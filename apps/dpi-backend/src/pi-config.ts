/**
 * The device is pi: it reuses the SAME credentials and custom providers the pi
 * CLI already has on this machine — the fix for "pi đầy đủ key, sao durable
 * lại không". Nothing is copied or re-entered:
 *
 *   ~/.pi/agent/auth.json    provider credentials pi saved via /login
 *                            (api_key and oauth entries, keyed by provider id)
 *   ~/.pi/agent/models.json  custom providers ({baseUrl, api, apiKey?, models})
 *
 * PI_AGENT_DIR moves both (same variable pi honors). The device never WRITES
 * pi's files: its credential store is a read-only view, so a headless daemon
 * cannot corrupt an interactive login.
 */
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  createProvider,
  envApiKeyAuth,
  type ApiKeyCredential,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";

/** pi's agent directory on this machine (PI_AGENT_DIR overrides, like pi). */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** auth.json: one type-tagged credential per provider id. */
export function readPiAuth(dir: string): Record<string, Credential> {
  return readJson(join(dir, "auth.json"));
}

/** models.json custom providers: {providers: {name: {baseUrl, api, apiKey?, models[]}}}. */
export function readPiModelsJson(dir: string): PiModelsJson {
  return readJson(join(dir, "models.json"));
}

function readJson(path: string): Record<string, never> | never {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // absent or unreadable: the device simply has no pi credentials
  }
}

export interface PiModelsJson {
  providers?: Record<
    string,
    {
      baseUrl?: string;
      api?: string;
      apiKey?: string;
      name?: string;
      models?: PiCustomModel[];
    }
  >;
}

export interface PiCustomModel {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  cost?: { input?: number; output?: number };
  [key: string]: unknown;
}

/**
 * Read-only credential view over pi's files, honoring pi's precedence
 * (auth.json credential, then the models.json apiKey, then provider env vars —
 * env resolution stays inside pi-ai). Writes are refused by returning the
 * current value: the daemon must not touch an interactive login.
 */
export function piCredentialStore(auth: Record<string, Credential>, modelsJson: PiModelsJson): CredentialStore {
  const of = (providerId: string): Credential | undefined => {
    const fromAuth = auth[providerId];
    if (fromAuth) return fromAuth;
    const key = modelsJson.providers?.[providerId]?.apiKey;
    if (key) {
      const credential: ApiKeyCredential = { type: "api_key", key };
      return credential;
    }
    return undefined;
  };
  return {
    async read(providerId) {
      return of(providerId);
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const ids = new Set([...Object.keys(auth), ...Object.keys(modelsJson.providers ?? {})]);
      return [...ids]
        .map(of)
        .filter((c): c is Credential => !!c)
        .map((c, i) => ({ providerId: [...new Set([...Object.keys(auth), ...Object.keys(modelsJson.providers ?? {})])][i]!, type: c.type }));
    },
    async modify(providerId, fn) {
      const current = of(providerId);
      const next = await fn(current);
      return next === current ? current : current; // read-only: never persist
    },
    async delete() {
      /* read-only */
    },
  };
}

/** Provider ids the device has SOME credential for (auth.json or models.json). */
export function credentialedProviders(auth: Record<string, Credential>, modelsJson: PiModelsJson): string[] {
  return [...new Set([...Object.keys(auth), ...Object.keys(modelsJson.providers ?? {})])].filter((id) => {
    if (auth[id]) return true;
    return !!modelsJson.providers?.[id]?.apiKey;
  });
}

/** pi models.json api id → pi-ai API implementation. Unknown ids are skipped. */
const API_IMPLS: Record<string, () => ReturnType<typeof openAICompletionsApi>> = {
  "openai-completions": () => openAICompletionsApi(),
  "openai-responses": () => openAIResponsesApi() as never,
  "anthropic-messages": () => anthropicMessagesApi() as never,
};

/**
 * Build pi-ai providers for the models.json custom entries. An entry with an
 * api we cannot serve (or no models) is skipped and REPORTED, not silently
 * dropped — the operator should learn why a model is missing.
 */
export function piCustomProviders(
  modelsJson: PiModelsJson,
  onSkip?: (id: string, reason: string) => void,
): Provider[] {
  const out: Provider[] = [];
  for (const [id, entry] of Object.entries(modelsJson.providers ?? {})) {
    const reason = !entry.baseUrl
      ? "no baseUrl"
      : !entry.api || !API_IMPLS[entry.api]
        ? `unsupported api ${String(entry.api)}`
        : !entry.models?.length
          ? "no models"
          : "";
    if (reason) {
      onSkip?.(id, reason);
      continue;
    }
    out.push(
      createProvider({
        id,
        name: entry.name ?? id,
        baseUrl: entry.baseUrl,
        auth: { apiKey: envApiKeyAuth(`${id} API key`, [`${id.toUpperCase().replace(/-/g, "_")}_API_KEY`]) },
        models: entry.models!.map((m) => ({
          type: "chat",
          id: m.id,
          name: m.name ?? m.id,
          provider: id,
          api: entry.api!,
          baseUrl: entry.baseUrl,
          contextWindow: m.contextWindow ?? 128000,
          reasoning: m.reasoning ?? false,
          input: ["text"],
          cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
          ...(m as Record<string, unknown>),
        })) as never,
        api: API_IMPLS[entry.api!]!(),
      }),
    );
  }
  return out;
}

