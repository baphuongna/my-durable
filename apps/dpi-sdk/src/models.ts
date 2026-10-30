// Client-side reducers. Each consumes stream frames and exposes plain state plus change
// notifications, so Vue, the TUI or any other renderer can sit on top without knowing the wire.
import type {
  AgentSummary,
  DeviceStatus,
  Frame,
  InboxItem,
  NetworkDevice,
  SessionSummary,
  TaskNode,
  UsageTotals,
  WireAgentEvent,
  WireAgentState,
  WireAssistantBlock,
  WireAssistantMessage,
  WireCompactionFailure,
  WireEntry,
  WireMessageChange,
  WireNestedToolResult,
  WireSnapshotEvent,
  WireUsageState,
} from "./api.js";
import { toTranscript, type LiveTool, type TranscriptItem } from "./transcript.js";

type Listener = () => void;

class Emitter {
  private listeners = new Set<Listener>();
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  protected emit() {
    for (const fn of this.listeners) fn();
  }
}

// ---------------------------------------------------------------- agent

export interface AgentViewState {
  /** Normalized transcript of the active context plus live generation and tools. */
  items: TranscriptItem[];
  /** Committed entries of the active context, ordered by id. */
  entries: WireEntry[];
  /** True between run_start and run_end (snapshot: `run` present). */
  running: boolean;
  generating: boolean;
  inbox: InboxItem[];
  agent: WireAgentState;
  usage: WireUsageState;
  retry?: { at: number; error: string };
  compactions: number[];
  /** The newest compaction failure (`pi.live.compactionFailure`); cleared by a compaction that produces a summary. */
  compactionFailure?: WireCompactionFailure;
  notices: string[];
  docs: Record<string, unknown>;
  /** Set once the first snapshot arrives. */
  ready: boolean;
}

const emptyAgentState = (): AgentViewState => ({
  items: [],
  entries: [],
  running: false,
  generating: false,
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
  compactions: [],
  notices: [],
  docs: {},
  ready: false,
});

/** Wire-controlled path elements that must never be walked or written:
 * reading node["__proto__"] returns Object.prototype and the walk descends
 * onto it silently, and "constructor" reaches the inherited Function — both
 * end in process-wide prototype pollution from a hostile/corrupt delta
 * (R15: run-1 NV v3-13). A delta carrying any of these is dropped whole
 * rather than partially applied. */
const FORBIDDEN_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function setPath(target: Record<string | number, unknown>, path: readonly (string | number)[], delta: string) {
  for (const key of path) {
    if (typeof key === "string" && FORBIDDEN_PATH_KEYS.has(key)) return;
  }
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof node[key] !== "object" || node[key] === null)
      node[key] = typeof path[i + 1] === "number" ? [] : {};
    node = node[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  // run-7 cold-1 m1: the live toolCall arguments accumulator rode the same
  // 16MiB wire ceiling per delta with no cap — fold into the 256Ki tail.
  node[last] = capLiveText(String(node[last] ?? "") + delta);
}

/** run-7 D4-B: inbox items are wire JSON — non-array or null-element shapes
 *  threw in every tasks-tab consumer; same discipline as safeTasks. */
function safeInbox(items: unknown): AgentViewState["inbox"] {
  return (Array.isArray(items) ? items : []).filter((x) => !!x && typeof x === "object") as AgentViewState["inbox"];
}

/** run-7 D3 F3: live message blocks append unbounded deltas between
 *  message_start/message_end — keep a 256Ki flattened tail (the capToolOutput
 *  principle, applied to the live accumulator). */
const LIVE_TEXT_CAP = 256 * 1024;
function capLiveText(text: string): string {
  return text.length > LIVE_TEXT_CAP ? AgentModel.flatSlice(text.slice(text.length - LIVE_TEXT_CAP)) : text;
}

