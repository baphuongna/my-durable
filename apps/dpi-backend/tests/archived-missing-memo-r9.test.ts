// run-9 G (run-8 u1 hardening): zombie rows must not burn the search budget.
// A zombie = a catalog row that is alive while its sessions/<id> dir is gone
// and NO archive bundle exists — the run-8 u1 crash-window leftover that
// reconcileArchiveWindows deliberately keeps as a bounded-fault row. scope=all
// search used to pay for every zombie on EVERY query: one harness-throw +
// reopenOnce stat attempt AND one of the 100 TRANSCRIPT_SESSION_LIMIT slots
// (list() is createdAt DESC, so NEWEST zombies starve the oldest live sessions
// first). The memo mirrors salvageFailedSessions: the row is probed once (boot
// open loop / first failed open), skipped slot-free afterwards, and cleared
// when the dir comes back (a successful open — manual copy-back or restore).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { cp, rm } from "node:fs/promises";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

/** DPI_HOME layout: dataDir = <home>/backend, sessions at <home>/backend/sessions. */
const sessionsDirOf = (home: string) => join(home, "backend", "sessions");

/** Wait for a faux submission to finish (r19 transcript-search style). */
async function settle(client: DpiClient, sid: string, submissionId: number, label: string): Promise<void> {
  await until(async () => (await client.session(sid).submission(submissionId, 5000)).status === "done", 20000, label);
}

test("run-9 G (a)+(b): zombie rows are probed once, then skipped without burning budget slots", async () => {
  const t = await tempStore();
  const token = newToken();
  const home = join(t.root, "home");
  const server = await bootServer({ home, startDirs: t.work, token, name: "r9g1" });
  try {
    const client = new DpiClient(server.base, token);
    const keep = (await client.createSession({ name: "Keep", cwd: t.work, model: faux }, "create-keep")).id;
    await settle(
      client,
      keep,
      (await client.agent("Keep", "main").send("please remember mangosteen", "followUp", "req-keep")).submissionId,
      "keep",
    );
    // Three NEWER ghost sessions: createdAt DESC puts them in FRONT of Keep in
    // the scan order, so pre-fix they eat budget slots before Keep is reached.
    const ghosts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sid = (await client.createSession({ name: `Ghost${i}`, cwd: t.work, model: faux }, `create-g${i}`)).id;
      await settle(
        client,
        sid,
        (await client.agent(`Ghost${i}`, "main").send(`ghost ${i} talks about nothing`, "followUp", `req-g${i}`))
          .submissionId,
        `ghost${i}`,
      );
      ghosts.push(sid);
    }
    await server.stop();

    // Crash-window shape: the ghost dirs vanish with no archive bundle, so
    // reconcile KEEPS the rows (bounded faults) — exactly the zombie class.
    for (const sid of ghosts) await rm(join(sessionsDirOf(home), sid), { recursive: true, force: true });

    const server2 = await bootServer({ home, startDirs: t.work, token, name: "r9g1" });
    const client2 = new DpiClient(server2.base, token);
    try {
      // (a) probe evidence: ONE boot open left a bounded fault per zombie —
      // the row is still listed, never thrown away, never re-probed.
      const listed = await client2.sessions();
      for (const sid of ghosts) {
        const s = listed.find((x) => x.id === sid);
        assert.ok(s, `zombie row ${sid} survives the reboot`);
        assert.match(String(s.error ?? ""), /ENOENT|missing/i, "the single boot probe left a bounded fault");
      }
      // (a)+(b): the ghosts cost ZERO scan slots — the whole budget goes to
      // the one present session. Pre-fix this count was 4 (three zombies
      // re-probed via harness-throw + reopenOnce stat, then Keep) per query.
      for (let i = 0; i < 3; i++) {
        const r = await client2.searchSessions("mangosteen", "all");
        assert.equal(r.scanned!.sessions, 1, `query ${i}: zombie rows must not burn TRANSCRIPT_SESSION_LIMIT slots`);
        const m = r.matches.find((x) => x.name === "Keep");
        assert.ok(m, "the present session matches");
        assert.ok(m!.hits?.length, "the present session's transcript is found");
        assert.ok(m!.where.includes("transcript"), "the hit is a transcript hit");
      }
    } finally {
      await server2.stop();
    }
  } finally {
    await t.cleanup();
  }
});

