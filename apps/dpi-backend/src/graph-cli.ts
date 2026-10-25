/**
 * `dpi graph` — task-graph orchestration from the CLI (checklist Wave 3, the
 * last SHOULD: "Task-graph orchestration").
 *
 * The records live in `<home>/backend/graphs.json`, so list/show/add/archive/
 * unarchive edit that file directly through `GraphRegistry` (atomic, 0600, with
 * a `.bak`) — the same "the file is the contract" stance as the other
 * registries. Two commands additionally talk to the RUNNING device daemon over
 * its API, because only the device executes:
 *
 *   - `run`    POST   /v1/graphs/:id/run  (body `{}`) — the store drives the
 *               DAG: each task, once its deps finished ok, runs as a fresh session.
 *   - `remove` DELETE /v1/graphs/:id      — the record is gone from the file
 *               either way; the DELETE tells a running daemon to drop it now.
 *
 * Those REST routes land in a later build of the daemon, so a 404 (or an
 * allowlist refusal) is translated to "this device is on an older build" rather
 * than a raw error. Endpoint + token resolution is doctor.ts's
 * `deviceEndpoint`/`authHeaders`, exactly like `dpi schedule`.
 *
 * CLI io is injected (print/printErr/env/homedir/fetch/exists/readFile/
 * readStdin), so tests fake one object. Exit codes: 0 ok, 1 graph/daemon error,
 * 2 usage error; nothing is ever thrown out of `graphCli`. `argv` is what
 * follows the `graph` word (`graphCli({ argv: ["list"] })`).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GraphError, GraphRegistry, type GraphRecord, type GraphRunRecord, type TaskRunState } from "./graphs.js";
import { authHeaders, defaultDoctorIo, deviceEndpoint, expand, readEnvFile, type FetchLike } from "./doctor.js";

export const GRAPH_HELP = `dpi graph — task-graph orchestration (a run = a fresh session per task)

  dpi graph list [--all]
  dpi graph show <id-prefix> [--runs]
  dpi graph add --file graph.json | --file -
  dpi graph run <id-prefix>
  dpi graph remove <id-prefix>
  dpi graph archive|unarchive <id-prefix>

  list         graphs (active only; --all includes archived)
  show         the tasks with their last-run statuses; --runs adds the history
  add          read a { name, cwd, tasks: [...] } JSON document from --file
               (or STDIN with --file -), print the created id
  run          ask the running device daemon to start a run
               (POST /v1/graphs/<id>/run; each task runs as a fresh session
               once every dependency finished ok)
  remove       delete the record (and its run history) and tell the daemon
  archive      soft delete: keeps tasks and run history, hides the graph

  --home DIR   device home (default: $DPI_HOME, else ~/.dpi); the registry is
               <home>/backend/graphs.json

A 404 from the daemon on run/remove means an older build without the graph
routes — update the device and restart it.
Exit codes: 0 ok, 1 graph/daemon error, 2 usage error.`;

export interface GraphCliArgs {
  argv: readonly string[];
}

/** Everything the CLI touches is injectable; the default io is the real machine. */
export interface GraphCliIo {
  print: (line: string) => void;
  printErr: (line: string) => void;
  env: Record<string, string | undefined>;
  homedir: () => string;
  /** doctor's narrow fetch surface, so a fake httpd is three lines in tests. */
  fetch: FetchLike;
  /** Timeout for the daemon calls (`run` may kick off sessions). */
  fetchTimeoutMs: number;
  exists: (path: string) => boolean;
  /** Sync text read: the --file document and the env file (doctor.ts shape). */
  readFile: (path: string) => string;
  /** The add document when `--file -` is used. */
  readStdin: () => Promise<string>;
}

const readAllStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

export const defaultGraphCliIo = (): GraphCliIo => ({
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
  env: process.env as Record<string, string | undefined>,
  homedir,
  fetch: async (url, init) => fetch(url, init as RequestInit),
  fetchTimeoutMs: 30_000,
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  readStdin: readAllStdin,
});

/** Flags that consume the next argument. */
const VALUE_FLAGS = new Set(["--home", "--file"]);
/** Flags each subcommand accepts; anything else `--`-shaped is a usage error. */
const SUB_FLAGS: Record<string, Set<string>> = {
  list: new Set(["--all"]),
  show: new Set(["--runs"]),
  add: new Set(["--file"]),
  run: new Set(),
  remove: new Set(),
  archive: new Set(),
  unarchive: new Set(),
};

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

