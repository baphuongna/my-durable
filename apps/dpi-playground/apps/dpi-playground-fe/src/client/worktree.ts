// Worktree sessions, shared by the Git tab and the session tree (F3): the
// sibling-target rule (<parent>/<base>-<branch>) lives here once so the two
// entry points cannot drift. GitPanel keeps its own busy/notify chrome around
// the same calls; the session list gets the whole flow in one function.
import type { DpiClient, GitStatus } from "@sdk/client";
import type { SessionSummary } from "@sdk/api";

/** What the flow needs from a device client — structural, so a stub (tests,
 *  other transports) can stand in without constructing a real DpiClient. */
export interface WorktreeApi {
  gitStatus: DpiClient["gitStatus"];
  gitOp: DpiClient["gitOp"];
  createSession: DpiClient["createSession"];
}

/** Sibling checkout target: <parent>/<base>-<branch>. Path separators in the
 *  branch are flattened to dashes — a branch may contain them, a folder may not. */
export function worktreeTarget(root: string, branch: string): string {
  const parent = root.slice(0, root.lastIndexOf("/"));
  const base = root.slice(root.lastIndexOf("/") + 1);
  return `${parent}/${base}-${branch.replace(/[/\\]+/g, "-")}`;
}

/** `git worktree add` into the sibling target — the extracted half of the old
 *  GitPanel.addWorktree. Returns the target plus the op's first line (notify). */
export async function addWorktree(
  deviceApi: Pick<WorktreeApi, "gitOp">,
  cwd: string,
  root: string,
  branch: string,
): Promise<{ target: string; text: string }> {
  const target = worktreeTarget(root, branch);
  const r = await deviceApi.gitOp(cwd, "worktree-add", { branch, target });
  return { target, text: r.text.split("\n")[0] ?? `worktree ${target}` };
}

/** Open a session in an existing folder — the extracted half of the old
 *  GitPanel.sessionOn. Model optional: absent = the device's (or the
 *  project's) default, the same rule as every other create call. */
export async function createSessionOn(
  deviceApi: Pick<WorktreeApi, "createSession">,
  path: string,
  name: string,
  model?: { provider: string; modelId: string },
): Promise<SessionSummary> {
  return deviceApi.createSession(model ? { name, cwd: path, model } : { name, cwd: path });
}

export interface CreateWorktreeSessionArgs {
  deviceApi: WorktreeApi;
  cwd: string;
  sessionName: string;
  branch: string;
  /** Repo root when the caller already has it (GitPanel's cached status);
   *  resolved from the device otherwise. */
  root?: string;
  /** The session this one is branched from (session tree, F3). Its model rides
   *  along ONLY in the object shape the create route requires — SessionSummary
   *  stores `model` as a bare modelId string, so it is rewrapped as
   *  `{ provider, modelId }`; a bare string is a 400 ("model must be
   *  { provider, modelId }"). A field missing — or a pair the device no
   *  longer serves (seen live: sessions outliving a curated-model removal) —
   *  falls to the catalog default, NOT to omitting: the worktree is a sibling
   *  folder, its brand-new project has no default, and the create route has
   *  no device-default fallback for an absent model (both proven live). */
  source?: Pick<SessionSummary, "model" | "provider">;
  /** The device's served catalog (the tree's device.info.models) and its
   *  default (device.info.defaultModel, "provider/id"). With a catalog the
   *  resolution is: source pair if served → catalog default → catalog[0]
   *  (NewSessionDialog's rule). Without one, any { model, provider } pair is
   *  forwarded as-is and a missing pair omits `model` (the documented
   *  create-body contract: absent or { provider, modelId }, never a string). */
  catalog?: ReadonlyArray<{ provider: string; id: string }>;
  defaultModel?: string;
}

/** Worktree + session in one call (session tree, F3): add the sibling
 *  checkout, then open the session right in it. worktree-add runs first, so a
 *  rejected add never leaves a session behind, and the session's cwd is
 *  exactly the folder git just made. */
export async function createWorktreeSession({
  deviceApi,
  cwd,
  sessionName,
  branch,
  root,
  source,
  catalog,
  defaultModel,
}: CreateWorktreeSessionArgs): Promise<SessionSummary> {
  let repoRoot = root;
  if (!repoRoot) {
    const status: GitStatus = await deviceApi.gitStatus(cwd);
    if (!status.repo || !status.root) throw Error(`${cwd} is not a git repository`);
    repoRoot = status.root;
  }
  const { target } = await addWorktree(deviceApi, cwd, repoRoot, branch);
  // Wire shape, not a passthrough: SessionSummary.model is a modelId string,
  // CreateSessionBody.model is { provider, modelId } — never a bare string.
  const { model: srcModel, provider: srcProvider } = source ?? {};
  const served =
    srcModel && srcProvider && (!catalog || catalog.some((m) => m.provider === srcProvider && m.id === srcModel))
      ? { provider: srcProvider, modelId: srcModel }
      : undefined;
  const fallback = catalog?.length
    ? (catalog.find((m) => `${m.provider}/${m.id}` === defaultModel) ?? catalog[0])
    : undefined;
  const model = served ?? (fallback ? { provider: fallback.provider, modelId: fallback.id } : undefined);
  return createSessionOn(deviceApi, target, sessionName, model);
}
