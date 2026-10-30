// One place for the FE's copy of the device's git-containment rule.
// A device serves git ONLY under its configured start dirs (the device stays
// the enforcer — this is the advisory pre-check that keeps doomed requests off
// the wire). Kept import-free so both the store and the client wrapper can use
// it without a cycle.
export interface GitDeviceFacts {
  startDirs?: unknown;
  /** run-8: the device's own served set (start dirs + session folders). Preferred
   *  when present — the FE must judge with the same list the enforcer uses. */
  gitDirs?: unknown;
  platform?: unknown;
}

/** Normalised spelling used for the comparison (win32: slash-fold + case-fold). */
export function normGitPath(p: string, win: boolean): string {
  const trimmed = String(p ?? "").trim();
  return win
    ? trimmed.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
    : trimmed.replace(/\/+$/, "");
}

/** True when the device's start dirs are unknown (allow: the device decides) or
 *  `path` IS a start dir / lives under one. */
export function pathUnderStartDirs(info: GitDeviceFacts | undefined, path: string): boolean {
  const dirs = Array.isArray(info?.gitDirs) && info.gitDirs.length ? info.gitDirs : info?.startDirs;
  if (!Array.isArray(dirs) || dirs.length === 0) return true;
  const win = String(info?.platform ?? "").startsWith("win32");
  const a = normGitPath(path, win);
  return dirs.some((raw) => {
    const b = normGitPath(String(raw), win);
    return !!b && (a === b || a.startsWith(win ? `${b}\\` : `${b}/`));
  });
}

/** Operator-facing sentence naming the roots the device actually serves. */
export function outsideStartDirsReason(info: GitDeviceFacts | undefined): string {
  const source = Array.isArray(info?.gitDirs) && info.gitDirs.length ? info.gitDirs : info?.startDirs;
  const dirs = Array.isArray(source) ? (source as unknown[]).map(String) : [];
  return dirs.length
    ? `outside the device's start dirs (it serves: ${dirs.join(", ")})`
    : "outside the device's start dirs";
}
