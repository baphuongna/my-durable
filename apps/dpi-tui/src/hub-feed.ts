/**
 * Multi-host display feed: the hub's /api/network is the same source of truth
 * the web UI renders. The TUI polls it (no local registry sqlite needed — the
 * TUI's dpiHome() default differs from the hub's, which starved the network
 * view to a single adhoc row) and maps NetworkDevice rows into the DeviceRow
 * shape the network view already renders: devices with live status dots and
 * their session trees, exactly like the web sidebar.
 *
 * Attaching still needs a reachable endpoint: LAN rows carry url+token and
 * switch directly; tunnel rows have url null and honestly say so (full tunnel
 * attach rides the hub's /api/stream mux — a later step, same as the web).
 */
import type { DeviceRow } from "../../dpi-sdk/src/node/registry.ts";

/** The subset of the hub's NetworkDevice DTO the feed maps into DeviceRow. */
export interface HubNetworkDevice {
  id: string;
  name: string;
  kind: string;
  transport: string;
  url: string | null;
  source: string;
  deviceUid?: string | null;
  status?: string;
  error?: string | null;
  lastSeenAt?: number;
  info?: unknown;
  tree?: { sessions?: { id: string; name: string }[] } | null;
}

export function toDeviceRows(devices: HubNetworkDevice[]): DeviceRow[] {
  return devices.map(
    (d): DeviceRow => ({
      id: d.id,
      name: d.name,
      kind: "url",
      transport: d.transport === "tunnel" ? "tunnel" : "lan",
      url: d.url ?? null,
      token: null,
      source: d.source === "config" ? "config" : "ui",
      position: 0,
      deviceUid: d.deviceUid ?? null,
      lastStatus: (d.status ?? "offline") as DeviceRow["lastStatus"],
      lastError: d.error ?? null,
      lastSeenAt: d.lastSeenAt ?? null,
      lastInfo: (d.info ?? null) as DeviceRow["lastInfo"],
      lastTree: (d.tree ?? null) as DeviceRow["lastTree"],
      createdAt: 0,
      updatedAt: 0,
    }),
  );
}

/** Fetch the hub network once; returns null on any failure (caller keeps the last good rows). */
export async function fetchHubNetwork(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<DeviceRow[] | null> {
  try {
    const res = await fetch(new URL("api/network", url), {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { devices?: HubNetworkDevice[] };
    return toDeviceRows(body.devices ?? []);
  } catch {
    return null;
  }
}