/** Positional args, skipping flags and the value --home/--file consume. */
const positional = (argv: readonly string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (VALUE_FLAGS.has(argv[i])) i += 1;
    else if (!argv[i].startsWith("-")) out.push(argv[i]);
  }
  return out;
};

/** env wins over the env file, like doctor.ts's `deviceEndpoint`. */
function envValues(io: GraphCliIo): (key: string) => string | undefined {
  const envFile = io.env.DPI_ENV_FILE;
  let fileEnv: Record<string, string> = {};
  if (envFile) {
    try {
      fileEnv = readEnvFile(io.readFile(resolve(expand(envFile, io.homedir()))));
    } catch {
      /* unreadable env file: fall back to process env, like doctor.ts */
    }
  }
  return (key) => io.env[key] ?? (typeof fileEnv[key] === "string" ? fileEnv[key] : undefined);
}

/** `--home` wins, then $DPI_HOME (env file included), then ~/.dpi — the backup-cli rule. */
function resolveHome(homeFlag: string | undefined, io: GraphCliIo): string {
  const value = envValues(io);
  const home = homeFlag ?? value("DPI_HOME") ?? join(io.homedir(), ".dpi");
  return resolve(expand(home, io.homedir()));
}

/** The registry the device loop reads: <home>/backend/graphs.json (the store's dataDir). */
function registryPath(home: string): string {
  return join(home, "backend", "graphs.json");
}

async function openRegistry(home: string, io: GraphCliIo): Promise<GraphRegistry> {
  return GraphRegistry.open(registryPath(home), {
    warn: (message, error) => io.printErr(`[graphs] ${message}${error === undefined ? "" : ` (${error})`}`),
  });
}

/** Resolve an id prefix the way a human types it (`dpi graph show 3f2a`). */
export function matchGraph(list: readonly GraphRecord[], prefix: string): GraphRecord[] {
  const needle = prefix.toLowerCase();
  return list.filter((graph) => graph.id.toLowerCase().startsWith(needle));
}

type Resolved = { record: GraphRecord } | { error: number; message: string };

function resolveTarget(list: readonly GraphRecord[], prefix: string, io: GraphCliIo): Resolved {
  const matches = matchGraph(list, prefix);
  if (!matches.length) return { error: 1, message: `no graph starts with '${prefix}'` };
  if (matches.length > 1) {
    io.printErr(`dpi graph: '${prefix}' matches ${matches.length} graphs — be more specific:`);
    for (const match of matches) io.printErr(`  ${match.id}  ${match.name}`);
    return { error: 2, message: `prefix '${prefix}' is ambiguous` };
  }
  return { record: matches[0] };
}

/** The last-run marker a task shows: `ok` / `pending` / `✗ failed: <err>` / `– skipped`. */
export function taskMarker(state: TaskRunState | undefined): string {
  if (!state) return "–"; // never ran
  switch (state.status) {
    case "ok":
      return "ok";
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "failed":
      return `✗ failed: ${(state.error ?? "").slice(0, 40) || "no error recorded"}`;
    case "skipped":
      return "– skipped";
  }
}

/** A graph with its tasks and their last-run statuses. */
export function formatGraph(graph: GraphRecord, lastRun?: GraphRunRecord): string[] {
  const head = `${graph.id}  ${graph.name}${graph.archivedAt ? " (archived)" : ""} — ${graph.tasks.length} task(s), ${graph.cwd}`;
  const tasks = graph.tasks.map((task) => {
    const deps = task.dependsOn.length ? `  [needs ${task.dependsOn.join(", ")}]` : "";
    return `  ${taskMarker(lastRun?.tasks[task.id]).padEnd(18)} ${task.id.padEnd(12)} ${task.name}${deps}`;
  });
  return [head, ...tasks];
}

/** One run as a summary line per task plus the counts — what `run` prints back. */
export function formatRun(run: GraphRunRecord): string[] {
  const states = Object.values(run.tasks);
  const count = (status: TaskRunState["status"]) => states.filter((state) => state.status === status).length;
  const toGo = count("pending") + count("running");
  const head = `${run.id}  ${run.status} — ${count("ok")} ok, ${count("failed")} failed, ${count("skipped")} skipped, ${toGo} to go`;
  return [
    head,
    ...Object.entries(run.tasks).map(([id, state]) => `  ${taskMarker(state).padEnd(18)} ${id}`),
  ];
}

