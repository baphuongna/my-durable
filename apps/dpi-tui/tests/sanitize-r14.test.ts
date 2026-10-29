/**
 * Audit run-1 (terminal escape injection): device/hub/model-controlled strings
 * reached the operator's terminal unsanitized — OSC 8 / OSC 52 / CSI ?1049l /
 * OSC 0 / bare CR survived every render path verbatim and landed in
 * process.stdout (pi-tui is a zero-width passthrough, not a sanitizer). The fix
 * strips ESC-initiated sequences and C0 controls (except \n, \t) at the render
 * choke points: Line/Wrapped/ToolRow/Markdown input (render.ts), fit() for
 * every dashboard row (views.ts), the toast and the exit write (app.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTerminal } from "../src/sanitize.ts";
import { itemComponent } from "../src/render.ts";
import { Line } from "../src/render.ts";
import { herdRows, networkRows, renderHerd, renderHerdPanel } from "../src/views.ts";
import type { DeviceRow } from "../../dpi-sdk/src/node/registry.ts";
import type { SessionSummary } from "../../dpi-sdk/src/api.ts";

const OSC8 = "\x1b]8;;http://evil.example/click\x1b\\CLICK ME\x1b]8;;\x1b\\";
const OSC52 = "\x1b]52;c;cG93bmVk\x1b\\";
const EXIT_ALT = "\x1b[?1049l\x1b[2J";
const TITLE = "\x1b]0;pwned-title\x1b\\";
const DCS = "\x1bP1;2q\x1b\\";
const CR = "SAFE-ROW\rEVIL-ROW";
const LONE_ESC = "trail\x1b";

const hasControl = (s: string) => /\x1b|[\u0000-\u0008\u000B-\u001F\u007F]/.test(s);

/** Payload-specific probe for RENDERED lines: our own theme emits trusted SGR
 * color codes (CSI m), so the invariant is that no OSC/DCS/private CSI from the
 * payload class survives and the injected link target is gone. */
const leaked = (s: string) =>
  s.includes("\x1b]") || s.includes("\x1bP") || s.includes("\x1b^") || s.includes("\x1b_") ||
  s.includes("\x1b[?") || s.includes("\r") || s.includes("evil.example");

