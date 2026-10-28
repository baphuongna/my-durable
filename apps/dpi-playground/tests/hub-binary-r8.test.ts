/**
 * R8 binary passthrough — hub side:
 *
 * 1. LanTransport flags non-textual device responses as base64 + carries the sanitized
 *    Content-Disposition; textual responses keep the legacy plain-string shape.
 * 2. The REST proxy serves base64-flagged payloads byte-exact with the device's content
 *    type + disposition (still a locked-down opaque download from the ADMIN origin).
 *
 * Rig: a stub "device" http server (binary zip / JSON), stub registry/monitor pair,
 * and the REAL LanTransport + proxy() mounted on a real express app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { LanTransport } from "../apps/dpi-playground-hub/src/transport.js";
import { proxy } from "../apps/dpi-playground-hub/src/proxy.js";
import type { TransportResponse } from "../apps/dpi-playground-hub/src/transport.js";

const ZIP = Buffer.concat([
  Buffer.from("PK\x03\x04\x14\x00\x00\x00\x08\x00", "binary"),
  Buffer.from("R8-hub-binary-payload", "utf8"),
]);
const ACTIVE = "<html><body>pwn</body></html>";

async function stubDevice(
  headers: Record<string, string>,
  body: Buffer | string,
): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, headers);
    res.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const lanRow = (url: string) => ({
  id: "dev-a",
  transport: "lan" as const,
  url,
  token: "dpt_" + "T".repeat(43),
});

test("LanTransport: binary zip → base64 flag + sanitized disposition; JSON → legacy shape", async () => {
  const device = await stubDevice(
    {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="résumé\tmy-session.bundle.zip"',
    },
    ZIP,
  );
  try {
    const t = new LanTransport(lanRow(device.url));
    const out = (await t.request(
      { method: "GET", path: "/v1/sessions/x/export" },
      new AbortController().signal,
    )) as TransportResponse;
    assert.equal(out.status, 200);
    assert.equal(out.contentType, "application/zip");
    assert.equal(out.bodyEncoding, "base64");
    const cd = String(out.contentDisposition);
    assert.match(cd, /^[\x20-\x7E]+$/, "printable ASCII only");
    assert.ok(cd.endsWith('my-session.bundle.zip"'), "filename tail kept, high bytes stripped");
    assert.ok(Buffer.from(String(out.body), "base64").equals(ZIP), "byte-exact round trip");

    const json = await stubDevice({ "content-type": "application/json" }, '{"ok":true}');
    try {
      const t2 = new LanTransport(lanRow(json.url));
      const out2 = await t2.request(
        { method: "GET", path: "/v1/device" },
        new AbortController().signal,
      );
      assert.equal(out2.bodyEncoding, undefined, "no flag for textual — legacy shape");
      assert.equal(out2.contentDisposition, undefined);
      assert.deepEqual(JSON.parse(String(out2.body)), { ok: true });
    } finally {
      await json.close();
    }
  } finally {
    await device.close();
  }
});

test("R13 (R9-6.3 FE): the proxy surfaces the device's replay verdict as the Idempotent-Replay header", async () => {
  // Both transport legs mark TransportResponse.idempotentReplay; the LAN leg
  // is exercised here (the tunnel envelope carries the same literal — proven
  // in the backend three-legs test), and the proxy maps it to the standard
  // header so FE clients can tell a replay from a fresh create.
  const device = await stubDevice(
    { "content-type": "application/json", "idempotent-replay": "true" },
    '{"ok":true}',
  );
  try {
    const registry = { get: () => lanRow(device.url) } as never;
    const monitor = { state: () => ({ status: "online" }) } as never;
    const app = express();
    app.use("/api/devices/:id/v1", proxy(registry, monitor));
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => listener.once("listening", done));
    const port = (listener.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/devices/dev-a/v1/sessions`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("idempotent-replay"), "true", "the replay verdict surfaces");
    } finally {
      listener.closeAllConnections?.();
      await new Promise<void>((done) => listener.close(() => done()));
    }
    // Without the verdict, the header is absent (never a false positive).
    const fresh = await stubDevice({ "content-type": "application/json" }, '{"ok":true}');
    try {
      const registry2 = { get: () => lanRow(fresh.url) } as never;
      const app2 = express();
      app2.use("/api/devices/:id/v1", proxy(registry2, monitor));
      const l2 = app2.listen(0, "127.0.0.1");
      await new Promise<void>((done) => l2.once("listening", done));
      const p2 = (l2.address() as { port: number }).port;
      try {
        const res = await fetch(`http://127.0.0.1:${p2}/api/devices/dev-a/v1/sessions`);
        assert.equal(res.headers.get("idempotent-replay"), null, "no header without a replay");
      } finally {
        l2.closeAllConnections?.();
        await new Promise<void>((done) => l2.close(() => done()));
      }
    } finally {
      await fresh.close();
    }
  } finally {
    await device.close();
  }
});

test("proxy: binary passthrough is byte-exact, keeps device type+filename, stays a locked-down download", async () => {
  const device = await stubDevice(
    {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="r8-live.bundle.zip"',
    },
    ZIP,
  );
  try {
    const registry = { get: () => lanRow(device.url) } as never;
    const monitor = { state: () => ({ status: "online" }) } as never;
    const app = express();
    app.use("/api/devices/:id/v1", proxy(registry, monitor));
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => listener.once("listening", done));
    const port = (listener.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/devices/dev-a/v1/sessions/x/export`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/zip");
      assert.equal(
        res.headers.get("content-disposition"),
        'attachment; filename="r8-live.bundle.zip"',
      );
      // Audit run-1 (GA-01 saved-file residual): even a ZIP answer's LABEL is
      // hub-authored — a hostile device filename is stripped and re-issued with
      // a forced .zip suffix, so the operator's download name is never chosen
      // by the device. (The honest *.bundle.zip contract is lossless here.)
      const rebrand = await stubDevice(
        { "content-type": "application/zip", "content-disposition": 'attachment; filename="session-notes.bundle.html"' },
        ZIP,
      );
      try {
        const registryR = { get: () => lanRow(rebrand.url) } as never;
        const appR = express();
        appR.use("/api/devices/:id/v1", proxy(registryR, monitor));
        const lr = appR.listen(0, "127.0.0.1");
        await new Promise<void>((done) => lr.once("listening", done));
        try {
          const resR = await fetch(
            `http://127.0.0.1:${(lr.address() as { port: number }).port}/api/devices/dev-a/v1/sessions/x/export`,
          );
          assert.equal(resR.status, 200);
          assert.equal(resR.headers.get("content-type"), "application/zip");
          const dispR = resR.headers.get("content-disposition") ?? "";
          assert.match(dispR, /\.zip"$/, "the download label always ends .zip");
          assert.doesNotMatch(dispR, /\.html/, "the device's html rebrand is gone");
          const bytesR = Buffer.from(await resR.arrayBuffer());
          assert.ok(bytesR.equals(ZIP), "bytes stay byte-exact through the relabel");
        } finally {
          lr.closeAllConnections?.();
          await new Promise<void>((done) => lr.close(() => done()));
        }
      } finally {
        await rebrand.close();
      }
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.ok(bytes.equals(ZIP), "proxy serves the zip byte-exact");

      // A hostile device cannot rebrand bytes as html at the ADMIN origin: only zip
      // keeps its label; every other non-JSON type is an inert octet-stream download.
      const hostile = await stubDevice(
        { "content-type": "text/html", "content-disposition": 'attachment; filename="evil.html"' },
        Buffer.from(ACTIVE),
      );
      try {
        const registry2 = { get: () => lanRow(hostile.url) } as never;
        const app2 = express();
        app2.use("/api/devices/:id/v1", proxy(registry2, monitor));
        const l2 = app2.listen(0, "127.0.0.1");
        await new Promise<void>((done) => l2.once("listening", done));
        try {
          const res2 = await fetch(
            `http://127.0.0.1:${(l2.address() as { port: number }).port}/api/devices/dev-a/v1/x`,
          );
          assert.equal(res2.headers.get("content-type"), "application/octet-stream");
          assert.equal(
            res2.headers.get("content-disposition"),
            'attachment; filename="device-response.bin"',
          );
        } finally {
          l2.closeAllConnections?.();
          await new Promise<void>((done) => l2.close(() => done()));
        }
      } finally {
        await hostile.close();
      }
    } finally {
      listener.closeAllConnections?.();
      await new Promise<void>((done) => listener.close(() => done()));
    }
  } finally {
    await device.close();
  }
});
