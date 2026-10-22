/**
 * Gate A GA-07 — what a hub may ask a device's REST API for.
 *
 * The connector hands the validated path string to fetch() and Express matches the result case-insensitively,
 * so the validator has to decide on the bytes that will really be requested: a spelling the parsers would
 * read differently is refused (never repaired), and only routes the device serves to a remote caller pass.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateRestRequest } from "../src/protocol/tunnel.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const allowed = (method: string, path: string) => validateRestRequest({ method, path }).ok;

/** One sample path per served route, with the methods that route answers. */
const SERVED: { sample: string; methods: string[] }[] = [
  { sample: "/v1/device", methods: ["GET"] },
  { sample: "/v1/tree", methods: ["GET"] },
  { sample: "/v1/fs/dirs?path=%2Fhome%2Fme", methods: ["GET"] },
  { sample: "/v1/docs/app.shared-state", methods: ["GET"] },
  { sample: "/v1/sessions", methods: ["GET", "POST"] },
  { sample: "/v1/sessions/3f2b9c1e-0a4d-4a43-9d57-6b0e0c1f2a3b", methods: ["GET", "PATCH", "DELETE"] },
  { sample: "/v1/sessions/My%20Session", methods: ["GET", "PATCH", "DELETE"] },
  { sample: "/v1/sessions/%C3%A9t%C3%A9%20%E2%9C%93", methods: ["GET", "PATCH", "DELETE"] },
  { sample: "/v1/sessions/s1/compaction", methods: ["GET", "PATCH"] },
  { sample: "/v1/sessions/s1/tasks?status=live", methods: ["GET"] },
  { sample: "/v1/sessions/s1/tasks/7/abort", methods: ["POST"] },
  { sample: "/v1/sessions/s1/inspect", methods: ["GET"] },
  { sample: "/v1/sessions/s1/submissions/12?waitMs=1000", methods: ["GET"] },
  { sample: "/v1/sessions/s1/agents", methods: ["GET", "POST"] },
  { sample: "/v1/sessions/s1/agents/main", methods: ["GET", "PATCH"] },
  { sample: "/v1/sessions/s1/agents/2", methods: ["GET", "PATCH"] },
  { sample: "/v1/sessions/s1/agents/main/entries?scope=active&limit=50", methods: ["GET"] },
  { sample: "/v1/sessions/s1/agents/main/transcript?format=md", methods: ["GET"] },
  { sample: "/v1/sessions/s1/agents/main/messages", methods: ["POST"] },
  { sample: "/v1/sessions/s1/agents/main/inbox/9", methods: ["DELETE"] },
  { sample: "/v1/sessions/s1/agents/main/abort", methods: ["POST"] },
  { sample: "/v1/sessions/s1/agents/main/fork", methods: ["POST"] },
  { sample: "/v1/sessions/s1/agents/main/config", methods: ["GET", "PATCH"] },
  { sample: "/v1/sessions/s1/agents/main/extensions", methods: ["GET", "PATCH"] },
  { sample: "/v1/sessions/s1/agents/main/compact", methods: ["POST"] },
  { sample: "/v1/sessions/s1/agents/main/reset", methods: ["POST"] },
  { sample: "/v1/sessions/s1/agents/main/docs/state", methods: ["GET"] },
  { sample: "/v1/sessions/s1/agents/main/demo/state", methods: ["POST"] },
  { sample: "/v1/sessions/s1/agents/main/demo/jobs", methods: ["POST"] },
  { sample: "/v1/sessions/s1/agents/main/demo/jobs/4/approval", methods: ["POST"] },
];

/** Routes that must never travel as tunneled REST: the device-local control surface and the three SSE streams. */
const DENIED: string[] = [
  "/v1/events",
  "/v1/pairing",
  "/v1/pairing/start",
  "/v1/pairing/cancel",
  "/v1/tunnel",
  "/v1/sessions/s1/events",
  "/v1/sessions/s1/agents/a1/events",
];

test("GA-07: every route the device serves to a remote caller passes, and only with the methods it answers", () => {
  for (const { sample, methods } of SERVED) {
    for (const method of METHODS) {
      assert.equal(allowed(method, sample), methods.includes(method), `${method} ${sample}`);
    }
  }
});

