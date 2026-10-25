/**
 * `dpi notify` — outbound notification sinks (webhook / ntfy) from the CLI.
 *
 * Same shape as `dpi schedule`: the CLI edits the device's own records over its
 * local API, so a running daemon picks changes up immediately.
 */
import { authHeaders, deviceEndpoint, defaultDoctorIo } from "./doctor.js";
import type { ScheduleIo } from "./schedule-cli.js";

export interface SinkView {
  id: string;
  kind: "webhook" | "ntfy";
  url: string;
  enabled: boolean;
  events?: string[];
  label?: string;
  lastDeliveryAt?: number;
  lastError?: string;
  lastStatus?: number;
}

export interface Delivery {
  id: string;
  kind: string;
  status: "sent" | "skipped" | "failed";
  detail?: string;
}

export const NOTIFY_HELP = `dpi notify — outbound notifications (webhook / ntfy)

  dpi notify list
  dpi notify add --kind webhook|ntfy --url <url> [--events a,b|schedule.*] [--label <text>]
                 [--priority min|low|default|high|max] [--tags a,b] [--disabled]
  dpi notify enable|disable <id-prefix>
  dpi notify remove <id-prefix>
  dpi notify test
  dpi notify events
      The event kinds this device emits today.

  LAN sinks (http://192.168.x.x, http://localhost) are refused by default:
  start the device with DPI_NOTIFY_ALLOW_PRIVATE=1 to allow them.`;

export const EMITTED_EVENTS = [
  "session.failed",
  "schedule.ok",
  "schedule.failed",
  "graph.ok",
  "graph.failed",
  "test",
] as const;

export const defaultNotifyIo = (): ScheduleIo => ({
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
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: `${res.status} ${(data.error as { message?: string })?.message ?? ""}`.trim() };
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const ago = (at?: number): string => {
  if (!at) return "never";
  const mins = Math.round((Date.now() - at) / 60_000);
  return mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
};

export function formatSinks(list: readonly SinkView[]): string[] {
  if (!list.length) return ["no sinks. Add one with `dpi notify add --url <url> --kind webhook|ntfy`."];
  return list.map((s) => {
    const filters = s.events?.length ? s.events.join(",") : "all events";
    const last = s.lastError ? `last failed: ${s.lastError.slice(0, 60)}` : `last sent ${ago(s.lastDeliveryAt)}`;
    return `${s.id.slice(0, 8)}  ${s.kind} ${s.enabled ? "" : "(disabled) "}${s.label ?? ""}\n          ${s.url}\n          ${filters} · ${last}`;
  });
}

export function matchSink(list: readonly SinkView[], prefix: string): SinkView[] {
  const needle = prefix.toLowerCase();
  return list.filter((s) => s.id.toLowerCase().startsWith(needle));
}

export function formatResults(results: readonly Delivery[]): string[] {
  if (!results.length) return ["no enabled sinks matched — nothing was sent."];
  return results.map((r) => {
    const tail = r.detail ? ` — ${r.detail}` : "";
    return `${r.status.padEnd(7)} ${r.kind} ${r.id.slice(0, 8)}${tail}`;
  });
}

export async function notifyCli(argv: readonly string[], io: ScheduleIo = defaultNotifyIo()): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h") {
    io.print(NOTIFY_HELP);
    return 0;
  }
  if (sub === "events") {
    io.print(`events this device emits: ${EMITTED_EVENTS.join(", ")}`);
    return 0;
  }
  if (!sub || sub === "list") {
    const listed = await call<{ sinks: SinkView[] }>(io, "GET", "/v1/notify/sinks");
    if (!listed.ok) {
      io.printErr(`dpi notify: ${listed.error}`);
      return 1;
    }
    for (const line of formatSinks(listed.data.sinks ?? [])) io.print(line);
    return 0;
  }

  if (sub === "test") {
    const sent = await call<{ results: Delivery[] }>(io, "POST", "/v1/notify/test", {});
    if (!sent.ok) {
      io.printErr(`dpi notify: ${sent.error}`);
      return 1;
    }
    for (const line of formatResults(sent.data.results ?? [])) io.print(line);
    return (sent.data.results ?? []).some((r) => r.status === "failed") ? 1 : 0;
  }

  if (sub === "add") {
    const kind = flag(rest, "--kind") ?? "webhook";
    const url = flag(rest, "--url");
    if (!url || (kind !== "webhook" && kind !== "ntfy")) {
      io.printErr(`dpi notify add: --url is required and --kind is webhook|ntfy\n\n${NOTIFY_HELP}`);
      return 2;
    }
    const events = flag(rest, "--events");
    const tags = flag(rest, "--tags");
    const body = {
      kind,
      url,
      ...(flag(rest, "--label") ? { label: flag(rest, "--label") } : {}),
      ...(events ? { events: events.split(",").map((e) => e.trim()).filter(Boolean) } : {}),
      ...(flag(rest, "--priority") ? { priority: flag(rest, "--priority") } : {}),
      ...(tags ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
      ...(rest.includes("--disabled") ? { enabled: false } : {}),
    };
    const created = await call<SinkView>(io, "POST", "/v1/notify/sinks", body);
    if (!created.ok) {
      io.printErr(`dpi notify: ${created.error}`);
      return 1;
    }
    io.print(`created ${created.data.id.slice(0, 8)} — ${created.data.kind} ${created.data.url}`);
    return 0;
  }

  const prefix = positional(rest)[0];
  if (!prefix) {
    io.printErr(`dpi notify ${sub}: an id prefix is required\n\n${NOTIFY_HELP}`);
    return 2;
  }
  const listed = await call<{ sinks: SinkView[] }>(io, "GET", "/v1/notify/sinks");
  if (!listed.ok) {
    io.printErr(`dpi notify: ${listed.error}`);
    return 1;
  }
  const matches = matchSink(listed.data.sinks ?? [], prefix);
  if (!matches.length) {
    io.printErr(`dpi notify: no sink starts with '${prefix}'`);
    return 1;
  }
  if (matches.length > 1) {
    io.printErr(`dpi notify: '${prefix}' matches ${matches.length} sinks — be more specific:`);
    for (const m of matches) io.printErr(`  ${m.id.slice(0, 8)}  ${m.kind} ${m.url}`);
    return 2;
  }
  const target = matches[0];

  if (sub === "enable" || sub === "disable") {
    const patched = await call<SinkView>(io, "PATCH", `/v1/notify/sinks/${target.id}`, { enabled: sub === "enable" });
    if (!patched.ok) {
      io.printErr(`dpi notify: ${patched.error}`);
      return 1;
    }
    io.print(`${sub}d ${target.id.slice(0, 8)} — ${target.kind} ${target.url}`);
    return 0;
  }
  if (sub === "remove") {
    const removed = await call<{ removed: boolean }>(io, "DELETE", `/v1/notify/sinks/${target.id}`);
    if (!removed.ok) {
      io.printErr(`dpi notify: ${removed.error}`);
      return 1;
    }
    io.print(`removed ${target.id.slice(0, 8)} — ${target.url}`);
    return 0;
  }
  io.printErr(`dpi notify: unknown subcommand '${sub}'\n\n${NOTIFY_HELP}`);
  return 2;
}
