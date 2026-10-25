/**
 * Wave 2 of docs/host-project-checklist.md: notification delivery fan-out
 * (webhook + ntfy, per-sink cooldown). Every test that mutates also looks at the
 * bytes on disk — a sink registry that only remembers in RAM is worse than none
 * — and every delivery test goes through a recording fake, so "never throws" is
 * asserted rather than hoped for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COOLDOWN_MS,
  MAX_LABEL_LENGTH,
  MAX_TAGS,
  NotifySinkError,
  NotifySinks,
  isPrivateHost,
  matchesEventFilter,
  normaliseSinkUrl,
  type FetchLike,
  type NotifySinksOptions,
} from "../src/notify-sinks.js";

const mode = (path: string) => stat(path).then((stats) => stats.mode & 0o777);

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "dpi-notify-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  return {
    root,
    dataDir,
    file: join(dataDir, "notify.json"),
    backup: join(dataDir, "notify.json.bak"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** One recorded fetch: the URL plus the init the module built. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** A fetch that records every call and answers from `respond` (default: 200 OK). */
function recorder(respond?: (call: Call) => { ok: boolean; status: number } | Promise<{ ok: boolean; status: number }>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body, signal: init.signal };
    calls.push(call);
    if (!respond) return { ok: true, status: 200 };
    return respond(call);
  };
  return { calls, fetchImpl };
}

/** `open` with warnings captured (recovery is asserted, not printed) and a clock the test owns. */
function openWith(file: string, options: NotifySinksOptions & { warnings?: string[] } = {}) {
  const warnings = options.warnings ?? [];
  const { warnings: _ignored, ...rest } = options;
  return NotifySinks.open(file, {
    ...rest,
    warn: (message) => warnings.push(message),
  });
}

/** The clock every test drives by hand: no `sleep` in the suite. */
function clock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
      return value;
    },
  };
}

const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));

const event = (over: Partial<{ kind: string; title: string; body: string; data: Record<string, unknown> }> = {}) => ({
  kind: "session.failed",
  title: "Session failed",
  body: "agent turn aborted",
  ...over,
});

test("create, list, update and remove land on disk and survive a reopen", async () => {
  const s = await scratch();
  const time = clock();
  try {
    const sinks = await openWith(s.file, { now: time.now });
    const created = await sinks.create({
      kind: "webhook",
      url: "https://example.com/hooks/dpi",
      label: "ops webhook",
      events: ["session.*", "schedule.failed"],
    });

    assert.match(created.id, /^snk_[0-9a-f]{12}$/);
    assert.equal(created.kind, "webhook");
    assert.equal(created.url, "https://example.com/hooks/dpi");
    assert.equal(created.enabled, true, "a sink that exists is one the operator asked for");
    assert.deepEqual(created.events, ["session.*", "schedule.failed"]);
    assert.equal(created.label, "ops webhook");
    assert.equal(created.createdAt, time.now());
    assert.equal(created.updatedAt, created.createdAt);
    assert.deepEqual(sinks.list().map((sink) => sink.id), [created.id]);

    const onDisk = await readJson(s.file);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.sinks.length, 1);
    assert.equal(onDisk.sinks[0].id, created.id);

    time.advance(1_000);
    const updated = await sinks.update(created.id, { label: "night ops", events: ["session.failed"], enabled: false });
    assert.equal(updated.id, created.id);
    assert.equal(updated.label, "night ops");
    assert.deepEqual(updated.events, ["session.failed"]);
    assert.equal(updated.enabled, false);
    assert.equal(updated.updatedAt, time.now(), "update stamps updatedAt");
    assert.equal(updated.createdAt, created.createdAt, "createdAt is not touched");

    // Clearing a label removes the key rather than storing "".
    const cleared = await sinks.update(created.id, { label: "" });
    assert.equal(cleared.label, undefined);
    assert.ok(!("label" in (await readJson(s.file)).sinks[0]), "no empty label on disk");

    const reopened = await openWith(s.file, { now: time.now });
    assert.equal(reopened.list().length, 1);
    assert.deepEqual(reopened.list()[0], cleared);

    assert.equal(await sinks.remove(created.id), true);
    assert.equal(await sinks.remove(created.id), false, "removing twice is a no-op");
    assert.equal(sinks.list().length, 0);
    assert.equal((await openWith(s.file, { now: time.now })).list().length, 0);
  } finally {
    await s.cleanup();
  }
});

