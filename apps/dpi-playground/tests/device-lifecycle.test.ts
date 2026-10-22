/**
 * R-2 and T-2 with a real dpi-backend daemon: the device process really dies (SIGKILL) or its tunnel really drops,
 * and the hub, the dispatcher, the monitor and a browser tab (an SSE connection to the mux) react to the real
 * thing. Every clock here is the real one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { faux } from "../../dpi-backend/tests/helpers.js";
import { deviceRig, until, type MuxTab, type TabFrame } from "./harness/device-rig.js";

const subscribeIds = (controls: { action: string; subscriptionId: string }[]) =>
  controls.filter((c) => c.action === "subscribe").map((c) => c.subscriptionId);

/** Frames for one subscription key, in arrival order, after `from`. */
const framesOf = (tab: MuxTab, key: string, from = 0): TabFrame[] => tab.frames.slice(from).filter((f) => f.sub === key);
const typesOf = (frames: TabFrame[]) => frames.map((f) => f.frame.type as string);

test("R-2: SIGKILL of the device with its tunnel live — pairing and keys survive, nobody pairs again, the job resumes, the tab keeps its stream and gets fresh state", { timeout: 150_000 }, async () => {
  const CHECKS = 4;
  const rig = await deviceRig();
  try {
    await rig.waitOnline();
    const client = new DpiClient(rig.backend.base, rig.deviceToken);
    const session = await client.createSession({ name: "R-2", cwd: rig.startDirs, model: faux });
    const main = client.agent(session.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "change-watch", input: { checks: CHECKS, interval_seconds: 2 } });

    const tab = await rig.openTab();
    const deviceKey = `${rig.deviceId}/device`;
    const agentKey = `${rig.deviceId}/agent/${session.id}/main?docs=demo.job-runs`;
    await tab.subscribe([deviceKey, agentKey]);
    const runOf = (f: TabFrame) => (f.frame.value as JobRunsDoc).items[taskId];
    const jobDocs = (from = 0) => framesOf(tab, agentKey, from).filter((f) => f.frame.type === "doc" && f.frame.kind === "demo.job-runs");
    const checkpointsIn = (f: TabFrame) => runOf(f)?.phases[1].progress?.done ?? 0;
    await tab.until(() => jobDocs().some((f) => checkpointsIn(f) >= 1), 30_000, "the tab to see the first durable checkpoint");
    await tab.until(() => framesOf(tab, deviceKey).some((f) => f.frame.type === "tree"), 10_000, "the device tree in the tab");

    const committed = Math.max(...jobDocs().map(checkpointsIn));
    assert.ok(committed >= 1 && committed < CHECKS, `progress is visible but the job is not finished before the crash (${committed}/${CHECKS} checkpoints committed)`);
    const pairedBefore = await rig.persisted();
    const localBefore = await rig.localPairing();
    assert.equal(localBefore.state, "paired");
    const subscriptionsBefore = new Set(subscribeIds(rig.controls));
    assert.ok(subscriptionsBefore.size >= 3, "the monitor, the device key and the agent key each hold a subscription");
    const streamHellos = () => tab.frames.filter((f) => f.sub === "hello").length;
    assert.equal(streamHellos(), 1);

    // The kill must land mid-job, or "the job resumes" and "none repeated" below are
    // vacuous: re-checked as late as possible — immediately before the SIGKILL—
    // at least one checkpoint is committed and fewer than all CHECKS.
    const committedAtKill = Math.max(...jobDocs().map(checkpointsIn));
    assert.ok(committedAtKill >= 1 && committedAtKill < CHECKS, `the kill landed mid-job (${committedAtKill}/${CHECKS} checkpoints committed)`);

    // The crash. The hub's tab stream is hub-owned: it must survive and say what happened.
    const killedAt = tab.frames.length;
    await rig.backend.stop("SIGKILL");
    await tab.until(
      () => framesOf(tab, agentKey, killedAt).some((f) => f.frame.type === "disconnected") && framesOf(tab, deviceKey, killedAt).some((f) => f.frame.type === "disconnected"),
      20_000,
      "the tab to be told both streams were cut",
    );
    assert.equal(rig.tunnel.hasConnection(rig.deviceId), false);
    assert.equal(tab.open, true, "the tab's SSE connection to the hub stays up");
    assert.equal(rig.monitor.state(rig.deviceId)?.status === "online", false, "a dead device is not shown as online");
    const cutAt = tab.frames.length;

    // Restart with nothing but the files the dead process left behind.
    await rig.backend.start();
    await rig.waitOnline();
    await tab.until(
      () => jobDocs(cutAt).length > 0 && framesOf(tab, deviceKey, cutAt).some((f) => f.frame.type === "tree") && framesOf(tab, agentKey, cutAt).some((f) => f.frame.type === "snapshot"),
      60_000,
      "fresh device and agent state on the same stream",
    );

    // Same tab, same stream; snapshot before any delta; a new subscription for every reader.
    assert.equal(streamHellos(), 1, "the browser never had to open a new stream");
    for (const key of [deviceKey, agentKey]) {
      const fresh = typesOf(framesOf(tab, key, cutAt));
      assert.equal(fresh[0], "hello", `${key}: the fresh reader starts with hello`);
    }
    const agentFresh = typesOf(framesOf(tab, agentKey, cutAt));
    assert.ok(agentFresh.indexOf("snapshot") > 0 && !agentFresh.slice(0, agentFresh.indexOf("snapshot")).includes("batch"), "snapshot comes before any delta");
    const subscriptionsAfter = subscribeIds(rig.controls).filter((id) => !subscriptionsBefore.has(id));
    assert.ok(subscriptionsAfter.length >= 3, `every reader re-subscribed under a new id (${subscriptionsAfter.length} new)`);

    // The agent resumed from its committed checkpoint and finished the job exactly once per check.
    assert.ok(checkpointsIn(jobDocs(cutAt)[0]) >= committed, "fresh state never shows less progress than was committed before the kill");
    await tab.until(() => jobDocs(cutAt).some((f) => runOf(f)?.status === "completed"), 60_000, "the job to complete in the tab after the restart");
    const done = runOf(jobDocs(cutAt).findLast((f) => runOf(f)?.status === "completed")!);
    assert.deepEqual(
      done.phases[1].steps.filter((step) => step.kind === "checkpoint" && step.status === "done").map((step) => step.label),
      Array.from({ length: CHECKS }, (_, i) => `Check ${i + 1}/${CHECKS}`),
      "one checkpoint per check: none repeated by the crash, none skipped",
    );

    // Nobody paired again: same files byte for byte, same hub rows, no pairing events, same identity on the device.
    const pairedAfter = await rig.persisted();
    assert.equal(pairedAfter.pairingJson, pairedBefore.pairingJson, "pairing.json is the file the dead process left");
    assert.equal(pairedAfter.keypairJson, pairedBefore.keypairJson, "the device key is the one it had");
    const identity = (rows: { pairings: unknown[]; credentials: unknown[] }) => ({
      pairings: (rows.pairings as Record<string, unknown>[]).map((r) => [r.pairing_epoch, r.key_fingerprint, r.status, r.credential_generation]),
      credentials: (rows.credentials as Record<string, unknown>[]).map((r) => [r.credential_id, r.generation, r.token_hash, r.status]),
    });
    assert.deepEqual(identity(pairedAfter), identity(pairedBefore), "the hub still holds the same pairing and credential");
    assert.equal(pairedAfter.pairEvents, pairedBefore.pairEvents, "no pairing activity happened on the hub");
    const localAfter = await rig.localPairing();
    for (const field of ["state", "deviceId", "pairingEpoch", "generation", "fingerprint", "hubOrigin"]) assert.equal(localAfter[field], localBefore[field], `device pairing ${field}`);
  } finally {
    await rig.cleanup();
  }
});

