/**
 * Wave 2 of docs/host-project-checklist.md: the device-side schedule registry
 * ("Scheduled sessions"). The file is the contract the device loop reads, so
 * every test that mutates also looks at the bytes on disk — a registry that only
 * remembers in RAM would fire nothing after a restart.
 *
 * The clock is injected everywhere (`now: () => number`) so the interesting
 * cases — a device that was off for five hours, a daily slot that lands exactly
 * now, midnight wrap — are asserted instead of slept through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PROMPT_LENGTH,
  MIN_EVERY_MINUTES,
  ScheduleRegistry,
  ScheduleRegistryError,
  computeNextRun,
  formatDailyAt,
  migrate,
  newScheduleId,
  normaliseCwd,
  normaliseTrigger,
} from "../src/schedules.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const mode = (path: string) => stat(path).then((stats) => stats.mode & 0o777);

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "dpi-schedules-"));
  const dataDir = join(root, "data");
  return {
    root,
    dataDir,
    file: join(dataDir, "schedules.json"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** A settable clock, so a test can walk the device through an afternoon in a few lines. */
function clockAt(start: number) {
  const state = { now: start };
  return {
    now: () => state.now,
    set: (value: number) => {
      state.now = value;
    },
    advance: (ms: number) => {
      state.now += ms;
    },
  };
}

/** `open` with the warnings captured, so recovery is asserted instead of printed. */
function openWith(file: string, warnings: string[] = [], clock?: { now: () => number }) {
  return ScheduleRegistry.open(file, {
    warn: (message) => warnings.push(message),
    ...(clock ? { now: clock.now } : {}),
  });
}

const readFileJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  name: "Nightly tidy",
  cwd: "/srv/work/app",
  model: { provider: "anthropic", modelId: "claude-haiku" },
  prompt: "Tidy the TODO list and report what changed.",
  everyMinutes: 60,
  ...overrides,
});

const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);

test("create/list/get/update/remove round-trips through the file", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const nightly = await registry.create(baseInput());

    assert.match(nightly.id, /^sch_[0-9a-f]{12}$/);
    assert.equal(nightly.name, "Nightly tidy");
    assert.equal(nightly.cwd, "/srv/work/app");
    assert.deepEqual(nightly.model, { provider: "anthropic", modelId: "claude-haiku" });
    assert.equal(nightly.everyMinutes, 60);
    assert.equal("dailyAt" in nightly, false, "the unused trigger key is absent, not null");
    assert.equal(nightly.enabled, true, "a new schedule is live unless asked otherwise");
    assert.equal(nightly.createdAt, T0);
    assert.equal(nightly.updatedAt, T0);
    assert.equal("lastOutcome" in nightly, false, "never run yet");

    clock.advance(MINUTE);
    const morning = await registry.create(baseInput({ name: "Alpha sweep", cwd: "/srv/work/app/" }));
    assert.equal(morning.cwd, "/srv/work/app", "trailing separator stripped");
    assert.equal(morning.createdAt, T0 + MINUTE);

    assert.deepEqual(
      registry.list().map((record) => record.name),
      ["Alpha sweep", "Nightly tidy"],
      "list is sorted by the name a human reads",
    );
    assert.equal(registry.get(nightly.id)?.id, nightly.id);
    assert.equal(registry.get("sch_000000000000"), undefined);

    const renamed = await registry.update(nightly.id, { name: "Nightly tidy (quiet)", enabled: false });
    assert.equal(renamed.name, "Nightly tidy (quiet)");
    assert.equal(renamed.enabled, false);
    assert.equal(renamed.createdAt, T0, "createdAt is history and never rewritten");
    assert.equal(renamed.updatedAt, T0 + MINUTE, "updatedAt follows the clock");

    const onDisk = await readFileJson(s.file);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.schedules.length, 2);
    assert.equal(onDisk.schedules.find((record: { id: string }) => record.id === nightly.id).enabled, false);

    // A reopen reads both schedules back rather than minting new ones.
    const reopened = await openWith(s.file, [], clock);
    assert.deepEqual(
      reopened.list().map((record) => record.id),
      [morning.id, nightly.id],
    );

    assert.equal(await registry.remove(nightly.id), true);
    assert.equal(await registry.remove(nightly.id), false, "removing a missing schedule is a no-op");
    assert.deepEqual((await readFileJson(s.file)).schedules.map((record: { id: string }) => record.id), [
      morning.id,
    ]);

    await assert.rejects(
      () => registry.update("sch_000000000000", { name: "ghost" }),
      (error: unknown) => error instanceof ScheduleRegistryError && error.code === "not_found",
    );
  } finally {
    await s.cleanup();
  }
});

