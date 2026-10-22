/** Browser-safe: no Node imports. */

export interface BackoffPolicy {
  readonly initS: number;
  readonly capS: number;
}

/**
 * The reconnect curve every retry loop shares: wait `initS`, double after each failed attempt, stop at
 * `capS`. A loop calls `reset()` when the peer proves it is alive (a valid hello), so the next outage
 * starts from the first step again. Policies live in limits.ts.
 */
export class Backoff {
  private step = 0;

  constructor(private readonly policy: BackoffPolicy) {}

  /** How long to wait before the next attempt. */
  get ms(): number {
    return Math.min(this.policy.initS * 2 ** this.step, this.policy.capS) * 1000;
  }

  /** Call once the wait for a failed attempt has been taken. */
  advance(): void {
    if (this.ms < this.policy.capS * 1000) this.step++;
  }

  reset(): void {
    this.step = 0;
  }
}
