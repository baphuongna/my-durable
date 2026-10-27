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
import { encodePairOffer, type PairOffer } from "../../dpi-sdk/src/protocol/pairing.js";
import { AUDIT_ACTIONS, Audit, scrubSecrets } from "../apps/dpi-playground-hub/src/audit.js";

async function tempAudit(hooks?: ConstructorParameters<typeof Audit>[1]) {
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

/** A structurally valid offer fixture (encode needs no freshness, so any exp works). */
const offerFixture = (): PairOffer => ({
  v: 2,
  hub: "https://pi.example.com",
  id: "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d",
  code: "a1b2c3d4-e5f6-4789-abcd-eff012345678",
  exp: 1760000240000,
});

test("append: all 18 required actions round-trip with correlation fields", async () => {
  const { registry, audit, cleanup } = await tempAudit();
  try {
    for (const action of AUDIT_ACTIONS) {
      audit.append({
        actor: "admin",
        action,
        outcome: action === "auth.denied" ? "denied" : "ok",
        requestId: "req-1",
        connectionId: "conn-1",
        detail: { x: 1 },
      });
    }
    assert.equal(AUDIT_ACTIONS.length, 18);
    const all = rows(registry);
    assert.equal(all.length, 18);
    assert.equal(all[0].action, "pair.code_created");
    assert.equal(all[13].action, "admin.login");
    assert.equal(all[14].action, "auth.denied");
    assert.equal(all[17].action, "rotation.stale_cleared");
    assert.equal(
      all[12].action,
      "hub.identity_created",
      "the v3 pinning audit action is part of the contract",
    );
    assert.ok(
      all.some((r) => r.action === "admin.token_created") &&
        all.some((r) => r.action === "admin.login"),
      "the admin auth actions are part of the contract",
    );
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
        .prepare(
          "INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c1','dev-a','e',1,?,'current',1)",
        )
        .run("a".repeat(64));
      audit.append({
        actor: "hub",
        action: "token.rotate_started",
        outcome: "ok",
        detail: { credentialId: "c1" },
      });
    });
    assert.ok(
      registry.db.prepare("SELECT 1 FROM tunnel_credentials WHERE credential_id='c1'").get(),
    );
    assert.equal(rows(registry).length, 1);

    // business failure after audit append → both roll back
    assert.throws(() =>
      audit.withTransaction(() => {
        registry.db
          .prepare(
            "INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c2','dev-a','e',2,?,'current',1)",
          )
          .run("b".repeat(64));
        audit.append({
          actor: "hub",
          action: "token.rotate_started",
          outcome: "ok",
          detail: { credentialId: "c2" },
        });
        throw new Error("mutation failed");
      }),
    );
    const n2 = (
      registry.db
        .prepare("SELECT count(*) AS n FROM tunnel_credentials WHERE credential_id='c2'")
        .get() as { n: number }
    ).n;
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
          .prepare(
            "INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c9','dev-a','e',1,?,'current',1)",
          )
          .run("c".repeat(64));
        failing.append({ actor: "hub", action: "pair.success", outcome: "ok" });
      }),
    );
    const n = (
      registry.db.prepare("SELECT count(*) AS n FROM tunnel_credentials").get() as { n: number }
    ).n;
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
    assert.throws(
      () =>
        audit.append({
          actor: "a",
          action: "pair.approved",
          outcome: "ok",
          detail: { blob: "é".repeat(4000) },
        }),
      /bytes/,
    );
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
        nested: {
          url: `https://hub/pair?code=AB2C7DEF&v=1`,
          tokenTry: dpi,
          pem: "-----BEGIN PRIVATE KEY-----\nzz\n-----END PRIVATE KEY-----",
        },
        free: `prefix ${dpt.slice(4)} mid ${"AB2C7DEF"} end`,
        free12: `prefix ${"ABCD2345EF67"} end`,
        url12: `https://hub/pair?code=ABCD2345EF67&v=1`,
        uuidCode: `{"code":"a1b2c3d4-e5f6-4789-abcd-eff012345678"}`,
        uuidUrl: `https://hub/pair?code=a1b2c3d4-e5f6-4789-abcd-eff012345678&v=1`,
        // v2 offer links: the secret IS the fragment payload — redact it wherever a URL shows up
        offerUrl: `https://hub/pair#offer=${encodePairOffer(offerFixture())}`,
        offerNested: { link: `https://hub/pair/#offer=${encodePairOffer(offerFixture())}` },
      },
    });
    const stored = JSON.stringify(rows(registry));
    assert.ok(!stored.includes("A".repeat(20)));
    assert.ok(!stored.includes("B".repeat(20)));
    assert.ok(!stored.includes("AB2C7DEF"));
    assert.ok(!stored.includes("ABCD2345EF67"));
    // a minted UUID v4 code is redacted too — but the row's own correlation ids stay readable
    assert.ok(!stored.includes("a1b2c3d4-e5f6-4789-abcd-eff012345678"));
    const rowIds = rows(registry)
      .map((r) => r.code_id)
      .filter((id): id is string => !!id);
    for (const id of rowIds)
      assert.ok(stored.includes(id), "audit correlation ids survive redaction");
    assert.ok(!stored.includes("BEGIN PRIVATE KEY"));
    assert.ok(stored.includes("<redacted>") || stored.includes("<code-redacted>"));
    // unit-level substring checks
    assert.ok(scrubSecrets(`x${dpt}y`).includes("dpt_<redacted>"));
    assert.ok(!scrubSecrets(`see ${dpi} later`).includes(dpi));
    // a 12-char minted code is redacted as one token, wherever it stands alone
    assert.ok(!scrubSecrets(`see ABCD2345EF67 later`).includes("ABCD2345EF67"));
    assert.ok(!scrubSecrets('{"code":"ABCD2345EF67"}').includes("ABCD2345EF67"));
    assert.ok(scrubSecrets('{"code":"ABCD2345EF67"}').includes("<code-redacted>"));
    assert.ok(
      !scrubSecrets('{"code":"a1b2c3d4-e5f6-4789-abcd-eff012345678"}').includes("a1b2c3d4"),
    );
    assert.ok(
      scrubSecrets('{"code":"a1b2c3d4-e5f6-4789-abcd-eff012345678"}').includes("<code-redacted>"),
    );
    assert.ok(!scrubSecrets("code=a1b2c3d4-e5f6-4789-abcd-eff012345678").includes("a1b2c3d4"));
    // an id that is NOT labelled a code is correlation, not a secret
    assert.ok(
      scrubSecrets('{"codeId":"a1b2c3d4-e5f6-4789-abcd-eff012345678"}').includes(
        "a1b2c3d4-e5f6-4789-abcd-eff012345678",
      ),
    );
    // a #offer= fragment is redacted in any URL-bearing field, standalone or nested
    const payload = encodePairOffer(offerFixture());
    assert.ok(!stored.includes(payload));
    assert.ok(scrubSecrets(`https://hub/pair#offer=${payload}`).includes("#offer=<redacted>"));
    assert.ok(scrubSecrets(`see #offer=${payload} there`).includes("#offer=<redacted>"));
    const short = payload.slice(0, 20); // a truncated fragment run is still a secret prefix
    assert.ok(!scrubSecrets(`https://hub/pair/#offer=${short}`).includes(`#offer=${short}`));
  } finally {
    await cleanup();
  }
});

