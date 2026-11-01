// Run-13 Unit A — :export and :archive, pinned in the commands-ops-r12.test.ts
// style: a fake App whose client stubs the SDK ops, driven exactly the keys an
// operator sends. The run-9/r12-m1 invariant rides every case: device-authored
// text (session names, cwd, the export download filename, transcript lines)
// must never split a rendered row or a log line, so hostile \n\r fixtures are
// used on purpose and every picker/log line is asserted single-line. File
// writes go ONLY to mkdtemp tmp dirs — never a production path.
import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, runCommand, sanitizeExportName } from "../src/commands.ts";
import { capTranscriptLines } from "../src/pickers.ts";
import type { App, DeviceRef } from "../src/app.ts";

/** Names a hostile relay might ride in — the run-9/r12 fixture shape. */
const HOSTILE_NAME = "nightly\n DIGEST\r";
const HOSTILE_CWD = "/srv/wor\nk\r";
/** The device's Content-Disposition download name, hostile variant. */
const HOSTILE_FILENAME = "my session:\n bundle\r.zip";

/** Just enough App for the run-13 doors: recording client, prompt queue,
 * overlays — the fakeOps harness of commands-ops-r12.test.ts, trimmed to the
 * sessions/export/archive surface. */
function fakeEA(opts: { prompts?: (string | undefined)[] } = {}) {
  const flashes: { text: string; error: boolean }[] = [];
  const logEvents: { glyph: string; text: string }[] = [];
  const overlays: unknown[] = [];
  const prompts: { label: string; initial: string }[] = [];
  const queue = [...(opts.prompts ?? [])];
  const attached: [string, number][] = [];
  let closes = 0;

  // Live sessions for the pickSession door (loose records — the wire shape is
  // the SDK's business; the harness only needs the fields the flows read).
  const sessions = [
    { id: "s1", name: HOSTILE_NAME, cwd: HOSTILE_CWD, busy: false, agents: [{ id: 1, kind: "root" }] },
    { id: "s2", name: "plain", cwd: "/srv/plain", busy: false, agents: [{ id: 7, kind: "root" }] },
  ];
  // Deliberately stored OLDEST-FIRST so the test pins the archivedAt-desc sort.
  const archive: (Record<string, unknown> & { sessionId: string })[] = [
    {
      sessionId: "old-1",
      archivedAt: Date.now() - 900_000,
      name: HOSTILE_NAME,
      cwd: HOSTILE_CWD,
      model: "openrouter/m",
      turns: 12,
      lastMessageAt: null,
      bytes: 2048,
      hasManifest: true,
    },
    {
      sessionId: "new-1",
      archivedAt: Date.now() - 90_000,
      name: "fresh",
      cwd: "/srv/fresh",
      model: "openrouter/m",
      turns: 3,
      lastMessageAt: Date.now(),
      bytes: 300,
      hasManifest: false,
    },
  ];
  const calls = {
    export: 0,
    exportedIds: [] as string[],
    archived: 0,
    transcript: [] as [string, string][],
    restore: [] as string[],
    tree: 0,
  };
  const transcripts: Record<string, string> = {
    "new-1": Array.from({ length: 450 }, (_, i) => `line ${i}`).join("\n"),
    "old-1": "# nightly\n\nrun \r 1\nokay \x1b[31mRED\x1b[0m",
  };
  const client = {
    tree: async () => (calls.tree++, { uid: "u", name: "box", sessions, at: 0 }),
    exportSession: async (id: string) => {
      calls.export++;
      calls.exportedIds.push(id);
      if (id === "boom") throw new Error("device refused: session locked");
      return { filename: HOSTILE_FILENAME, mime: "application/zip", bytes: new Uint8Array([0x50, 0x4b, 1, 2, 3, 4]) };
    },
    archived: async () => (calls.archived++, { sessions: [...archive] }),
    archivedTranscript: async (id: string, format: string) => (
      calls.transcript.push([id, format]),
      { format: "markdown", text: transcripts[id] ?? "" }
    ),
    restoreArchived: async (id: string) => {
      calls.restore.push(id);
      const i = archive.findIndex((a) => a.sessionId === id);
      if (i >= 0) archive.splice(i, 1);
      return { id, name: "restored-name" };
    },
  };
  const device: DeviceRef = { id: "box", name: "box", url: "http://x", token: "t" };
  const app = {
    device,
    client,
    info: { models: [], defaultModel: "m", startDirs: [], name: "box" },
    handle: undefined,
    sessionId: undefined,
    agentId: undefined,
    cwd: () => undefined,
    model: { state: { agent: {}, entries: [], items: [] } },
    session: { state: { tasks: [], agents: [] } },
    sessionSummary: () => undefined,
    run: async (fn: () => Promise<unknown>) => {
      // Mirrors App.run: a thrown device error becomes a toast, never a crash.
      try {
        await fn();
      } catch (e) {
        flashes.push({ text: (e as Error).message, error: true });
      }
    },
    attach: async (sessionId: string, agentId: number) => {
      attached.push([sessionId, agentId]);
    },
    flash: (text: string, error = false) => flashes.push({ text, error }),
    notify: (text: string, error = false) => flashes.push({ text, error }),
    overlay: (component: unknown) => overlays.push(component),
    closeOverlay: () => {
      closes += 1;
    },
    prompt: async (label: string, initial: string) => {
      prompts.push({ label, initial });
      return queue.length ? queue.shift() : undefined;
    },
    setPending: (_text: string | null) => {},
    logEvent: (glyph: string, text: string) => logEvents.push({ glyph, text }),
    exit: () => {},
  };
  return {
    app: app as never as App,
    flashes,
    logEvents,
    prompts,
    attached,
    calls,
    archive,
    transcripts,
    settle: (ms = 25) => new Promise((r) => setTimeout(r, ms)),
    mounted: () => overlays.length - closes,
    top: () =>
      overlays[overlays.length - 1] as unknown as {
        render: (w: number) => string[];
        handleInput: (data: string) => void;
        items: () => { value: string; label: string; description?: string }[];
        pick: (item: { value: string; label: string }) => void;
      },
  };
}

