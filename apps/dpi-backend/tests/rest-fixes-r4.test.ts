/**
 * Round-4 REST audit fixes: start-dir containment for session/schedule
 * creation (the /etc repro), the Idempotency-Key create race, the
 * DELETE /device/env managed-key bypass, the notify-sink private-host grant
 * surviving patches, hostile pi-auth provider ids, case-sensitive device
 * routing, and rename bounds/control characters.
 *
 * Same in-process pattern as rest-edge.test.ts: a real Store (faux provider,
 * temp start dirs) behind the real router + error middleware.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { errorMiddleware } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import { EnvFileEditor } from "../src/env-vars.js";
import { NotifySinks } from "../src/notify-sinks.js";
import { faux, newToken, tempStore } from "./helpers.js";

async function backend() {
  const t = await tempStore();
  const token = newToken();
  const store = await Store.open(t.options);
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use("/v1", bearerAuth(token), express.json({ limit: "256kb" }), v1(store));
  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
  app.use(errorMiddleware);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close().catch(() => {});
    await t.cleanup();
  };
  return { t, store, api, close };
}

const errorOf = async (res: Response) => {
  assert.equal(res.headers.get("content-type") ?? "", "application/json; charset=utf-8", "errors are JSON");
  return (await res.json()).error as { code: string; message: string };
};

// ------------------------------------------------------------------ finding 1

test("session create is contained to the start dirs (the /etc repro)", async () => {
  const b = await backend();
  try {
    // The audit's exact repro: an absolute cwd used to override the first
    // start dir base and root a session outside the sandbox.
    const escape = await b.api("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ name: "Escape", cwd: "/etc", model: faux }),
    });
    assert.equal(escape.status, 400);
    const error = await errorOf(escape);
    assert.equal(error.code, "invalid");
    assert.match(error.message, /must live under a start dir/);
    assert.ok(error.message.includes(b.t.work), "the message names the allowed root");

    // The same rule at the store (the choke point schedule runs also go through).
    await assert.rejects(() => b.store.create({ name: "X", cwd: "/etc", model: faux }), /must live under a start dir/);
    await assert.rejects(() => b.store.create({ name: "X", cwd: tmpdir(), model: faux }), /must live under a start dir/);

    // Contained cwds keep working, absolute and relative.
    const atRoot = await b.api("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ name: "Root", cwd: b.t.work, model: faux }),
    });
    assert.equal(atRoot.status, 201);
    const nested = await b.api("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ name: "Nested", cwd: "project/nested", model: faux }),
    });
    assert.equal(nested.status, 201);

    // A session whose cwd is outside is NOT retroactively broken: read paths
    // never re-check containment (pre-rule sessions must stay visible).
    const created = (await atRoot.json()) as { id: string };
    b.store.catalog.prepare("UPDATE sessions SET cwd='/etc' WHERE id=?").run(created.id);
    const reread = await b.api(`/v1/sessions/${created.id}`);
    assert.equal(reread.status, 200);
    assert.equal(((await reread.json()) as { cwd: string }).cwd, "/etc");
  } finally {
    await b.close();
  }
});

test("schedule create/patch are contained before the record is stored", async () => {
  const b = await backend();
  try {
    const body = (cwd: unknown) =>
      JSON.stringify({ name: "Escape", cwd, model: faux, prompt: "go", everyMinutes: 60 });
    const post = await b.api("/v1/schedules", { method: "POST", body: body("/etc") });
    assert.equal(post.status, 400);
    const error = await errorOf(post);
    assert.equal(error.code, "invalid");
    assert.match(error.message, /must live under a start dir/);
    assert.ok(error.message.includes(b.t.work), "the message names the allowed root");

    // A contained schedule still saves (relative resolves against the first start dir).
    const ok = await b.api("/v1/schedules", { method: "POST", body: body("project") });
    assert.equal(ok.status, 201);
    const id = ((await ok.json()) as { id: string }).id;

    // A patch repointing the schedule at /etc is refused the same way.
    const patched = await b.api(`/v1/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ cwd: "/etc" }) });
    assert.equal(patched.status, 400);
    assert.match((await errorOf(patched)).message, /must live under a start dir/);
  } finally {
    await b.close();
  }
});

// ------------------------------------------------------------------ finding 2

test("concurrent identical creates with one Idempotency-Key make exactly one session", async () => {
  const b = await backend();
  try {
    const key = `r4-race-${Date.now()}`;
    const body = JSON.stringify({ name: "Idem", cwd: "project", model: faux });
    const fire = () => b.api("/v1/sessions", { method: "POST", body, headers: { "idempotency-key": key } });
    const responses = await Promise.all(Array.from({ length: 6 }, fire));
    const payloads = (await Promise.all(responses.map((r) => r.json()))) as Array<{ id: string }>;

    assert.equal(new Set(payloads.map((p) => p.id)).size, 1, "all responses share one session id");
    for (const r of responses) assert.equal(r.status, 201);
    const replays = responses.filter((r) => r.headers.get("idempotent-replay") === "true").length;
    assert.ok(replays >= 5, `expected ≥5 replay headers, got ${replays}`);

    // After the flight settles, the stored row answers a later request too.
    const later = await fire();
    assert.equal(later.status, 201);
    assert.equal(later.headers.get("idempotent-replay"), "true");
    assert.equal(((await later.json()) as { id: string }).id, payloads[0]!.id);

    // And the device really holds one session, not six.
    const list = (await (await b.api("/v1/sessions")).json()) as Array<{ id: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, payloads[0]!.id);
  } finally {
    await b.close();
  }
});

// ------------------------------------------------------------------ finding 3

test("DELETE /device/env refuses managed keys and leaves the line in place", async () => {
  const b = await backend();
  const envPath = join(b.t.root, "backend.env");
  writeFileSync(envPath, "DPI_TOKEN=dpi_secret_line_here\nMY_KEY=1\n");
  try {
    const refused = await b.api("/v1/device/env/DPI_TOKEN", { method: "DELETE" });
    assert.equal(refused.status, 400);
    const error = await errorOf(refused);
    assert.equal(error.code, "invalid");
    assert.match(error.message, /has its own setting/);
    assert.ok(readFileSync(envPath, "utf8").includes("DPI_TOKEN=dpi_secret_line_here"), "managed line survives");

    // Non-managed keys still unset normally — the guard is not a blanket block.
    const removed = await b.api("/v1/device/env/MY_KEY", { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
    assert.ok(!readFileSync(envPath, "utf8").includes("MY_KEY"));

    // The unit behind the route carries the same rule.
    const editor = new EnvFileEditor(envPath);
    await assert.rejects(() => editor.unset("DPI_PORT"), /has its own setting/);
    assert.ok(readFileSync(envPath, "utf8").includes("DPI_TOKEN"), "editor-level refusal wrote nothing");
  } finally {
    await b.close();
  }
});

// ------------------------------------------------------------------ finding 4

test("a notify sink keeps its private-host grant across patches", async () => {
  const b = await backend();
  const hadEnv = process.env.DPI_NOTIFY_ALLOW_PRIVATE;
  delete process.env.DPI_NOTIFY_ALLOW_PRIVATE;
  try {
    const created = await b.api("/v1/notify/sinks", {
      method: "POST",
      body: JSON.stringify({ kind: "webhook", url: "http://127.0.0.1:9/hook", allowPrivateHosts: true }),
    });
    assert.equal(created.status, 201);
    const sink = (await created.json()) as { id: string; allowPrivateHosts?: boolean };
    assert.equal(sink.allowPrivateHosts, true, "the grant is persisted on the record");

    // The finding's repro: a patch that does not even touch the url used to
    // 400 because the flag was per-request only.
    assert.equal((await b.api(`/v1/notify/sinks/${sink.id}`, { method: "PATCH", body: JSON.stringify({ label: "x" }) })).status, 200);
    assert.equal((await b.api(`/v1/notify/sinks/${sink.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status, 200);

    // A NEW url still needs a fresh opt-in (or the env default) — the record
    // flag is not a skeleton key for future hosts.
    const newHost = await b.api(`/v1/notify/sinks/${sink.id}`, {
      method: "PATCH",
      body: JSON.stringify({ url: "http://10.0.0.1/x" }),
    });
    assert.equal(newHost.status, 400);
    assert.match((await errorOf(newHost)).message, /local\/private/);
    const granted = await b.api(`/v1/notify/sinks/${sink.id}`, {
      method: "PATCH",
      body: JSON.stringify({ url: "http://10.0.0.2/x", allowPrivateHosts: true }),
    });
    assert.equal(granted.status, 200);
    assert.equal(((await granted.json()) as { allowPrivateHosts?: boolean }).allowPrivateHosts, true);

    // Scalar fields are validated BEFORE the url, so the error names the field
    // a caller can fix without re-deciding the url.
    const scalarFirst = await b.api("/v1/notify/sinks", {
      method: "POST",
      body: JSON.stringify({ kind: "webhook", url: "http://10.9.9.9/x", label: "x".repeat(61) }),
    });
    assert.equal(scalarFirst.status, 400);
    const scalarError = (await scalarFirst.json()).error as { message: string };
    assert.match(scalarError.message, /label/, "label error wins over the url error");
  } finally {
    if (hadEnv !== undefined) process.env.DPI_NOTIFY_ALLOW_PRIVATE = hadEnv;
    await b.close();
  }
});

test("the private-host grant survives a registry round-trip", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "r4-sink-")), "notify.json");
  try {
    const first = await NotifySinks.open(file);
    await first.create({ kind: "webhook", url: "http://127.0.0.1:9/hook" }, { allowPrivateHosts: true });
    const second = await NotifySinks.open(file);
    const record = second.list()[0]!;
    assert.equal(record.allowPrivateHosts, true, "the flag is part of the stored record");
    // Revalidating the SAME url on a patch succeeds without any per-request flag.
    const patched = await second.update(record.id, { label: "lan" });
    assert.equal(patched.label, "lan");
    // …while a new host still needs the opt-in.
    await assert.rejects(() => second.update(record.id, { url: "http://10.0.0.3/x" }), /local\/private/);
  } finally {
    rmSync(file, { force: true });
    rmSync(`${file}.bak`, { force: true });
  }
});

// ------------------------------------------------------------------ finding 5

test("hostile pi-auth provider ids answer 400 without a stack or a file write", async () => {
  const b = await backend();
  const piDir = mkdtempSync(join(tmpdir(), "r4-pi-"));
  const previous = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = piDir;
  try {
    // (%2e%2e%2f decodes to ../ inside the segment; a dots-only `..` segment is
    // collapsed by every HTTP client before the server sees it, so the wire
    // form is the encoded-slash one.)
    for (const id of ["%2e%2e%2f%2e%2e%2fetc", "my%20provider", "%C3%A9lan", "openrouter%2Ffallback%2Fescape"]) {
      const res = await b.api(`/v1/device/pi-auth/${id}`, { method: "PUT", body: JSON.stringify({ key: "sk-1234567890" }) });
      assert.equal(res.status, 400, `provider id ${id} must be a 400`);
      const raw = JSON.stringify(await res.json());
      const error = JSON.parse(raw).error as { code: string; message: string };
      assert.equal(error.code, "invalid");
      assert.match(error.message, /invalid provider id/);
      assert.ok(!raw.includes("stack"), "no stack in the response");
    }
    assert.ok(!existsSync(join(piDir, "auth.json")), "no file written for a hostile id");

    // A legal id still works.
    const ok = await b.api("/v1/device/pi-auth/lan-provider", { method: "PUT", body: JSON.stringify({ key: "sk-1234567890" }) });
    assert.equal(ok.status, 200);
    assert.ok(existsSync(join(piDir, "auth.json")));
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previous;
    rmSync(piDir, { recursive: true, force: true });
    await b.close();
  }
});

// ------------------------------------------------------------------ finding 6

test("device-local routes match case-sensitively", async () => {
  const b = await backend();
  try {
    const upper = await b.api("/V1/DEVICE");
    assert.equal(upper.status, 404, "/V1/DEVICE must not be served");
    const mixed = await b.api("/v1/DEVICE");
    assert.equal(mixed.status, 404);
    const lower = await b.api("/v1/device");
    assert.equal(lower.status, 200, "lowercase paths keep working");
  } finally {
    await b.close();
  }
});

// ------------------------------------------------------------------ finding 7

test("session rename is bounded and refuses control characters", async () => {
  const b = await backend();
  try {
    const created = await b.api("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ name: "Rename me", cwd: "project", model: faux }),
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    const rename = (name: string) => b.api(`/v1/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });

    const tooLong = await rename("x".repeat(10_000));
    assert.equal(tooLong.status, 400);
    assert.match((await errorOf(tooLong)).message, /the limit is 80/);
    const eightyOne = await rename("x".repeat(81));
    assert.equal(eightyOne.status, 400);

    const newline = await rename("line1\nline2");
    assert.equal(newline.status, 400);
    assert.match((await errorOf(newline)).message, /control characters/);
    const nul = await rename("a\u0000b");
    assert.equal(nul.status, 400, "NUL is rejected, not silently truncated");
    const del = await rename("a\u007fb");
    assert.equal(del.status, 400);

    const cap = await rename("y".repeat(80));
    assert.equal(cap.status, 200);
    assert.equal(((await cap.json()) as { name: string }).name, "y".repeat(80));
  } finally {
    await b.close();
  }
});
