import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRegistry, toPublic } from "../src/node/registry.js";

const token = "dpi_" + "x".repeat(40);

test("registry CRUD, validation, token privacy, uid learning and UI state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-reg-"));
  const reg = new NetworkRegistry(join(dir, "network.sqlite"));
  try {
    assert.equal((await stat(join(dir, "network.sqlite"))).mode & 0o777, 0o600);
    assert.throws(() => reg.upsert({ id: "Bad Id", url: "http://x" }), /Device id/);
    assert.throws(() => reg.upsert({ id: "a", url: "ftp://x" }), /http or https/);
    assert.throws(() => reg.upsert({ id: "a", url: "http://x", token: "short" }), /32 characters/);
    const row = reg.upsert({ id: "box", name: "Box", kind: "ssh", url: "http://box.local:4780/", token, source: "config" });
    assert.equal(row.url, "http://box.local:4780");
    assert.equal(row.token, token);
    // undefined token keeps it, a config device refuses UI edits
    reg.upsert({ id: "box", name: "Box 2", kind: "ssh", url: "http://box.local:4780", source: "config" });
    assert.equal(reg.get("box")!.token, token);
    assert.throws(() => reg.upsert({ id: "box", url: "http://elsewhere", source: "ui" }), /dpi-network.yaml/);
    const pub = toPublic(reg.get("box")!);
    assert.equal(pub.hasToken, true);
    assert.equal("token" in pub, false);
    assert.equal(JSON.stringify(pub).includes(token), false);
    reg.learnUid("box", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    reg.learnUid("box", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f1");
    assert.equal(reg.get("box")!.deviceUid, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    // changing the URL forgets identity and caches
    reg.recordStatus("box", { status: "online", tree: { uid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", name: "box", sessions: [], at: 1 }, seenAt: 5 });
    reg.upsert({ id: "box", kind: "ssh", url: "http://box2.local:4780", source: "config" });
    assert.equal(reg.get("box")!.deviceUid, null);
    assert.equal(reg.get("box")!.lastTree, null);
    reg.upsert({ id: "ad-hoc", url: "https://example.test", token, source: "ui" });
    reg.pruneConfig([]);
    assert.deepEqual(reg.list().map((d) => d.id), ["ad-hoc"]);
    reg.uiSet("tree.expanded", ["a", "b"]);
    assert.deepEqual(reg.uiGet("tree.expanded"), ["a", "b"]);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run-7 B4: persisted device JSON is capped (hostile trees cannot rewrite megabytes every 10s)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-reg-cap-"));
  const reg = new NetworkRegistry(join(dir, "network.sqlite"));
  try {
    reg.upsert({ id: "box", kind: "ssh", url: "http://box.local:4780", token, source: "config" });
    const big: unknown[] = Array.from({ length: 4000 }, (_, i) => ({ id: "s" + i, name: "n".repeat(60) }));
    reg.recordStatus("box", { status: "online", tree: { uid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", name: "box", sessions: big as never, at: 2 } });
    const persisted = (reg as unknown as { get: (id: string) => { lastTree?: unknown } }).get("box");
    const len = JSON.stringify(persisted?.lastTree ?? {}).length;
    assert.ok(len <= 288 * 1024 + 64, `persisted tree capped, got ${len}`);
    reg.recordStatus("box", { status: "online", info: { big: "x".repeat(300_000) } as never });
    const infoLen = JSON.stringify((reg as unknown as { get: (id: string) => { lastInfo?: unknown } }).get("box")?.lastInfo ?? {}).length;
    assert.ok(infoLen <= 64 * 1024 + 64, `persisted info capped, got ${infoLen}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