test("denial aggregation: floods collapse to one row per window; buckets bounded", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_760_000_030_000 }); // mid-window: a minute boundary must not split the flood
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

const detailOf = (row: Record<string, unknown>) =>
  JSON.parse(row.detail_json as string) as Record<string, unknown>;

test("RR: a flood leaves its real total once the window has closed; the opening row does not pretend to count", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_760_000_010_000 }); // 10 s into a window
  const { registry, audit, cleanup } = await tempAudit();
  try {
    for (let i = 0; i < 1000; i++) audit.denied("auth.denied", "10.9.9.9", { path: "/api/tunnel" });
    assert.equal(rows(registry).length, 1);
    assert.equal(
      detailOf(rows(registry)[0]).count,
      undefined,
      "the opening row is a marker, not a total",
    );

    audit.sweepDenials();
    assert.equal(rows(registry).length, 1, "the window is still open: nothing to close");

    t.mock.timers.tick(60_000);
    audit.sweepDenials();
    const all = rows(registry);
    assert.equal(all.length, 2);
    const [opening, closing] = [detailOf(all[0]), detailOf(all[1])];
    assert.equal(closing.count, 1000);
    assert.equal(closing.closing, true);
    assert.equal(closing.window, opening.window);
    assert.equal(all[1].actor, all[0].actor);
    assert.equal(all[1].action, all[0].action);

    audit.sweepDenials();
    assert.equal(rows(registry).length, 2, "a window is closed once");
  } finally {
    await cleanup();
  }
});

