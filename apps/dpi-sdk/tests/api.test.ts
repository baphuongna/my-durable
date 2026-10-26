import { test } from "node:test";
import assert from "node:assert/strict";
import { THINKING_LEVELS, type SessionSummary, type ThinkingLevel } from "../src/api.js";

test("THINKING_LEVELS is pi 1.4.0's scale, topping out at max", () => {
  assert.deepEqual([...THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("ThinkingLevel admits max and nothing past it", () => {
  const top: ThinkingLevel = "max";
  assert.ok(THINKING_LEVELS.includes(top));
  // Compile-time guard: "ultra" is off the scale, so this assignment must not typecheck.
  // @ts-expect-error past the top of pi's thinking scale
  const beyond: ThinkingLevel = "ultra";
  assert.equal(THINKING_LEVELS.includes(beyond), false);
});

test("SessionSummary carries the provider alongside the model", () => {
  const summary: SessionSummary = {
    id: "s1",
    name: "Test",
    cwd: "/tmp/project",
    model: "echo",
    provider: "faux",
    createdAt: 1790000000000,
    dbPath: "/tmp/s1/agent.sqlite",
    busy: false,
    agents: [],
  };
  assert.equal(summary.model, "echo");
  assert.equal(summary.provider, "faux");
});
