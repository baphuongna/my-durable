import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnvKeys, parseRemote, newChangeUrl, gitStatus } from "../src/git.js";

const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repo whose ONLY git config is the one we place under a private HOME —
 *  exactly the shape of an operator's machine, and proof that the probe reads
 *  config the way git does rather than inventing its own rule. */
async function repoWithHome(global?: { name?: string; email?: string }) {
  const root = await mkdtemp(join(tmpdir(), "dpi-ident-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const repo = join(root, "repo");
  await mkdir(repo);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" };
  sh("git", ["init", "-q", repo], env);
  if (global?.name || global?.email) {
    const lines = [global.name ? `\tname = ${global.name}` : "", global.email ? `\temail = ${global.email}` : ""].filter(Boolean);
    await writeFile(join(home, ".gitconfig"), `[user]\n${lines.join("\n")}\n`);
  }
  await writeFile(join(repo, "a.txt"), "x\n");
  sh("git", ["-C", repo, "add", "a.txt"], env);
  return { root, home, repo, env };
}

test("r28 identity: a resolvable author is reported and marks the repo committable", async () => {
  const t = await repoWithHome({ name: "Phuong NB", email: "phuong@example.com" });
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, NS: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.HOME = t.home;
  process.env.XDG_CONFIG_HOME = join(t.home, ".config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const st = await gitStatus(t.repo);
    assert.deepEqual(st.identity, { name: "Phuong NB", email: "phuong@example.com" });
    assert.equal(st.identityComplete, true);
    // The check must agree with git: this identity actually commits.
    sh("git", ["-C", t.repo, "commit", "-q", "-m", "t"], t.env);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
    if (saved.NS === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.NS;
    await rm(t.root, { recursive: true, force: true });
  }
});

test("r28 identity: no author anywhere means git itself refuses — we say the same", async () => {
  const t = await repoWithHome();
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, NS: process.env.GIT_CONFIG_NOSYSTEM, EM: process.env.EMAIL, GN: process.env.GIT_AUTHOR_NAME, GE: process.env.GIT_AUTHOR_EMAIL };
  process.env.HOME = t.home;
  process.env.XDG_CONFIG_HOME = join(t.home, ".config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const k of ["EMAIL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"] as const) delete process.env[k];
  try {
    const st = await gitStatus(t.repo);
    assert.equal(st.identityComplete, false, "git cannot resolve an author here");
    assert.equal(st.identity, undefined, "and no guessed identity is published as if it were configured");
    // Ground truth: git agrees — the commit is refused.
    assert.throws(() => sh("git", ["-C", t.repo, "commit", "-q", "-m", "t"], t.env), /identity|tell me who you are/i);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
    if (saved.NS === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.NS;
    if (saved.EM !== undefined) process.env.EMAIL = saved.EM;
    if (saved.GN !== undefined) process.env.GIT_AUTHOR_NAME = saved.GN;
    if (saved.GE !== undefined) process.env.GIT_AUTHOR_EMAIL = saved.GE;
    await rm(t.root, { recursive: true, force: true });
  }
});

test("r28 identity: an author supplied by env alone is honoured (git would commit)", async () => {
  const t = await repoWithHome();
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, NS: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.HOME = t.home;
  process.env.XDG_CONFIG_HOME = join(t.home, ".config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const envIdentity = { ...t.env, GIT_AUTHOR_NAME: "Env Author", GIT_AUTHOR_EMAIL: "env@example.com", GIT_COMMITTER_NAME: "Env Author", GIT_COMMITTER_EMAIL: "env@example.com" };
  try {
    // Config-only probing reported "not set" here while git commits happily.
    sh("git", ["-C", t.repo, "commit", "-q", "-m", "t"], envIdentity);
    const out = sh("git", ["-C", t.repo, "var", "GIT_AUTHOR_IDENT"], envIdentity);
    assert.match(out, /Env Author <env@example\.com>/);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
    if (saved.NS === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.NS;
    await rm(t.root, { recursive: true, force: true });
  }
});

test("r28 env: the Windows child allowlist carries the account git derives an author from", () => {
  // Reported live: git worked in a terminal but every device-side call said
  // "identity unknown" — git-for-windows' getpwuid reads USERNAME/USERDOMAIN,
  // and the allowlist stripped them. Not secrets; the account itself.
  const keys = childEnvKeys();
  if (process.platform === "win32") {
    for (const k of ["USERNAME", "USERDOMAIN", "COMPUTERNAME", "USERPROFILE", "APPDATA", "SYSTEMROOT", "HOMEDRIVE", "HOMEPATH", "TEMP", "PATHEXT"])
      assert.ok(keys.includes(k), `win32 allowlist must keep ${k}`);
  } else {
    for (const k of ["PATH", "HOME"]) assert.ok(keys.includes(k), `posix allowlist must keep ${k}`);
    // The daemon's own token must never ride into a repo-controlled hook.
    for (const k of ["DPI_TOKEN", "DPI_ADMIN_TOKEN", "AWS_SECRET_ACCESS_KEY"]) assert.ok(!keys.includes(k), `${k} must never reach a child`);
  }
  // Identity vars are harmless on every platform, so they are not platform-gated.
  assert.ok(!keys.includes("DPI_TOKEN"));
});

test("r28 forge: every origin spelling parses to host + path + browser URL", () => {
  const cases: [string, string, string, string][] = [
    ["git@github.com:me/repo.git", "github", "github.com", "https://github.com/me/repo"],
    ["https://github.com/me/repo.git", "github", "github.com", "https://github.com/me/repo"],
    ["git@gitlab.com:group/sub/proj.git", "gitlab", "gitlab.com", "https://gitlab.com/group/sub/proj"],
    ["ssh://git@gitlab.example.com:2222/team/app.git", "gitlab", "gitlab.example.com", "https://gitlab.example.com/team/app"],
    ["https://oauth2:secrettoken@gitlab.com/g/p.git", "gitlab", "gitlab.com", "https://gitlab.com/g/p"],
    ["git@bitbucket.org:team/repo.git", "bitbucket", "bitbucket.org", "https://bitbucket.org/team/repo"],
    ["git@git.example.com:team/repo.git", "other", "git.example.com", "https://git.example.com/team/repo"],
    ["https://github.com/me/repo", "github", "github.com", "https://github.com/me/repo"],
  ];
  for (const [url, forge, host, web] of cases) {
    const p = parseRemote(url);
    assert.ok(p, `${url} must parse`);
    assert.equal(p.forge, forge, `${url} → forge`);
    assert.equal(p.host, host, `${url} → host`);
    assert.equal(p.webUrl, web, `${url} → web`);
    assert.ok(!p.webUrl.includes("secrettoken"), "credentials never reach the browser URL");
  }
  // A filesystem remote has no browser URL — and must not be mangled into one.
  assert.equal(parseRemote("/srv/git/repo.git"), undefined);
  assert.equal(parseRemote("D:\\repos\\repo"), undefined);
  assert.equal(parseRemote(""), undefined);
});

test("r28 forge: the new-change link is built per forge, credentials never leak", () => {
  const gl = parseRemote("git@gitlab.com:group/sub/proj.git");
  assert.equal(
    newChangeUrl(gl, "feat/x", "main"),
    "https://gitlab.com/group/sub/proj/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx&merge_request%5Btarget_branch%5D=main",
  );
  const gh = parseRemote("https://github.com/me/repo.git");
  assert.equal(newChangeUrl(gh, "feat/x", "main"), "https://github.com/me/repo/compare/main...feat%2Fx?expand=1");
  const bb = parseRemote("git@bitbucket.org:team/repo.git");
  assert.equal(newChangeUrl(bb, "feat/x", "main"), "https://bitbucket.org/team/repo/pull-requests/new?source=feat%2Fx&dest=main");
  // Unknown forge: no invented URL — the UI falls back to the plain repo link.
  assert.equal(newChangeUrl(parseRemote("git@git.example.com:t/r.git"), "feat/x"), undefined);
  // A branch name can never break out of the query string.
  assert.ok(newChangeUrl(gl, "a&b=c#d")!.includes("a%26b%3Dc%23d"));
});
