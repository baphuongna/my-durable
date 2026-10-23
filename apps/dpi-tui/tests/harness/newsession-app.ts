// Real App/terminal driven against a REAL device backend — the Windows
// configuration: provider default, no provider key, EMPTY model catalog.
import { readFileSync } from "node:fs";
import { App } from "../../src/app.ts";
import { DpiClient } from "../../../dpi-sdk/src/client.ts";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const client = new DpiClient(cfg.url, cfg.token);
const info = await client.device();
const app = new App({ id: cfg.id, name: cfg.name, url: cfg.url, token: cfg.token }, client, info);
// App owns its timers/terminal; nothing else to keep alive.
export { app };
