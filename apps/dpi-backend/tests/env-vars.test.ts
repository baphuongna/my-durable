/**
 * The device env-file editor ("Env-var management UI", Wave 2 SHOULD of
 * docs/host-project-checklist.md): masked reads, guarded writes, and the
 * process-vs-file distinction that decides what is editable at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EnvError, EnvFileEditor, maskValue, type EnvIo } from "../src/env-vars.js";

/** In-memory io: the file is a string, processEnv is a fixed snapshot. */
function fakeIo(initial = "", processEnv: Record<string, string | undefined> = {}) {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  if (initial) files.set("/env", initial);
  const io: EnvIo = {
    readFile: async (p) => {
      if (!files.has(p)) throw Error("ENOENT");
      return files.get(p)!;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
      modes.set(p, 0o600);
    },
    chmod: async (p, mode) => void modes.set(p, mode),
    exists: async (p) => files.has(p),
    processEnv: () => processEnv,
  };
  return { io, files, modes };
}

test("view masks secret-looking values and never returns them", async () => {
  const { io } = fakeIo(
    "DPI_NOTIFY_ALLOW_PRIVATE=1\nMY_PROVIDER_TOKEN=supersecretvalue123\n# a comment\n\nPLAIN_TEXT=hello\n",
    { DPI_HUB_URL: "https://hub.example", DPI_SSH_KEY: "ssh-priv" },
  );
  const editor = new EnvFileEditor("/env", io);
  const view = await editor.view();
  const byKey = Object.fromEntries(view.vars.map((v) => [v.key, v]));

  assert.equal(byKey.DPI_NOTIFY_ALLOW_PRIVATE.masked, "1");
  assert.equal(byKey.DPI_NOTIFY_ALLOW_PRIVATE.source, "file");
  assert.ok(!view.vars.some((v) => v.masked.includes("supersecret")), "the secret value leaked");
  assert.match(byKey.MY_PROVIDER_TOKEN.masked, /^•{8}e123$/);
  // Process-only DPI_* vars appear read-only.
  assert.equal(byKey.DPI_HUB_URL.source, "process");
  assert.equal(byKey.DPI_HUB_URL.masked, "https://hub.example");
  assert.equal(byKey.DPI_SSH_KEY.source, "process");
  assert.ok(!byKey.DPI_SSH_KEY.masked.includes("ssh-priv"));
  assert.ok(view.restartRequired === false, "nothing changed yet");
});

test("set adds a new key, updates an existing one and preserves comments and order", async () => {
  const { io, files } = fakeIo("# owned by ops\nEXISTING=old\n");
  const editor = new EnvFileEditor("/env", io);
  await editor.set("NEW_KEY", "fresh");
  await editor.set("EXISTING", "new");
  const text = files.get("/env")!;
  assert.match(text, /^# owned by ops\nEXISTING=new\nNEW_KEY=fresh\n$/);
  const view = await editor.view();
  assert.ok(view.restartRequired, "a write sets the restart hint");
});

test("set refuses managed/self-referential keys, bad names and multi-line values", async () => {
  const { io } = fakeIo("X=1\n");
  const editor = new EnvFileEditor("/env", io);
  for (const key of ["DPI_TOKEN", "DPI_PORT", "DPI_START_DIRS", "DPI_HOME", "DPI_ENV_FILE", "DPI_DATA_DIR"]) {
    await assert.rejects(() => editor.set(key, "v"), (e: unknown) => {
      assert.ok(e instanceof EnvError);
      assert.equal(e.code, "invalid");
      return true;
    }, `${key} must be refused`);
  }
  await assert.rejects(() => editor.set("lowercase", "v"), /UPPER_SNAKE_CASE/);
  await assert.rejects(() => editor.set("GOOD_KEY", "a\nb"), /single line/);
  await assert.rejects(() => editor.set("GOOD_KEY", ""), /value is required/);
});

test("unset removes only the named line; unknown keys are a no-op", async () => {
  const { io, files } = fakeIo("A=1\nB=2\nC=3\n");
  const editor = new EnvFileEditor("/env", io);
  assert.deepEqual(await editor.unset("B"), { removed: true });
  assert.equal(files.get("/env"), "A=1\nC=3\n");
  assert.deepEqual(await editor.unset("NOPE"), { removed: false });
});

test("maskValue keeps a recognisable tail but never the middle", () => {
  assert.equal(maskValue("short"), "•••••");
  assert.equal(maskValue("0123456789abcdef"), "••••••••cdef");
  assert.equal(maskValue(""), "••••");
});

test("a missing file views as empty-but-existing-path, and set creates it", async () => {
  const { io, files } = fakeIo("");
  const editor = new EnvFileEditor("/env", io);
  const view = await editor.view();
  assert.equal(view.exists, false);
  assert.deepEqual(view.vars, []);
  await editor.set("DPI_SSH_KNOWN_HOSTS", "/etc/known");
  assert.equal(files.get("/env"), "DPI_SSH_KNOWN_HOSTS=/etc/known\n");
});

test("CRLF files parse cleanly: no trailing \\r reaches a value (Notepad-edited keys)", async () => {
  const { io, files } = fakeIo("KEY=abc\r\nOTHER=def\r\n");
  const editor = new EnvFileEditor("/env", io);
  const view = await editor.view();
  const byKey = Object.fromEntries(view.vars.map((v) => [v.key, v]));
  assert.equal(byKey.KEY?.masked, "abc", `got ${JSON.stringify(byKey.KEY?.masked)}`);
  assert.equal(byKey.OTHER?.masked, "def", `got ${JSON.stringify(byKey.OTHER?.masked)}`);
  // Write-back on the same file: the edited line is stored without \r, and
  // untouched lines keep their content (endings normalize to LF).
  await editor.set("OTHER", "xyz");
  assert.equal(files.get("/env"), "KEY=abc\nOTHER=xyz\n");
});

test("a value with intentional trailing spaces is preserved verbatim (no trim beyond the CR fix)", async () => {
  const { io, files } = fakeIo("SPACED_VALUE=keep  \n");
  const editor = new EnvFileEditor("/env", io);
  const view = await editor.view();
  assert.equal(view.vars.find((v) => v.key === "SPACED_VALUE")?.masked, "keep  ");
  // Rewriting an unrelated line must not trim the spaced value either.
  await editor.set("OTHER", "x");
  assert.equal(files.get("/env"), "SPACED_VALUE=keep  \nOTHER=x\n");
});
