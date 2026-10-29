// R18 (run-4 h1): restore is a session-placement writer — it must enforce the
// same start-dir choke point as create. The leader probe confirmed a planted
// archive manifest (same-user writable, reachable by any session agent with
// bash) restored a session rooted OUTSIDE the start dirs, re-anchoring its
// tool environment (and giving read-only sessions out-of-sandbox reads).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";

test("restore refuses a manifest cwd outside the start dirs (create-parity choke point)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpi-restore-r18-"));
  try {
    const work = join(root, "work");
    const outside = join(root, "outside-vault");
    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const dataDir = join(root, "data");

    const plant = (cwd: string): string => {
      const sessionId = randomUUID();
      const dir = join(dataDir, "archive", `${sessionId}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "session.json"),
        JSON.stringify({
          sessionId,
          name: "planted",
          cwd,
          model: "m",
          provider: "faux",
          createdAt: Date.now(),
          archivedAt: Date.now(),
          packageVersion: "0",
        }),
      );
      return sessionId;
    };

    const store = await Store.open({ dataDir, startDirs: [work], name: "restore-box", provider: "faux" } as never);
    const outsideId = plant(outside);

    // The choke point: a planted outside cwd is refused, and the refusal
    // happens BEFORE the bundle moves (the archive stays restorable).
    await assert.rejects(
      () => (store as unknown as { restoreArchivedSession(id: string): Promise<unknown> }).restoreArchivedSession(outsideId),
      (e: { code?: string }) => e.code === "invalid",
    );

    // Control: a bundle whose cwd IS a start-dir folder restores fine.
    const insideId = plant(join(work, "project"));
    mkdirSync(join(work, "project"), { recursive: true });
    const restored = (await (store as unknown as { restoreArchivedSession(id: string): Promise<{ cwd: string }> })
      .restoreArchivedSession(insideId)) as { cwd: string };
    assert.ok(restored.cwd.startsWith(work), `restored cwd must live under the start dir: ${restored.cwd}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R20 h6: an oversized planted archive manifest is refused without reading it", async () => {
  const { bootServer, newToken, tempStore } = await import("./helpers.js");
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "r20m" });
  try {
    // Plant a >1 MiB valid-shape manifest with an in-model cwd: pre-fix the
    // restore READ + PARSED the whole file before the cwd refusal (leader
    // probe: 150 MB plant = ~770 ms and ~600 MB RSS per request, repeatable,
    // and the archive LISTING paid the same per bundle).
    const sid = "deadbeef-0000-4000-8000-000000000001";
    const bundle = join(t.root, "home", "backend", "archive", `${sid}-1700000000000`);
    mkdirSync(bundle, { recursive: true });
    const manifest = {
      sessionId: sid, name: "Plant", cwd: t.work, model: "m", provider: "p",
      createdAt: 1700000000000, archivedAt: 1700000000000, pad: "x".repeat(2 * 1024 * 1024),
    };
    writeFileSync(join(bundle, "session.json"), JSON.stringify(manifest));
    for (let i = 1; i <= 2; i++) {
      const t0 = performance.now();
      const resp = await fetch(`${server.base}/v1/archive/${sid}/restore`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      });
      const ms = performance.now() - t0;
      assert.ok(resp.status === 400 || resp.status === 404, `refused without reading (${resp.status} — absent manifest degrades to the empty-cwd refusal)`);
      assert.ok(ms < 500, `oversized manifest must not be read, took ${Math.round(ms)}ms`);
    }
    const t1 = performance.now();
    const list = await (await fetch(`${server.base}/v1/archive`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.ok(performance.now() - t1 < 500, "listing must skip the oversized manifest too");
    assert.ok(list.sessions.length >= 1, "the bundle still lists (degraded row)");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
