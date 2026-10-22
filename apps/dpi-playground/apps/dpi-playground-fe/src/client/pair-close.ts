export type CancelResult = "cancelled" | "issued" | "failed";

export const CANCEL_TIMEOUT_MS = 4000;

/**
 * Cancel the live code first, but never let a failing or hanging request keep the wizard open:
 * an unconfirmed code simply expires on the hub. Only a code the device already redeemed
 * keeps the wizard open, so the operator sees it and can revoke it explicitly.
 */
export async function closeWizard(opts: {
  needsCancel: boolean;
  cancel: () => Promise<CancelResult>;
  timeoutMs: number;
}): Promise<{ closed: boolean; confirmed: boolean }> {
  if (!opts.needsCancel) return { closed: true, confirmed: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race<CancelResult>([
    opts.cancel().catch((): CancelResult => "failed"),
    new Promise<CancelResult>((done) => (timer = setTimeout(() => done("failed"), opts.timeoutMs))),
  ]);
  clearTimeout(timer);
  return { closed: result !== "issued", confirmed: result === "cancelled" };
}