test("RR: a window with a single denial needs no closing row; flushDenials closes the windows still open", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_760_000_010_000 });
  const { registry, audit, cleanup } = await tempAudit();
  try {
    audit.denied("auth.denied", "10.4.4.4", {});
    audit.denied("rate_limited", "10.4.4.5", {});
    audit.denied("rate_limited", "10.4.4.5", {});
    audit.denied("rate_limited", "10.4.4.5", {});
    t.mock.timers.tick(60_000);
    audit.sweepDenials();
    const closing = rows(registry)
      .map(detailOf)
      .filter((d) => d.closing);
    assert.deepEqual(
      closing.map((d) => d.count),
      [3],
      "only the window that saw more than one denial",
    );

    audit.denied("auth.denied", "10.4.4.6", {});
    audit.denied("auth.denied", "10.4.4.6", {});
    audit.flushDenials(); // shutdown: the current window is still open
    assert.deepEqual(
      rows(registry)
        .map(detailOf)
        .filter((d) => d.closing)
        .map((d) => d.count),
      [3, 2],
    );
    audit.flushDenials();
    assert.equal(
      rows(registry)
        .map(detailOf)
        .filter((d) => d.closing).length,
      2,
      "flushing twice writes nothing new",
    );
  } finally {
    await cleanup();
  }
});

test("RR: closing rows stay bounded: a distinct-address flood costs at most one opening and one closing row per recorded address", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_760_000_010_000 });
  const { registry, audit, cleanup } = await tempAudit();
  try {
    for (let i = 0; i < 400; i++)
      for (let k = 0; k < 2; k++) audit.denied("rate_limited", `10.6.${i >> 8}.${i & 255}`, {});
    t.mock.timers.tick(60_000);
    audit.sweepDenials();
    const total = rows(registry).length;
    assert.ok(total <= 2 * 256 + 1, `${total} rows for 800 denials from 400 addresses`);
    assert.ok(total >= 256, "the first 256 addresses were evidenced");
  } finally {
    await cleanup();
  }
});

test("RR: addresses of one IPv6 /64 are one denial source; an IPv4 client is one source in either spelling", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_760_000_010_000 });
  const { registry, audit, cleanup } = await tempAudit();
  try {
    for (let i = 1; i <= 50; i++)
      audit.denied("auth.denied", `2001:db8:1:2::${i.toString(16)}`, {});
    for (const spelling of ["198.51.100.7", "::ffff:198.51.100.7", "::ffff:c633:6407"])
      audit.denied("auth.denied", spelling, {});
    assert.deepEqual(
      rows(registry)
        .map((r) => r.actor)
        .sort(),
      ["ip:198.51.100.7", "ip:2001:db8:1:2::/64"],
    );
  } finally {
    await cleanup();
  }
});

test("RR: an over-long sample field cannot make the denial row unwritable", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_760_000_010_000 });
  const { registry, audit, cleanup } = await tempAudit();
  try {
    audit.denied("auth.denied", "10.7.7.7", {
      method: "GET",
      path: `/${"a".repeat(6_000)}`,
      status: 401,
    });
    assert.equal(audit.droppedDenials, 0);
    const all = rows(registry);
    assert.equal(all.length, 1);
    const sample = detailOf(all[0]).sample as { path: string; method: string; status: number };
    assert.ok(
      sample.path.length <= 200 && sample.path.startsWith("/aaa"),
      "the path is clipped, not dropped",
    );
    assert.equal(sample.method, "GET");
    assert.equal(sample.status, 401);
  } finally {
    await cleanup();
  }
});