export function applyMessageChange(message: WireAssistantMessage, change: WireMessageChange): WireAssistantMessage {
  if (change.type === "message") return structuredClone(change.message);
  const content = [...message.content] as WireAssistantBlock[];
  const i = change.contentIndex;
  // R19 (run-5 h10, leader-probed): the wire number was indexed raw — any
  // index > content.length creates holes that crash toTranscript's for-of
  // ("Cannot read properties of undefined"), which the SSE follow loop turns
  // into a disconnect/reconnect churn loop; a huge index also allocates a
  // length-2^32 sparse array. Validate like setPath: drop the whole change.
  if (!Number.isInteger(i) || i < 0 || i > content.length) return message;
  if (change.type === "block" || change.type.endsWith("_start")) {
    content[i] = structuredClone((change as { block: WireAssistantBlock }).block);
  } else if (change.type === "text_delta") {
    const block = content[i];
    content[i] = { type: "text", text: capLiveText((block?.type === "text" ? block.text : "") + change.delta) };
  } else if (change.type === "thinking_delta") {
    const block = content[i];
    content[i] = {
      type: "thinking",
      thinking: capLiveText((block?.type === "thinking" ? block.thinking : "") + change.delta),
    };
  } else if (change.type === "toolcall_delta") {
    const block = structuredClone(content[i] ?? { type: "toolCall", id: "", name: "", arguments: {} });
    setPath(block as unknown as Record<string, unknown>, change.path, change.delta);
    content[i] = block;
  }
  return { ...message, content };
}

/**
 * R20 cold-2 M2: agents elements ride the same JSON.parse cast — [null]
 * threw in lineage()/find() from the FE's always-render breadcrumb. Same
 * boundary discipline as safeTasks.
 */
function safeAgents(value: unknown): AgentSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is AgentSummary => !!a && typeof a === "object");
}

/**
 * R20 cold-1 M3: both tasks-bearing frame shapes (session + tasks) pass here
 * — non-array input ({} / null) crashed the old inline filter itself, and
 * null/state-less rows crashed the statusbar's every-frame deref.
 */
function safeTasks(value: unknown): TaskNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is TaskNode => !!t && typeof t === "object" && !!(t as { state?: unknown }).state);
}

export class AgentModel extends Emitter {
  state: AgentViewState = emptyAgentState();
  private entries = new Map<number, WireEntry>();
  private live?: WireAssistantMessage;
  private tools = new Map<string, LiveTool>();

  /** Apply one stream frame; returns true when state changed. */
  apply(frame: Frame): boolean {
    switch (frame.type) {
      case "snapshot":
        this.reset(frame.snapshot);
        this.state.inbox = safeInbox(frame.inbox);
        break;
      case "batch":
        // run-7 D4-B + cold-1 M6: non-iterable events AND hostile field shapes
        // (message_start.message:null, message_update.changes:5, entry:null)
        // threw inside apply(), which follow() turns into a reconnect loop
        // re-receiving the same hostile frame forever. Drop the hostile
        // EVENT, keep the stream alive.
        for (const event of (Array.isArray(frame.events) ? frame.events : []).filter((e) => !!e && typeof e === "object")) {
          try {
            this.event(event);
          } catch {
            // one hostile event must not kill the stream for the session
          }
        }
        break;
      case "inbox":
        this.state.inbox = safeInbox(frame.items);
        break;
      case "doc": {
        // run-7 D3 F2: docs was the ONE wire-driven map with neither a count
        // cap nor a byte cap — kind strings are device-chosen and values rode
        // the 16MiB wire ceiling verbatim, forever (no eviction either).
        // cold-1 M5: the KIND is the map key — oversized kinds are dropped
        // whole (the 4096-drop discipline), or 64 of them retain ~1GiB.
        if (String(frame.kind).length > 256) break;
        const kinds: Record<string, unknown> = {
          ...this.state.docs,
          [String(frame.kind)]: this.capDocValue(frame.value),
        };
        const kept = Object.keys(kinds).slice(-64); // insertion order: newest 64 survive
        this.state.docs = Object.fromEntries(kept.map((k) => [k, kinds[k]]));
        break;
      }
      default:
        return false;
    }
    this.rebuild();
    this.emit();
    return true;
  }