test("GA-07: the local control surface and the SSE streams are refused as they are written", () => {
  for (const path of DENIED) {
    for (const method of METHODS) {
      assert.equal(allowed(method, path), false, `${method} ${path}`);
      assert.equal(allowed(method, `${path}?x=1`), false, `${method} ${path}?x=1`);
    }
  }
});

/** Spellings that the URL parser, Express or a proxy could fold back onto `path`. */
function spellings(path: string): string[] {
  const segments = path.split("/");
  const last = segments.length - 1;
  const swapCase = (s: string) => [...s].map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join("");
  const withLast = (edit: (s: string) => string) => segments.map((s, i) => (i === last ? edit(s) : s)).join("/");
  const afterV1 = (insert: string) => path.replace("/v1/", `/v1${insert}`);
  const beforeLast = (insert: string) => segments.slice(0, last).join("/") + insert + segments[last];
  return [
    path.toUpperCase(),
    path.replace(/\/([a-z])/g, (_m, c: string) => `/${c.toUpperCase()}`),
    swapCase(path),
    withLast((s) => s.charAt(0).toUpperCase() + s.slice(1)),
    afterV1("/./"),
    afterV1("/%2e/"),
    afterV1("/%2E/"),
    beforeLast("/./"),
    beforeLast("/%2e/"),
    beforeLast("/;/"),
    afterV1("//"),
    beforeLast("//"),
    `${path}/`,
    `${path}//`,
    `${path}#x`,
    `${path}#/..`,
    `${path};x=1`,
    `${path};jsessionid=abc`,
    withLast((s) => `${s};x=1`),
    `${path}\t`,
    `${path}\n`,
    `${path}\r`,
    `${path} `,
    ` ${path}`,
    withLast((s) => `${s.slice(0, 1)}\t${s.slice(1)}`),
    withLast((s) => `${s.slice(0, 1)}\n${s.slice(1)}`),
    withLast((s) => `${s.slice(0, 1)}\r${s.slice(1)}`),
    withLast((s) => `${s.slice(0, 1)}\u0000${s.slice(1)}`),
    withLast((s) => `${s.slice(0, 1)}%00${s.slice(1)}`),
    withLast((s) => `%${s.charCodeAt(0).toString(16)}${s.slice(1)}`),
    withLast((s) => `%${s.charCodeAt(0).toString(16).toUpperCase()}${s.slice(1)}`),
    withLast((s) => `${s.slice(0, -1)}%${s.charCodeAt(s.length - 1).toString(16)}`),
    withLast((s) => `\uff45${s.slice(1)}`),
    path.replace("/v1/", "/v1\\"),
    `${path}\\`,
    `/v1/%2e%2e${path.slice(3)}`,
    `/v1/x/..${path.slice(3)}`,
    `/v1/x/%2e%2e${path.slice(3)}`,
    `/v1/x/%2E%2E${path.slice(3)}`,
    `/v1/x/.%2e${path.slice(3)}`,
    `/v1/x/%2e.${path.slice(3)}`,
    `//${path.slice(1)}`,
    `http://127.0.0.1:1${path}`,
  ];
}

test("GA-07: no spelling of a denied route gets through (case, dot segments, control bytes, fragments, ;params, //, encodings)", () => {
  for (const path of DENIED) {
    for (const spelled of spellings(path)) {
      for (const method of METHODS) {
        assert.equal(allowed(method, spelled), false, `${method} ${JSON.stringify(spelled)}`);
      }
    }
  }
});

test("GA-07: the case and encoding variants the Gate A probe sent are refused", () => {
  for (const [method, path] of [
    ["POST", "/v1/Pairing/start"],
    ["POST", "/v1/PAIRING/cancel"],
    ["GET", "/v1/Tunnel"],
    ["GET", "/v1/TUNNEL"],
    ["GET", "/v1/Events"],
    ["GET", "/v1/EVENTS?scope=all"],
    ["POST", "/v1/%50airing/start"],
    ["GET", "/v1/%65vents"],
  ] as const) {
    const verdict = validateRestRequest({ method, path });
    assert.equal(verdict.ok, false, `${method} ${path}`);
  }
});

