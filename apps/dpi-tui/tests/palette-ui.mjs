/**
 * Command palette + filter affordances (v0.0.53 fixes) — real PTY regression.
 * (1) palette enter resolves the SAME list the live filter shows ("device
 *     events" → the `log` row, not ◆ no command),
 * (2) the palette carries every slash command + the 4 view switches,
 * (3) newly added palette entries actually run (thinking, name, tasks),
 * (4) a herd filter matching nothing shows the muted empty-state line,
 * (5) the log view keeps a persistent `filter: X` indicator; esc clears both.
 * Same harness pattern as tests/navredesign-ui.mjs (backend + tuistory).
 * Run: node tests/palette-ui.mjs (requires tuistory).
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { mkdtempSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";

const root = mkdtempSync(join(tmpdir(), "dpi-pal-"));
for (const dir of ["alpha", "beta"]) await mkdir(join(root, "work", dir), { recursive: true });
const backendDir = resolve(import.meta.dirname, "../../dpi-backend");

const freePort = async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
};
const port = await freePort();
const token = "dpi_" + "K".repeat(43);
const url = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const dev = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--port", String(port), "--host", "127.0.0.1"], {
  cwd: backendDir,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DPI_HOME: join(root, "home"),
    DPI_ENV_FILE: join(root, "home", "none.env"),
    DPI_TOKEN: token,
    DPI_PROVIDER: "faux",
    DPI_START_DIRS: join(root, "work"),
    DPI_DEVICE_NAME: "palbox",
  },
  stdio: ["ignore", openSync(join(root, "dev.log"), "a"), openSync(join(root, "dev.log"), "a")],
});
const devExit = new Promise((r) => dev.on("exit", r));
const run = (cmd, args) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { cwd: resolve(import.meta.dirname, "..") }, (e, out) => (e ? rej(e) : res(String(out)))),
  );

const session = `dpi-pal-${Date.now()}`;
const tui = (...args) => run("tuistory", ["-s", session, ...args]);
const snap = () => tui("snapshot", "--trim");
const press = async (...keys) => {
  await tui("press", ...keys);
  await new Promise((r) => setTimeout(r, 450));
};
const type = async (text) => {
  await tui("type", text);
  await new Promise((r) => setTimeout(r, 200));
};
/** Open the palette, type a query, return the snapshot with the panel up. */
const palette = async (query) => {
  await press(":");
  if (query) await type(query);
  return snap();
};

const onHerd = async (s) => assert.match(s ?? (await snap()), /NAME\s+STATE\s+AGENTS/, "expected the herd table");
const onLog = async (s) => assert.match(s ?? (await snap()), /events · this client/, "expected the log view");

const reset = async () => {
  for (let i = 0; i < 4; i += 1) {
    await tui("press", "esc").catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
  }
  await press("1"); // a known home: the network view
};