test("exactly one trigger: both, neither, too-short interval and bad HH:MM are rejected", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));

    await assert.rejects(
      () => registry.create(baseInput({ dailyAt: "09:00" })),
      /mutually exclusive/,
      "both triggers is a caller bug, not a preference",
    );
    await assert.rejects(
      () => registry.create(baseInput({ everyMinutes: undefined })),
      /one trigger/,
      "neither trigger would be a schedule that never runs",
    );
    await assert.rejects(() => registry.create(baseInput({ everyMinutes: 2 })), /between 5 and 1440/);
    await assert.rejects(() => registry.create(baseInput({ everyMinutes: 1441 })), /between 5 and 1440/);
    await assert.rejects(() => registry.create(baseInput({ everyMinutes: 30.5 })), /whole number/);
    const dailyOnly = (dailyAt: unknown) => baseInput({ everyMinutes: undefined, dailyAt });
    await assert.rejects(() => registry.create(dailyOnly("25:00")), /HH:MM/);
    await assert.rejects(() => registry.create(dailyOnly("9:05")), /HH:MM/, "one spelling per time");
    await assert.rejects(() => registry.create(dailyOnly("09:60")), /HH:MM/);
    await assert.rejects(() => registry.create(dailyOnly("0900")), /HH:MM/);
    await assert.rejects(() => registry.create(dailyOnly("")), /one trigger/, "a blank dailyAt is not a trigger");

    assert.deepEqual(registry.list(), [], "nothing was stored by the rejected calls");

    // The boundary values are allowed.
    const daily = await registry.create(baseInput({ name: "daily", everyMinutes: undefined, dailyAt: "00:00" }));
    assert.equal(daily.dailyAt, "00:00");
    const fastest = await registry.create(baseInput({ name: "fastest", everyMinutes: MIN_EVERY_MINUTES }));
    assert.equal(fastest.everyMinutes, MIN_EVERY_MINUTES);

    // Switching trigger requires saying what is being replaced.
    await assert.rejects(() => registry.update(daily.id, { everyMinutes: 30 }), /mutually exclusive/);
    const switched = await registry.update(daily.id, { everyMinutes: 30, dailyAt: undefined });
    assert.equal(switched.everyMinutes, 30);
    assert.equal("dailyAt" in switched, false, "the old trigger key is gone, not left behind");

    // A blank dailyAt counts as "not set", so a form can clear the field.
    assert.deepEqual(normaliseTrigger({ everyMinutes: 15, dailyAt: "" }), { everyMinutes: 15 });
    assert.deepEqual(normaliseTrigger({ dailyAt: " 07:45 " }), { dailyAt: "07:45" });
    assert.equal(formatDailyAt(9, 5), "09:05");
    assert.equal(formatDailyAt(0, 0), "00:00");
    assert.throws(() => formatDailyAt(24, 0), /hour must be 0–23/);
  } finally {
    await s.cleanup();
  }
});

test("name, cwd, model and prompt are validated", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));

    await assert.rejects(() => registry.create(baseInput({ model: "anthropic/claude-haiku" })), /model must be/);
    await assert.rejects(() => registry.create(baseInput({ model: { provider: "anthropic" } })), /model.modelId/);
    await assert.rejects(() => registry.create(baseInput({ model: { provider: "", modelId: "x" } })), /model.provider/);

    await assert.rejects(() => registry.create(baseInput({ name: "   " })), /name is required/);
    await assert.rejects(() => registry.create(baseInput({ name: "x".repeat(81) })), /the limit is 80/);
    await assert.rejects(() => registry.create(baseInput({ prompt: "" })), /prompt is required/);
    await assert.rejects(() => registry.create(baseInput({ prompt: "   " })), /prompt is required/);
    await assert.rejects(
      () => registry.create(baseInput({ prompt: "x".repeat(MAX_PROMPT_LENGTH + 1) })),
      /the limit is 8000/,
    );
    await assert.rejects(() => registry.create(baseInput({ cwd: "  " })), /cwd is required/);

    // A cwd is normalised but never probed: the mount may be offline right now.
    const offline = await registry.create(baseInput({ cwd: "/mnt/not-mounted-here/", name: "offline" }));
    assert.equal(offline.cwd, "/mnt/not-mounted-here");

    assert.equal(normaliseCwd("/a/b/"), "/a/b");
    assert.notEqual(newScheduleId(), newScheduleId(), "ids are not repeated");
    assert.match(newScheduleId(), /^sch_[0-9a-f]{12}$/);
    assert.equal(registry.list().length, 1, "only the valid schedule landed");
  } finally {
    await s.cleanup();
  }
});

