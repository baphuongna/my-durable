// REST v1. Every route requires the device token (see auth.ts). Session refs are a UUID or a
// unique name; agent refs are a numeric id, `main`, or a unique name.
import { Router, type Request, type Response, type NextFunction } from "express";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { DEVICE_DOC_KINDS, type SessionRow, type Store } from "./store.js";
import { agentStream, deviceStream, sessionStream } from "./streams.js";
import { idempotent } from "./idempotency.js";
import { invalid, notFound } from "./errors.js";
import { streamSessionBundle } from "./zip.js";
import type { DevicePairing } from "./pairing.js";

type Async = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Async) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
import { gitOp, gitStatus, gitStatusBatch, isNotARepoError, type GitOp } from "./git.js";
const GIT_OPS: GitOp[] = ["diff", "log", "log-list", "fetch", "pull", "push", "switch", "branch", "commit", "stage", "unstage", "discard", "diff-file", "stash-push", "stash-pop", "compare", "merge-abort", "show-files", "ignore", "checkpoint", "checkpoints", "rewind", "resolve", "submodule-update", "pr-create", "pr-list", "pr-merge", "pr-checks", "pr-comment", "worktree-list", "worktree-add", "worktree-remove"];

interface Locals {
  row: SessionRow;
  h: Harness;
  c: Conversation;
}

const param = (req: Request, key: string) => String(req.params[key]);
const int = (value: unknown, name: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw invalid(`${name} must be an integer`);
  return n;
};

/** A numeric query/body param: absent → fallback, non-integer or below min → 400,
 *  above max → clamped. `Number(query)` alone lets NaN reach SQLite and brick
 *  the session, so every limit/waitMs goes through here. */
const intArg = (raw: unknown, name: string, fallback: number, min: number, max: number) => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw invalid(`${name} must be an integer from ${min} to ${max}`);
  return Math.min(n, max);
};

