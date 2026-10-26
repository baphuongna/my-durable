#!/usr/bin/env node
/**
 * scripts/verify.mjs — P2-27 consolidated verification runner.
 *
 *   node scripts/verify.mjs --phase P2     # core local suites
 *   node scripts/verify.mjs --phase all    # core + lint + browser + PTY
 *
 * Contract:
 * - Preflight checks (node version, per-app toolchain, Caddy binary) run first.
 * - Suites run with an explicit cwd (never the repo root) and a fresh env.
 * - Inventory: every case family → suite → report line is printed; a suite
 *   that fails OR cannot run makes the whole run exit nonzero.
 * - Output is a summary, not an automatically saved evidence manifest.
 *   Failure output is truncated; fixtures mint throwaway credentials.
 * - No deploy or paid models; test servers bind loopback.
 * - NAT/M1–M4 acceptance (P2-29), restore/quarantine (D-4, P3) and
 *   Gate A/B approval are not evaluated by this local runner. `--phase all`
 *   does run the R-1 recovery timing alone and prints every sample, but that
 *   is a local measurement, not the P2-29 acceptance run.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const phaseIndex = args.indexOf("--phase");
const phaseFlag = phaseIndex === -1 ? undefined : args[phaseIndex + 1];
if (phaseIndex !== -1 && (!phaseFlag || phaseFlag.startsWith("--"))) {
  process.stderr.write("--phase requires P0, P1, P2 or all\n");
  process.exit(1);
}
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
  "test:verification": { cwd: ".", cmd: ["node", "--test", "scripts/verify.test.mjs"], title: "verification CLI regressions" },
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
  "timing:backend": {
    cwd: "apps/dpi-backend",
    cmd: ["npm", "run", "test:timing"],
    title: "R-1/M4 SIGKILL recovery timing, run alone: strict < 2 s from before the kill, every sample reported (this machine only)",
    report: /^# (M4 R-1 (?:pass|fail):.*)$/m,
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
  "lint:playground": {
    cwd: "apps/dpi-playground",
    cmd: ["npm", "run", "lint"],
    title: "frontend, hub and playground tests",
  },
  "lint:core": {
    cwd: "apps/dpi-playground",
    cmd: [
      join(ROOT, "apps/dpi-playground/node_modules/.bin/oxlint"),
      ...["apps/dpi-sdk/src", "apps/dpi-sdk/tests", "apps/dpi-backend/src", "apps/dpi-backend/tests", "apps/dpi-tui/src", "apps/dpi-tui/tests", "scripts"].map((path) => join(ROOT, path)),
    ],
    title: "SDK, backend, TUI and verification scripts",
  },
  "ui:network": {
    cwd: "apps/dpi-playground",
    cmd: ["node", "tests/network-ui.mjs"],
    title: "real browser network, stream fault and mobile regression",
  },
  "ui:pairing": {
    cwd: "apps/dpi-playground",
    cmd: ["node", "--import", "tsx", "tests/pairing-ui.mjs"],
    title: "real browser pairing and offline credential regression",
  },
  "ui:tui": {
    cwd: "apps/dpi-tui",
    cmd: ["node", "tests/pairing-ui.mjs"],
    title: "real PTY pairing lifecycle and 40/80/200-column resize",
  },
  "ui:tui-session": {
    cwd: "apps/dpi-tui",
    cmd: ["node", "tests/newsession-ui.mjs"],
    title: "real PTY session creation on a keyless device + empty-state layout",
  },
  "ui:tui-keymap": {
    cwd: "apps/dpi-tui",
    cmd: ["node", "tests/keymap-ui.mjs"],
    title: "real PTY keymap: every advertised key drives a real backend",
  },
  "ui:tui-welcome": {
    cwd: "apps/dpi-tui",
    cmd: ["node", "tests/welcome-ui.mjs"],
    title: "real PTY welcome screen, detect-local and quit",
  },
  "ui:tui-ensure": {
    cwd: "apps/dpi-tui",
    cmd: ["node", "tests/ensure-ui.mjs"],
    title: "real PTY [d] auto-starts the local dpi-backend and opens it",
  },
};

const PHASE_GATES = ["test:verification", "check:sdk", "check:backend", "contract:backend", "build:playground", "check:tui"];
const PHASE_SUITES = {
  P0: ["sdk"],
  P1: ["sdk", "playground"],
  P2: ["sdk", "backend", "playground", "tui"],
  ALL: [
    "sdk",
    "backend",
    "timing:backend",
    "playground",
    "tui",
    "lint:playground",
    "lint:core",
    "ui:network",
    "ui:pairing",
    "ui:tui",
    "ui:tui-session",
    "ui:tui-keymap",
    "ui:tui-welcome",
    "ui:tui-ensure",
  ],
};

function run(name, suite) {
  const cwd = join(ROOT, suite.cwd);
  process.stdout.write(`\n▶ ${name} — ${suite.title}\n  cwd: ${suite.cwd}\n  cmd: ${suite.cmd.join(" ")}\n`);
  const t0 = Date.now();
  // Bare npm/npx are .cmd shims on Windows — a shell-less spawn cannot find
  // them and fails with ENOENT. The suite commands are fixed arrays with no
  // user input, so a shell is safe there; windowsHide keeps the runner
  // console-free on both platforms.
  const onWindows = process.platform === "win32";
  const r = spawnSync(suite.cmd[0], suite.cmd.slice(1), {
    cwd,
    env: { ...process.env, DPI_TEST: "1", NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 1_800_000,
    maxBuffer: 256 * 1024 * 1024,
    shell: onWindows,
    windowsHide: true,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const tail = out.split("\n").filter(Boolean).slice(-6).join("\n  ");
  const report = suite.report && out.match(suite.report)?.[1];
  if (r.status === 0) {
    const pass = out.match(/^# pass (\d+)/m)?.[1];
    // Skipped tests must stay visible: a suite that quietly skips half its cases
    // must not surface as a plain "PASS (n)".
    const skipped = out.match(/^# skip(?:ped)? (\d+)/m)?.[1];
    const skipNote = skipped && skipped !== "0" ? `${skipped} skipped` : "";
    const parts = [pass ? `${pass} tests` : "", skipNote].filter(Boolean);
    ok(`pass in ${secs}s${parts.length ? ` (${parts.join(", ")})` : ""}`);
    if (report) info(`  ${report}`);
    return { name, ok: true, detail: [pass, skipNote].filter(Boolean).join(", ") || "ok" };
  }
  bad(`FAILED after ${secs}s (exit ${r.status ?? "signal"})`);
  if (report) info(`  ${report}`);
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
info("  P2-29 NAT and M1–M4 acceptance targets: NOT_MEASURED");
if (phase === "ALL") info("    (timing:backend reports local R-1/M4 samples for this machine; it is not the P2-29 acceptance run)");
info("  D-4 restore/quarantine drill: NOT_MEASURED (P3)");
info("  Gate A / Gate B: NOT_EVALUATED; local tests do not authorize exposure");
if (phase !== "ALL") info("  lint/browser/PTY: NOT_RUN in this phase; use --phase all");
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
ok(`all ${results.length} suite(s) green (local checks only; no Gate A/B approval)`);
