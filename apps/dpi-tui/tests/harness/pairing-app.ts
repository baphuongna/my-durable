// Real App/terminal, with only its local pairing HTTP peer controlled by the test.
import { readFileSync } from "node:fs";
import { App } from "../../src/app.ts";
import { runPairing } from "../../src/pairing.ts";
import { DpiClient } from "../../../dpi-sdk/src/client.ts";
import type { DeviceInfo } from "../../../dpi-sdk/src/api.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.env.DPI_TOKEN = config.token;
process.env.DPI_PORT = String(config.port);
const info: DeviceInfo = {
  uid: "fixture-uid", name: "Fixture", hostname: "fixture", platform: "linux",
  apiVersion: 1, durableVersion: "fixture", startedAt: Date.now(), startDirs: [],
  models: [], defaultModel: "", capabilities: [],
  storage: { dataDir: "fixture", catalogPath: "fixture", appStatePath: "fixture" },
};
const app = new App({ id: "pair-fixture", name: "Fixture", url: "http://127.0.0.1:9", token: config.token },
  new DpiClient("http://127.0.0.1:9", config.token), info);
void runPairing(app, { code: "ABCD2345", hub: "https://fixture.invalid" });
