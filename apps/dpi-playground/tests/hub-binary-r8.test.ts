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
