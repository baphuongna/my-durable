/**
 * Pairing from the CLI — both directions, no browser involved.
 *
 *   dpi pair <code|pairUrl|offerLink> [--hub <origin>]   pair THIS machine
 *   dpi pair --hub <origin>                              this machine asks the hub
 *                                                        itself; prints the identity
 *                                                        block and waits for approval
 *   dpi pair offer [--hub <origin>]                      operator: mint an offer link
 *                                                        for a NEW machine (paste it there)
 *   dpi pair list [--hub <origin>]                       operator: who is waiting
 *   dpi pair approve <name|codeId> [--hub <origin>]      operator: approve that machine
 *   dpi pair revoke <name|deviceId> [--hub <origin>]     operator: revoke its credential
 *
 * The device side talks to the LOCAL backend (token-authed /v1/pairing), the
 * operator side talks to the HUB (admin token). Both accept the token from the
 * environment or from the file each component already bootstrapped, so a device
 * with `dpi device` running needs no arguments at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PairCliDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  print?: (line: string) => void;
  /** Poll interval while waiting for approval (tests shrink it). */
  pollMs?: number;
  /** Give up waiting after this long (0 = wait forever, the default). */
  timeoutMs?: number;
  /** Resolves after `ms` — injectable so tests do not sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Directory that holds the hub's admin.token (default ~/.local/share/durable-pi). */
  hubHome?: string;
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function io(deps: PairCliDeps) {
  return {
    env: deps.env ?? process.env,
    fetch: deps.fetchImpl ?? fetch,
    print: deps.print ?? ((line: string) => process.stdout.write(`${line}\n`)),
    pollMs: deps.pollMs ?? 1000,
    timeoutMs: deps.timeoutMs ?? 0,
    sleep: deps.sleep ?? realSleep,
  };
}

/** The local device API: DPI_PORT + the token from env or its env file. */
export function localTarget(env: Record<string, string | undefined>) {
  const home = expand(env.DPI_HOME ?? join(homedir(), ".dpi"));
  const port = Number(env.DPI_PORT ?? "4780");
  let token = env.DPI_TOKEN ?? "";
  if (!token) {
    for (const file of [env.DPI_ENV_FILE, join(home, "backend.env")]) {
      if (!file) continue;
      try {
        const m = readFileSync(expand(file), "utf8").match(/^DPI_TOKEN=(.+)$/m);
        if (m) {
          token = m[1].trim();
          break;
        }
      } catch {
        /* no env file yet */
      }
    }
  }
  return { url: `http://127.0.0.1:${port}`, token, home };
}

/** The hub: origin from --hub / DPI_HUB_URL, admin token from env or its file. */
export function hubTarget(env: Record<string, string | undefined>, hubHome?: string) {
  const origin = (env.DPI_HUB_URL ?? "").replace(/\/+$/, "");
  let token = env.DPI_ADMIN_TOKEN ?? "";
  if (!token) {
    const home = hubHome ?? expand(env.DPI_HOME ?? join(homedir(), ".local/share/durable-pi"));
    for (const file of [env.DPI_ADMIN_TOKEN_FILE, join(home, "admin.token")]) {
      if (!file) continue;
      try {
        token = readFileSync(expand(file), "utf8").trim();
        if (token) break;
      } catch {
        /* not the hub's home */
      }
    }
  }
  return { origin, token };
}

