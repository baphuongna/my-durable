/**
 * The "older build" wall, done right. Live-caught: the old message said
 * "This device runs an older build" without naming WHICH device, and hinted
 * `dpi update` — wrong for a pre-rename install (durable 1.x) whose updater
 * does not know the my-durable package. The hint must be actionable on the
 * machine that is actually stale.
 */
import { network } from "./store";
import { message } from "./hub";

/** True when the tunnel refused the route (old build) — the stale-device wall. */
export function isStaleDeviceError(e: unknown): boolean {
  const text = message(e);
  return (e as { code?: string }).code === "not_found" || /allowlist|not found/i.test(text);
}

/**
 * The message to show instead of a raw tunnel error. Names the device, and
 * when the device predates the rename (durableVersion, no packageVersion)
 * gives the migration command rather than `dpi update`.
 */
export function staleDeviceHint(deviceId: string | undefined, purpose: string): string {
  const dev = network.devices.value.find((d) => d.id === deviceId) as
    | { name?: string; info?: { packageVersion?: string; durableVersion?: string } }
    | undefined;
  const name = dev?.name || "This device";
  const info = dev?.info;
  if (info && !info.packageVersion && info.durableVersion) {
    return `${name} runs the pre-rename build (durable ${info.durableVersion}) — ${purpose} needs the new one. On that machine: npm i -g my-durable@latest, then dpi device stop && dpi device start.`;
  }
  return `${name} runs an older build — ${purpose}. Update it on that machine (\`dpi update\`).`;
}
