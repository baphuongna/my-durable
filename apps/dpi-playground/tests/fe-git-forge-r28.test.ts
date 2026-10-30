// R28: the git panel must not assume GitHub, and it must not invent an
// identity failure. Two live reports:
//  - a GitLab origin (gitlab.com or self-hosted) was matched by the same regex
//    as GitHub, so "list PRs" ran `gh pr list` and reported an empty list;
//  - a machine whose git resolves an author from the account/env was told to
//    run `git config --global user.name` (and a `dpi device config` command
//    that does not exist) although `git commit` there works.
// Level: integration (vite SSR, real module graph; fetch mocked).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
};
if (!globalThis.navigator) Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-test" }, configurable: true });
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...a) {
  const t = origSetInterval.call(this, fn, ms, ...a);
  t.unref?.();
  return t;
};

const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);
let vite;

test.before(async () => {
  vite = await createServer({
    configFile: new URL("vite.config.ts", FE_ROOT).pathname,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
});
test.after(async () => {
  await vite?.close();
});

async function renderPanel(status: unknown) {
  const gitStore = await vite.ssrLoadModule("/src/client/git-store.ts");
  gitStore.clearGitCache();
  const panel = (await vite.ssrLoadModule("/src/components/GitPanel.vue")).default;
  const ops: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/git/status"))
      return new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/v1/git") && (init?.method ?? "GET") === "POST") {
      ops.push(JSON.parse(String(init.body ?? "{}")).op);
      return new Response(JSON.stringify({ text: "ok", prs: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const html = await renderToString(createSSRApp({ render: () => h(panel, { deviceId: "dev1", cwd: "/r" }) }));
    return { html, ops };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const gitlabRepo = {
  repo: true,
  root: "/r",
  branch: "feat/login",
  upstream: "origin/main",
  head: "abc1234",
  remoteUrl: "git@gitlab.com:group/sub/proj.git",
  forge: "gitlab",
  webUrl: "https://gitlab.com/group/sub/proj",
  identityComplete: true,
  identity: { name: "Phuong NB", email: "phuong@example.com" },
  files: [{ path: "a.ts", x: "M", y: " " }],
};

test("R28 GitLab: the panel offers merge-request links, not a GitHub PR list", async () => {
  const { html, ops } = await renderPanel(gitlabRepo);
  assert.match(html, /merge request/, "says merge request on GitLab");
  assert.doesNotMatch(html, /Pull requests/, "no GitHub wording for a GitLab origin");
  assert.match(html, /gitlab\.com\/group\/sub\/proj/, "the origin's own URL is used");
  assert.match(html, /-\/merge_requests\/new\?merge_request%5Bsource_branch%5D=feat%2Flogin/, "new-MR link is prefilled with the branch");
  assert.match(html, /target_branch%5D=main/, "and with the upstream's branch as the target");
  assert.ok(!ops.includes("pr-list"), `the GitHub CLI is never called for GitLab (ops: ${ops.join(",")})`);
});

test("R28 GitHub: the gh-backed PR panel is kept for the forge that has the CLI", async () => {
  const { html } = await renderPanel({
    ...gitlabRepo,
    remoteUrl: "git@github.com:me/repo.git",
    forge: "github",
    webUrl: "https://github.com/me/repo",
  });
  assert.match(html, /Pull requests/);
  assert.doesNotMatch(html, /merge request/, "no GitLab wording on GitHub");
});

test("R28 identity: no warning when git CAN resolve an author", async () => {
  const { html } = await renderPanel(gitlabRepo);
  assert.doesNotMatch(html, /cannot resolve an author/);
  assert.doesNotMatch(html, /dpi device config/, "that command does not exist — never advise it");
});

test("R28 identity: warning only when git itself would refuse, with a command that exists", async () => {
  const { html } = await renderPanel({ ...gitlabRepo, identityComplete: false, identity: undefined });
  assert.match(html, /cannot resolve an author/, "the real failure is named");
  assert.match(html, /git config --global user\.name/, "advice is a real git command");
  assert.match(html, /git config --global user\.email/);
  assert.match(html, /this repo/, "per-repo config is offered too");
  assert.doesNotMatch(html, /dpi device config/, "no invented command");
});

test("R28 forge: an unknown forge still gets a repo link — never a broken action", async () => {
  const { html, ops } = await renderPanel({
    ...gitlabRepo,
    remoteUrl: "git@git.example.com:team/app.git",
    forge: "other",
    webUrl: "https://git.example.com/team/app",
  });
  assert.match(html, /change requests/, "neutral wording for an unknown forge");
  assert.match(html, /https:\/\/git\.example\.com\/team\/app/, "plain repo link");
  assert.ok(!ops.includes("pr-list"), "no CLI guessing");
});