test("GA-07: the refusal says which kind of route it was", () => {
  const why = (path: string) => {
    const verdict = validateRestRequest({ method: "GET", path });
    return verdict.ok ? "allowed" : verdict.error;
  };
  assert.match(why("/v1/events"), /SSE/);
  assert.match(why("/v1/Events"), /SSE/);
  assert.match(why("/v1/sessions/s/agents/a/events"), /SSE/);
  assert.match(why("/v1/Pairing/start"), /device-local/);
  assert.match(why("/v1/TUNNEL"), /device-local/);
  assert.match(why("/v1/nothing-here"), /not allowlisted/);
});

test("GA-07: spellings that are not canonical are refused rather than repaired", () => {
  for (const path of [
    "/v1",
    "/v1/",
    "/v1/device/",
    "/v1//device",
    "/v1/sessions//agents",
    "/v1/sessions/s1/agents/",
    "/v1/./device",
    "/v1/sessions/./s1",
    "/v1/sessions/%2e/agents",
    "/v1/device#x",
    "/v1/device;x=1",
    "/v1/sessions/s1;x=1/agents",
    "/v1/de\tvice",
    "/v1/device\n",
    "/v1/device ",
    "/v1/Device",
    "/v1/DEVICE",
    "/v1/Sessions",
    "/v1/sessions/s1/Agents",
    "/v1/%64evice",
    "/v1/sessions/é",
    "/v1/sessions/s1?q=a#b",
  ]) {
    assert.equal(allowed("GET", path), false, JSON.stringify(path));
  }
});

test("GA-07: a parameter segment is one decoded name: no separators, controls, dot names or runaway length", () => {
  assert.equal(allowed("GET", "/v1/sessions/a%2Fb/agents"), false, "encoded slash");
  assert.equal(allowed("GET", "/v1/sessions/a%5Cb/agents"), false, "encoded backslash");
  assert.equal(allowed("GET", "/v1/sessions/a%00b/agents"), false, "encoded NUL");
  assert.equal(allowed("GET", "/v1/sessions/a%0Ab/agents"), false, "encoded newline");
  assert.equal(allowed("GET", "/v1/sessions/%2e/agents"), false, "encoded dot name");
  assert.equal(allowed("GET", "/v1/sessions/%C3/agents"), false, "truncated UTF-8");
  assert.equal(allowed("GET", "/v1/sessions/%/agents"), false, "bare percent");
  assert.equal(allowed("GET", `/v1/sessions/${"a".repeat(256)}`), true, "256 characters is still a name");
  assert.equal(allowed("GET", `/v1/sessions/${"a".repeat(257)}`), false, "257 is not");
  assert.equal(allowed("GET", `/v1/sessions/${"%C3%A9".repeat(256)}`), true, "the limit counts decoded characters");
  // Decoded once: the text %2e that a name spells out is a name, not a dot segment.
  assert.equal(allowed("GET", "/v1/sessions/%252e%252e/agents"), true);
});

test("GA-07: the query string is carried but cannot smuggle a fragment, a traversal or an absolute URL", () => {
  assert.equal(allowed("GET", "/v1/tree?a=1&b=%20x"), true);
  assert.equal(allowed("GET", "/v1/tree?a=1#x"), false);
  assert.equal(allowed("GET", "/v1/tree?next=../../x"), false);
  assert.equal(allowed("GET", "/v1/tree?next=http://example.invalid/"), false);
  assert.equal(allowed("GET", "/v1/tree?a=100%"), false);
  assert.equal(allowed("GET", "/v1/tree?a=\tb"), false);
});

// A deterministic fuzz: whatever the validator lets through must be requested exactly as it was checked,
// and must not be a denied route under any of the foldings Express or the URL parser could apply.
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS = [
  "/", "//", "/./", "/%2e/", "/%2E/", ".", "%2e", ";", ";x=1", "#", "#frag", "\t", "\n", "\r", " ", "\\", "%00", "%0a",
  "%2f", "%5c", "?", "?x=1", "%", "%zz", "é", "%C3%A9", "..", "%252e", "://", "%3a%2f%2f",
];
const WORDS = ["v1", "events", "pairing", "start", "cancel", "tunnel", "sessions", "agents", "main", "device", "tree", "messages", "docs", "Events", "PAIRING", "s1", "a1"];
// Names a caller may legitimately put in a parameter position, including ones that spell a denied route.
const NAMES = ["events", "Events", "pairing", "tunnel", "x", "7", "main", "%65vents", "%C3%A9", "a%2Fb", "%2e", ".", "..", "%252e", "s1;x", "a b"];
const QUERIES = ["x=1", "a=%20b", "next=%2F..%2Fx", "q=a%23b", "", "x=1&y=2", "path=%2Fhome%2Fme"];

