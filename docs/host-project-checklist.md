# Host / Project / Device / Session Management Feature Checklist — orca / paseo / zcode / herdr / piggery → durable-pi

Run: `team_20261024143910_47d06fe8b77400d4` · Steps: 01_explore (inventory) → 02_analyze (verify/correct) → 03_write (this file)
Status: **ALL WAVES ADOPTED (0.0.45 — live-verified in production Chrome: bell+panel, usage chip+total row, transcript download, prompt library, bulk select bar, recent-cwds chips; Host vitals with real uptime/load/memory/disk, tunnel-routed session search, and a bundle zip that real `unzip` opens).** Wave 2 complete (0.0.42); Wave 3 complete: diagnostics + keep-awake (0.0.43), telegram bridge + conversation share (0.0.44), task-graph DAG (0.0.45); ssh-interactivity and bulk-resume closed by design. NOTHING left on the feature list. Policy ledger: **ALL FOUR DECIDED** — #1 crash reporting local-only ✅ (0.0.46) · #2 pi credentials write-only ✅ (0.0.46) · #3 retention manual-only PERMANENTLY ✅ (user 2026-10-25: old sessions are future feature surface — nothing ever auto-deletes) · #4 remote updates hint-only badge ✅ (hub never pushes code). Companion to `docs/git-ui-checklist.md` (CLOSED): that file covered the git panel; this one covers everything **around** the agent runtime — projects/workspaces, host/device management, session lifecycle, config/credentials, diagnostics, maintenance. Git-panel features are deliberately absent here. Every load-bearing citation below was re-read in the actual files during this run (see [Verification log](#verification-log)).

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

All four are DECIDED (0.0.46, user-approved):

1. **Crash reporting — DECIDED: local-only.** One short redacted markdown file per crash under
   `<home>/backend/crashes/`; no telemetry, no upload, no opt-in question — *we cannot leak what we
   never send*. Human- and agent-readable fixed template; `dpi doctor` surfaces reports as a warn.
2. **Writable provider credentials — DECIDED: write-only.** pi keeps owning `~/.pi/agent/auth.json`;
   the device may set/remove exactly one `api_key` entry. Values never leave the file (masked tails
   only), oauth logins and corrupt files are refused, writes atomic 0600 + `.bak`.
3. **Retention / auto-archive — DECIDED: manual-only, permanently.** `dpi gc --closed-before 30d`
   (dry-run default, `--yes` to act) stays the ONLY deletion path; nothing ever schedules itself.
   Rationale (user, 2026-10-25): old sessions are a likely FEATURE surface later (search/resume/
   history mining), so the device must never silently destroy them — the operator is the only deleter.
4. **Hub-driven remote updates — DECIDED: hint-only badge.** The hub informs, the device self-updates;
   the hub never pushes code to devices. If more is ever needed, that is a new decision, not a default.

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
| MUST | Device vitals endpoint + card | herdr `shared/types.ts:19` (`Device.uptime`, `since`); piggery `top` (`docs/reference.md:22`) | ✅ (`0.0.38`) | GET `/device/vitals` (`vitals.ts`: uptime, loadavg, memory, statfs free, counts) + Inspector **Host** tab (`HostPanel.vue`). On demand only — verified 0 requests until the tab opens |
| MUST | `dpi doctor` | piggery `check`/`doctor` (`docs/reference.md:33-34`) | ✅ (`0.0.38`) | `dpi doctor [--json] [--quiet]` (`doctor.ts`): node ≥ 22.19, healthz, start-dir writability, default-model probe, hub reachability; exit 1 only on FAIL, probe/hub are WARN |
| SHOULD | Session search (device-side first) | paseo `packages/server/src/server/agent-history-search.ts` | ✅ (`0.0.38`) | GET `/sessions/search?q=` matches names/cwd/models (never transcripts — FTS first). FE: instant local filter + debounced device call merged as "more on device" |
| SHOULD | Session export bundle | paseo `packages/server/src/server/exports.ts` | ✅ (`0.0.38`) | GET `/sessions/:s/export` → base64 zip (`zip.ts`, zero-dep writer): manifest + session record + per-agent transcript.json/.md + config.json. Import still later |

