// Types for bin/update.mjs — the updater is plain JS (it must run before any
// TS toolchain is available), so its public surface is declared here.
export interface UpdateDeps {
  argv: string[];
  pkg: { version: string; engines?: { node?: string } };
  nodeVersion: string;
  fetchLatest: () => Promise<string>;
  daemon: { running: () => Promise<boolean>; stop: () => Promise<unknown>; start: () => Promise<unknown> };
  runNpm: (version: string) => Promise<{ code: number; output: string }>;
  print: (line: string) => void;
  printErr: (line: string) => void;
}
export function rank(version: string): { nums: number[]; pre: boolean };
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function satisfiesEngine(current: string, required: string): boolean;
export function normalizeExitCode(code: number | undefined): number;
export function isBusyFailure(text: string): boolean;
export function runUpdate(deps: UpdateDeps): Promise<number>;
export function spawnNpm(args: string[]): Promise<{ code: number; output: string }>;
export function fetchLatestVersion(): Promise<string>;
export function daemonControl(
  dpiPath: string,
  port: number,
): { running: () => Promise<boolean>; stop: () => Promise<number>; start: () => Promise<number> };
/** Below this the app cannot run at all (node:sqlite). The only hard block. */
export const REQUIRED_NODE_FLOOR: string;
