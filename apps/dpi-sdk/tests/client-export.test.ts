// R8 export-contract: the device route streams raw zip bytes (`application/zip`
// + Content-Length + Content-Disposition) instead of the old base64 JSON
// envelope, so DpiClient.exportSession() returns the payload as bytes and
// refusal faults still throw the usual typed DpiError.
// Level: unit, against a loopback http fixture server (hermetic — no device).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DpiClient } from "../src/client.js";
import { DpiError, isDpiError } from "../src/errors.js";

/** ZIP magic + bytes that are NOT valid UTF-8 — a base64/text round-trip would corrupt them. */
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x81, 0x8d]);

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(url);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

test("exportSession returns the raw zip bytes plus the device's Content-Disposition filename", async () => {
  let seenPath = "";
  await withServer(
    (req, res) => {
      seenPath = req.url ?? "";
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(ZIP.byteLength),
        "content-disposition": 'attachment; filename="my-session-1.bundle.zip"',
      });
      res.end(Buffer.from(ZIP));
    },
    async (url) => {
      const bundle = await new DpiClient(url).exportSession("s1");
      assert.equal(seenPath, "/v1/sessions/s1/export");
      assert.equal(bundle.filename, "my-session-1.bundle.zip");
      assert.equal(bundle.mime, "application/zip");
      assert.deepEqual([...bundle.bytes], [...ZIP], "byte-for-byte — a text decode would mojibake these");
    },
  );
});

test("exportSession slugs a fallback filename when Content-Disposition is missing", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(Buffer.from(ZIP));
    },
    async (url) => {
      const bundle = await new DpiClient(url).exportSession("My Session #1");
      assert.equal(bundle.filename, "my-session-1.bundle.zip", "the ref is slugged like the device does");
    },
  );
});

test("exportSession throws the typed fault when the device refuses (JSON body on a binary route)", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "invalid", message: "session bundle exceeds the 256 MiB ceiling" } }),
      );
    },
    async (url) => {
      await assert.rejects(
        new DpiClient(url).exportSession("s1"),
        (e: unknown) => {
          assert.ok(isDpiError(e), "a DpiError, not a raw fetch failure");
          assert.equal((e as DpiError).code, "invalid");
          assert.equal((e as DpiError).status, 413);
          assert.match((e as DpiError).message, /256 MiB ceiling/);
          return true;
        },
      );
    },
  );
});

test("exportSession falls back to status-derived fault codes when the body is not JSON", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    },
    async (url) => {
      await assert.rejects(
        new DpiClient(url).exportSession("s1"),
        (e: unknown) => isDpiError(e) && (e as DpiError).code === "internal" && (e as DpiError).status === 500,
      );
    },
  );
});