test("computeNextRun counts an interval from createdAt and then from lastRunAt", async () => {
  const record = {
    enabled: true,
    createdAt: T0,
    everyMinutes: 60,
  };

  assert.equal(computeNextRun(record, T0), T0 + HOUR, "first slot is one interval after creation");
  assert.equal(computeNextRun(record, T0 + 30 * MINUTE), T0 + HOUR, "mid-interval asks for the same slot");
  assert.equal(computeNextRun(record, T0 + HOUR), T0 + 2 * HOUR, "a slot that just passed rolls to the next");
  assert.equal(computeNextRun(record, T0 + 5 * HOUR + 1), T0 + 6 * HOUR, "whole intervals only, no partial slot");
  assert.equal(computeNextRun({ ...record, enabled: false }, T0), undefined, "disabled is never due");
  assert.equal(
    computeNextRun({ enabled: true, createdAt: T0, dailyAt: undefined }, T0),
    undefined,
    "a record with no trigger is inert rather than crashing the loop",
  );

  const afterRun = { ...record, lastRunAt: T0 + 3 * HOUR };
  assert.equal(computeNextRun(afterRun, T0 + 3 * HOUR + 10 * MINUTE), T0 + 4 * HOUR, "counts from the last run");
});

test("an offline device catches up once and the next slot is in the future", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const schedule = await registry.create(baseInput({ everyMinutes: 60 }));

    // Five and a half hours later — the device was simply off.
    clock.advance(5 * HOUR + 30 * MINUTE);
    assert.deepEqual(
      registry.due().map((record) => record.id),
      [schedule.id],
      "one due record, not five",
    );
    assert.equal(registry.due().length, 1, "asking twice does not double-count a missed run");
    assert.ok((registry.nextRunAt(registry.get(schedule.id)!) ?? 0) > clock.now(), "the next slot is in the future");

    // The device runs it and reports back.
    const ran = await registry.markRun(schedule.id, { outcome: "ok", sessionId: "ses_1", at: clock.now() });
    assert.equal(ran.lastRunAt, clock.now());
    assert.deepEqual(registry.due(), [], "nothing is due until the next slot");
    assert.equal(registry.nextRunAt(ran), clock.now() + HOUR, "next slot counts from the run, not from creation");

    clock.advance(59 * MINUTE);
    assert.deepEqual(registry.due(), [], "not yet");
    clock.advance(1 * MINUTE);
    assert.deepEqual(registry.due().map((record) => record.id), [schedule.id], "and then it is due again");
  } finally {
    await s.cleanup();
  }
});

test("dailyAt resolves to the next local occurrence, strictly after now", async () => {
  const s = await scratch();
  try {
    const local = (day: number, hour: number, minute: number, second = 0) =>
      new Date(2026, 0, day, hour, minute, second, 0).getTime();
    const daily = (dailyAt: string) => ({ enabled: true, createdAt: local(15, 8, 0), dailyAt });

    assert.equal(
      computeNextRun(daily("09:00"), local(15, 8, 59)),
      local(15, 9, 0),
      "later today",
    );
    assert.equal(
      computeNextRun(daily("09:00"), local(15, 9, 0)),
      local(16, 9, 0),
      "exactly now has already happened, so the slot is tomorrow",
    );
    assert.equal(computeNextRun(daily("09:00"), local(15, 10, 0)), local(16, 9, 0), "today's slot has passed");
    assert.equal(
      computeNextRun(daily("00:30"), local(15, 23, 45)),
      local(16, 0, 30),
      "midnight wrap",
    );
    assert.equal(computeNextRun(daily("00:30"), local(15, 0, 15)), local(15, 0, 30), "same day after midnight");
    assert.equal(
      computeNextRun(daily("23:59"), local(31, 23, 59, 30)),
      local(32, 23, 59),
      "month end rolls over like any other day",
    );

    // A daily schedule that was created before its slot and never ran is due once.
    const clock = clockAt(local(15, 10, 0));
    const registry = await openWith(s.file, [], clock);
    const record = await registry.create(
      baseInput({ name: "morning report", everyMinutes: undefined, dailyAt: "09:00" }),
    );
    assert.deepEqual(registry.due(), [], "created after today's slot: nothing to catch up on");

    clock.set(local(16, 9, 0));
    assert.deepEqual(registry.due().map((entry) => entry.id), [record.id], "due at the slot");
    const ran = await registry.markRun(record.id, { outcome: "ok", at: clock.now() });
    assert.deepEqual(registry.due(), []);
    assert.equal(registry.nextRunAt(ran), local(17, 9, 0), "tomorrow at 09:00 local");
  } finally {
    await s.cleanup();
  }
});