test("sanitizeTerminal neutralizes every payload class, keeps \\n and \\t", () => {
  for (const payload of [OSC8, OSC52, EXIT_ALT, TITLE, DCS, CR, LONE_ESC]) {
    const out = sanitizeTerminal(payload);
    assert.equal(hasControl(out), false, `payload survived: ${JSON.stringify(payload)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(sanitizeTerminal("line1\nline2\ttab"), "line1\nline2\ttab");
  // The OSC 8 TARGET is stripped; the visible label degrades to inert text.
  assert.equal(sanitizeTerminal(`hostile ${OSC8} inline`), "hostile CLICK ME inline");
});

test("transcript render paths emit no ESC bytes for payload-carrying items", () => {
  // user text (Wrapped)
  const user = itemComponent({ kind: "user", id: "u1", text: `hi ${OSC8} ${CR}` } as never, false);
  // assistant thinking + error (Line)
  const think = itemComponent(
    { kind: "assistant", id: "a1", streaming: false, blocks: [{ type: "thinking", text: `${OSC52} pondering` }], error: `${TITLE} boom` } as never,
    false,
  );
  // tool-result row (ToolRow body)
  const tool = itemComponent(
    { kind: "tool-result", id: "t1", name: `bash ${EXIT_ALT}`, isError: false, text: `out ${OSC8} ${DCS} ${CR}` } as never,
    false,
  );
  for (const [label, comp] of [["user", user], ["assistant", think], ["tool", tool]] as const) {
    const lines = comp.render(60).join("\n");
    assert.equal(leaked(lines), false, `${label} path leaked control sequences: ${JSON.stringify(lines)}`);
  }
});

test("dashboard rows (device/hub-controlled names) emit no ESC bytes", () => {
  const sessions: SessionSummary[] = [
    {
      id: "ses-1",
      name: `evil-${OSC8}-name`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: `${TITLE} err`,
      busy: false,
      cwd: "/tmp/work",
      model: "faux",
      agents: [],
    } as never as SessionSummary,
  ];
  const rows = herdRows(sessions, "", () => `branch-${EXIT_ALT}`);
  for (const row of rows) {
    assert.equal(leaked(row.label), false, `row label leaked: ${JSON.stringify(row.label)}`);
    if (row.kind === "session")
      assert.equal(leaked(row.branch ?? ""), false, `row branch leaked: ${JSON.stringify(row.branch)}`);
  }
  // The RENDERED table (the bytes that reach the terminal) is clean too —
  // while the theme's own SGR colors must survive the strip (styled BEFORE fit).
  const lines = renderHerd(100, rows, sessions, {}).join("\n");
  assert.equal(leaked(lines), false, `rendered herd leaked: ${JSON.stringify(lines.slice(0, 200))}`);
  assert.match(lines, /\u001b\[/, "the theme's own SGR colors survive (fit no longer strips styling)");

  // Network rows: device names (self-declared at pairing) are device-controlled.
  const net = networkRows(
    [{ id: "d1", name: `box-${OSC8}`, kind: "pi", transport: "tunnel" } as never as DeviceRow],
    "",
  );
  for (const row of net) assert.equal(leaked(row.label), false, `net row leaked: ${JSON.stringify(row.label)}`);
});

test("the overview panel sanitizes its device-sourced strings (R14 review)", () => {
  // renderHerdPanel renders the same device-sourced fields as the table
  // (name, cwd basename, model, agent names, device) — all sanitized at the
  // data boundary. Line itself is a STYLED primitive and must NOT strip
  // (R14 cold review: it was stripping the theme's own SGR).
  const session = {
    id: "ses-1",
    name: `evil-${OSC8}-name`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: `${TITLE} err`,
    busy: false,
    cwd: `/tmp/${TITLE}-work`,
    model: `faux-${EXIT_ALT}`,
    agents: [{ kind: "fork", name: `agent-${OSC52}` } as never],
  } as never as Parameters<typeof renderHerdPanel>[2];
  const lines = renderHerdPanel(60, 20, session, 50, `dev-${DCS}`).join("\n");
  assert.equal(leaked(lines), false, `panel leaked: ${JSON.stringify(lines.slice(0, 300))}`);
  // The styled primitive keeps the theme's own SGR (no over-stripping).
  assert.match(new Line("\u001b[1mbold\u001b[22m").render(20).join(""), /\u001b\[1m/, "Line preserves pre-styled SGR");
});

test("the live transcript renderer sanitizes model/tool payloads (R15 run-2 h15)", async () => {
  // The delta-8 fix sanitized render.ts components that App.frame() never
  // uses — the real conversation is App.agentContent. This drives the REAL
  // method with a hostile transcript and asserts no escape bytes survive.
  const { App } = await import("../src/app.ts");
  const app = new App(
    { id: `dev-${OSC52}`, name: "n", url: "http://127.0.0.1:9", token: "t" },
    { stream: () => ({ abort() {} }), on: () => () => {} } as never,
    { models: [], startDirs: [] } as never,
  );
  try {
    const s = app.model.state as { items: unknown[] };
    s.items = [
      { kind: "user", text: `user ${OSC8} text` },
      {
        kind: "assistant",
        blocks: [
          { type: "thinking", text: `think ${DCS}` },
          { type: "text", text: `answer ${OSC52}` },
          {
            type: "tool",
            call: {
              id: "1",
              name: `bash${EXIT_ALT}`,
              status: "ok",
              args: { command: `echo ${OSC8}` },
              result: `out ${TITLE}\rline`,
            },
          },
        ],
        error: `boom ${EXIT_ALT}`,
      },
    ];
    const raw = (app as unknown as { agentContent(w: number): string[] }).agentContent(80).join("\n");
    // Theme SGR (`ESC[...m`) is trusted; strip it, then NO escape/control byte
    // of any payload class may survive — OSC/DCS/CSI?/CR all gone, and the OSC8
    // link TARGET may not remain as a rendered link (inert label text is fine).
    const inert = raw.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(/\x1b/.test(inert), false, `escape byte survived: ${JSON.stringify(inert.slice(0, 300))}`);
    assert.equal(inert.includes("\r"), false, "CR survived");
  } finally {
    (app as unknown as { exit(): void }).exit();
  }
});

test("R17 h5: pending notes are sanitized at the setPending chokepoint", async () => {
  const { App } = await import("../src/app.ts");
  const app = new App(
    { id: "d", name: "n", url: "http://127.0.0.1:9", token: "t" },
    { stream: () => ({ abort() {} }), on: () => () => {} } as never,
    { models: [], startDirs: [] } as never,
  );
  try {
    app.setPending(`listing ${OSC8} on dev…`);
    // messageLine is private — structural cast like the siblings above.
    const raw = (app as unknown as { messageLine(w: number): string }).messageLine(120);
    const line = raw.replace(/\u001b\[[0-9;]*m/g, ""); // theme SGR is trusted
    assert.ok(!line.includes("\u001b"), "OSC hyperlink payload must not reach the frame");
    assert.ok(!line.includes("evil.example"), "the hyperlink target must not survive");
    app.setPending(null);
  } finally {
    await app.exit();
  }
});

test("R18 h4: pairing note, network status and /name seed are sanitized", async () => {
  const OSC = "\u001b]8;;http://evil.example\u0007x\u001b\\";
  // Theme SGR is trusted chrome (R17 pattern) — strip it before asserting.
  const noEsc = (s: string) => {
    const bare = s.replace(/\u001b\[[0-9;]*m/g, "");
    return !bare.includes("\u001b") && !bare.includes("evil.example");
  };

  // (1) pairing panel: the note reaches chrome through TWO branches now (the
  // !status branch was always sanitized; the status branches were raw).
  const { pairingViewLines } = await import("../src/pairing.ts");
  for (const dto of [
    { state: "pairing", fingerprint: "abc" },
    { state: "paired", fingerprint: "abc" },
    { state: "revoked", fingerprint: "abc" },
  ] as never[]) {
    const lines = pairingViewLines(dto, `note ${OSC}`, 100);
    assert.ok(lines.every(noEsc), `pairing note leaked: ${lines.join(" | ")}`);
  }

  // (2) network view: a hub-supplied free-form status string never injects.
  const { renderNetwork } = await import("../src/views.ts");
  const rows = [{ kind: "device", deviceId: "d1", label: "d1", depth: 0, key: "d1" }] as never[];
  const devices = [
    { id: "d1", name: "d1", kind: "local", transport: "lan", lastStatus: OSC, lastSeen: 0 },
  ] as never[];
  const lines = renderNetwork(100, rows, devices);
  assert.ok(lines.every(noEsc), `network status leaked: ${lines.join(" | ")}`);
});

test("R19 h2: /find hit lines sanitize the relay-borne numeric entry and counts", async () => {
  const { findHitLine } = await import("../src/commands.ts");
  const hostile = { agent: "Main", entry: "\u001b]52;c;aGVsbG8=\u0007" as unknown as number, text: "ok" };
  const line = findHitLine("Session", hostile);
  assert.ok(!/\u001b/.test(line), `no raw ESC may reach the terminal: ${JSON.stringify(line)}`);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(line), "no C0/C1 controls either");
  // Honest values keep their readable shape.
  assert.equal(findHitLine("Session", { agent: "Main", entry: 12345, text: "hello" }), "  Session:Main #12345 — hello");
});
