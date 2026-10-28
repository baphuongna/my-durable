/**
 * R15 (run-1 NV v3-13, app-side): a wire `toolcall_delta.path` containing
 * `__proto__` / `constructor` / `prototype` must NEVER be walked or written —
 * the setPath walk's `node[key]` read returns Object.prototype for `__proto__`
 * and descends onto it, so the final append write pollutes Object.prototype
 * process-wide (crash gadget in the TUI/FE render loops). The delta is now
 * dropped whole; benign nested paths still apply.
 * Level: unit, in-memory (hermetic).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentModel, applyMessageChange } from "../src/models.js";
import type { Frame, WireAssistantMessage, WireMessageChange } from "../src/api.js";

function updateFrame(changes: WireMessageChange[]): Frame {
  return { type: "message_update", changes, usage: {} } as never;
}

const base: WireAssistantMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "tc1", name: "write", arguments: {} }],
  provider: "p",
  model: "m",
  usage: {},
  stopReason: "pending",
} as never;

test("a __proto__ path element is dropped without polluting Object.prototype", () => {
  const m = new AgentModel();
  const change = { type: "toolcall_delta", contentIndex: 0, path: ["__proto__", "polluted"], delta: "PWN" } as never as WireMessageChange;
  m.apply(updateFrame([change]));
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false, "Object.prototype was polluted");
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "empty object inherited the key");
});

test("constructor.prototype paths are dropped too", () => {
  const m = new AgentModel();
  m.apply(updateFrame([{ type: "toolcall_delta", contentIndex: 0, path: ["constructor", "prototype", "x"], delta: "PWN" } as never as WireMessageChange]));
  assert.equal(Object.hasOwn(Object.prototype, "x"), false);
  m.apply(updateFrame([{ type: "toolcall_delta", contentIndex: 0, path: ["arguments", "constructor"], delta: "PWN" } as never as WireMessageChange]));
  assert.equal(Object.hasOwn(Object.prototype, "arguments"), false);
});

test("a hostile delta is dropped whole but later benign deltas still apply", () => {
  const m = new AgentModel();
  m.apply(updateFrame([{ type: "toolcall_delta", contentIndex: 0, path: ["__proto__", "polluted"], delta: "PWN" } as never as WireMessageChange]));
  m.apply(updateFrame([{ type: "toolcall_delta", contentIndex: 0, path: ["arguments", "command"], delta: "echo hi" } as never as WireMessageChange]));
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("applyMessageChange: hostile path is a no-op, benign nested path applies", () => {
  const hostile = applyMessageChange(base, { type: "toolcall_delta", contentIndex: 0, path: ["__proto__", "polluted"], delta: "PWN" } as never);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  assert.deepEqual((hostile.content[0] as { arguments: object }).arguments, {}, "hostile delta must not partially apply");

  const good = applyMessageChange(base, { type: "toolcall_delta", contentIndex: 0, path: ["arguments", "files", 0, "name"], delta: "a.txt" } as never);
  const args = (good.content[0] as { arguments: { files: Array<{ name: string }> } }).arguments;
  assert.equal(args.files[0].name, "a.txt", "benign nested delta still applies");
  assert.equal(Object.hasOwn(Object.prototype, "name"), false, "guard must not over-reach");
});
