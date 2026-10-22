/** Verification demo: mint on a fixture hub → show both links → decode the fragment. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { PairingService } from "../apps/dpi-playground-hub/src/pairing.js";
import { parsePairOfferUrl } from "../../dpi-sdk/src/protocol/pairing.js";

const dir = await mkdtemp(join(tmpdir(), "dpi-demo-"));
const registry = new NetworkRegistry(join(dir, "network.sqlite"));
const service = new PairingService({
  registry,
  audit: new Audit(registry),
  hubOrigin: "https://my-durable.phuongnb.io.vn",
  hubId: "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d",
  now: () => 1760000000000,
});
const minted = service.createCode("10.0.0.1");
if (!minted.ok) throw new Error("mint failed");
const v1 = minted.value.pairUrl;
const v2 = minted.value.offerUrl!;
console.log("pairUrl  (v1):", v1);
console.log("offerUrl (v2):", v2);
const parsed = parsePairOfferUrl(v2, 1760000000000);
if (!parsed) throw new Error("fragment did not decode");
console.log("offer JSON   :", JSON.stringify(parsed.offer));
await rm(dir, { recursive: true, force: true });
