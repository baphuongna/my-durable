/**
 * R11 — the R9 audit's export/schedule follow-ups, implemented directly:
 *
 *   1.1  the export spill file lives beside the DATA DIR (or DPI_EXPORT_TMPDIR),
 *        never blind os.tmpdir() (tmpfs /tmp is RAM — the R5 cliff's back door).
 *   1.2  a session whose store db already exceeds the export ceiling refuses
 *        BEFORE the first stringify (heap death → polite, remedy-naming fault).
 *   2.2  a failed intent-marker persist SKIPS the dispatch (the run has not
 *        started, so not running it is correct) — the schedule cannot re-fire
 *        at tick rate, and the degraded episode is reported ONCE, not per tick.
 *   2.3  run-now returns as soon as the run is ARMED; the outcome lands in the
 *        record and the events (a slow turn no longer holds HTTP hostage).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { streamSessionBundle } from "../src/zip.js";
import { parseArchivedName } from "../src/gc.js";
import { faux, tempStore, until } from "./helpers.js";

const seams = (store: Store): Record<string, unknown> => store as unknown as Record<string, unknown>;
const keepAlive = () => {
  const keep = setInterval(() => {}, 50);
  return () => clearInterval(keep);
};

test("2.3 run-now arms the run and returns while the turn is still in flight", async () => {
  const t = await tempStore();
  const store = await t.open();
  const stopKeepAlive = keepAlive();
  try {
    const s = await store.createSchedule({
      name: "Slow",
      cwd: "project",
      model: faux,
      prompt: "Say only: ok",
      everyMinutes: 30,
    });
    let gate!: () => void;
    const gated = new Promise<void>((resolve) => (gate = resolve));
    let creates = 0;
    const realCreate = store.create.bind(store) as (...args: unknown[]) => Promise<unknown>;
    seams(store).create = (...args: unknown[]) => {
      creates += 1;
      return gated.then(() => realCreate(...args));
    };

    const t0 = Date.now();
    const view = await store.runScheduleNow(s.id);
    assert.ok(Date.now() - t0 < 2000, "run-now returns before the (gated) turn completes");
    assert.equal(view.running, true, "the view says the run is in flight");
    await until(() => creates === 1, 3000, "the dispatch reached the gated create");

    // A second Run click while in flight still gets the typed busy fault.
    await assert.rejects(
      () => store.runScheduleNow(s.id),
      (e: unknown) => (e as { code?: string }).code === "busy",
    );

    gate();
    await until(() => store.scheduleList()[0]?.lastOutcome === "ok", 5000, "the released run completes");
    assert.equal(store.scheduleList()[0]?.running, false);
  } finally {
    stopKeepAlive();
    await store.close();
    await t.cleanup();
  }
});

test("2.2 a failed intent-marker persist skips the dispatch and reports the degraded episode once", async () => {
  const t = await tempStore();
  const store = await t.open();
  const stopKeepAlive = keepAlive();
  try {
    const s = await store.createSchedule({
      name: "Paused",
      cwd: "project",
      model: faux,
      prompt: "Say only: ok",
      everyMinutes: 30,
    });
    const delivered: { kind: string; title: string }[] = [];
    (store.sinks as unknown as { deliver: unknown }).deliver = async (event: { kind: string; title: string }) => {
      delivered.push({ kind: event.kind, title: event.title });
      return [];
    };
    await store.createNotifySink({ kind: "webhook", url: "https://example.com/hook" });

    let creates = 0;
    const realCreate = store.create.bind(store) as (...args: unknown[]) => Promise<unknown>;
    seams(store).create = (...args: unknown[]) => {
      creates += 1;
      return realCreate(...args);
    };
    // The registry is unwritable: EVERY markRun rejects.
    const registry = store.schedules as unknown as { markRun: unknown };
    const realMarkRun = registry.markRun as (...args: unknown[]) => Promise<unknown>;
    registry.markRun = () => Promise.reject(new Error("ENOSPC: registry unwritable"));

    // Two due passes while degraded: zero real runs, exactly ONE pause event.
    // (everyMinutes: 30 — a pass is "due" only past the next slot.)
    await store.runDueSchedules(Date.now() + 31 * 60_000);
    await store.runDueSchedules(Date.now() + 61 * 60_000);
    assert.equal(creates, 0, "no session is created while the registry is unwritable");
    await until(() => delivered.some((d) => d.title.includes("Paused")), 3000, "the pause event lands");
    assert.equal(
      delivered.filter((d) => d.kind === "schedule.failed").length,
      1,
      "ONE degraded event per episode, not one per tick",
    );
    // The run record shows nothing started — due() keeps offering, we keep skipping.
    assert.notEqual(store.scheduleList()[0]?.lastOutcome, "ok");

    // Recovery: the registry writes again — the next due pass RUNS, the episode
    // ends, and a resume event is followed by the run's own ok.
    registry.markRun = realMarkRun;
    await store.runDueSchedules(Date.now() + 91 * 60_000);
    await until(() => store.scheduleList()[0]?.lastOutcome === "ok", 5000, "the recovered run completes");
    assert.equal(creates, 1, "exactly one real run after recovery");
    const titles = delivered.map((d) => d.title).join("\n");
    assert.match(titles, /resumed/i, "the episode's end is reported");
  } finally {
    stopKeepAlive();
    await store.close();
    await t.cleanup();
  }
});

test("1.1 the export spill file lands beside the data dir, and DPI_EXPORT_TMPDIR overrides", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await store.create({ name: "export-src", cwd: "project", model: faux });
    const target = (await store.list())[0]!;

    const bundle = await streamSessionBundle(store, target);
    try {
      assert.ok(
        bundle.path.startsWith(t.options.dataDir),
        `spill file lands beside the data dir (${bundle.path}), not blind os.tmpdir()`,
      );
      assert.equal((await stat(bundle.path)).size, bundle.bytes, "Content-Length source is the real file");
    } finally {
      await bundle.cleanup();
    }

    const override = await mkdtemp(join(tmpdir(), "r11-tmp-"));
    process.env.DPI_EXPORT_TMPDIR = override;
    try {
      const b2 = await streamSessionBundle(store, target);
      try {
        assert.ok(b2.path.startsWith(override), "DPI_EXPORT_TMPDIR wins");
      } finally {
        await b2.cleanup();
      }
      assert.deepEqual(await readdir(override), [], "cleanup unlinks the override spill too");
    } finally {
      delete process.env.DPI_EXPORT_TMPDIR;
      await rm(override, { recursive: true, force: true });
    }
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("1.2 a session db over the ceiling refuses BEFORE any stringify, naming the remedy", async () => {
  const t = await tempStore();
  const store = await t.open();
  const scratch = await mkdtemp(join(tmpdir(), "r11-huge-"));
  try {
    // A sparse 2 MiB file standing in for a monster session db.
    const huge = join(scratch, "huge.sqlite");
    const handle = await open(huge, "w");
    await handle.write(Buffer.from("x"), 0, 1, 2 * 1024 * 1024);
    await handle.close();
    const row = { id: "x1", name: "Monster", dbPath: huge } as unknown as Parameters<
      typeof streamSessionBundle
    >[1];

    await assert.rejects(
      () => streamSessionBundle(store, row, { ceilingBytes: 1024 * 1024 }),
      (e: unknown) => {
        const fault = e as { code?: string; message?: string };
        assert.equal(fault.code, "invalid", "typed invalid fault, not a 500/OOM");
        assert.match(fault.message ?? "", /2\.0 MiB/);
        assert.match(fault.message ?? "", /export ceiling/);
        assert.match(fault.message ?? "", /Compact the session first/);
        return true;
      },
    );
    // No spill file was created before the refusal.
    assert.deepEqual(
      (await readdir(t.options.dataDir)).filter((n) => n.startsWith(".dpi-export-")),
      [],
      "the pre-check refuses before touching disk",
    );
  } finally {
    await store.close();
    await t.cleanup();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("4.1 the tightened bundle pattern keeps canonical bundles and rejects lookalikes", () => {
  assert.deepEqual(parseArchivedName("aaaa1111-0000-0000-0000-000000000000-1790000000000"), {
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    closedAt: 1790000000000,
  });
  // 36 dashes, hex-without-dashes, uppercase: all lookalikes now.
  assert.equal(parseArchivedName("------------------------------------1790000000000"), undefined);
  assert.equal(parseArchivedName("aaaa11110000000000000000000000000000-1790000000000"), undefined);
  assert.equal(parseArchivedName("AAAA1111-0000-0000-0000-000000000000-1790000000000"), undefined);
});