  /** Re-render without new data (for example after a UI toggle). */
  touch() {
    this.emit();
  }

  clear() {
    this.entries.clear();
    this.tools.clear();
    this.live = undefined;
    this.state = emptyAgentState();
    this.emit();
  }

  private rebuild() {
    const entries = [...this.entries.values()].sort((a, b) => a.id - b.id);
    this.state.entries = entries;
    this.state.generating = !!this.live;
    this.state.items = toTranscript(entries, this.live, this.tools);
  }

  private reset(snapshot: WireSnapshotEvent) {
    // run-7 D4-B: snapshot carriers arrive as raw JSON.parse casts — a
    // non-array (or null-element) shape threw in these map/filter chains and
    // follow() re-delivered the hostile snapshot forever.
    const snapEntries = (Array.isArray(snapshot.entries) ? snapshot.entries : []).filter((x) => !!x && typeof x === "object");
    const snapTools = (Array.isArray(snapshot.tools) ? snapshot.tools : []).filter((x) => !!x && typeof x === "object");
    const snapNested = (Array.isArray(snapshot.nestedTools) ? snapshot.nestedTools : []).filter((x) => !!x && typeof x === "object");
    const snapCompactions = (Array.isArray(snapshot.compactions) ? snapshot.compactions : []).filter((x) => !!x && typeof x === "object");
    this.entries = new Map(snapEntries.map((entry) => [entry.id, entry]));
    this.capEntries(); // a hostile snapshot is as unbounded as a hostile stream
    this.live = snapshot.generation?.message ? structuredClone(snapshot.generation.message) : undefined;
    this.tools = new Map(
      snapTools
        .filter((slot) => typeof slot.callId === "string" && slot.callId.length <= 4_096 && typeof slot.name === "string" && slot.name.length <= 4_096) // R20 cold-3 M1: oversized ids/names are dropped, not retained
        .slice(-2_000)
        .map((slot) => [ // R20 h4: hostile snapshot.tools was uncapped — same bound as every other path
          slot.callId,
          { name: slot.name, status: slot.status, output: this.capToolOutput(slot.output ?? "") },
        ]),
    );
    // Nested calls of running tools: they have no assistant entry, so the snapshot is the only source on attach.
    for (const slot of snapNested.filter((x) => typeof x.callId === "string" && x.callId.length <= 4_096 && typeof x.name === "string" && x.name.length <= 4_096).slice(-2_000)) {
      const existing = this.tools.get(slot.callId);
      this.tools.set(slot.callId, {
        name: slot.name,
        status: slot.status,
        output: this.capToolOutput(slot.output ?? ""),
        args: this.capArgs(slot.arguments), // R20 cold-2 M1
        nested: { parentCallId: slot.parentCallId, parentTaskId: slot.parentTaskId, taskId: slot.taskId },
        ...(slot.summary ? { summary: slot.summary } : {}),
        ...(existing ?? {}),
      });
    }
    this.capTools(); // R20 cold-1 M2: snapshot.tools(≤2000) + nestedTools(≤2000) must UNION to ≤2000
    this.state.running = !!snapshot.run;
    this.state.agent = snapshot.agent;
    this.state.usage = snapshot.usage;
    this.state.retry = snapshot.generation?.retry;
    this.state.compactions = snapCompactions.map((c) => c.taskId).slice(-64);
    this.state.compactionFailure = snapshot.compactionFailure;
    this.state.ready = true;
  }

