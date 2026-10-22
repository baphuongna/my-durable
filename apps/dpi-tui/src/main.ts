// dpi-tui: a pi-like terminal client for one Durable Agent Network device.
//   dpi-tui                                        the app; welcome screen when nothing to connect to,
//                                                  the single saved device when there is exactly one
//   dpi-tui <device>[:<session>[:<agent>]]        device from ~/.dpi/network.sqlite (seeded from dpi-network.yaml)
//   dpi-tui --url <url> --token <token> [--save <id>]
//   dpi-tui mac-mini --new triage                 create a session (in the device's first start dir) and attach
import { parseArgs } from "node:util";
import { DpiClient } from "../../dpi-sdk/src/client.ts";
import type { DeviceInfo } from "../../dpi-sdk/src/api.ts";
import { isDpiError } from "../../dpi-sdk/src/errors.ts";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.ts";
import { syncConfigToRegistry, tryLoadNetworkConfig } from "../../dpi-sdk/src/node/config.ts";
import { App, type DeviceRef } from "./app.ts";
import { pickDevice } from "./pickers.ts";
import { emptyDeviceInfo, resolveStartupAction, showWelcome, WELCOME_DEVICE } from "./welcome.ts";

const USAGE = `usage: dpi-tui [device[:session[:agent]]] [options]
       dpi-tui --url <url> --token <token> [--save <id>]
       dpi-tui                 no arguments: the app opens (welcome screen when no
                               device is saved; the one saved device when there is one)

  -s, --session <ref>   session id or name (else a picker opens)
  -a, --agent <ref>     agent id, "main" or name (default: the session's root agent)
  --new <name>          create a session on the device and attach
  --cwd <dir>           working directory on the device for --new (absolute, or relative to its first start dir)
  --model <id>          model for --new (default: the device's default)
  --pair <CODE|URL>     pair THIS device's local backend with a hub before the UI opens
  --hub <origin>        hub origin for --pair (else the code's pair URL)
  --force               with --pair: switch hubs even if already paired
  --url, --token        connect to any dpi-backend directly (also DPI_URL, DPI_TOKEN)
  --save <id>           store a --url device in ~/.dpi/network.sqlite under <id>`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    save: { type: "string" },
    session: { type: "string", short: "s" },
    agent: { type: "string", short: "a" },
    new: { type: "string" },
    cwd: { type: "string" },
    model: { type: "string" },
    pair: { type: "string" },
    hub: { type: "string" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const registry = new NetworkRegistry();
const config = tryLoadNetworkConfig(process.env.INIT_CWD ?? process.cwd());
if (config) syncConfigToRegistry(config, registry);

const url = values.url ?? process.env.DPI_URL;
const [deviceRef = "", sessionRef = values.session, agentRef = values.agent] = (
  positionals[0] ?? (url ? "" : (process.env.DPI_DEVICE ?? ""))
).split(":");

/** The shared tail of every path that has a device: --save, --new, the App, --pair, open. */
async function start(device: DeviceRef, client: DpiClient, info: DeviceInfo, opts: { devicePicker?: boolean } = {}) {
  if (values.save && url)
    registry.upsert({ id: values.save, name: values.save, url: device.url, kind: "url", source: "ui", token: device.token });

  let session = sessionRef;
  if (values.new) {
    const cwd = values.cwd ?? (await client.dirs("")).dirs[0]?.path;
    if (!cwd) fail(`${device.id} has no start dirs; pass --cwd`);
    const modelId = values.model ?? info.defaultModel;
    const model = info.models.find((m) => m.id === modelId);
    if (!model) fail(`Unknown model ${modelId}. Available: ${info.models.map((m) => m.id).join(", ")}`);
    const created = await client
      .createSession({ name: values.new, cwd, model: { provider: model.provider, modelId: model.id } })
      .catch((e: Error) => fail(`Could not create the session: ${e.message}`));
    session = created.id;
  }

  const app = new App(device, client, info, registry);

  // Bootstrap local pairing (--pair CODE --hub ORIGIN [--force]): runs the same
  // controller as /pair, against the LOCAL backend, before the UI opens. A bare
  // --pair without a value points at the slash command instead of guessing.
  if (values.pair !== undefined || values.hub !== undefined) {
    const { runPairing, parsePairArgs, LocalPairing } = await import("./pairing.ts");
    if (!values.pair) {
      process.stdout.write("--pair needs the code from the hub wizard (or its pair URL).\nInside dpi-tui, run: /pair <CODE> --hub <origin>\n");
      process.exit(1);
    }
    try {
      LocalPairing.fromEnv();
    } catch (e) {
      fail((e as Error).message);
    }
    await app.open(session, agentRef);
    await runPairing(app, parsePairArgs([values.pair, ...(values.hub ? ["--hub", values.hub] : []), ...(values.force ? ["--force"] : [])].join(" ")));
    return;
  }
  await app.open(session, agentRef);
  if (opts.devicePicker) pickDevice(app);
}

// The app opens first; connection is a state, not a precondition. With no explicit
// device/url/pair: one saved device opens it directly, several open on the first
// with the device picker on top, none open the welcome screen.
const startup = resolveStartupAction({ devices: registry.list(), env: process.env, args: { deviceRef, url, pair: values.pair } });

if (startup.kind === "welcome") {
  showWelcome(new App(WELCOME_DEVICE, new DpiClient(WELCOME_DEVICE.url, WELCOME_DEVICE.token), emptyDeviceInfo(), registry));
} else if (startup.kind === "auto-open" || startup.kind === "picker") {
  const row = startup.kind === "auto-open" ? startup.device : startup.devices[0]!;
  const device: DeviceRef = { id: row.id, name: row.name, url: row.url!, token: row.token! };
  const client = new DpiClient(device.url, device.token);
  try {
    const info = await client.device({ timeoutMs: 8000 });
    await start(device, client, info, { devicePicker: startup.kind === "picker" });
  } catch (e) {
    // An auto-connected device that is unreachable falls back to a screen that says
    // so and offers the picker + welcome actions — never back to usage text.
    showWelcome(new App(WELCOME_DEVICE, new DpiClient(WELCOME_DEVICE.url, WELCOME_DEVICE.token), emptyDeviceInfo(), registry), {
      notice:
        isDpiError(e) && e.code === "unauthorized"
          ? `${device.id}: token rejected by ${device.url}`
          : `${device.id} is offline at ${device.url} (${(e as Error).message})`,
    });
  }
} else if (url) {
  const token = values.token ?? process.env.DPI_TOKEN ?? "";
  if (!token) fail("--url needs --token (or DPI_TOKEN)");
  const device: DeviceRef = { id: values.save ?? "adhoc", name: values.save ?? new URL(url).host, url: url.replace(/\/+$/, ""), token };
  const client = new DpiClient(device.url, device.token);
  const info = await client.device({ timeoutMs: 8000 }).catch((e: unknown) =>
    fail(
      isDpiError(e) && e.code === "unauthorized"
        ? `${device.id}: token rejected by ${device.url}`
        : `${device.id} is offline at ${device.url} (${(e as Error).message})`,
    ),
  );
  await start(device, client, info);
} else {
  const known = registry.list().map((d) => d.id);
  if (!deviceRef && (values.pair !== undefined || values.hub !== undefined)) {
    // Fresh-install flow: an explicit --pair (a pasted code, pair URL or offer link IS
    // the whole configuration) must never die on usage text — pair this machine's LOCAL
    // backend first, then the app opens on it. Mirrors the welcome screen's [p] action.
    const { applyBackendEnv } = await import("./welcome.ts");
    applyBackendEnv();
    const { LocalPairing } = await import("./pairing.ts");
    try {
      LocalPairing.fromEnv();
    } catch (e) {
      fail((e as Error).message);
    }
    const port = Number(process.env.DPI_PORT ?? "4780");
    const url = `http://127.0.0.1:${port}`;
    const device: DeviceRef = { id: "local", name: "This machine", url, token: process.env.DPI_TOKEN ?? "" };
    const client = new DpiClient(url, device.token);
    const info = await client.device({ timeoutMs: 8000 }).catch((e: unknown) =>
      fail(`no local dpi-backend on ${url} — start one with: dpi device (${(e as Error).message})`),
    );
    await start(device, client, info);
  } else if (!deviceRef) fail(`${USAGE}\n\nKnown devices: ${known.join(", ") || "none"}`);
  const row = registry.get(deviceRef);
  if (!row) fail(`Unknown device "${deviceRef}". Known: ${known.join(", ") || "none (add one to dpi-network.yaml)"}`);
  if (!row.token) fail(`No token for ${row.id}. Run: just net register ${row.id}`);
  if (!row.url)
    fail(`Device ${row.id} is paired over the tunnel — it has no LAN URL. Attach through the hub web UI, or pair this machine directly.`);
  const device: DeviceRef = { id: row.id, name: row.name, url: row.url, token: row.token };
  const client = new DpiClient(device.url, device.token);
  const info = await client.device({ timeoutMs: 8000 }).catch((e: unknown) =>
    fail(
      isDpiError(e) && e.code === "unauthorized"
        ? `${device.id}: token rejected by ${device.url}`
        : `${device.id} is offline at ${device.url} (${(e as Error).message})`,
    ),
  );
  await start(device, client, info);
}
