import type {
  AgentConfig,
  AgentDetail,
  AgentExtensions,
  AgentSummary,
  CompactionSettings,
  ArchivedView,
  EnvFileView,
  PiAuthView,
  PiAuthWriteResult,
  GraphRecord,
  GraphRunRecord,
  GraphTask,
  EnvVarView,
  CreateAgentBody,
  CreateSessionBody,
  DeviceInfo,
  DeviceTree,
  DeviceVitals,
  DirListing,
  ErrorCode,
  ForkBody,
  Frame,
  DeviceUsageReport,
  NotifyDelivery,
  NotifySinkBody,
  NotifySinkView,
  Page,
  ProjectPatchBody,
  ProjectRecord,
  SchedulePatchBody,
  ScheduleView,
  SendResult,
  SessionSearchResult,
  SessionSummary,
  TaskOutcome,
  WhenBusy,
  WireEntry,
} from "./api.js";
import { DpiError } from "./errors.js";
import { Backoff } from "./protocol/backoff.js";
import { RECONNECT_BACKOFF_S } from "./protocol/limits.js";
import { readSse } from "./sse.js";

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
}

const enc = encodeURIComponent;
const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** "My session #1" → "my-session-1" — mirrors the device's download slug (zip.ts). */
const slugName = (input: string): string =>
  input
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase() || "session";

/**
 * Typed client for one dpi-backend. Works in browsers and Node (fetch + streams).
 * `token` is optional: the playground hub injects it, so browsers never hold one.
 */
export interface GitStatus {
  repo: boolean;
  root?: string;
  branch?: string;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  head?: string;
  subject?: string;
  worktreeOf?: string;
  worktrees?: { path: string; branch: string | null; head: string }[];
  /** ±n line counts from numstat; -1 marks a binary file. */
  files?: { path: string; x: string; y: string; a?: number; d?: number }[];
  branches?: { name: string; current?: boolean; upstream?: string }[];
  merge?: boolean;
  conflicts?: number;
  identity?: { name?: string; email?: string };
  remoteUrl?: string;
}
export type GitOpName =
  | "diff"
  | "log"
  | "log-list"
  | "fetch"
  | "pull"
  | "switch"
  | "branch"
  | "commit"
  | "worktree-list"
  | "worktree-add"
  | "worktree-remove"
  | "push"
  | "stage"
  | "discard"
  | "diff-file"
  | "stash-push"
  | "stash-pop"
  | "unstage"
  | "compare"
  | "merge-abort"
  | "show-files"
  | "ignore"
  | "checkpoint"
  | "checkpoints"
  | "rewind"
  | "resolve"
  | "submodule-update"
  | "pr-create"
  | "pr-list"
  | "pr-merge"
  | "pr-checks"
  | "pr-comment";

/** One zipped session bundle, downloaded as raw bytes (R8 binary contract):
 *  the device streams plain `application/zip` bytes, so there is no base64
 *  hop. Hand `bytes` straight to `new Blob(...)` in the browser or to
 *  `fs.writeFile` in Node. */
export interface SessionExport {
  /** The device's download name (`${slug}.bundle.zip`), from Content-Disposition
   *  — a slug of the session ref when the peer sends no usable header. */
  filename: string;
  /** The response's media type; `application/zip` from the device route. */
  mime: string;
  /** The zip payload, byte-for-byte as the device streamed it. */
  bytes: Uint8Array;
}

/** Everything a git op may return; most carry only text. */
export interface GitOpResult {
  text: string;
  commits?: { hash: string; refs: string; author: string; date: string; subject: string; parents: string[] }[];
  ahead?: number;
  behind?: number;
  changed?: { status: string; path: string }[];
  checkpoints?: { name: string; hash: string; date: string; subject: string }[];
  prs?: { n: number; title: string; state: string; draft: boolean; branch: string; url: string }[];
}