  /**
   * R19 (run-5 h10, leader-probed): the events stream had NO aggregate cap — a
   * hostile device streaming unique ids under the 16 MiB per-event cap grew this
   * Map linearly (10k entries → +11 MB, no ceiling) until the operator's tab/TUI
   * OOMs. Cold-review MAJOR 3: the cap first lived only in commit(), so the
   * snapshot and tool_execution_end paths bypassed it — it is enforced in ONE
   * place, on every mutation.
   */
  /**
   * R19 cold-review follow-up: `tools` is the SDK's other unbounded map — 30k
   * `tool_execution_start` events grew it to 30k slots AND cost ~140 s of CPU
   * (rebuild → toTranscript is O(tools) per frame, so the stream is quadratic).
   * Same hostile-peer class as the entries cap, so the same bound.
   */
  /**
   * R20 cold-1 M2: capTools bounds the NUMBER of slots, not the bytes in one
   * slot — 100 update events each appending ~16 MiB (the per-event cap) onto
   * ONE callId retained ~1.6 GB in client state. Keep only the tail.
   */
  private static readonly MAX_TOOL_OUTPUT = 256 * 1024;
  private capToolOutput(text: string): string {
    return text.length > AgentModel.MAX_TOOL_OUTPUT ? AgentModel.flatSlice(text.slice(-AgentModel.MAX_TOOL_OUTPUT)) : text;
  }

  /**
   * R20 cold-2 M1 (probe follow-up): a V8 SlicedString RETAINS its parent —
   * a 4 KiB preview of a 2 MiB JSON kept the whole 2 MiB alive (measured
   * 607 MiB retained for 300 "bounded" slots). Round-tripping through bytes
   * detaches the slice from the parent.
   */
  static flatSlice(text: string): string { // module fns (nestedResultText) share it
    return Buffer.from(text, "utf8").toString("utf8");
  }

  /**
   * R20 cold-2 M1: `args` rode the same 16 MiB per-event ceiling as output —
   * 2000 slots x 16 MiB of verbatim args was a ~32 GiB retention path the
   * output cap did not touch. Oversized args become a bounded preview.
   */
  private static readonly MAX_ARGS = 64 * 1024;
  private capArgs(args: unknown): unknown {
    if (args === undefined || args === null) return args;
    try {
      const text = JSON.stringify(args);
      if (text.length <= AgentModel.MAX_ARGS) return args;
      return { truncated: true, preview: AgentModel.flatSlice(text.slice(0, 4_096)) };
    } catch {
      return { truncated: true };
    }
  }

  private capTools() {
    while (this.tools.size > 2_000) {
      const oldest = this.tools.keys().next().value;
      if (oldest === undefined) break;
      this.tools.delete(oldest);
    }
  }

  private capEntries() {
    while (this.entries.size > 5_000) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Store a committed entry. Resets (sent as message_end) and compactions start a new context head. */
  private commit(entry: WireEntry) {
    this.entries.set(entry.id, this.capEntry(entry));
    if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") {
      const head = entry.head ?? entry.id;
      for (const id of this.entries.keys()) if (id < head) this.entries.delete(id);
    }
    this.capEntries();
  }

