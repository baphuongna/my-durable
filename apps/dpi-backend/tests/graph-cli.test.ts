/**
 * `dpi graph` — the CLI is a registry editor plus a daemon client: add/list/
 * show/archive work on <home>/backend/graphs.json (real fs in a temp dir), and
 * run/remove are tested against a FAKE httpd (fetch injected), because the REST
 * routes land in a later daemon build. One wrong flag must fail loudly rather
 * than silently writing nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphCli, defaultGraphCliIo, type GraphCliIo } from "../src/graph-cli.js";
import { GraphRegistry } from "../src/graphs.js";
import type { FetchLike, HttpResponse } from "../src/doctor.js";

const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);
const clock = { now: () => new Date(T0).toISOString() };

const document = {
  name: "Release flow",
  cwd: "/srv/app",
  tasks: [
    { id: "install", name: "Install deps", prompt: "Run npm install.", dependsOn: [] },
    { id: "build", name: "Build", prompt: "Run npm run build.", dependsOn: ["install"] },
  ],
};

/** A CLI io over the real fs with a fake env, captured output, injectable fetch/stdin. */
const harness = (over: { env?: Record<string, string | undefined>; fetch?: FetchLike; stdin?: string } = {}) => {
  const lines: string[] = [];
  const errors: string[] = [];
  const calls: { method: string; url: string; body?: unknown; headers?: Record<string, string> }[] = [];
  // When a fake daemon is injected, wrap it so the calls it saw are captured.
  const fetch: FetchLike = over.fetch
    ? async (url, init) => {
        calls.push({
          method: init?.method ?? "GET",
          url,
          body: init?.body ? JSON.parse(init.body) : undefined,
          headers: init?.headers,
        });
        return over.fetch!(url, init);
      }
    : async () => {
        throw new Error("connect ECONNREFUSED (faked)");
      };
  const io: GraphCliIo = {
    ...defaultGraphCliIo(),
    env: over.env ?? { DPI_TOKEN: "t" },
    fetch,
    readStdin: async () => over.stdin ?? "",
    print: (line) => lines.push(line),
    printErr: (line) => errors.push(line),
  };
  return { io, lines, errors, calls };
};

const respond = (body: unknown, status = 200): FetchLike => {
  const response: HttpResponse = { ok: status >= 200 && status < 300, status, json: async () => body };
  return async () => response;
};

/** A temp device home with a graph (and optionally run state) already in it. */
async function homeWithGraph(name = "Release flow") {
  const home = await mkdtemp(join(tmpdir(), "dpi-graph-cli-"));
  const registry = await GraphRegistry.open(join(home, "backend", "graphs.json"), { now: clock.now });
  const graph = await registry.create({ ...document, name });
  return { home, registry, graph };
}

