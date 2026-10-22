/**
 * Hub admin authentication (the operator's own credential — devices use pairing
 * credentials and never see any of this).
 *
 * Token bootstrap (mirrors the device-side DPI_TOKEN bootstrap):
 * - `DPI_ADMIN_TOKEN` env wins outright; anything shorter than 32 characters is a
 *   configuration mistake and REFUSES to boot — it is never silently replaced.
 * - Otherwise the token is minted at first boot (`adm_` + 32 random bytes,
 *   base64url) into `<DPI_HOME>/admin.token` (or `DPI_ADMIN_TOKEN_FILE`),
 *   owner-only 0600, and its value is logged exactly once — at mint time only;
 *   every later boot logs just the file path.
 *
 * Presentation:
 * - Browsers: `POST /api/session {token}` sets a stateless cookie `dpi_admin` =
 *   base64url(payload) + "." + base64url(HMAC-SHA256(payload, adminToken)) with
 *   payload `{"exp":<ms>}`. HttpOnly, SameSite=Strict, Path=/, 4 h, `Secure` when
 *   the request arrived via the TLS proxy. Forging it requires the token itself;
 *   it survives a hub restart because it carries no server-side state.
 * - Non-browser clients (TUI, tests, curl): the raw token as
 *   `Authorization: Bearer <adm_…>` or `X-Admin-Token`.
 *
 * Every comparison hashes both sides with SHA-256 first and uses timingSafeEqual
 * (the device-side bearerAuth pattern), so the cookie HMAC and the raw token are
 * both compared in constant time.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RequestHandler } from "express";
import { homedir } from "node:os";

export const ADMIN_COOKIE = "dpi_admin";
/** How long a login cookie is worth. */
export const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
/** A set-but-short env token is a configuration mistake, never replaced silently. */
export const MIN_TOKEN_CHARS = 32;
/** Login attempts per client address: 5 per minute, burst 5. */
export const LOGIN_RATE = { capacity: 5, perMinute: 5 } as const;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time string equality (hash first so lengths cannot leak). */
export function tokenEquals(presented: string, expected: string): boolean {
  const a = sha256(presented);
  const b = sha256(expected);
  return timingSafeEqual(a, b);
}

export interface AdminTokenInfo {
  token: string;
  /** Where the token file lives (even when the env override is in force). */
  path: string;
  /** True when this boot minted the token file. */
  created: boolean;
}

/**
 * Resolve the admin token at boot: env override (>= 32 chars or throw), the
 * existing token file, or a freshly minted one written 0600.
 */
export function bootstrapAdminToken(
  home = process.env.DPI_HOME ?? join(homedir(), ".dpi"),
): AdminTokenInfo {
  const path = process.env.DPI_ADMIN_TOKEN_FILE ?? join(home, "admin.token");
  const env = process.env.DPI_ADMIN_TOKEN;
  if (env !== undefined && env !== "") {
    if (env.length < MIN_TOKEN_CHARS)
      throw Error(
        `DPI_ADMIN_TOKEN is ${env.length} characters; an admin token must be at least ${MIN_TOKEN_CHARS}. ` +
          "A short token is a configuration mistake — fix it or unset the variable; the hub will not replace it.",
      );
    return { token: env, path, created: false };
  }
  let existing = "";
  try {
    existing = readFileSync(path, "utf8").trim();
  } catch {
    /* first run (or an unreadable file): mint below */
  }
  if (existing) {
    // The token file must stay 0600 — tighten quietly if a copy restored looser bits
    // (the same quiet re-tightening Audit applies to the registry file).
    try {
      if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
    return { token: existing, path, created: false };
  }
  const token = `adm_${randomBytes(32).toString("base64url")}`;
  // DPI_ADMIN_TOKEN_FILE may name a directory that does not exist yet — create it
  // owner-only rather than refusing the operator's explicit choice of location.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // a pre-existing (e.g. empty) file may carry wider bits
  // Gap #5: first-login friction — the value appears exactly once, here at
  // mint time (this line only ever runs on a first boot), so the operator can
  // log into the web UI without reading a file off the hub machine. Restarts
  // print only the file path (see the banner in main.ts).
  console.log(`first run: created admin token: ${token}`);
  return { token, path, created: true };
}

/** The cookie value for a session expiring at `exp` (epoch ms). */
export function signSession(adminToken: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp }), "utf8").toString("base64url");
  const mac = createHmac("sha256", adminToken).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

/** True when `cookie` is a well-formed, correctly signed, unexpired session. */
export function verifySession(
  adminToken: string,
  cookie: string | undefined,
  now = Date.now(),
): boolean {
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot <= 0) return false;
  const payload = cookie.slice(0, dot);
  const given = cookie.slice(dot + 1);
  const expected = createHmac("sha256", adminToken).update(payload).digest("base64url");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof parsed.exp === "number" && Number.isFinite(parsed.exp) && parsed.exp > now;
  } catch {
    return false;
  }
}

/** The `dpi_admin` value from a raw Cookie header, or undefined. */
export function adminCookie(header: string | string[] | undefined): string | undefined {
  const cookies = Array.isArray(header) ? header.join("; ") : header;
  if (!cookies) return undefined;
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === ADMIN_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The presented raw token: `Authorization: Bearer <t>` or `X-Admin-Token: <t>`. */
export function bearerToken(req: { headers: Record<string, unknown> }): string {
  const auth = req.headers.authorization;
  const header = typeof auth === "string" ? auth : "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  const alt = req.headers["x-admin-token"];
  return typeof alt === "string" ? alt.trim() : "";
}

/**
 * Require the admin credential (cookie or bearer) on a route. Answers
 * `{error:{code:"unauthorized"}}` with 401 otherwise.
 */
export function requireAdmin(adminToken: string): RequestHandler {
  return (req, res, next) => {
    const bearer = bearerToken(req);
    if (
      (bearer && tokenEquals(bearer, adminToken)) ||
      verifySession(adminToken, adminCookie(req.headers.cookie))
    )
      return void next();
    res
      .status(401)
      .json({ error: { code: "unauthorized", message: "Admin authentication required" } });
  };
}