## Wave 2 — medium

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| MUST | Project entity + labels + archive | paseo `workspace-registry.ts:22-40` (`PersistedProjectRecord`: projectId/rootPath/kind/displayName/projectKey with COMPAT migration, customName; atomic writes via `atomic-file.ts`); zcode `packages/services/src/project/CONTRACT.md` + `autoArchiveScheduler.ts` | ✅ (`0.0.39`) | `projects.ts`: atomic 0600 registry with `.bak` + v0→v1 COMPAT migration, customName/labels/archive; seeded from every session cwd on boot and on create. FE `ProjectBar.vue` chips filter the tree, name/labels/archive through the app-styled prompt |
| MUST | Scheduled sessions (device-side) | orca `automations/service.ts:186-211` (scheduled trigger, precheck, completion watcher; separate drift report) | ✅ (`0.0.40`) | `schedules.ts` registry + a 30 s unref'd device loop (`store.ts`): a run creates a **fresh session** (`<name> · <time>`), sends the prompt, records the outcome. `dpi schedule list/add/enable/disable/run/remove`; Inspector **Auto** tab. Live: run → `ok`, next run computed |
| MUST | Usage dashboard | orca `usage/agent-token-usage.ts` + `usage-calendar-range.ts` (46-file suite incl. per-provider parsers) | ✅ (`0.0.39`) | GET `/device/usage` sums each harness's usage per session/model/project; Inspector **Usage** tab. Live: 4,307 tok → `opencode-go/claude-haiku-5-5`, attributed to its project. No calendar/persistence yet (archived sessions are closed stores) |
| SHOULD | Notification delivery fan-out | orca `notification-delivery-service.ts:15-49` (tray→mobile→desktop, burst cooldown); piggery notify hooks desktop/herdr/ntfy (`docs/reference.md:15`) | ✅ (`0.0.41`) | `notify-sinks.ts`: webhook + ntfy sinks, per-(sink,event-kind) 10 s cooldown, SSRF guard with `DPI_NOTIFY_ALLOW_PRIVATE=1` for LAN. Events: `session.failed`, `schedule.ok`, `schedule.failed`, `test`. `dpi notify list/add/enable/disable/remove/test/events`; Inspector **Notify** tab. Live: ntfy.sh received the test sent from the panel |
| SHOULD | Env-var management UI | orca `settings/HostAgentEnvironmentEditor.tsx` + `agent-default-env-draft.ts` | ✅ (`0.0.42`) | `env-vars.ts`: the DEVICE's env file, not the laptop's yaml — managed keys (DPI_TOKEN/port/…) refused, secret-NAMED values return masked (`••••••••t123`), process-only vars listed read-only (`loadEnvFile` never overrides them). `GET/POST/DELETE /v1/device/env`; Inspector **Env** tab with a restart-required banner (nothing pretends to hot-apply). Caught live: the hub caches the tunnel allowlist in memory, so new device routes also need a hub restart |
| MUST | Retention / auto-GC — **policy #3** | orca `terminal-history-gc.ts`; piggery `gc --closed-before DURATION [--dry-run]` (`docs/reference.md:31`) | ✅ manual-only (`0.0.40`) | `gc.ts` + `dpi gc --closed-before 30d [--yes]`: **dry-run is the default and nothing schedules itself** — and per the user's decision (2026-10-25) this is PERMANENT: no auto-archive will ever ship, because old sessions are a likely future feature surface (search/resume/history mining). The operator is the only deleter |
| SHOULD | Remote update badge — **policy #4** | orca `ssh/managed-server-update-check.ts` + `orcad-update-plan.ts` | ✅ (`0.0.40`) | `GET /api/version` (hub walks up to the `my-durable` package.json) + device `packageVersion` in `/v1/device` → tree badge "update". Hint only: devices self-update, the hub never pushes code. Verified 0 badges when versions match, and the 1.3.0-vs-0.0.39 trap (pi-durable's version) is fixed by reporting both |
| SHOULD | Backup/restore of session data | orca `rolling-file-backup.ts`; paseo `migrations/` (schema side) | ✅ (`0.0.42`) | `dpi backup create|list|restore` (executor module + 16 tests): whole-home zip (binary-capable writer reusing zip.ts's crc32) into a SIBLING `<home>-backups/` dir so a backup never contains itself; restore is plan-first (`--yes`), refuses while the daemon answers healthz, and never deletes — the old home becomes `home.bak-<ts>`. Live: 73 files / 5.4 MiB from the real device home, `unzip`/`zipfile`-clean, restore refused with exit 1 while running |
| SHOULD | Rate-limit surfacing | orca `rate-limits/` | ✅ device-side (`0.0.41`) | `classifyProviderError`: 429/quota → `rate_limited` (+`retryAfterMs` from Retry-After), 401/403 → `auth`, 404 → `missing`; `probeModel` returns the provider's own words, `dpi doctor` prints "rate limited — retry in 30s" / "provider key rejected". **Not** in the web picker: `probe-model` is deliberately local-only (never tunnelled), so the FE cannot probe |
| SHOULD | Per-project settings/instructions | orca `settings/RepositoryPane.tsx` | ✅ (`0.0.42`) | `model` on the project record (`""` clears): a session created with no model under a project uses the project's model — device-side (`store.create` via longest-registered-root lookup, so schedules/spawns inherit too) and visible in the FE (ProjectBar "model ✓" editor validating against the catalog; NewSessionDialog prefills the picker once the cwd names the project). Per-project ENV defaults were deliberately not built: sessions have no per-session env surface to plug into. Live: curl-created session in gitdemo landed on `zai/glm-4.7` with no model in the body; picker prefill verified in Chrome |

## Wave 3 — differentiators / later

| Tier | Feature | Source (path:line) | Ours | Adoption suggestion |
|---|---|---|---|---|
| MUST | Interactive SSH suite | orca `src/main/ssh/` (connection, `port-forwarding/`, `remote-exec/`, `sftp-upload.ts`; the orcad-* provisioning suite is 100+ files) | ✅ by design (`0.0.43`) | leader decision: the WSS tunnel already IS our authenticated remote channel — browse (`/fs/dirs`), git, sessions/exec all run over it behind the rest allowlist (`rest-routes.ts`), and `kind: ssh` + `sshDriver` remain the *bring-up* transport for `just net up`. An ssh path into the hub would bypass the pairing/allowlist trust model, so it is deliberately not built |
| SHOULD | Keep-awake during runs | orca `agent-awake-service.ts:53-97` (powerSaveBlocker, LinuxLidSleepAssertion, MacosSystemSleepAssertion, powerMonitor resume) | ✅ (`0.0.43`) | `awake.ts` + store wiring on notify (1 s debounce, unref'd, never throws): systemd `--what=idle --mode=block` on Linux (verified live: a user MAY hold idle:block; sleep:block answers Access denied, so lid-close/root suspend deliberately still win), `caffeinate -i -s` on macOS, honest `none` elsewhere (`keepAwake` in deviceInfo + HostPanel row). Two live-caught bugs: `require()` in ESM killed the spawn silently, and the first proof missed because the turn finished before the check — held T+6/15/30 s, released at zero busy |
| SHOULD | Bulk resume-after-restart UX | orca `NativeChatResumeOnRestartModal.tsx` (+ bulk-progress test) | ✅ by durability (`0.0.43`) | pi-durable already does what orca's modal needs a click for: `TaskScheduler.open` turns surviving `running` tasks back to `pending` and `Harness.resume()` re-dispatches — the device's boot loop calls it for every session, so interrupted work continues with NO user action. A "list of interrupted sessions" modal would list work that already resumed itself |
| SHOULD | Telegram channel bridge | zcode `packages/services/src/bots/telegramChannelRuntime.ts` | ✅ (`0.0.44`) | `telegram.ts` (executor, 28 tests): long-poll loop with offset persisted BEFORE handling (a crash never re-handles), chat↔session binding via a 10-minute single-use `/start <code>` from `dpi telegram bind` (strangers are ignored silently), `/status /stop /session <prefix> /help`; plain text → the bound session's agent, the answer returns as a Telegram reply (120 s cap). Token `DPI_TELEGRAM_TOKEN` in the env file (the 0.0.42 env UI manages it). Live: a fake token made the REAL api.telegram.org answer 401 and the loop stopped itself with the right warning; capability `telegram` appears in deviceInfo only while the loop runs |
| SHOULD | Conversation share | zcode `packages/services/src/conversation-share/` | ✅ (`0.0.44`) | hub `shares.ts`: the shell uploads prepared transcripts (it holds the tunnel creds — the hub never talks to devices for this) and gets a tokenized PUBLIC link; **retention decided: 7-day expiry, swept on create/get/list, admin DELETE kills early** (the row demanded that decision up front). Public page is server-rendered, escaped, CSP `default-src 'none'; style-src 'unsafe-inline'`, zero scripts; junk/expired/deleted tokens all 404 identically. Live in Chrome: share button → confirm (says what "public" means) → link + expiry toast → page renders logged-out → admin delete → 404 |
| SHOULD | Task-graph orchestration | paseo `packages/server/src/server/tasks/task-graph.ts` (+execution-order); zcode `task-groups/` | ✅ (`0.0.45`) | `graphs.ts` (executor, 32 tests) + a store engine: a graph is a validated DAG (Kahn cycle refusal naming the ring), run sequentially in topological order — deterministic on one device; **each task = a fresh session** (the schedules rule), turn completion detected via `settled` polling with a 30-min ceiling; failure cascades `skipped` to dependants; a restart flips a running run to `interrupted` with tasks back to pending (re-run continues); events `graph.ok`/`graph.failed`. Routes `GET/POST/PATCH/DELETE /graphs` + `/:id/run`; Inspector **DAG** tab; `dpi graph list\|show\|add\|run\|remove`. Live: demo-dag on the real device — T+8s `alpha ok, beta running`, T+16s `ok`; FE shows per-task statuses with deps. Built on the session-submission surface (schedules-proven), not the per-session job API — a cross-session DAG over jobs would need multi-session job plumbing this stack does not have; approval-gate nodes are a natural follow-up |
| SHOULD | Diagnostic bundle | orca `settings/PrivacyDiagnosticBundleControls.tsx` | ✅ (`0.0.43`) | `dpi diagnostics` (executor module, 14 tests): 10-section 0600 zip — manifest, doctor, device/vitals/env, sessions/projects/schedules/notify, 400-line redacted `device.log` tail. Sections fail independently (a dead device still produces a bundle). `redact()` strips dpi_/Bearer/sk- shapes; verified on the LIVE device: 10/10 ok, **0 raw tokens in any entry**. Hub-side audit denies still not included (the device cannot read the hub's audit log — a hub-side bundle would be a separate feature) |
| SHOULD | Crash reporting — **policy #1** | orca `crash-reporting/` | ✅ (`0.0.46`) | **DECIDED: local-only** — `crash.ts` (executor, 11 tests) writes ONE short markdown file per crash to `<home>/backend/crashes/` (newest 10 kept). There is no telemetry, no upload, no opt-in question at all: *we cannot leak what we never send*. The template is fixed-headings, ~24 lines, readable by a human or an independent agent; every line passes `redactLine()` (sk-/dpi_/adm_/Bearer/PRIVATE KEY shapes — live probe: `sk-<redacted>`, `DPI_TOKEN=<redacted>`). `uncaughtException` → report + exit 1; `unhandledRejection` → report, keep running (Node's own posture). Handlers install BEFORE loadConfig in `main.ts` (a config failure still reports); state counts arrive via a never-throwing snapshot. `dpi doctor` shows a **warn** row with age + filename (a past crash is information, not a broken device); diagnostics carry the same check. Live-proven: a real thrown error → exit 1 → redacted report → doctor `warn crash reports — 1 report — newest just now` |
| — (policy) | Writable provider credential store | orca `credentials/encrypted-api-key-file-store.ts` | ✅ (`0.0.46`) | **DECIDED: write-only over pi's own file.** pi keeps owning `~/.pi/agent/auth.json`; the device may SET/REMOVE an `api_key` entry in it — nothing else. Security rules (each tested): **values never leave the file** (`GET /v1/device/pi-auth` returns names + type + source + masked tail `••••••••9999` only); **pi's interactive logins are untouchable** (an `oauth` entry is refused on write AND delete with a pointer to pi); **a corrupt auth.json is refused, not rewritten**; writes are atomic tmp+rename 0600 with a `.bak`, and every OTHER entry survives byte-for-byte (live-verified: after add+remove of a test key, all five real providers' values identical). Web surface: Env tab **PI KEYS** card — password input + `autocomplete=off`, cleared the moment a save lands, remove behind a danger confirm; the key transits the TLS tunnel in the PUT body and is never echoed, logged, or stored FE-side. Restart-required banner like the env file (creds load at boot). FE test asserts the panel never interpolates a raw key |
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