/** Run-history lines for `show --runs`. */
export function formatRuns(runs: readonly GraphRunRecord[]): string[] {
  return runs.map(
    (run) =>
      `  ${run.id}  ${run.status.padEnd(11)} started ${run.startedAt}${run.finishedAt ? `, finished ${run.finishedAt}` : ""}`,
  );
}

/**
 * One daemon call. The token is looked up in the same home the CLI is editing
 * (`DPI_HOME` is overridden with the resolved home), so the graph and the
 * credential can never come from two different devices.
 */
async function callDevice(
  io: GraphCliIo,
  home: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; status?: number; error: string }> {
  const doctorIo = {
    ...defaultDoctorIo(),
    env: { ...io.env, DPI_HOME: home },
    homedir: io.homedir,
    exists: io.exists,
    readFile: io.readFile,
    fetchImpl: io.fetch,
  };
  const cfg = deviceEndpoint(doctorIo);
  if (!cfg.token) return { ok: false, error: `no DPI_TOKEN (looked in ${cfg.envFile})` };
  try {
    const res = await io.fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        ...authHeaders(cfg.token),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(io.fetchTimeoutMs),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = (parsed as { error?: { message?: string } })?.error?.message ?? "";
      return { ok: false, status: res.status, error: message };
    }
    return { ok: true, status: res.status, body: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${message} (is the device running? "dpi device start")` };
  }
}

/** A non-ok daemon answer in words; a 404 on the graph routes is an older build, not a bug. */
function daemonError(result: { status?: number; error: string }, action: string): string {
  if (result.status === 404) {
    return `the device answered 404 — this device is on an older build without the /v1/graphs routes (update it, then "dpi device start")`;
  }
  const detail = result.status ? `${result.status} ` : "";
  return `could not ${action} on the device: ${detail}${result.error}`.trim();
}

export async function graphCli(args: GraphCliArgs, io: GraphCliIo = defaultGraphCliIo()): Promise<number> {
  try {
    return await run(args.argv, io);
  } catch (error) {
    // The CLI contract is an exit code, never a stack trace (backupCli's rule).
    io.printErr(`dpi graph: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function run(argv: readonly string[], io: GraphCliIo): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.print(GRAPH_HELP);
    return 0;
  }
  // `--home` is global: peel it out wherever it sits, so both
  // `dpi graph list --home D` and `dpi graph --home D list` parse.
  const homeFlag = flagValue(argv, "--home");
  const peeled: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--home") {
      i += 1;
      continue;
    }
    peeled.push(argv[i]);
  }
  const [sub = "list", ...rest] = peeled;
  if (!SUB_FLAGS[sub]) {
    io.printErr(`dpi graph: unknown subcommand '${sub}'\n\n${GRAPH_HELP}`);
    return 2;
  }
  // Every other --flag must be known to the subcommand; a flag's VALUE (the
  // "-" STDIN marker, a dir) is skipped, not validated.
  for (let i = 0; i < rest.length; i += 1) {
    if (VALUE_FLAGS.has(rest[i])) {
      i += 1;
      continue;
    }
    if (rest[i].startsWith("-") && !SUB_FLAGS[sub].has(rest[i])) {
      io.printErr(`dpi graph ${sub}: unknown flag '${rest[i]}'\n\n${GRAPH_HELP}`);
      return 2;
    }
  }
  if (sub === "add") return addCmd(rest, homeFlag, io);
  if (sub === "list") return listCmd(rest, homeFlag, io);

  // Everything else needs a graph id prefix.
  const home = resolveHome(homeFlag, io);
  const registry = await openRegistry(home, io);
  const prefix = positional(rest)[0];
  if (!prefix) {
    io.printErr(`dpi graph ${sub}: an id prefix is required\n\n${GRAPH_HELP}`);
    return 2;
  }
  const resolved = resolveTarget(registry.list({ includeArchived: true }), prefix, io);
  if ("error" in resolved) {
    if (resolved.error === 1) io.printErr(`dpi graph: ${resolved.message}`);
    return resolved.error;
  }
  const graph = resolved.record;

  if (sub === "show") return showCmd(registry, graph, rest.includes("--runs"), io);
  if (sub === "run") return runCmd(home, graph, io);
  if (sub === "remove") return removeCmd(home, registry, graph, io);
  if (sub === "archive" || sub === "unarchive") {
    const updated = sub === "archive" ? await registry.archive(graph.id) : await registry.unarchive(graph.id);
    io.print(`${sub}d ${updated.id} — ${updated.name}`);
    return 0;
  }
  io.printErr(`dpi graph: unknown subcommand '${sub}'\n\n${GRAPH_HELP}`);
  return 2;
}

