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
