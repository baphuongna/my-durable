// Run-15 Unit A — u3-4 MED (per-frame DoS): safeTasks filtered malformed task
// rows but kept EVERY survivor — a hostile device pushes a 5000-row tasks
// frame and the TUI walks all of them on every statusbar pass (frames arrive
// continuously). Cap at TASKS_MAX=256 keeping the NEWEST rows, mirroring the
// safeInbox INBOX_MAX_ITEMS=128 sibling cap (models.ts:105).
import test from "node:test";
import assert from "node:assert/strict";
import { SessionModel } from "../src/models.js";

const row = (i: number) => ({
  id: i,
  kind: "pi.generation",
  conversationId: 1,
  background: true,
  state: { status: "done" },
  conversations: [],
});

test("run-15 u3-4: a 5000-row tasks frame keeps only the NEWEST 256 rows", () => {
  const m = new SessionModel();
  const rows: unknown[] = [];
  for (let i = 0; i < 5000; i++) {
    // Malformed rows ride only the OLD prefix — the newest slice must be the
    // 256 newest VALID rows, not the 256 newest raw elements.
    if (i < 200 && i % 2 === 0) rows.push(null);
    else if (i < 200 && i % 3 === 0) rows.push({ id: i, kind: "x", conversationId: 1, background: false });
    else rows.push(row(i));
  }
  m.apply({ type: "tasks", tasks: rows } as never);
  assert.equal(m.state.tasks.length, 256, "TASKS_MAX=256 retained");
  const ids = m.state.tasks.map((t) => t.id);
  assert.equal(ids[0], 4744, "the window starts at the 256th-newest valid row");
  assert.equal(ids[ids.length - 1], 4999, "the newest row survives");
  assert.ok(ids.every((id) => id >= 4744), "no old row leaks into the window");
  // Still usable through the model's own doors.
  assert.equal(m.backgroundTasks(1).length, 256);
});

test("run-15 u3-4: malformed rows keep filtering before the cap", () => {
  const m = new SessionModel();
  m.apply({ type: "tasks", tasks: [null, "x", 7, {}, row(1), row(2)] } as never);
  assert.deepEqual(m.state.tasks.map((t) => t.id), [1, 2], "null/primitives/state-less rows dropped, cap never resuscitates them");
});

test("run-15 u3-4: the session frame rides the same cap", () => {
  const m = new SessionModel();
  const rows = Array.from({ length: 1000 }, (_, i) => row(i));
  m.apply({ type: "session", agents: [], tasks: rows, usage: { models: {}, tools: {} } } as never);
  assert.equal(m.state.tasks.length, 256, "the first session frame is capped too");
  assert.equal(m.state.tasks[255]!.id, 999, "the newest row is the last retained");
});

test("run-15 u3-4: small task lists pass through untouched", () => {
  const m = new SessionModel();
  m.apply({ type: "tasks", tasks: [row(1), row(2), row(3)] } as never);
  assert.equal(m.state.tasks.length, 3, "under the cap nothing is dropped");
});