const folded = (path: string): string[] =>
  path
    .split("?")[0]
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .map((segment) => segment.split(";")[0].toLowerCase())
    .filter((segment) => segment !== "" && segment !== ".");

const isDeniedShape = (segments: string[]) => {
  const rest = segments[0] === "v1" ? segments.slice(1) : segments;
  if (["events", "pairing", "tunnel"].includes(rest[0])) return true;
  if (rest[0] === "sessions" && rest[2] === "events") return true;
  return rest[0] === "sessions" && rest[2] === "agents" && rest[4] === "events";
};

test("GA-07: fuzz — an accepted path is requested exactly as validated and is never a denied route in any folding", () => {
  const random = prng(0x6a07);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const templates = [...DENIED, ...SERVED.map((s) => s.sample)];
  // `benign` limits a mutation to swapping a name or a query in, so a good share of the corpus stays acceptable.
  const mutate = (s: string, benign: boolean): string => {
    const at = Math.floor(random() * (s.length + 1));
    switch (benign ? 7 + Math.floor(random() * 2) : Math.floor(random() * 9)) {
      case 7: {
        const parts = s.split("?")[0].split("/");
        parts[2 + Math.floor(random() * (parts.length - 2))] = pick(NAMES);
        return parts.join("/") + (s.includes("?") ? `?${s.split("?").slice(1).join("?")}` : "");
      }
      case 8:
        return `${s.split("?")[0]}?${pick(QUERIES)}`;
      case 0:
        return s.slice(0, at) + pick(ATOMS) + s.slice(at);
      case 1:
        return s.slice(0, at) + s.slice(at + 1);
      case 2: {
        const i = Math.floor(random() * s.length);
        const c = s[i] ?? "";
        return s.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + s.slice(i + 1);
      }
      case 3: {
        const i = Math.floor(random() * s.length);
        return s.slice(0, i) + "%" + (s.charCodeAt(i) || 0).toString(16).padStart(2, "0") + s.slice(i + 1);
      }
      case 4: {
        const parts = s.split("/");
        parts[Math.floor(random() * parts.length)] = pick(WORDS);
        return parts.join("/");
      }
      case 5:
        return s + pick(ATOMS);
      default:
        return pick(ATOMS) + s;
    }
  };

  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 80_000; i++) {
    let path = pick(templates);
    const benign = random() < 0.5;
    for (let n = Math.floor(random() * 3); n >= 0; n--) path = mutate(path, benign);
    const method = pick(METHODS);
    if (!allowed(method, path)) {
      refused++;
      continue;
    }
    accepted++;
    const shown = `${method} ${JSON.stringify(path)}`;
    const url = new URL(`http://127.0.0.1:1${path}`);
    assert.equal(url.hash, "", `${shown}: a fragment would be cut off`);
    const [rawPath, ...rawQuery] = path.split("?");
    assert.deepEqual(
      url.pathname.split("/").map((s) => decodeURIComponent(s)),
      rawPath.split("/").map((s) => decodeURIComponent(s)),
      `${shown}: the URL parser changed the path`,
    );
    const query = rawQuery.join("?");
    // An empty query ("...?") is reported as "" by the URL parser and sent without the "?": the same request.
    if (query) assert.equal(decodeURIComponent(url.search), decodeURIComponent(`?${query}`), `${shown}: query changed`);
    assert.equal(isDeniedShape(folded(path)), false, `${shown}: denied route in disguise`);
  }
  assert.ok(accepted > 3_000, `the fuzz must exercise accepted paths too (accepted ${accepted}, refused ${refused})`);
  assert.ok(refused > 5_000, `and refused ones (accepted ${accepted}, refused ${refused})`);
});
