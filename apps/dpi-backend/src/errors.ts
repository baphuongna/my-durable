import type { ErrorRequestHandler } from "express";
import { ConversationBusy, SessionFailed, StorageRequestError } from "@earendil-works/pi-durable";
import type { ErrorCode } from "../../dpi-sdk/src/api.js";
import { ScheduleRegistryError } from "./schedules.js";
import { GraphError } from "./graphs.js";
import { NotifySinkError } from "./notify-sinks.js";
import { ProjectRegistryError } from "./projects.js";
import { EnvError } from "./env-vars.js";
import { PiConfigError } from "./pi-config.js";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid: 400,
  busy: 409,
  conflict: 409,
  ambiguous: 409,
  unavailable: 503,
  internal: 500,
  offline: 503,
  rate_limited: 429,
  timeout: 504,
};

export class ApiFault extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const invalid = (message: string) => new ApiFault("invalid", message);
export const notFound = (message: string) => new ApiFault("not_found", message);

/**
 * SQLite faults, mapped to bounded client-facing text (R5 finding 5): node:sqlite
 * reports plain Errors with `code: "ERR_SQLITE_ERROR"` and a numeric `errcode`
 * (5=BUSY, 6=LOCKED, 8=READONLY, 11=CORRUPT, 26=NOTADB). The raw message
 * ("database is locked", "no such column: …") must never reach a client.
 */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

const sqliteCode = (err: unknown): string | undefined =>
  err instanceof Error ? (err as { code?: unknown }).code as string | undefined : undefined;

export const isSqliteError = (err: unknown): err is Error & { errcode?: number } =>
  sqliteCode(err) === "ERR_SQLITE_ERROR" && err instanceof Error;

const sqliteErrcode = (err: Error & { errcode?: number }): number | undefined =>
  typeof err.errcode === "number" ? err.errcode : undefined;

/** True when a failure means "another connection holds the database" — retryable, not fatal. */
export const isStorageBusy = (err: unknown): boolean => {
  if (!isSqliteError(err)) return false;
  const errcode = sqliteErrcode(err);
  return errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED || /database (is|table is) locked/i.test(err.message);
};

/** The one retryable storage fault (R5 finding 1): 503, temporary, no sqlite internals. */
export const storageBusyFault = (): ApiFault =>
  new ApiFault("unavailable", "The device's storage is busy; this failure is temporary — retry shortly");

/** True when the database FILE itself is unreadable (corrupt header / not a database / foreign format). */
export const isUnreadableStorage = (err: unknown): boolean => {
  if (!isSqliteError(err)) return false;
  const errcode = sqliteErrcode(err);
  return (
    errcode === SQLITE_CORRUPT ||
    errcode === SQLITE_NOTADB ||
    /file is not a database|disk image is malformed|unsupported file format/i.test(err.message)
  );
};

/** Map any sqlite error to a bounded typed fault; the raw message never leaves the server. */
const sqliteFault = (err: Error & { errcode?: number }): ApiFault => {
  if (isStorageBusy(err)) return storageBusyFault();
  if (isUnreadableStorage(err))
    return new ApiFault("unavailable", "The device's storage is unreadable; restart the device to quarantine the corrupt file and rebuild");
  if (/^no such (table|column):/i.test(err.message) || /^unknown column/i.test(err.message))
    return new ApiFault("unavailable", "The device's storage schema does not match this build; restart the device to migrate");
  return new ApiFault("unavailable", "A storage operation failed; retry, or restart the device if it persists");
};

/** Typed registry failures carry their own 4xx code (`invalid`/`not_found`) — map them
 * to the matching status with the message intact, instead of a 500 "internal". */
const registryFault = (err: unknown): ApiFault | undefined => {
  if (
    err instanceof ScheduleRegistryError ||
    err instanceof GraphError ||
    err instanceof NotifySinkError ||
    err instanceof ProjectRegistryError ||
    err instanceof EnvError ||
    err instanceof PiConfigError
  )
    return err.code === "not_found" ? notFound(err.message) : invalid(err.message);
  return undefined;
};

export const errorMiddleware: ErrorRequestHandler = (err, req, res, _next) => {
  let fault: ApiFault;
  const typed = registryFault(err);
  if (err instanceof ApiFault) fault = err;
  else if (typed) fault = typed;
  else if (err instanceof SessionFailed)
    fault = new ApiFault("unavailable", "The session failed and is closed; it is unavailable until reopened");
  else if (err instanceof ConversationBusy) fault = new ApiFault("busy", "The agent is busy and the input asked to be rejected while busy");
  // pi-durable's typed "this storage READ was malformed" class (a cursor from
  // another scan, an unknown id): caller error whatever the message text. The
  // old mapping keyed on the message-prefix regex below, so only "Invalid…"
  // wordings scored 400 and any other message leaked as a 500 with raw
  // internal text.
  else if (err instanceof StorageRequestError) fault = invalid(err.message);
  else if (err?.type === "entity.parse.failed") fault = invalid("Body must be valid JSON");
  else if (err?.type === "entity.too.large") fault = invalid("Body too large");
  // SQLite faults get a bounded typed shape (R5 finding 5) — before any message
  // regex could touch them, and with the full error still logged server-side.
  else if (isSqliteError(err)) {
    console.error(`[dpi-backend] ${req.method} ${req.path}: storage error:`, err.stack);
    fault = sqliteFault(err);
  }
  else if (/App State changed while you were editing/.test(String(err?.message))) fault = new ApiFault("conflict", err.message);
  // Message-prefix fallback for dpi-sdk's app-state validation Errors
  // (dpi-sdk/src/app-state.ts throws plain Error with no class of its own).
  // Typed classes are mapped above by instanceof — nothing else relies on this.
  else if (err instanceof Error && /^(Field|Invalid|Use a JSON Pointer|Increment|The state root|State path|Parent must|Value must|Reserved field|App State must|State is too)/.test(err.message))
    fault = invalid(err.message);
  else {
    console.error(`[dpi-backend] ${req.method} ${req.path}:`, err instanceof Error ? err.stack : err);
    fault = new ApiFault("internal", err instanceof Error ? err.message : "Internal error");
  }
  if (res.headersSent) return void res.end();
  res.status(fault.status).json({ error: { code: fault.code, message: fault.message } });
};
