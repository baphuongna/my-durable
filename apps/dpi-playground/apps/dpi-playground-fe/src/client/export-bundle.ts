// Session-bundle export with a retryable failure surface. A failure used to
// surface only as a ≤120-char toast that vanished before the user could act;
// it now also stays inline in the Session heading (Git tab's error-banner
// pattern) until a successful retry — or a session switch — clears it.
// R8: the device streams raw zip bytes (the SDK's SessionExport — bytes, no
// base64 hop), so the Blob is built straight from the payload.
import { ref, watch, type Ref } from "vue";
import type { NetworkDevice, SessionSummary } from "@sdk/api";
import type { SessionExport } from "@sdk/client";
import { deviceClient, message } from "./hub";

/** The device's zipped session bundle: raw zip bytes plus the download name. */
export type BundleFile = SessionExport;
export type BundleTarget = Ref<{
  device?: Pick<NetworkDevice, "id">;
  summary?: Pick<SessionSummary, "id">;
}>;

/** Browser-only: turn a bundle into a download. Separate so tests can drive
 *  the retry logic without the DOM. The Blob wraps the zip bytes directly —
 *  no base64 decode since the R8 binary contract. */
export function downloadBundle(r: BundleFile) {
  const a = document.createElement("a");
  // slice() normalizes the buffer to a plain ArrayBuffer (BlobPart typing, TS 5.7).
  // R16 (run-2 h13): the device is untrusted at the operator origin — the FE
  // authors the label itself (mirrors hub delta-6): zip MIME is a literal and
  // the filename is charset-folded, extension-stripped is unnecessary (the
  // honest device contract is *.bundle.zip) but the cap keeps it sane.
  let stem = (r.filename || "device-response").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "device-response";
  if (/\.zip$/i.test(r.filename) && !/\.zip$/i.test(stem)) stem = `${stem.slice(0, 76)}.zip`;
  a.href = URL.createObjectURL(new Blob([r.bytes.slice()], { type: "application/zip" }));
  a.download = stem;
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
      notify(`Bundle downloaded (${Math.max(1, Math.round(r.bytes.length / 1024))} KiB).`);
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
