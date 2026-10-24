# Host / Project / Device / Session Management Feature Checklist — orca / paseo / zcode / herdr / piggery → durable-pi

Run: `team_20261024143910_47d06fe8b77400d4` · Steps: 01_explore (inventory) → 02_analyze (verify/correct) → 03_write (this file)
Status: **Wave 1a ADOPTED (0.0.37 — live-verified in production Chrome: bell+panel, usage chip+total row, transcript download, prompt library, bulk select bar, recent-cwds chips).** Waves 1b+ remain planning input. Companion to `docs/git-ui-checklist.md` (CLOSED): that file covered the git panel; this one covers everything **around** the agent runtime — projects/workspaces, host/device management, session lifecycle, config/credentials, diagnostics, maintenance. Git-panel features are deliberately absent here. Every load-bearing citation below was re-read in the actual files during this run (see [Verification log](#verification-log)).

## Why this doc exists

Our device/hub/session stack is real and durable, but five local reference repos have shipped
years of operational UX we have not: orca (Electron desktop app) treats a fleet of local+remote
machines as a first-class managed surface; paseo and zcode have project/workspace registries with
labels, archiving and scheduling; herdr is our TUI template and models device vitals; piggery has
CLI ops discipline (check/doctor/gc/update). This checklist inventories those features, marks what
we already cover, and sequences the remainder into adoption waves sized for PR-sized work. It is a
planning input, not a commitment: the leader picks the sequencing, and four policy decisions gate
the later waves.

**How to read it**

- Coverage vs our baseline: ✅ covered · 🟡 partial (name the delta) · ❌ missing.
- Tier: **MUST-LEARN** = orca main flows (primary reference — desktop app, richest ops UX) ·
  **SHOULD** = paseo/zcode/herdr/piggery niceties · **SKIP** = infra-specific, do not adopt.
- Waves sequence by effort/dependency: 1a FE-only → 1b small BE → 2 medium → 3 differentiators.
- Reference roots: orca `/tmp/research/orca`, paseo `/tmp/research/paseo`, zcode `/tmp/research/zcode`,
  herdr `/tmp/research/herdr/herdr-0.4.0`, piggery `/tmp/research/piggery`. Citations are repo-relative.
- Our side: `routes.ts` = `durable-pi/apps/dpi-backend/src/routes.ts`; `store.ts` = same dir;
  hub sources under `durable-pi/apps/dpi-playground/apps/dpi-playground-hub/src/`; FE components under
  `durable-pi/apps/dpi-playground/apps/dpi-playground-fe/src/`.

## Our baseline (verified today)

All line numbers re-pinned by direct read in this run.

**Devices & hub:**

- `monitor.ts:1-2,39` — one loop per registry device: probe `/v1/device`, classify
  (online/offline/unauthorized/mismatch/incompatible), then follow `/v1/events`; backoff offline
  1s→30s, human-fixable states 30s. WSS tunnel with credential auth/revocation in `tunnel.ts`;
  per-address token budgets are charged **before** a credential resolves, hub-wide bucket after
  (`tunnel.ts:369-372`, anti-starvation comment).
- Device API: GET `/device` (`routes.ts:114` — info, model catalog, `defaultModel`), POST
  `/device/probe-model` (`routes.ts:117` — one provider, one throwaway session; comment `:115-116`:
  "Local control plane only — deliberately NOT tunnelled"), GET `/fs/dirs` (`routes.ts:130`).
- Pairing: QR ceremony (`PairDeviceWizard.vue` + device `pairing.ts`); operator side in FE
  `client/pair.ts:116-123` — rotate `:116-118` (202, async via tunnel), durable revoke `:119-123`.
  **`DeviceCredentialsDialog.vue` + `TokenManager.vue` manage tunnel *pairing* credentials**
  (fingerprint, generation, rotate, revoke) — not pi provider keys (see corrections register #1).
- Offline: `OfflinePanel.vue` + the monitor's status machine/backoff. This is a strength —
  do not rebuild it.

**Sessions & agents** (`routes.ts:171-295`):

- CRUD: list/create `:172-173`, read/rename `:174-175`, archive DELETE `:178`, events SSE `:179`,
  tasks + abort `:185-199`, inspect `:200`, submissions `:201-214`.
- Agent surface: rename, fork, compact, reset, abort (incl. background), config PATCH, extensions
  PATCH, subagents, inbox withdraw — and **transcript export** GET `…/transcript?format=json|markdown`
  (`routes.ts:241` → `store.ts:1237-1239`). No FE download button, no full-bundle export.
- Session-scoped git: `/sessions/:s/git-files` `:182` and `/git-turns` `:184` (closed git checklist).

**Projects & workspaces — none.** `DPI_START_DIRS` env is the only project-adjacent surface
(`dpi-network.example.yaml:23-30` documents how `backend.env` is generated from `start_dirs` +
`env`/`env_keys`); sessions are keyed by cwd; the TUI herd view already groups sessions by cwd
(`dpi-tui/src/views.ts:72-73`). No project entity, recents, templates, or per-project settings.

**Ops:**

- `bin/dpi.mjs:23-36` — device start/stop/status (background daemon), install/uninstall
  (systemd/launchd), `devices --watch`, `update --check`.
- `bin/update.mjs:1-12` — self-update handling the two Windows hazards explicitly (EBUSY: stop the
  daemon around the update; EBADENGINE: refuse Node < 22.19.0 up front). Dependency-injected, tested.
- `hub/src/audit.ts:172-181` — disk-free guard refuses audited work when the registry volume is
  nearly full; `volumeFreeBytes()` uses `statfs` (`:183-196`). Internal only — no user-facing
  health surface. `device.log`, `/healthz` exist on the device.

**Usage:** per-agent rows in `Inspector.vue:67-72` (input/output/cacheRead/cacheWrite tokens+cost);
last-message total in `ContextBar.vue:42`. No aggregation, calendar, or provider rollup.

**TUI:** herdr-template views herd/network/agent/log (`dpi-tui/src/views.ts:10-17`), multi-host feed.

**Verified absent (grep/read this run):** no session/project search route, no recents or templates in
`NewSessionDialog.vue` (draft is exactly `{ name, cwd, model }`, `:43`), no notifications/webhook/cron
features anywhere in FE/backend/hub, no CPU/RAM/uptime surface, no env-var UI, no backup/restore,
no doctor.

## Corrections register

The analyst corrected the explorer's first draft; the writer re-verified each correction (and re-pinned a few of the analyst's own line numbers). Do not resurrect the originals.

| # | Claim | Correction | Evidence (all re-read) |
|---|---|---|---|
| 1 | "`DeviceCredentialsDialog.vue` = pi credential store, read-only" | **Wrong attribution.** That dialog + `TokenManager.vue` manage *tunnel pairing* credentials (rotate/revoke). The read-only view over pi's files lives in the backend: `dpi-backend/src/pi-config.ts:1-12` ("The device never WRITES pi's files… so a headless daemon cannot corrupt an interactive login") and `:77-89` (writes refused by returning current value). Writable provider creds remain ❌ — but the evidence points at the right place. | both files read |
| 2 | "no session export/download" | **🟡, not ❌.** Transcript export API exists (`routes.ts:241`, `store.ts:1237-1239`, json or markdown). Missing: FE download button, full-bundle export/import. | both read |
| 3 | "NO project entity, DPI_START_DIRS only" | Stays ❌, but the adjacent rail is real: `dpi-network.example.yaml:23-30` already generates per-device `backend.env` from `start_dirs` + `env`/`env_keys`, and the TUI already groups by cwd (`views.ts:72-73`) — the natural seed for a project layer. | both read |
| 4 | "no cron/scheduled" | Stays ❌, evidence sharpened: `dpi-sdk/tests/config.test.ts:25` **actively rejects** `service: cron` (launchd/systemd only). Scheduling must be a new, explicit surface — not smuggled in as a service kind. | test read; block `:21-29` |
| 5 | "route pins drift ±4" | **No drift.** The analyst reported :114/:117/:130 had drifted; writer re-read with a narrow window — GET `/device` is exactly `:114`, `probe-model` `:117`, `/fs/dirs` `:130`. Originals stand. | narrow-window read |
| 6* | (writer-time re-pins) | `config.test.ts:25` (analyst said :26); `Inspector.vue:67-72` (was :67-71); FE credential ops pinned to `client/pair.ts:116-123` (was "pair.ts:116", dir ambiguous). | all read |

\* Row 6 was pinned during the write step's final verification pass, not by the analyst.

## Policy decisions that gate later waves

Four rows below cannot default; they need the leader's decision before their wave enters the roadmap.
None of them blocks Wave 1.

1. **Crash reporting** (Wave 3) — privacy posture: what is collected, opt-in vs opt-out.
2. **Writable provider credentials** (Wave 3) — pi owns `~/.pi/agent/auth.json`; our read-only view is
   deliberate (`pi-config.ts:10-11`). A write path means deciding who owns that file.
3. **Retention / auto-archive defaults** (Wave 2) — deletes user data; needs explicit defaults and a
   dry-run story before any automatic deletion.
4. **Hub-driven remote updates** (Wave 2) — trust boundary: the hub must never push code to devices.
   Badge-only (device self-updates, hub informs) is the safe shape; anything more needs a decision.

## Wave 1a — FE-only, no BE change (start here)

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| MUST | Recent cwds in NewSessionDialog | orca `components/new-workspace/` composer (set-location/start-from) | ❌ | persist last N cwds per device in localStorage; chips under `DirBrowser` |
| MUST | Transcript download button | ours already (API `routes.ts:241` + `store.ts:1237-1239`); FE shape from orca export flows | 🟡 | button on Inspector → `GET …/transcript?format=markdown` → Blob download |
| MUST | Prompt library (quick commands) | orca `settings/QuickCommandsPane.tsx` (+List/ScopeFilter) | ❌ | localStorage snippets; insert-on-click into the composer |
| MUST | Bulk session manage (multi-select) | orca `settings/ManageSessionsSection.tsx` + `ManageSessionKillDialog.tsx` | 🟡 (archive `:178`, abort `:195` exist) | checkbox column in NetworkSidebar; client-side loop + per-row result chips |
| SHOULD | In-app notification center | orca `notifications/notification-delivery-service.ts:15-49`; piggery `docs/reference.md:15` | ❌ | toast feed derived from the existing `/events` stream (task done, attention needed); no webhook yet |
| SHOULD | Usage rollup header | orca `usage/usage-calendar-range.ts` | 🟡 (per-agent only, `Inspector.vue:67-72`) | sum the per-agent rows → device-level chip in NetworkSidebar |

## Wave 1b — small BE, PR-sized endpoints

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| MUST | Device vitals endpoint + card | herdr `shared/types.ts:19` (`Device.uptime`, `since`); piggery `top` (`docs/reference.md:22`) | ❌ | GET `/device/vitals`: `os.uptime`, loadavg, memoryUsage, statfs free — reuse the `audit.ts:183-196` statfs pattern; small FE card |
| MUST | `dpi doctor` | piggery `check`/`doctor` (`docs/reference.md:33-34`) | ❌ | CLI one-shot: healthz + probe-model + start_dirs writability + registry reachable + node ≥ 22.19; exit 1 on findings |
| SHOULD | Session search (device-side first) | paseo `packages/server/src/server/agent-history-search.ts` | ❌ | v1: match over session names/cwd (cheap). **Do not naive-LIKE transcripts at volume** — entries need an FTS/index plan first |
| SHOULD | Session export bundle | paseo `packages/server/src/server/exports.ts` | 🟡 (transcript API ✅) | one endpoint: zip session JSON + transcripts + agent configs; import later |

## Wave 2 — medium

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| MUST | Project entity + labels + archive | paseo `workspace-registry.ts:22-40` (`PersistedProjectRecord`: projectId/rootPath/kind/displayName/projectKey with COMPAT migration, customName; atomic writes via `atomic-file.ts`); zcode `packages/services/src/project/CONTRACT.md` + `autoArchiveScheduler.ts` | ❌ | registry keyed on cwd; promote the TUI's group-by-cwd (`views.ts:72-73`) into an entity; copy paseo's schema-migration discipline |
| MUST | Scheduled sessions (device-side) | orca `automations/service.ts:186-211` (scheduled trigger, precheck, completion watcher; separate drift report) | ❌ | systemd timer / launchd job through the existing service layer; the **device** owns execution, the hub only displays. New surface — `config.test.ts:25` rejects `service: cron` by design |
| MUST | Usage dashboard | orca `usage/agent-token-usage.ts` + `usage-calendar-range.ts` (46-file suite incl. per-provider parsers) | 🟡 | persist the Inspector-shaped rows → per-device/per-provider/calendar views; entries already carry usage |
| SHOULD | Notification delivery fan-out | orca `notification-delivery-service.ts:15-49` (tray→mobile→desktop, burst cooldown); piggery notify hooks desktop/herdr/ntfy (`docs/reference.md:15`) | ❌ | webhook + ntfy targets driven from existing events; per-device cooldown like orca's |
| SHOULD | Env-var management UI | orca `settings/HostAgentEnvironmentEditor.tsx` + `agent-default-env-draft.ts` | ❌ | edit the `env`/`env_keys` blocks of `dpi-network.yaml` (the file that generates `backend.env`, `dpi-network.example.yaml:23-30`) |
| MUST | Retention / auto-GC — **policy #3** | orca `terminal-history-gc.ts`; piggery `gc --closed-before DURATION [--dry-run]` (`docs/reference.md:31`) | 🟡 (archive exists, no deletion policy) | archive → verify → delete, `--dry-run` first (piggery pattern); defaults need leader sign-off |
| SHOULD | Remote update badge — **policy #4** | orca `ssh/managed-server-update-check.ts` + `orcad-update-plan.ts` | 🟡 (`dpi update --check` exists, `dpi.mjs:36`) | hub compares `/device` version vs registry → badge. Device always self-updates; hub never pushes code |
| SHOULD | Backup/restore of session data | orca `rolling-file-backup.ts`; paseo `migrations/` (schema side) | ❌ | rolling copies of registry + device store ahead of schema migrations |
| SHOULD | Rate-limit surfacing | orca `rate-limits/` | ❌ | parse provider 429/limit info at probe/send time → hint in model picker |
| SHOULD | Per-project settings/instructions | orca `settings/RepositoryPane.tsx` | ❌ | after the project entity: per-project model/env defaults |

## Wave 3 — differentiators / later

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| MUST | Interactive SSH suite | orca `src/main/ssh/` (connection, `port-forwarding/`, `remote-exec/`, `sftp-upload.ts`; the orcad-* provisioning suite is 100+ files) | 🟡 (ssh exists as a device *kind* for transport) | smallest slice first: sftp browse with the `/fs/dirs` shape over ssh; shell/port-forward later |
| SHOULD | Keep-awake during runs | orca `agent-awake-service.ts:53-97` (powerSaveBlocker, LinuxLidSleepAssertion, MacosSystemSleepAssertion, powerMonitor resume) | ❌ | device asserts no-sleep while any session is busy; electron-free needs a per-OS helper — cost it before committing |
| SHOULD | Bulk resume-after-restart UX | orca `NativeChatResumeOnRestartModal.tsx` (+ bulk-progress test) | 🟡 (durability exists — sessions survive daemon restarts) | post-restart modal listing interrupted sessions + one-click reopen, per-session progress |
| SHOULD | Telegram channel bridge | zcode `packages/services/src/bots/telegramChannelRuntime.ts` | ❌ | channel message → existing session inbox submission surface |
| SHOULD | Conversation share | zcode `packages/services/src/conversation-share/` | ❌ | builds on the 1b export bundle; decide retention first |
| SHOULD | Task-graph orchestration | paseo `packages/server/src/server/tasks/task-graph.ts` (+execution-order); zcode `task-groups/` | ❌ | multi-session DAG on top of durable jobs (run/check/approval already exist) |
| SHOULD | Diagnostic bundle | orca `settings/PrivacyDiagnosticBundleControls.tsx` | ❌ | redacted zip: versions, healthz, tunnel diagnostics, recent audit denies |
| SHOULD | Crash reporting — **policy #1** | orca `crash-reporting/` | ❌ | opt-in only if adopted at all; leader decides privacy posture |
| — (policy) | Writable provider credential store | orca `credentials/encrypted-api-key-file-store.ts` | ❌ (read-only by design, `pi-config.ts:10-11`) | **policy #2** — any write path needs an ownership decision over `~/.pi/agent/auth.json`; do not default |
| — | Remote daemon deploy (orcad-style) | orca `ssh/orcad-ssh-provisioning.ts` + migration/cutover suite | 🟡 (`dpi device install` covers local) | only if the SSH suite lands and manual deploy still hurts; orcad is an entire subsystem |

## SKIP — infra-specific, do not adopt

- **Worktree management** — already adopted; closed in `docs/git-ui-checklist.md`.
- **OS keychain / vault** (orca `macos-keychain/`, `ai-vault/`) — pi owns credential storage; our
  device is deliberately read-only over pi's files (`pi-config.ts:10-11`).
- **zcode settings-sync / skill-sync / plugin-sync** — the pi ecosystem syncs its own settings and skills.
- **zcode feishu/weixin channels** — CN-specific infra; telegram is the only channel worth costing.
- **orca ephemeral VM runtimes** (`ephemeral-vm/`) — the exe-dev device kind plus the
  agent-sandboxes cookbook already cover the pattern.
- **orca updater internals** (`updater-prerelease-feed.ts`, `linux-package-update-recovery.ts`) —
  Electron-distribution-specific; ours is npm + `bin/update.mjs` with EBUSY/EBADENGINE handled (`:1-12`).
- **piggery implementation internals** (Go, `internal/server/`) — behavior reference only; any port
  is a re-implementation.

## UX shape by repo

- **orca** — a desktop ops center: one settings pane per concern, host-scoped setting scopes,
  notifications with delivery policy and burst cooldown, and a 100+-file remote-daemon subsystem
  (fencing, migrations, cutover journals). Copy the *flows*, not the subsystem size.
- **paseo** — server-side registry discipline: zod-validated records with dated COMPAT migrations,
  atomic writes, archive policies driven by merge events.
- **zcode** — contracts first: `project/CONTRACT.md` defines the entity, the scheduler is a service
  beside it, channels and share are pluggable runtimes.
- **herdr** — one `shared/types.ts` feeds both clients; `Device.uptime`/`since` render inline in the
  tree — the cheapest vitals UX of the five.
- **piggery** — CLI ops discipline: `check` validates config without side effects, `doctor` reports
  state findings, `gc` defaults to dry-run, every destructive op asks once.
- **durable-pi today** — strong device/session durability and offline story; thin ops surface
  (no vitals, no notifications, no project entity, no doctor).

## Verification log

- **Writer (03_write, this run) — re-read and re-pinned:** `routes.ts` (:114/:117/:130 narrow-window;
  session block :171-214; agents :216-295; transcript :241), `store.ts:1230-1241`, `pi-config.ts`
  (read-only design :1-12, :77-89), `views.ts` (:10-17, herd group-by-cwd :72-73), `Inspector.vue:62-75`,
  `ContextBar.vue:38-47`, `tunnel.ts:362-375`, `dpi-sdk/tests/config.test.ts:18-31`,
  `dpi-network.example.yaml:20-35`, `NewSessionDialog.vue:1-75` (draft shape :43),
  FE `client/pair.ts:108-123`, `monitor.ts:1-45`, `audit.ts:155-196`, `bin/dpi.mjs:22-39`,
  `bin/update.mjs:1-12`; reference side: orca `automations/service.ts:183-212`,
  `agent-awake-service.ts:53-97`, `notifications/notification-delivery-service.ts:15-49`,
  plus directory confirmations of `ssh/`, `usage/`, `credentials/`, `project-groups/`;
  paseo `workspace-registry.ts:1-40`, `project-directory-service.ts:7-36`, server dir listing
  (`agent-history-search.ts`, `connected-hosts/`, `schedule/`, `push/`, `exports.ts`, `migrations/`);
  zcode `project/` listing (CONTRACT.md, contract.ts, autoArchiveScheduler.ts), `bots/`,
  `conversation-share/`, `credential/`; herdr `shared/types.ts:1-40`; piggery `docs/reference.md:9-36`.
- **Analyst (02_analyze)** — additionally read: `DeviceCredentialsDialog.vue` and `TokenManager.vue`
  (full), `pairing.ts`, `dpi-backend/README.md`, `drivers.ts:118`, `dpi-sdk/src/node/config.ts:63`,
  FE greps (credential/usage/transcript/notification/cron — no feature matches beyond those listed).
- **Explorer (01_explore)** — original inventory with citations; baseline component list; first-draft
  coverage marks (5 corrected above).

*Planning input, not a commitment.* Wave 1a can start immediately (FE-only, touches no policy);
Waves 2–3 are gated by the four policy decisions above.
