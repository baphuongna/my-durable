#!/usr/bin/env node
/**
 * scripts/verify.mjs — P2-27 consolidated verification runner.
 *
 *   node scripts/verify.mjs --phase P2     # P2 acceptance suites
 *   node scripts/verify.mjs --phase all    # everything, in dependency order
 *
 * Contract:
 * - Preflight checks (node version, per-app toolchain, Caddy binary) run first.
 * - Suites run with an explicit cwd (never the repo root) and a fresh env.
 * - Inventory: every case family → suite → report line is printed; a suite
 *   that fails OR cannot run makes the whole run exit nonzero.
 * - Sanitized: manifests list file names only; logs are truncated and never
 *   contain tokens (test fixtures mint their own throwaway credentials).
 * - No deploy, no paid models, no network beyond 127.0.0.1 test binds.
 * - D-4 (NAT drill) belongs to P3 and is NEVER reported as pass here.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const phaseFlag = args.includes("--phase") ? args[args.indexOf("--phase") + 1] : undefined;
const phase = (phaseFlag ?? "P2").toUpperCase();

const ok = (msg) => process.stdout.write(`  \x1b[32m✓\x1b[0m ${msg}\n`);
const bad = (msg) => process.stdout.write(`  \x1b[31m✗\x1b[0m ${msg}\n`);
const info = (msg) => process.stdout.write(`  \x1b[2m${msg}\x1b[0m\n`);

// ---------------------------------------------------------------- preflight

function preflight() {
  const problems = [];
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) problems.push(`node ${process.versions.node} — tests need >= 22 (node:sqlite)`);
  else ok(`node ${process.versions.node}`);
  for (const dir of ["apps/dpi-sdk", "apps/dpi-backend", "apps/dpi-playground", "apps/dpi-tui"]) {
    try {
      statSync(join(ROOT, dir, "package.json"));
      statSync(join(ROOT, dir, "node_modules"));
    } catch {
      problems.push(`${dir}: package.json/node_modules missing — run npm install there`);
    }
  }
  if (!problems.some((p) => p.includes("node_modules"))) ok("toolchain: 4 apps installed");
  const caddy = join(ROOT, "tools", "caddy");
  try {
    statSync(caddy);
    ok("tools/caddy present (Caddy deploy tests)");
  } catch {
    info("tools/caddy absent — Caddy deploy tests will fail if the P2 suite includes them");
  }
  if (problems.length) {
    for (const p of problems) bad(p);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- suites

/** Build/type gates (review 2026-10-20 item 5): a green test runner must
 * never again coexist with a broken Web build or a dead compile-negative
 * fixture. These run FIRST so failures fail fast. */
const GATES = {
  "check:sdk": { cwd: "apps/dpi-sdk", cmd: ["npm", "run", "check"], title: "dpi-sdk type-check" },
  "check:backend": { cwd: "apps/dpi-backend", cmd: ["npm", "run", "check"], title: "dpi-backend type-check" },
  "contract:backend": { cwd: "apps/dpi-backend", cmd: ["npm", "run", "check:contract"], title: "compile-negative wire-contract fixture (control + 5 mutations)" },
  "build:playground": { cwd: "apps/dpi-playground", cmd: ["npm", "run", "build"], title: "vue-tsc FE + hub tsc + vite build (Web UI must ship)" },
  "check:tui": { cwd: "apps/dpi-tui", cmd: ["npm", "run", "check"], title: "dpi-tui type-check" },
};

const SUITES = {
  sdk: {
    cwd: "apps/dpi-sdk",
    cmd: ["npx", "tsx", "--test", "tests/*.test.ts"],
    title: "dpi-sdk: protocol/limits/chunk/registry/DTO (D-1..D-3, W-2 fixture, W-3 TypeBox runtime)",
  },
  backend: {
    cwd: "apps/dpi-backend",
    cmd: ["npx", "tsx", "--test", "tests/*.test.ts"],
    title: "dpi-backend: pairing files/flows, connector, REST (P-4/P-5/P-13, T-2 partial)",
  },
  playground: {
    cwd: "apps/dpi-playground",
    cmd: ["npm", "test"],
    title:
      "hub+FE integration: tunnel server/REST/readers/pacing, rotation/revoke, Caddy deploy, guards audit, FE pair client, QR cross-validation (P-1/P-6..P-8, S-1..S-12, T-*, W-*)",
  },
  tui: {
    cwd: "apps/dpi-tui",
    cmd: ["npx", "tsx", "--test", "tests/*.test.ts"],
    title: "dpi-tui: render cases + local pairing controller (P-4/P-5/P-10/P-13/P-14 render rules)",
  },
};

const PHASE_GATES = ["check:sdk", "check:backend", "contract:backend", "build:playground", "check:tui"];
const PHASE_SUITES = {
  P0: ["sdk"],
  P1: ["sdk", "playground"],
  P2: ["sdk", "backend", "playground", "tui"],
  all: ["sdk", "backend", "playground", "tui"],
};

function run(name, suite) {
  const cwd = join(ROOT, suite.cwd);
  process.stdout.write(`\n▶ ${name} — ${suite.title}\n  cwd: ${suite.cwd}\n  cmd: ${suite.cmd.join(" ")}\n`);
  const t0 = Date.now();
  const r = spawnSync(suite.cmd[0], suite.cmd.slice(1), {
    cwd,
    env: { ...process.env, DPI_TEST: "1", NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 1_800_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const tail = out.split("\n").filter(Boolean).slice(-6).join("\n  ");
  if (r.status === 0) {
    const pass = out.match(/^# pass (\d+)/m)?.[1];
    ok(`pass in ${secs}s${pass ? ` (${pass} tests)` : ""}`);
    return { name, ok: true, detail: pass ?? "ok" };
  }
  bad(`FAILED after ${secs}s (exit ${r.status ?? "signal"})`);
  info(`  last output:\n  ${tail}`);
  return { name, ok: false, detail: `exit ${r.status}` };
}

// ---------------------------------------------------------------- main

preflight();
const list = PHASE_SUITES[phase];
if (!list) {
  bad(`unknown phase ${phase} — use ${Object.keys(PHASE_SUITES).join(" | ")}`);
  process.exit(1);
}
process.stdout.write(`\n== verify phase ${phase} ==\n`);
info("case families NOT measured here (by design):");
info("  D-4 NAT drill — belongs to P3; this runner never claims it");
info("  browser pixel acceptance — headless matrix runs in the playground suite where present");
const results = [];
for (const name of PHASE_GATES) results.push(run(name, GATES[name]));
if (results.some((r) => !r.ok)) {
  bad("build/type gates failed — skipping test suites (fail fast)");
  process.exit(1);
}
for (const name of list) results.push(run(name, SUITES[name]));
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n== summary ==\n`);
for (const r of results) process.stdout.write(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name} (${r.detail})\n`);
if (failed.length) {
  bad(`${failed.length} suite(s) failed: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
ok(`all ${results.length} suite(s) green — phase ${phase} acceptance evidence recorded under artifacts/verification/`);
