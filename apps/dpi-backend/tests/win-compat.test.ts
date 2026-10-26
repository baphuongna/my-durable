/**
 * Round-4 win-compat fixes, store side: projectForPath's raw
 * `cwd.startsWith(root)` broke on win32 (backslash vs forward slash,
 * drive-letter case, `repo-x` vs `repo` prefix collisions). The pure helper
 * `pathsUnder` carries the platform so CI (Linux) can pin both behaviors:
 * win32 spellings compare equal; POSIX stays byte-identical.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathsUnder } from "../src/store.js";

test("pathsUnder: win32 spellings of the same repo all match", () => {
  assert.equal(pathsUnder("D:/src/repo", "D:\\src\\repo", "win32"), true, "backslash cwd under forward-slash root");
  assert.equal(pathsUnder("D:/src/repo", "d:/src/repo", "win32"), true, "drive case");
  assert.equal(pathsUnder("d:/SRC/REPO", "D:/src/repo/sub", "win32"), true, "mixed case, nested cwd");
  assert.equal(pathsUnder("D:/src/repo/", "D:/src/repo", "win32"), true, "trailing slash on the root");
  assert.equal(pathsUnder("D:/src/repo", "D:/src/repo/", "win32"), true, "trailing slash on the cwd");
  assert.equal(pathsUnder("D:/src/repo", "D:/src/repo/nested/file.ts", "win32"), true, "nested cwd");
});

test("pathsUnder: boundary — a sibling whose name extends the root is NOT under it", () => {
  assert.equal(pathsUnder("D:/src/repo", "D:/src/repo-other", "win32"), false);
  assert.equal(pathsUnder("D:/src/repo", "D:/src/repo-other/nested", "win32"), false);
  assert.equal(pathsUnder("/src/repo", "/src/repo-other", "linux"), false);
});

test("pathsUnder: win32 paths outside the root", () => {
  assert.equal(pathsUnder("D:/src/repo", "D:/src/other", "win32"), false);
  assert.equal(pathsUnder("D:/src/repo", "E:/src/repo", "win32"), false, "different drive");
  assert.equal(pathsUnder("D:/src/repo", "d:/src/rep", "win32"), false, "shorter sibling");
});

test("pathsUnder: POSIX stays byte-identical (case-sensitive, backslash literal)", () => {
  assert.equal(pathsUnder("/src/repo", "/src/repo", "linux"), true, "exact match");
  assert.equal(pathsUnder("/src/repo", "/src/repo/session", "linux"), true, "prefix match");
  assert.equal(pathsUnder("/src/repo", "/src/Repo", "linux"), false, "case matters on POSIX");
  assert.equal(pathsUnder("/src/repo", "/src/repo\\x", "linux"), false, "backslash is a legal filename char");
  // Trailing slashes normalize on BOTH platforms (the one deliberate change to
  // POSIX behavior: `/repo/` and `/repo` are the same root).
  assert.equal(pathsUnder("/src/repo/", "/src/repo", "linux"), true);
  assert.equal(pathsUnder("/src/repo", "/src/repo/", "linux"), true);
});

test("pathsUnder: default platform is the running one", () => {
  if (process.platform === "win32") assert.equal(pathsUnder("C:\\r", "c:/r", process.platform), true);
  else assert.equal(pathsUnder("/r", "/R", process.platform), false);
});