async function jsonOrThrow(res: Response, what: string) {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw Error(`${what}: hub returned ${res.status} (not JSON): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = (body as { error?: { message?: string } }).error;
    throw Error(`${what}: ${err?.message ?? `HTTP ${res.status}`}`);
  }
  return body as Record<string, unknown>;
}

/** Print the block an operator compares with the hub's approval card. */
function identityLines(status: {
  deviceName?: string;
  fingerprint?: string;
  hostname?: string;
  platform?: string;
}): string[] {
  return [
    `  device      ${status.deviceName ?? "?"}`,
    ...(status.hostname ? [`  hostname    ${status.hostname}`] : []),
    ...(status.platform ? [`  platform    ${status.platform}`] : []),
    `  fingerprint ${status.fingerprint ?? "?"}`,
  ];
}

export type PairAction = "device" | "offer" | "list" | "approve" | "revoke";

/** Parse `dpi pair …` argv into an action plus its arguments. */
export function parsePairCommand(argv: string[]): {
  action: PairAction;
  target?: string;
  hub?: string;
  force: boolean;
  wait: boolean;
  watch: boolean;
} {
  const hubIdx = argv.indexOf("--hub");
  const hub = hubIdx >= 0 ? argv[hubIdx + 1] : undefined;
  const force = argv.includes("--force");
  const wait = argv.includes("--wait") || argv.includes("--yes");
  const watch = argv.includes("--watch");
  const rest = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--hub");
  const [first, second] = rest;
  if (first === "offer") return { action: "offer", hub, force, wait, watch };
  if (first === "list") return { action: "list", hub, force, wait, watch };
  if (first === "approve") return { action: "approve", target: second, hub, force, wait, watch };
  if (first === "revoke") return { action: "revoke", target: second, hub, force, wait, watch };
  // Anything else is the thing to pair with: a code, a pair URL or an offer link.
  return { action: "device", target: first, hub, force, wait, watch };
}

/**
 * Pair THIS machine. With a code/link the hub already knows the request; with
 * only `--hub` the machine asks the hub itself (device-initiated enrollment) and
 * prints its identity so the operator can compare before approving.
 */
export async function pairThisDevice(
  args: { target?: string; hub?: string; force: boolean },
  deps: PairCliDeps = {},
): Promise<number> {
  const { env, fetch: f, print, pollMs, timeoutMs, sleep } = io(deps);
  const local = localTarget(env);
  if (!local.token) {
    print("no local device token — is `dpi device` installed here? (looked in DPI_TOKEN / backend.env)");
    return 1;
  }
  const auth = { authorization: `Bearer ${local.token}`, "content-type": "application/json" };

  const body: Record<string, unknown> = {};
  if (args.target) {
    if (/^https?:\/\//i.test(args.target)) body.pairUrl = args.target;
    else body.code = args.target;
    if (args.hub) body.hub = args.hub;
  } else if (args.hub) {
    // Device-initiated: no secret to carry between machines.
    body.hub = args.hub;
  } else {
    print("pair needs a code, a pair link, or --hub <origin> to ask the hub itself");
    return 1;
  }
  if (args.force) body.force = true;

  let started: Record<string, unknown>;
  try {
    started = await jsonOrThrow(
      await f(`${local.url}/v1/pairing/start`, { method: "POST", headers: auth, body: JSON.stringify(body) }),
      "pairing start",
    );
  } catch (error) {
    print(`pairing failed: ${(error as Error).message}`);
    return 1;
  }

  const status = started as {
    state?: string;
    deviceName?: string;
    fingerprint?: string;
    hostname?: string;
    platform?: string;
    pending?: { hubOrigin?: string };
    lastError?: string;
  };
  const hubOrigin = status.pending?.hubOrigin ?? args.hub ?? "(hub)";
  if (status.state === "paired") {
    print(`already paired${status.pending?.hubOrigin ? ` to ${status.pending.hubOrigin}` : ""} — use --force to switch hubs`);
    return 0;
  }
  print(`pairing with ${hubOrigin}`);
  for (const line of identityLines(status)) print(line);
  print("  compare the fingerprint with the hub's approval card, then approve there");
  print("  (web: hub → Machines waiting for you · cli: dpi pair list / dpi pair approve <name>)");

  const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
  for (;;) {
    await sleep(pollMs);
    let now: Record<string, unknown>;
    try {
      now = await jsonOrThrow(await f(`${local.url}/v1/pairing`, { headers: auth }), "pairing status");
    } catch (error) {
      print(`lost the local backend: ${(error as Error).message}`);
      return 1;
    }
    const state = String(now.state ?? "");
    if (state === "paired") {
      print(`paired ✓ ${String((now as { hubOrigin?: string }).hubOrigin ?? hubOrigin)}`);
      return 0;
    }
    if (state === "unpaired" || state === "failed") {
      print(`pairing ended: ${String((now as { lastError?: string }).lastError ?? state)}`);
      return 1;
    }
    if (deadline && Date.now() > deadline) {
      print("still waiting for approval — approve it and run `dpi pair` again, or wait longer with --wait");
      return 1;
    }
  }
}

/** Operator side: mint an offer link for a machine that has no CLI pairing yet. */
async function pairOffer(deps: PairCliDeps, hubArg?: string): Promise<number> {
  const { env, fetch: f, print } = io(deps);
  const hub = hubTarget(env, deps.hubHome);
  const origin = hubArg ?? hub.origin;
  if (!origin) return print("offer needs --hub <origin> (or DPI_HUB_URL)"), 1;
  if (!hub.token) return print("offer needs the hub admin token (DPI_ADMIN_TOKEN or the hub's admin.token)"), 1;
  try {
    const minted = await jsonOrThrow(
      await f(`${origin}/api/pair/code`, {
        method: "POST",
        headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
        body: "{}",
      }),
      "mint offer",
    );
    print(`offer for a new machine (expires in ${Math.round((Number(minted.expiresAt) - Date.now()) / 60000)} min):`);
    print(`  ${String(minted.offerUrl ?? minted.pairUrl)}`);
    print(`  code ${String(minted.code)}`);
    print("paste that link on the machine:  dpi pair <link>   (or dpi tui --pair <link>)");
    return 0;
  } catch (error) {
    print(`offer failed: ${(error as Error).message}`);
    return 1;
  }
}

interface PendingCode {
  codeId: string;
  deviceName?: string;
  hostname?: string;
  platform?: string;
  keyFingerprint?: string;
  phase?: string;
  enrollmentId?: string;
  deviceUid?: string;
}

/** Watch cadence: the caller's pollMs (tests) or 2 s. */
function watchPoll(deps: PairCliDeps): number {
  return deps.pollMs ?? 2000;
}

function printPending(c: PendingCode, print: (l: string) => void = (l) => process.stdout.write(`${l}\n`)) {
  print(`  ${c.deviceName ?? "(unnamed)"}  ·  ${c.phase ?? "?"}`);
  print(`    hostname    ${c.hostname ?? "?"}`);
  print(`    platform    ${c.platform ?? "?"}`);
  print(`    fingerprint ${c.keyFingerprint ?? "?"}`);
  print(`    approve with: dpi pair approve ${c.deviceName ?? c.codeId}`);
}

/** Pending codes or a ready-to-print error string (watch loops never throw). */
async function pendingCodesOrError(deps: PairCliDeps, hubArg?: string): Promise<PendingCode[] | string> {
  const { env, fetch: f } = io(deps);
  const hub = hubTarget(env, deps.hubHome);
  const origin = hubArg ?? hub.origin;
  if (!origin) return "list needs --hub <origin> (or DPI_HUB_URL)";
  if (!hub.token) return "list needs the hub admin token (DPI_ADMIN_TOKEN or the hub's admin.token)";
  try {
    return await pendingCodes(origin, hub.token, f);
  } catch (error) {
    return `list failed: ${(error as Error).message}`;
  }
}

async function pendingCodes(origin: string, token: string, f: typeof fetch): Promise<PendingCode[]> {
  const body = await jsonOrThrow(
    await f(`${origin}/api/pair/codes`, { headers: { authorization: `Bearer ${token}` } }),
    "list pending",
  );
  return (body.codes ?? []) as PendingCode[];
}

async function pairList(deps: PairCliDeps, hubArg?: string, watch = false): Promise<number> {
  const { env, fetch: f, print, pollMs, sleep } = io(deps);
  if (watch) {
    // Live: reprint only when the set of waiting machines changes, so the
    // operator sees a device appear (or leave) without re-running the command.
    let previous = "";
    for (;;) {
      const snapshot = await pendingCodesOrError(deps, hubArg);
      if (typeof snapshot === "string") return print(snapshot), 1;
      const key = snapshot.map((c) => `${c.codeId}:${c.phase}:${c.deviceName ?? ""}`).join("|");
      if (key !== previous) {
        previous = key;
        print(`— ${new Date().toLocaleTimeString()} —`);
        if (!snapshot.length) print("nothing is waiting for approval");
        for (const c of snapshot) printPending(c);
      }
      await sleep(watchPoll(deps));
    }
  }
  const hub = hubTarget(env, deps.hubHome);
  const origin = hubArg ?? hub.origin;
  if (!origin) return print("list needs --hub <origin> (or DPI_HUB_URL)"), 1;
  if (!hub.token) return print("list needs the hub admin token (DPI_ADMIN_TOKEN or the hub's admin.token)"), 1;
  try {
    const codes = await pendingCodes(origin, hub.token, f);
    if (!codes.length) {
      print("nothing is waiting for approval");
      print(`  mint an offer for a new machine: dpi pair offer --hub ${origin}`);
      return 0;
    }
    print(`${codes.length} machine${codes.length === 1 ? "" : "s"} waiting on ${origin}:`);
    for (const c of codes) printPending(c, print);
    return 0;
  } catch (error) {
    print(`list failed: ${(error as Error).message}`);
    return 1;
  }
}

async function pairApprove(deps: PairCliDeps, target?: string, hubArg?: string): Promise<number> {
  const { env, fetch: f, print } = io(deps);
  const hub = hubTarget(env, deps.hubHome);
  const origin = hubArg ?? hub.origin;
  if (!origin) return print("approve needs --hub <origin> (or DPI_HUB_URL)"), 1;
  if (!hub.token) return print("approve needs the hub admin token (DPI_ADMIN_TOKEN or the hub's admin.token)"), 1;
  if (!target) return print("approve needs a machine name or code id (see: dpi pair list)"), 1;
  try {
    const codes = await pendingCodes(origin, hub.token, f);
    const code =
      codes.find((c) => c.codeId === target) ??
      codes.find((c) => (c.deviceName ?? "").toLowerCase() === target.toLowerCase());
    if (!code) {
      print(`nothing waiting matches “${target}” — run: dpi pair list`);
      return 1;
    }
    // The approval body is the hub's own view of the request; the fingerprint is
    // the hub-computed one, never what the device claimed.
    const approved = await jsonOrThrow(
      await f(`${origin}/api/pair/codes/${code.codeId}/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          enrollmentId: code.enrollmentId,
          deviceUid: code.deviceUid,
          keyFingerprint: code.keyFingerprint,
        }),
      }),
      "approve",
    );
    print(`approved ${code.deviceName ?? code.codeId} (${String(approved.phase ?? "approved")})`);
    print(`  fingerprint ${code.keyFingerprint ?? "?"}`);
    return 0;
  } catch (error) {
    print(`approve failed: ${(error as Error).message}`);
    return 1;
  }
}

