#!/usr/bin/env node
// P1-09 compile-negative suite for the wire-contract checker.
//
// Copies the real SDK wire types and the real checker into a throwaway layout, then removes one field,
// one tag or one nested subfield at a time. Every omission must make `tsc` fail with a diagnostic that
// names what went missing — never a missing-module or setup error — and the unmutated copy must pass.
//
// `npm run check` already runs the positive checks (src/contract-check.ts is in tsconfig include).
// This script proves those checks earn their keep. It never mutates the real source tree.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const backend = resolve(import.meta.dirname, "..");
const repo = resolve(backend, "../..");
const SDK_SRC = join(repo, "apps/dpi-sdk/src");
const CHECKER = join(backend, "src/contract-check.ts");
const WORK = join(backend, ".contract-negative");

const checkerSource = readFileSync(CHECKER, "utf8");
const apiSource = readFileSync(join(SDK_SRC, "api.ts"), "utf8");
const tsc = join(backend, "node_modules/.bin/tsc");

const tsconfig = {
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    lib: ["ES2023", "DOM", "DOM.Iterable"],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
  },
  include: ["apps/dpi-backend/src/contract-check.ts", "apps/dpi-sdk/src/api.ts"],
};

/** @type {{name: string, mutate: (s: string) => string, expect: RegExp, note: string}[]} */
const cases = [
  {
    name: "omit-nestedTools",
    note: "snapshot.nestedTools removed",
    mutate: (s) => s.replace(/\n  \/\*\* Nested calls of running tool calls[^\n]*\n  nestedTools: readonly WireNestedToolSlot\[\];/, ""),
    expect: /nestedTools/,
  },
  {
    name: "omit-end-result",
    note: "tool_execution_end.result removed",
    mutate: (s) => s.replace("; entry?: WireEntry; result?: WireNestedToolResult }", "; entry?: WireEntry }"),
    expect: /result/,
  },
  {
    name: "omit-end-error",
    note: "compaction_end.error removed",
    mutate: (s) => s.replace('| { type: "compaction_end"; taskId: number; reason: string; error?: string }', '| { type: "compaction_end"; taskId: number; reason: string }'),
    expect: /error/,
  },
  {
    name: "omit-nested-subfield",
    note: "WireNestedToolSlot.parentTaskId removed",
    mutate: (s) => s.replace("  parentCallId: string;\n  parentTaskId: number;\n", "  parentCallId: string;\n"),
    expect: /parentTaskId/,
  },
  {
    name: "omit-tag",
    note: "deferred_poll event variant removed",
    mutate: (s) => s.replace('\n  | { type: "deferred_poll"; pollAt: number }', ""),
    expect: /deferred_poll/,
  },
];

function prepare(directory, api) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(join(directory, "apps/dpi-backend/src"), { recursive: true });
  cpSync(SDK_SRC, join(directory, "apps/dpi-sdk/src"), { recursive: true });
  writeFileSync(join(directory, "apps/dpi-sdk/src/api.ts"), api);
  writeFileSync(join(directory, "apps/dpi-backend/src/contract-check.ts"), checkerSource);
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  // F18: the P2 protocol modules import @sinclair/typebox (dpi-sdk's
  // dependency) — the scratch layout must resolve the SAME packages as the
  // real tree or every case degrades into a missing-module error instead of
  // a completeness diagnostic. The scratch node_modules composes the
  // packages the copied sources actually resolve against.
  mkdirSync(join(directory, "node_modules"));
  const links = [
    [join(repo, "apps/dpi-sdk/node_modules"), "@sinclair"],
    [join(backend, "node_modules"), "@types"],
  ];
  for (const [from, name] of links)
    try {
      symlinkSync(join(from, name), join(directory, "node_modules", name), "dir");
    } catch {
      /* absent in this checkout: tsc will say so honestly */
    }
}

function compile(directory) {
  const result = spawnSync(tsc, ["--noEmit", "-p", "tsconfig.json"], { cwd: directory, encoding: "utf8" });
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
let failures = 0;
try {
  // Positive control: the unmutated copy must compile, so a negative failure cannot be a setup artifact.
  const control = join(WORK, "control");
  prepare(control, apiSource);
  const positive = compile(control);
  if (positive.status !== 0) {
    failures++;
    console.error(`FAIL control: unmutated copy does not compile\n${positive.output}`);
  } else {
    console.log("ok   control: unmutated copy compiles (0)");
  }

  for (const test of cases) {
    const directory = join(WORK, test.name);
    const mutated = test.mutate(apiSource);
    if (mutated === apiSource) {
      failures++;
      console.error(`FAIL ${test.name}: mutation did not apply (source shape changed?) — ${test.note}`);
      continue;
    }
    prepare(directory, mutated);
    const { status, output } = compile(directory);
    const moduleError = /TS2307|Cannot find module/.test(output);
    const named = test.expect.test(output);
    if (status === 0) {
      failures++;
      console.error(`FAIL ${test.name}: expected a compile error (${test.note}) but tsc passed`);
    } else if (moduleError) {
      failures++;
      console.error(`FAIL ${test.name}: failure is a module/setup error, not a completeness diagnostic\n${output}`);
    } else if (!named) {
      failures++;
      console.error(`FAIL ${test.name}: diagnostic does not name ${test.expect} (${test.note})\n${output}`);
    } else {
      console.log(`ok   ${test.name}: rejected with a diagnostic naming ${test.expect} (exit ${status}) — ${test.note}`);
    }
    rmSync(directory, { recursive: true, force: true });
  }
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} contract-negative case(s) failed`);
  process.exit(1);
}
console.log(`\nall ${cases.length} contract-negative cases failed for the right reason; control compiled`);
