<script setup lang="ts">
// Inspector GIT tab — the IDE git window, in the app's own design language
// (panel-heading + tags + task-sections). IntelliJ features: branch popup,
// changelist commit with per-file diff/stage/unstage/discard, structured log
// with swimlane graph, push with ahead count + recovery hints, stash with
// auto-stash on switch, conflict banner + abort, checkpoints/rewind,
// session-scoped commits, worktree sessions.
// Checklist: docs/git-ui-checklist.md (orca main, paseo/zcode niceties).
import { computed, onServerPrefetch, ref, watch } from "vue";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerUpLeft,
  Eye,
  Flag,
  GitBranch,
  GitCompare,
  GitMerge,
  History,
  Minus,
  PackageOpen,
  Plus,
  RefreshCw,
  Sparkles,
  SquareStack,
  Undo2,
  X,
} from "lucide-vue-next";
import { deviceId, network, sessionSummary, notify, select } from "../client/store";
import { deviceClient } from "../client/hub";
import { ensureGit, gitEntry, wireGitAutoRefresh } from "../client/git-store";
import type { GitStatus } from "@sdk/client";

const props = defineProps<{ deviceId?: string; cwd?: string }>();

const cwd = computed(() => props.cwd ?? sessionSummary.value?.cwd ?? "");
const devId = computed(() => props.deviceId ?? deviceId.value);
const entry = computed(() => gitEntry(devId.value || "?", cwd.value || "?"));
const status = computed(() => entry.value.status);
const loading = computed(() => entry.value.loading);
const refreshing = computed(() => entry.value.refreshing);
const error = computed(() => entry.value.error);
const sessionId = computed(() => {
  const s = sessionSummary.value;
  return s && s.cwd === cwd.value && !props.deviceId ? s.id : undefined;
});

const busy = ref("");
const out = ref("");
const commitMsg = ref("");
const checked = ref<Set<string>>(new Set());
const branchMenu = ref(false);
const wtMenu = ref(false);
const newBranch = ref("");
/** IntelliJ: click a changed file → its diff, right there. */
const fileDiff = ref<{ path: string; text: string } | null>(null);
/** Working vs staged — paseo's diff modes. */
const diffMode = ref<"working" | "staged">("working");
/** orca commit drafts: the message survives navigation and reloads. */
const draftKey = computed(() => `dpi-git-draft:${devId.value}:${cwd.value}`);
/** Compare vs an arbitrary base (orca git-bridge). */
const base = ref<{ ref: string; ahead: number; behind: number } | null>(null);
/** paseo: stash → switch → pop, so a dirty tree never blocks a branch hop. */
const autoStash = ref(true);
/** Push/pull failures get a RECOVERY action, not just red text. */
const pushHint = ref("");
const pullHint = ref(false);
/** Session-scoped commit (zcode flagship): files this session's agent touched. */
const sessionFiles = ref<string[]>([]);
const sessionCount = computed(() => {
  if (!sessionFiles.value.length || !cwd.value) return null;
  const abs = (p: string) => (p.startsWith("/") || p.includes(":\\") ? p : `${cwd.value}/${p}`);
  const touched = new Set(sessionFiles.value);
  const mine = (status.value?.files ?? []).filter((f) => touched.has(abs(f.path)));
  return { changed: mine.length, total: sessionFiles.value.length };
});
/** App-styled confirm modal — native confirm() cannot be driven headless
 *  (checklist Q4) and looks foreign. One slot, Escape backs out. */
const ask = ref<{ title: string; body: string; confirmLabel?: string; danger?: boolean; input?: { placeholder: string; value: string }; action: (input: string) => void } | null>(null);
const askInput = ref("");
const openAsk = (m: NonNullable<typeof ask.value>) => {
  askInput.value = m.input?.value ?? "";
  ask.value = m;
};
const runAsk = () => {
  const m = ask.value;
  ask.value = null;
  if (m) m.action(askInput.value);
};
const onKeyEsc = (e: KeyboardEvent) => {
  if (e.key === "Escape" && ask.value) ask.value = null;
};
if (!import.meta.env.SSR) window.addEventListener("keydown", onKeyEsc);

/** Checkpoints (zcode): named refs of HEAD you can rewind to. */
const checkpoints = ref<{ name: string; hash: string; date: string; subject: string }[]>([]);
const cpsOpen = ref(false);
/** Log row expander: files of one commit. */
const expanded = ref<Map<string, { status: string; path: string }[]>>(new Map());
/** PRs via the device's gh CLI (forge territory, checklist defer-item now
 *  un-deferred): lazy list, create from the current branch, squash-merge,
 *  checks as text, comment through the same modal. */
const prs = ref<{ n: number; title: string; state: string; draft: boolean; branch: string; url: string }[]>([]);
const prsOpen = ref(false);
const prChecks = ref<Map<number, string>>(new Map());
const prBusy = ref(false);
const isGitHub = computed(() => /github\.com|gitlab/i.test(status.value?.remoteUrl ?? ""));
const loadPRs = async () => {
  if (!devId.value || !cwd.value) return;
  prBusy.value = true;
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "pr-list");
    prs.value = r.prs ?? [];
  } catch (e) {
    notify(`pr list failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    prBusy.value = false;
  }
};
watch(prsOpen, (open) => { if (open) void loadPRs(); });
const prCreate = () =>
  openAsk({
    title: "Create pull request",
    body: `head: ${status.value?.branch ?? "?"}`,
    confirmLabel: "Create PR",
    input: { placeholder: "PR title", value: commitMsg.value.trim() || "" },
    action: (title) => void prCreateNow(title),
  });
async function prCreateNow(title: string) {
  if (!devId.value || !cwd.value || !title.trim()) return;
  prBusy.value = true;
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "pr-create", { message: title.trim(), body: title.trim() });
    notify(r.text.split("\n")[0] ?? "PR created");
    await loadPRs();
  } catch (e) {
    notify(`pr create failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    prBusy.value = false;
  }
}
async function prChecksOf(n: number) {
  if (!devId.value || !cwd.value) return;
  prBusy.value = true;
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "pr-checks", { n });
    prChecks.value = new Map(prChecks.value).set(n, r.text.slice(0, 1500));
  } catch (e) {
    notify(`pr checks failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    prBusy.value = false;
  }
}
const prMergeAsk = (n: number) =>
  openAsk({
    title: `Merge PR #${n}?`,
    body: "squash-merge via gh on the device.",
    confirmLabel: "Squash & merge",
    danger: true,
    action: () => void prMergeNow(n),
  });
async function prMergeNow(n: number) {
  if (!devId.value || !cwd.value) return;
  prBusy.value = true;
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "pr-merge", { n });
    notify(r.text || `PR #${n} merged`);
    await loadPRs();
    await refresh();
  } catch (e) {
    notify(`pr merge failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    prBusy.value = false;
  }
}
const prCommentAsk = (n: number) =>
  openAsk({
    title: `Comment on PR #${n}`,
    body: "posted as the device's gh login",
    confirmLabel: "Comment",
    input: { placeholder: "comment…", value: "" },
    action: (text) => void prCommentNow(n, text),
  });