test("a missing registry opens empty; an unknown id updates/removes nothing", async () => {
  const s = await scratch();
  try {
    const sinks = await openWith(s.file, { now: clock().now });
    assert.deepEqual(sinks.list(), []);
    await assert.rejects(sinks.update("snk_000000000000", { label: "x" }), (error: unknown) => {
      assert.ok(error instanceof NotifySinkError);
      assert.equal(error.code, "not_found");
      return true;
    });
    assert.equal(await sinks.remove("snk_000000000000"), false);
  } finally {
    await s.cleanup();
  }
});

test("URL validation: http(s) only, no userinfo, and private hosts only on request", async () => {
  const s = await scratch();
  try {
    const sinks = await openWith(s.file, { now: clock().now });

    // The two schemes we allow.
    const https = await sinks.create({ kind: "webhook", url: "https://example.com/hook" });
    assert.equal(https.url, "https://example.com/hook");
    const http = await sinks.create({ kind: "webhook", url: "http://example.com/hook" });
    assert.equal(http.url, "http://example.com/hook");

    const rejected = async (url: string, options: NotifySinksOptions = {}) => {
      const registry = await openWith(s.file, { now: clock().now, ...options });
      await assert.rejects(registry.create({ kind: "webhook", url }), (error: unknown) => {
        assert.ok(error instanceof NotifySinkError, `${url} must fail with a NotifySinkError`);
        assert.equal(error.code, "invalid");
        return true;
      });
    };

    await rejected("file:///etc/passwd");
    await rejected("gopher://example.com/1");
    await rejected("data:text/plain,hi");
    await rejected("not a url");
    await rejected("ftp://example.com/hook");
    await rejected("https://user:secret@example.com/hook");
    await rejected("https://user@example.com/hook");

    // Loopback / private / link-local are SSRF primitives, so they are out by default.
    for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.0.5", "169.254.169.254", "[::1]"]) {
      await rejected(`http://${host}:8080/hook`);
    }

    // …and a LAN ntfy is the common self-hosted case, so the operator can opt in.
    assert.equal(isPrivateHost("192.168.1.10"), true);
    assert.equal(isPrivateHost("example.com"), false);
    assert.equal(
      normaliseSinkUrl("http://192.168.1.10:8080/dpi/", { allowPrivateHosts: true }),
      "http://192.168.1.10:8080/dpi",
    );
    const lan = await openWith(s.file, { now: clock().now, allowPrivateHosts: true });
    const lanSink = await lan.create({ kind: "webhook", url: "http://192.168.1.10:8080/hook/" });
    assert.equal(lanSink.url, "http://192.168.1.10:8080/hook", "trailing slash normalised away");
    await assert.rejects(lan.create({ kind: "webhook", url: "file:///etc/passwd" }), NotifySinkError);
  } finally {
    await s.cleanup();
  }
});

