/**
 * Run-10 H4 contract tests — device-authored URL scheme-trust (h4-1) and the
 * device-slot retention caps (h4-2/h4-3, h4-4). The threat actor is a hostile
 * PAIRED device: the hub relay deliberately forwards its frames (pipe
 * contract), so the FE is the last cap point.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const fe = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "dpi-playground-fe", "src");
const read = (p: string) => readFileSync(join(fe, p), "utf8");

test("h4-1: every device-authored href binding goes through externalHref — no raw scheme trust anywhere", () => {
  const git = read("components/GitPanel.vue");
  const tunnel = read("components/TunnelStatusBar.vue");
  // The computeds guard the base URL with externalHref (http/https only, hub origin rejected).
  assert.match(git, /const webUrl = computed\(\(\) => externalHref\(status\.value\?\.webUrl/, "webUrl computed must guard with externalHref");
  assert.match(git, /const remoteWeb = computed\(\(\) => externalHref\(status\.value\?\.webUrl/, "remoteWeb computed must guard with externalHref");
  assert.match(git, /const prSafeUrl = \(u: string\) => externalHref\(u, globalThis\.location\?\.origin \?\? ""\)/, "pr.url must have a guarded helper");
  // Template bindings may ONLY use the guarded computeds/helpers — never raw device fields.
  for (const line of git.split("\n")) {
    if (!line.includes(":href=")) continue;
    // webUrl/remoteWeb are the GUARDED computeds (asserted above) — they may
    // bind; raw device fields may never reach :href directly.
    assert.ok(
      !/:href="(pr\.url|device\.url|status\.value|status\.value\?\.webUrl)/.test(line),
      `raw device-authored href binding: ${line.trim()}`,
    );
  }
  assert.match(tunnel, /const safeUrl = \(u: string\) => externalHref\(u, globalThis\.location\?\.origin \?\? ""\)/, "TunnelStatusBar must guard device.url");
  assert.match(tunnel, /:href="safeUrl\(device\.url\)"/, "TunnelStatusBar template must use the guarded helper");
  // The pr link hides entirely when the scheme is not http(s).
  assert.match(git, /v-if="prSafeUrl\(pr\.url\)"/, "pr anchor must v-if on the guarded URL");
});

test("h4-2: device-slot doc frames are capped at ingestion — 64KiB ceiling, flattened preview past it", () => {
  const src = read("client/composables.ts");
  assert.match(src, /const DEVICE_DOC_MAX = 64 \* 1024;/, "doc cap constant");
  assert.match(src, /value: capDocFrame\(frame\.value\) as AppState/, "the doc frame value must pass through capDocFrame");
  assert.match(src, /subarray\(0, 4096\)\.toString\("utf8"\)/, "oversized values keep only a Buffer-rounded 4Ki preview (flatSlice rule)");
});

test("h4-3: activity previews are 4Ki-capped and cleared on device switch", () => {
  const src = read("client/composables.ts");
  assert.match(src, /const ACTIVITY_PREVIEW_MAX = 4096;/, "preview cap constant");
  assert.match(src, /preview: capPreview\(String\(it\.preview \?\? ""\)\)/, "every retained preview is capped");
  assert.match(src, /activity\.value = \[\]; \/\/ r10 h4-3/, "the deviceId watcher resets activity — previews never survive a switch");
});

test("h4-4: the markdown render cache retains only small sources (byte-bounded, not count-only)", () => {
  const src = read("client/markdown.ts");
  assert.match(src, /const CACHE_SOURCE_MAX = 4096;/, "cache source ceiling");
  assert.match(src, /if \(text\.length <= CACHE_SOURCE_MAX\)/, "oversized sources render but are never retained");
});
