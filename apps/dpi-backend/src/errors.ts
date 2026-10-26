import type { ErrorRequestHandler } from "express";
import { ConversationBusy, SessionFailed } from "@earendil-works/pi-durable";
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
  else if (err?.type === "entity.parse.failed") fault = invalid("Body must be valid JSON");
  else if (err?.type === "entity.too.large") fault = invalid("Body too large");
  else if (/App State changed while you were editing/.test(String(err?.message))) fault = new ApiFault("conflict", err.message);
  else if (err instanceof Error && /^(Field|Invalid|Use a JSON Pointer|Increment|The state root|State path|Parent must|Value must|Reserved field|App State must|State is too)/.test(err.message))
    fault = invalid(err.message);
  else {
    console.error(`[dpi-backend] ${req.method} ${req.path}:`, err instanceof Error ? err.stack : err);
    fault = new ApiFault("internal", err instanceof Error ? err.message : "Internal error");
  }
  if (res.headersSent) return void res.end();
  res.status(fault.status).json({ error: { code: fault.code, message: fault.message } });
};
