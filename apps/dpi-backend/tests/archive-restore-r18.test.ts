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
