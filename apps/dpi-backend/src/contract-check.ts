// Compile-time proof that pi-durable's agent events still fit the SDK's wire contract, and that the wire
// contract still carries every field and tag each library variant provides.
//
// The positive checks run inside `npm run check` (this file is in tsconfig `include`). The compile-negative
// runner (`npm run check:contract` → scripts/check-contract.mjs) proves they actually fail when a field, a
// tag or a nested subshape is removed from a temporary copy of the wire types.
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type {
  WireAgentEvent,
  WireCompactionFailure,
  WireNestedToolResult,
  WireNestedToolSlot,
  WireSnapshotEvent,
} from "../../dpi-sdk/src/api.js";

/** Forward fit: the library's shape must stay assignable to ours. */
export const agentEventFits = (e: AgentEvent): WireAgentEvent => e;
export const snapshotFits = (e: SnapshotEvent): WireSnapshotEvent => e;

// ---------------------------------------------------------------- completeness helpers

type LibTags = AgentEvent["type"];

/** Members of a union whose `type` includes `Tag` — grouped tags like `run_start | run_end` included. */
type MemberWithTag<U, Tag extends PropertyKey> = U extends { type: infer T }
  ? Tag extends T
    ? U
    : never
  : never;

type LibVariant<Tag extends PropertyKey> = MemberWithTag<AgentEvent, Tag>;
type WireVariant<Tag extends PropertyKey> = MemberWithTag<WireAgentEvent, Tag>;

/** `true` only when the wire variant exists and declares at least every field the library variant has. */
type WireCovers<Tag extends LibTags> = [WireVariant<Tag>] extends [never]
  ? { wireTagMissing: Tag }
  : Exclude<keyof LibVariant<Tag>, keyof WireVariant<Tag>> extends never
    ? true
    : { wireFieldsMissing: Exclude<keyof LibVariant<Tag>, keyof WireVariant<Tag>> };

/** `true` when every key of `Keys` is a key of `Shape` (`Keys` must be a subset of `keyof Shape`). */
// The tuple wrapper stops the conditional from distributing over the union, which would mask a missing key.
type HasKeys<Shape, Keys extends PropertyKey> = [Keys] extends [Extract<Keys, keyof Shape>]
  ? true
  : { missingKeys: Exclude<Keys, keyof Shape> };

type MustBeRequired<T> = undefined extends T ? { mustBeRequired: true } : true;
type MustBeOptional<T> = undefined extends T ? true : { mustBeOptional: true };

// ---------------------------------------------------------------- every event tag and field

/**
 * One entry per library tag. A new tag in pi-durable breaks this object until the wire type covers it;
 * a removed or renamed wire variant (or a field dropped from one) breaks the corresponding entry.
 */
export const eventFieldCoverage: { [K in LibTags]: WireCovers<K> } = {
  snapshot: true,
  run_start: true,
  run_end: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  inbox_update: true,
  submission: true,
  auto_retry_start: true,
  auto_retry_end: true,
  deferred_poll: true,
  entry_appended: true,
  agent_changed: true,
  usage_changed: true,
  task_failed: true,
  compaction_start: true,
  compaction_end: true,
};

/** The snapshot keeps every field of the library's snapshot, including `nestedTools` and `compactionFailure`. */
export const snapshotFieldCoverage: Exclude<keyof SnapshotEvent, keyof WireSnapshotEvent> extends never
  ? true
  : { snapshotFieldsMissing: Exclude<keyof SnapshotEvent, keyof WireSnapshotEvent> } = true;

// ---------------------------------------------------------------- required/optional shape

/** `nestedTools` is a required array, so a serializer that drops it cannot compile. */
export const nestedToolsRequired: MustBeRequired<WireSnapshotEvent["nestedTools"]> = true;
export const nestedToolsArray: WireSnapshotEvent["nestedTools"] extends readonly WireNestedToolSlot[] ? true : { notArray: true } = true;

/** `compactionFailure` and the tool-end `entry`/`result`/`error` fields stay optional. */
export const compactionFailureOptional: MustBeOptional<WireSnapshotEvent["compactionFailure"]> = true;
export const toolEndEntryOptional: MustBeOptional<WireVariant<"tool_execution_end">["entry"]> = true;
export const toolEndResultOptional: MustBeOptional<WireVariant<"tool_execution_end">["result"]> = true;
export const compactionEndErrorOptional: MustBeOptional<WireVariant<"compaction_end">["error"]> = true;

/** The neither-entry-nor-result case stays representable (faulted, orphaned, or an unfinished slot). */
export const toolEndWithoutResult: WireVariant<"tool_execution_end"> = {
  type: "tool_execution_end",
  toolCallId: "call",
  toolName: "tool",
};

/** Tool events carry the call's task and, for a nested call, its parent call and task. */
export const toolStartMeta: HasKeys<WireVariant<"tool_execution_start">, "taskId" | "parentToolCallId" | "parentTaskId"> = true;
export const toolUpdateMeta: HasKeys<WireVariant<"tool_execution_update">, "taskId" | "parentToolCallId" | "parentTaskId"> = true;
export const toolEndMeta: HasKeys<WireVariant<"tool_execution_end">, "taskId" | "parentToolCallId" | "parentTaskId"> = true;

// ---------------------------------------------------------------- nested subshapes

type LibNestedSlot = SnapshotEvent["nestedTools"][number];
type LibNestedResult = NonNullable<MemberWithTag<AgentEvent, "tool_execution_end">["result"]>;
type LibCompactionFailure = NonNullable<SnapshotEvent["compactionFailure"]>;

export const nestedSlotShape: HasKeys<WireNestedToolSlot, "callId" | "name" | "status" | "parentCallId" | "parentTaskId" | "taskId" | "arguments" | keyof LibNestedSlot> = true;
export const nestedResultShape: HasKeys<WireNestedToolResult, "taskId" | "isError" | "diagnostics" | keyof LibNestedResult> = true;
export const compactionFailureShape: HasKeys<WireCompactionFailure, "taskId" | "reason" | "error" | keyof LibCompactionFailure> = true;