test("add --file reads the document, prints the created id and writes graphs.json", async () => {
  const { home, graph } = await homeWithGraph();
  try {
    const file = join(home, "graph.json");
    await writeFile(file, JSON.stringify(document), "utf8");
    const { io, lines, errors } = harness();
    assert.equal(await graphCli({ argv: ["add", "--file", file, "--home", home] }, io), 0);
    assert.match(lines[0], /^created grp_[0-9a-f]{10} — Release flow \(2 task\(s\)\)$/);
    assert.deepEqual(errors, [], "nothing on stderr");

    // The record really landed, next to the one the fixture made.
    const onDisk = JSON.parse(await readFile(join(home, "backend", "graphs.json"), "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.graphs.length, 2);
    assert.ok(onDisk.graphs.some((entry: { id: string }) => entry.id === graph.id));
    assert.ok(
      onDisk.graphs.some((entry: { id: string; name: string }) => /^grp_[0-9a-f]{10}$/.test(entry.id) && entry.id !== graph.id),
      "the printed id is the created grp_ id",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("add --file - reads the document from STDIN", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-graph-cli-"));
  try {
    const { io, lines } = harness({ stdin: JSON.stringify(document) });
    assert.equal(await graphCli({ argv: ["add", "--file", "-", "--home", home] }, io), 0);
    assert.match(lines[0], /^created grp_[0-9a-f]{10}/);
    const onDisk = JSON.parse(await readFile(join(home, "backend", "graphs.json"), "utf8"));
    assert.equal(onDisk.graphs[0].tasks[1].dependsOn[0], "install");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("add: a bad document is exit 1 with the message; a missing --file is exit 2", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-graph-cli-"));
  try {
    const broken = join(home, "broken.json");
    await writeFile(broken, "{ not json", "utf8");
    const json = harness({ stdin: "" });
    assert.equal(await graphCli({ argv: ["add", "--file", broken, "--home", home] }, json.io), 1);
    assert.match(json.errors.join("\n"), /not valid JSON/);

    // A cyclic document names the ring, not a stack trace.
    const cyclic = harness({
      stdin: JSON.stringify({
        name: "Ring",
        cwd: "/srv",
        tasks: [
          { id: "a", name: "A", prompt: "a", dependsOn: ["b"] },
          { id: "b", name: "B", prompt: "b", dependsOn: ["a"] },
        ],
      }),
    });
    assert.equal(await graphCli({ argv: ["add", "--file", "-", "--home", home] }, cyclic.io), 1);
    assert.match(cyclic.errors.join("\n"), /the graph has a cycle/);

    const noFile = harness();
    assert.equal(await graphCli({ argv: ["add", "--home", home] }, noFile.io), 2);
    assert.match(noFile.errors.join("\n"), /--file <graph\.json>/);

    const missing = harness();
    assert.equal(await graphCli({ argv: ["add", "--file", join(home, "ghost.json"), "--home", home] }, missing.io), 1);
    assert.match(missing.errors.join("\n"), /could not read/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("list and show render tasks with their last-run statuses, including a failure", async () => {
  const { home, registry, graph } = await homeWithGraph();
  try {
    const run = await registry.beginRun(graph.id);
    await registry.markTask(graph.id, run.id, "install", { status: "ok", sessionId: "ses_1" });
    await registry.markTask(graph.id, run.id, "build", { status: "failed", error: "exit 1" });

    const listing = harness();
    assert.equal(await graphCli({ argv: ["list", "--home", home] }, listing.io), 0);
    assert.match(listing.lines.join("\n"), new RegExp(`${graph.id}  Release flow — 2 task\\(s\\), /srv/app`));
    assert.equal(listing.lines.length, 1, "one graph, one line");

    // show by id prefix, the way a human types it
    const shown = harness();
    const prefix = graph.id.slice(0, 8);
    assert.equal(await graphCli({ argv: ["show", prefix, "--home", home] }, shown.io), 0);
    const text = shown.lines.join("\n");
    assert.match(text, /ok\s+install\s+Install deps/);
    assert.match(text, /✗ failed: exit 1\s+build\s+Build/);
    assert.match(text, /\[needs install\]/);
    assert.doesNotMatch(text, /pending/, "both tasks have a verdict");

    // --runs adds the history
    const withRuns = harness();
    assert.equal(await graphCli({ argv: ["show", prefix, "--runs", "--home", home] }, withRuns.io), 0);
    assert.match(withRuns.lines.join("\n"), new RegExp(`runs:\\n  ${run.id}  failed\\s+started`));

    const none = harness();
    assert.equal(await graphCli({ argv: ["show", "grp_0000", "--home", home] }, none.io), 1);
    assert.match(none.errors.join("\n"), /no graph starts with 'grp_0000'/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("show renders – skipped, pending and never-ran tasks too", async () => {
  const { home, registry, graph } = await homeWithGraph("Mixed");
  try {
    const run = await registry.beginRun(graph.id);
    await registry.markTask(graph.id, run.id, "install", { status: "failed", error: "boom" });

    const shown = harness();
    assert.equal(await graphCli({ argv: ["show", graph.id.slice(0, 6), "--home", home] }, shown.io), 0);
    const text = shown.lines.join("\n");
    assert.match(text, /✗ failed: boom\s+install/);
    assert.match(text, /– skipped\s+build/, "the dependent was skipped by the cascade");
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  // A graph that never ran shows the neutral marker.
  const home2 = await mkdtemp(join(tmpdir(), "dpi-graph-cli-"));
  try {
    const registry = await GraphRegistry.open(join(home2, "backend", "graphs.json"), { now: clock.now });
    const graph = await registry.create({ ...document, name: "Never ran" });
    const shown = harness();
    assert.equal(await graphCli({ argv: ["show", graph.id.slice(0, 8), "--home", home2] }, shown.io), 0);
    assert.match(shown.lines.join("\n"), /–\s+install/);
  } finally {
    await rm(home2, { recursive: true, force: true });
  }
});

test("run POSTs {} to /v1/graphs/:id/run with the token and prints the run summary", async () => {
  const { home, graph } = await homeWithGraph();
  try {
    const runRecord = {
      id: `run_${T0}_ab12`,
      graphId: graph.id,
      startedAt: new Date(T0).toISOString(),
      finishedAt: null,
      status: "running",
      tasks: { install: { status: "running" }, build: { status: "pending" } },
    };
    const fake = harness({ fetch: respond({ run: runRecord }) });
    assert.equal(await graphCli({ argv: ["run", graph.id.slice(0, 8), "--home", home] }, fake.io), 0);
    assert.equal(fake.calls.length, 1, "one daemon call");
    assert.equal(fake.calls[0].method, "POST");
    assert.equal(fake.calls[0].url, `http://127.0.0.1:4780/v1/graphs/${graph.id}/run`);
    assert.deepEqual(fake.calls[0].body, {}, "the body is exactly {}");
    assert.equal(fake.calls[0].headers?.authorization, "Bearer t");
    assert.match(fake.calls[0].headers?.["content-type"] ?? "", /application\/json/);
    const text = fake.lines.join("\n");
    assert.match(text, /asking the device to run Release flow/);
    assert.match(text, new RegExp(`run_${T0}_ab12\\s+running — 0 ok, 0 failed, 0 skipped, 2 to go`));
    assert.match(text, /running\s+install/);

    // A terminal failed run exits 1, like `dpi schedule run`.
    const failed = harness({
      fetch: respond({
        run: { ...runRecord, id: `run_${T0}_ff00`, status: "failed", finishedAt: new Date(T0).toISOString(), tasks: { install: { status: "failed", error: "model_error" }, build: { status: "skipped" } } },
      }),
    });
    assert.equal(await graphCli({ argv: ["run", graph.id.slice(0, 8), "--home", home] }, failed.io), 1);
    assert.match(failed.lines.join("\n"), /✗ failed: model_error\s+install/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("run: a 404 says the device is on an older build; no token and no daemon are clear errors", async () => {
  const { home, graph } = await homeWithGraph();
  try {
    const prefix = graph.id.slice(0, 8);

    const older = harness({ fetch: respond({ error: { code: "not_found", message: "no route" } }, 404) });
    assert.equal(await graphCli({ argv: ["run", prefix, "--home", home] }, older.io), 1);
    assert.match(older.errors.join("\n"), /older build/);

    const unauthorized = harness({ fetch: respond({ error: { code: "unauthorized", message: "bad token" } }, 401) });
    assert.equal(await graphCli({ argv: ["run", prefix, "--home", home] }, unauthorized.io), 1);
    assert.match(unauthorized.errors.join("\n"), /could not start the run on the device: 401/);

    const down = harness(); // fetch throws ECONNREFUSED
    assert.equal(await graphCli({ argv: ["run", prefix, "--home", home] }, down.io), 1);
    assert.match(down.errors.join("\n"), /is the device running\?/);

    const noToken = harness({ env: {} });
    assert.equal(await graphCli({ argv: ["run", prefix, "--home", home] }, noToken.io), 1);
    assert.match(noToken.errors.join("\n"), /no DPI_TOKEN/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("remove deletes the record locally and DELETEs it from the daemon; a dead daemon is a note, not a failure", async () => {
  const { home, graph } = await homeWithGraph();
  try {
    const fake = harness({ fetch: respond({ removed: true }) });
    assert.equal(await graphCli({ argv: ["remove", graph.id.slice(0, 8), "--home", home] }, fake.io), 0);
    assert.match(fake.lines.join("\n"), new RegExp(`removed ${graph.id} — Release flow`));
    assert.equal(fake.calls[0].method, "DELETE");
    assert.equal(fake.calls[0].url, `http://127.0.0.1:4780/v1/graphs/${graph.id}`);
    assert.deepEqual(fake.calls[0].body, undefined, "DELETE carries no body");

    const onDisk = JSON.parse(await readFile(join(home, "backend", "graphs.json"), "utf8"));
    assert.deepEqual(onDisk.graphs, [], "the record is gone from the file");
    const names = await readdir(join(home, "backend"));
    assert.equal(names.includes("graphs.json.bak"), true, "the .bak rides along like every registry");

    // A daemon that cannot be reached (or is an older build) must not undo a
    // durable removal — the next boot reads the file without the record.
    const second = await homeWithGraph("Second");
    try {
      const down = harness();
      assert.equal(await graphCli({ argv: ["remove", second.graph.id.slice(0, 8), "--home", second.home] }, down.io), 0);
      assert.match(down.lines.join("\n"), /removed/);
      assert.match(down.errors.join("\n"), /note:/);
    } finally {
      await rm(second.home, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("archive/unarchive, an ambiguous prefix, usage errors and help", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-graph-cli-"));
  try {
    const registry = await GraphRegistry.open(join(home, "backend", "graphs.json"), { now: clock.now });
    const first = await registry.create({ ...document, name: "Alpha" });
    const second = await registry.create({ ...document, name: "Beta" });

    // list defaults (no subcommand) and --all
    const plain = harness();
    assert.equal(await graphCli({ argv: ["--home", home] }, plain.io), 0);
    assert.equal(plain.lines.length, 2);
    const archived = harness();
    assert.equal(await graphCli({ argv: ["archive", first.id.slice(0, 8), "--home", home] }, archived.io), 0);
    assert.match(archived.lines.join("\n"), new RegExp(`archived ${first.id} — Alpha`));
    const active = harness();
    assert.equal(await graphCli({ argv: ["list", "--home", home] }, active.io), 0);
    assert.equal(active.lines.length, 1, "archived graphs are hidden");
    const all = harness();
    assert.equal(await graphCli({ argv: ["list", "--all", "--home", home] }, all.io), 0);
    assert.equal(all.lines.length, 2);
    const back = harness();
    assert.equal(await graphCli({ argv: ["unarchive", first.id.slice(0, 8), "--home", home] }, back.io), 0);
    assert.match(back.lines.join("\n"), /unarchived/);

    // Both ids share no prefix beyond "grp_" — asking for "grp" is ambiguous.
    const ambiguous = harness();
    assert.equal(await graphCli({ argv: ["show", "grp", "--home", home] }, ambiguous.io), 2);
    assert.match(ambiguous.errors.join("\n"), /matches 2 graphs/);

    // Usage errors: 2, never a throw.
    const unknown = harness();
    assert.equal(await graphCli({ argv: ["frobnicate"] }, unknown.io), 2);
    assert.match(unknown.errors.join("\n"), /unknown subcommand 'frobnicate'/);
    const noPrefix = harness();
    assert.equal(await graphCli({ argv: ["show", "--home", home] }, noPrefix.io), 2);
    assert.match(noPrefix.errors.join("\n"), /an id prefix is required/);
    const badFlag = harness();
    assert.equal(await graphCli({ argv: ["list", "--bogus", "--home", home] }, badFlag.io), 2);
    assert.match(badFlag.errors.join("\n"), /unknown flag '--bogus'/);
    const empty = harness();
    assert.equal(await graphCli({ argv: [] }, empty.io), 0, "no subcommand lists");
    const help = harness();
    assert.equal(await graphCli({ argv: ["--help"] }, help.io), 0);
    assert.match(help.lines.join("\n"), /dpi graph add --file/);

    // The second graph still exists for a full-id show (prefix used above).
    assert.equal(second.tasks === undefined, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