async function pairRevoke(deps: PairCliDeps, target?: string, hubArg?: string): Promise<number> {
  const { env, fetch: f, print } = io(deps);
  const hub = hubTarget(env, deps.hubHome);
  const origin = hubArg ?? hub.origin;
  if (!origin) return print("revoke needs --hub <origin> (or DPI_HUB_URL)"), 1;
  if (!hub.token) return print("revoke needs the hub admin token (DPI_ADMIN_TOKEN or the hub's admin.token)"), 1;
  if (!target) return print("revoke needs a device name or id (see: dpi devices)"), 1;
  try {
    const net = await jsonOrThrow(
      await f(`${origin}/api/network`, { headers: { authorization: `Bearer ${hub.token}` } }),
      "list devices",
    );
    const devices = (net.devices ?? []) as Array<{ id: string; name: string; deviceUid?: string }>;
    const device =
      devices.find((d) => d.id === target) ?? devices.find((d) => d.name.toLowerCase() === target.toLowerCase());
    if (!device) {
      print(`no device matches “${target}” — known: ${devices.map((d) => d.name).join(", ") || "none"}`);
      return 1;
    }
    await jsonOrThrow(
      await f(`${origin}/api/devices/${device.id}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "revoked from the cli" }),
      }),
      "revoke",
    );
    print(`revoked ${device.name} — its next request will be refused`);
    return 0;
  } catch (error) {
    print(`revoke failed: ${(error as Error).message}`);
    return 1;
  }
}

/** Entry point for `dpi pair …`. */
export async function runPairCommand(argv: string[], deps: PairCliDeps = {}): Promise<number> {
  const parsed = parsePairCommand(argv);
  if (parsed.action === "offer") return pairOffer(deps, parsed.hub);
  if (parsed.action === "list") return pairList(deps, parsed.hub, parsed.watch);
  if (parsed.action === "approve") return pairApprove(deps, parsed.target, parsed.hub);
  if (parsed.action === "revoke") return pairRevoke(deps, parsed.target, parsed.hub);
  return pairThisDevice({ target: parsed.target, hub: parsed.hub, force: parsed.force }, deps);
}

interface HubDevice {
  id: string;
  name: string;
  status?: string;
  transport?: string;
  deviceUid?: string;
}

/** `dpi devices [--watch]` — the paired machines and their live status. */
export async function listDevices(deps: PairCliDeps = {}, hubArg?: string, watch = false): Promise<number> {
  const { env, fetch: f, print, sleep } = io(deps);
  const hub = hubTarget(env, deps.hubHome);
  const origin = hubArg ?? hub.origin;
  if (!origin) return print("devices needs --hub <origin> (or DPI_HUB_URL)"), 1;
  if (!hub.token) return print("devices needs the hub admin token (DPI_ADMIN_TOKEN or the hub's admin.token)"), 1;
  let previous = "";
  for (;;) {
    let devices: HubDevice[];
    try {
      const net = await jsonOrThrow(
        await f(`${origin}/api/network`, { headers: { authorization: `Bearer ${hub.token}` } }),
        "list devices",
      );
      devices = (net.devices ?? []) as HubDevice[];
    } catch (error) {
      print(`devices failed: ${(error as Error).message}`);
      return 1;
    }
    const key = devices.map((d) => `${d.id}:${d.status ?? ""}`).join("|");
    if (!watch || key !== previous) {
      previous = key;
      if (!devices.length) print(`no devices on ${origin}`);
      for (const d of devices)
        print(`  ${(d.status ?? "?").padEnd(9)} ${d.name}  ·  ${d.transport ?? "?"}  ·  ${d.id}`);
    }
    if (!watch) return 0;
    await sleep(watchPoll(deps));
  }
}

export const PAIR_USAGE = `dpi pair — pairing from the CLI (no browser needed)

  dpi pair <code|pairUrl|offerLink> [--hub <origin>] [--force]
      pair THIS machine (runs on the device; needs the local dpi device)
  dpi pair --hub <origin>
      this machine asks the hub itself and prints its identity; approve on the
      hub (web or \`dpi pair approve\`) — nothing is copied between machines
  dpi pair offer [--hub <origin>]
      operator: mint an offer link for a new machine (paste it there)
  dpi pair list [--hub <origin>]
      operator: machines waiting for approval, with hostname/platform/fingerprint
  dpi pair approve <name|codeId> [--hub <origin>]
      operator: approve that machine
  dpi pair revoke <name|deviceId> [--hub <origin>]
      operator: revoke a paired machine's credential

Hub admin token: DPI_ADMIN_TOKEN, or the hub's admin.token (DPI_HOME).
Device token:    DPI_TOKEN, or the device's backend.env (DPI_HOME).
`;