/** Everything pi brings on this machine: credentials + custom providers. */
export interface PiConfig {
  dir: string;
  auth: Record<string, Credential>;
  modelsJson: PiModelsJson;
  credentials: CredentialStore;
  customProviders: Provider[];
  /** Provider ids with a usable credential (auth.json or models.json key). */
  credentialed: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/** Load pi's configuration; absent files mean simply "nothing from pi". */
export function loadPiConfig(env: NodeJS.ProcessEnv = process.env): PiConfig {
  const dir = piAgentDir(env);
  const auth = existsSync(join(dir, "auth.json")) ? readPiAuth(dir) : {};
  const modelsJson = existsSync(join(dir, "models.json")) ? readPiModelsJson(dir) : {};
  const skipped: Array<{ id: string; reason: string }> = [];
  const customProviders = piCustomProviders(modelsJson, (id, reason) => skipped.push({ id, reason }));
  return {
    dir,
    auth,
    modelsJson,
    credentials: piCredentialStore(auth, modelsJson),
    customProviders,
    credentialed: credentialedProviders(auth, modelsJson),
    skipped,
  };
}


/**
 * Writable provider keys (policy gate #2, decided 0.0.46): the device may SET
 * or REMOVE an api_key entry in pi's OWN auth.json — write-only. The rules that
 * keep pi and the device from fighting over the file:
 *
 *   - values are never returned: the view carries a masked tail (`••••••••t123`)
 *     so an operator can confirm a rotation, nothing more;
 *   - pi's INTERACTIVE logins (oauth entries) are untouchable — a headless
 *     daemon must not clobber what `pi /login` established;
 *   - a corrupt auth.json is refused, not rewritten: the fix belongs to pi;
 *   - writes are atomic (tmp + rename, 0600) with a `.bak` of the previous
 *     file, and every OTHER entry survives byte-for-byte.
 */
export interface PiAuthEntry {
  providerId: string;
  type: string;
  source: "auth.json" | "models.json" | "both";
  /** `••••••••` + last 4 — the only form a value ever leaves the file in. */
  masked: string;
}

export function maskPiKey(key: string): string {
  return `••••••••${key.slice(-4)}`;
}

/** The write-only view: names, types, sources, masked tails — never values. */
export function piAuthView(auth: Record<string, Credential>, modelsJson: PiModelsJson): PiAuthEntry[] {
  const ids = [...new Set([...Object.keys(auth), ...Object.keys(modelsJson.providers ?? {})])].sort();
  return ids.map((providerId) => {
    const fromAuth = auth[providerId];
    const fromModels = modelsJson.providers?.[providerId]?.apiKey;
    const key: string | undefined =
      fromAuth?.type === "api_key" ? fromAuth.key : (fromModels ?? undefined);
    return {
      providerId,
      type: fromAuth?.type ?? "api_key",
      source: fromAuth && fromModels ? "both" : fromAuth ? "auth.json" : "models.json",
      masked: key ? maskPiKey(key) : "(none)",
    };
  });
}

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type PiConfigErrorCode = "invalid" | "not_found";

/** Typed failure so routes can answer 400 (`invalid`) or 404 (`not_found`)
 *  without string matching — a hostile provider id (path-traversal shape,
 *  spaces, unicode) is caller error, not a 500 with a stack. */
export class PiConfigError extends Error {
  readonly code: PiConfigErrorCode;

  constructor(code: PiConfigErrorCode, message: string) {
    super(message);
    this.name = "PiConfigError";
    this.code = code;
  }
}

/** Provider ids reach a filename key in pi's auth.json, so anything outside
 *  PROVIDER_ID — including `../` shapes, spaces and non-ASCII — is refused
 *  before any file is touched. */
function assertProviderId(providerId: string): void {
  if (!PROVIDER_ID.test(providerId))
    throw new PiConfigError(
      "invalid",
      `invalid provider id: ${JSON.stringify(providerId)} (use 1–64 characters of letters, digits, dot, dash or underscore)`,
    );
}

/** Read auth.json strictly: absent → {}, corrupt → REFUSE (pi owns the fix). */
function readAuthStrict(dir: string): Record<string, Credential> {
  const path = join(dir, "auth.json");
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw Error("auth.json is not valid JSON — fix it with pi, the device will not rewrite it");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("auth.json has an unexpected shape — fix it with pi, the device will not rewrite it");
  return parsed as Record<string, Credential>;
}

/** Atomic 0600 write with a `.bak` of the previous file (house registry style). */
function writeAuthAtomic(dir: string, next: Record<string, Credential>): void {
  const path = join(dir, "auth.json");
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tmp = join(dir, `auth.json.tmp-${process.pid}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Set one api_key. Refuses invalid ids, oversized keys, and oauth entries. */
export function writePiApiKey(dir: string, providerId: string, key: string): PiAuthEntry {
  assertProviderId(providerId);
  if (!key.trim() || key.length > 4096) throw Error("key must be 1–4096 non-whitespace characters");
  const auth = readAuthStrict(dir);
  const existing = auth[providerId];
  if (existing && existing.type !== "api_key")
    throw Error(`${providerId} uses an interactive pi login (${existing.type}) — edit it with pi, not here`);
  const credential: ApiKeyCredential = { type: "api_key", key };
  writeAuthAtomic(dir, { ...auth, [providerId]: credential });
  return { providerId, type: "api_key", source: existing ? "auth.json" : "auth.json", masked: maskPiKey(key) };
}

/** Remove one api_key entry. Same refusals; returns whether it existed. */
export function removePiApiKey(dir: string, providerId: string): boolean {
  assertProviderId(providerId);
  const auth = readAuthStrict(dir);
  const existing = auth[providerId];
  if (existing && existing.type !== "api_key")
    throw Error(`${providerId} uses an interactive pi login (${existing.type}) — edit it with pi, not here`);
  if (!existing) return false;
  const next = { ...auth };
  delete next[providerId];
  writeAuthAtomic(dir, next);
  return true;
}
