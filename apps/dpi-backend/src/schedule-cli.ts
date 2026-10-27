/**
 * `dpi schedule` — scheduled sessions from the CLI (checklist Wave 2).
 *
 * The device owns the clock: this command only edits and reads the schedule
 * records over the local device API, so the running daemon picks changes up
 * without a restart. Same endpoint resolution as `dpi doctor`.
 */
import { authHeaders, deviceEndpoint, defaultDoctorIo, type DoctorIo } from "./doctor.js";

export interface ScheduleView {
  id: string;
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  prompt: string;
  everyMinutes?: number;
  dailyAt?: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt?: number;
  lastSessionId?: string;
  lastOutcome?: "ok" | "failed";
  lastError?: string;
  running: boolean;
}

export const SCHEDULE_HELP = `dpi schedule — scheduled sessions (the device owns the clock)

  dpi schedule list
  dpi schedule add --name <name> --cwd <dir> --prompt <text> --model <provider>/<model>
                   (--every <minutes> | --daily HH:MM) [--disabled]
  dpi schedule enable|disable <id-prefix>
  dpi schedule run <id-prefix>
  dpi schedule remove <id-prefix>

  --every N        interval trigger, 5–1440 minutes
  --daily HH:MM    daily trigger, local time
  A run creates a fresh session (named "<schedule> · <time>") and sends the prompt
  to its root agent.`;

/** doctor's IO (env file, token, fetch) plus the two print hooks a CLI needs. */
export interface ScheduleIo extends DoctorIo {
  print: (line: string) => void;
  printErr: (line: string) => void;
}

export const defaultScheduleIo = (): ScheduleIo => ({
  ...defaultDoctorIo(),
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
});

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = (argv: readonly string[]): string[] =>
  argv.filter((arg, i) => !arg.startsWith("--") && !(i > 0 && argv[i - 1]?.startsWith("--")));

