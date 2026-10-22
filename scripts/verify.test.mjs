import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dpi-verify-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const log = join(root, "commands.jsonl");
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./verify.mjs", import.meta.url), join(root, "scripts/verify.mjs"));
  for (const app of ["dpi-sdk", "dpi-backend", "dpi-playground", "dpi-tui"]) {
    const dir = join(root, "apps", app);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
  }
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools/caddy"), "");

  // Replace only external commands. The real CLI selects and executes the plan.
  const command = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
const record = { command: basename(process.argv[1]), args: process.argv.slice(2), cwd: process.cwd() };
appendFileSync(process.env.VERIFY_FIXTURE_LOG, JSON.stringify(record) + "\\n");
if (record.args.join(" ") === "run test:timing") {
  console.log("# M4 R-1 fail: 5/5 samples (ms from before SIGKILL): 1100 2100 1200 1300 1400");
  for (let i = 0; i < 10; i++) console.log("# later output " + i); // pushes the samples out of the failure tail
}
if ([record.command, ...record.args].join(" ") === process.env.VERIFY_FIXTURE_FAIL) {
  console.error("fixture command failed");
  process.exit(7);
}
if (record.command === "oxlint" && record.args.some((arg) => arg.split("/").includes(".."))) {
  console.error("PATH must not contain parent traversal");
  process.exit(1);
}
if (process.env.VERIFY_FIXTURE_SKIPS) {
  console.log("# skipped " + process.env.VERIFY_FIXTURE_SKIPS);
}
console.log("# pass 1");
`;
  for (const name of ["node", "npm", "npx"]) {
    writeFileSync(join(bin, name), command, { mode: 0o755 });
  }
  const lintBin = join(root, "apps/dpi-playground/node_modules/.bin");
  mkdirSync(lintBin);
  writeFileSync(join(lintBin, "oxlint"), command, { mode: 0o755 });
  return {
    run(args, fail = "", env = {}) {
      writeFileSync(log, "");
      const result = spawnSync(process.execPath, [join(root, "scripts/verify.mjs"), ...args], {
        cwd: tmpdir(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          VERIFY_FIXTURE_LOG: log,
          VERIFY_FIXTURE_FAIL: fail,
          ...env,
        },
        encoding: "utf8",
        timeout: 15_000,
      });
      return {
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
        commands: readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
      };
    },
  };
}

test("documented --phase all runs all four application suites", (t) => {
  const result = fixture(t).run(["--phase", "all"]);
  assert.equal(result.status, 0, result.output);
  for (const app of ["dpi-sdk", "dpi-backend", "dpi-playground", "dpi-tui"]) {
    assert.ok(result.commands.some((c) =>
      c.cwd.endsWith(`/apps/${app}`) &&
      (c.args.includes("--test") || c.args.join(" ") === "test"),
    ), `${app} test suite was not executed`);
  }
});

test("all requires CLI regressions, lint, browser and PTY checks without expanding P2", (t) => {
  const f = fixture(t);
  const all = f.run(["--phase", "ALL"]);
  assert.equal(all.status, 0, all.output);
  assert.ok(all.commands.some((c) =>
    c.command === "node" && c.args.join(" ") === "--test scripts/verify.test.mjs",
  ), "CLI regressions must be part of the gate");
  const extra = [
    ["dpi-backend", "npm", "run test:timing"],
    ["dpi-playground", "npm", "run lint"],
    ["dpi-playground", "node", "tests/network-ui.mjs"],
    ["dpi-playground", "node", "--import tsx tests/pairing-ui.mjs"],
    ["dpi-tui", "node", "tests/pairing-ui.mjs"],
  ];
  const executed = (result, [app, command, args]) => result.commands.some((c) =>
    c.cwd.endsWith(`/apps/${app}`) && c.command === command && c.args.join(" ") === args,
  );
  for (const check of extra) assert.ok(executed(all, check), check.join(" "));
  assert.ok(all.commands.some((c) =>
    c.command === "oxlint" && c.args.some((arg) => arg.endsWith("/scripts")),
  ));

  const p2 = f.run(["--phase", "p2"]);
  assert.equal(p2.status, 0, p2.output);
  for (const check of extra) assert.equal(executed(p2, check), false, check.join(" "));

  const failed = f.run(["--phase", "all"], "node --import tsx tests/pairing-ui.mjs");
  assert.notEqual(failed.status, 0, failed.output);
  assert.match(failed.output, /FAIL\s+ui:pairing/);
  assert.doesNotMatch(failed.output, /all \d+ suite\(s\) green/);
});

test("the recovery timing suite reports every sample, passing or failing, and a failing timing fails the run", (t) => {
  const f = fixture(t);
  const passing = f.run(["--phase", "all"]);
  assert.equal(passing.status, 0, passing.output);
  assert.match(passing.output, /M4 R-1 \w+: 5\/5 samples \(ms from before SIGKILL\): 1100 2100 1200 1300 1400/);
  assert.match(passing.output, /timing:backend reports local R-1\/M4 samples.*not the P2-29 acceptance run/);

  const failing = f.run(["--phase", "all"], "npm run test:timing");
  assert.notEqual(failing.status, 0, failing.output);
  assert.match(failing.output, /FAIL\s+timing:backend/);
  assert.match(failing.output, /M4 R-1 fail: 5\/5 samples/, "the samples of a failed run stay in the output");
  assert.doesNotMatch(failing.output, /all \d+ suite\(s\) green/);

  const p2 = f.run(["--phase", "p2"]);
  assert.equal(p2.status, 0, p2.output);
  assert.doesNotMatch(p2.output, /M4 R-1/);
  assert.doesNotMatch(p2.output, /timing:backend/);
});

test("missing or unknown phase values fail without running any commands", (t) => {
  const f = fixture(t);
  for (const args of [["--phase"], ["--phase", "--unknown"], ["--phase", "unknown"]]) {
    const result = f.run(args);
    assert.notEqual(result.status, 0, result.output);
    assert.equal(result.commands.length, 0, result.output);
  }
});

test("local results distinguish NAT, restore and gate approval without claiming saved evidence", (t) => {
  const f = fixture(t);
  for (const args of [[], ["--phase", "all"]]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /P2-29 NAT.*NOT_MEASURED/);
    assert.match(result.output, /D-4 restore\/quarantine.*NOT_MEASURED.*P3/);
    assert.match(result.output, /Gate A \/ Gate B: NOT_EVALUATED/);
    assert.doesNotMatch(result.output, /acceptance evidence recorded|D-4 NAT/);
  }
});

test("core lint receives normalized absolute source paths", (t) => {
  const result = fixture(t).run(["--phase", "all"]);
  assert.equal(result.status, 0, result.output);
  const lint = result.commands.find((c) => c.command === "oxlint");
  assert.ok(lint);
  assert.ok(lint.args.every((arg) => isAbsolute(arg) && !arg.split("/").includes("..")));
});

test("a suite that reports skipped tests surfaces the skip count in its summary line", (t) => {
  const f = fixture(t);
  const skipped = f.run(["--phase", "p2"], "", { VERIFY_FIXTURE_SKIPS: "2" });
  assert.equal(skipped.status, 0, skipped.output);
  assert.match(skipped.output, /PASS\s+sdk \(1, 2 skipped\)/, "the surfaced summary must carry the skip count");

  const plain = f.run(["--phase", "p2"]);
  assert.equal(plain.status, 0, plain.output);
  assert.match(plain.output, /PASS\s+sdk \(1\)/, "suites reporting no skips keep the current output contract");
  assert.doesNotMatch(plain.output, /, \d+ skipped/);
});
