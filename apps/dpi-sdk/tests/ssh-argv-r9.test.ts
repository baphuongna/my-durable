/**
 * run-9 unit E — u9: enumerate EVERY ssh argument source in
 * apps/dpi-sdk/src/node/{ops,drivers}.ts and guard each at the sink.
 *
 * Threat model: OpenSSH joins the words after the destination into ONE remote
 * command string that the remote shell re-parses; rsync word-splits its -e
 * value and embeds host:path in a remote command the remote shell re-parses;
 * an option-shaped word (leading dash) in destination position is parsed as an
 * ssh OPTION. So: explicit argv only, charset/shape guards on every dynamic
 * word, integers clamped before interpolation.
 *
 * Source → guard map (mirrors the ops.ts/drivers.ts guards under test):
 *   ops.ts SSH_OPTS          → single-word integrity assert (rsync -e split)
 *   ops.ts remote()          → sshTarget() sink validation of device.ssh
 *   ops.ts rsync() sources   → rsyncArgv() path guard (no dash/metachars)
 *   ops.ts rsync() dest join → rsyncArgv() dest guard + sshTarget()
 *   ops.ts exeDev() args     → exeDevArgv() charset allowlist (ls/new/share/rm)
 *   drivers.ts exeCreate     → exeVmArg(vm) + argvInt(cpu 1-64) + sshTarget(probe)
 *   drivers.ts exeExpose     → exeVmArg(vm) + argvInt(share port 1-65535)
 *   drivers.ts exeDestroy    → exeVmArg(vm) for `rm`
 *   drivers.ts logs          → clampInt(n 1-1000, fallback 80) for `tail -n`
 *   drivers.ts facts/provision/deploy/writeEnv → argvInt(node 1-99 / port 1-65535)
 *   drivers.ts waitOnline    → url/token consumer sink guard (migrated rows)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { argvInt, clampInt, exeDevArgv, exeVmArg, remote, rsyncArgv, SSH_OPTS, sshTarget } from "../src/node/ops.js";
import { waitOnline, type DriverContext } from "../src/node/drivers.js";
import type { NetDevice } from "../src/node/config.js";

const GOOD_TOKEN = `dpi_${"A".repeat(44)}`;
const dev = (over: Partial<NetDevice> = {}): NetDevice => ({
  id: "dev1",
  name: "dev1",
  kind: "ssh",
  url: "http://127.0.0.1:4782",
  port: 4782,
  node: 24,
  codeDir: "~/dpi",
  homeDir: "~/.dpi",
  host: "0.0.0.0",
  startDirs: ["~/dpi-work"],
  envKeys: [],
  env: {},
  ...over,
});
const ctxWith = (token: string | undefined): DriverContext =>
  ({ registry: { get: () => (token ? { token } : undefined) }, log: () => {} }) as unknown as DriverContext;

// ------------------------------------------------------------------ sshTarget

test("r9 E: sshTarget accepts only [user@]host[:port] — clean targets pass through verbatim", () => {
  for (const t of ["pi@raspberrypi.local", "pi@10.0.0.5:2222", "user.name%40dom@host.example.com", "dpi-vm.exe.xyz"])
    assert.equal(sshTarget(dev({ ssh: t })), t);
});

test("r9 E: sshTarget rejects option- and shell-shaped destinations (leading dash / attached options)", () => {
  for (const t of [
    "-oProxyCommand=evil@host", // ssh OPTION in destination position
    "-Jjump@pi@host", // attached-value option (ProxyJump) as user
    "-oBatchMode=yes", // option with no host at all
    "pi@host -oProxyCommand=evil", // trailing option smuggle
    "pi@host;id",
    "pi@ho'st",
    'pi@"host"',
    "pi@ho`st`",
    "pi@ho$st",
    "pi@host\n-oProxyCommand=evil",
    " pi@host",
    "pi @host",
    "",
    "pi@host:0",
    "pi@host:70000",
    "pi@host:99999",
    "pi@host:22;id",
    "pi@host:22 id",
  ])
    assert.throws(() => sshTarget(dev({ ssh: t })), /ssh target/, JSON.stringify(t));
});

test("r9 E: sshTarget rejects a device with no ssh scalar at all", () => {
  assert.throws(() => sshTarget(dev({ ssh: undefined })), /has no ssh target/);
});

test("r9 E: remote() refuses to spawn ssh for a hostile destination (guard fires before spawn)", () => {
  assert.throws(() => remote(dev({ ssh: "-oProxyCommand=evil@host" }), "echo hi"), /ssh target/);
});

// ------------------------------------------------------------------ exeDev argv

test("r9 E: exeDevArgv builds the exe.dev control-plane argv explicitly", () => {
  assert.deepEqual(exeDevArgv(["share", "port", "dpi-1", "4782"]), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "exe.dev",
    "share",
    "port",
    "dpi-1",
    "4782",
    "--json",
  ]);
  assert.deepEqual(exeDevArgv(["ls"]), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "exe.dev", "ls", "--json"]);
  assert.deepEqual(exeDevArgv(["new", "--name=dpi-1", "--cpu=4", "--memory=4GiB", "--disk=20G"]).slice(5, -1), [
    "new",
    "--name=dpi-1",
    "--cpu=4",
    "--memory=4GiB",
    "--disk=20G",
  ]);
});

test("r9 E: exeDevArgv rejects args that could detach into new remote words or re-parse as shell", () => {
  for (const a of ["vm;id", "vm id", "vm\nid", "vm\tid", "vm'id", 'vm"id', "vm$id", "vm`id`", "$(id)", "vm|id", "vm&id", "vm<id>", "rm -rf /", "", "vm\\id"])
    assert.throws(() => exeDevArgv(["rm", a]), /exe\.dev argument rejected/, JSON.stringify(a));
});

// ------------------------------------------------------------------ exe.dev values

test("r9 E: exeVmArg rejects option-shaped / metacharacter VM names (share port, set-public, rm, new)", () => {
  for (const vm of ["-oProxyCommand=evil", "-Jjump", "vm;id", "vm id", "vm\n-oProxyCommand=x", "vm`id`", "vm$id", "A", "UPPER", "_x", "x", "a".repeat(64), "", undefined])
    assert.throws(() => exeVmArg(vm), /vm name is invalid/, JSON.stringify(vm));
  assert.equal(exeVmArg("dpi-1"), "dpi-1");
  assert.equal(exeVmArg("a".repeat(63)), "a".repeat(63));
});

test("r9 E: argvInt clamps argv-bound integers (share port, cpu, node) before interpolation", () => {
  for (const bad of [0, -1, 70000, 1.5, NaN, Infinity, "4782;id", "1e999", "", null, undefined])
    assert.throws(() => argvInt(bad as number, 1, 65535, "port"), /port/, JSON.stringify(bad));
  assert.equal(argvInt(4782, 1, 65535, "port"), 4782);
  assert.equal(argvInt("4782", 1, 65535, "port"), 4782);
});

test("r9 E: clampInt clamps operator input for `net logs <n>` (was raw Number() into tail -n)", () => {
  assert.equal(clampInt("-5", 1, 1000, 80), 1);
  assert.equal(clampInt("1e9", 1, 1000, 80), 1000);
  assert.equal(clampInt(0, 1, 1000, 80), 1);
  assert.equal(clampInt(22.9, 1, 1000, 80), 22);
  assert.equal(clampInt("200", 1, 1000, 80), 200);
  assert.equal(clampInt("abc", 1, 1000, 80), 80);
  assert.equal(clampInt(undefined, 1, 1000, 80), 80);
});

// ------------------------------------------------------------------ rsync

test("r9 E: rsyncArgv builds the argv explicitly and -e word-splits back to exactly ssh + SSH_OPTS", () => {
  const argv = rsyncArgv(dev({ ssh: "pi@raspi.local" }), ["apps/dpi-backend", "apps/dpi-sdk"], "code/apps/");
  assert.deepEqual(argv, [
    "-a",
    "--delete",
    "--exclude",
    "node_modules",
    "--exclude",
    ".data",
    "--exclude",
    ".durable-pi",
    "--exclude",
    "dist",
    "--exclude",
    "*.log",
    "--exclude",
    ".DS_Store",
    "-e",
    "ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15",
    "apps/dpi-backend",
    "apps/dpi-sdk",
    "pi@raspi.local:code/apps/",
  ]);
  const e = argv[argv.indexOf("-e") + 1];
  assert.deepEqual(e.split(/\s+/), ["ssh", ...SSH_OPTS]);
  assert.ok(SSH_OPTS.every((o) => !/\s/.test(o)), "SSH_OPTS must stay single words (rsync word-splits -e)");
});

test("r9 E: rsyncArgv rejects option-shaped and shell-shaped sources and dests (remote shell re-parses the join)", () => {
  const good = dev({ ssh: "pi@raspi.local" });
  for (const dest of ["code;id/apps", "-evil", "$(pwd)/apps", "`pwd`/apps", "co'de/apps", "code apps", "code\nrm -rf /apps", "$HOME/apps", "code|apps", "code&apps", "code>x/apps", "co(de/apps", "", "code\\apps"])
    assert.throws(() => rsyncArgv(good, ["apps/dpi-backend"], dest), /rsync dest/, JSON.stringify(dest));
  for (const src of ["-e", "apps;rm", "apps $(id)", "apps;id", "app s"])
    assert.throws(() => rsyncArgv(good, [src], "code/apps/"), /rsync source/, JSON.stringify(src));
});

test("r9 E: rsyncArgv rejects a hostile ssh destination via sshTarget", () => {
  assert.throws(() => rsyncArgv(dev({ ssh: "-oProxyCommand=evil@host" }), ["apps/dpi-sdk"], "code/apps/"), /ssh target/);
});

// ------------------------------------------------------------------ waitOnline url/token sink

test("r9 E: waitOnline (migrated url/token consumer sink) refuses CRLF/non-http urls before any client call", async () => {
  const lf = "http://127.0.0.1:4782\nX-Forged: yes";
  await assert.rejects(waitOnline(dev({ url: lf }), ctxWith(GOOD_TOKEN), 1), /url/);
  await assert.rejects(waitOnline(dev({ url: "http://127.0.0.1:4782\rX-Forged: yes" }), ctxWith(GOOD_TOKEN), 1), /url/);
  await assert.rejects(waitOnline(dev({ url: "ftp://127.0.0.1:4782" }), ctxWith(GOOD_TOKEN), 1), /url/);
  await assert.rejects(waitOnline(dev({ url: "" }), ctxWith(GOOD_TOKEN), 1), /url/);
});

test("r9 E: waitOnline refuses a migrated/registry token with whitespace (header injection) or short length", async () => {
  await assert.rejects(waitOnline(dev(), ctxWith(`${GOOD_TOKEN}\r\nX-Forged: yes`), 1), /token/i);
  await assert.rejects(waitOnline(dev(), ctxWith("short"), 1), /token/i);
  await assert.rejects(waitOnline(dev(), ctxWith(undefined), 1), /has no token/);
});