async function call<T>(
  io: ScheduleIo,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const cfg = deviceEndpoint(io);
  if (!cfg.token) return { ok: false, error: `no DPI_TOKEN (looked in ${cfg.envFile})` };
  try {
    const res = await io.fetchImpl(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        ...authHeaders(cfg.token),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(io.timeoutMs),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: `${res.status} ${(parsed as { error?: { message?: string } })?.error?.message ?? ""}`.trim() };
    return { ok: true, data: parsed as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const when = (at: number | null | undefined): string => {
  if (!at) return "—";
  const delta = at - Date.now();
  const mins = Math.round(Math.abs(delta) / 60_000);
  const human = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return delta >= 0 ? `in ${human}` : `${human} ago`;
};

const trigger = (s: ScheduleView) => (s.everyMinutes ? `every ${s.everyMinutes}m` : `daily ${s.dailyAt}`);

export function formatSchedules(list: readonly ScheduleView[]): string[] {
  if (!list.length) return ["no schedules. Add one with `dpi schedule add --help`."];
  return list.map((s) => {
    const state = !s.enabled ? "disabled" : s.running ? "running" : "enabled";
    const outcome = s.lastOutcome ? ` last ${s.lastOutcome}${s.lastError ? ` (${s.lastError.slice(0, 40)})` : ""}` : "";
    return `${s.id.slice(0, 8)}  ${s.name} — ${trigger(s)}, ${state}, next ${when(s.nextRunAt)}${outcome}\n          ${s.cwd}`;
  });
}

/** Resolve an id prefix the way a human types it (`dpi schedule run 3f2a`). */
export function matchSchedule(list: readonly ScheduleView[], prefix: string): ScheduleView[] {
  const needle = prefix.toLowerCase();
  return list.filter((s) => s.id.toLowerCase().startsWith(needle));
}

export async function scheduleCli(argv: readonly string[], io: ScheduleIo = defaultScheduleIo()): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h") {
    io.print(SCHEDULE_HELP);
    return 0;
  }
  // No subcommand lists, like `dpi device` with no verb shows the device.
  if (!sub || sub === "list") {
    const listed = await call<{ schedules: ScheduleView[] }>(io, "GET", "/v1/schedules");
    if (!listed.ok) {
      io.printErr(`dpi schedule: ${listed.error}`);
      return 1;
    }
    for (const line of formatSchedules(listed.data.schedules ?? [])) io.print(line);
    return 0;
  }

  if (sub === "add") {
    const every = flag(rest, "--every");
    const daily = flag(rest, "--daily");
    const body = {
      name: flag(rest, "--name"),
      cwd: flag(rest, "--cwd"),
      prompt: flag(rest, "--prompt"),
      model: (() => {
        const raw = flag(rest, "--model") ?? "";
        const slash = raw.indexOf("/");
        return slash > 0 ? { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) } : undefined;
      })(),
      ...(every ? { everyMinutes: Number(every) } : {}),
      ...(daily ? { dailyAt: daily } : {}),
      ...(rest.includes("--disabled") ? { enabled: false } : {}),
    };
    if (!body.name || !body.cwd || !body.prompt || !body.model) {
      io.printErr(`dpi schedule add: --name, --cwd, --prompt and --model are required\n\n${SCHEDULE_HELP}`);
      return 2;
    }
    const created = await call<ScheduleView>(io, "POST", "/v1/schedules", body);
    if (!created.ok) {
      io.printErr(`dpi schedule: ${created.error}`);
      return 1;
    }
    io.print(`created ${created.data.id.slice(0, 8)} — ${created.data.name}, ${trigger(created.data)}, next ${when(created.data.nextRunAt)}`);
    return 0;
  }

  const prefix = positional(rest)[0];
  if (!prefix) {
    io.printErr(`dpi schedule ${sub}: an id prefix is required\n\n${SCHEDULE_HELP}`);
    return 2;
  }
  const listed = await call<{ schedules: ScheduleView[] }>(io, "GET", "/v1/schedules");
  if (!listed.ok) {
    io.printErr(`dpi schedule: ${listed.error}`);
    return 1;
  }
  const matches = matchSchedule(listed.data.schedules ?? [], prefix);
  if (!matches.length) {
    io.printErr(`dpi schedule: no schedule starts with '${prefix}'`);
    return 1;
  }
  if (matches.length > 1) {
    io.printErr(`dpi schedule: '${prefix}' matches ${matches.length} schedules — be more specific:`);
    for (const m of matches) io.printErr(`  ${m.id.slice(0, 8)}  ${m.name}`);
    return 2;
  }
  const target = matches[0];

  if (sub === "enable" || sub === "disable") {
    const patched = await call<ScheduleView>(io, "PATCH", `/v1/schedules/${target.id}`, {
      enabled: sub === "enable",
    });
    if (!patched.ok) {
      io.printErr(`dpi schedule: ${patched.error}`);
      return 1;
    }
    io.print(`${sub}d ${target.id.slice(0, 8)} — next ${when(patched.data.nextRunAt)}`);
    return 0;
  }
  if (sub === "run") {
    io.print(`${target.name}: starting…`);
    // R11 2.3: the route answers 202 as soon as the run is ARMED — the turn
    // itself is bounded by the dispatch deadlines and lands in the record and
    // the schedule.ok/failed events. `dpi schedule list` shows the outcome.
    const ran = await call<ScheduleView>(io, "POST", `/v1/schedules/${target.id}/run`, {});
    if (!ran.ok) {
      io.printErr(`dpi schedule: ${ran.error}`);
      return 1;
    }
    io.print(
      ran.data.running
        ? `run started (watch \`dpi schedule list\` for the outcome); next ${when(ran.data.nextRunAt)}`
        : `armed; next ${when(ran.data.nextRunAt)}`,
    );
    return 0;
  }
  if (sub === "remove") {
    const removed = await call<{ removed: boolean }>(io, "DELETE", `/v1/schedules/${target.id}`);
    if (!removed.ok) {
      io.printErr(`dpi schedule: ${removed.error}`);
      return 1;
    }
    io.print(`removed ${target.id.slice(0, 8)} — ${target.name}`);
    return 0;
  }
  io.printErr(`dpi schedule: unknown subcommand '${sub}'\n\n${SCHEDULE_HELP}`);
  return 2;
}
