/**
 * Transcript text is written by a device (or by an agent a device can prompt-inject)
 * and is rendered inside the hub's own origin. A link in it must therefore never lead
 * back into the hub: one click is a top-level navigation to a hub path under the
 * operator's credentials. Only absolute http(s) links to OTHER origins survive.
 */
export function externalHref(href: string, hubOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim()); // no base: relative and protocol-relative forms throw and are dropped
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin === hubOrigin ? null : url.href;
}