async function prCommentNow(n: number, text: string) {
  if (!devId.value || !cwd.value || !text.trim()) return;
  prBusy.value = true;
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "pr-comment", { n, body: text.trim() });
    notify(r.text || "comment posted");
  } catch (e) {
    notify(`pr comment failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    prBusy.value = false;
  }
}

/** Per-turn summaries (zcode taskChangeSummary) under the session chip. */
const turns = ref<{ when: string; files: { path: string; writes: number; a?: number; d?: number }[] }[]>([]);
const turnsOpen = ref(false);
const loadTurns = async () => {
  if (!devId.value || !sessionId.value) return;
  try {
    const r = await deviceClient(devId.value).sessionGitTurns(sessionId.value);
    turns.value = r.turns;
  } catch {
    turns.value = [];
  }
};
watch(turnsOpen, (open) => { if (open) void loadTurns(); });

/** Focus refresh (checklist fs-auto-refresh, lightweight variant): the tab
 *  re-syncs when the user comes back to it — event-driven, never a timer. */
let lastFocusRefresh = 0;
if (!import.meta.env.SSR) {
  window.addEventListener("focus", () => {
    if (!cwd.value || Date.now() - lastFocusRefresh < 15_000) return;
    lastFocusRefresh = Date.now();
    void ensureGit(devId.value || "?", cwd.value || "?", { force: true });
  });
}

/** Folder grouping (orca tree-directory-rows): collapse noise. */
const collapsed = ref<Set<string>>(new Set());

const draftLoad = () => {
  if (typeof localStorage === "undefined") return;
  commitMsg.value = localStorage.getItem(draftKey.value) ?? "";
};
if (!import.meta.env.SSR) {
  wireGitAutoRefresh();
  void ensureGit(devId.value || "?", cwd.value || "?");
  draftLoad();
}
onServerPrefetch(() => ensureGit(devId.value || "?", cwd.value || "?"));
watch(commitMsg, (m) => {
  if (typeof localStorage === "undefined") return;
  if (m) localStorage.setItem(draftKey.value, m);
  else localStorage.removeItem(draftKey.value);
});
watch([devId, cwd], () => {
  branchMenu.value = false;
  wtMenu.value = false;
  fileDiff.value = null;
  base.value = null;
  pushHint.value = "";
  pullHint.value = false;
  sessionFiles.value = [];
  expanded.value = new Map();
  collapsed.value = new Set();
  if (!import.meta.env.SSR) {
    void ensureGit(devId.value || "?", cwd.value || "?");
    draftLoad();
  }
});
const refresh = () => {
  checked.value = new Set();
  fileDiff.value = null;
  return ensureGit(devId.value || "?", cwd.value || "?", { force: true });
};

const files = computed(() => status.value?.files ?? []);
watch(
  files,
  (list) => {
    const next = new Set<string>();
    for (const f of list) if (f.x !== "?" && f.y !== "?") next.add(f.path);
    checked.value = next;
  },
  // immediate: with SSR prefetch the status is ALREADY populated at setup —
  // without this the changelist starts empty and only fills after a refresh
  // (caught live in Chrome on production; unit tests never see hydration).
  { immediate: true },
);
const someChecked = computed(() => files.value.some((f) => checked.value.has(f.path)));
/** orca's split: staged (index changed) vs unstaged (worktree + untracked). */
const stagedFiles = computed(() => files.value.filter((f) => !isConflict(f) && f.x !== " " && f.x !== "?"));
const unstagedFiles = computed(() => files.value.filter((f) => !isConflict(f) && (f.x === " " || f.x === "?")));
/** Porcelain unmerged pairs (UU/AA/DD/AU/UA/DU/UD) get their own section —
 *  orca's conflicts section — instead of polluting the staged list. */
const isConflict = (f: { x: string; y: string }) => "UAD".includes(f.x) && "UAD".includes(f.y);
const conflictFiles = computed(() => files.value.filter(isConflict));
const atCap = computed(() => files.value.length >= 500);
const dirty = computed(() => (status.value?.staged ?? 0) + (status.value?.unstaged ?? 0) + (status.value?.untracked ?? 0) > 0);
const noIdentity = computed(() => !status.value?.identity?.name || !status.value?.identity?.email);
const remoteWeb = computed(() => {
  const u = status.value?.remoteUrl ?? "";
  const m = u.match(/git@([^:]+):(.+?)(?:\.git)?$/) ?? u.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `https://${m[1]}/${m[2]}` : "";
});
const toggle = (p: string) => {
  const next = new Set(checked.value);
  if (next.has(p)) next.delete(p);
  else next.add(p);
  checked.value = next;
};
const toggleAll = () => {
  checked.value = someChecked.value ? new Set() : new Set(files.value.map((f) => f.path));
};
const toggleGroup = (group: { path: string }[]) => {
  const all = group.every((f) => checked.value.has(f.path));
  const next = new Set(checked.value);
  for (const f of group) {
    if (all) next.delete(f.path);
    else next.add(f.path);
  }
  checked.value = next;
};
const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "." : p.slice(0, i);
};
const grouped = (list: { path: string; x: string; y: string; a?: number; d?: number }[]) => {
  const byDir = new Map<string, typeof list>();
  for (const f of list) {
    const d = dirOf(f.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(f);
  }
  return [...byDir.entries()].map(([dir, fs]) => ({
    dir,
    files: fs,
    open: !collapsed.value.has(dir),
  }));
};
const collapse = (dir: string) => {
  const next = new Set(collapsed.value);
  if (next.has(dir)) next.delete(dir);
  else next.add(dir);
  collapsed.value = next;
};
const numChip = (f: { a?: number; d?: number }) =>
  f.a === undefined && f.d === undefined ? "" : f.a === -1 || f.d === -1 ? "bin" : `+${f.a ?? 0} −${f.d ?? 0}`;
const copyPath = (p: string) => {
  void navigator.clipboard?.writeText(p).then(() => notify(`copied ${p}`));
};

async function op(
  name: "fetch" | "pull" | "push" | "branch" | "diff" | "stash-push" | "stash-pop",
  extra: { message?: string; rebase?: boolean; setUpstream?: boolean; ref?: string } = {},
) {
  if (!devId.value || !cwd.value) return;
  busy.value = name;
  out.value = "";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, name, extra);
    out.value = r.text || "(empty)";
    if (name === "push") {
      pushHint.value = "";
    }
    if (name === "pull") pullHint.value = false;
    if (["fetch", "pull", "push", "stash-push", "stash-pop"].includes(name)) notify(`git ${name} ✓`);
    await refresh();
    void loadLog(true);
  } catch (e) {
    const msg = (e as Error).message;
    if (name === "push") {
      // orca push-recovery: name the fix, offer the button.
      if (/no upstream|has no upstream|upstream is gone/i.test(msg)) pushHint.value = "no upstream — set it while pushing?";
      else if (/fetch first|non-fast-forward|rejected.*fetch|behind/i.test(msg)) pushHint.value = "the remote has work you lack — pull first";
      else if (/authentication|permission|could not read|403|denied/i.test(msg)) pushHint.value = "credentials rejected on the device — check its git login";
      else pushHint.value = "";
    }
    if (name === "pull" && /not possible to fast-forward|divergent|unrelated histories/i.test(msg)) pullHint.value = true;
    notify(`git ${name}: ${msg.slice(0, 160)}`);
  } finally {
    busy.value = "";
  }
}

