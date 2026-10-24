# Git UI Feature Checklist — orca / paseo / zcode → durable-pi

Run: `team_20261024073535_a2a56c3410bfe1d9` · Steps: 01_explore (research) → 02_analyze (verify/correct) → 03_write (this file)
Status: **verified against source** — every coverage claim below was re-read in the actual files before persisting (see [Verification log](#verification-log)).

## Why this doc exists

Our git UI (`GitPanel.vue` + device `git.ts`) is a working IntelliJ-style panel, but three local
reference repos have shipped years of git-UX refinement we have not. This checklist inventories
every git feature their UIs expose, marks what we already cover, and sequences the remainder into
adoption waves sized for PR-sized work. It is a planning input, not a commitment: the leader picks
the sequencing, especially for Wave 3.

**How to read it**

- Coverage vs our baseline: ✅ covered · 🟡 partial (name the delta) · ❌ missing.
- Tier: **MUST-LEARN** = orca main flows (primary reference — desktop app, richest git UX) ·
  **SHOULD** = paseo/zcode niceties · **SKIP** = infra-specific, do not adopt.
- Waves sequence by effort/dependency: 1a FE-only → 1b tiny BE ops → 2 medium → 3 differentiators.

## Our baseline (verified today)

All line numbers verified by direct read in this run.

**BE — `durable-pi/apps/dpi-backend/src/git.ts` (~285 lines):**

- `gitOp` — 17 whitelisted ops (`GitOp` union, ~:190-207): `diff, log, log-list, fetch, pull,
  switch, branch, commit, worktree-list, worktree-add, worktree-remove, push, stage, discard,
  diff-file, stash-push, stash-pop`. Every call is `execFile("git", ["-C", cwd, ...args])` with
  hand-built argv and `safeRef` validation — no shell, no interpolated paths.
- `gitStatus(path)` (~:70-160) — one call returns branch, upstream, **ahead/behind** (parsed from
  `## branch...upstream [ahead N, behind M]`, ~:126-131), staged/unstaged/untracked counts,
  per-file porcelain `x`/`y` codes **capped at 500 files** (`body.slice(0, 500)`, ~:118), local
  branches (for pickers), and the worktree list.
- `pull` is `--ff-only` (unchanged by this checklist; any rebase fallback must be explicit opt-in).

**FE — `durable-pi/apps/dpi-playground/apps/dpi-playground-fe/src/components/GitPanel.vue` (~415 lines):**

- Branch menu + new-branch input; fetch/pull/push/stash/unstash buttons; per-file view-diff /
  stage / discard (discard guarded by `confirm()`, `fileAction()` ~:95); commit-selected with
  changelist semantics; structured log list; worktree add / per-worktree **session** launch
  (`sessionOn()` ~:167) / remove (confirm-guarded, ~:193).
- States: loading / refreshing / error+retry / not-a-repo hint; busy disables; `↑N ↓N` ahead/behind
  tags (~:247-248) and `+~?` count chip (~:249); file-diff popup truncated at 8000 chars (~:303),
  op output at 6000 (~:373).

**Known defect found during review:** `loadLog()` swallows errors (`catch { /* decorative */ }`,
~:212) — a failed log fetch renders as "no commits", which is misleading. Fix is Wave 1a.

## Corrections vs the first-draft table

The explorer's original 45-row table had 5 wrong coverage cells. The corrected values below are
verified; do not resurrect the originals.

| # | Feature | Was | Now | Evidence |
|---|---|---|---|---|
| 1 | Upstream ahead/behind | ❌ | ✅ | `git.ts` `gitStatus()` parses `[ahead N, behind M]`; GitPanel renders `↑N ↓N`. Only *arbitrary-base* compare (`rev-list --left-right --count base...HEAD`) is missing. |
| 2 | Discard confirmation | ❌ | ✅ | Native `confirm()` in `GitPanel.vue` `fileAction()`. Orca's multi-file dialog is a refinement, not a gap. |
| 3 | Worktree-remove warning | ❌ | 🟡 | Basic `confirm()` exists in `removeWorktree()`. Delta: orca's "uncommitted changes will be lost" wording (orca `i18n/en.json:10533`). |
| 4 | Staged/unstaged split | ❌ | 🟡 | Per-file `x`/`y` codes and aggregate counts already flow from BE; the sectioned list is **FE-only** work. |
| 5 | Too-many-changes cap | ❌ | narrower | BE already caps at 500 files (`git.ts` ~:118). Missing: a "showing N of M" banner when the cap bites. |
| 6* | Diff truncation | ❌ | 🟡 | *Write-time note:* GitPanel already slices the file-diff popup at 8000 chars and op output at 6000. Still missing: binary/large-file labels and diff-viewer options (orca `DiffViewer.tsx`). |

\* Row 6 was corrected by the write step during final verification, not by the analyst.

## Wave 1a — FE-only, no BE change (start here)

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| MUST | Staged/Unstaged split sections | orca `listing/uncommitted-sections.tsx:99-155` | 🟡 (x/y codes exist) | Split file list on `f.x !== ' '` vs rest |
| MUST | Stage-all button | orca `uncommitted-sections.tsx:99` | ❌ | `stage` op already takes `files[]` |
| SHOULD | ⌘/Ctrl+Enter to commit | zcode `GitActionMenu.tsx:369` | ❌ | keydown on commit textarea |
| MUST | Commit draft persistence | orca `commit/commit-drafts.ts` | ❌ | localStorage keyed by cwd |
| MUST | Copy-path / reveal actions | orca `listing/entry-context-menu.tsx:110-200` | ❌ | icon buttons per file row |
| MUST | Log error surfacing | our gap (`GitPanel.vue` `loadLog` ~:212) | ❌ | replace `catch {}` with notify |
| MUST | "Showing N of 500" banner | orca `listing/too-many-changes-banner.tsx:101` | ❌ | note when `files.length === 500` |
| MUST | Folder/tree grouping | orca `listing/tree-directory-rows.tsx:106-135` | ❌ | group by dirname, collapsible |

## Wave 1b — three tiny BE ops (whitelisted, same execFile pattern)

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| MUST | Unstage (`git reset HEAD --`) | orca `git-bridge.ts:170` | ❌ | new `unstage` op beside stage icon |
| MUST | ±n line counts | orca `listing/diff-line-counts.tsx` | ❌ | `diff --numstat` op → row chip |
| MUST | Base-compare ahead/behind | orca `git-bridge.ts:60-63` | 🟡 (upstream ✅) | `rev-list --left-right --count` |
| MUST | Commit&push | orca primary-action; zcode `GitActionMenu.tsx:243` | ❌ | FE chain commit→push (**no BE op needed**) |
| MUST | Conflict banner + abort | orca `git-bridge.ts:49-52` | ❌ | detect MERGE_HEAD in `gitStatus` + `abort` op |
| SHOULD | Identity check pre-commit | zcode `switchAssist.ts` | ❌ | `rev-parse user.name` → warn if unset |
| MUST | Worktree-remove loss warning | orca `i18n/en.json:10533` | 🟡 | extend existing confirm text |

## Wave 2 — medium

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| SHOULD | AI commit message | orca `git-bridge.ts:125`; zcode `GitActionMenu.tsx:992` | ❌ | agent summarizes `diff --cached` into textarea |
| MUST | Expand files per commit | orca `sync/git-history-commit-files.tsx:121` | ❌ | `show --name-status <hash>` op |
| MUST | Log graph swimlanes | orca `sync/git-history-graph-svg.tsx`; zcode `git-graph/layoutAlgorithm.ts:50-279` | 🟡 | start 2-lane SVG; zcode algo is portable TS |
| MUST | Diff binary/large labels | orca `editor/DiffViewer.tsx` options | 🟡 (truncation exists) | label binaries; cap oversized hunks |
| MUST | Push-failure recovery hints | orca `sync/push-recovery.ts` | ❌ | parse error → suggest pull |
| SHOULD | Auto-stash on switch | paseo `branch-switcher-operations.ts:6-16`; `use-branch-switcher.ts:93-99` | 🟡 | stash→switch→pop on conflict |
| MUST | Pull policy fallback | orca `commit/pull-policy-error-notice.ts` | 🟡 | offer `--rebase` when ff-only fails (explicit opt-in) |
| MUST | .gitignore helper | orca `git-bridge.ts:35-43` | ❌ | "ignore" → append to .gitignore |
| MUST | Open in remote | orca `git-bridge.ts:190-195` | ❌ | parse `remote get-url` → link |

## Wave 3 — differentiators / later

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| SHOULD (flagship) | **Session-scoped commit** (tag session-touched files) | zcode `session/taskChangeSummary.ts:21-129`; `GitActionMenu.tsx:992` | ❌ | track session-touched paths → "commit session changes" |
| SHOULD | Per-turn change summaries | zcode `taskChangeSummary.ts` | ❌ | natural extension of the above |
| SHOULD | Git checkpoints (rewind) | zcode `git/repo/gitCheckpointStore.ts:23-45` | ❌ | hidden-ref per session; fits durable model |
| SHOULD | Diff modes (working/staged/base) | paseo `diff-pane.tsx:136` | 🟡 | toggle on diff-file (staged opt exists, unused) |
| MUST | Worktree palette quick-switch | orca `lib/worktree-palette-create-action.ts` | ❌ | dropdown reusing worktree-add |
| — (defer) | PR create/merge, CI checks, diff comments, submodule UI, FS auto-refresh | paseo/zcode (e.g. paseo `use-actions.tsx:705-795`) | ❌ | defer — needs forge APIs / line-diff / fs events |

**Why session-scoped commit is the flagship:** zcode builds per-turn file-change summaries from
persisted snapshots (`taskChangeSummary.ts` aggregates before→after per path per turn) and scopes
the commit dialog to the current session's files. That maps directly onto durable-pi's
session-on-worktree model (`GitPanel.vue` `sessionOn()`) — "commit what this session touched" is
the git primitive an agent runtime wants and none of the other references have end-to-end.

## SKIP — infra-specific, do not adopt

- orca command-runner / admission / WSL-SSH routing (`src/main/git/*`)
- orca syncFork + Gitea/GitLab hosted review (`git-bridge.ts:75`; `src/main/gitea/`)
- orca sparse worktree dir sets + remote worktree sleep (`fr.json:8834`; `remote-worktree-sleep.ts`)
- paseo forge checkout ref resolution (`forge-service.ts:445-466`)
- paseo desktop per-worktree isolation (`desktop/src/main.ts:300-325`)
- i18n auto-key infra (orca)

## UX shape by repo

Synthesized from the explorer pass; items marked ✓n were re-verified in this run.

- **orca** — IntelliJ/VSCode hybrid right-sidebar: sectioned changes with per-section bulk actions
  (Stage all / Unstage all / Discard all — ✓n `uncommitted-sections.tsx:99-155`), context menus,
  adaptive split button, cancellable ops, per-state rendering (idle/loading/ready/error).
- **paseo** — mobile/agent-first: toasts, policy gating with human-readable "unavailable" reasons,
  a11y/testIDs, workspaces == worktrees, PR-centric actions (`use-actions.tsx`).
- **zcode** — VSCode-ish pane with explicit states; segmented commit dialog where ⏎ submits and
  ↑/↓ move between actions (✓n `GitActionMenu.tsx:355-375`); graph dialog; agent-turn grouping —
  the closest cousin to "git UI for an agent runtime".
- **durable-pi today** — flat single panel, icon rows, busy/error strings, native `confirm()`.

## Sessions / agents ↔ worktrees

- **orca**: worktree IS the workspace unit — tabs/terminals/agents keyed by worktreeId
  (`store/slices/worktrees.ts:44-57`, explorer-verified).
- **paseo**: worktree per workspace; PR checkouts become workspaces (`checkout/status-projection.test.ts:264`).
- **zcode**: no worktree fan-out; checkpoints + per-turn summaries tie agents to git instead.
- **durable-pi**: `worktree-list/add/remove` + "session on worktree" (`GitPanel.vue:345-362`) —
  direction matches orca; lacks per-worktree panel context and loss warnings.

## Open questions (for the leader / planner)

1. **Sequencing**: land Wave 3 session-scoped commit before Wave 2 polish (graph, AI message), or
   after? Strategic call — the analyst deferred it to the leader.
2. **Wave 3 design**: where do "session-touched paths" come from — device fs events or the
   session's tool-call log? Needed before any Wave 3 PR.
3. **AI commit message latency**: an agent round-trip per commit; no budget specified. Cap or async?
4. **Testability**: native `confirm()` guards cannot be exercised in headless UI runs (bench
   evidence needs an app modal). Swap to a modal when adopting dialog refinements.
5. **Unverified claims** (adopt conservatively): orca's full keyboard-shortcut registry is
   i18n-keyed and only the commit screen-submit was verified (analyst, via `CommitArea.test.tsx:11`);
   zcode graph search/filter interactions are unverified — adopt the layout algorithm only.

## Constraints for adopters

- New BE ops must follow the existing `execFile` whitelist pattern in `git.ts` (`safeRef`/argv, no shell).
- `pull` stays `--ff-only`; any rebase fallback is explicit opt-in.
- No forge/GitHub-API features (PR merge, CI checks) on the device side.
- Waves 1-2 touch exactly two files: `git.ts` and `GitPanel.vue` — single-file ownership per PR.

## Verification log

Evidence gathered by the write step (03_write) before persisting this file; direct `read`
inspections, no shell:

| Read | Confirmed |
|---|---|
| `durable-pi/apps/dpi-backend/src/git.ts` (full) | 17-op union; ahead/behind parsing; 500-file cap; x/y codes; `pull --ff-only`; `safeRef`/execFile pattern; `isNotARepoError` |
| `durable-pi/apps/dpi-playground/apps/dpi-playground-fe/src/components/GitPanel.vue` (full) | discard/worktree confirm guards; ↑/↓ tags; +~? chip; per-file x/y render; `sessionOn()`; log-error swallow; 8000/6000-char caps; error+retry/busy/loading states |
| orca `src/preload/api/git-bridge.ts:155-195` | stage/bulkStage/unstage/bulkUnstage/discard/bulkDiscard, remoteFileUrl |
| orca `listing/uncommitted-sections.tsx:95-155` | Stage all / Unstage all / Discard-all section actions; conflicts section |
| zcode `GitActionMenu.tsx:355-385` | dialog keydown: Enter submits, ↑/↓ select action |
| zcode `session/taskChangeSummary.ts:1-60` | per-turn before→after file summaries with line stats |
| paseo `branch-switcher-operations.ts:1-16` | stash list/save/pop + switch bound to one cwd |

Upstream verification (02_analyze): 7 additional spot-checks across the three repos, all matching;
5 coverage corrections to the explorer table (register above). Original research: 01_explore, 45
rows, all cited path:line.

Explorer/analyst handoffs: `.crew/artifacts/team_20261024073535_a2a56c3410bfe1d9/results/01_explore.txt`,
`.crew/artifacts/team_20261024073535_a2a56c3410bfe1d9/results/02_analyze.txt`.
