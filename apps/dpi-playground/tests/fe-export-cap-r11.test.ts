// Run-11 h4-6 (Unit C): the bundle download now has a ceiling — the SDK
// already refuses to READ a binary body past 12 MiB (client.ts
// BINARY_BODY_MAX, r10 h3-1), so an over-cap bundle reaching the FE is a bug
// upstream; honoring it would materialize the bytes as a Blob + object URL
// one call later. downloadBundle() throws BEFORE any DOM work and run()'s
// existing catch turns that into the inline retryable error + toast (the
// R6 fe fix #5 surface, unchanged). Level: unit + wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import { createServer } from "vite";

globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }),
};
if (!globalThis.navigator)
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node-test" },
    configurable: true,
  });

const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);
let vite: Awaited<ReturnType<typeof createServer>>;

test.before(async () => {
  vite = await createServer({
    configFile: new URL("vite.config.ts", FE_ROOT).pathname,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
});
test.after(async () => {
  await vite?.close();
});

/** DOM probes for the "before any DOM work" half of the contract: every entry
 *  point into createElement/Blob-object-URL territory counts, and the cap
 *  path must leave all of them at zero. */
function stubDom() {
  const g = globalThis as Record<string, unknown> & typeof globalThis;
  const realDocument = g.document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  const calls = { createElement: 0, createObjectURL: 0, revokeObjectURL: 0 };
  g.document = {
    createElement: () => {
      calls.createElement++;
      return { href: "", download: "", click: () => {} };
    },
  };
  URL.createObjectURL = () => {
    calls.createObjectURL++;
    return "blob:fixture";
  };
  URL.revokeObjectURL = () => {
    calls.revokeObjectURL++;
  };
  return {
    calls,
    restore() {
      if (realDocument === undefined) delete (g as Record<string, unknown>).document;
      else g.document = realDocument;
      if (realCreate === undefined) delete (URL as unknown as Record<string, unknown>).createObjectURL;
      else URL.createObjectURL = realCreate;
      if (realRevoke === undefined) delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
      else URL.revokeObjectURL = realRevoke;
    },
  };
}

test("downloadBundle: an oversized bundle is refused BEFORE any DOM work", async () => {
  const { downloadBundle, EXPORT_BUNDLE_MAX_BYTES } = await vite.ssrLoadModule("/src/client/export-bundle.ts");
  const dom = stubDom();
  try {
    const oversized = { filename: "s1.zip", mime: "application/zip", bytes: new Uint8Array(EXPORT_BUNDLE_MAX_BYTES + 1) };
    assert.throws(() => downloadBundle(oversized), /over the \d+ byte download cap/);
    assert.deepEqual(dom.calls, { createElement: 0, createObjectURL: 0, revokeObjectURL: 0 }, "no anchor, no Blob, no object URL");

    // The cap is strictly-greater: a bundle exactly at the ceiling is legal.
    const atCap = { filename: "s1.zip", mime: "application/zip", bytes: new Uint8Array(EXPORT_BUNDLE_MAX_BYTES) };
    downloadBundle(atCap);
    assert.deepEqual(dom.calls, { createElement: 1, createObjectURL: 1, revokeObjectURL: 1 }, "the boundary bundle downloads");
  } finally {
    dom.restore();
  }
});

test("export bundle: the cap failure surfaces through run()'s inline retryable error", async () => {
  const { useExportBundle, EXPORT_BUNDLE_MAX_BYTES } = await vite.ssrLoadModule("/src/client/export-bundle.ts");
  const dom = stubDom();
  const notes: string[] = [];
  try {
    const target = ref({ device: { id: "dev1" }, summary: { id: "s1" } });
    // No download override: the REAL downloadBundle must be the one that refuses.
    const s = useExportBundle(target, {
      fetchBundle: async () => ({
        filename: "s1.zip",
        mime: "application/zip",
        bytes: new Uint8Array(EXPORT_BUNDLE_MAX_BYTES + 1024),
      }),
      notify: (t) => notes.push(t),
    });
    await s.run();
    assert.match(s.error.value, /bundle export failed: bundle is \d+ bytes, over the \d+ byte download cap/);
    assert.ok(s.error.value.length <= 300 + "bundle export failed: ".length, "the inline message is the full (sliced) reason");
    assert.deepEqual(dom.calls, { createElement: 0, createObjectURL: 0, revokeObjectURL: 0 }, "the bytes are never materialized");
    assert.match(notes.at(-1)!, /download cap/, "the toast still fires");

    // A retry with a legal bundle clears the inline error (retry surface intact).
    let calls = 0;
    const s2 = useExportBundle(target, {
      fetchBundle: async () => {
        if (++calls === 1)
          return { filename: "s1.zip", mime: "application/zip", bytes: new Uint8Array(EXPORT_BUNDLE_MAX_BYTES + 1) };
        return { filename: "s1.zip", mime: "application/zip", bytes: new Uint8Array(2048) };
      },
      notify: () => {},
    });
    await s2.run(); // over-cap again
    assert.match(s2.error.value, /download cap/);
    await s2.run(); // legal retry
    assert.equal(s2.error.value, "", "a successful retry clears the cap failure");
    assert.equal(dom.calls.createElement, 1, "exactly the legal retry touched the DOM");
  } finally {
    dom.restore();
  }
});

test("export bundle: a legal bundle still downloads via the injected download stub", async () => {
  const { useExportBundle } = await vite.ssrLoadModule("/src/client/export-bundle.ts");
  const target = ref({ device: { id: "dev1" }, summary: { id: "s1" } });
  const downloads: string[] = [];
  const notes: string[] = [];
  const s = useExportBundle(target, {
    fetchBundle: async () => ({ filename: "s1.zip", mime: "application/zip", bytes: new Uint8Array(2048) }),
    download: (r) => downloads.push(r.filename),
    notify: (t) => notes.push(t),
  });
  await s.run();
  assert.deepEqual(downloads, ["s1.zip"], "the legal bundle downloads");
  assert.equal(s.error.value, "", "no error");
  assert.match(notes.at(-1)!, /Bundle downloaded \(2 KiB\)/);
});