test("due() is ordered by name and never includes a disabled schedule", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const zeta = await registry.create(baseInput({ name: "zeta", everyMinutes: 5 }));
    const alpha = await registry.create(baseInput({ name: "alpha", everyMinutes: 5 }));
    const middle = await registry.create(baseInput({ name: "middle", everyMinutes: 5 }));
    await registry.create(baseInput({ name: "later", everyMinutes: 1440 }));

    clock.advance(10 * MINUTE);
    assert.deepEqual(
      registry.due().map((record) => record.name),
      ["alpha", "middle", "zeta"],
      "what the device loop iterates is stable and human-ordered",
    );
    assert.equal(
      registry.due(T0 + 5 * MINUTE - 1).length,
      0,
      "`at` is honoured: nothing was due a millisecond before the first slot",
    );
    assert.equal(registry.due(T0 + 5 * MINUTE).length, 3, "and the slot itself is due");

    await registry.update(middle.id, { enabled: false });
    assert.deepEqual(
      registry.due().map((record) => record.id),
      [alpha.id, zeta.id],
      "a disabled schedule is skipped",
    );
    assert.equal(registry.nextRunAt(registry.get(middle.id)!), undefined, "and has no next run at all");
  } finally {
    await s.cleanup();
  }
});

test("markRun records the outcome, the session and clears a stale error", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const schedule = await registry.create(baseInput());

    const failed = await registry.markRun(schedule.id, {
      outcome: "failed",
      sessionId: "ses_bad",
      error: "  provider returned 429  ",
      at: T0 + HOUR,
    });
    assert.equal(failed.lastOutcome, "failed");
    assert.equal(failed.lastError, "provider returned 429", "trimmed");
    assert.equal(failed.lastSessionId, "ses_bad");
    assert.equal(failed.lastRunAt, T0 + HOUR);

    const ok = await registry.markRun(schedule.id, { outcome: "ok", sessionId: "ses_good" });
    assert.equal(ok.lastOutcome, "ok");
    assert.equal(ok.lastSessionId, "ses_good");
    assert.equal("lastError" in ok, false, "a success clears the reason the last one failed");
    assert.equal(ok.lastRunAt, T0, "no `at` means the registry clock");
    assert.equal(ok.updatedAt, T0);

    const onDisk = await readFileJson(s.file);
    assert.equal(onDisk.schedules[0].lastOutcome, "ok");
    assert.equal(onDisk.schedules[0].lastSessionId, "ses_good");
    assert.equal(onDisk.schedules[0].lastError, undefined);

    await assert.rejects(
      () => registry.markRun("sch_000000000000", { outcome: "ok" }),
      (error: unknown) => error instanceof ScheduleRegistryError && error.code === "not_found",
    );
    await assert.rejects(
      () => registry.markRun(schedule.id, { outcome: "maybe" as never }),
      /unknown run outcome/,
    );
  } finally {
    await s.cleanup();
  }
});

test("a v0 file (no version field) migrates and the next write stamps v1", async () => {
  const s = await scratch();
  try {
    await mkdir(s.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(
      s.file,
      JSON.stringify({
        schedules: [
          {
            name: "Legacy nightly",
            cwd: "/srv/checkout",
            model: { provider: "anthropic", modelId: "claude-haiku" },
            prompt: "Check the deploy.",
            dailyAt: "03:15",
            enabled: true,
            lastRunAt: T0,
            lastOutcome: "ok",
            createdAt: T0,
            updatedAt: T0,
          },
        ],
      }),
      "utf8",
    );

    const warnings: string[] = [];
    const clock = clockAt(T0 + HOUR);
    const registry = await openWith(s.file, warnings, clock);
    const [record] = registry.list();
    assert.equal(registry.list().length, 1, "no record was dropped");
    assert.match(record.id ?? "", /^sch_[0-9a-f]{12}$/, "an id is minted for a v0 record");
    assert.equal(record.dailyAt, "03:15");
    assert.equal(record.lastOutcome, "ok");
    assert.equal(record.lastRunAt, T0);
    assert.deepEqual(warnings, [], "a clean v0 file is not a warning");

    // The migration is durable: the next mutation writes the versioned document.
    await registry.update(record.id, { name: "Legacy nightly (kept)" });
    const onDisk = await readFileJson(s.file);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.schedules[0].id, record.id);

    // migrate() is pure and refuses a shape it does not know, rather than guessing.
    assert.throws(() => migrate({ version: 2, schedules: [] }), /unsupported registry version 2/);
    assert.deepEqual(migrate({ version: 1, schedules: [] }), []);
    assert.deepEqual(migrate({ schedules: [] }), [], "v0 without a version field is fine");
    assert.throws(() => migrate({ schedules: [{ name: "no cwd" }] }), /has no cwd/);
  } finally {
    await s.cleanup();
  }
});