const strip = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

/** Run-9 invariant: chrome rows are single lines and fit the terminal. */
const assertRows = (lines: string[]) => {
  for (const line of lines) {
    assert.ok(!line.includes("\n") && !line.includes("\r"), `raw CR/LF leaked into a picker row: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(line) <= 80, `row exceeds 80 visible cols: ${JSON.stringify(line)}`);
  }
};

/** Every log line the flows wrote is single-line too (logEvent has no
 * normalizer downstream — the helpers own that invariant). */
const assertLogLines = (events: { text: string }[]) => {
  for (const e of events)
    assert.ok(
      !e.text.includes("\n") && !e.text.includes("\r") && !e.text.includes("\x1b"),
      `log line carries control chars: ${JSON.stringify(e.text)}`,
    );
};

/** A fresh tmp dir per fs-touching test — rm'd on the way out. */
const tmpDir = () => mkdtempSync(join(tmpdir(), "dpi-tui-r13-"));

// ---------------------------------------------------------------- :export

test("COMMANDS registers :export (with argumentHint) and :archive", () => {
  const names = COMMANDS.map((c) => c.name);
  assert.ok(names.includes("export"), ":export missing from COMMANDS");
  assert.ok(names.includes("archive"), ":archive missing from COMMANDS");
  assert.equal(COMMANDS.find((c) => c.name === "export")!.argumentHint, "[sessionId]");
  assert.ok(COMMANDS.find((c) => c.name === "archive")!.description!.length > 0);
});

test("sanitizeExportName folds the device filename: oneLine, charset fold, 80-cap (FE r16 pattern)", () => {
  // CR/LF first (oneLine collapses the whitespace), then [^A-Za-z0-9._-] → "_".
  assert.equal(sanitizeExportName(HOSTILE_FILENAME), "my_session__bundle.zip");
  assert.equal(sanitizeExportName("a b.tar.gz"), "a_b.tar.gz");
  assert.equal(sanitizeExportName("x".repeat(100) + ".zip"), "x".repeat(80), "capped at 80 chars");
  assert.equal(sanitizeExportName(""), "", "an empty device name folds to empty — the flow has its own fallback");
});

test(":export <id> seeds the folded default, writes the exact bytes, toasts saved <path> (size)", async () => {
  const tmp = tmpDir();
  try {
    const target = join(tmp, "out.zip");
    const t = fakeEA({ prompts: [target] });
    assert.equal(await runCommand(t.app, "/export s2"), true);
    await t.settle();
    assert.deepEqual(t.calls.exportedIds, ["s2"]);
    // The seeded default is the FOLDED device filename — the hostile \n\r
    // never reaches the prompt's initial value (a path segment!).
    assert.equal(t.prompts[0]!.label, "Save export as");
    assert.equal(t.prompts[0]!.initial, "./my_session__bundle.zip");
    assert.deepEqual([...readFileSync(target)], [0x50, 0x4b, 1, 2, 3, 4], "the zip bytes landed byte-for-byte");
    assert.ok(t.flashes.some((f) => !f.error && f.text === `saved ${target} (6B)`), `saved toast: ${JSON.stringify(t.flashes)}`);
    assert.ok(t.logEvents.some((e) => e.glyph === "export" && e.text.includes("saved") && e.text.includes("6B")));
    assertLogLines(t.logEvents);
    assert.equal(t.mounted(), 0, "the flow leaves no overlay behind");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test(":export over an existing file: y/n confirm — declined never writes, y overwrites", async () => {
  const keep = tmpDir();
  const over = tmpDir();
  try {
    const keepPath = join(keep, "exists.zip");
    writeFileSync(keepPath, "KEEP ME");
    const declined = fakeEA({ prompts: [keepPath, "n"] });
    await runCommand(declined.app, "/export s1");
    await declined.settle();
    // The confirm came BEFORE any write: the declined answer means writeFile
    // never ran — the existing content is untouched.
    assert.match(declined.prompts[1]!.label, /Overwrite .*exists\.zip\? y\/n/);
    assert.equal(readFileSync(keepPath, "utf8"), "KEEP ME", "a declined overwrite never wrote");
    assert.ok(declined.flashes.some((f) => /export cancelled — kept the existing file/.test(f.text) && !f.error));

    const overPath = join(over, "exists.zip");
    writeFileSync(overPath, "OLD");
    const accepted = fakeEA({ prompts: [overPath, "y"] });
    await runCommand(accepted.app, "/export s1");
    await accepted.settle();
    assert.deepEqual([...readFileSync(overPath)], [0x50, 0x4b, 1, 2, 3, 4], "an accepted y overwrote the file");
  } finally {
    rmSync(keep, { recursive: true, force: true });
    rmSync(over, { recursive: true, force: true });
  }
});

test(":export with no arg rides pickSession: the PICKED session exports (and attaches); esc exports nothing", async () => {
  const tmp = tmpDir();
  try {
    const target = join(tmp, "picked.zip");
    const t = fakeEA({ prompts: [target] });
    // The command stays pending until a pick (the operator types /export and
    // the picker mounts while it runs) — fire it, drive the picker, then join.
    const running = runCommand(t.app, "/export");
    await t.settle();
    assert.equal(t.mounted(), 1, "the session picker mounted");
    assertRows(t.top().render(80));
    t.top().pick(t.top().items()[2]); // ＋new, s1(hostile), s2
    assert.equal(await running, true);
    await t.settle(50);
    assert.deepEqual(t.attached, [["s2", 7]], "attach-on-pick is pickSession's documented behavior");
    assert.deepEqual(t.calls.exportedIds, ["s2"], "the export followed the pick");
    assert.ok(t.flashes.some((f) => /saved/.test(f.text) && !f.error));

    // Esc out of the picker: /export resolves quietly — no call, no lie of a
    // "cancelled" toast over a flow that simply ended.
    const esc = fakeEA();
    const escRunning = runCommand(esc.app, "/export");
    await esc.settle();
    esc.top().handleInput("\x1b");
    assert.equal(await escRunning, true);
    await esc.settle(50);
    assert.equal(esc.calls.export, 0, "esc never exports");
    assert.ok(!esc.flashes.some((f) => /export/.test(f.text)), `esc is quiet: ${JSON.stringify(esc.flashes)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test(":export error paths toast and never throw: device refusal and unwritable path", async () => {
  const refused = fakeEA();
  assert.equal(await runCommand(refused.app, "/export boom"), true, "the command never throws on a device refusal");
  await refused.settle();
  assert.ok(refused.flashes.some((f) => f.error && /export: device refused/.test(f.text)), JSON.stringify(refused.flashes));
  assert.equal(refused.prompts.length, 0, "a refused export never asks for a path");

  const tmp = tmpDir();
  try {
    const bad = join(tmp, "no-such-dir", "x.zip"); // ENOENT on writeFile
    const disk = fakeEA({ prompts: [bad] });
    assert.equal(await runCommand(disk.app, "/export s1"), true);
    await disk.settle();
    assert.ok(disk.flashes.some((f) => f.error && /export: /.test(f.text)), `write failure toasted: ${JSON.stringify(disk.flashes)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- :archive

test("capTranscriptLines caps at 400 lines / 100 KiB with a LEADING marker; under cap there is none", () => {
  // Under both caps: verbatim (modulo sanitize), no marker.
  assert.deepEqual(capTranscriptLines("a\nb\nc"), ["a", "b", "c"]);
  // 401 short lines → marker + exactly 400 lines.
  const many = capTranscriptLines(Array.from({ length: 401 }, (_, i) => `l${i}`).join("\n"));
  assert.equal(many.length, 401);
  assert.equal(many[0], "... truncated (1 line)", "the marker LEADS the dump (r9 pattern)");
  assert.equal(many[1], "l0");
  assert.equal(many.at(-1), "l399");
  // 450 lines → 50 dropped.
  const big = capTranscriptLines(Array.from({ length: 450 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(big[0], "... truncated (50 lines)");
  assert.equal(big.length, 401);
  // One giant line (150 KiB) → byte cut names at least 1 hidden line.
  const fat = capTranscriptLines("x".repeat(150 * 1024));
  assert.equal(fat.length, 2);
  assert.equal(fat[0], "... truncated (1 line)");
  assert.equal(fat[1]!.length, 100 * 1024, "the body stops at the 100 KiB bound");
  // Every surviving line is stripped of \r and ESC sequences (logEvent writes
  // verbatim — this helper is the chokepoint).
  const hostile = capTranscriptLines("run \r 1\nokay \x1b[31mRED\x1b[0m");
  assert.deepEqual(hostile, ["run  1", "okay RED"]);
});

test(":archive lists hostile rows single-line, newest first, with turns · bytes · age · manifest glyph", async () => {
  const t = fakeEA();
  assert.equal(await runCommand(t.app, "/archive"), true);
  await t.settle();
  assert.equal(t.mounted(), 1, "the archive picker mounted");
  const lines = t.top().render(80);
  assertRows(lines);
  const visible = strip(lines);
  assert.match(visible, /Archived on box/);
  // r12 m1: the name and cwd are device-authored AND land in label/description
  // paths pi-tui never LF-normalizes — both must collapse at compose time.
  assert.match(visible, /◈ nightly DIGEST/, "the hostile \\n in the name collapsed (label path)");
  assert.match(visible, /\/srv\/wor k/, "the hostile \\r\\n in the cwd collapsed");
  assert.match(visible, /12 turns/);
  assert.match(visible, /2\.0K/, "bundle size rides fmtBytes");
  // The description column clips at 80 cols — the full row text lives on the
  // item, which is exactly what render composes from.
  assert.match(t.top().items()[1]!.description!, /archived 15m ago/, "archived age");
  assert.match(t.top().items()[0]!.description!, /3 turns/);
  assert.match(visible, /◇ fresh/, "the manifest-less bundle gets its glyph");
  assert.match(visible, /r restore/, "the restore hotkey is advertised");
  // sorted archivedAt desc: new-1 (90s ago) rows before old-1 (15m ago).
  assert.equal(t.top().items()[0]!.value, "new-1");
  assert.equal(t.top().items()[1]!.value, "old-1");
  assert.ok(!visible.includes("d delete") && !visible.includes("x delete"), "no delete door is invented (SDK has none)");
});

test(":archive enter dumps the markdown transcript to the log view — capped, marker-led, rows stay up", async () => {
  const t = fakeEA();
  await runCommand(t.app, "/archive");
  await t.settle();
  t.top().pick(t.top().items()[0]); // new-1 → the 450-line transcript
  await t.settle(80);
  assert.deepEqual(t.calls.transcript, [["new-1", "markdown"]], "markdown is the requested format");
  const dump = t.logEvents.filter((e) => e.glyph === "arch");
  assert.equal(dump.length, 401, "marker + 400 lines, never the whole 450");
  assert.equal(dump[0]!.text, "... truncated (50 lines)", "the marker leads the dump");
  assert.equal(dump[1]!.text, "line 0");
  assertLogLines(dump);
  assert.ok(t.flashes.some((f) => /transcript/.test(f.text) && /log view: L/.test(f.text) && !f.error));
  assert.equal(t.mounted(), 1, "reading is read-only — the list stays up (pickNotify pattern)");

  // Under the caps (old-1, 4 lines incl. a blank, hostile \r and ESC): no
  // marker, and the control chars never reach the log ring.
  t.top().pick(t.top().items()[1]);
  await t.settle(80);
  const tail = t.logEvents.filter((e) => e.glyph === "arch").slice(-4);
  assert.deepEqual(tail.map((e) => e.text), ["# nightly", "", "run  1", "okay RED"]);
  assert.ok(!tail.some((e) => e.text.includes("... truncated")), "no marker under the cap");
  assertLogLines(t.logEvents.filter((e) => e.glyph === "arch"));
});

test(":archive r restores only behind the y/n gate: y restores + refetches, n keeps the bundle", async () => {
  const yes = fakeEA({ prompts: ["y"] });
  await runCommand(yes.app, "/archive");
  await yes.settle();
  yes.top().handleInput("r"); // fires on the highlighted row (new-1, newest)
  await yes.settle(60);
  assert.match(yes.prompts[0]!.label, /Restore fresh\? y\/n/, "the confirm oneLines the name");
  assert.deepEqual(yes.calls.restore, ["new-1"], "y ran restoreArchived");
  assert.ok(yes.flashes.some((f) => /restored .* — press g to open it/.test(f.text) && !f.error), JSON.stringify(yes.flashes));
  assert.ok(yes.logEvents.some((e) => e.glyph === "arch" && /restored/.test(e.text)));
  assert.equal(yes.calls.archived, 2, "the list refetched without the restored row");
  assert.equal(yes.mounted(), 1);
  assert.ok(!yes.top().items().some((i) => i.value === "new-1"), "the restored session left the archive list");
  assertRows(yes.top().render(80));

  const no = fakeEA({ prompts: ["n"] });
  await runCommand(no.app, "/archive");
  await no.settle();
  no.top().handleInput("r");
  await no.settle(60);
  assert.equal(no.calls.restore.length, 0, "n never restores");
  assert.ok(no.flashes.some((f) => /restore cancelled/.test(f.text) && !f.error));
  assert.equal(no.mounted(), 1, "a cancelled confirm leaves the picker up");
});

test(":archive empty list and fetch failure are honest toasts, not dead overlays", async () => {
  const empty = fakeEA();
  empty.archive.length = 0;
  await runCommand(empty.app, "/archive");
  await empty.settle();
  assert.equal(empty.mounted(), 0, "an empty archive does not mount an empty picker");
  assert.ok(empty.flashes.some((f) => /no archived sessions/.test(f.text) && !f.error));

  const down = fakeEA();
  (down.app as never as { client: { archived: () => Promise<never> } }).client.archived = async () => {
    throw new Error("device unreachable\nat tunnel");
  };
  await runCommand(down.app, "/archive");
  await down.settle();
  assert.equal(down.mounted(), 0);
  assert.ok(down.flashes.some((f) => f.error && /archive: device unreachable/.test(f.text)), JSON.stringify(down.flashes));
});
