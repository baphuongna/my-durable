// Real PTY keymap regression — EVERY advertised key, driven against a real
// backend, asserted on what the user sees. This exists because "phím điều
// hướng không xài được" was true three separate ways (group rows froze the
// cursor, esc interrupted instead of going back, and nothing said what the keys
// were). One key, one observable effect; a broken key fails here, not in the
// user's hands.
// Run: node tests/keymap-ui.mjs (requires tuistory).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { mkdtempSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";

const root = mkdtempSync(join(tmpdir(), "dpi-keymap-"));
for (const dir of ["alpha", "beta"]) await mkdir(join(root, "work", dir), { recursive: true });
// alpha is a git repo (with a commit) so /git exercises the real device API.
const sh = (cmd, args, opts = {}) =>
  new Promise((res, rej) => execFile(cmd, args, opts, (e, out) => (e ? rej(e) : res(String(out)))));
await sh("git", ["init", "-q", "-b", "main"], { cwd: join(root, "work", "alpha") });
await sh("git", ["config", "user.email", "t@t"], { cwd: join(root, "work", "alpha") });
await sh("git", ["config", "user.name", "t"], { cwd: join(root, "work", "alpha") });
await (async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "work", "alpha", "a.txt"), "one\n");
})();
await sh("git", ["add", "."], { cwd: join(root, "work", "alpha") });
await sh("git", ["commit", "-qm", "first"], { cwd: join(root, "work", "alpha") });
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
    DPI_DEVICE_NAME: "keybox",
  },
  stdio: ["ignore", openSync(join(root, "dev.log"), "a"), openSync(join(root, "dev.log"), "a")],
});
const devExit = new Promise((r) => dev.on("exit", r));
const run = (cmd, args) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { cwd: resolve(import.meta.dirname, "..") }, (e, out) => (e ? rej(e) : res(String(out)))),
  );

const session = `dpi-keymap-${Date.now()}`;
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

/** Marker + name of the selected herd row (▌ is the cursor column). */
const selected = async () => {
  const m = (await snap()).match(/▌ (\S+)/);
  return m?.[1] ?? null;
};
const body = async () => {
  const screen = await snap();
  return screen;
};

