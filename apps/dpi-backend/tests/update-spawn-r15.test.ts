/**
 * R15 (run-1 NV v3-06, app-side): `dpi update` on win32 used to spawn a bare
 * `npm.cmd` through cmd.exe with no cwd pin — cmd.exe resolves bare .cmd names
 * CURRENT-DIRECTORY-FIRST unless NoDefaultCurrentDirectoryInExePath is set, so
 * a planted npm.cmd in the operator's invoking cwd would execute as the
 * operator during self-update (Windows OS fact, owner-checkable). The app-side
 * fix removes the dependency on that fact: resolve npm's cli script to an
 * ABSOLUTE .js path and spawn node + npm-cli.js with shell:false; the (rare)
 * fallback pins cwd + sets NoDefaultCurrentDirectoryInExePath.
 * Level: unit, scratch fs only (hermetic — no npm run, no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  resolveNpmCli,
  windowsFallbackEnv,
  windowsFallbackCwd,
} from "../../../bin/update.mjs";

test("resolveNpmCli never returns a .cmd or relative path — absolute .js or null", () => {
  const cli = resolveNpmCli();
  assert.ok(cli === null || (isAbsolute(cli) && cli.endsWith(".js")), `bad resolution: ${cli}`);
});

test("resolveNpmCli finds the POSIX nvm prefix layout (root/lib/node_modules)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dpi-r15-"));
  try {
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    const fakeNode = join(bin, "node");
    writeFileSync(fakeNode, "");
    const npmCli = join(tmp, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, "");
    assert.equal(resolveNpmCli(fakeNode, {}), npmCli);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveNpmCli finds the Windows nodejs.org layout (bin/node_modules)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dpi-r15-"));
  try {
    const fakeNode = join(tmp, "node.exe");
    writeFileSync(fakeNode, "");
    const npmCli = join(tmp, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, "");
    assert.equal(resolveNpmCli(fakeNode, {}), npmCli);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveNpmCli rejects a non-absolute or non-.js npm_execpath (planted .cmd)", () => {
  const prev = process.env.npm_execpath;
  try {
    process.env.npm_execpath = "npm.cmd"; // relative + .cmd — must be ignored
    const tmp = mkdtempSync(join(tmpdir(), "dpi-r15-"));
    try {
      const fakeNode = join(tmp, "bin", "node");
      mkdirSync(dirname(fakeNode), { recursive: true });
      writeFileSync(fakeNode, "");
      assert.equal(resolveNpmCli(fakeNode, { npm_execpath: "npm.cmd" }), null, "relative .cmd execpath must not resolve");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    if (prev === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = prev;
  }
});

test("windows fallback env suppresses cmd.exe cwd-first .cmd resolution", () => {
  const env = windowsFallbackEnv({ PATH: "x" });
  assert.equal(env.NoDefaultCurrentDirectoryInExePath, "1");
  assert.equal(env.PATH, "x");
});

test("windows fallback cwd is pinned to a trusted directory, never the invoking cwd", () => {
  assert.equal(windowsFallbackCwd({ SystemRoot: "C:\\Windows" }), "C:\\Windows");
  assert.equal(windowsFallbackCwd({}), dirname(process.execPath));
});
