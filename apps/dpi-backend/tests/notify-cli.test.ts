import test from "node:test";
import assert from "node:assert/strict";
import { formatResults, formatSinks, matchSink, notifyCli, type SinkView } from "../src/notify-cli.js";
import type { ScheduleIo } from "../src/schedule-cli.js";

const sink = (over: Partial<SinkView> = {}): SinkView => ({
  id: "snk_abcdef123456",
  kind: "webhook",
  url: "https://example.com/hook",
  enabled: true,
  events: ["schedule.*"],
  label: "ops",
  lastDeliveryAt: Date.now() - 120_000,
  ...over,
});

function io(respond?: (init: { url: string; method?: string; body?: string }) => unknown) {
  const lines: string[] = [];
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const base: ScheduleIo = {
    env: { DPI_TOKEN: "t" },
    nodeVersion: "22.19.0",
    fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body) : undefined });
      const data = respond?.({ url, method: init?.method, body: init?.body as string }) ?? {};
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
  };
  return { io: base, lines, calls };
}

test("list prints each sink with its filter and last delivery", async () => {
  const { io: fake, lines } = io(() => ({ sinks: [sink()] }));
  assert.equal(await notifyCli(["list"], fake), 0);
  const text = lines.join("\n");
  assert.match(text, /webhook ops/);
  assert.match(text, /https:\/\/example\.com\/hook/);
  assert.match(text, /schedule\.\* · last sent 2m ago/);
});

test("add posts the flags it was given and nothing else", async () => {
  const { io: fake, calls } = io(() => sink());
  assert.equal(
    await notifyCli(
      ["add", "--kind", "ntfy", "--url", "https://ntfy.sh/topic", "--events", "session.failed,schedule.*", "--priority", "high", "--tags", "a,b", "--label", "phone"],
      fake,
    ),
    0,
  );
  assert.deepEqual(calls[0].body, {
    kind: "ntfy",
    url: "https://ntfy.sh/topic",
    events: ["session.failed", "schedule.*"],
    priority: "high",
    tags: ["a", "b"],
    label: "phone",
  });
  assert.equal(await notifyCli(["add", "--kind", "ntfy"], io().io), 2, "--url is required");
});

test("test prints per-sink results and exits 1 when any sink failed", async () => {
  const ok = io(() => ({ results: [{ id: "snk_1", kind: "webhook", status: "sent" }] }));
  assert.equal(await notifyCli(["test"], ok.io), 0);
  assert.match(ok.lines.join("\n"), /sent\s+webhook snk_1/);

  const bad = io(() => ({ results: [{ id: "snk_1", kind: "ntfy", status: "failed", detail: "ECONNREFUSED" }] }));
  assert.equal(await notifyCli(["test"], bad.io), 1);
  assert.match(bad.lines.join("\n"), /failed\s+ntfy snk_1 — ECONNREFUSED/);
});

test("enable/disable/remove hit the right route with an id prefix", async () => {
  const disable = io((init) => (init.method === "PATCH" ? sink({ enabled: false }) : { sinks: [sink()] }));
  assert.equal(await notifyCli(["disable", "snk_abc"], disable.io), 0);
  assert.deepEqual(disable.calls.at(-1), {
    method: "PATCH",
    url: "http://127.0.0.1:4780/v1/notify/sinks/snk_abcdef123456",
    body: { enabled: false },
  });
  assert.match(disable.lines.join("\n"), /disabled snk_abcd/);

  const remove = io((init) => (init.method === "DELETE" ? { removed: true } : { sinks: [sink()] }));
  assert.equal(await notifyCli(["remove", "snk_abc"], remove.io), 0);
  assert.match(remove.lines.join("\n"), /removed snk_abcd/);
});

test("ambiguous and unknown prefixes are refused; events lists what the device emits", async () => {
  const two = io(() => ({ sinks: [sink(), sink({ id: "snk_abcdef9" })] }));
  assert.equal(await notifyCli(["disable", "snk_abc"], two.io), 2);
  assert.match(two.lines.join("\n"), /matches 2 sinks/);

  const none = io(() => ({ sinks: [sink()] }));
  assert.equal(await notifyCli(["remove", "zzz"], none.io), 1);
  assert.match(none.lines.join("\n"), /no sink starts with 'zzz'/);

  const listed = io();
  assert.equal(await notifyCli(["events"], listed.io), 0);
  assert.match(listed.lines.join("\n"), /session\.failed, schedule\.ok, schedule\.failed, graph\.ok, graph\.failed, test/);
});

test("formatters stay honest about empty state", () => {
  assert.deepEqual(formatSinks([]), ["no sinks. Add one with `dpi notify add --url <url> --kind webhook|ntfy`."]);
  assert.deepEqual(formatResults([]), ["no enabled sinks matched — nothing was sent."]);
  assert.deepEqual(matchSink([sink()], "snk_abc").map((s) => s.id), ["snk_abcdef123456"]);
  assert.match(formatSinks([sink({ enabled: false, lastError: "ECONNREFUSED" })]).join("\n"), /last failed: ECONNREFUSED/);
});
