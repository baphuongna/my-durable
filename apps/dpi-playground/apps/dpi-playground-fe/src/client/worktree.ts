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
}: CreateWorktreeSessionArgs): Promise<SessionSummary> {
  let repoRoot = root;
  if (!repoRoot) {
    const status: GitStatus = await deviceApi.gitStatus(cwd);
    if (!status.repo || !status.root) throw Error(`${cwd} is not a git repository`);
    repoRoot = status.root;
  }
  const { target } = await addWorktree(deviceApi, cwd, repoRoot, branch);
  return createSessionOn(deviceApi, target, sessionName);
}
