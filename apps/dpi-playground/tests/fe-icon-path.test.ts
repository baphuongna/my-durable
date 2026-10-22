// The model icon file name comes from a device-controlled field and is interpolated into a
// same-origin path under /icons/. Only plain file names may pass.
import test from "node:test";
import assert from "node:assert/strict";
import { iconPath } from "../apps/dpi-playground-fe/src/client/icon-path.js";

test("icon path: plain png/svg file names are used", () => {
  assert.equal(iconPath("openai.png"), "/icons/openai.png");
  assert.equal(iconPath("lab.svg"), "/icons/lab.svg");
  assert.equal(iconPath("my-lab_2.v1.png"), "/icons/my-lab_2.v1.png");
});

test("icon path: traversal, separators, encodings, query/fragment and odd values fall back to the default", () => {
  for (const value of [
    "../../api/network",
    "../x.png",
    "..x.png",
    "a..b.png",
    "a/b.png",
    "a\\b.png",
    "%2e%2e%2fx.png",
    "x.png?y",
    "x.svg#f",
    "x.png ",
    " x.png",
    "x.PNG",
    "x.jpg",
    ".png",
    "",
    undefined,
    null,
    42,
    {},
    ["x.png"],
  ])
    assert.equal(iconPath(value), "/icons/lab.png", JSON.stringify(value) ?? String(value));
});
