/**
 * Plain-JS admin login for the .mjs suites (usable without tsx): exchange the
 * hub's admin token for the `dpi_admin` cookie and hand it to Node fetches and
 * Playwright contexts. The token comes from DPI_ADMIN_TOKEN or the hub's
 * admin.token file (DPI_HOME / DPI_ADMIN_TOKEN_FILE).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function readAdminToken() {
  if (process.env.DPI_ADMIN_TOKEN) return process.env.DPI_ADMIN_TOKEN;
  const file =
    process.env.DPI_ADMIN_TOKEN_FILE ??
    join(process.env.DPI_HOME ?? join(homedir(), ".dpi"), "admin.token");
  return (await readFile(file, "utf8")).trim();
}

/**
 * Log in against `base` once. Returns:
 *   header           "dpi_admin=<value>" — the Cookie header for Node fetches
 *   bearer           { authorization: "Bearer <token>" } — for curl-style calls
 *   playwrightCookie a cookie object ready for browserContext.addCookies
 */
export async function hubSession(base) {
  const token = await readAdminToken();
  const r = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (r.status !== 200)
    throw new Error(`admin login failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const setCookie = r.headers.getSetCookie?.()[0] ?? r.headers.get("set-cookie") ?? "";
  const value = /dpi_admin=([^;]+)/.exec(setCookie)?.[1];
  if (!value) throw new Error("admin login set no dpi_admin cookie");
  return {
    token,
    header: `dpi_admin=${value}`,
    bearer: { authorization: `Bearer ${token}` },
    playwrightCookie: { name: "dpi_admin", value, url: base, httpOnly: true, sameSite: "Strict" },
  };
}
