/**
 * Wave 2 SHOULD: notification fan-out wired into the device (sinks CRUD + the
 * events the device really emits) and the rate-limit classification a model
 * picker shows as a hint.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { faux, tempStore, until } from "./helpers.js";
import { classifyProviderError } from "../src/store.js";
import { NotifySinks } from "../src/notify-sinks.js";

test("sinks are CRUD-able on the store and a test event fans out", async () => {
  const t = await tempStore();
  const store = await t.open();
  const calls: string[] = [];
  try {
    const created = await store.createNotifySink({ kind: "webhook", url: "https://example.com/hook", label: "ops" });
    assert.equal(created.label, "ops");
    assert.equal(created.enabled, true);
    assert.equal(created.silencedUntil, null);
    assert.deepEqual(store.notifySinkList().map((s) => s.url), ["https://example.com/hook"]);

    // Swap the fetch so the test never leaves the box.
    const sinks = store.sinks as unknown as { fetchImpl: unknown };
    sinks.fetchImpl = async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => "", headers: new Map() };
    };
    const results = await store.testNotifySinks();
    assert.deepEqual(results.map((r) => r.status), ["sent"]);
    assert.deepEqual(calls, ["https://example.com/hook"]);

    const patched = await store.updateNotifySink(created.id, { enabled: false });
    assert.equal(patched.enabled, false);
    assert.deepEqual(await store.testNotifySinks(), [], "a disabled sink receives nothing");

    assert.deepEqual(await store.removeNotifySink(created.id), { removed: true });
    assert.deepEqual(store.notifySinkList(), []);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("LAN sinks are refused unless the operator opts in", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await assert.rejects(
      () => store.createNotifySink({ kind: "ntfy", url: "http://192.168.1.5/mytopic" }),
      /private|loopback|LAN/i,
      "a private host must not be accepted by default",
    );
    const open = await NotifySinks.open(`${t.root}/notify-lan.json`, { allowPrivateHosts: true });
    const sink = await open.create({ kind: "ntfy", url: "http://192.168.1.5/mytopic" });
    assert.equal(sink.kind, "ntfy");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a failed schedule emits schedule.failed to the sink", async () => {
  const t = await tempStore();
  const store = await t.open();
  const delivered: { kind: string; title: string }[] = [];
  try {
    const sink = await store.createNotifySink({ kind: "webhook", url: "https://example.com/hook" });
    assert.ok(sink.id);
    // Intercept delivery: this asserts the event the device chooses to emit.
    const spy = store.sinks as unknown as { deliver: unknown };
    spy.deliver = async (event: { kind: string; title: string }) => {
      delivered.push({ kind: event.kind, title: event.title });
      return [];
    };
    const bad = await store.createSchedule({
      name: "Broken",
      cwd: "project",
      model: { provider: "nope", modelId: "nope" },
      prompt: "go",
      everyMinutes: 30,
    });
    await store.runScheduleNow(bad.id);
    // R11 2.3: the run is armed, not finished — the failure event lands when
    // the turn actually fails.
    await until(() => delivered.some((d) => d.kind === "schedule.failed"), 5000, "the broken run fails");
    const kinds = delivered.map((d) => d.kind);
    assert.ok(kinds.includes("schedule.failed"), `expected schedule.failed, got ${kinds.join(",")}`);
    assert.match(delivered.find((d) => d.kind === "schedule.failed")!.title, /Broken/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a successful schedule emits schedule.ok", async () => {
  const t = await tempStore();
  const store = await t.open();
  const delivered: string[] = [];
  try {
    await store.createNotifySink({ kind: "webhook", url: "https://example.com/hook" });
    (store.sinks as unknown as { deliver: unknown }).deliver = async (event: { kind: string }) => {
      delivered.push(event.kind);
      return [];
    };
    const ok = await store.createSchedule({
      name: "Healthy",
      cwd: "project",
      model: faux,
      prompt: "Say only: ok",
      everyMinutes: 30,
    });
    await store.runScheduleNow(ok.id);
    await until(() => delivered.length === 1, 5000, "the healthy run's schedule.ok lands");
    assert.deepEqual(delivered, ["schedule.ok"]);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("provider errors are classified so a picker can say 'wait', not 'broken'", () => {
  assert.deepEqual(classifyProviderError("429 Too Many Requests, retry-after: 30"), {
    status: "rate_limited",
    retryAfterMs: 30_000,
  });
  assert.equal(classifyProviderError("rate limit exceeded for this key").status, "rate_limited");
  assert.equal(classifyProviderError("quota exceeded").status, "rate_limited");
  assert.equal(classifyProviderError("401 Unauthorized: invalid api key").status, "auth");
  assert.equal(classifyProviderError("403 forbidden").status, "auth");
  assert.equal(classifyProviderError("404 model not found").status, "missing");
  assert.equal(classifyProviderError("unknown model foo").status, "missing");
  assert.deepEqual(classifyProviderError("something else broke"), { status: "error" });
  assert.deepEqual(classifyProviderError(""), { status: "error" });
});

test("probeModel reports the provider's own words and a status", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const good = await store.probeModel(faux.provider, faux.modelId);
    assert.equal(good.ok, true);
    assert.equal(good.status, undefined, "a working model needs no status");

    const bad = await store.probeModel("nope", "nope");
    assert.equal(bad.ok, false);
    assert.ok(bad.detail.length > 0);
    assert.ok(bad.status, "a failure always carries a classifiable status");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
