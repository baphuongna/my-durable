/**
 * run-11 h2-4 (missing-dir memo TTL): the run-9 G zombie-row memo was a
 * Set<string> with no expiry — an operator who manually copies a session dir
 * back (the crash-window recovery) has NO API touch to clear it, so scope=all
 * search hid the session for the whole process lifetime. The memo now carries
 * a memoize-at timestamp and expires 5 min after memoization: lazy expiry on
 * the read (searchSessionsAll), re-memoization with a fresh stamp when the
 * re-probe still ENOENTs, and the existing lifecycle deletes (successful
 * open, archive, restore) unchanged.
 *
 * Shape: the sessions are created through the real daemon (bootServer — the
 * transcript needs the full faux submission machinery), but the TTL
 * assertions run against an IN-PROCESS Store.open of the same dataDir: the
 * injected clock (setMissingDirClockForTests) must share the process with the
 * memo for a deterministic 5-min walk — no sleeping, no fake timers over the
 * server's own machinery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { cp, rm } from "node:fs/promises";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { Store } from "../src/store.js";
import { setMissingDirClockForTests } from "../src/store.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

/** DPI_HOME layout: dataDir = <home>/backend, sessions at <home>/backend/sessions. */
const sessionsDirOf = (home: string) => join(home, "backend", "sessions");

/** Wait for a faux submission to finish (r9 transcript-memo style). */
async function settle(client: DpiClient, sid: string, submissionId: number, label: string): Promise<void> {
  await until(async () => (await client.session(sid).submission(submissionId, 5000)).status === "done", 20000, label);
}

test("run-11 h2-4: the missing-dir memo expires after 5 min — a still-missing dir re-memos, a restored dir is searchable again", async () => {
  const t = await tempStore();
  const token = newToken();
  const home = join(t.root, "home");
  const server = await bootServer({ home, startDirs: t.work, token, name: "r11ttl1" });
  let phoenix = "";
  try {
    const client = new DpiClient(server.base, token);
    const keep = (await client.createSession({ name: "Keep", cwd: t.work, model: faux }, "create-keep")).id;
    await settle(
      client,
      keep,
      (await client.agent("Keep", "main").send("please remember jackfruit", "followUp", "req-keep")).submissionId,
      "keep",
    );
    phoenix = (await client.createSession({ name: "Phoenix", cwd: t.work, model: faux }, "create-phx")).id;
    await settle(
      client,
      phoenix,
      (await client.agent("Phoenix", "main").send("phoenix needle tamarind", "followUp", "req-phx")).submissionId,
      "phoenix",
    );
  } finally {
    await server.stop();
  }

  // Crash-window shape: the dir vanishes with no archive bundle, so the row
  // survives as a bounded fault. Keep a byte copy for the manual restore.
  const src = join(sessionsDirOf(home), phoenix);
  const backup = join(t.root, "phoenix-backup");
  await cp(src, backup, { recursive: true });
  await rm(src, { recursive: true, force: true });

  // Same dataDir, IN THIS PROCESS — the injected clock and the memo must
  // share it. The boot open loop (or the warm search below, whichever arms
  // the memo first) records a real-clock stamp.
  const store = await Store.open({ dataDir: join(home, "backend"), startDirs: [t.work], name: "r11ttl1", provider: "faux" });
  try {
    // Warm: guarantees the memo is armed no matter how the boot loop timed.
    const warm = await store.searchSessionsAll("tamarind");
    assert.ok(warm.scanned && warm.scanned.sessions >= 1, "the search ran");
    const memoAt = Date.now(); // every memo stamp so far is <= this

    // 4 min later (< the 5-min TTL): the memo is still fresh — skipped, and
    // the zombie burns none of the scan budget (the r9 behavior, intact).
    setMissingDirClockForTests(() => memoAt + 4 * 60_000);
    const skipped = await store.searchSessionsAll("tamarind");
    assert.equal(skipped.scanned!.sessions, 1, "memo fresh: only Keep is scanned");
    assert.equal(skipped.matches.length, 0, "the zombie yields nothing");

    // 6 min after memoization: expired — the row re-enters search, the
    // re-probe ENOENTs (the dir is STILL gone) and re-memos with a fresh
    // stamp at the injected now.
    setMissingDirClockForTests(() => memoAt + 6 * 60_000);
    const expired = await store.searchSessionsAll("tamarind");
    assert.equal(expired.scanned!.sessions, 2, "expired memo: the zombie row is probed again (and burns its slot)");
    assert.equal(expired.matches.length, 0, "a still-missing dir still yields nothing");
    const reMemoed = await store.searchSessionsAll("tamarind"); // same injected now → the fresh memo skips again
    assert.equal(reMemoed.scanned!.sessions, 1, "the failed re-probe re-memoized for another TTL window");

    // Manual restore, no API touch: copy-back + a second TTL expiry makes the
    // session searchable again — search's own open (and the successful-open
    // delete) does the rest, exactly the run-11 h2-4 net effect.
    await cp(backup, src, { recursive: true });
    setMissingDirClockForTests(() => memoAt + 12 * 60_000);
    const back = await store.searchSessionsAll("tamarind");
    assert.equal(back.scanned!.sessions, 2, "the restored row is scanned again");
    const m = back.matches.find((x) => x.name === "Phoenix");
    assert.ok(m?.hits?.length, "the restored session is searchable again after the TTL");
    assert.match(m!.hits!.map((h) => h.text).join(" "), /tamarind/, "the hit text carries the needle");
  } finally {
    setMissingDirClockForTests(); // real clock before anything else in this process
    await store.close().catch(() => {});
    await t.cleanup();
  }
});
