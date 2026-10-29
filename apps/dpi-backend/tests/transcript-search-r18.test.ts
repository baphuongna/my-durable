// R18 transcript search (scope=all): the device answers "which session did the
// agent say X in?" — metadata search stays untouched (default scope), the new
// scope walks stored history with budgets and never fails on one bad session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("sessions/search: scope=all finds transcript text, default scope stays metadata-only", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "find-box" });
  try {
    const client = new DpiClient(server.base, token);
    // Two sessions; only Alpha ever mentions the needle. Twin proves the scan
    // walks every session and reports only real hits.
    const alpha = await client.createSession({ name: "Alpha", cwd: t.work, model: faux }, "create-a");
    await client.createSession({ name: "Twin", cwd: t.work, model: faux }, "create-b");
    const main = client.agent("Alpha", "main");
    const queued = await main.send("find the zenobia-needle please", "followUp", "req-1");
    await until(async () => (await client.session(alpha.id).submission(queued.submissionId, 5000)).status === "done", 20000, "faux turn");

    // Default scope: metadata only — the needle is in no name/cwd/model.
    const meta = await client.searchSessions("zenobia");
    assert.equal(meta.matches.length, 0);
    assert.equal(meta.scanned, undefined);

    // scope=all: the transcript hit surfaces with agent, entry and snippet.
    const all = await client.searchSessions("zenobia", "all");
    assert.equal(all.matches.length, 1);
    const match = all.matches[0];
    assert.equal(match.id, alpha.id);
    assert.ok(match.where.includes("transcript"));
    assert.ok((match.hits ?? []).length >= 1);
    const hit = match.hits![0];
    assert.equal(hit.agent, "Main");
    assert.ok(hit.entry >= 1);
    assert.ok(hit.text.toLowerCase().includes("zenobia"), `snippet should carry the needle: ${hit.text}`);

    // Case-insensitive, multi-word AND semantics (same as search_history).
    const upper = await client.searchSessions("ZENOBIA needle", "all");
    assert.equal(upper.matches.length, 1);
    const absent = await client.searchSessions("zenobia absentword", "all");
    assert.equal(absent.matches.length, 0);

    // The scan report is honest: both sessions, some entries, not truncated.
    assert.equal(all.scanned?.sessions, 2);
    assert.ok((all.scanned?.entries ?? 0) >= 2);
    assert.equal(all.scanned?.truncated, false);

    // A metadata hit still works under scope=all and merges with transcript flags.
    const byName = await client.searchSessions("twin", "all");
    assert.equal(byName.matches.length, 1);
    assert.ok(byName.matches[0].where.includes("name"));
    assert.equal(byName.matches[0].hits?.length, 0);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