async function fileAction(name: "stage" | "discard", path?: string, confirmed = false) {
  if (!devId.value || !cwd.value) return;
  if (confirmed) {
    busy.value = name!;
  }
  if (!path && name !== "stage") return;
  if (name === "discard" && path && !confirmed) {
    openAsk({
      title: "Roll back to HEAD?",
      body: `${path} — uncommitted changes are lost.`,
      confirmLabel: "Roll back",
      danger: true,
      action: () => void fileAction(name, path, true),
    });
    return;
  }
  busy.value = name;
  const targets = path ? [path] : files.value.filter((f) => f.x === " " || f.x === "M").map((f) => f.path);
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, name, { files: targets });
    notify(r.text);
    await refresh();
  } catch (e) {
    notify(`${name} failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

async function unstageFiles(paths: string[]) {
  if (!devId.value || !cwd.value || !paths.length) return;
  busy.value = "unstage";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "unstage", { files: paths });
    notify(r.text);
    await refresh();
  } catch (e) {
    notify(`unstage failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

/** orca conflicts section: one click picks a side and stages the file. */
async function resolveFile(side: "ours" | "theirs", path: string) {
  if (!devId.value || !cwd.value) return;
  busy.value = "resolve";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "resolve", { side, files: [path] });
    notify(r.text);
    await refresh();
  } catch (e) {
    notify(`resolve failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

async function ignorePaths(paths: string[]) {
  if (!devId.value || !cwd.value || !paths.length) return;
  busy.value = "ignore";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "ignore", { lines: paths });
    notify(r.text);
    await refresh();
  } catch (e) {
    notify(`ignore failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

async function showDiff(path: string) {
  if (!devId.value || !cwd.value) return;
  if (fileDiff.value?.path === path) return (fileDiff.value = null);
  busy.value = "diff";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "diff-file", { target: path, staged: diffMode.value === "staged" });
    fileDiff.value = { path, text: r.text };
  } catch (e) {
    notify(`diff failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}
const reDiff = async () => {
  const p = fileDiff.value?.path;
  fileDiff.value = null;
  if (p) await showDiff(p);
};
const diffIsBinary = computed(() => /Binary files .* differ/i.test(fileDiff.value?.text ?? ""));

async function gitAbort() {
  if (!devId.value || !cwd.value) return;
  busy.value = "abort";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "merge-abort");
    notify(r.text);
    await refresh();
  } catch (e) {
    notify(`abort failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}

async function compareWith(ref: string) {
  branchMenu.value = false;
  if (!devId.value || !cwd.value) return;
  busy.value = "compare";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "compare", { ref });
    base.value = { ref, ahead: r.ahead ?? 0, behind: r.behind ?? 0 };
  } catch (e) {
    notify(`compare failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

async function switchBranch(name: string, create = false) {
  branchMenu.value = false;
  if (!devId.value || !cwd.value || (name === status.value?.branch && !create)) return;
  busy.value = "switch";
  const client = deviceClient(devId.value);
  let stashed = false;
  try {
    // paseo auto-stash: a dirty tree never blocks a branch hop.
    if (autoStash.value && !create && dirty.value) {
      await client.gitOp(cwd.value, "stash-push", { message: `dpi auto-stash before ${name}` });
      stashed = true;
    }
    const r = await client.gitOp(cwd.value, "switch", { ref: name, create });
    notify(r.text || `switched to ${name}`);
    if (stashed) {
      try {
        const pop = await client.gitOp(cwd.value, "stash-pop");
        if (/conflict/i.test(pop.text)) notify(`stash popped WITH CONFLICTS — resolve in the file list`);
      } catch {
        notify(`switched, but the stash did not pop — resolve manually (git stash list)`);
      }
    }
    await refresh();
    void loadLog(true);
  } catch (e) {
    notify(`switch failed: ${(e as Error).message.slice(0, 140)}`);
    if (stashed) {
      try {
        await client.gitOp(cwd.value, "stash-pop");
      } catch {}
    }
  } finally {
    busy.value = "";
  }
}

async function commit(thenPush = false) {
  if (!devId.value || !cwd.value || !commitMsg.value.trim()) return;
  busy.value = "commit";
  const chosen = files.value.filter((f) => checked.value.has(f.path)).map((f) => f.path);
  if (!chosen.length) return notify("check the files to commit — nothing is selected");
  const client = deviceClient(devId.value);
  try {
    // During a merge git refuses path-limited commits ("cannot do a partial
    // commit during a merge") — the changelist is everything staged anyway.
    const r = await client.gitOp(cwd.value, "commit", {
      message: commitMsg.value.trim(),
      ...(status.value?.merge ? {} : { files: chosen }),
    });
    notify(r.text);
    commitMsg.value = "";
    if (thenPush) {
      try {
        const p = await client.gitOp(cwd.value, "push");
        notify(`pushed: ${p.text.slice(0, 80)}`);
      } catch (e) {
        notify(`committed, but push failed: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    await refresh();
    void loadLog(true);
  } catch (e) {
    notify(`commit failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

/** One model per provider, default's provider first — dead providers (seen
 *  live: a stale key answers model_error) are skipped after one strike. */
function modelCandidates(info: { models?: { id: string; provider: string }[]; defaultModel?: string } | undefined) {
  const models = info?.models ?? [];
  const def = models.find((m) => `${m.provider}/${m.id}` === info?.defaultModel);
  const byProvider = new Map<string, { id: string; provider: string }>();
  for (const m of models) if (!byProvider.has(m.provider)) byProvider.set(m.provider, m);
  const rest = [...byProvider.values()].filter((m) => m !== def).slice(0, 3);
  return (def ? [def, ...rest] : rest).slice(0, 4);
}

/** orca/zcode AI message: ask the device's own model to title the changelist. */
async function aiMessage() {
  if (!devId.value || !cwd.value) return;
  const chosen = files.value.filter((f) => checked.value.has(f.path)).map((f) => f.path);
  if (!chosen.length) return notify("check files first — the model summarises THOSE");
  busy.value = "ai";
  const client = deviceClient(devId.value);
  let diff = "";
  for (const f of chosen.slice(0, 5)) {
    const d = await client.gitOp(cwd.value, "diff-file", { target: f });
    diff += `${d.text}\n`;
    if (diff.length > 4000) break;
  }
  diff = diff.slice(0, 4000);
  const prompt = `Write ONE concise git commit message (under 72 chars, imperative, no quotes, no backticks) for these changes:\n\n${diff}`;
  const info = network.devices.value.find((d) => d.id === devId.value)?.info;
  const candidates = modelCandidates(info);
  if (!candidates.length) {
    busy.value = "";
    return notify("no model on the device");
  }
  const failed: string[] = [];
  try {
    for (const model of candidates) {
      const sid = await client
        .createSession({ name: "git-msg", cwd: cwd.value, model: { provider: model.provider, modelId: model.id } })
        .then((s) => s.id)
        .catch(() => "");
      if (!sid) {
        failed.push(`${model.provider}: no session`);
        continue;
      }
      try {
        const r = await client.agent(sid, 1).send(prompt, "followUp", undefined, 120_000);
        const text = r.status === "done" ? r.answer.text.trim().split("\n")[0]?.slice(0, 100) : "";
        if (text) {
          commitMsg.value = text;
          return;
        }
        failed.push(`${model.provider}/${model.id}: ${r.status === "unanswered" ? r.reason : "empty answer"}`);
      } finally {
        void client.session(sid).archive().catch(() => {});
      }
    }
    notify(`ai message failed on every model — ${failed.join("; ").slice(0, 140)}`);
  } catch (e) {
    notify(`ai message failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}

/** zcode flagship: check exactly the files this session's agents touched. */
async function selectSessionFiles() {
  if (!devId.value || !sessionId.value) return;
  busy.value = "session-files";
  try {
    const r = await deviceClient(devId.value).sessionGitFiles(sessionId.value);
    sessionFiles.value = r.files;
    const abs = (p: string) => (p.startsWith("/") || p.includes(":\\") ? p : `${cwd.value}/${p}`);
    const touched = new Set(r.files.map(abs));
    const mine = files.value.filter((f) => touched.has(abs(f.path)));
    checked.value = new Set(mine.map((f) => f.path));
    notify(mine.length ? `${mine.length} session file(s) still changed — checked` : "the session touched nothing that is still changed");
  } catch (e) {
    notify(`session files failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}

async function loadCommitFiles(hash: string) {
  if (expanded.value.has(hash)) {
    expanded.value.delete(hash);
    expanded.value = new Map(expanded.value);
    return;
  }
  if (!devId.value || !cwd.value) return;
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "show-files", { target: hash });
    expanded.value = new Map(expanded.value).set(hash, r.changed ?? []);
  } catch (e) {
    notify(`commit files failed: ${(e as Error).message.slice(0, 120)}`);
  }
}

async function saveCheckpoint() {
  if (!devId.value || !cwd.value) return;
  const name = `cp-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  busy.value = "checkpoint";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "checkpoint", { name });
    notify(r.text);
    cpsOpen.value = true;
    await loadCheckpoints();
  } catch (e) {
    notify(`checkpoint failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}

async function loadCheckpoints() {
  if (!devId.value || !cwd.value) return;
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "checkpoints");
    checkpoints.value = r.checkpoints ?? [];
  } catch {
    checkpoints.value = [];
  }
}

async function rewind(name: string) {
  if (!devId.value || !cwd.value) return;
  const target = name;
  openAsk({
    title: `Rewind to ${target}?`,
    body: "reset --hard — ALL uncommitted changes in this worktree are LOST.",
    confirmLabel: "Rewind",
    danger: true,
    action: () => void rewindAfter(target),
  });
  return;
}
async function rewindAfter(name: string) {
  if (!devId.value || !cwd.value) return;
  busy.value = "rewind";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "rewind", { name });
    notify(r.text);
    await refresh();
    void loadLog(true);
  } catch (e) {
    notify(`rewind failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}
watch(cpsOpen, (open) => {
  if (open) void loadCheckpoints();
});

async function addWorktree(branch: string) {
  wtMenu.value = false;
  if (!devId.value || !cwd.value || !status.value?.root) return;
  const root = status.value.root;
  const parent = root.slice(0, root.lastIndexOf("/"));
  const base = root.slice(root.lastIndexOf("/") + 1);
  const target = `${parent}/${base}-${branch.replace(/[/\\]+/g, "-")}`;
  busy.value = "wt";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "worktree-add", { branch, target });
    notify(r.text.split("\n")[0] ?? `worktree ${target}`);
    newBranch.value = "";
    await refresh();
  } catch (e) {
    notify(`worktree failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

async function sessionOn(path: string, branch: string | null) {
  if (!devId.value) return;
  busy.value = "session";
  try {
    const info = network.devices.value.find((d) => d.id === devId.value)?.info;
    const model = modelCandidates(info)[0];
    if (!model) return notify(`no model available on ${devId.value} — cannot create a session`);
    const s = await deviceClient(devId.value).createSession({
      name: branch ?? path.slice(path.lastIndexOf("/") + 1),
      cwd: path,
      model: { provider: model.provider, modelId: model.id },
    });
    select({ deviceId: devId.value, sessionId: s.id, agentId: 1 });
    notify(`session "${s.name}" on ${path}`);
  } catch (e) {
    notify(`session failed: ${(e as Error).message.slice(0, 160)}`);
  } finally {
    busy.value = "";
  }
}

/** orca worktree palette: jump to whatever session already lives there. */
async function goToWorktree(path: string) {
  if (!devId.value) return;
  busy.value = "go";
  try {
    const sessions = await deviceClient(devId.value).sessions();
    const found = sessions.find((s) => s.cwd === path);
    if (found) {
      select({ deviceId: devId.value, sessionId: found.id, agentId: 1 });
      notify(`switched to session "${found.name}"`);
    } else {
      await sessionOn(path, null);
    }
  } catch (e) {
    notify(`switch failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}

async function removeWorktree(path: string) {
  if (!devId.value || !cwd.value) return;
  busy.value = "wt";
  let warn = "Uncommitted changes in it will be LOST.";
  try {
    // orca wording, earned honestly: only say "lost" when there ARE changes.
    const batch = await deviceClient(devId.value).gitStatusBatch([path], { timeoutMs: 60_000 });
    const s = batch[path];
    if ((s?.staged ?? 0) + (s?.unstaged ?? 0) + (s?.untracked ?? 0) > 0) warn = `It CONTAINS uncommitted changes — they will be LOST.`;
    else warn = "Its checkout is clean.";
  } catch {}
  const w = warn;
  openAsk({
    title: "Remove worktree?",
    body: `${path} — ${w}`,
    confirmLabel: "Remove",
    danger: true,
    action: () => void removeWorktreeNow(path),
  });
}
async function removeWorktreeNow(path: string) {
  busy.value = "wt";
  try {
    await deviceClient(devId.value!).gitOp(cwd.value!, "worktree-remove", { target: path });
    await refresh();
  } catch (e) {
    notify(`remove failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

type Commit = { hash: string; refs: string; author: string; date: string; subject: string; parents: string[] };
const commits = ref<Commit[]>([]);
const logLoading = ref(false);
const logError = ref("");
let logAt = 0;
async function loadLog(force = false) {
  if (!devId.value || !cwd.value) return;
  if (!force && commits.value.length && Date.now() - logAt < 120_000) return;
  logLoading.value = true;
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "log-list");
    commits.value = r.commits ?? [];
    logError.value = "";
    logAt = Date.now();
  } catch (e) {
    // "no commits" lied when the fetch failed (checklist Wave 1a) — say it.
    logError.value = (e as Error).message.slice(0, 120);
  } finally {
    logLoading.value = false;
  }
}
if (!import.meta.env.SSR) void loadLog();
watch([devId, cwd], () => {
  commits.value = [];
  logAt = 0;
  void loadLog();
});
const worktrees = computed(() => (status.value?.worktrees ?? []).filter((w) => w.path));

/** zcode's portable lane layout: newest first, first parent keeps the lane. */
const LANE_COLORS = ["#4f8cc9", "#b8860b", "#7aa25c", "#a061ba", "#c96f6f", "#5fa8a0"];
const lanes = computed(() => {
  const laneOf = new Map<string, number>();
  const rows: { lane: number; parents: number[]; width: number }[] = [];
  const alive: (string | null)[] = [];
  for (const c of commits.value) {
    let lane = laneOf.get(c.hash);
    if (lane === undefined) {
      lane = alive.indexOf(null);
      if (lane === -1) {
        alive.push(null);
        lane = alive.length - 1;
      }
      laneOf.set(c.hash, lane);
    }
    alive[lane] = null;
    const parentLanes: number[] = [];
    c.parents.forEach((p, i) => {
      let pl = laneOf.get(p);
      if (pl === undefined || alive[pl] === p) {
        pl = alive.indexOf(null);
        if (pl === -1) {
          alive.push(null);
          pl = alive.length - 1;
        }
        laneOf.set(p, pl);
      }
      alive[pl] = p;
      if (i === 0) alive[lane!] = p;
      parentLanes.push(pl);
    });
    rows.push({ lane, parents: parentLanes, width: Math.max(1, alive.length) });
  }
  return rows;
});
const laneX = (lane: number) => lane * 12 + 7;
</script>

<template>
  <div class="git-pane">
    <p v-if="!cwd" class="hint">No session selected — open a session to see its git.</p>
    <template v-else>
      <p v-if="loading" class="hint">loading git…</p>
      <p v-else-if="refreshing" class="muted-line">refreshing…</p>
      <p v-if="error" class="message-error">{{ error }} <button @click="refresh()">retry</button></p>

      <div v-if="status" :class="{ stale: !!error || !!refreshing }">
        <p v-if="!status.repo" class="hint">Not a git repository — run <code>git init</code> (or open a session inside a repo).</p>

        <template v-else>
          <!-- conflict banner: the one state that blocks everything else -->
          <p v-if="status.merge" class="message-error merge-banner">
            merge in progress — {{ status.conflicts ?? conflictFiles.length }} unmerged path(s). Resolve them in the lists above, or
            <button class="small" :disabled="!!busy" @click="gitAbort()">abort merge</button>
          </p>

          <!-- branch popup + sync, the IDE way -->
          <div class="panel-heading git-top">
            <div class="branch-wrap">
              <button class="branch-btn" :disabled="!!busy" @click="branchMenu = !branchMenu">
                <GitBranch :size="16" /><strong>{{ status.branch ?? "detached" }}</strong>
                <ChevronDown :size="14" />
              </button>
              <div v-if="branchMenu" class="menu">
                <button v-for="b in status.branches ?? []" :key="b.name" :class="{ cur: b.current }" @click="switchBranch(b.name)">
                  <GitBranch :size="13" /><span>{{ b.name }}</span>
                  <span class="muted-line">{{ b.current ? "current" : b.upstream ? `→ ${b.upstream}` : "" }}</span>
                  <span class="grow" />
                  <GitCompare v-if="!b.current" :size="13" title="compare with this base" @click.stop="compareWith(b.name)" />
                </button>
                <div class="new-branch">
                  <input v-model="newBranch" placeholder="new branch…" @keyup.enter="newBranch.trim() && switchBranch(newBranch.trim(), true)" />
                  <button :disabled="!newBranch.trim()" @click="switchBranch(newBranch.trim(), true)"><Plus :size="13" /></button>
                </div>
                <label class="auto-stash"><input type="checkbox" v-model="autoStash" /> auto-stash on switch</label>
              </div>
            </div>
            <span class="tag">{{ status.upstream ?? "no upstream" }}</span>
            <span v-if="status.ahead" class="tag">↑{{ status.ahead }}</span>
            <span v-if="status.behind" class="tag">↓{{ status.behind }}</span>
            <span v-if="base" class="tag" title="vs the picked base">
              vs {{ base.ref }}: ↑{{ base.ahead }} ↓{{ base.behind }}
              <button class="tag-x" @click="base = null"><X :size="11" /></button>
            </span>
            <span class="tag">+{{ status.staged ?? 0 }} ~{{ status.unstaged ?? 0 }} ?{{ status.untracked ?? 0 }}</span>
            <a v-if="remoteWeb" class="icon-button" :href="`${remoteWeb}/tree/${status.branch ?? ''}`" target="_blank" rel="noopener" title="open on the remote"><ArrowUpFromLine :size="15" style="transform: rotate(45deg)" /></a>
            <button class="icon-button" :disabled="!!busy || loading || refreshing" title="refresh" @click="refresh()"><RefreshCw :size="16" /></button>
          </div>

          <div class="row ops">
            <button class="small" :disabled="!!busy" @click="op('fetch')"><ArrowDownToLine :size="14" />fetch</button>
            <button class="small" :disabled="!!busy" @click="op('pull')"><ArrowDownToLine :size="14" />pull</button>
            <button class="small primary" :disabled="!!busy" title="push" @click="op('push')"><ArrowUpFromLine :size="14" />push</button>
            <button class="small" :disabled="!!busy" title="stash changes" @click="op('stash-push', { message: commitMsg.trim() || undefined })"><SquareStack :size="14" />stash</button>
            <button class="small" :disabled="!!busy" title="pop the newest stash" @click="op('stash-pop')"><PackageOpen :size="14" />unstash</button>
          </div>
          <p v-if="pushHint" class="message-error hintbox">
            {{ pushHint }}
            <button v-if="pushHint.includes('upstream')" class="small primary" :disabled="!!busy" @click="op('push', { setUpstream: true, ref: status.branch })">push -u origin {{ status.branch }}</button>
            <button v-else-if="pushHint.includes('remote has work')" class="small primary" :disabled="!!busy" @click="op('pull')">pull now</button>
          </p>
          <p v-if="pullHint" class="message-error hintbox">
            fast-forward is not possible — branches diverged.
            <button class="small primary" :disabled="!!busy" @click="op('pull', { rebase: true })">pull --rebase</button>
          </p>

          <!-- COMMIT — always present, changelist semantics -->
          <section class="task-section" aria-label="Commit">
            <div class="panel-heading">
              <h4>Commit</h4>
              <span class="tag">{{ files.length ? `${checked.size}/${files.length} files` : "no changes" }}</span>
              <span class="grow" />
              <button v-if="sessionId" class="small" :disabled="!!busy" title="check the files this session's agent touched" @click="selectSessionFiles">
                <Flag :size="13" /> session files{{ sessionCount ? ` (${sessionCount.changed}/${sessionCount.total})` : "" }}
              </button>
              <button v-if="sessionId" class="small" :disabled="!!busy" title="what each turn of this session changed" @click="turnsOpen = !turnsOpen">
                turns
              </button>
            </div>
            <p v-if="noIdentity" class="hintbox warn">git user.name/user.email is not set on the device — <code>dpi device config</code> or <code>git config --global</code> before committing.</p>
            <div v-if="turnsOpen" class="cps turns">
              <p v-if="!turns.length" class="hint">no turns recorded yet for this session.</p>
              <div v-for="(t, ti) in turns" :key="ti" class="cp-row">
                <code>t{{ turns.length - ti }}</code>
                <span class="muted-line">{{ t.when.slice(0, 16).replace("T", " ") }}</span>
                <span class="cp-subj">{{ t.files.map((f) => `${f.path}×${f.writes}${f.a !== undefined || f.d !== undefined ? ` (+${f.a ?? 0} −${f.d ?? 0})` : ""}`).join(", ") || "(no file writes)" }}</span>
              </div>
            </div>
            <p v-if="atCap" class="muted-line cap">showing the first 500 changed files — commit in smaller batches</p>
            <div v-if="conflictFiles.length" class="files conflicts">
              <label class="file all">
                <span class="muted-line conflict-head">Conflicts · {{ conflictFiles.length }} — pick a side per file</span>
              </label>
              <div v-for="f in conflictFiles" :key="f.path" class="file">
                <label class="file-label">
                  <code class="xy">{{ f.x }}{{ f.y }}</code>
                  <span class="path" :title="f.path">{{ f.path }}</span>
                </label>
                <span class="file-acts">
                  <button class="icon-button" title="view the conflict" @click="showDiff(f.path)"><Eye :size="13" /></button>
                  <button class="small" :disabled="!!busy" title="keep this branch's version and stage it" @click="resolveFile('ours', f.path)">ours</button>
                  <button class="small" :disabled="!!busy" title="take the incoming version and stage it" @click="resolveFile('theirs', f.path)">theirs</button>
                </span>
              </div>
            </div>
            <div v-if="stagedFiles.length" class="files">
              <label class="file all">
                <input type="checkbox" :checked="stagedFiles.every((f) => checked.has(f.path))" @change="toggleGroup(stagedFiles)" />
                <span class="muted-line">Staged · {{ stagedFiles.length }}</span>
                <span class="grow" />
                <button class="icon-button" title="stage every changed file" @click="fileAction('stage')"><Plus :size="13" /> all</button>
                <button class="icon-button" title="unstage all (git reset HEAD)" @click="unstageFiles(stagedFiles.map((f) => f.path))"><Minus :size="13" /> none</button>
              </label>
              <template v-for="g in grouped(stagedFiles)" :key="g.dir">
                <button v-if="g.dir !== '.'" class="dir-row" @click="collapse(g.dir)">
                  <ChevronRight :size="12" :class="{ open: g.open }" />{{ g.dir }}<span class="muted-line">· {{ g.files.length }}</span>
                </button>
                <div v-for="f in g.files" v-show="g.open" :key="f.path" class="file">
                  <label class="file-label">
                    <input type="checkbox" :checked="checked.has(f.path)" @change="toggle(f.path)" />
                    <code class="xy" :title="`index ${f.x} · worktree ${f.y}`">{{ f.x }}{{ f.y }}</code>
                    <span class="path" :title="f.path">{{ f.path }}</span>
                    <span v-if="numChip(f)" class="nums" :class="{ bin: numChip(f) === 'bin' }">{{ numChip(f) }}</span>
                  </label>
                  <span class="file-acts">
                    <button class="icon-button" title="view diff" @click="showDiff(f.path)"><Eye :size="13" /></button>
                    <button class="icon-button" title="unstage (git reset HEAD)" @click="unstageFiles([f.path])"><Minus :size="13" /></button>
                    <button class="icon-button" title="roll back to HEAD" @click="fileAction('discard', f.path)"><CornerUpLeft :size="13" /></button>
                  </span>
                </div>
              </template>
            </div>
            <div v-if="unstagedFiles.length" class="files">
              <label class="file all">
                <input type="checkbox" :checked="unstagedFiles.every((f) => checked.has(f.path))" @change="toggleGroup(unstagedFiles)" />
                <span class="muted-line">Unstaged · {{ unstagedFiles.length }}</span>
              </label>
              <template v-for="g in grouped(unstagedFiles)" :key="g.dir">
                <button v-if="g.dir !== '.'" class="dir-row" @click="collapse(g.dir)">
                  <ChevronRight :size="12" :class="{ open: g.open }" />{{ g.dir }}<span class="muted-line">· {{ g.files.length }}</span>
                </button>
                <div v-for="f in g.files" v-show="g.open" :key="f.path" class="file">
                  <label class="file-label">
                    <input type="checkbox" :checked="checked.has(f.path)" @change="toggle(f.path)" />
                    <code class="xy" :title="`index ${f.x} · worktree ${f.y}`">{{ f.x }}{{ f.y }}</code>
                    <span class="path" :title="f.path">{{ f.path }}</span>
                    <span v-if="numChip(f)" class="nums" :class="{ bin: numChip(f) === 'bin' }">{{ numChip(f) }}</span>
                  </label>
                  <span class="file-acts">
                    <button class="icon-button" title="view diff" @click="showDiff(f.path)"><Eye :size="13" /></button>
                    <button v-if="f.x === '?'" class="icon-button" title="add to .gitignore" @click="ignorePaths([f.path])"><Ban :size="13" /></button>
                    <button v-else class="icon-button" title="stage (git add)" @click="fileAction('stage', f.path)"><Plus :size="13" /></button>
                    <button v-if="f.x !== '?'" class="icon-button" title="roll back to HEAD" @click="fileAction('discard', f.path)"><CornerUpLeft :size="13" /></button>
                    <button class="icon-button" title="copy path" @click="copyPath(f.path)"><Copy :size="13" /></button>
                  </span>
                </div>
              </template>
            </div>
            <p v-if="fileDiff" class="file-diff">
              <strong>{{ fileDiff.path }}</strong>
              <span class="mode-chips">
                <button :class="{ on: diffMode === 'working' }" @click="diffMode = 'working'; reDiff()">working</button>
                <button :class="{ on: diffMode === 'staged' }" @click="diffMode = 'staged'; reDiff()">staged</button>
              </span>
              <span v-if="diffIsBinary" class="nums bin">binary file</span>
              <span v-else-if="fileDiff.text.length > 8000" class="nums">truncated at 8000 chars</span>
              <button class="icon-button" title="close diff" @click="fileDiff = null"><X :size="13" /></button>
              <pre v-if="!diffIsBinary">{{ fileDiff.text.slice(0, 8000) }}</pre>
            </p>
            <textarea
              v-model="commitMsg"
              rows="4"
              placeholder="Commit message…  (Ctrl+Enter to commit)"
              @keydown.enter.exact.prevent="commit()"
              @keydown.meta.enter.prevent="commit()"
              @keydown.ctrl.enter.prevent="commit()"
            />
            <div class="row">
              <button class="small" :disabled="!!busy || !checked.size" title="ask the device's model for a message" @click="aiMessage"><Sparkles :size="14" /> ai message</button>
              <span class="grow" />
              <button class="primary small" :disabled="!!busy || !commitMsg.trim() || !someChecked" @click="commit(false)">
                <Check :size="14" /> Commit{{ checked.size ? ` ${checked.size} file${checked.size > 1 ? "s" : ""}` : "" }}
              </button>
              <button v-if="status.upstream" class="primary small" :disabled="!!busy || !commitMsg.trim() || !someChecked" title="commit, then push" @click="commit(true)">
                <Check :size="14" /> Commit &amp; push
              </button>
            </div>
          </section>

          <!-- LOG: swimlane graph + expandable commits + checkpoints -->
          <section class="task-section" aria-label="Log">
            <div class="panel-heading">
              <h4><History :size="16" /> Log</h4>
              <span class="grow" />
              <button class="small" :disabled="!!busy" title="save a checkpoint ref of HEAD" @click="saveCheckpoint"><Flag :size="13" /> checkpoint</button>
              <button class="small" :disabled="!!busy" @click="cpsOpen = !cpsOpen">checkpoints {{ checkpoints.length ? `(${checkpoints.length})` : "" }}</button>
              <button class="icon-button" :disabled="logLoading" title="refresh log" @click="loadLog(true)"><RefreshCw :size="14" /></button>
            </div>
            <div v-if="cpsOpen" class="cps">
              <p v-if="!checkpoints.length" class="hint">no checkpoints yet — one click saves a named ref of HEAD.</p>
              <div v-for="cp in checkpoints" :key="cp.name" class="cp-row">
                <code>{{ cp.name }}</code>
                <span class="muted-line">{{ cp.hash }} · {{ cp.date }}</span>
                <span class="cp-subj">{{ cp.subject }}</span>
                <span class="grow" />
                <button class="small" :disabled="!!busy" title="reset --hard to this checkpoint (this worktree)" @click="rewind(cp.name)"><Undo2 :size="13" /> rewind</button>
              </div>
            </div>
            <p v-if="logLoading && !commits.length" class="hint">loading log…</p>
            <div v-else-if="commits.length" class="commits">
              <template v-for="(c, i) in commits" :key="c.hash">
                <div class="commit-row" :title="c.refs">
                  <svg v-if="lanes[i]" class="lane" :width="lanes[i].width * 12 + 4" height="24" aria-hidden="true">
                    <line v-for="l in lanes[i].width" :key="l" :x1="laneX(l - 1)" :x2="laneX(l - 1)" y1="0" y2="24" :stroke="'#3a3134'" stroke-width="2" />
                    <line v-for="(pl, j) in lanes[i].parents" :key="'p' + j" :x1="laneX(lanes[i].lane)" :x2="laneX(pl)" y1="12" y2="24" :stroke="LANE_COLORS[pl % LANE_COLORS.length]" stroke-width="2" />
                    <circle :cx="laneX(lanes[i].lane)" cy="12" r="4" :fill="LANE_COLORS[lanes[i].lane % LANE_COLORS.length]" />
                  </svg>
                  <button class="icon-button hash-btn" title="files in this commit" @click="loadCommitFiles(c.hash)"><ChevronRight :size="12" :class="{ open: expanded.has(c.hash) }" /></button>
                  <code class="hash">
                    <a v-if="remoteWeb" :href="`${remoteWeb}/commit/${c.hash}`" target="_blank" rel="noopener" title="on the remote">{{ c.hash }}</a>
                    <template v-else>{{ c.hash }}</template>
                  </code>
                  <span v-if="c.refs" class="refs">{{ c.refs.split(",")[0] }}</span>
                  <span class="subject">{{ c.subject }}</span>
                  <span class="muted-line who">{{ c.author }} · {{ c.date }}</span>
                </div>
                <div v-if="expanded.has(c.hash)" class="commit-files">
                  <div v-for="f in expanded.get(c.hash)" :key="f.path" class="cf">
                    <code class="cf-status" :data-s="f.status">{{ f.status }}</code>
                    <span class="path">{{ f.path }}</span>
                  </div>
                  <p v-if="!expanded.get(c.hash)?.length" class="hint">no files (merge/empty commit)</p>
                </div>
              </template>
            </div>
            <p v-else-if="logError" class="message-error">log failed: {{ logError }}</p>
            <p v-else class="hint">no commits</p>
          </section>

          <!-- WORKTREES -->
          <section class="task-section" aria-label="Worktrees">
            <div class="panel-heading">
              <h4><PackageOpen :size="16" /> Worktrees</h4>
              <div class="branch-wrap">
                <button class="small" :disabled="!!busy" @click="wtMenu = !wtMenu"><Plus :size="13" /> worktree</button>
                <div v-if="wtMenu" class="menu">
                  <button v-for="b in (status.branches ?? []).filter((x) => !x.current)" :key="b.name" @click="addWorktree(b.name)">
                    <GitBranch :size="13" /><span>{{ b.name }}</span><span class="muted-line">existing</span>
                  </button>
                  <div class="new-branch">
                    <input v-model="newBranch" placeholder="or a NEW branch…" @keyup.enter="newBranch.trim() && addWorktree(newBranch.trim())" />
                    <button :disabled="!newBranch.trim()" @click="addWorktree(newBranch.trim())">create</button>
                  </div>
                </div>
              </div>
            </div>
            <div v-for="w in worktrees" :key="w.path" class="wt" :class="{ main: w.path === status.root }">
              <code :title="w.path">{{ w.path }}</code>
              <span class="muted-line">{{ w.branch ?? w.head }}</span>
              <span class="grow" />
              <button class="icon-button" :disabled="!!busy" title="jump to this worktree (session or new)" @click="goToWorktree(w.path)"><ArrowRight :size="13" /></button>
              <button class="small" :disabled="!!busy" title="create a session on this worktree" @click="sessionOn(w.path, w.branch)">session</button>
              <button v-if="w.path !== status.root" class="icon-button" :disabled="!!busy" @click="removeWorktree(w.path)"><X :size="13" /></button>
              <Check v-if="w.path === status.root" :size="13" class="muted-line" />
            </div>
          </section>

          <!-- PULL REQUESTS (device gh CLI) -->
          <section v-if="isGitHub" class="task-section" aria-label="Pull requests">
            <div class="panel-heading">
              <h4><GitMerge :size="16" /> Pull requests</h4>
              <span class="grow" />
              <button class="small" :disabled="prBusy || !!busy" @click="prCreate">create PR</button>
              <button class="small" :disabled="prBusy" @click="prsOpen = !prsOpen">{{ prsOpen ? "hide" : "list" }}</button>
            </div>
            <p v-if="prsOpen && !prs.length && !prBusy" class="hint">no open PRs (or gh is not logged in on the device — every action will say so).</p>
            <div v-if="prsOpen" class="commits">
              <div v-for="pr in prs" :key="pr.n" class="pr-row">
                <code class="hash">#{{ pr.n }}</code>
                <span class="tag" :class="{ open: pr.state === 'OPEN' }">{{ pr.state.toLowerCase() }}{{ pr.draft ? " · draft" : "" }}</span>
                <span class="subject">{{ pr.title }}</span>
                <span class="muted-line who">{{ pr.branch }}</span>
                <span class="grow" />
                <button class="icon-button" title="run checks" :disabled="prBusy" @click="prChecksOf(pr.n)"><RefreshCw :size="13" /></button>
                <button class="icon-button" title="comment" :disabled="prBusy" @click="prCommentAsk(pr.n)"><Copy :size="13" /></button>
                <button v-if="pr.state === 'OPEN'" class="small" :disabled="prBusy || !!busy" @click="prMergeAsk(pr.n)">squash &amp; merge</button>
                <a class="icon-button" :href="pr.url" target="_blank" rel="noopener" title="open on the forge"><ArrowUpFromLine :size="13" style="transform: rotate(45deg)" /></a>
              </div>
              <pre v-for="[n, text] in prChecks" :key="n" class="pr-checks">#{{ n }} checks:{{ "\n" }}{{ text }}</pre>
            </div>
          </section>

          <pre v-if="out" class="op-out">{{ out.slice(0, 6000) }}</pre>
        </template>
      </div>

      <!-- app-styled confirm modal (checklist Q4): drivable headless -->
      <div v-if="ask" class="modal-veil" @click.self="ask = null">
        <div class="modal" :class="{ danger: ask.danger }" role="dialog" aria-modal="true">
          <h5>{{ ask.title }}</h5>
          <p>{{ ask.body }}</p>
          <textarea v-if="ask.input" v-model="askInput" rows="2" :placeholder="ask.input.placeholder" />
          <div class="row">
            <span class="grow" />
            <button class="small" @click="ask = null">cancel <span class="muted-line">(esc)</span></button>
            <button class="primary small" :class="{ danger: ask.danger }" :disabled="!!(ask.input && !askInput.trim())" @click="runAsk">
              {{ ask.confirmLabel ?? "confirm" }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.git-pane { display: grid; gap: 4px; }
.git-top { gap: 8px; flex-wrap: wrap; }
.branch-wrap { position: relative; }
.branch-btn { display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; }
.branch-btn strong { font-size: 16px; }
.menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; min-width: 300px; max-height: 280px; overflow: auto;
  background: var(--bg-2, #221a1c); border: 1px solid var(--line); border-radius: 8px; padding: 4px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 50%);
}
.menu button { display: flex; gap: 10px; align-items: center; width: 100%; padding: 7px 10px; border-radius: 6px; text-align: left; font-size: 15px; }
.menu button:hover, .menu button.cur { background: #403536; }
.menu .new-branch { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--line); }
.menu .new-branch input { flex: 1; min-width: 0; }
.auto-stash { display: flex; gap: 8px; align-items: center; padding: 8px 10px; font-size: 14px; opacity: 0.85; }
.muted-line { opacity: 0.65; font-size: 13px; }
.cap { padding: 4px 0; }
.row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; align-items: center; }
.hintbox { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 6px 10px; border-radius: 6px; margin: 4px 0; }
.hintbox.warn { border: 1px solid var(--warn, #e5a50a); color: var(--warn, #e5a50a); }
.merge-banner { padding: 8px 10px; border-radius: 6px; }
.files.conflicts { border-color: var(--warn, #e5a50a); }
.conflict-head { color: var(--warn, #e5a50a); }
.files { max-height: 260px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; }
.file { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 0; }
.file.all { border-bottom: 1px solid var(--line); }
.file-label { display: flex; gap: 8px; align-items: center; flex: 1; min-width: 0; cursor: pointer; }
.file .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.file .xy { opacity: 0.7; font-size: 12px; }
.nums { font-size: 11px; opacity: 0.8; color: var(--ok, #2ea043); white-space: nowrap; }
.nums.bin { color: var(--warn, #e5a50a); }
.dir-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 0; font-size: 13px; opacity: 0.8; }
.dir-row .open { transform: rotate(90deg); }
.file-acts { display: flex; gap: 2px; }
.file-diff { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin: 8px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.file-diff pre { max-height: 260px; overflow: auto; font-size: 12px; margin: 6px 0 0; width: 100%; }
.mode-chips { display: inline-flex; gap: 2px; }
.mode-chips button { font-size: 12px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--line); }
.mode-chips button.on { background: #403536; }
textarea { width: 100%; resize: vertical; min-height: 76px; font: inherit; margin-top: 8px; }
.commits { max-height: 340px; overflow: auto; display: grid; gap: 3px; }
.commit-row { display: flex; gap: 8px; align-items: center; white-space: nowrap; }
.commit-row .lane { flex-shrink: 0; }
.commit-row .hash { color: var(--ok, #2ea043); font-size: 13px; }
.hash-btn svg { transition: transform 0.1s; }
.hash-btn svg.open { transform: rotate(90deg); }
.commit-row .refs { color: var(--warn, #e5a50a); font-size: 12px; max-width: 18ch; overflow: hidden; text-overflow: ellipsis; }
.commit-row .subject { overflow: hidden; text-overflow: ellipsis; max-width: 40%; font-size: 14px; }
.commit-row .who { font-size: 12px; }
.commit-files { padding: 2px 0 6px 34px; border-left: 2px solid var(--line); margin-left: 16px; }
.cf { display: flex; gap: 10px; font-size: 13px; padding: 1px 0; }
.cf-status { font-size: 11px; opacity: 0.8; width: 2ch; }
.cps { border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; margin-bottom: 6px; }
.cp-row { display: flex; gap: 10px; align-items: center; padding: 2px 0; font-size: 14px; }
.cp-row code { color: var(--warn, #e5a50a); }
.cp-subj { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.wt { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
.wt code { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.wt.main code { font-weight: 650; }
.grow { flex: 1; }
.tag-x { margin-left: 4px; opacity: 0.7; display: inline-flex; }
.pr-row { display: flex; gap: 8px; align-items: center; padding: 2px 0; white-space: nowrap; }
.pr-row .tag.open { color: var(--ok, #2ea043); }
.pr-checks { font-size: 12px; background: rgb(0 0 0 / 25%); padding: 8px; border-radius: 6px; margin: 4px 0; white-space: pre-wrap; }
.turns { max-height: 180px; overflow: auto; }
.modal-veil { position: fixed; inset: 0; z-index: 90; background: rgb(0 0 0 / 55%); display: flex; align-items: center; justify-content: center; }
.modal { min-width: 340px; max-width: 520px; background: var(--bg-2, #221a1c); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
.modal.danger { border-color: var(--warn, #e5a50a); }
.modal h5 { margin: 0 0 6px; font-size: 17px; }
.modal p { margin: 0 0 10px; font-size: 15px; }
.modal textarea { min-height: 56px; }
.modal .danger { border-color: var(--warn, #e5a50a); }
.op-out { max-height: 300px; overflow: auto; background: rgb(0 0 0 / 25%); padding: 10px; border-radius: 6px; font-size: 12px; margin-top: 8px; }
h4 { display: flex; align-items: center; gap: 8px; font-size: 16px; margin: 0; }
</style>