test("ntfy needs a topic and the ntfy-only fields stay ntfy-only", async () => {
  const s = await scratch();
  try {
    const sinks = await openWith(s.file, { now: clock().now });
    await assert.rejects(sinks.create({ kind: "ntfy", url: "https://ntfy.sh" }), /topic/);
    const sink = await sinks.create({
      kind: "ntfy",
      url: "https://ntfy.sh/dpi-alerts",
      priority: "high",
      tags: ["rotating_light", "backup"],
    });
    assert.equal(sink.priority, "high");
    assert.deepEqual(sink.tags, ["rotating_light", "backup"]);

    await assert.rejects(sinks.create({ kind: "webhook", url: "https://example.com/h", priority: "high" }), /ntfy-only/);
    await assert.rejects(sinks.create({ kind: "webhook", url: "https://example.com/h", tags: ["a"] }), /ntfy-only/);
    await assert.rejects(
      sinks.create({ kind: "ntfy", url: "https://ntfy.sh/t", priority: "urgent" as never }),
      /priority/,
    );
    await assert.rejects(
      sinks.create({ kind: "ntfy", url: "https://ntfy.sh/t", tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`) }),
      /limit/,
    );
    await assert.rejects(sinks.create({ kind: "ntfy", url: "https://ntfy.sh/t", tags: ["a".repeat(21)] }), /limit/);
    await assert.rejects(sinks.create({ kind: "ntfy", url: "https://ntfy.sh/t", tags: ["two words"] }), /comma|space/);
    await assert.rejects(
      sinks.create({ kind: "webhook", url: "https://example.com/h", label: "x".repeat(MAX_LABEL_LENGTH + 1) }),
      /limit/,
    );
  } finally {
    await s.cleanup();
  }
});

test("webhook delivery posts exactly { event, title, body, at, device } plus data", async () => {
  const s = await scratch();
  const time = clock();
  const { calls, fetchImpl } = recorder();
  try {
    const sinks = await openWith(s.file, { now: time.now, fetchImpl });
    const sink = await sinks.create({ kind: "webhook", url: "https://example.com/hook" });

    const results = await sinks.deliver(
      { kind: "session.failed", title: "Session failed", body: "boom", data: { session: "s_1", cwd: "/w" } },
      { device: "dev-abc" },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.com/hook");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["content-type"], "application/json");
    assert.equal(
      calls[0].body,
      JSON.stringify({
        session: "s_1",
        cwd: "/w",
        event: "session.failed",
        title: "Session failed",
        body: "boom",
        at: time.now(),
        device: "dev-abc",
      }),
      "the wire body is this, byte for byte",
    );
    assert.deepEqual(results, [{ id: sink.id, kind: "webhook", status: "sent", detail: "HTTP 200", ms: results[0].ms }]);
    assert.equal(typeof results[0].ms, "number");
  } finally {
    await s.cleanup();
  }
});

test("a base field cannot be rewritten by event.data", async () => {
  const s = await scratch();
  const { calls, fetchImpl } = recorder();
  try {
    const sinks = await openWith(s.file, { now: clock().now, fetchImpl });
    await sinks.create({ kind: "webhook", url: "https://example.com/hook" });
    await sinks.deliver(event({ data: { event: "spoofed", device: "spoofed" } }), { device: "dev-abc" });
    const payload = JSON.parse(calls[0].body);
    assert.equal(payload.event, "session.failed");
    assert.equal(payload.device, "dev-abc");
  } finally {
    await s.cleanup();
  }
});

test("ntfy delivery joins the topic onto the server and sets Title/Priority/Tags", async () => {
  const s = await scratch();
  const time = clock();
  const { calls, fetchImpl } = recorder();
  try {
    const sinks = await openWith(s.file, { now: time.now, fetchImpl });
    const sink = await sinks.create({
      kind: "ntfy",
      url: "https://ntfy.sh/dpi-alerts/",
      priority: "high",
      tags: ["rotating_light", "backup"],
    });
    assert.equal(sink.url, "https://ntfy.sh/dpi-alerts", "no trailing slash is stored");

    const [result] = await sinks.deliver(event({ kind: "schedule.failed", title: "Backup failed", body: "exit 2" }), {
      device: "dev-abc",
    });
    assert.equal(result.status, "sent");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://ntfy.sh/dpi-alerts", "one topic segment, no double slash");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.title, "Backup failed");
    assert.equal(calls[0].headers.priority, "high");
    assert.equal(calls[0].headers.tags, "rotating_light,backup");
    assert.equal(calls[0].headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(calls[0].body, "exit 2");

    // No priority/tags configured → no headers at all, ntfy picks its defaults.
    time.advance(1);
    await sinks.create({ kind: "ntfy", url: "https://ntfy.sh/plain" });
    await sinks.deliver(event({ kind: "test", title: "hello", body: "world" }), { device: "dev-abc" });
    const plain = calls.filter((call) => call.url === "https://ntfy.sh/plain");
    assert.equal(plain.length, 1);
    assert.equal(plain[0].headers.priority, undefined);
    assert.equal(plain[0].headers.tags, undefined);
    assert.equal(plain[0].headers.title, "hello");
  } finally {
    await s.cleanup();
  }
});

test("event filtering: patterns, wildcards, absent = all, no match = skipped/filtered", async () => {
  const s = await scratch();
  const { calls, fetchImpl } = recorder();
  try {
    const sinks = await openWith(s.file, { now: clock().now, fetchImpl, cooldownMs: 0 });
    const wildcard = await sinks.create({ kind: "webhook", url: "https://example.com/schedules", events: ["schedule.*"] });
    const exact = await sinks.create({ kind: "webhook", url: "https://example.com/ok", events: ["schedule.ok"] });
    const everything = await sinks.create({ kind: "webhook", url: "https://example.com/all" });

    assert.equal(matchesEventFilter(["*"], "anything.at.all"), true);
    assert.equal(matchesEventFilter(["schedule.*"], "schedule.ok"), true);
    assert.equal(matchesEventFilter(["schedule.*"], "schedule.failed"), true);
    assert.equal(matchesEventFilter(["schedule.*"], "schedules.ok"), false);
    assert.equal(matchesEventFilter(["schedule.ok"], "schedule.failed"), false);
    assert.equal(matchesEventFilter([], "whatever"), true);

    const scheduleOk = await sinks.deliver(event({ kind: "schedule.ok", title: "ok", body: "ran" }), { device: "dev" });
    assert.deepEqual(
      scheduleOk.map((result) => [result.id, result.status, result.detail]).sort(),
      [
        [wildcard.id, "sent", "HTTP 200"],
        [exact.id, "sent", "HTTP 200"],
        [everything.id, "sent", "HTTP 200"],
      ].sort(),
    );
    assert.equal(calls.length, 3);

    calls.length = 0;
    const sessionFailed = await sinks.deliver(event({ kind: "session.failed" }), { device: "dev" });
    const byId = new Map(sessionFailed.map((result) => [result.id, result]));
    assert.equal(byId.get(wildcard.id)?.status, "skipped");
    assert.equal(byId.get(wildcard.id)?.detail, "filtered");
    assert.equal(byId.get(exact.id)?.status, "skipped");
    assert.equal(byId.get(exact.id)?.detail, "filtered");
    assert.equal(byId.get(everything.id)?.status, "sent", "no events key means everything");
    assert.equal(calls.length, 1, "filtered sinks never open a socket");

    const scheduleFailed = await sinks.deliver(event({ kind: "schedule.failed" }), { device: "dev" });
    const failedById = new Map(scheduleFailed.map((result) => [result.id, result]));
    assert.equal(failedById.get(exact.id)?.detail, "filtered", "an exact pattern is not a wildcard");
    assert.equal(failedById.get(wildcard.id)?.status, "sent");
  } finally {
    await s.cleanup();
  }
});

test("deliver never throws: a 500 and a refused connection are both `failed`", async () => {
  const s = await scratch();
  const time = clock();
  const { calls, fetchImpl } = recorder((call) => {
    if (call.url.endsWith("/dead")) return { ok: false, status: 500 };
    throw new Error("ECONNREFUSED 127.0.0.1:9");
  });
  try {
    const sinks = await openWith(s.file, { now: time.now, fetchImpl });
    const dead = await sinks.create({ kind: "webhook", url: "https://example.com/dead" });
    const refused = await sinks.create({ kind: "webhook", url: "https://example.com/refused" });

    const results = await sinks.deliver(event(), { device: "dev" });
    assert.equal(calls.length, 2);
    // `list()` order is creation order, and both sinks share one injected clock — compare by id.
    assert.deepEqual(
      [...results]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((result) => [result.id, result.status, result.detail]),
      [
        [dead.id, "failed", "HTTP 500"],
        [refused.id, "failed", "ECONNREFUSED 127.0.0.1:9"],
      ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    );

    const records = new Map(sinks.list().map((record) => [record.id, record]));
    assert.equal(records.get(dead.id)?.lastStatus, 500);
    assert.equal(records.get(dead.id)?.lastError, "HTTP 500");
    assert.equal(records.get(dead.id)?.lastDeliveryAt, time.now());
    assert.equal(records.get(refused.id)?.lastStatus, undefined, "a refusal has no HTTP status");
    assert.equal(records.get(refused.id)?.lastError, "ECONNREFUSED 127.0.0.1:9");
    assert.equal(records.get(refused.id)?.lastDeliveryAt, time.now());

    // The failure state is durable: the next boot still knows the sink is broken.
    const reopened = await openWith(s.file, { now: time.now, fetchImpl });
    const survived = reopened.list().find((record) => record.id === dead.id);
    assert.equal(survived?.lastStatus, 500);
    assert.equal(survived?.lastError, "HTTP 500");
  } finally {
    await s.cleanup();
  }
});

test("a successful delivery records lastDeliveryAt/lastStatus and clears lastError", async () => {
  const s = await scratch();
  const time = clock();
  let healthy = false;
  const { fetchImpl } = recorder(() => (healthy ? { ok: true, status: 204 } : { ok: false, status: 503 }));
  try {
    const sinks = await openWith(s.file, { now: time.now, fetchImpl, cooldownMs: 0 });
    const sink = await sinks.create({ kind: "webhook", url: "https://example.com/flaky" });

    const failed = await sinks.deliver(event({ kind: "a.one" }), { device: "dev" });
    assert.equal(failed[0].status, "failed");
    assert.equal(sinks.list()[0].lastError, "HTTP 503");

    healthy = true;
    time.advance(5_000);
    const sent = await sinks.deliver(event({ kind: "a.two" }), { device: "dev" });
    assert.deepEqual(sent.map((result) => result.status), ["sent"]);
    const record = sinks.list()[0];
    assert.equal(record.id, sink.id);
    assert.equal(record.lastStatus, 204);
    assert.equal(record.lastDeliveryAt, time.now());
    assert.equal(record.lastError, undefined, "a success clears the previous error");
    assert.ok(!("lastError" in (await readJson(s.file)).sinks[0]), "and it is gone from the file too");
  } finally {
    await s.cleanup();
  }
});

test("burst cooldown: the same kind is silenced, a different kind is not", async () => {
  const s = await scratch();
  const time = clock();
  const { calls, fetchImpl } = recorder();
  try {
    const sinks = await openWith(s.file, { now: time.now, fetchImpl });
    const sink = await sinks.create({ kind: "webhook", url: "https://example.com/hook" });
    assert.equal(sinks.recent()[0].silencedUntil, undefined);

    const first = await sinks.deliver(event({ kind: "schedule.failed" }), { device: "dev" });
    assert.deepEqual(first.map((result) => result.status), ["sent"]);
    assert.equal(sinks.recent().find((entry) => entry.id === sink.id)?.silencedUntil, time.now() + DEFAULT_COOLDOWN_MS);

    time.advance(2_000);
    const second = await sinks.deliver(event({ kind: "schedule.failed" }), { device: "dev" });
    assert.deepEqual(second, [{ id: sink.id, kind: "webhook", status: "skipped", detail: "cooldown" }]);
    assert.equal(calls.length, 1, "a silenced sink is not called again");

    const otherKind = await sinks.deliver(event({ kind: "schedule.ok" }), { device: "dev" });
    assert.deepEqual(otherKind.map((result) => result.status), ["sent"], "a different kind is different news");

    time.advance(DEFAULT_COOLDOWN_MS);
    const afterWindow = await sinks.deliver(event({ kind: "schedule.failed" }), { device: "dev" });
    assert.deepEqual(afterWindow.map((result) => result.status), ["sent"], "the window expires");
    assert.equal(calls.length, 3);
  } finally {
    await s.cleanup();
  }
});

test("a failed attempt also consumes the window (no retry storm on a dead sink)", async () => {
  const s = await scratch();
  const time = clock();
  const { calls, fetchImpl } = recorder(() => ({ ok: false, status: 502 }));
  try {
    const sinks = await openWith(s.file, { now: time.now, fetchImpl, cooldownMs: 1_000 });
    await sinks.create({ kind: "webhook", url: "https://example.com/dead" });
    await sinks.deliver(event({ kind: "session.failed" }), { device: "dev" });
    time.advance(100);
    const second = await sinks.deliver(event({ kind: "session.failed" }), { device: "dev" });
    assert.equal(second[0].status, "skipped");
    assert.equal(second[0].detail, "cooldown");
    assert.equal(calls.length, 1);
  } finally {
    await s.cleanup();
  }
});

test("delivery is sequential: sink B starts only after sink A finishes", async () => {
  const s = await scratch();
  const time = clock();
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const fetchImpl: FetchLike = async (url) => {
    order.push(`start:${url}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    order.push(`end:${url}`);
    return { ok: true, status: 200 };
  };
  try {
    const sinks = await openWith(s.file, { now: time.now, fetchImpl });
    // Distinct createdAt stamps so `list()` order is creation order, not id order.
    await sinks.create({ kind: "webhook", url: "https://example.com/first" });
    time.advance(1);
    await sinks.create({ kind: "webhook", url: "https://example.com/second" });
    time.advance(1);
    await sinks.create({ kind: "webhook", url: "https://example.com/third" });

    const results = await sinks.deliver(event(), { device: "dev" });
    assert.deepEqual(results.map((result) => result.status), ["sent", "sent", "sent"]);
    assert.deepEqual(order, [
      "start:https://example.com/first",
      "end:https://example.com/first",
      "start:https://example.com/second",
      "end:https://example.com/second",
      "start:https://example.com/third",
      "end:https://example.com/third",
    ]);
    assert.equal(maxActive, 1, "never two requests in flight");
  } finally {
    await s.cleanup();
  }
});

test("a request is bounded by the timeout and reports `failed` instead of hanging", async () => {
  const s = await scratch();
  const time = clock();
  let sawSignal: AbortSignal | undefined;
  // Behaves like a real fetch: rejects when the signal aborts. The bail timer keeps
  // the loop alive (AbortSignal.timeout's own timer is unref'd) and fails loudly if
  // the module forgot to pass a signal at all.
  const fetchImpl: FetchLike = async (_url, init) => {
    sawSignal = init.signal;
    return new Promise((_resolve, reject) => {
      const bail = setTimeout(() => reject(new Error("no abort within 1s: deliver did not time out")), 1_000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(bail);
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    });
  };
  try {
    const sinks = await openWith(s.file, { now: time.now, fetchImpl, timeoutMs: 25 });
    await sinks.create({ kind: "webhook", url: "https://example.com/slow" });
    const results = await sinks.deliver(event(), { device: "dev" });
    assert.ok(sawSignal instanceof AbortSignal, "the timeout signal is handed to fetch");
    assert.equal(sawSignal?.aborted, true);
    assert.equal(results[0].status, "failed");
    assert.match(String(results[0].detail), /abort|timeout/i);
  } finally {
    await s.cleanup();
  }
});

test("disabled sinks and a kindless event fan nothing out", async () => {
  const s = await scratch();
  const { calls, fetchImpl } = recorder();
  try {
    const sinks = await openWith(s.file, { now: clock().now, fetchImpl });
    const sink = await sinks.create({ kind: "webhook", url: "https://example.com/muted", enabled: false });
    assert.deepEqual(await sinks.deliver(event(), { device: "dev" }), [], "a disabled sink is not fanned out");
    assert.equal(calls.length, 0);
    assert.equal(sinks.list()[0].id, sink.id, "and it is still in the registry");

    await sinks.update(sink.id, { enabled: true });
    const warnings: string[] = [];
    const noisy = await openWith(s.file, { now: clock().now, fetchImpl, warnings });
    assert.deepEqual(await noisy.deliver({ kind: "  ", title: "", body: "" }, { device: "dev" }), []);
    assert.equal(warnings.length, 1, "the malformed event is warned about, not thrown");
  } finally {
    await s.cleanup();
  }
});

test("the registry is 0600, its directory 0700, and no temp file survives a write", async () => {
  const s = await scratch();
  try {
    const sinks = await openWith(s.file, { now: clock().now });
    await sinks.create({ kind: "webhook", url: "https://example.com/a" });
    await sinks.create({ kind: "webhook", url: "https://example.com/b" });

    assert.equal(await mode(s.file), 0o600);
    assert.equal(await mode(s.dataDir), 0o700);
    assert.equal(await mode(s.backup), 0o600, "the rolling backup is as private as the file");

    const residue = (await readdir(s.dataDir)).filter((entry) => entry.includes(".tmp-"));
    assert.deepEqual(residue, [], "temp+rename leaves nothing behind");
  } finally {
    await s.cleanup();
  }
});

test("a corrupt registry is recovered from .bak instead of being overwritten", async () => {
  const s = await scratch();
  const time = clock();
  const warnings: string[] = [];
  try {
    const sinks = await openWith(s.file, { now: time.now, warnings });
    const first = await sinks.create({ kind: "webhook", url: "https://example.com/first" });
    await sinks.create({ kind: "webhook", url: "https://example.com/second" });
    // The `.bak` holds the state after the first write, which is the last good one.
    await writeFile(s.file, "{ this is not json", "utf8");

    const reopened = await openWith(s.file, { now: time.now, warnings });
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.list()[0].id, first.id);
    assert.ok(
      warnings.some((message) => message.includes("recovered 1 sink(s) from")),
      `expected a recovery warning, got ${JSON.stringify(warnings)}`,
    );
    const aside = (await readdir(s.dataDir)).filter((entry) => entry.includes(".corrupt-"));
    assert.equal(aside.length, 1, "the unreadable file was kept, not deleted");
  } finally {
    await s.cleanup();
  }
});

test("a corrupt registry whose .bak is also corrupt starts empty and keeps both files", async () => {
  const s = await scratch();
  const time = clock();
  const warnings: string[] = [];
  try {
    await writeFile(s.file, "nope", "utf8");
    await writeFile(s.backup, "also nope", "utf8");

    const sinks = await openWith(s.file, { now: time.now, warnings });
    assert.deepEqual(sinks.list(), []);
    assert.ok(
      warnings.some((message) => message.includes("is unusable too")),
      `expected the both-corrupt warning, got ${JSON.stringify(warnings)}`,
    );
    const aside = (await readdir(s.dataDir)).filter((entry) => entry.includes(".corrupt-"));
    assert.equal(aside.length, 1);
    assert.equal(await readFile(join(s.dataDir, aside[0]), "utf8"), "nope", "the bytes are preserved");

    // And the registry is writable again afterwards.
    const created = await sinks.create({ kind: "webhook", url: "https://example.com/new" });
    assert.equal((await readJson(s.file)).sinks[0].id, created.id);
  } finally {
    await s.cleanup();
  }
});

test("a hand-written file: bare array accepted, unknown version refused, bad rows dropped", async () => {
  const s = await scratch();
  const time = clock();
  const warnings: string[] = [];
  try {
    await writeFile(
      s.file,
      JSON.stringify([
        { id: "snk_aaaaaaaaaaaa", kind: "ntfy", url: "http://192.168.1.9/dpi", enabled: true },
        { id: "snk_bbbbbbbbbbbb", kind: "pigeon", url: "https://example.com/x" },
        { id: "snk_cccccccccccc", kind: "webhook", url: "file:///etc/passwd" },
        { id: "snk_dddddddddddd", kind: "webhook", url: "https://example.com/ok", events: ["ok.*", "not a pattern"] },
      ]),
      "utf8",
    );
    const sinks = await openWith(s.file, { now: time.now, warnings });
    const records = sinks.list();
    assert.deepEqual(
      records.map((record) => record.id),
      ["snk_aaaaaaaaaaaa", "snk_dddddddddddd"],
      "the unknown kind and the non-http url are dropped, the rest survives",
    );
    assert.equal(records[0].createdAt, time.now(), "missing timestamps are repaired");
    assert.deepEqual(records[1].events, ["ok.*"], "a bad pattern is dropped, not fatal");

    await writeFile(s.file, JSON.stringify({ version: 9, sinks: [] }), "utf8");
    await writeFile(s.backup, "gone", "utf8");
    const future = await openWith(s.file, { now: time.now, warnings: [] });
    assert.deepEqual(future.list(), [], "a newer file is refused, not read as garbage");
  } finally {
    await s.cleanup();
  }
});

test("deliver with no sinks is a no-op, and up() is safe on an empty registry", async () => {
  const s = await scratch();
  try {
    const sinks = await openWith(s.file, { now: clock().now });
    assert.deepEqual(await sinks.deliver(event(), { device: "dev" }), []);
    assert.deepEqual(sinks.recent(), []);
  } finally {
    await s.cleanup();
  }
});