async function listCmd(rest: readonly string[], homeFlag: string | undefined, io: GraphCliIo): Promise<number> {
  const registry = await openRegistry(resolveHome(homeFlag, io), io);
  const graphs = registry.list({ includeArchived: rest.includes("--all") });
  if (!graphs.length) {
    io.print("no graphs yet. Add one with `dpi graph add --file graph.json`.");
    return 0;
  }
  for (const graph of graphs) {
    io.print(`${graph.id}  ${graph.name}${graph.archivedAt ? " (archived)" : ""} — ${graph.tasks.length} task(s), ${graph.cwd}`);
  }
  return 0;
}

async function showCmd(registry: GraphRegistry, graph: GraphRecord, withRuns: boolean, io: GraphCliIo): Promise<number> {
  for (const line of formatGraph(graph, registry.lastRun(graph.id))) io.print(line);
  if (withRuns) {
    const runs = registry.runs(graph.id);
    io.print(runs.length ? "runs:" : "runs: none yet");
    for (const line of formatRuns(runs)) io.print(line);
  }
  return 0;
}

async function addCmd(rest: readonly string[], homeFlag: string | undefined, io: GraphCliIo): Promise<number> {
  const file = flagValue(rest, "--file");
  if (!file) {
    io.printErr(`dpi graph add: --file <graph.json> (or --file - for STDIN) is required\n\n${GRAPH_HELP}`);
    return 2;
  }
  let text: string;
  if (file === "-") {
    text = await io.readStdin();
  } else {
    try {
      text = io.readFile(resolve(expand(file, io.homedir())));
    } catch (error) {
      io.printErr(`dpi graph add: could not read ${file} — ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    io.printErr(`dpi graph add: ${file === "-" ? "STDIN" : file} is not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    io.printErr(`dpi graph add: the document must be a { name, cwd, tasks } JSON object`);
    return 1;
  }
  const home = resolveHome(homeFlag, io);
  const registry = await openRegistry(home, io);
  try {
    const created = await registry.create(document as { name: string; cwd: string; tasks: never[] });
    io.print(`created ${created.id} — ${created.name} (${created.tasks.length} task(s))`);
    return 0;
  } catch (error) {
    if (error instanceof GraphError && error.code === "invalid") {
      io.printErr(`dpi graph add: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function runCmd(home: string, graph: GraphRecord, io: GraphCliIo): Promise<number> {
  io.print(`asking the device to run ${graph.name} (${graph.tasks.length} task(s))…`);
  const result = await callDevice(io, home, "POST", `/v1/graphs/${graph.id}/run`, {});
  if (!result.ok) {
    io.printErr(`dpi graph run: ${daemonError(result, "start the run")}`);
    return 1;
  }
  const body = result.body;
  const candidate =
    body.run && typeof body.run === "object" ? (body.run as Record<string, unknown>) : body;
  if (typeof candidate.id !== "string" || !candidate.tasks || typeof candidate.tasks !== "object") {
    io.print(`the device accepted the run for ${graph.id}`);
    return 0;
  }
  const run = candidate as unknown as GraphRunRecord;
  for (const line of formatRun(run)) io.print(line);
  return run.status === "failed" || run.status === "interrupted" ? 1 : 0;
}

async function removeCmd(home: string, registry: GraphRegistry, graph: GraphRecord, io: GraphCliIo): Promise<number> {
  if (!(await registry.remove(graph.id))) {
    io.printErr(`dpi graph: no graph ${graph.id}`);
    return 1;
  }
  io.print(`removed ${graph.id} — ${graph.name}`);
  // The file is the durable fact; the DELETE tells a RUNNING daemon to drop it
  // now. An older build or a stopped daemon is a note, not a failure — the next
  // boot reads the file without the record.
  const result = await callDevice(io, home, "DELETE", `/v1/graphs/${graph.id}`);
  if (!result.ok) io.printErr(`note: ${daemonError(result, "remove it")} — it will forget the graph on its next start`);
  return 0;
}