export function v1(
  store: Store,
  pairing?: DevicePairing,
  connector?: { status(): unknown },
  stop?: () => void,
) {
  // caseSensitive: the hub tunnel's allowlist is lowercase-exact, so the
  // device-local surface must not be looser than what can actually reach it
  // (/V1/DEVICE used to answer 200 over loopback and 404 through the tunnel).
  // Every client (sdk/TUI/web) speaks lowercase — verified against sdk client.ts.
  const r = Router({ caseSensitive: true });
  const create = idempotent(store);
  // `dpi device stop`: graceful local shutdown (token-authed like every /v1
  // route). The response flushes BEFORE the daemon tears down so the caller
  // always sees 200 instead of a dropped connection.
  if (stop)
    r.post("/shutdown", (_req, res) => {
      res.json({ ok: true });
      setImmediate(stop);
    });

  // Local pairing control point (03 §7): the TUI never touches crypto or the
  // pairing files directly — everything flows through these token-authed routes.
  // Tunnel connector status (no secrets) for the TUI (P2-13).
  if (connector) r.get("/tunnel", (_req, res) => res.json(connector.status()));
  if (pairing) {
    // Pairing errors carry {code, status}; map them without going through the
    // generic middleware so codes like hub_required/busy survive to the TUI.
    const fail = (e: unknown, res: Response) =>
      res.status((e as { status?: number }).status ?? 400).json({
        error: { code: (e as { code?: string }).code ?? "invalid", message: (e as Error).message },
      });
    r.get("/pairing", (_req, res) => res.json(pairing.status()));
    r.post("/pairing/start", (req, res) => {
      void (async () => {
        try {
          const input = req.body as { code?: string; hub?: string; pairUrl?: string; force?: boolean };
          // A pasted pair URL (v1) or offer link (v2) carries the code itself — a pairUrl-only body
          // is the TUI/daemon paste path, so code is required only when pairUrl is absent.
          // Three shapes: a code (+ optional hub), a pasted pair URL, or just
          // `{hub}` — the device asks the hub itself (device-initiated), which is
          // what `dpi pair --hub <origin>` sends. Nothing is copied between
          // machines in that last form.
          if (
            !input ||
            (input.code !== undefined && typeof input.code !== "string") ||
            (input.hub !== undefined && typeof input.hub !== "string") ||
            (input.pairUrl !== undefined && typeof input.pairUrl !== "string") ||
            (input.code === undefined && input.pairUrl === undefined && !input.hub)
          )
            throw invalid("body: { code?: string, hub?: string, pairUrl?: string, force?: boolean } — code, pairUrl or hub required");
          await pairing.start({ code: input.code ?? "", hub: input.hub, pairUrl: input.pairUrl, force: input.force });
          res.json(pairing.status());
        } catch (e) {
          fail(e, res);
        }
      })();
    });
    r.post("/pairing/cancel", (_req, res) => {
      try {
        res.json(pairing.cancel());
      } catch (e) {
        fail(e, res);
      }
    });
  }

  // Resolve :s and :a once per request.
  r.param("s", (req, res, next, value: string) => {
    try {
      const row = store.resolveSession(value);
      res.locals.row = row;
      next();
    } catch (e) {
      next(e);
    }
  });
  r.param("a", (req, res, next, value: string) => {
    store
      .resolveAgent(param(req, "s"), value)
      .then((resolved) => {
        Object.assign(res.locals, resolved);
        next();
      })
      .catch(next);
  });
  const L = (res: Response) => res.locals as Locals;

  // ---------------------------------------------------------- device
  r.get("/device", (_req, res) => res.json(store.deviceInfo()));
  // Model health, probed live: one provider, its first catalog model, one
  // throwaway session. Local control plane only — deliberately NOT tunnelled.
  r.post("/device/probe-model", route(async (req, res) => {
    const provider = String(req.body?.provider ?? "");
    const modelId = String(req.body?.modelId ?? "");
    res.json(await store.probeModel(provider, modelId));
  }));
  // Host health (uptime/load/memory/disk) — one-shot, the UIs ask when looked at.
  r.get("/device/vitals", route(async (_req, res) => res.json(await store.vitals())));
  // Usage rollup for the sessions this device still holds (orca usage/, our data).
  r.get("/device/usage", route(async (_req, res) => res.json(await store.usageReport())));
  r.get("/tree", route(async (_req, res) => res.json(await store.tree())));
  r.get("/events", (req, res, next) => {
    try {
      deviceStream(store, req, res);
    } catch (e) {
      next(e);
    }
  });
  r.get("/fs/dirs", route(async (req, res) => res.json(await store.browse(String(req.query.path ?? "")))));
  // Git, spoken by the device itself: status for the UIs, ops for the humans.
  // The path must live under a start dir (same rule as every other fs route);
  // an omitted path means the FIRST start dir, never the daemon's own cwd.
  const gitPath = async (raw: unknown) => {
    if (raw === undefined || raw === null) return store.firstStartDir();
    if (typeof raw !== "string" || !raw.trim()) throw invalid("path must be a non-empty string");
    return store.containedPath(raw);
  };
  /** A git failure answers 400 with a bounded message — never raw CLI usage
   *  text, never a 500 (B3). */
  const gitFault = (e: unknown, path: string) =>
    isNotARepoError(e)
      ? invalid(`not a git repository: ${path}`)
      : invalid(String((e as Error)?.message ?? e).slice(0, 200));
  r.get("/git/status", route(async (req, res) => {
    const path = await gitPath(req.query.path);
    try {
      res.json(await gitStatus(path));
    } catch (e) {
      throw gitFault(e, path);
    }
  }));
  r.post("/git/status-batch", route(async (req, res) => {
    const raw: string[] = Array.isArray(req.body?.paths) ? req.body.paths.map(String).filter(Boolean).slice(0, 50) : [];
    const paths = await Promise.all(raw.map((p) => store.containedPath(p)));
    try {
      res.json(await gitStatusBatch(paths));
    } catch (e) {
      throw gitFault(e, paths[0] ?? "");
    }
  }));
  r.post("/git", route(async (req, res) => {
    const body = req.body ?? {};
    const op = String(body.op ?? "") as GitOp;
    if (!GIT_OPS.includes(op)) throw invalid(`Unknown git op ${String(body.op ?? "")}`);
    const path = await gitPath(body.path);
    try {
      const out = await gitOp(path, op, {
      ref: body.ref,
      branch: body.branch,
      message: body.message,
      target: body.target,
      files: Array.isArray(body.files) ? body.files.map(String).slice(0, 500) : undefined,
      // booleans stay booleans: gitOp validates names/refs itself.
      create: body.create === true,
      staged: body.staged === true,
      rebase: body.rebase === true,
      setUpstream: body.setUpstream === true,
      name: typeof body.name === "string" ? body.name : undefined,
      lines: Array.isArray(body.lines) ? body.lines.map(String).slice(0, 50) : undefined,
      side: body.side === "ours" || body.side === "theirs" ? body.side : undefined,
      method: body.method === "merge" ? "merge" : "squash",
      body: typeof body.body === "string" ? body.body : undefined,
      n: Number.isInteger(body.n) ? Number(body.n) : undefined,
      });
      res.json(out);
    } catch (e) {
      throw gitFault(e, path);
    }
  }));
  r.get(
    "/docs/:kind",
    route(async (req, res) => {
      const kind = param(req, "kind");
      if (!DEVICE_DOC_KINDS.includes(kind)) throw invalid(`Unknown device document ${kind}`);
      res.json({ kind, ...(await store.deviceDoc(kind)) });
    }),
  );

  // ---------------------------------------------------------- projects
  // Roots with labels/custom names: the tree's group-by-cwd as an entity you can
  // own. Archived projects stay out of the default list, like archived sessions.
  r.get("/projects", (req, res) => {
    const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";
    res.json({ projects: store.projectList(includeArchived) });
  });
  r.patch("/projects/:id", route(async (req, res) => {
    const body = req.body ?? {};
    if (body.customName !== undefined && typeof body.customName !== "string") throw invalid("customName must be a string");
    if (body.labels !== undefined && !Array.isArray(body.labels)) throw invalid("labels must be an array of strings");
    if (
      body.model !== undefined &&
      body.model !== "" &&
      (typeof body.model?.provider !== "string" || typeof body.model?.modelId !== "string")
    )
      throw invalid('model must be { provider, modelId } or ""');
    res.json(
      await store.updateProject(param(req, "id"), { customName: body.customName, labels: body.labels, model: body.model }),
    );
  }));
  r.post("/projects/:id/archive", route(async (req, res) => res.json(await store.archiveProject(param(req, "id")))));
  r.post("/projects/:id/unarchive", route(async (req, res) => res.json(await store.unarchiveProject(param(req, "id")))));

  // ---------------------------------------------------------- env vars
  // The daemon's own env file, behind the guarded editor: managed keys are
  // refused, secrets come back masked, and every change needs a restart.
  r.get("/device/env", route(async (_req, res) => res.json(await store.envView())));
  r.post("/device/env", route(async (req, res) => {
    const body = req.body ?? {};
    if (typeof body.key !== "string" || !body.key.trim()) throw invalid("key is required");
    if (typeof body.value !== "string" || !body.value) throw invalid("value is required");
    res.status(201).json(await store.setEnvVar(body.key.trim(), body.value));
  }));
  r.delete("/device/env/:key", route(async (req, res) => res.json(await store.removeEnvVar(param(req, "key")))));

  // -------------------------------------------------- pi provider keys
  // WRITE-ONLY over pi's own auth.json (gate #2): values are never returned —
  // masked tails only — and pi's interactive oauth logins are untouchable.
  r.get("/device/pi-auth", (_req, res) => res.json({ entries: store.piAuthView() }));
  r.put("/device/pi-auth/:provider", route(async (req, res) => {
    const body = req.body ?? {};
    if (typeof body.key !== "string" || !body.key.trim()) throw invalid("key is required");
    // Same bound as pi's own auth.json writer — a paste of the wrong buffer is a 400, not a 500.
    if (body.key.length > 4096) throw invalid("key must be 1–4096 non-whitespace characters");
    res.json(store.setPiApiKey(param(req, "provider"), body.key));
  }));
  r.delete("/device/pi-auth/:provider", route(async (req, res) => res.json(store.removePiApiKey(param(req, "provider")))));

  // ---------------------------------------------------- notifications
  // Outbound fan-out (webhook/ntfy). Configured here, delivered by the device.
  r.get("/notify/sinks", (_req, res) => res.json({ sinks: store.notifySinkList() }));
  // allowPrivateHosts (B5) is a per-request grant on top of the env default — strictly boolean.
  const sinkBody = (body: unknown): Parameters<Store["createNotifySink"]>[0] => {
    if (
      body &&
      typeof body === "object" &&
      (body as { allowPrivateHosts?: unknown }).allowPrivateHosts !== undefined &&
      typeof (body as { allowPrivateHosts?: unknown }).allowPrivateHosts !== "boolean"
    )
      throw invalid("allowPrivateHosts must be a boolean");
    return (body ?? {}) as Parameters<Store["createNotifySink"]>[0];
  };
  r.post("/notify/sinks", route(async (req, res) => res.status(201).json(await store.createNotifySink(sinkBody(req.body)))));
  r.patch("/notify/sinks/:id", route(async (req, res) => res.json(await store.updateNotifySink(param(req, "id"), sinkBody(req.body)))));
  r.delete("/notify/sinks/:id", route(async (req, res) => res.json(await store.removeNotifySink(param(req, "id")))));
  r.post("/notify/test", route(async (_req, res) => res.json({ results: await store.testNotifySinks() })));

  // ----------------------------------------------------- task-graphs
  // The device owns execution (sequential, topological); these routes only
  // read, edit and START a run — the answer streams back through the tree.
  r.get("/graphs", (req, res) => {
    const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";
    res.json({ graphs: store.graphList(includeArchived) });
  });
  r.get("/graphs/:id", route(async (req, res) => {
    const found = store.graphGet(param(req, "id"));
    if (!found) throw notFound(`no graph ${param(req, "id")}`);
    res.json(found);
  }));
  r.post("/graphs", route(async (req, res) => res.status(201).json(await store.createGraph(req.body ?? {}))));
  r.patch("/graphs/:id", route(async (req, res) => res.json(await store.updateGraph(param(req, "id"), req.body ?? {}))));
  r.delete("/graphs/:id", route(async (req, res) => res.json(await store.removeGraph(param(req, "id")))));
  r.post("/graphs/:id/run", route(async (req, res) => res.status(202).json(await store.runGraphNow(param(req, "id")))));

  // -------------------------------------------------------- schedules
  // The device owns execution (systemd/cron are deliberately rejected by config);
  // these routes only read and edit the schedule records.
  r.get("/schedules", (_req, res) => res.json({ schedules: store.scheduleList() }));
  r.post("/schedules", route(async (req, res) => res.status(201).json(await store.createSchedule(req.body ?? {}))));
  r.patch("/schedules/:id", route(async (req, res) => res.json(await store.updateSchedule(param(req, "id"), req.body ?? {}))));
  r.delete("/schedules/:id", route(async (req, res) => res.json(await store.removeSchedule(param(req, "id")))));
  r.post("/schedules/:id/run", route(async (req, res) => res.json(await store.runScheduleNow(param(req, "id")))));

  // ---------------------------------------------------------- sessions
  r.get("/sessions", route(async (_req, res) => res.json((await store.tree()).sessions)));
  r.post("/sessions", create, route(async (req, res) => res.status(201).json(await store.create(req.body ?? {}))));
  // Literal route, so it must precede `/sessions/:s` (Express matches in order).
  // Names/cwds/models only — transcript search needs an FTS index, not a LIKE scan.
  r.get("/sessions/search", route(async (req, res) => res.json(store.searchSessions(String(req.query.q ?? "")))));
  r.get("/sessions/:s", route(async (_req, res) => res.json(await store.sessionSummary(L(res).row))));
  r.patch("/sessions/:s", route(async (req, res) => res.json(await store.rename(L(res).row, req.body?.name))));
  r.get("/sessions/:s/compaction", route(async (_req, res) => res.json(store.compactionOf(L(res).row.id))));
  r.patch("/sessions/:s/compaction", route(async (req, res) => res.json(store.setCompaction(L(res).row, req.body ?? {}))));
  r.delete("/sessions/:s", route(async (_req, res) => res.json(await store.archive(L(res).row))));

  // ------------------------------------------------------- old sessions
  // The archive is a feature surface (policy #3): list, read a transcript,
  // restore back to live. Nothing here deletes — deletion stays `dpi gc`.
  r.get("/archive", route(async (_req, res) => res.json({ sessions: store.archivedList() })));
  r.get("/archive/:id/transcript", route(async (req, res) =>
    res.json(store.archivedTranscriptView(param(req, "id"), String(req.query.format ?? "markdown"))),
  ));
  r.post("/archive/:id/restore", route(async (req, res) =>
    res.status(201).json(await store.restoreArchivedSession(param(req, "id"))),
  ));
  // One downloadable .zip: manifest + session record + every agent's transcript/config.
  // R8: the bundle streams through a temp file (deflate piped to disk, never the
  // whole archive in RAM) and the route pipes that file out, unlinks it in the
  // finally, and speaks plain zip bytes — Content-Disposition names the download.
  // Guards (256 MiB uncompressed ceiling, zip64-less limits) run during the temp
  // write, so refusals surface as the usual JSON faults before any byte is sent.
  r.get(
    "/sessions/:s/export",
    route(async (_req, res) => {
      const bundle = await streamSessionBundle(store, L(res).row);
      try {
        res.set({
          "Content-Type": bundle.mime,
          "Content-Length": String(bundle.bytes),
          "Content-Disposition": `attachment; filename="${bundle.filename}"`,
        });
        await pipeline(createReadStream(bundle.path), res);
      } finally {
        await bundle.cleanup();
      }
    }),
  );
  r.get("/sessions/:s/events", route(async (_req, res) => sessionStream(store, L(res).row, res)));
  // The zcode flagship, adapted: which files has THIS session's agent touched?
  // Powers "commit session changes" in the git panel.
  r.get("/sessions/:s/git-files", route(async (_req, res) => res.json({ files: await store.sessionTouchedFiles(L(res).row) })));
  // Per-turn breakdown of the same data (zcode taskChangeSummary shape).
  r.get("/sessions/:s/git-turns", route(async (_req, res) => res.json({ turns: await store.sessionGitTurns(L(res).row) })));
  r.get(
    "/sessions/:s/tasks",
    route(async (req, res) => {
      const status = String(req.query.status ?? "terminal");
      if (!["live", "terminal"].includes(status)) throw invalid("status must be live or terminal");
      const h = store.harness(L(res).row);
      if (status === "live") return res.json(await store.liveTasks(h));
      res.json(await store.tasks(h, status, intArg(req.query.limit, "limit", 20, 1, 5000)));
    }),
  );
  r.post(
    "/sessions/:s/tasks/:taskId/abort",
    route(async (req, res) => res.json(await store.abortTask(store.harness(L(res).row), int(req.params.taskId, "taskId")))),
  );
  r.get("/sessions/:s/inspect", route(async (_req, res) => res.json(await store.inspect(store.harness(L(res).row)))));
  r.get(
    "/sessions/:s/submissions/:id",
    route(async (req, res) => {
      const closed = new AbortController();
      res.on("close", () => closed.abort());
      res.json(
        await store.settled(
          store.harness(L(res).row),
          int(req.params.id, "submission id"),
          intArg(req.query.waitMs, "waitMs", 0, 0, 300_000),
          closed.signal,
        ),
      );
    }),
  );

  // ---------------------------------------------------------- agents
  r.get("/sessions/:s/agents", route(async (_req, res) => res.json(await store.agents(L(res).row))));
  r.post(
    "/sessions/:s/agents",
    create,
    route(async (req, res) => {
      // An agent is a deliberate act: a body with a name is required, so a
      // mistyped request never spawns a default agent (B6).
      const body = req.body ?? {};
      if (typeof body.name !== "string" || !body.name.trim()) throw invalid("name is required");
      res.status(201).json(await store.createAgent(L(res).row, body));
    }),
  );
  const a = "/sessions/:s/agents/:a";
  r.get(a, route(async (_req, res) => res.json(await store.agentDetail(L(res).row, L(res).c))));
  r.patch(
    a,
    route(async (req, res) => {
      store.setAgentName(L(res).row, L(res).c.id as number, req.body?.name);
      res.json(await store.agentSummary(L(res).row, L(res).c));
    }),
  );
  r.get(`${a}/events`, route(async (req, res) => agentStream(store, L(res), req, res)));
  r.get(
    `${a}/entries`,
    route(async (req, res) => {
      const scope = String(req.query.scope ?? "all");
      if (scope === "active") return res.json({ items: await store.activeEntries(L(res).c) });
      res.json(await store.entries(L(res).c, req.query.cursor as string | undefined, intArg(req.query.limit, "limit", 500, 1, 5000)));
    }),
  );
  r.get(`${a}/transcript`, route(async (req, res) => res.json(await store.transcript(L(res).c, String(req.query.format ?? "json")))));
  r.post(
    `${a}/messages`,
    route(async (req, res) => {
      const { h, c } = L(res);
      const submission = await store.send(c, req.body ?? {});
      const waitMs = intArg(req.body?.waitMs, "waitMs", 0, 0, 300_000);
      if (!waitMs) return res.status(202).json({ submissionId: submission.id, status: "queued" });
      const closed = new AbortController();
      res.on("close", () => closed.abort());
      const result = await store.settled(h, submission.id as number, waitMs, closed.signal);
      res.status(result.status === "done" || result.status === "unanswered" ? 200 : 202).json(result);
    }),
  );
  r.delete(
    `${a}/inbox/:submissionId`,
    route(async (req, res) => res.json(await store.withdraw(L(res).h, L(res).c, int(req.params.submissionId, "submissionId")))),
  );
  r.post(`${a}/abort`, route(async (req, res) => res.json(await store.abort(L(res).c, req.body?.background === true))));
  r.post(`${a}/fork`, create, route(async (req, res) => res.status(201).json(await store.fork(L(res).row, L(res).c, req.body ?? {}))));
  r.get(`${a}/config`, route(async (_req, res) => res.json((await store.agentDetail(L(res).row, L(res).c)).config)));
  r.patch(`${a}/config`, route(async (req, res) => res.json(await store.configure(L(res).row, L(res).c, req.body ?? {}))));
  r.get(`${a}/extensions`, route(async (_req, res) => res.json(await store.extensionsOf(L(res).row, L(res).c))));
  r.patch(`${a}/extensions`, route(async (req, res) => res.json(await store.setExtension(L(res).row, L(res).c, req.body ?? {}))));
  r.post(`${a}/compact`, route(async (req, res) => res.json(await store.compact(L(res).c, req.body?.instructions))));
  r.post(`${a}/reset`, route(async (req, res) => res.json(await store.reset(L(res).c, req.body?.note))));
  r.get(
    `${a}/docs/:kind`,
    route(async (req, res) => {
      const kind = param(req, "kind");
      res.json({ kind, value: await store.agentDoc(L(res).h, L(res).c, kind) });
    }),
  );

  // ---------------------------------------------------------- demo extension
  r.post(`${a}/demo/state`, route(async (req, res) => res.json(await store.demoState(L(res).c, req.body ?? {}))));
  r.post(
    `${a}/demo/jobs`,
    route(async (req, res) => res.status(201).json(await store.startJob(L(res).row, L(res).h, L(res).c, req.body ?? {}))),
  );
  r.post(
    `${a}/demo/jobs/:taskId/approval`,
    route(async (req, res) => res.json(await store.approveJob(L(res).c, int(req.params.taskId, "taskId"), req.body?.approved))),
  );

  return r;
}
