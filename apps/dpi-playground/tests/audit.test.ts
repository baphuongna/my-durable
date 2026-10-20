/**
 * P2-07 audit: append-only rows, same-transaction commits (fail closed),
 * 4096-byte cap (bytes, not chars), full secret scrubbing incl. substrings,
 * bounded denial aggregation, storage perms.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { AUDIT_ACTIONS, Audit, scrubSecrets } from "../apps/dpi-playground-hub/src/audit.js";

async function tempAudit(hooks?: { failAppend?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-audit-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  return {
    dir,
    registry,
    audit: new Audit(registry, hooks ?? {}),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const rows = (registry: NetworkRegistry) =>
  registry.db.prepare("SELECT * FROM events ORDER BY id").all() as Record<string, unknown>[];

test("append: all 12 required actions round-trip with correlation fields", async () => {
  const { registry, audit, cleanup } = await tempAudit();
  try {
    for (const action of AUDIT_ACTIONS) {
      audit.append({ actor: "admin", action, outcome: action === "auth.denied" ? "denied" : "ok", requestId: "req-1", connectionId: "conn-1", detail: { x: 1 } });
    }
    assert.equal(AUDIT_ACTIONS.length, 12);
    const all = rows(registry);
    assert.equal(all.length, 12);
    assert.equal(all[0].action, "pair.code_created");
    assert.equal(all[11].action, "rate_limited");
    assert.equal(all[0].request_id, "req-1");
    // append-only: UPDATE/DELETE raise (S-6)
    assert.throws(() => registry.db.prepare("UPDATE events SET actor='x' WHERE id=1").run());
    assert.throws(() => registry.db.prepare("DELETE FROM events WHERE id=1").run());
  } finally {
    await cleanup();
  }
});

test("same transaction: mutation + audit commit together, rollback together (fail closed)", async () => {
  const { registry, audit, cleanup } = await tempAudit();
  try {
    registry.upsert({ id: "dev-a", url: "http://10.0.0.5:7900" });
    // happy path: credential row + audit row commit together
    audit.withTransaction(() => {
      registry.db
        .prepare("INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c1','dev-a','e',1,?,'current',1)")
        .run("a".repeat(64));
      audit.append({ actor: "hub", action: "token.rotate_started", outcome: "ok", detail: { credentialId: "c1" } });
    });
    assert.ok(registry.db.prepare("SELECT 1 FROM tunnel_credentials WHERE credential_id='c1'").get());
    assert.equal(rows(registry).length, 1);

    // business failure after audit append → both roll back
    assert.throws(() =>
      audit.withTransaction(() => {
        registry.db
          .prepare("INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c2','dev-a','e',2,?,'current',1)")
          .run("b".repeat(64));
        audit.append({ actor: "hub", action: "token.rotate_started", outcome: "ok", detail: { credentialId: "c2" } });
        throw new Error("mutation failed");
      }),
    );
    const n2 = (registry.db.prepare("SELECT count(*) AS n FROM tunnel_credentials WHERE credential_id='c2'").get() as { n: number }).n;
    assert.equal(n2, 0);
    assert.equal(rows(registry).length, 1); // no orphan audit row
  } finally {
    await cleanup();
  }
});

test("audit-write failure fails the mutation closed", async () => {
  const { dir, registry, cleanup } = await tempAudit();
  const failing = new Audit(registry, { failAppend: true });
  try {
    registry.upsert({ id: "dev-a", url: "http://10.0.0.5:7900" });
    assert.throws(() =>
      failing.withTransaction(() => {
        registry.db
          .prepare("INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c9','dev-a','e',1,?,'current',1)")
          .run("c".repeat(64));
        failing.append({ actor: "hub", action: "pair.success", outcome: "ok" });
      }),
    );
    const n = (registry.db.prepare("SELECT count(*) AS n FROM tunnel_credentials").get() as { n: number }).n;
    assert.equal(n, 0); // mutation did NOT commit
  } finally {
    await cleanup();
    void dir;
  }
});

test("detail byte-cap: 4096 UTF-8 bytes, not characters (multibyte rejected)", async () => {
  const { registry, audit, cleanup } = await tempAudit();
  try {
    // 4000 'é' chars = 8000 bytes → must throw (S-12)
    assert.throws(() => audit.append({ actor: "a", action: "pair.approved", outcome: "ok", detail: { blob: "é".repeat(4000) } }), /bytes/);
    // exactly-at-cap ASCII passes
    const fill = "x".repeat(4096 - JSON.stringify({ blob: "" }).length - 2);
    audit.append({ actor: "a", action: "pair.approved", outcome: "ok", detail: { blob: fill } });
    const row = rows(registry)[0];
    assert.ok(Buffer.byteLength(row.detail_json as string, "utf8") <= 4096);
  } finally {
    await cleanup();
  }
});

test("scrub: tokens, codes, keys, Authorization, pair-URL — including substrings", async () => {
  const { registry, audit, cleanup } = await tempAudit();
  try {
    const dpt = `dpt_${"A".repeat(43)}`;
    const dpi = `dpi_${"B".repeat(43)}`;
    audit.append({
      actor: "attacker",
      action: "auth.denied",
      outcome: "denied",
      detail: {
        header: `Authorization: Bearer ${dpt}`,
        nested: { url: `https://hub/pair?code=AB2C7DEF&v=1`, tokenTry: dpi, pem: "-----BEGIN PRIVATE KEY-----\nzz\n-----END PRIVATE KEY-----" },
        free: `prefix ${dpt.slice(4)} mid ${"AB2C7DEF"} end`,
      },
    });
    const stored = JSON.stringify(rows(registry));
    assert.ok(!stored.includes("A".repeat(20)));
    assert.ok(!stored.includes("B".repeat(20)));
    assert.ok(!stored.includes("AB2C7DEF"));
    assert.ok(!stored.includes("BEGIN PRIVATE KEY"));
    assert.ok(stored.includes("<redacted>") || stored.includes("<code-redacted>"));
    // unit-level substring checks
    assert.ok(scrubSecrets(`x${dpt}y`).includes("dpt_<redacted>"));
    assert.ok(!scrubSecrets(`see ${dpi} later`).includes(dpi));
  } finally {
    await cleanup();
  }
});

test("denial aggregation: floods collapse to one row per window; buckets bounded", async () => {
  const { registry, audit, cleanup } = await tempAudit();
  try {
    for (let i = 0; i < 1000; i++) audit.denied("auth.denied", "10.9.9.9", { path: "/api/tunnel" });
    const all = rows(registry);
    assert.equal(all.length, 1); // one row per (action, ip, window)
    const detail = JSON.parse(all[0].detail_json as string);
    assert.equal(detail.aggregated, true);

    // different IPs/actions get their own bounded buckets
    for (let i = 0; i < 600; i++) audit.denied("rate_limited", `10.8.0.${i}`, {});
    const after = rows(registry).length;
    assert.ok(after <= 513, `bounded rows, got ${after}`);
  } finally {
    await cleanup();
  }
});

test("storage perms: registry file tightened to 0600 on audit init", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-perm-"));
  try {
    const path = join(dir, "network.sqlite");
    const registry = new NetworkRegistry(path);
    const { chmodSync, statSync } = await import("node:fs");
    chmodSync(path, 0o644); // simulate a bad restore
    new Audit(registry);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    registry.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
