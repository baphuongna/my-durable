// Transcript markdown is written by a device (or by an agent a device can prompt-inject) and is
// rendered with v-html inside the admin origin, so only the markdown subset may survive
// sanitising. DOMPurify needs a real DOM: the rendered result is asserted in tests/network-ui.mjs;
// this pins the policy data it is configured with.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  FORBIDDEN_TAGS,
  attributeAllowed,
  isSafeImageSrc,
} from "../apps/dpi-playground-fe/src/client/markdown-policy.js";

const HUB = "https://hub.example.com";

test("FE-M1: the tag allowlist is the markdown subset and excludes every active or form element", () => {
  for (const tag of [
    "p",
    "br",
    "hr",
    "strong",
    "em",
    "del",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "a",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "img",
  ])
    assert.ok(ALLOWED_TAGS.includes(tag), tag);
  for (const tag of [
    "form",
    "style",
    "script",
    "button",
    "select",
    "textarea",
    "iframe",
    "object",
    "embed",
    "svg",
    "math",
    "link",
    "meta",
    "base",
    "div",
    "span",
    "label",
    "option",
    "frame",
    "audio",
    "video",
    "details",
  ])
    assert.ok(!ALLOWED_TAGS.includes(tag), `${tag} must not be allowed`);
  for (const tag of [
    "form",
    "style",
    "script",
    "button",
    "select",
    "textarea",
    "iframe",
    "object",
    "embed",
    "svg",
    "math",
  ])
    assert.ok(FORBIDDEN_TAGS.includes(tag), tag);
  assert.deepEqual(
    ALLOWED_TAGS.filter((tag) => FORBIDDEN_TAGS.includes(tag)),
    [],
  );
  assert.ok(ALLOWED_TAGS.includes("input"), "only for the disabled GFM task-list checkbox");
});

test("FE-M2: the attribute allowlist has no style, id, name, form-action, data or aria attribute", () => {
  for (const name of [
    "style",
    "id",
    "name",
    "action",
    "formaction",
    "onclick",
    "onerror",
    "srcset",
    "xlink:href",
    "target",
    "rel",
    "value",
    "form",
  ])
    assert.ok(!ALLOWED_ATTR.includes(name), name);
  assert.ok(
    !ALLOWED_ATTR.some(
      (name) => name.startsWith("data-") || name.startsWith("aria-") || name.startsWith("on"),
    ),
  );
  for (const name of ["href", "title", "alt", "src", "colspan", "rowspan", "align", "class"])
    assert.ok(ALLOWED_ATTR.includes(name), name);
});

test("FE-M3: attributes are allowed per element, not globally", () => {
  assert.equal(attributeAllowed("a", "href", "https://example.org/"), true);
  assert.equal(attributeAllowed("a", "title", "t"), true);
  assert.equal(attributeAllowed("img", "src", "/x.png"), true);
  assert.equal(attributeAllowed("img", "alt", "a"), true);
  assert.equal(attributeAllowed("td", "colspan", "2"), true);
  assert.equal(attributeAllowed("th", "align", "center"), true);
  assert.equal(attributeAllowed("ol", "start", "3"), true);
  for (const [tag, name] of [
    ["p", "href"],
    ["p", "src"],
    ["a", "src"],
    ["img", "href"],
    ["p", "alt"],
    ["a", "colspan"],
    ["p", "class"],
    ["a", "class"],
    ["p", "start"],
    ["a", "style"],
    ["p", "id"],
    ["a", "name"],
    ["a", "action"],
    ["a", "formaction"],
    ["a", "onclick"],
    ["img", "onerror"],
    ["p", "data-x"],
    ["p", "aria-label"],
    ["a", "type"],
    ["input", "name"],
    ["input", "value"],
    ["input", "form"],
    ["unknown", "href"],
  ])
    assert.equal(attributeAllowed(tag, name, "x"), false, `${tag}[${name}]`);
});

test("FE-M4: class survives only as a code-fence language", () => {
  for (const value of [
    "language-ts",
    "language-c-sharp",
    "language-objective_c",
    "language-x86-64",
  ])
    assert.equal(attributeAllowed("code", "class", value), true, value);
  for (const value of [
    "modal",
    "language-",
    "language-a b",
    "language-a modal",
    "language-a\nmodal",
    "x language-ts",
    "language-ts modal",
    "Language-ts",
    "language-<b>",
    "language-a.b",
    "",
  ])
    assert.equal(attributeAllowed("code", "class", value), false, JSON.stringify(value));
});

test("FE-M5: only a disabled-checkbox input is representable; numeric and align values are validated", () => {
  assert.equal(attributeAllowed("input", "type", "checkbox"), true);
  assert.equal(attributeAllowed("input", "type", "CheckBox"), true);
  for (const value of ["text", "password", "submit", "image", "hidden", "file", ""])
    assert.equal(attributeAllowed("input", "type", value), false, value);
  assert.equal(attributeAllowed("input", "checked", ""), true);
  assert.equal(attributeAllowed("input", "disabled", ""), true);
  assert.equal(attributeAllowed("td", "colspan", "2; x"), false);
  assert.equal(attributeAllowed("td", "colspan", "99999"), false);
  assert.equal(attributeAllowed("td", "align", "javascript:x"), false);
});

test("FE-M6: an image is kept only for a same-origin source or an embedded raster image", () => {
  for (const src of [
    "/icons/lab.png",
    "icons/lab.png",
    `${HUB}/x.png`,
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    "DATA:IMAGE/WEBP;base64,UklGRhoAAABXRUJQ",
  ])
    assert.equal(isSafeImageSrc(src, HUB), true, src);
  // The admin API is not an image host: an <img> there is a credentialed GET the operator never asked for.
  for (const src of [
    "/api/network",
    "/api/devices/box/v1/file.png",
    "/API/network",
    "/x/../api/network",
    `${HUB}/api/stream`,
    "https://evil.test/t.png?d=secret",
    "http://evil.test/t.png",
    "//evil.test/t.png",
    "///evil.test/t.png",
    "/\\evil.test/t.png",
    "/\t/evil.test/t.png",
    "\\\\evil.test\\t.png",
    "https://hub.example.com.evil.test/x.png",
    "https://hub.example.com@evil.test/x.png",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/svg+xml,<svg/>",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/png,not-base64",
    'data:image/png;base64,AAAA"onerror="x',
    "data:image/png;base64,AAAA data:",
    "blob:https://hub.example.com/6f1c0b9e",
    "ftp://hub.example.com/x.png",
    "file:///etc/passwd",
    "",
  ])
    assert.equal(isSafeImageSrc(src, HUB), false, JSON.stringify(src));
});