test("T-2: a tunnel-only disconnect keeps the hub and the browser stream; rejected reconnects back off 1, 2, 4 s on the real clock, then hello brings fresh state under new subscription ids", { timeout: 120_000 }, async () => {
  const rig = await deviceRig();
  try {
    await rig.waitOnline();
    const tab = await rig.openTab();
    const deviceKey = `${rig.deviceId}/device`;
    await tab.subscribe([deviceKey]);
    await tab.until(() => framesOf(tab, deviceKey).some((f) => f.frame.type === "tree"), 15_000, "the device tree in the tab");
    const subscriptionsBefore = new Set(subscribeIds(rig.controls));
    assert.ok(subscriptionsBefore.size >= 2, "the monitor and the tab each hold a subscription");
    const seen = tab.frames.length;
    const connectorBefore = await rig.localTunnel();
    assert.equal(connectorBefore.hellos, 1);

    // Cut only the tunnel. The device process, the hub and the tab's stream all stay up.
    rig.rejectUpgrades(3);
    const droppedAt = rig.dropTunnel();
    await tab.until(() => framesOf(tab, deviceKey, seen).some((f) => f.frame.type === "disconnected"), 15_000, "the tab to be told the stream was cut");
    assert.equal(tab.open, true);
    const cutAt = tab.frames.length;

    // Three attempts are refused, the fourth is let through. Gaps are measured on the hub's monotonic clock.
    await until(() => rig.upgrades.filter((u) => u.at > droppedAt).length >= 4, 45_000, "four reconnect attempts");
    const attempts = rig.upgrades.filter((u) => u.at > droppedAt);
    assert.deepEqual(attempts.map((a) => a.rejected), [true, true, true, false], "three refusals, then the hello attempt");
    const gaps = attempts.map((a, i) => Math.round(a.at - (i === 0 ? droppedAt : attempts[i - 1].at)));
    const expected = [1000, 2000, 4000, 8000];
    // Lower bound stays tight (deterministic Backoff, no jitter): a gap can only
    // shrink by loopback transit skew. The upper bound carries +2000 ms of real-clock
    // slack for a loaded machine. The doubling check is the load-robust discriminator
    // against a flat or jittered curve: sustained load inflates every gap together,
    // it does not halve the ratio between consecutive ones.
    gaps.forEach((gap, i) => assert.ok(gap >= expected[i] - 50 && gap <= expected[i] + 2000, `reconnect gap ${i + 1} should be about ${expected[i]} ms, was ${gap} ms (all: ${gaps.join(", ")})`));
    for (let i = 0; i + 1 < gaps.length; i++)
      assert.ok(gaps[i + 1] >= 2 * gaps[i] - 500, `reconnect gap ${i + 2} (${gaps[i + 1]} ms) must be at least double gap ${i + 1} (${gaps[i]} ms) minus measurement skew: the curve is 1, 2, 4, 8 s, not flat or jittered (all: ${gaps.join(", ")})`);
    await rig.waitOnline();

    // Fresh state on the same stream, new subscription ids, and the daemon never restarted.
    await tab.until(() => framesOf(tab, deviceKey, cutAt).some((f) => f.frame.type === "tree"), 30_000, "fresh device state after the hello");
    const fresh = typesOf(framesOf(tab, deviceKey, cutAt));
    assert.equal(fresh[0], "hello");
    assert.ok(fresh.indexOf("tree") > 0);
    assert.equal(tab.frames.filter((f) => f.sub === "hello").length, 1, "the browser kept its stream id");
    const issued = subscribeIds(rig.controls);
    assert.equal(new Set(issued).size, issued.length, "no subscription id is ever reused");
    const subscriptionsAfter = issued.filter((id) => !subscriptionsBefore.has(id));
    assert.ok(subscriptionsAfter.length >= 2, `monitor and tab re-subscribed under new ids (${subscriptionsAfter.length} new)`);
    // Connector counters live in the daemon's memory: a restarted daemon would start again from one hello and one attempt.
    const connectorAfter = await rig.localTunnel();
    assert.equal(connectorAfter.hellos, 2, "the same daemon said hello twice");
    assert.equal(Number(connectorAfter.attempts) - Number(connectorBefore.attempts), 4, "and made exactly four attempts since the drop");
    const statuses = tab.frames.filter((f) => f.sub === "network").map((f) => f.frame.devices.find((d: { id: string }) => d.id === rig.deviceId)?.status);
    assert.ok(statuses.includes("offline") && statuses.at(-1) === "online", `the network view followed the disconnect (${[...new Set(statuses)].join(" → ")})`);
  } finally {
    await rig.cleanup();
  }
});