/** Back to a known state: close any overlay/input, then the herd view. */
const reset = async () => {
  for (let i = 0; i < 3; i += 1) {
    await tui("press", "esc").catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
  }
  await press("g");
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
    console.log(screen.split("\n").slice(0, 14).join("\n"));
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
  await tui("wait", "no sessions yet", "--timeout", "20000").catch(() => {});
  await tui("wait", "alpha", "--timeout", "20000");

  // ---------------------------------------------------------------- herd keys
  await check("herd: j moves the cursor down, k moves it back", async () => {
    await press("j");
    const first = await selected();
    await press("j");
    const second = await selected();
    assert.ok(second && second !== first, `j did not move (${first} → ${second})`);
    await press("k");
    assert.equal(await selected(), first, "k did not return");
  });

  await check("herd: ↓/↑ are the same movement as j/k", async () => {
    for (let i = 0; i < 5; i += 1) await press("k"); // start at the top row
    const first = await selected();
    await press("down");
    const second = await selected();
    assert.ok(second && second !== first, "down did nothing");
    await press("up");
    assert.equal(await selected(), first, "up did not return");
  });

  await check("herd: j never lands on a group header (cursor always names a session)", async () => {
    for (let i = 0; i < 4; i += 1) {
      await press("j");
      const name = await selected();
      assert.ok(name && ["alpha", "beta"].includes(name), `cursor on a non-session row: ${name}`);
    }
    for (let i = 0; i < 4; i += 1) await press("k");
  });

  await check("herd: enter opens the selected session", async () => {
    await press("j"); // ensure a session row
    const name = await selected();
    await press("enter");
    assert.match(await body(), new RegExp(`› ${name} › #1`), "agent view did not open");
  });

  await check("agent: esc goes BACK to the herd (it used to interrupt)", async () => {
    await press("escape");
    assert.match(await body(), /NAME\s+STATE\s+AGENTS/, "esc did not return to the list");
  });

  await check("herd: digits open the nth session", async () => {
    // Order is newest-first, so derive the expectation from what each digit did
    // rather than assuming which name sits at which index.
    const opened = async (n) => {
      await press(String(n));
      const m = (await body()).match(/› (\S+) › #1/);
      await press("escape");
      return m?.[1] ?? null;
    };
    const first = await opened(1);
    const second = await opened(2);
    assert.ok(first && second, `digit jump opened nothing (${first}, ${second})`);
    assert.notEqual(first, second, "digits 1 and 2 opened the same session");
  });

  await check("herd: N opens the network view", async () => {
    await press("N");
    assert.match(await body(), /keybox/, "network view lost the device");
    assert.doesNotMatch(await body(), /NAME\s+STATE\s+AGENTS\s+AGE/, "still the herd table");
  });

  await check("herd: g comes back to the herd", async () => {
    await press("g");
    assert.match(await body(), /NAME\s+STATE\s+AGENTS/, "g did not return to the herd");
  });

  await check("herd: L opens the event log", async () => {
    await press("L");
    assert.match(await body(), /events · this client/, "log view did not open");
    await press("g");
  });

  await check("herd: f opens the filter line", async () => {
    await press("f");
    assert.match(await body(), /filter ❯/, "no filter line");
    await type("alpha");
    await press("enter");
    assert.match(await body(), /filter: alpha/, "filter was not applied");
    await press("escape");
  });

  await check("herd: ? opens the in-frame help", async () => {
    await press("?");
    const screen = await body();
    assert.match(screen, /keys|help/i, "no help panel");
    await press("escape");
  });

  await check("herd: : opens the palette", async () => {
    await press(":");
    assert.match(await body(), /palette/i, "no palette line");
    await press("escape");
  });

  await check("herd: n opens the new-session line", async () => {
    await press("n");
    assert.match(await body(), /new session/, "no new-session prompt");
    await press("escape");
  });

  await check("herd: x asks before resetting a session's context", async () => {
    await press("j");
    await press("x");
    assert.match(await body(), /reset .*\? y\/n/i, "no reset confirmation");
    await type("n");
    await press("enter");
    assert.match(await body(), /cancelled/i, "n did not cancel the reset");
  });

  // --------------------------------------------------------------- agent keys
  await check("agent: enter opens, m opens the follow-up line, esc cancels it", async () => {
    await press("enter");
    await press("m");
    assert.match(await body(), /follow-up ❯/, "no follow-up line");
    await press("escape");
    assert.match(await body(), /transcript/, "esc left the agent view");
  });

  // Each tab renders its own body: the tab bar itself only differs by inverse.
  const tabBody = async () => (await snap()).split("\n").slice(6, 12).join("\n");

  await check("agent: ] walks the five tabs, [ walks back", async () => {
    await press("enter");
    const seen = [await tabBody()];
    for (let i = 0; i < 4; i += 1) {
      await press("]");
      seen.push(await tabBody());
    }
    assert.equal(new Set(seen).size, 5, `expected 5 distinct tab bodies, got ${new Set(seen).size}`);
    assert.match(seen.join("\n"), /provider|thinking/, "the state tab never rendered");
    assert.match(seen.join("\n"), /tool calls/, "the tools tab never rendered");
    for (let i = 0; i < 4; i += 1) await press("[");
    assert.equal(await tabBody(), seen[0], "[ did not walk back to the first tab");
  });

  await check("agent: tab and shift+tab cycle the tabs too", async () => {
    await press("enter");
    const before = await tabBody();
    await press("tab");
    assert.notEqual(await tabBody(), before, "tab did nothing");
    await tui("press", "shift", "tab");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await tabBody(), before, "shift+tab did not return");
  });

  await check("agent: ctrl+o toggles full tool output", async () => {
    await press("ctrl", "o");
    assert.match(await body(), /expand on/, "no expand notice");
    await press("ctrl", "o");
  });

  await check("agent: ctrl+l opens the model picker", async () => {
    await press("ctrl", "l");
    assert.match(await body(), /Model \(/, "no model picker");
    await press("escape");
  });

  await check("agent: g returns to the herd, N to the network", async () => {
    await press("g");
    assert.match(await body(), /NAME\s+STATE\s+AGENTS/, "g did not leave the agent view");
    await press("N");
    assert.match(await body(), /keybox/, "N did not open the network");
    await press("g");
  });

  // ------------------------------------------------------ slash autocomplete
  // "/" alone lists every command, so the rows are deterministic:
  // sessions, agents, model, devices, new, fork, … (COMMANDS order).
  await check("slash: ↓ steers the list, enter completes the highlighted row", async () => {
    await press("enter"); // the agent view
    await press("m");
    await type("/");
    assert.match(await body(), /\/sessions/, "the suggestion list did not open for /");
    await press("down"); // onto "agents"
    await press("enter"); // complete → "/agents "
    const screen = await body();
    assert.match(screen, /follow-up ❯ \/agents/, "enter did not complete the second row");
    assert.doesNotMatch(screen, /no command/, "enter submitted instead of completing");
    await press("escape");
  });

  await check("slash: completed text runs on the second enter", async () => {
    await press("enter");
    await press("m");
    await type("/mo"); // one match: model
    await press("enter"); // complete → "/model "
    assert.match(await body(), /follow-up ❯ \/model/, "the row was not completed");
    await press("enter"); // run it
    assert.match(await body(), /Model \(/, "the completed /model did not run");
    await press("escape");
    await press("escape");
  });

  await check("slash: tab completes row 1; ↑ walks back up after ↓↓", async () => {
    await press("enter");
    await press("m");
    await type("/");
    await press("tab");
    assert.match(await body(), /follow-up ❯ \/sessions/, "tab did not complete the first row");
    await press("backspace"); // "/sessions" → the list reopens with one row… type a fresh prefix instead
    for (let i = 0; i < 9; i += 1) await press("backspace");
    await type("/");
    await press("down");
    await press("down"); // onto "model"
    await press("up"); // back onto "agents"
    await press("enter");
    assert.match(await body(), /follow-up ❯ \/agents/, "↑ did not walk back up the list");
    await press("escape");
    await press("escape");
  });

  // ------------------------------------------------- view cycling (reported:
  // "không điều hướng xem tab khác ngoài tab session đầu nhất" — Tab on the
  // outermost list used to do nothing; now it cycles the four views, pi-style.)
  await check("herd: tab walks herd→network→agent, L reaches the log, tab wraps home", async () => {
    await press("tab");
    assert.match(await body(), /keybox/, "tab from herd did not reach the network view");
    await press("tab");
    assert.match(await body(), /#1\s+idle|#1/, "tab from network did not reach the agent view");
    // inside the agent view Tab belongs to the AGENT's tab strip (pi semantics):
    // views keep their direct keys — L for the log.
    await press("L");
    assert.match(await body(), /events · this client/, "L from agent did not reach the log");
    await press("tab");
    assert.match(await body(), /NAME\s+STATE\s+AGENTS/, "tab from log did not wrap to the herd");
    await tui("press", "shift", "tab");
    await new Promise((r) => setTimeout(r, 300));
    assert.match(await body(), /events · this client/, "shift+tab did not step back to the log");
  });

  await check("herd: [ and ] step the views one at a time", async () => {
    await press("]");
    assert.match(await body(), /keybox/, "] did not go forward to network");
    await press("[");
    assert.match(await body(), /NAME\s+STATE\s+AGENTS/, "[ did not come back to herd");
  });

  await check("network: enter on the local device row returns to its sessions", async () => {
    await press("N");
    await press("enter");
    assert.match(await body(), /NAME\s+STATE\s+AGENTS/, "enter on the device row did not open its herd");
  });

  await check("herd: a/d speak when nothing waits instead of silence", async () => {
    await press("a");
    assert.match(await body(), /nothing is waiting for approval/, "a said nothing");
  });

  await check("herd: palette runs a command", async () => {
    await press(":");
    await tui("type", "net");
    await new Promise((r) => setTimeout(r, 250));
    await press("enter");
    assert.match(await body(), /keybox/, "palette 'network' did not switch the view");
    await press("g");
  });

  await check("herd: filter narrows LIVE while typing, esc aborts and clears", async () => {
    await press("f");
    await tui("type", "alp");
    await new Promise((r) => setTimeout(r, 350));
    const narrowed = await body();
    assert.match(narrowed, /~\/alpha\//, "alpha group missing while typing");
    assert.doesNotMatch(narrowed, /~\/beta\//, "beta group survived a live 'alp' filter");
    await press("escape"); // abort the line — the needle must not linger
    await new Promise((r) => setTimeout(r, 300));
    const back = await body();
    assert.match(back, /~\/beta\//, "esc did not abort the filter back to the full list");
    assert.match(back, /~\/alpha\//, "full list lost the alpha group");
  });

  await check("agent: y cycles the thinking level", async () => {
    await press("enter");
    await press("y");
    assert.match(await body(), /thinking: /, "y produced no thinking notice");
    await press("esc");
  });

  await check("log: events accumulate while you drive the app", async () => {
    await press("L");
    const m = (await body()).match(/(\d+) events · this client/);
    assert.ok(m, "log header missing");
    assert.ok(Number(m[1]) > 0, "no events recorded");
  });

  // ------------------------------------------------------ branch per row
  await check("herd: every session row shows ⎇ branch (batched, no typing)", async () => {
    await tui("wait", "⎇ main", "--timeout", "10000");
    const rows = await body();
    assert.match(rows, /alpha.*⎇ main|⎇ main.*alpha/s, "alpha row lost its branch");
  });

  // ------------------------------------------------------ ambient git display
  await check("git: the OVERVIEW panel shows ⎇ branch ±dirty without any command", async () => {
    await press("2"); // alpha, the git repo
    await tui("wait", "⎇ main", "--timeout", "8000");
    const panel = await body();
    assert.match(panel, /⎇ main/, "no branch line in the OVERVIEW panel");
    await press("esc");
  });

  await check("git: the agent header carries the branch too", async () => {
    await press("2");
    await tui("wait", /#1/, "--timeout", "6000").catch(async () => {
      await press("enter");
    });
    await tui("wait", "⎇ main", "--timeout", "8000");
    assert.match(await body(), /⎇ main/, "agent header lost the branch");
    await press("esc");
  });

  // ------------------------------------------------------ /git (device API)
  await check("git: /git status shows branch and dirty for the session's repo", async () => {
    await press("2"); // digits jump: alpha is the 2nd session and the git repo
    await press("m");
    await type("/git");
    await press("enter");
    assert.match(await body(), /⎇ main/, "no branch in the status toast");
    await press("escape");
    await press("esc");
  });

  await check("git: /git worktree new creates a sibling worktree", async () => {
    await press("2");
    await press("m");
    await type("/git worktree new wtx");
    await press("enter");
    await tui("wait", "worktree add", "--timeout", "8000").catch(() => {});
    const list = await (async () => {
      await press("m");
      await type("/git worktree");
      await press("enter");
      await press("L");
      return body();
    })();
    assert.match(list, /wtx/, "worktree not listed in the log view");
    await press("g");
  });

  await check("herd: q quits the app", async () => {
    await press("q");
    await new Promise((r) => setTimeout(r, 800));
    // The PTY keeps its last buffer after exit, so the process status is the
    // only honest signal that q really quit.
    const list = await run("tuistory", ["sessions"]).catch(() => "");
    const line = list.split("\n").findIndex((l) => l.includes(session));
    const status = line >= 0 ? list.split("\n")[line + 1] : "";
    assert.match(status, /dead/, `still alive after q (status: ${status.trim()})`);
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
  console.error(`\nkeymap-ui: ${failures} key(s) broken`);
  process.exit(1);
}
console.log("\nkeymap-ui: ALL PASS");
