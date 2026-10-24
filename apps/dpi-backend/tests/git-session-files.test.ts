import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

test("session git-files/turns: write tool calls become the session changelist, grouped per turn", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "gitfiles-box" });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "turns", cwd: t.work, model: faux });
    const main = client.agent(s.id, 1);
    const r1 = await main.send("write:hello.txt|hi", "followUp", "w1", 20000);
    assert.equal(r1.status, "done", `first write: ${JSON.stringify(r1).slice(0, 120)}`);
    await main.send("write:sub/bye.txt|bye there", "followUp", "w2", 20000);

    const files = (await client.sessionGitFiles(s.id)).files;
    assert.ok(files.some((f) => f.endsWith("hello.txt")), `files: ${JSON.stringify(files)}`);
    assert.ok(files.some((f) => f.endsWith("sub/bye.txt")), "second file missing");

    const turns = (await client.sessionGitTurns(s.id)).turns;
    assert.equal(turns.length, 2, `turns: ${JSON.stringify(turns)}`);
    assert.ok(turns[0]!.files.some((f) => f.path.endsWith("hello.txt")), "turn 1 files");
    assert.ok(turns[1]!.files.some((f) => f.path.endsWith("sub/bye.txt")), `turn 2 files — turns: ${JSON.stringify(turns)}`);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
