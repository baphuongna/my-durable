/**
 * Wave 2b: scheduled sessions wired into the device — the loop, the dispatch
 * (a run is a fresh session + one prompt), and the recorded outcome.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { faux, tempStore } from "./helpers.js";

const input = (over: Record<string, unknown> = {}) => ({
  name: "Nightly check",
  cwd: "project",
  model: faux,
  prompt: "Say only: ok",
  everyMinutes: 60,
  ...over,
});

test("a schedule run creates its own session, sends the prompt and records the outcome", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const created = await store.createSchedule(input());
    assert.equal(created.enabled, true, "schedules start enabled");
    assert.ok(created.nextRunAt && created.nextRunAt > Date.now(), "the next run is in the future");
    assert.equal(created.running, false);
    assert.deepEqual(store.scheduleList().map((s) => s.name), ["Nightly check"]);

    const ran = await store.runScheduleNow(created.id);
    assert.equal(ran.lastOutcome, "ok", "the faux provider answers, so the run succeeds");
    assert.ok(ran.lastSessionId, "the run is attached to the session it created");
    assert.equal(ran.lastRunAt !== undefined, true);
    assert.equal(ran.lastError, undefined);

    // A run is a fresh session: the work of yesterday is never overwritten.
    const sessions = store.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, ran.lastSessionId);
    assert.match(sessions[0].name, /^Nightly check · /, "the session name carries the schedule and the time");

    // The prompt landed in the root agent's transcript.
    const { c } = await store.resolveAgent(sessions[0].id, "main");
    const transcript = await store.transcript(c, "json");
    const text = JSON.stringify(transcript.items);
    assert.match(text, /Say only: ok/, "the prompt reached the agent");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("the loop dispatches only what is due, and never a disabled schedule", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const hourly = await store.createSchedule(input({ name: "Hourly" }));
    const daily = await store.createSchedule(input({ name: "Daily", everyMinutes: undefined, dailyAt: "03:00" }));
    const off = await store.createSchedule(input({ name: "Off" }));
    await store.updateSchedule(off.id, { enabled: false });

    assert.deepEqual(await store.runDueSchedules(Date.now()), [], "nothing is due the moment it is created");
    assert.equal((await store.runDueSchedules(Date.now() + 2 * 3_600_000)).length, 1, "the hourly one comes due");
    // A daily 03:00 schedule is due within the next day, not within two hours.
    assert.equal((await store.runDueSchedules(Date.now() + 25 * 3_600_000)).length, 2, "hourly again + the daily slot");

    const after = store.scheduleList();
    assert.equal(after.find((s) => s.name === "Hourly")!.lastOutcome, "ok");
    assert.equal(after.find((s) => s.name === "Daily")!.lastOutcome, "ok");
    assert.equal(after.find((s) => s.name === "Off")!.lastRunAt, undefined, "a disabled schedule never runs");
    assert.equal(store.list().length, 3, "one session per run (hourly twice, daily once)");
    void hourly;
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a failing schedule records the error instead of breaking the loop", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    // An unknown model makes session creation fail inside the dispatch.
    const bad = await store.createSchedule(input({ name: "Broken", model: { provider: "nope", modelId: "nope" } }));
    const ran = await store.runScheduleNow(bad.id);
    assert.equal(ran.lastOutcome, "failed");
    assert.ok(ran.lastError, "the reason is recorded for the UI");
    assert.equal(store.list().length, 0, "no session was left behind");

    // The loop keeps going: a healthy schedule still runs in the same pass.
    const good = await store.createSchedule(input({ name: "Healthy" }));
    await store.runDueSchedules(Date.now() + 2 * 3_600_000);
    const list = store.scheduleList();
    assert.equal(list.find((s) => s.name === "Healthy")!.lastOutcome, "ok");
    assert.equal(list.find((s) => s.name === "Broken")!.lastOutcome, "failed", "the old failure is kept");
    void good;
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("schedules can be edited and removed, and the next run follows the trigger", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const created = await store.createSchedule(input({ everyMinutes: 30 }));
    const before = created.nextRunAt!;
    const slower = await store.updateSchedule(created.id, { everyMinutes: 120, name: "Renamed" });
    assert.equal(slower.name, "Renamed");
    assert.ok(slower.nextRunAt! > before, "a longer interval pushes the next run out");
    assert.equal(slower.prompt, created.prompt, "a partial patch keeps the prompt");

    await assert.rejects(() => store.updateSchedule(created.id, { everyMinutes: 2 }), /5|interval/i);

    assert.deepEqual(await store.removeSchedule(created.id), { removed: true });
    assert.deepEqual(store.scheduleList(), []);
    await assert.rejects(() => store.runScheduleNow(created.id), (e: unknown) => (e as { code?: string }).code === "not_found");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
