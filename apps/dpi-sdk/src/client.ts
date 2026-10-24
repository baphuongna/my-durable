import type {
  AgentConfig,
  AgentDetail,
  AgentExtensions,
  AgentSummary,
  CompactionSettings,
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
  Page,
  ProjectPatchBody,
  ProjectRecord,
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
  /** Usage rollup over the sessions this device still holds. */
  deviceUsage() {
    return this.request<DeviceUsageReport>("GET", "/v1/device/usage");
  }
  /** Session search over names/cwds/models (transcripts are not scanned). */
  searchSessions(query: string) {
    return this.request<SessionSearchResult>("GET", `/v1/sessions/search?q=${enc(query)}`);
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
  /** One zipped bundle of a session (manifest + record + agent transcripts/configs). */
  exportSession(sessionId: string) {
    return this.request<{ filename: string; mime: string; bytes: number; base64: string }>(
      "GET",
      `/v1/sessions/${enc(sessionId)}/export`,
    );
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
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
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