test("a corrupt main file falls back to the .bak copy", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const keep = await registry.create(baseInput({ name: "keep" }));
    // The second write copies the first good file to `.bak`.
    await registry.create(baseInput({ name: "later" }));
    assert.equal((await readFileJson(`${s.file}.bak`)).schedules.length, 1);

    await writeFile(s.file, "{ this is not json", "utf8");

    const warnings: string[] = [];
    const reopened = await openWith(s.file, warnings, clock);
    assert.deepEqual(
      reopened.list().map((record) => record.id),
      [keep.id],
      "the backup's schedule came back",
    );
    assert.ok(
      warnings.some((line) => line.includes("unusable")),
      `the recovery was reported: ${JSON.stringify(warnings)}`,
    );
    const names = await readdir(s.dataDir);
    assert.ok(
      names.some((name) => name.startsWith("schedules.json.corrupt-")),
      "the corrupt file was kept aside, not deleted",
    );
  } finally {
    await s.cleanup();
  }
});

test("main and .bak both corrupt → empty registry, bad file moved aside", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    await registry.create(baseInput({ name: "gone" }));
    await registry.create(baseInput({ name: "gone2" }));
    await writeFile(s.file, "garbage", "utf8");
    await writeFile(`${s.file}.bak`, "\u0000\u0001 also garbage", "utf8");

    const warnings: string[] = [];
    const reopened = await openWith(s.file, warnings, clock);
    assert.deepEqual(reopened.list(), []);
    assert.ok(warnings.some((line) => line.includes("unusable")));
    assert.ok(warnings.some((line) => line.includes("unusable too")));

    const names = await readdir(s.dataDir);
    assert.ok(names.some((name) => name.startsWith("schedules.json.corrupt-")));
    assert.equal(names.includes("schedules.json"), false, "the torn file is no longer the registry");

    // A recovered-from-nothing registry still works, and nothing was written over the bad file.
    const fresh = await reopened.create(baseInput({ name: "fresh" }));
    assert.equal(reopened.list().length, 1);
    assert.equal((await readFileJson(s.file)).schedules[0].id, fresh.id);
  } finally {
    await s.cleanup();
  }
});

test("every mutation writes atomically with 0600 and leaves no temp file behind", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const schedule = await registry.create(baseInput({ name: "secure" }));
    await registry.update(schedule.id, { prompt: "Do the thing.", enabled: false });
    await registry.markRun(schedule.id, { outcome: "failed", error: "no cwd" });

    const parsed = await readFileJson(s.file);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.schedules.length, 1);
    assert.equal(parsed.schedules[0].prompt, "Do the thing.");
    assert.equal(parsed.schedules[0].lastError, "no cwd");

    assert.equal(await mode(s.file), 0o600, "registry file is owner-only");
    assert.equal(await mode(s.dataDir), 0o700, "its directory is owner-only");
    assert.equal(await mode(`${s.file}.bak`), 0o600, "the backup is owner-only too");

    const names = await readdir(s.dataDir);
    assert.deepEqual(
      names.filter((name) => name.includes(".tmp-")),
      [],
      "renames leave no temp files",
    );
  } finally {
    await s.cleanup();
  }
});

test("concurrent creates all land with unique ids", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) => registry.create(baseInput({ name: `burst ${index}` }))),
    );

    assert.equal(new Set(created.map((record) => record.id)).size, 8, "eight ids, no collisions");
    assert.equal(registry.list().length, 8);
    assert.equal((await readFileJson(s.file)).schedules.length, 8, "and all eight on disk");
  } finally {
    await s.cleanup();
  }
});

test("records are returned as copies, so a caller cannot mutate the cache", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));
    const schedule = await registry.create(baseInput());

    const listed = registry.list()[0]!;
    listed.name = "hacked";
    listed.model.modelId = "hacked";
    assert.equal(registry.get(schedule.id)?.name, "Nightly tidy");
    assert.equal(registry.get(schedule.id)?.model.modelId, "claude-haiku");
  } finally {
    await s.cleanup();
  }
});