test("run-9 G (c): the memo clears when the dir comes back (copy-back and restore)", async () => {
  const t = await tempStore();
  const token = newToken();
  const home = join(t.root, "home");
  const server = await bootServer({ home, startDirs: t.work, token, name: "r9g2" });
  try {
    const client = new DpiClient(server.base, token);
    const phoenix = (await client.createSession({ name: "Phoenix", cwd: t.work, model: faux }, "create-phx")).id;
    await settle(
      client,
      phoenix,
      (await client.agent("Phoenix", "main").send("phoenix needle durian", "followUp", "req-phx")).submissionId,
      "phoenix",
    );
    const boomerang = (await client.createSession({ name: "Boomerang", cwd: t.work, model: faux }, "create-boom")).id;
    await settle(
      client,
      boomerang,
      (await client.agent("Boomerang", "main").send("boomerang needle lychee", "followUp", "req-boom")).submissionId,
      "boomerang",
    );
    await server.stop();

    // Crash-window: Phoenix's dir vanishes; keep a byte copy of its REAL db
    // (a genuine device-written agent.sqlite, no synthesized schema).
    const src = join(sessionsDirOf(home), phoenix);
    const backup = join(t.root, "phoenix-backup");
    await cp(src, backup, { recursive: true });
    await rm(src, { recursive: true, force: true });

    const server2 = await bootServer({ home, startDirs: t.work, token, name: "r9g2" });
    const client2 = new DpiClient(server2.base, token);
    try {
      // Zombie alone: memoized-skipped, zero slots — Boomerang is the only
      // scannable row. Pre-fix this count was 2 (the zombie re-probed first).
      const z = await client2.searchSessions("durian", "all");
      assert.equal(z.scanned!.sessions, 1, "only the present session is scanned");
      assert.equal(z.matches.length, 0, "the zombie yields nothing");

      // The dir comes back (run-8 u1 variant-B shape). Like the salvage memo
      // (R20 h6), the memo does NOT self-invalidate on a scan — it clears when
      // a real open succeeds, so a copy-back with no intervening touch still
      // skips (pinned here), and the FIRST API touch that opens the session
      // (git-files is a read-only openAgent path) un-memos it.
      await cp(backup, src, { recursive: true });
      const stillSkipped = await client2.searchSessions("durian", "all");
      assert.equal(stillSkipped.scanned!.sessions, 1, "no open yet — the memo still skips (salvage-memo semantics)");
      const touch = await fetch(`${server2.base}/v1/sessions/${phoenix}/git-files`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(touch.status, 200, await touch.text());
      const back = await client2.searchSessions("durian", "all");
      assert.equal(back.scanned!.sessions, 2, "the returned dir is scanned again after its first open");
      const m = back.matches.find((x) => x.name === "Phoenix");
      assert.ok(m?.hits?.length, "the returned session is searchable again");
      assert.match(m!.hits!.map((h) => h.text).join(" "), /durian/, "the hit text carries the needle");

      // Lifecycle mirror (the salvageFailedSessions semantics): archive
      // Boomerang, restore it — the restored session is searchable again.
      const del = await fetch(`${server2.base}/v1/sessions/${boomerang}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.ok(del.status === 200 || del.status === 201, `archive delete: ${del.status} ${await del.text()}`);
      const mid = await client2.searchSessions("lychee", "all");
      assert.equal(mid.matches.length, 0, "the archived session left the catalog");
      const restore = await fetch(`${server2.base}/v1/archive/${boomerang}/restore`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.ok(restore.status === 200 || restore.status === 201, `restore: ${restore.status} ${await restore.text()}`);
      const after = await client2.searchSessions("lychee", "all");
      const b = after.matches.find((x) => x.name === "Boomerang");
      assert.ok(b?.hits?.length, "the restored session is searchable again");
      assert.equal(after.scanned!.sessions, 2, "both live rows are scanned after the restore");
    } finally {
      await server2.stop();
    }
  } finally {
    await t.cleanup();
  }
});
