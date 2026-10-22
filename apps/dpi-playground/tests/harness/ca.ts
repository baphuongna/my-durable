/**
 * Test CA: a real local certificate authority + server leaf, generated with
 * openssl into a per-test temp dir. The CA is trusted by Node test clients
 * (custom https agent) and can be imported into browser NSS profiles by the
 * Playwright harness. No insecure TLS overrides anywhere.
 *
 * Leaf SANs: DNS:hub.local.test + IP:127.0.0.1 — connecting to
 * https://localhost:<port> must FAIL hostname validation (negative case).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface TestCa {
  dir: string;
  caCert: Buffer;
  caKey: Buffer;
  cert: Buffer;
  key: Buffer;
  cleanup: () => Promise<void>;
}

const openssl = (args: string[]) => run("openssl", args, { timeout: 15_000 });

export async function makeTestCa(): Promise<TestCa> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-ca-"));
  const caKey = join(dir, "ca.key");
  const caCrt = join(dir, "ca.crt");
  const leafKey = join(dir, "hub.key");
  const leafCsr = join(dir, "hub.csr");
  const leafCrt = join(dir, "hub.crt");

  await openssl([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCrt,
    "-days",
    "2",
    "-subj",
    "/CN=DPI Test Root CA (fixtures only)",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);

  await openssl([
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    leafKey,
    "-out",
    leafCsr,
    "-subj",
    "/CN=hub.local.test",
  ]);

  const extFile = join(dir, "hub.ext");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    extFile,
    [
      "subjectAltName=DNS:hub.local.test,IP:127.0.0.1",
      "extendedKeyUsage=serverAuth",
      "keyUsage=digitalSignature,keyEncipherment",
      "basicConstraints=CA:FALSE",
    ].join("\n"),
  );

  await openssl([
    "x509",
    "-req",
    "-in",
    leafCsr,
    "-CA",
    caCrt,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    leafCrt,
    "-days",
    "2",
    "-extfile",
    extFile,
  ]);

  return {
    dir,
    caCert: await readFile(caCrt),
    caKey: await readFile(caKey),
    cert: await readFile(leafCrt),
    key: await readFile(leafKey),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Trusted https agent factory for Node test clients (replaces no-rejectUnauthorized hacks). */
export async function trustedAgent(ca: TestCa) {
  const { Agent } = await import("node:https");
  const { readFileSync } = await import("node:fs");
  return new Agent({ ca: readFileSync(join(ca.dir, "ca.crt")) });
}

/** Import the test CA into a Chromium NSS profile so browsers trust it for real. */
export async function trustCaInBrowserProfile(profileDir: string, ca: TestCa): Promise<void> {
  const caPath = join(ca.dir, "ca.crt");
  await run("certutil", ["-N", "-d", `sql:${profileDir}`, "--empty-password"], { timeout: 15_000 });
  await run(
    "certutil",
    ["-A", "-d", `sql:${profileDir}`, "-t", "C,,", "-n", "DPI Test Root CA", "-i", caPath],
    { timeout: 15_000 },
  );
}