  /** run-7 D3 F3: entries were count-capped but byte-uncapped (5000 × the
   *  16MiB wire ceiling, joined again by toTranscript on every rebuild).
   *  Assistant text/thinking blocks keep a flattened 256Ki TAIL + marker. */
  private capEntry(entry: WireEntry): WireEntry {
    // WireEntry.model is readonly WireMessage[]; assistant messages carry
    // content blocks whose text/thinking strings are the retention vector.
    if (!Array.isArray(entry.model)) return entry;
    for (const msg of entry.model) {
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        const block = b as { text?: unknown; thinking?: unknown };
        for (const f of ["text", "thinking"] as const) {
          const v = block[f];
          if (typeof v === "string" && v.length > LIVE_TEXT_CAP) {
            block[f] = AgentModel.flatSlice(v.slice(v.length - LIVE_TEXT_CAP)) + "…[truncated]";
          }
        }
      }
    }
    return entry;
  }

  /** run-7 D3 F2: bound a wire doc value — over 64Ki serialized it becomes a
   *  flattened 4Ki preview (the capArgs discipline). */
  private capDocValue(value: unknown): unknown {
    const text = safeStringify(value);
    if (text.length > 64 * 1024) return { truncated: true, preview: AgentModel.flatSlice(text.slice(0, 4096)) };
    return value;
  }

  private event(event: WireAgentEvent) {
    switch (event.type) {
      case "snapshot":
        return this.reset(event);
      case "run_start":
        this.state.running = true;
        return;
      case "run_end":
        this.state.running = false;
        this.live = undefined;
        return;
      case "message_start":
        if (event.message.role === "assistant")
          this.live = structuredClone(event.message as WireAssistantMessage);
        return;
      case "message_update":
        if (!this.live)
          this.live = {
            role: "assistant",
            content: [],
            provider: "",
            model: "",
            usage: event.usage,
            stopReason: "pending",
          };
        for (const change of event.changes) this.live = applyMessageChange(this.live, change);
        this.live = { ...this.live, usage: event.usage };
        return;
      case "message_end":
        this.live = undefined;
        return this.commit(event.entry);
      case "entry_appended":
        return this.commit(event.entry);
      case "tool_execution_start":
        // R20 cold-3 M1: name/callId rode the same 16 MiB per-event ceiling as
        // args — the engine's ids/names are tens of bytes, so oversized ones
        // are hostile bytes and the slot is dropped, not stored verbatim.
        if (
          typeof event.toolCallId !== "string" || event.toolCallId.length > 4_096 ||
          typeof event.toolName !== "string" || event.toolName.length > 4_096 ||
          (event.parentToolCallId !== undefined && typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 4_096)
        )
          return;
        this.capTools(); // R19: bound before the insert adds one more
        this.tools.set(event.toolCallId, {
          name: event.toolName,
          status: "running",
          output: "",
          args: this.capArgs(event.args), // R20 cold-2 M1: bounded like output
          // A nested call names the call that made it; a model-issued call has no parent.
          ...(event.parentToolCallId !== undefined && event.parentTaskId !== undefined && event.taskId !== undefined
            ? { nested: { parentCallId: event.parentToolCallId, parentTaskId: event.parentTaskId, taskId: event.taskId } }
            : {}),
        });
        return;
      case "tool_execution_update": {
        // run-7 D3 F1: the R20 cold-3 M1 4096-drop ran on the start path only;
        // this orphan path stored the id as the MAP KEY and the name verbatim
        // (16MiB × 2000 slots ceiling). Same drop discipline.
        if (typeof event.toolCallId !== "string" || event.toolCallId.length > 4_096 || typeof event.toolName !== "string" || event.toolName.length > 4_096)
          return;
        const tool = this.tools.get(event.toolCallId) ?? {
          name: event.toolName,
          status: "running" as const,
          output: "",
        };
        const output = event.output;
        if (output && "set" in output) tool.output = this.capToolOutput(output.set);
        else if (output) tool.output = this.capToolOutput(tool.output.slice(output.trimStart ?? 0) + (output.append ?? ""));
        tool.status = "running";
        this.capTools(); // R20 h4: orphan-creating path — unseen callIds must not grow the map either
        this.tools.set(event.toolCallId, tool);
        return;
      }
      case "tool_execution_end":
        if (event.entry) {
          // A model-issued call renders from its result entry; drop the live slot so it is never duplicated.
          this.tools.delete(event.toolCallId);
          this.commit(event.entry);
          this.capTools();
          return;
        }
        if (event.result) {
          // run-7 D3 F1: same drop discipline as start/update (this path also
          // stored id/name verbatim into the capped-by-count-only map).
          if (typeof event.toolCallId !== "string" || event.toolCallId.length > 4_096 || typeof event.toolName !== "string" || event.toolName.length > 4_096)
            return;
          // A nested call has no entry: keep the slot so its result still renders, exactly once.
          const tool = this.tools.get(event.toolCallId) ?? { name: event.toolName, status: "done" as const, output: "" };
          tool.status = "done";
          tool.result = { text: nestedResultText(event.result), isError: event.result.isError };
          tool.summary = { isError: event.result.isError, durationMs: event.result.durationMs };
          this.capTools(); // R20 h4: orphan-creating path — unseen callIds must not grow the map either
          this.tools.set(event.toolCallId, tool);
          return;
        }
        // Faulted, orphaned, or an unfinished slot: no entry and no result. Drop it without inventing a result.
        this.tools.delete(event.toolCallId);
        return;
      case "agent_changed":
        this.state.agent = event.agent;
        return;
      case "usage_changed":
        this.state.usage = event.usage;
        return;
      case "auto_retry_start":
        this.state.retry = { at: event.at, error: event.errorMessage };
        return;
      case "auto_retry_end":
        this.state.retry = undefined;
        return;
      case "compaction_start":
        if (!this.state.compactions.includes(event.taskId)) this.state.compactions.push(event.taskId);
        // R19: bound alongside the entries cap — fresh taskIds grow unbounded.
        if (this.state.compactions.length > 64) this.state.compactions = this.state.compactions.slice(-64);
        return;
      case "compaction_end":
        this.state.compactions = this.state.compactions.filter((id) => id !== event.taskId);
        // `error` marks a failure, fault or orphaning; its absence means a summary was produced.
        this.state.compactionFailure = event.error
          ? { taskId: event.taskId, reason: event.reason, error: event.error }
          : undefined;
        return;
      case "task_failed":
        this.state.notices = [...this.state.notices.slice(-9), `${event.kind} failed: ${event.message}`];
        return;
      default:
        return;
    }
  }
}

