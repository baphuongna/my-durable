/**
 * One error contract for the whole HTTP surface: `{ error: { code, message } }` with a stable
 * code and a short message. Framework error pages (stack frames, module paths, absolute paths)
 * never reach a client, and an unexpected fault is a generic 500 whose detail stays in the log.
 */
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import { AuditUnavailableError, scrubSecrets } from "./audit.js";

export interface HttpFailure {
  status: number;
  code: string;
  message: string;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "invalid",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  410: "gone",
  413: "payload_too_large",
  415: "unsupported_media_type",
  421: "misdirected",
  429: "rate_limited",
};

const MESSAGE_BY_STATUS: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  405: "Method not allowed",
  409: "Conflict",
  410: "Gone",
  413: "Request body is too large",
  415: "Unsupported media type",
  421: "Misdirected request",
  429: "Too many requests; slow down",
};

const MESSAGE_MAX = 200;
const LOG_INTERVAL_MS = 10_000;
let loggedAt = 0;

interface Thrown {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
  expose?: unknown;
  message?: unknown;
}

const clientStatus = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isInteger(n) && n >= 400 && n <= 499 ? n : undefined;

/**
 * Map anything thrown to a client-safe failure.
 *
 * - Audit storage refusal → 503 `audit_unavailable`.
 * - Body-parser / router / static errors (they carry `type` or `expose`) → fixed text per cause or
 *   status, never the library's own message.
 * - Errors our code raises on purpose with a 4xx `status` → their (short, scrubbed) message.
 * - Anything else → `plainStatus`: a 4xx keeps the message (handlers that validate input by
 *   throwing); the default 500 hides it and logs it.
 */
export function describeFailure(e: unknown, plainStatus = 500): HttpFailure {
  if (e instanceof AuditUnavailableError)
    return {
      status: 503,
      code: "audit_unavailable",
      message: "Audit storage is unavailable; the change was not applied",
    };

  const t = (e && typeof e === "object" ? e : {}) as Thrown;
  switch (t.type) {
    case "entity.parse.failed":
    case "entity.verify.failed":
      return { status: 400, code: "invalid_json", message: "Request body is not valid JSON" };
    case "entity.too.large":
      return { status: 413, code: "payload_too_large", message: MESSAGE_BY_STATUS[413]! };
    case "charset.unsupported":
    case "encoding.unsupported":
      return {
        status: 415,
        code: "unsupported_media_type",
        message: "Unsupported request encoding",
      };
    case "request.aborted":
    case "request.size.invalid":
    case "parameters.too.many":
      return { status: 400, code: "invalid", message: "Request body could not be read" };
  }

  const status = clientStatus(t.status) ?? clientStatus(t.statusCode);
  // body-parser/send/http-errors set `type` or `expose`; the router flags an undecodable path param as a URIError.
  const fromFramework =
    typeof t.type === "string" || typeof t.expose === "boolean" || e instanceof URIError;
  if (status && fromFramework)
    return {
      status,
      code: CODE_BY_STATUS[status] ?? "invalid",
      message: MESSAGE_BY_STATUS[status] ?? MESSAGE_BY_STATUS[400]!,
    };

  const own = status ?? clientStatus(plainStatus);
  if (own) {
    const text =
      typeof t.message === "string" && t.message
        ? t.message
        : (MESSAGE_BY_STATUS[own] ?? "Bad request");
    const code = own === 404 ? "not_found" : (CODE_BY_STATUS[own] ?? "invalid");
    return {
      status: own,
      code: own === 400 ? "invalid" : code,
      message: scrubSecrets(text).slice(0, MESSAGE_MAX),
    };
  }

  logUnexpected(e);
  return { status: 500, code: "internal", message: "Internal error" };
}

function logUnexpected(e: unknown): void {
  const now = Date.now();
  if (now - loggedAt < LOG_INTERVAL_MS) return;
  loggedAt = now;
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`hub: unhandled request error: ${scrubSecrets(text).slice(0, MESSAGE_MAX)}`);
}

export const body = (f: HttpFailure) => ({ error: { code: f.code, message: f.message } });

/**
 * Wrap a route handler so that whatever it throws is answered in the contract above. A handler
 * that rejects on purpose carries a 4xx `status`; any other throw is our fault, so it is a 500.
 */
export const safe =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (res.headersSent) return;
      const failure = describeFailure(e);
      res.status(failure.status).json(body(failure));
    }
  };

/** Last middleware: every error that reaches it is answered in the contract above. */
export const errorMiddleware: ErrorRequestHandler = (e, _req, res, next) => {
  if (res.headersSent) return next(e); // too late for a body; Express closes the socket
  const f = describeFailure(e);
  res.status(f.status).json(body(f));
};
