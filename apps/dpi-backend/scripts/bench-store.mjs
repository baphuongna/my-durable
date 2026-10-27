#!/usr/bin/env node
/**
 * R8 store-perf benchmark — plain node script, no test framework.
 *
 * Measures per-op latency (p50/p95/max in ms) of the real Store APIs against a
 * throwaway sandbox home (default /tmp/r8perf), plus a paired raw-sqlite
 * commit control (synchronous=FULL vs NORMAL) so any catalog pragma change is
 * evidence-backed rather than assumed.
 *
 * Mix (flags tune the counts):
 *   - N session creates  (Store.create → catalog INSERT + per-session sqlite open)
 *   - M catalog insert+commit cycles (BEGIN/INSERT/COMMIT on the real catalog,
 *     the exact shape idempotency.ts writes per POST)
 *   - A entry appends    (conversation commit → tx.appendEntry → per-session DB)
 *   - P entry-list pages (Store.entries, first-page + full-walk pages)
 *   - G git-status cycles (fresh spawn each, cache bypassed via a future `now`)
 *
 * Run with the backend's tsx loader (same as `npm start`):
 *   cd apps/dpi-backend && node --import tsx scripts/bench-store.mjs
 * (equivalently: npx tsx scripts/bench-store.mjs)
 *
 * Flags: --home /tmp/r8perf --sessions 100 --appends 2000 --pages 500
 *        --git 6 --catalog-commits 300 --label before
 *
 * The sandbox home's data dir is WIPED at start so every run (before/after a
 * store change) starts from the same empty state.
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { Store } = await import(join(here, "../src/store.js"));
const { gitStatus } = await import(join(here, "../src/git.js"));

// ---------------------------------------------------------------- flags
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const HOME = String(arg("home", "/tmp/r8perf"));
const N_SESSIONS = Number(arg("sessions", 100));
const N_APPENDS = Number(arg("appends", 2000));
const N_PAGES = Number(arg("pages", 500));
const N_GIT = Number(arg("git", 6));
const N_CATALOG_COMMITS = Number(arg("catalog-commits", 300));
const LABEL = String(arg("label", "run"));

// ---------------------------------------------------------------- sandbox
const DATA_DIR = join(HOME, "backend");
const WORK = join(HOME, "work");
const REPO = join(WORK, "repo");
rmSync(DATA_DIR, { recursive: true, force: true });
rmSync(REPO, { recursive: true, force: true });
mkdirSync(join(REPO, "nested"), { recursive: true });
writeFileSync(join(REPO, "README.md"), "# r8 bench\n");
const git = (...args) => execFileSync("git", args, { cwd: REPO, stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "bench@example.com");
git("config", "user.name", "r8 bench");
git("add", ".");
git("commit", "-qm", "bench seed");

// ---------------------------------------------------------------- stats
const pct = (samples, p) => {
  const s = [...samples].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
};
const mean = (s) => s.reduce((a, b) => a + b, 0) / s.length;
const r = (ms) => (ms >= 100 ? Math.round(ms) : Math.round(ms * 1000) / 1000);
const results = [];
const bench = (name, count, fn) => {
  const samples = [];
  const t0 = performance.now();
  for (let i = 0; i < count; i += 1) {
    const s = performance.now();
    fn(i);
    samples.push(performance.now() - s);
  }
  const total = performance.now() - t0;
  const row = {
    op: name,
    count,
    totalMs: r(total),
    meanMs: r(mean(samples)),
    p50: r(pct(samples, 50)),
    p95: r(pct(samples, 95)),
    max: r(Math.max(...samples)),
    over20ms: samples.filter((x) => x > 20).length,
  };
  results.push(row);
  return row;
};
const benchAsync = async (name, count, fn) => {
  const samples = [];
  const t0 = performance.now();
  for (let i = 0; i < count; i += 1) {
    const s = performance.now();
    await fn(i);
    samples.push(performance.now() - s);
  }
  const total = performance.now() - t0;
  const row = {
    op: name,
    count,
    totalMs: r(total),
    meanMs: r(mean(samples)),
    p50: r(pct(samples, 50)),
    p95: r(pct(samples, 95)),
    max: r(Math.max(...samples)),
    over20ms: samples.filter((x) => x > 20).length,
  };
  results.push(row);
  return row;
};

// ---------------------------------------------------------------- run
const started = performance.now();
const load0 = loadavg()[0];
console.log(`[r8-bench] home=${HOME} label=${LABEL} load1m(start)=${load0.toFixed(2)}`);

const store = await Store.open({
  dataDir: DATA_DIR,
  startDirs: [WORK],
  name: "r8-bench",
  provider: "faux",
});

// 1) Session creates: catalog insert + openAgent (fresh per-session sqlite) + gitStatus.
console.log("[r8-bench] store open — starting session.create");
const ids = [];
await benchAsync("session.create", N_SESSIONS, async (i) => {
  const s = await store.create({ name: `bench-${String(i).padStart(4, "0")}`, cwd: REPO });
  ids.push(s.id);
});
console.log("[r8-bench] session.create done");

// 2) Catalog insert+commit cycles — the exact write shape idempotency.ts does per POST.
//    This is the pragma-sensitive path: journal WAL + synchronous=<default FULL> today.
const insert = store.catalog.prepare(
  "INSERT OR REPLACE INTO requests(key,route,status,body,createdAt) VALUES(?,?,?,?,?)",
);
console.log("[r8-bench] starting catalog.insert+commit");
bench("catalog.insert+commit", N_CATALOG_COMMITS, (i) => {
  store.catalog.exec("BEGIN");
  try {
    insert.run(`bench-${LABEL}-${i}`, "POST /v1/sessions", 201, '"bench"', Date.now());
    store.catalog.exec("COMMIT");
  } catch (e) {
    store.catalog.exec("ROLLBACK");
    throw e;
  }
});

// 2b) openAgent isolation: catalog rows inserted by hand, then ONLY the harness/sqlite
//     open is timed — splits session.create's cost between the catalog write and the
//     per-session DB open (migrations + Harness.open).
const agentRows = [];
for (let i = 0; i < Math.min(10, N_SESSIONS); i += 1) {
  const base = store.row(ids[i]);
  const id = randomUUID();
  const row = {
    id,
    name: `bench-agent-${String(i).padStart(4, "0")}`,
    cwd: REPO,
    dbPath: join(store.sessionsDir, id, "agent.sqlite"),
    createdAt: Date.now(),
    model: base.model,
    provider: base.provider,
  };
  store.catalog
    .prepare("INSERT INTO sessions(id,name,cwd,dbPath,createdAt,model,provider) VALUES(?,?,?,?,?,?,?)")
    .run(row.id, row.name, row.cwd, row.dbPath, row.createdAt, row.model, row.provider);
  agentRows.push(row);
}
await benchAsync("agent.open(solo)", agentRows.length, async (i) => {
  await store.openAgent(agentRows[i], true);
});

// 3) Entry appends into session 0's conversation (real append API: commit → tx.appendEntry).
console.log("[r8-bench] starting entry.append");
const row0 = store.row(ids[0]);
const { c } = await store.resolveAgent(row0.id, "main");
await benchAsync("entry.append", N_APPENDS, async (i) => {
  await c.commit(async (tx) => {
    await tx.appendEntry(c.id, {
      kind: "bench.entry",
      data: { i, text: `r8 benchmark entry ${i} — realistic mixed-length payload ${"x".repeat(80 + (i % 120))}` },
    });
  }, ctx);
});

// 4) Entry-list pages: first page re-reads (UI poll shape) + one full walk (deep pages).
console.log("[r8-bench] starting entries pages");
await benchAsync("entries.page(first)", N_PAGES, async () => {
  const page = await store.entries(c, undefined, 100);
  if (!page.items.length) throw Error("expected entries");
});
await benchAsync("entries.page(full-walk)", N_PAGES, async () => {
  let cursor;
  let pages = 0;
  let items = 0;
  for (;;) {
    const page = await store.entries(c, cursor, 100);
    pages += 1;
    items += page.items.length;
    cursor = page.next;
    if (!cursor) break;
    if (pages > 500) throw Error("walk did not terminate");
  }
  if (items === 0) throw Error("expected entries");
});

// 5) Git-status cycles: fresh git spawn each time (cache bypassed via a future `now`).
console.log("[r8-bench] starting git.status");
const futureNow = () => Date.now() + 3_600_000;
bench("git.status(fresh)", N_GIT, (i) => {
  writeFileSync(join(REPO, `scratch-${i}.txt`), `dirty ${i}\n`);
  const st = gitStatus(REPO, futureNow());
  if (!st) throw Error("no status");
});

// 6) Paired pragma control on throwaway files: identical commit loop, FULL vs NORMAL.
//    Directly quantifies what the catalog's missing synchronous=NORMAL costs per commit.
console.log("[r8-bench] starting pragma control");
const pragmaControl = (path, synchronous) => {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${synchronous};
    CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
  const ins = db.prepare("INSERT OR REPLACE INTO requests(key,route,status,body,createdAt) VALUES(?,?,?,?,?)");
  const samples = [];
  for (let i = 0; i < N_CATALOG_COMMITS; i += 1) {
    const s = performance.now();
    db.exec("BEGIN");
    ins.run(`ctl-${synchronous}-${i}`, "POST /v1/sessions", 201, '"ctl"', Date.now());
    db.exec("COMMIT");
    samples.push(performance.now() - s);
  }
  db.close();
  return samples;
};
const full = pragmaControl(join(HOME, "ctl-full.sqlite"), "FULL");
const normal = pragmaControl(join(HOME, "ctl-normal.sqlite"), "NORMAL");
for (const [name, samples] of [
  ["control.commit(sync=FULL)", full],
  ["control.commit(sync=NORMAL)", normal],
]) {
  results.push({
    op: name,
    count: samples.length,
    totalMs: r(samples.reduce((a, b) => a + b, 0)),
    meanMs: r(mean(samples)),
    p50: r(pct(samples, 50)),
    p95: r(pct(samples, 95)),
    max: r(Math.max(...samples)),
    over20ms: samples.filter((x) => x > 20).length,
  });
}

await store.close().catch(() => {});

// ---------------------------------------------------------------- report
const pad = (v, n) => String(v).padStart(n);
console.log(`\n[r8-bench] label=${LABEL} totalMs=${r(performance.now() - started)} load1m(end)=${loadavg()[0].toFixed(2)}`);
console.log(
  `${pad("op", 26)} ${pad("count", 7)} ${pad("totalMs", 9)} ${pad("meanMs", 9)} ${pad("p50", 9)} ${pad("p95", 9)} ${pad("max", 9)} ${pad(">20ms", 7)}`,
);
for (const row of results)
  console.log(
    `${pad(row.op, 26)} ${pad(row.count, 7)} ${pad(row.totalMs, 9)} ${pad(row.meanMs, 9)} ${pad(row.p50, 9)} ${pad(row.p95, 9)} ${pad(row.max, 9)} ${pad(row.over20ms, 7)}`,
  );
writeFileSync(join(HOME, `bench-${LABEL}.json`), JSON.stringify({ label: LABEL, home: HOME, results }, null, 2));
console.log(`[r8-bench] json → ${join(HOME, `bench-${LABEL}.json`)}`);
// The Store's watchers (awake/git/telegram timers) keep the event loop alive after
// close(); the measurements are done — exit explicitly.
process.exit(0);