export class DpiClient {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly token?: string,
    /** R13 (R9-6.3 FE): fired when a request's response carried
     *  Idempotent-Replay: true — the answer is a REPLAY of an earlier
     *  identical request, not a fresh effect. UIs use it to tell the user;
     *  clients that need deliberate repeats send their own idempotencyKey. */
    private readonly hooks: { onIdempotentReplay?: (path: string) => void } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(json: boolean, extra: Record<string, string> = {}) {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}`, "x-dpi-token": this.token } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
      ...extra,
    };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        signal,
        headers: this.headers(
          body !== undefined,
          options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {},
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      throw new DpiError("offline", `Cannot reach ${this.baseUrl}`, 0, { cause });
    }
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!response.ok) {
      const error = (data as { error?: { code?: ErrorCode; message?: string } } | undefined)?.error;
      const code: ErrorCode =
        error?.code ??
        (response.status === 401 ? "unauthorized" : response.status === 404 ? "not_found" : "internal");
      throw new DpiError(code, error?.message ?? `${response.status} ${response.statusText}`, response.status);
    }
    if (response.headers.get("idempotent-replay") === "true") this.hooks.onIdempotentReplay?.(path);
    return data as T;
  }

  /** Open one SSE stream and yield its frames until it ends. Throws `DpiError` on failure. */
  async *stream(path: string, signal: AbortSignal, idleMs?: number): AsyncGenerator<Frame> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        headers: { ...this.headers(false), accept: "text/event-stream" },
        signal,
      });
    } catch (cause) {
      if (signal.aborted) return;
      throw new DpiError("offline", `Cannot reach ${this.baseUrl}`, 0, { cause });
    }
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => undefined)) as
        | { error?: { code?: ErrorCode; message?: string } }
        | undefined;
      const code: ErrorCode =
        body?.error?.code ?? (response.status === 401 ? "unauthorized" : "unavailable");
      throw new DpiError(code, body?.error?.message ?? `Stream failed (${response.status})`, response.status);
    }
    try {
      for await (const message of readSse(response.body, idleMs)) yield JSON.parse(message.data) as Frame;
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }

  // ------------------------------------------------------------ device
  device(options?: RequestOptions) {
    return this.request<DeviceInfo>("GET", "/v1/device", undefined, options);
  }
  /** Host health of this device (uptime, load, memory, disk) — on demand. */
  vitals() {
    return this.request<DeviceVitals>("GET", "/v1/device/vitals");
  }
  tree() {
    return this.request<DeviceTree>("GET", "/v1/tree");
  }
  /** Projects on this device: roots with labels, custom names and archive state. */
  projects(includeArchived = false) {
    return this.request<{ projects: ProjectRecord[] }>(
      "GET",
      `/v1/projects${includeArchived ? "?includeArchived=1" : ""}`,
    );
  }
  updateProject(id: string, patch: ProjectPatchBody) {
    return this.request<ProjectRecord>("PATCH", `/v1/projects/${enc(id)}`, patch);
  }
  /** POSTs carry `{}`: the hub guard 415s a bodiless POST ("JSON required"). */
  archiveProject(id: string) {
    return this.request<ProjectRecord>("POST", `/v1/projects/${enc(id)}/archive`, {});
  }
  unarchiveProject(id: string) {
    return this.request<ProjectRecord>("POST", `/v1/projects/${enc(id)}/unarchive`, {});
  }
  /** Outbound notification sinks (webhook/ntfy) on this device. */
  notifySinks() {
    return this.request<{ sinks: NotifySinkView[] }>("GET", "/v1/notify/sinks");
  }
  createNotifySink(input: NotifySinkBody) {
    return this.request<NotifySinkView>("POST", "/v1/notify/sinks", input);
  }
  updateNotifySink(id: string, patch: Partial<NotifySinkBody>) {
    return this.request<NotifySinkView>("PATCH", `/v1/notify/sinks/${enc(id)}`, patch);
  }
  removeNotifySink(id: string) {
    return this.request<{ removed: boolean }>("DELETE", `/v1/notify/sinks/${enc(id)}`);
  }
  /** Fire a test event through every enabled sink. */
  testNotifySinks() {
    return this.request<{ results: NotifyDelivery[] }>("POST", "/v1/notify/test", {});
  }
  /** The device's env file (managed keys read-only, secrets masked). */
  envView() {
    return this.request<EnvFileView>("GET", "/v1/device/env");
  }
  setEnvVar(key: string, value: string) {
    return this.request<EnvVarView>("POST", "/v1/device/env", { key, value });
  }
  removeEnvVar(key: string) {
    return this.request<{ removed: boolean }>("DELETE", `/v1/device/env/${enc(key)}`);
  }
  /** pi provider keys — WRITE-ONLY: the view carries masked tails, never values. */
  piAuth() {
    return this.request<PiAuthView>("GET", "/v1/device/pi-auth");
  }
  setPiApiKey(providerId: string, key: string) {
    return this.request<PiAuthWriteResult>("PUT", `/v1/device/pi-auth/${enc(providerId)}`, { key });
  }
  removePiApiKey(providerId: string) {
    return this.request<{ removed: boolean; restartRequired: true }>(
      "DELETE",
      `/v1/device/pi-auth/${enc(providerId)}`,
    );
  }
  /** Task-graphs: a DAG of prompt-tasks the device runs sequentially. */
  graphs() {
    return this.request<{ graphs: Array<GraphRecord & { lastRun?: GraphRunRecord }> }>("GET", "/v1/graphs");
  }
  graph(id: string) {
    return this.request<{ graph: GraphRecord; runs: GraphRunRecord[] }>("GET", `/v1/graphs/${enc(id)}`);
  }
  createGraph(input: { name: string; cwd: string; tasks: GraphTask[] }) {
    return this.request<GraphRecord>("POST", "/v1/graphs", input);
  }
  runGraph(id: string) {
    return this.request<{ run: GraphRunRecord }>("POST", `/v1/graphs/${enc(id)}/run`, {});
  }
  removeGraph(id: string) {
    return this.request<{ removed: boolean }>("DELETE", `/v1/graphs/${enc(id)}`);
  }
  /** Scheduled sessions on this device (device-owned clock). */
  schedules() {
    return this.request<{ schedules: ScheduleView[] }>("GET", "/v1/schedules");
  }
  createSchedule(input: SchedulePatchBody & { name: string; cwd: string; prompt: string }) {
    return this.request<ScheduleView>("POST", "/v1/schedules", input);
  }
  updateSchedule(id: string, patch: SchedulePatchBody) {
    return this.request<ScheduleView>("PATCH", `/v1/schedules/${enc(id)}`, patch);
  }
  removeSchedule(id: string) {
    return this.request<{ removed: boolean }>("DELETE", `/v1/schedules/${enc(id)}`);
  }
  runSchedule(id: string) {
    return this.request<ScheduleView>("POST", `/v1/schedules/${enc(id)}/run`, {});
  }
  /** Usage rollup over the sessions this device still holds. */
  deviceUsage() {
    return this.request<DeviceUsageReport>("GET", "/v1/device/usage");
  }
  /** Session search over names/cwds/models; scope="all" adds the bounded transcript scan (R18). */
  searchSessions(query: string, scope?: "meta" | "all") {
    return this.request<SessionSearchResult>(
      "GET",
      `/v1/sessions/search?q=${enc(query)}${scope === "all" ? "&scope=all" : ""}`,
    );
  }
  dirs(path = "") {
    return this.request<DirListing>("GET", `/v1/fs/dirs?path=${enc(path)}`);
  }
  deviceDoc<T = unknown>(kind: string) {
    return this.request<{ kind: string; value: T; revision?: number }>("GET", `/v1/docs/${enc(kind)}`);
  }
  deviceEvents(signal: AbortSignal, docs: string[] = []) {
    return this.stream(`/v1/events${docs.length ? `?docs=${docs.map(enc).join(",")}` : ""}`, signal);
  }

  // ------------------------------------------------------------ git
  /** Structured git status for a folder on the device (repo:false when none).
   *  Big Windows repos can honestly take 20s+ — pass a longer timeoutMs. */
  gitStatus(path: string, options: { timeoutMs?: number } = {}) {
    return this.request<GitStatus>("GET", `/v1/git/status?path=${enc(path)}`, undefined, options);
  }
  /** One whitelisted git operation; see the device's git.ts for the op list. */
  gitOp(
    path: string,
    op: GitOpName,
    opts: {
      ref?: string;
      branch?: string;
      message?: string;
      target?: string;
      files?: string[];
      create?: boolean;
      staged?: boolean;
      rebase?: boolean;
      setUpstream?: boolean;
      name?: string;
      lines?: string[];
      side?: "ours" | "theirs";
      method?: "squash" | "merge";
      body?: string;
      n?: number;
    } = {},
  ) {
    return this.request<GitOpResult>("POST", "/v1/git", { path, op, ...opts });
  }
  /** Paths this session's agents wrote/edited — the session-changelist. */
  /** One zipped bundle of a session (manifest + record + agent transcripts/configs),
   *  downloaded as RAW zip bytes since R8 — the route streams `application/zip` with
   *  Content-Length + Content-Disposition instead of the old base64 JSON envelope.
   *  Returns { filename, mime, bytes }: `filename` parsed from Content-Disposition
   *  (slug-of-ref fallback), `mime` from Content-Type, `bytes` the zip payload —
   *  Blob-able in the browser, fs.writeFile-able in Node. Refusal faults keep their
   *  JSON error bodies and throw the usual DpiError. Bundles can be large — pass a
   *  longer timeoutMs on slow links (default 60s). */
  async exportSession(sessionId: string, options: RequestOptions = {}): Promise<SessionExport> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(this.baseUrl + `/v1/sessions/${enc(sessionId)}/export`, {
        headers: this.headers(false),
        signal,
      });
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      throw new DpiError("offline", `Cannot reach ${this.baseUrl}`, 0, { cause });
    }
    if (!response.ok) {
      // Refusals keep speaking JSON faults even on this binary route.
      const text = await response.text().catch(() => "");
      let data: { error?: { code?: ErrorCode; message?: string } } | undefined;
      try {
        data = text ? (JSON.parse(text) as typeof data) : undefined;
      } catch {
        data = undefined;
      }
      const code: ErrorCode =
        data?.error?.code ??
        (response.status === 401 ? "unauthorized" : response.status === 404 ? "not_found" : "internal");
      throw new DpiError(
        code,
        data?.error?.message ?? `${response.status} ${response.statusText}`,
        response.status,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // `filename="quoted"` (the device's form) or a bare token, per RFC 6266.
    const disposition = response.headers.get("content-disposition") ?? "";
    const quoted = /filename="((?:[^"\\]|\\.)*)"/i.exec(disposition)?.[1];
    const bare = /filename=([^;\s]+)/i.exec(disposition)?.[1];
    const named = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : bare;
    return {
      filename: named || `${slugName(sessionId)}.bundle.zip`,
      mime: response.headers.get("content-type") ?? "application/zip",
      bytes,
    };
  }
  sessionGitFiles(sessionId: string) {
    return this.request<{ files: string[] }>("GET", `/v1/sessions/${enc(sessionId)}/git-files`);
  }
  /** Per-turn breakdown of the same paths (zcode taskChangeSummary). */
  sessionGitTurns(sessionId: string) {
    return this.request<{ turns: { when: string; files: { path: string; writes: number }[] }[] }>(
      "GET",
      `/v1/sessions/${enc(sessionId)}/git-turns`,
    );
  }
  /** Many paths, one round-trip — session lists want branch-per-cwd. */
  gitStatusBatch(paths: string[], options: { timeoutMs?: number } = {}) {
    return this.request<Record<string, GitStatus>>("POST", "/v1/git/status-batch", { paths }, options);
  }

  // ------------------------------------------------------------ sessions
  sessions() {
    return this.request<SessionSummary[]>("GET", "/v1/sessions");
  }
  /** Old sessions (policy #3): archived bundles, their transcripts, restore. */
  archived() {
    return this.request<{ sessions: ArchivedView[] }>("GET", "/v1/archive");
  }
  archivedTranscript(sessionId: string, format: "markdown" | "json" = "markdown") {
    return this.request<{ format: string; text?: string; items?: unknown[] }>(
      "GET",
      `/v1/archive/${enc(sessionId)}/transcript?format=${format}`,
    );
  }
  restoreArchived(sessionId: string) {
    return this.request<SessionSummary>("POST", `/v1/archive/${enc(sessionId)}/restore`, {});
  }
  createSession(body: CreateSessionBody, idempotencyKey = newId()) {
    return this.request<SessionSummary>("POST", "/v1/sessions", body, { idempotencyKey });
  }
  session(ref: string) {
    return new SessionHandle(this, ref);
  }
  agent(session: string, agent: string | number) {
    return new AgentHandle(this, session, String(agent));
  }
}

export class SessionHandle {
  constructor(
    readonly client: DpiClient,
    readonly ref: string,
  ) {}
  get base() {
    return `/v1/sessions/${enc(this.ref)}`;
  }
  get() {
    return this.client.request<SessionSummary>("GET", this.base);
  }
  rename(name: string) {
    return this.client.request<SessionSummary>("PATCH", this.base, { name });
  }
  archive() {
    return this.client.request<{ archived: string }>("DELETE", this.base);
  }
  agents() {
    return this.client.request<AgentSummary[]>("GET", `${this.base}/agents`);
  }
  createAgent(body: CreateAgentBody = {}, idempotencyKey = newId()) {
    return this.client.request<AgentSummary>("POST", `${this.base}/agents`, body, { idempotencyKey });
  }
  tasks(status: "live" | "terminal" = "terminal", limit = 20) {
    return this.client.request<TaskOutcome[]>("GET", `${this.base}/tasks?status=${status}&limit=${limit}`);
  }
  abortTask(taskId: number) {
    return this.client.request<{ status: string }>("POST", `${this.base}/tasks/${taskId}/abort`, {});
  }
  inspect() {
    return this.client.request<unknown>("GET", `${this.base}/inspect`);
  }
  compaction() {
    return this.client.request<CompactionSettings>("GET", `${this.base}/compaction`);
  }
  /** Change the session's automatic compaction thresholds; they apply from the next request. */
  setCompaction(patch: Partial<CompactionSettings>) {
    return this.client.request<CompactionSettings>("PATCH", `${this.base}/compaction`, patch);
  }
  submission(id: number, waitMs = 0) {
    return this.client.request<SendResult>("GET", `${this.base}/submissions/${id}?waitMs=${waitMs}`, undefined, {
      timeoutMs: waitMs + 20_000,
    });
  }
  events(signal: AbortSignal) {
    return this.client.stream(`${this.base}/events`, signal);
  }
}

export class AgentHandle {
  constructor(
    readonly client: DpiClient,
    readonly session: string,
    readonly agent: string,
  ) {}
  get base() {
    return `/v1/sessions/${enc(this.session)}/agents/${enc(this.agent)}`;
  }
  get() {
    return this.client.request<AgentDetail>("GET", this.base);
  }
  rename(name: string) {
    return this.client.request<AgentSummary>("PATCH", this.base, { name });
  }
  send(content: string, whenBusy: WhenBusy = "followUp", requestId = newId(), waitMs?: number) {
    return this.client.request<SendResult>(
      "POST",
      `${this.base}/messages`,
      { content, whenBusy, requestId, waitMs },
      { timeoutMs: (waitMs ?? 0) + 20_000 },
    );
  }
  withdraw(submissionId: number) {
    return this.client.request<{ status: string }>("DELETE", `${this.base}/inbox/${submissionId}`);
  }
  abort(background = false) {
    return this.client.request<{ ok: true }>("POST", `${this.base}/abort`, { background });
  }
  fork(body: ForkBody, idempotencyKey = newId()) {
    return this.client.request<AgentSummary>("POST", `${this.base}/fork`, body, { idempotencyKey });
  }
  config() {
    return this.client.request<AgentConfig>("GET", `${this.base}/config`);
  }
  configure(patch: Partial<AgentConfig>) {
    return this.client.request<AgentConfig>("PATCH", `${this.base}/config`, patch);
  }
  compact(instructions?: string) {
    return this.client.request<{ taskId: number }>("POST", `${this.base}/compact`, { instructions });
  }
  reset(note?: string) {
    return this.client.request<{ ok: true }>("POST", `${this.base}/reset`, { note });
  }
  entries(options: { scope?: "active" | "all"; cursor?: string; limit?: number } = {}) {
    const q = new URLSearchParams({
      scope: options.scope ?? "all",
      limit: String(options.limit ?? 500),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    return this.client.request<Page<WireEntry>>("GET", `${this.base}/entries?${q}`);
  }
  transcript(format: "json" | "markdown" = "json") {
    return this.client.request<{ format: string; text?: string; items?: unknown[] }>(
      "GET",
      `${this.base}/transcript?format=${format}`,
    );
  }
  doc<T = unknown>(kind: string) {
    return this.client.request<{ kind: string; value: T }>("GET", `${this.base}/docs/${enc(kind)}`);
  }
  extensions() {
    return this.client.request<AgentExtensions>("GET", `${this.base}/extensions`);
  }
  /** Turn a custom extension on or off, or check or uncheck one of system-prompts' prompts. */
  setExtension(patch: { name: string; enabled: boolean } | { prompt: string; enabled: boolean }) {
    return this.client.request<AgentExtensions>("PATCH", `${this.base}/extensions`, patch);
  }
  demo<T = unknown>(path: string, body: unknown, method = "POST") {
    return this.client.request<T>(method, `${this.base}/demo/${path}`, body);
  }
  events(signal: AbortSignal, docs: string[] = []) {
    return this.client.stream(
      `${this.base}/events${docs.length ? `?docs=${docs.map(enc).join(",")}` : ""}`,
      signal,
    );
  }
}

export type ConnectionState = "connecting" | "live" | "offline" | "unauthorized" | "gone";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    // R18 (run-4 h5): remove the abort listener on the timer path too — a
    // completed sleep used to leave one listener on the long-lived signal,
    // and a flapping device retained closures without bound.
    const onAbort = () => (clearTimeout(timer), resolve());
    const timer = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Keep one stream open: reconnect with backoff, and start every reconnect from the server's fresh
 * snapshot (streams never replay). Stops for good on `unauthorized` or `not_found`.
 */
export async function follow(
  open: (signal: AbortSignal) => AsyncIterable<Frame>,
  onFrame: (frame: Frame) => void,
  onState: (state: ConnectionState, error?: DpiError) => void,
  signal: AbortSignal,
) {
  const backoff = new Backoff(RECONNECT_BACKOFF_S);
  while (!signal.aborted) {
    onState("connecting");
    try {
      for await (const frame of open(signal)) {
        if (frame.type === "hello") {
          backoff.reset();
          onState("live");
        }
        onFrame(frame);
      }
      if (signal.aborted) return;
      onFrame({ type: "disconnected", reason: "Stream ended" });
    } catch (error) {
      if (signal.aborted) return;
      const e =
        error instanceof DpiError ? error : new DpiError("offline", String((error as Error)?.message ?? error));
      onFrame({ type: "disconnected", reason: e.message });
      if (e.code === "unauthorized") return onState("unauthorized", e);
      if (e.code === "not_found") return onState("gone", e);
      onState("offline", e);
    }
    await sleep(backoff.ms, signal);
    backoff.advance();
  }
}