let failures = 0;
const check = async (name, fn) => {
  try {
    await reset();
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`);
    const screen = await snap().catch(() => "");
    console.log(screen.split("\n").slice(0, 18).join("\n"));
  }
};

try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try {
      up = (await fetch(`${url}/healthz`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(up, "backend booted");
  for (const name of ["alpha", "beta"]) {
    const res = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name, cwd: join(root, "work", name), model: { provider: "faux", modelId: "echo" } }),
    });
    assert.equal(res.status, 201, await res.text());
  }

  await tui("launch", `node --import tsx src/main.ts --url ${url} --token ${token}`, "--background", "--cols", "120", "--rows", "26");
  await tui("wait", "1 network", "--timeout", "20000");

  // Open one session once, so later checks ride on a settled herd/agent state.
  await press("2");
  await onHerd();
  await press("enter");

  // ------------------------------------ (1) enter resolves the filtered list
  await check("palette: 'device events' + enter opens the log view (the row the filter showed)", async () => {
    const open = await palette("device events");
    assert.match(open, /log\s+device events/, "the palette did not narrow to the log row");
    await press("enter");
    const screen = await snap();
    assert.doesNotMatch(screen, /no command/, "enter still ran nothing for 'device events'");
    await onLog(screen);
  });

  await check("palette: exact name wins, ambiguous query still toasts — deterministic", async () => {
    await press(":");
    await type("net");
    await press("enter"); // narrows to exactly `network` → the view switches
    assert.match(await snap(), /palbox/, "uniquely narrowed 'net' did not run network");
    await press(":");
    await type("e"); // matches many rows → keep the no-command toast
    await press("enter");
    assert.match(await snap(), /no command .*e/, "ambiguous 'e' should keep the no-command toast");
  });

  // ------------------------------ (2) full inventory: 15 commands + 4 views
  await check("palette: lists every slash command plus the 4 view switches", async () => {
    const screen = await palette("");
    const entries = [
      ["herd", "session dashboard"],
      ["network", "devices and sessions"],
      ["agent", "back to the conversation"],
      ["log", "device events"],
      ["sessions", "switch or create"],
      ["agents", "roots, forks, subagents"],
      ["model", "agent's model"],
      ["devices", "switch device"],
      ["new", "new agent"],
      ["fork", "last reply"],
      ["thinking", "thinking level"],
      ["compact", "older context"],
      ["reset", "fresh context"],
      ["name", "rename this agent"],
      ["tasks", "live tasks"],
      ["git", "session's folder"],
      ["help", "keys and commands"],
      ["pair", "hub"],
      ["quit", "the agent keeps running"],
    ];
    assert.equal(entries.length, 19, "inventory drift: 4 views + 15 commands expected");
    for (const [name, hint] of entries)
      assert.match(screen, new RegExp(`${name}\\s+.*${hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `palette row '${name}' missing/not showing hint`);
    await press("escape");
  });

  // ------------------------------ (3) the new entries actually run
  await check("palette: 'thinking' opens the thinking-level picker (no dead-end flash)", async () => {
    await palette("thinking");
    await press("enter");
    const screen = await snap();
    assert.match(screen, /Thinking level/, "the thinking picker did not open after palette enter");
    assert.match(screen, /off/, "the picker does not list the levels");
    assert.doesNotMatch(screen, /✗ Levels:/, "the old dead-end levels flash still shows");
    await press("escape");
    assert.doesNotMatch(await snap(), /Thinking level/, "esc closed the thinking picker");
  });

  await check("palette: 'name' opens the rename Prompt (no usage dead-end)", async () => {
    await palette("name");
    await press("enter");
    const screen = await snap();
    assert.match(screen, /Agent name/, "the rename prompt did not open after palette enter");
    assert.doesNotMatch(screen, /Usage: \/name/, "the old usage dead-end still shows");
    await press("escape"); // cancel — nothing renamed
    assert.doesNotMatch(await snap(), /Agent name/, "esc closed the rename prompt");
  });

  await check("palette: 'tasks' runs the /tasks handler (overlay panel with visible content)", async () => {
    await palette("tasks");
    await press("enter");
    const screen = await snap();
    assert.match(screen, /(Live tasks|No live tasks)/, "the tasks panel did not open");
    assert.match(screen, /No live tasks\./, "the empty task list is not announced in words");
    assert.match(screen, /esc close/, "the tasks panel shows no visible close hint (invisible overlay)");
    await press("escape");
    assert.doesNotMatch(await snap(), /No live tasks/, "esc did not close the tasks panel");
  });

  // ------------------------------ (4) herd empty state for a dead filter
  await check("herd: filter 'zzz' explains itself instead of 0 silent rows", async () => {
    await press("2");
    await press("f");
    await type("zzz");
    const narrowed = await snap();
    assert.match(narrowed, /no sessions match .*zzz.* — esc clears/, "no empty-state line for a dead filter");
    assert.doesNotMatch(narrowed, /~\/alpha\//, "alpha group survived a 'zzz' filter");
    await press("enter"); // commit, then esc must clear both indicator and rows
    await press("escape");
    const cleared = await snap();
    assert.doesNotMatch(cleared, /no sessions match/, "esc did not clear the empty-state line");
    assert.match(cleared, /~\/(alpha|beta)\//, "esc did not bring the sessions back");
  });

  // ------------------------------ (5) log view persistent filter indicator
  await check("log: committed filter keeps a persistent indicator; esc clears it", async () => {
    await press("4");
    await onLog();
    await press("f");
    await type("zzz");
    await press("enter"); // commit — the toast fades, the indicator must stay
    const filtered = await snap();
    assert.match(filtered, /filter: zzz · \d+\/\d+ shown — esc clears/, "no persistent filter indicator in the log view");
    await press("escape");
    const cleared = await snap();
    assert.doesNotMatch(cleared, /filter: zzz · \d+\/\d+ shown/, "esc did not clear the log filter indicator");
    await onLog(cleared);
  });

  // ------------------------------ (2b) EVERY entry runs — walk all 19
  // FIX 2's acceptance: “Every palette entry must actually run when selected.”
  // Each row is driven through the real palette and must leave an observable
  // effect (view switch, picker/overlay, or toast). reset now confirms y/n
  // before it wipes (R4 finding 4), thinking/name open their flows (R4 finding
  // 2) — the loop completes those flows with the keys a user would send. quit
  // goes last — it exits.
  await check("palette: every one of the 19 entries actually runs", async () => {
    const expect = [
      ["herd", /NAME\s+STATE\s+AGENTS/],
      ["network", /palbox/],
      ["agent", /› \S+ › #\d+/],
      ["log", /events · this client/],
      ["sessions", /Sessions on /],
      ["agents", /Agents in (alpha|beta)/],
      ["model", /Model \(/],
      ["devices", /Devices|No saved devices/],
      ["new", /New agent /],
      ["fork", /Forked at #|Nothing to fork yet/],
      ["thinking", /Thinking level/],
      ["compact", /Compaction requested|✗/],
      ["reset", /reset .*y\/n/i],
      ["name", /Agent name/],
      ["tasks", /(Live tasks|No live tasks)/],
      ["git", /is not a git repository|⎇/],
      ["help", /\/sessions\s+switch or create a session/],
      ["pair", /Usage: \/pair|pair/],
    ];
    for (const [name, re] of expect) {
      await palette(name);
      await press("enter");
      const screen = await snap();
      assert.match(screen, re, `palette '${name}' left no observable effect`);
      assert.doesNotMatch(screen, /no command/, `palette '${name}' refused to run`);
      if (name === "thinking") {
        await press("escape"); // close the picker; the flow door is pinned above
      } else if (name === "name") {
        await press("escape"); // cancel the rename prompt
      } else if (name === "reset") {
        await type("y");
        await press("enter");
        assert.match(await snap(), /New context started/, "the confirmed reset did not run");
      }
      await reset();
    }
    // quit: the honest signal is the process status, not the frozen PTY buffer.
    await palette("quit");
    await press("enter");
    await new Promise((r) => setTimeout(r, 800));
    const list = await run("tuistory", ["sessions"]).catch(() => "");
    const line = list.split("\n").findIndex((l) => l.includes(session));
    const status = line >= 0 ? list.split("\n")[line + 1] : "";
    assert.match(status, /dead/, `still alive after palette quit (status: ${status.trim()})`);
    // Relaunch so the harness teardown (tui close) still finds a session.
    await tui("launch", `node --import tsx src/main.ts --url ${url} --token ${token}`, "--background", "--cols", "120", "--rows", "26");
    await tui("wait", "1 network", "--timeout", "20000");
  });
} finally {
  await tui("close").catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
  if (dev.exitCode === null) {
    dev.kill("SIGTERM");
    await Promise.race([devExit, new Promise((r) => setTimeout(r, 3000))]);
  }
}
if (failures) {
  console.error(`\npalette-ui: ${failures} check(s) broken`);
  process.exit(1);
}
console.log("\npalette-ui: ALL PASS");
