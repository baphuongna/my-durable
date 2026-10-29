// R19 fix wave (run-5 leader-confirmed findings): regression pins.
// h1-a salvage attempt-once · h1-b per-session hit cap · h3 telegram lock+persist
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile, open, mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

const firstDb = async (root: string): Promise<string> => {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "agent.sqlite") out.push(p);
    }
  };
  walk(root, 0);
  return out.sort().at(-1)!;
};

test("R19 h1-a: a failed salvage runs at most ONCE — later scope=all searches skip the session", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "r19a" });
  try {
    const client = new DpiClient(server.base, token);
    const sid = (await client.createSession({ name: "Victim", cwd: t.work, model: faux }, "create-v")).id;
    const main = client.agent("Victim", "main");
    await main.send("hello needle", "followUp", "req-1");
    await new Promise((r) => setTimeout(r, 2000));
    await server.stop(); // release the catalog lock + the storage handle
    const db = await firstDb(join(t.root, "home"));
    // Close this session's storage, corrupt the file, and force a FAILED salvage:
    // a big body pushes integrity_check past the 5 s ceiling (leader-probe path).
    // The daemon holds the storage handle, so the corrupt file is only read on the
    // NEXT open (a fresh server instance below) — exactly the salvage path.
    const buf = await readFile(db);
    buf.write("This is not SQLite", 0);
    const fh = await open(db, "w");
    await fh.writeFile(buf);
    await fh.writeFile(Buffer.alloc(200 * 1024 * 1024, 7));
    await fh.close();
    // First query on a fresh store instance: salvage fails, the note is set.
    const server2 = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "r19a" }).catch(
      (e) => {
        throw new Error(`boot after corruption failed: ${e?.message}`);
      },
    );
    const client2 = new DpiClient(server2.base, token);
    const first = await client2.searchSessions("needle", "all");
    assert.equal(first.matches.length, 0, "the corrupt session yields nothing");
    const t0 = performance.now();
    const second = await client2.searchSessions("needle", "all");
    const third = await client2.searchSessions("needle", "all");
    const elapsed = performance.now() - t0;
    assert.equal(second.matches.length, 0);
    assert.equal(third.matches.length, 0);
    assert.ok(elapsed < 5_000, `later searches must skip salvage, took ${Math.round(elapsed)}ms for two`);
    // R20 h6 variant A: the memo must hold on the OPEN path too — an
    // agent-touching request re-ran the FULL salvage (leader probe: 5.0 s
    // per request). It must now fail fast from the recorded fault.
    const ta = performance.now();
    await assert.rejects(
      () => client2.agent("Victim", "main").send("again", "followUp", "req-2"),
      /unavailable|Unreadable/i,
    );
    const agentMs = performance.now() - ta;
    assert.ok(agentMs < 1_000, `agent request must fail fast from the memo, took ${Math.round(agentMs)}ms`);
    // R20 h6 variant B: a REFUSED restore (live session exists) must NOT wipe
    // the memo — the next scope=all search still skips the salvage.
    const refused = await fetch(`${server2.base}/v1/archive/${sid}/restore`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(refused.status, 400, "live session refuses the restore");
    const tb = performance.now();
    const afterRefused = await client2.searchSessions("needle", "all");
    assert.equal(afterRefused.matches.length, 0);
    assert.ok(performance.now() - tb < 1_000, `search after refused restore must still skip salvage, took ${Math.round(performance.now() - tb)}ms`);
    await server2.stop();
  } finally {
    await t.cleanup();
  }
});

test("R19 h1-b: transcript hits are capped at 12 per session even across forks", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "r19b" });
  try {
    const client = new DpiClient(server.base, token);
    const sid = (await client.createSession({ name: "Forky", cwd: t.work, model: faux }, "create-f")).id;
    const main = client.agent("Forky", "main");
    const q0 = await main.send("please remember rambutan-main", "followUp", "req-main");
    await until(async () => (await client.session(sid).submission(q0.submissionId, 5000)).status === "done", 20000, "main");
    // 5 forks × 1 needle turn each: pre-fix each conversation adds its 3 hits (uncapped 3×K).
    const page = await main.entries({ scope: "all", limit: 50 });
    const entryId = (page.items.find((e) => e.kind === "pi.assistant") ?? page.items.at(-1))!.id;
    let forkName = "rambutan-fork-0";
    let parent = main;
    for (let i = 0; i < 5; i++) {
      const fork = (await parent.fork({ entryId, name: `rambutan-fork-${i}` })) as unknown as { agent?: { name?: string }; name?: string };
      forkName = fork?.agent?.name ?? fork?.name ?? `rambutan-fork-${i}`;
      const fa = client.agent("Forky", forkName);
      const q = await fa.send(`rambutan in fork ${i}`, "followUp", `req-fork-${i}`);
      await until(async () => (await client.session(sid).submission(q.submissionId, 5000)).status === "done", 20000, `fork ${i}`);
      parent = fa;
    }
    const all = await client.searchSessions("rambutan", "all");
    const m = all.matches.find((x) => x.name === "Forky")!;
    assert.ok(m.hits!.length > 3, "hits still accumulate across conversations");
    assert.ok(m.hits!.length <= 12, `per-session cap: got ${m.hits!.length}`);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
