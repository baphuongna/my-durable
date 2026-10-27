// Session-bundle export with a retryable failure surface. A failure used to
// surface only as a ≤120-char toast that vanished before the user could act;
// it now also stays inline in the Session heading (Git tab's error-banner
// pattern) until a successful retry — or a session switch — clears it.
import { ref, watch, type Ref } from "vue";
import type { NetworkDevice, SessionSummary } from "@sdk/api";
import { deviceClient, message } from "./hub";

export interface BundleFile {
  filename: string;
  mime: string;
  bytes: number;
  base64: string;
}
export type BundleTarget = Ref<{
  device?: Pick<NetworkDevice, "id">;
  summary?: Pick<SessionSummary, "id">;
}>;

/** Browser-only: turn a bundle into a download. Separate so tests can drive
 *  the retry logic without the DOM. */
export function downloadBundle(r: BundleFile) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))], {
      type: r.mime || "application/zip",
    }),
  );
  a.download = r.filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function useExportBundle(
  target: BundleTarget,
  opts: {
    fetchBundle?: (deviceId: string, sessionId: string) => Promise<BundleFile>;
    download?: (r: BundleFile) => void;
    notify?: (text: string) => void;
  } = {},
) {
  const fetchBundle = opts.fetchBundle ?? ((d, s) => deviceClient(d).exportSession(s));
  const download = opts.download ?? downloadBundle;
  const notify = opts.notify ?? (() => {});
  const exporting = ref(false);
  /** The last failure: shown inline with a retry until one succeeds. */
  const error = ref("");
  async function run() {
    const { device, summary } = target.value;
    if (!device || !summary || exporting.value) return;
    exporting.value = true;
    error.value = "";
    try {
      const r = await fetchBundle(device.id, summary.id);
      download(r);
      notify(`Bundle downloaded (${Math.max(1, Math.round(r.bytes / 1024))} KiB).`);
    } catch (e) {
      error.value = `bundle export failed: ${message(e).slice(0, 300)}`;
      notify(error.value.slice(0, 120));
    } finally {
      exporting.value = false;
    }
  }
  // The failure belongs to one session; selecting another clears it.
  watch(
    () => target.value.summary?.id,
    () => (error.value = ""),
  );
  return { exporting, error, run };
}