test("GA-02: denied() never throws on a storage fault and does not wedge later accounting", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_760_000_030_000 }); // mid-window: a minute boundary must not split the recovered denials
  const hooks = { failAppend: true };
  const { registry, audit, cleanup } = await tempAudit(hooks);
  try {
    assert.doesNotThrow(() => audit.denied("auth.denied", "10.1.1.1", { path: "/api/tunnel" }));
    assert.equal(rows(registry).length, 0);
    assert.equal(audit.droppedDenials, 1);
    hooks.failAppend = false;
    audit.denied("auth.denied", "10.1.1.2", { path: "/api/tunnel" });
    audit.denied("auth.denied", "10.1.1.2", { path: "/api/tunnel" });
    assert.equal(rows(registry).length, 1, "later keys are persisted once the storage recovers");
    assert.equal(audit.droppedDenials, 1);
  } finally {
    await cleanup();
  }
});

test("GA-02: denial kinds from one IP and window are separate aggregates; a flood of each stays one row", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_760_000_030_000 }); // mid-window: a minute boundary must not split a flood
  const { registry, audit, cleanup } = await tempAudit();
  try {
    for (let i = 0; i < 50; i++) {
      audit.denied(
        "auth.denied",
        "10.2.2.2",
        { code: "token_unknown" },
        "tunnel.upgrade:token_unknown",
      );
      audit.denied("auth.denied", "10.2.2.2", { code: "revoked" }, "tunnel.upgrade:revoked");
    }
    const all = rows(registry);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => JSON.parse(r.detail_json as string).sample.code).sort(), [
      "revoked",
      "token_unknown",
    ]);
  } finally {
    await cleanup();
  }
});

test("GA-02: disk guard refuses audited work below the free-space floor; denials degrade to RAM-only", async () => {
  const MiB = 1024 * 1024;
  let free = 10 * 1024 * MiB;
  const { registry, audit, cleanup } = await tempAudit({
    freeBytes: () => free,
    minFreeBytes: 64 * MiB,
  });
  try {
    let ran = 0;
    audit.withTransaction(() => {
      ran++;
      audit.append({ actor: "admin", action: "pair.code_created", outcome: "ok" });
    });
    assert.equal(ran, 1);
    assert.equal(rows(registry).length, 1);

    free = 8 * MiB;
    const refused = (fn: () => unknown) =>
      assert.throws(
        fn,
        (e: Error & { status?: number; code?: string }) =>
          e.status === 503 && e.code === "audit_unavailable",
      );
    refused(() =>
      audit.withTransaction(() => {
        ran++;
      }),
    );
    refused(() => audit.append({ actor: "admin", action: "pair.cancelled", outcome: "ok" }));
    assert.equal(ran, 1, "the mutation callback never ran");
    assert.doesNotThrow(() => audit.denied("auth.denied", "10.3.3.3", {}));
    assert.equal(rows(registry).length, 1, "nothing was written below the floor");
    assert.equal(audit.droppedDenials, 1);

    free = 10 * 1024 * MiB;
    audit.withTransaction(() => {
      audit.append({ actor: "admin", action: "pair.cancelled", outcome: "ok" });
    });
    assert.equal(rows(registry).length, 2, "writes resume once space is available");
  } finally {
    await cleanup();
  }
});

test("GA-02: the default disk guard reads the real volume and lets a normal disk through", async () => {
  const { audit, cleanup } = await tempAudit();
  try {
    assert.doesNotThrow(() => audit.assertWritable());
  } finally {
    await cleanup();
  }
});

test("GA-15: startSweeper drops stale denial accounting on its own timer and stops cleanly", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_760_000_000_000 });
  const { audit, cleanup } = await tempAudit();
  try {
    audit.denied("auth.denied", "10.5.5.5", {});
    audit.denied("rate_limited", "10.5.5.6", {});
    assert.deepEqual(audit.stats(), { denialBuckets: 2, droppedDenials: 0 });
    const stop = audit.startSweeper(60_000);
    t.mock.timers.tick(60_000);
    assert.equal(audit.stats().denialBuckets, 2, "inside two windows nothing is stale yet");
    t.mock.timers.tick(3 * 60_000);
    assert.equal(audit.stats().denialBuckets, 0, "stale buckets are swept without any caller");
    stop();
    audit.denied("auth.denied", "10.5.5.7", {});
    t.mock.timers.tick(10 * 60_000);
    assert.equal(audit.stats().denialBuckets, 1, "a stopped sweeper no longer runs");
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