// ---------------------------------------------------------------- session

export interface SessionViewState {
  agents: AgentSummary[];
  tasks: TaskNode[];
  usage: UsageTotals;
  ready: boolean;
}

export function agentLabel(agent: Pick<AgentSummary, "id" | "name">) {
  return agent.name;
}

export class SessionModel extends Emitter {
  state: SessionViewState = { agents: [], tasks: [], usage: { models: {}, tools: {} }, ready: false };

  apply(frame: Frame): boolean {
    if (frame.type === "session") {
      // R20 cold-1 M3: the session frame is the FIRST frame every client gets
      // — its tasks/agents ride the same JSON.parse cast. One shared guard.
      this.state = { agents: safeAgents(frame.agents), tasks: safeTasks(frame.tasks), usage: frame.usage, ready: true };
    } else if (frame.type === "agents") this.state = { ...this.state, agents: safeAgents(frame.agents) };
    else if (frame.type === "tasks")
      // R20 h5: wire task rows are unvalidated (SSE frames are JSON.parse casts)
      // — a null/state-less element threw TypeError in backgroundTasks, which
      // the statusbar runs EVERY frame. Drop malformed rows at the boundary.
      this.state = { ...this.state, tasks: safeTasks(frame.tasks) };
    else if (frame.type === "usage") this.state = { ...this.state, usage: frame.usage };
    else return false;
    this.emit();
    return true;
  }

  clear() {
    this.state = { agents: [], tasks: [], usage: { models: {}, tools: {} }, ready: false };
    this.emit();
  }

  agent(id: number) {
    return this.state.agents.find((a) => a.id === id);
  }

  /** Root → … → id, following fork parents. */
  lineage(id: number): AgentSummary[] {
    return lineage(this.state.agents, id);
  }

  foregroundBusy(agentId: number) {
    return this.state.tasks.some((t) => !!t && t?.background !== true && t.conversationId === agentId);
  }

  backgroundTasks(agentId?: number) {
    return this.state.tasks.filter((t) => !!t && t?.background === true && (agentId === undefined || t.conversationId === agentId));
  }
}

export function lineage(agents: readonly AgentSummary[], id: number): AgentSummary[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out: AgentSummary[] = [];
  const seen = new Set<number>();
  let current: number | undefined = id;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const agent = byId.get(current);
    if (!agent) break;
    out.unshift(agent);
    current = agent.parentId;
  }
  return out;
}

