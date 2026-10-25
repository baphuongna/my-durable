/**
 * Keep-awake (Wave 3 SHOULD of docs/host-project-checklist.md): while any
 * session on this device is busy, hold the OS awake so runs finish instead of
 * pausing mid-turn. Modelled on orca's `agent-awake-service.ts:53-97`
 * (powerSaveBlocker + per-OS assertions), minus Electron.
 *
 * What each platform actually gets — verified live, not assumed:
 *  - Linux + systemd: `systemd-inhibit --what=idle --mode=block` — an
 *    unprivileged user MAY hold an idle block, but sleep:block answers
 *    "Access denied" (root/polkit). So this keeps idle-suspend away while
 *    agents run; a lid close or an explicit `systemctl suspend` still sleeps,
 *    and that is deliberate — the operator always outranks the agent.
 *  - macOS: `caffeinate -i -s` held until the inhibitor is killed.
 *  - anything else: no-op (`mode: "none"`), reported through deviceInfo.
 *
 * Failure discipline: a spawn that errors or a child that dies does not throw
 * into a turn — after two failed attempts the inhibitor disables itself for
 * the rest of the process, because a keep-awake helper must never become a
 * crash source (the sessions are durable either way).
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/** What this build can do on this machine. */
export type AwakeMode = "inhibit" | "caffeinate" | "none";

export interface AwakeChild {
  kill(): void;
}

export interface AwakeIo {
  platform(): NodeJS.Platform;
  /** Spawn a long-running holder process; `undefined` = the spawn itself failed. */
  spawn(cmd: string, args: readonly string[]): AwakeChild | undefined;
}

export const defaultAwakeIo = (): AwakeIo => ({
  platform: () => process.platform,
  spawn: (cmd, args) => {
    // ESM-safe: a static import, not `require` (caught live: `require` in an
    // ESM module context throws ReferenceError outside any try/catch).
    try {
      const child: ChildProcess = nodeSpawn(cmd, args as string[], {
        stdio: "ignore",
        detached: false,
      });
      child.unref();
      return { kill: () => void child.kill("SIGTERM") };
    } catch {
      return undefined;
    }
  },
});

/** Give up after this many failed spawns — a helper must never spin. */
const MAX_FAILURES = 2;

export class KeepAwake {
  private readonly io: AwakeIo;
  private child?: AwakeChild;
  private failures = 0;
  private disabled = false;
  private lastBusy = -1;

  constructor(io: AwakeIo = defaultAwakeIo()) {
    this.io = io;
  }

  /** The platform mode, computed without spawning anything. */
  get mode(): AwakeMode {
    const platform = this.io.platform();
    if (platform === "linux") return "inhibit";
    if (platform === "darwin") return "caffeinate";
    return "none";
  }

  /** True while an inhibitor process is being held. */
  get held(): boolean {
    return this.child !== undefined;
  }

  /**
   * Idempotent: `sync(n)` with the count of busy sessions. Spawn on 0→n,
   * kill on n→0, nothing in between — the WHY text names the current count
   * only at spawn time, which is fine: it is a hint, not a metric.
   */
  sync(busy: number): void {
    if (this.disabled || this.mode === "none") return;
    const shouldHold = busy > 0;
    if (shouldHold === (this.child !== undefined)) {
      this.lastBusy = busy;
      return;
    }
    if (!shouldHold) {
      this.stop();
      this.lastBusy = busy;
      return;
    }
    const reason = `${busy} session${busy === 1 ? "" : "s"} busy on a dpi device`;
    const child =
      this.mode === "inhibit"
        ? this.io.spawn("systemd-inhibit", [
            "--what=idle",
            "--mode=block",
            "--who",
            "dpi device",
            "--why",
            reason,
            // systemd-inhibit runs a command under the lock; hold it forever.
            "sleep",
            "infinity",
          ])
        : this.io.spawn("caffeinate", ["-i", "-s"]);
    if (!child) {
      this.fail();
      return;
    }
    this.child = child;
    this.lastBusy = busy;
  }

  /** Release the inhibitor if held. Never throws. */
  stop(): void {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      /* already dead */
    }
    this.child = undefined;
  }

  private fail(): void {
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) this.disabled = true;
  }
}
