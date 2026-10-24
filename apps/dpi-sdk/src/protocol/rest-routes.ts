// The device REST routes a hub may call through the tunnel (04 §9, P2-16), as an allowlist of method + route.
// Browser-safe: no Node builtins.
//
// Everything else under /v1 is refused. That keeps the device-local control surface (/v1/pairing/*, /v1/tunnel)
// and the three SSE streams (/v1/events, .../events) off the REST channel in every spelling, instead of trying
// to name each bad spelling. A route the device adds is remote-callable only once it is listed here; the
// backend's route-parity test fails until a new route is classified as served or as local/stream.
//
// `:name` stands for one parameter segment. Every other segment is a literal that must match exactly (lowercase):
// Express matches routes case-insensitively, so a looser comparison here would let `/v1/Pairing` through.

const ROUTES: readonly (readonly [method: string, pattern: string])[] = [
  ["GET", "/device"],
  ["GET", "/tree"],
  ["GET", "/fs/dirs"],
  ["GET", "/git/status"],
  ["POST", "/git"],
  ["POST", "/git/status-batch"],
  ["GET", "/docs/:kind"],

  ["GET", "/sessions"],
  ["POST", "/sessions"],
  ["GET", "/sessions/:s"],
  ["PATCH", "/sessions/:s"],
  ["DELETE", "/sessions/:s"],
  ["GET", "/sessions/:s/compaction"],
  ["PATCH", "/sessions/:s/compaction"],
  ["GET", "/sessions/:s/tasks"],
  ["POST", "/sessions/:s/tasks/:taskId/abort"],
  ["GET", "/sessions/:s/inspect"],
  ["GET", "/sessions/:s/submissions/:id"],

  ["GET", "/sessions/:s/agents"],
  ["POST", "/sessions/:s/agents"],
  ["GET", "/sessions/:s/agents/:a"],
  ["PATCH", "/sessions/:s/agents/:a"],
  ["GET", "/sessions/:s/agents/:a/entries"],
  ["GET", "/sessions/:s/agents/:a/transcript"],
  ["POST", "/sessions/:s/agents/:a/messages"],
  ["DELETE", "/sessions/:s/agents/:a/inbox/:submissionId"],
  ["POST", "/sessions/:s/agents/:a/abort"],
  ["POST", "/sessions/:s/agents/:a/fork"],
  ["GET", "/sessions/:s/agents/:a/config"],
  ["PATCH", "/sessions/:s/agents/:a/config"],
  ["GET", "/sessions/:s/agents/:a/extensions"],
  ["PATCH", "/sessions/:s/agents/:a/extensions"],
  ["POST", "/sessions/:s/agents/:a/compact"],
  ["POST", "/sessions/:s/agents/:a/reset"],
  ["GET", "/sessions/:s/agents/:a/docs/:kind"],
  ["POST", "/sessions/:s/agents/:a/demo/state"],
  ["POST", "/sessions/:s/agents/:a/demo/jobs"],
  ["POST", "/sessions/:s/agents/:a/demo/jobs/:taskId/approval"],
];

/** The allowlist as data: `route` is relative to /v1. */
export const REST_ROUTE_ALLOWLIST: readonly { method: string; route: string }[] = ROUTES.map(([method, route]) => ({
  method,
  route,
}));

/** Longest decoded parameter (session and agent names stop at 100 characters). */
export const REST_PARAM_MAX_CHARS = 256;

const COMPILED = ROUTES.map(([method, pattern]) => ({ method, parts: pattern.slice(1).split("/") }));

const decodeOr = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/** One percent-encoded name: not empty, not a dot segment, no separators or control characters once decoded. */
function isParam(segment: string): boolean {
  const name = decodeOr(segment);
  return (
    name !== undefined &&
    name.length > 0 &&
    name.length <= REST_PARAM_MAX_CHARS &&
    name !== "." &&
    name !== ".." &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f/\\]/.test(name)
  );
}

/** `segments` are the raw (still percent-encoded) path segments after /v1. */
export function matchesRestRoute(method: string, segments: readonly string[]): boolean {
  return COMPILED.some(
    (route) =>
      route.method === method &&
      route.parts.length === segments.length &&
      route.parts.every((part, i) => (part.startsWith(":") ? isParam(segments[i]) : part === segments[i])),
  );
}

/**
 * Why a path that matched no route is out of bounds, for the refusal message only (the allowlist alone decides).
 * Case-insensitive on purpose: `/v1/Events` is still an event stream as far as Express is concerned.
 */
export function restRouteKind(segments: readonly string[]): "stream" | "local" | undefined {
  const s = segments.map((segment) => (decodeOr(segment) ?? segment).toLowerCase());
  if (s[0] === "pairing" || s[0] === "tunnel") return "local";
  if (s[0] === "events") return "stream";
  if (s[0] === "sessions" && (s[2] === "events" || (s[2] === "agents" && s[4] === "events"))) return "stream";
  return undefined;
}