// ---------------------------------------------------------------- network tree

export type TreeNode =
  | {
      type: "device";
      key: string;
      device: NetworkDevice;
      status: DeviceStatus;
      stale: boolean;
      children: TreeNode[];
    }
  | {
      type: "session";
      key: string;
      deviceId: string;
      session: SessionSummary;
      stale: boolean;
      children: TreeNode[];
    }
  | {
      type: "agent";
      key: string;
      deviceId: string;
      sessionId: string;
      agent: AgentSummary;
      stale: boolean;
      children: TreeNode[];
    };

export const deviceKey = (deviceId: string) => deviceId;
export const sessionKey = (deviceId: string, sessionId: string) => `${deviceId}/s/${sessionId}`;
export const agentKey = (deviceId: string, sessionId: string, agentId: number) =>
  `${deviceId}/s/${sessionId}/a/${agentId}`;

/** Nest agents under the agent they forked from or the agent whose task owns them. */
export function agentTree(deviceId: string, session: SessionSummary, stale: boolean): TreeNode[] {
  const nodes = new Map<number, Extract<TreeNode, { type: "agent" }>>();
  // R20 cold-3 M3: tree data is hub-relayed and unvalidated — a null element
  // threw here on EVERY sidebar build (always-render). Same guard as safeAgents.
  for (const agent of (Array.isArray(session.agents) ? session.agents : []).filter((a) => !!a && typeof a === "object"))
    nodes.set(agent.id, {
      type: "agent",
      key: agentKey(deviceId, session.id, agent.id),
      deviceId,
      sessionId: session.id,
      agent,
      stale,
      children: [],
    });
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.agent.parentId ?? node.agent.ownerAgentId ?? -1);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function networkTree(devices: readonly NetworkDevice[]): TreeNode[] {
  return devices.map((device) => {
    const stale = device.status !== "online";
    return {
      type: "device",
      key: deviceKey(device.id),
      device,
      status: device.status,
      stale,
      children: (device.tree?.sessions ?? []).map((session) => ({
        type: "session" as const,
        key: sessionKey(device.id, session.id),
        deviceId: device.id,
        session,
        stale,
        children: agentTree(device.id, session, stale),
      })),
    };
  });
}

export class NetworkModel extends Emitter {
  devices: NetworkDevice[] = [];
  apply(frame: Frame): boolean {
    if (frame.type !== "network") return false;
    // R20 cold-3 M3: hub-relayed trees are unvalidated — null agent/session/
    // device elements threw in FE renders (TreeRow reduce, sidebar tree) and
    // in agentTree. Sanitize at the ONE ingestion point.
    this.devices = (Array.isArray(frame.devices) ? frame.devices : [])
      .filter((d) => !!d && typeof d === "object")
      .map((d) => {
        const sessions = Array.isArray(d.tree?.sessions) ? d.tree!.sessions.filter((x) => !!x && typeof x === "object") : [];
        return {
          ...d,
          ...(d.tree ? { tree: { ...d.tree, sessions: sessions.map((x) => ({ ...x, agents: (Array.isArray(x.agents) ? x.agents : []).filter((a) => !!a && typeof a === "object") })) } } : {}),
        };
      });
    this.emit();
    return true;
  }
  device(id: string) {
    return this.devices.find((d) => d.id === id);
  }
  tree() {
    return networkTree(this.devices);
  }
}

/** Display text for a nested call's returned value: its structured output, or nothing when absent. */
function nestedResultText(result: WireNestedToolResult): string {
  const value = result.structuredOutput;
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : safeStringify(value);
  // R20 cold-3 M2: the slice MUST be flattened — an unflattened V8 slice
  // retains its <=16 MiB parent behind a 4 KiB result (the 607 MiB class).
  return text.length > 4000 ? `${AgentModel.flatSlice(text.slice(0, 4000))}…` : text;
}

/** R20 cold-3 M1: stringify that never throws (cyclic structuredOutput). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
