import type { RequestHandler } from "express";
import type { Store } from "./store.js";

/** The rendered response of the request that owns an Idempotency-Key mid-flight. */
type Outcome = { status: number; body: unknown };

/**
 * Replays the stored response for a repeated `Idempotency-Key` on create routes.
 *
 * Two layers:
 *  - after the first request with a key finishes, `store.replay` answers every
 *    later one from the `requests` table;
 *  - WHILE it is still rendering, same-key requests share its outcome instead
 *    of racing into N duplicates (6 concurrent creates used to make 6
 *    sessions: the remember-then-replay row only lands when the winner is
 *    done). Same pattern as git.ts's `statusInFlight` — a per-key promise map,
 *    not a lock file.
 */
export function idempotent(store: Store): RequestHandler {
  // Per-middleware (per Store) so concurrent app instances never share flights.
  const inFlight = new Map<string, Promise<Outcome>>();
  return (req, res, next) => {
    const key = req.get("idempotency-key");
    if (!key) return next();
    if (key.length > 128) return void res.status(400).json({ error: { code: "invalid", message: "Idempotency-Key too long" } });
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    const stored = store.replay(key, route);
    if (stored) return void res.status(stored.status).set("Idempotent-Replay", "true").json(stored.body);
    const flightKey = `${route}\u0000${key}`;
    const running = inFlight.get(flightKey);
    if (running) {
      // A loser waits for the winner's outcome: a stored success replays with
      // the header; a failure is handed over as-is (nothing was remembered, so
      // the caller may still retry the key).
      void running.then((done) => {
        if (done.status < 400) res.set("Idempotent-Replay", "true");
        res.status(done.status).json(done.body);
      }, next);
      return;
    }
    let settle!: (outcome: Outcome) => void;
    let fail!: (error: Error) => void;
    const flight: Promise<Outcome> = new Promise<Outcome>((ok, no) => {
      settle = ok;
      fail = no;
    }).finally(() => {
      if (inFlight.get(flightKey) === flight) inFlight.delete(flightKey);
    });
    // The winner never awaits `flight`; without this a winner that dies without
    // rendering would surface as an unhandled rejection.
    flight.catch(() => {});
    inFlight.set(flightKey, flight);
    // A client that disconnects before the response must release same-key
    // waiters, not hang them forever.
    res.once("close", () => {
      if (!res.writableEnded) fail(new Error("the request holding this Idempotency-Key ended without a response"));
    });
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      settle({ status: res.statusCode, body });
      if (res.statusCode < 400) store.remember(key, route, res.statusCode, body);
      return json(body);
    };
    next();
  };
}
