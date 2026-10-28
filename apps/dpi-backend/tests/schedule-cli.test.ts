/**
 * `dpi schedule` — the CLI is a thin client over the device API: one wrong flag
 * must fail loudly rather than silently writing nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatSchedules, matchSchedule, scheduleCli, type ScheduleIo } from "../src/schedule-cli.js";
import type { ScheduleView } from "../src/schedule-cli.js";

const record = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  id: "sch_abcdef123456",
  name: "Nightly",
  cwd: "/work",
  model: { provider: "zai", modelId: "glm-4.7" },
  prompt: "go",
  everyMinutes: 60,
  enabled: true,
  nextRunAt: Date.now() + 3_600_000,
  running: false,
  ...over,
});

function io(over: Partial<ScheduleIo> & { respond?: (init: RequestInit & { url: string }) => unknown } = {}) {
  const lines: string[] = [];
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const base: ScheduleIo = {
    env: { DPI_TOKEN: "t" },
    nodeVersion: "22.19.0",
    fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body) : undefined });
      const data = over.respond?.({ url, ...(init ?? {}) }) ?? {};
      return { ok: true, status: 200, json: async () => data } as never;
    },
    access: () => undefined,
    exists: () => false,
    readFile: () => "",
    homedir: () => "/home/x",
    timeoutMs: 1000,
    hubTimeoutMs: 1000,
    probeTimeoutMs: 1000,
    requiredNode: ">=22.19.0",
    print: (l) => lines.push(l),
    printErr: (l) => lines.push(`ERR ${l}`),
    ...over,
  };
  return { io: base, lines, calls };
}

test("formatSchedules shows the trigger, the state, the next run and the last outcome", () => {
  const lines = formatSchedules([record(), record({ id: "sch_2", name: "Paused", enabled: false, lastOutcome: "failed", lastError: "model_error" })]);
  assert.match(lines[0], /sch_abcd  Nightly — every 60m, enabled, next in 1h/);
  assert.match(lines[0], /\/work/);
  assert.match(lines[1], /disabled/);
  assert.match(lines[1], /last failed \(model_error\)/);
  assert.deepEqual(formatSchedules([]), ["no schedules. Add one with `dpi schedule add --help`."]);
});

test("matchSchedule matches a typed id prefix", () => {
  const list = [record(), record({ id: "sch_zzz" })];
  assert.deepEqual(matchSchedule(list, "sch_abc").map((s) => s.id), ["sch_abcdef123456"]);
  assert.deepEqual(matchSchedule(list, "sch"), list, "a broad prefix matches both");
  assert.deepEqual(matchSchedule(list, "nope"), []);
});

test("list calls the device and prints what it returned", async () => {
  const { io: fake, lines, calls } = io({ respond: () => ({ schedules: [record()] }) });
  assert.equal(await scheduleCli(["list"], fake), 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET http://127.0.0.1:4780/v1/schedules"]);
  assert.match(lines.join("\n"), /Nightly — every 60m/);
});

test("add requires the whole shape and posts exactly one trigger", async () => {
  const missing = io();
  assert.equal(await scheduleCli(["add", "--name", "x"], missing.io), 2);
  assert.match(missing.lines.join("\n"), /--name, --cwd, --prompt and --model are required/);

  const ok = io({ respond: () => record({ everyMinutes: undefined, dailyAt: "03:00" }) });
  assert.equal(
    await scheduleCli(
      ["add", "--name", "Nightly", "--cwd", "/work", "--prompt", "go", "--model", "zai/glm-4.7", "--daily", "03:00"],
      ok.io,
    ),
    0,
  );
  assert.deepEqual(ok.calls[0].body, {
    name: "Nightly",
    cwd: "/work",
    prompt: "go",
    model: { provider: "zai", modelId: "glm-4.7" },
    dailyAt: "03:00",
  });
  assert.match(ok.lines.join("\n"), /created sch_abcd — Nightly, daily 03:00/);
});

test("a prefix that matches several schedules is refused, not guessed", async () => {
  const { io: fake, lines } = io({ respond: () => ({ schedules: [record(), record({ id: "sch_abcdef999", name: "Other" })] }) });
  assert.equal(await scheduleCli(["run", "sch_abc"], fake), 2);
  assert.match(lines.join("\n"), /matches 2 schedules/);
});

test("run arms the run and reports where the outcome lands (R11 2.3)", async () => {
  const okRun = io({ respond: (init) => (init.url.endsWith("/run") ? record({ running: true }) : { schedules: [record()] }) });
  assert.equal(await scheduleCli(["run", "sch_abc"], okRun.io), 0);
  assert.match(okRun.lines.join("\n"), /run started/);
  // R12 P3-9: the `armed` alternative is dead code — the guard-add runs
  // synchronously before the 202 is built, so `running` is always true.
  assert.doesNotMatch(okRun.lines.join("\n"), /armed/);
});

test("enable/disable PATCH the flag; remove DELETEs; no token is a clear error", async () => {
  const disable = io({ respond: (init) => (init.method === "PATCH" ? record({ enabled: false }) : { schedules: [record()] }) });
  assert.equal(await scheduleCli(["disable", "sch_abc"], disable.io), 0);
  assert.deepEqual(disable.calls.at(-1), { method: "PATCH", url: "http://127.0.0.1:4780/v1/schedules/sch_abcdef123456", body: { enabled: false } });

  const remove = io({ respond: (init) => (init.method === "DELETE" ? { removed: true } : { schedules: [record()] }) });
  assert.equal(await scheduleCli(["remove", "sch_abc"], remove.io), 0);
  assert.match(remove.lines.join("\n"), /removed sch_abcd — Nightly/);

  const noToken = io({ env: {} });
  assert.equal(await scheduleCli(["list"], noToken.io), 1);
  assert.match(noToken.lines.join("\n"), /no DPI_TOKEN/);
});
