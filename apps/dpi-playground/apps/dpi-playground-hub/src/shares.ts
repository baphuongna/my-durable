/**
 * Conversation shares (Wave 3 SHOULD of docs/host-project-checklist.md, the
 * zcode conversation-share idea on top of our 1b export surface): the operator
 * uploads a prepared transcript (title + per-agent markdown) and gets back a
 * tokenized public URL. The token IS the capability — the page is public, so
 * retention is explicit: every share expires (7 days by default), an expired
 * share is refused and swept, and the admin API can kill one early.
 *
 * The hub never talks to devices for this: the shell (which already holds the
 * tunnel credentials) fetches the transcripts and POSTs them here.
 *
 * Node builtins only; `now` and the fs go through injectable options so tests
 * never sleep or touch the real filesystem.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A shared transcript is read-only text; this is not a file drop. */
export const MAX_AGENTS = 20;
export const MAX_MARKDOWN_CHARS = 2 * 1024 * 1024;
export const MAX_TOTAL_CHARS = 8 * 1024 * 1024;
export const MAX_TITLE_CHARS = 200;
/** zcode decides retention per instance; we ship one honest default. */
export const DEFAULT_TTL_DAYS = 7;

export interface ShareAgent {
  name: string;
  markdown: string;
}

export interface ShareMeta {
  token: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  bytes: number;
}

export interface ShareDocument {
  meta: ShareMeta;
  agents: ShareAgent[];
}

export type ShareErrorCode = "invalid";

export class ShareError extends Error {
  readonly code: ShareErrorCode;

  constructor(message: string) {
    super(message);
    this.name = "ShareError";
    this.code = "invalid";
  }
}

export interface SharesIo {
  mkdir(path: string, mode?: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** stat is optional: existence probes use readFile's failure instead. */
  writeFile(path: string, data: string, mode?: number): Promise<void>;
  rm(path: string, options: { recursive: boolean }): Promise<void>;
  now(): number;
}

export const defaultSharesIo = (): SharesIo => ({
  mkdir: async (p, mode) => {
    await mkdir(p, { recursive: true, ...(mode ? { mode } : {}) });
  },
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, "utf8"),
  writeFile: async (p, d, mode) => {
    await writeFile(p, d, { mode: mode ?? 0o600 });
  },
  rm: async (p, o) => {
    await rm(p, o);
  },
  now: () => Date.now(),
});

const invalid = (message: string) => new ShareError(message);

const isToken = (value: string) => /^[A-Za-z0-9_-]{20,32}$/.test(value);

export class Shares {
  private constructor(
    private readonly dir: string,
    private readonly io: SharesIo,
    private readonly ttlDays: number,
  ) {}

  static async open(dir: string, options: { io?: SharesIo; ttlDays?: number } = {}): Promise<Shares> {
    const io = options.io ?? defaultSharesIo();
    await io.mkdir(dir, 0o700);
    return new Shares(dir, io, options.ttlDays ?? DEFAULT_TTL_DAYS);
  }

  /** Create a share. Expired siblings are swept first — creation is the idle-time GC. */
  async create(input: { title: string; agents: ShareAgent[] }): Promise<ShareMeta> {
    const title = input.title.trim();
    if (!title) throw invalid("a title is required");
    if (title.length > MAX_TITLE_CHARS) throw invalid(`the title is longer than ${MAX_TITLE_CHARS} characters`);
    if (!Array.isArray(input.agents) || input.agents.length === 0) throw invalid("at least one agent transcript is required");
    if (input.agents.length > MAX_AGENTS) throw invalid(`at most ${MAX_AGENTS} agent transcripts per share`);
    let total = 0;
    for (const agent of input.agents) {
      if (!agent || typeof agent.name !== "string" || !agent.name.trim()) throw invalid("every transcript needs a name");
      if (typeof agent.markdown !== "string") throw invalid(`the transcript for ${agent.name} is not text`);
      if (agent.markdown.length > MAX_MARKDOWN_CHARS)
        throw invalid(`the transcript for ${agent.name} is larger than ${MAX_MARKDOWN_CHARS} characters`);
      total += agent.markdown.length;
    }
    if (total > MAX_TOTAL_CHARS) throw invalid(`the share is larger than ${MAX_TOTAL_CHARS} characters`);

    await this.sweep();
    const now = this.io.now();
    const meta: ShareMeta = {
      token: randomBytes(18).toString("base64url"),
      title,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlDays * 24 * 3600_000).toISOString(),
      bytes: total,
    };
    const target = join(this.dir, meta.token);
    await this.io.mkdir(target, 0o700);
    await this.io.writeFile(join(target, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, 0o600);
    await this.io.writeFile(
      join(target, "page.json"),
      `${JSON.stringify({ agents: input.agents }, null, 2)}\n`,
      0o600,
    );
    return meta;
  }

  /** Read a live share. Expired or unknown → undefined (the page is public: never explain which). */
  async get(token: string): Promise<ShareDocument | undefined> {
    if (!isToken(token)) return undefined;
    const target = join(this.dir, token);
    try {
      const [metaRaw, pageRaw] = await Promise.all([
        this.io.readFile(join(target, "meta.json")),
        this.io.readFile(join(target, "page.json")),
      ]);
      const meta = JSON.parse(metaRaw) as ShareMeta;
      const page = JSON.parse(pageRaw) as { agents: ShareAgent[] };
      if (Date.parse(meta.expiresAt) <= this.io.now()) {
        await this.sweep();
        return undefined;
      }
      return { meta, agents: page.agents };
    } catch {
      return undefined;
    }
  }

  /** The admin list, newest first. */
  async list(): Promise<ShareMeta[]> {
    await this.sweep();
    const out: ShareMeta[] = [];
    for (const entry of await this.io.readdir(this.dir).catch(() => [])) {
      if (!isToken(entry)) continue;
      try {
        out.push(JSON.parse(await this.io.readFile(join(this.dir, entry, "meta.json"))) as ShareMeta);
      } catch {
        /* a half-written dir is not the list's problem */
      }
    }
    return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /** Kill a share early (the "remove link" button). */
  async remove(token: string): Promise<boolean> {
    if (!isToken(token)) return false;
    try {
      await this.io.rm(join(this.dir, token), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Delete every expired share dir. Returns how many. */
  async sweep(): Promise<number> {
    let removed = 0;
    for (const entry of await this.io.readdir(this.dir).catch(() => [])) {
      if (!isToken(entry)) continue;
      try {
        const meta = JSON.parse(await this.io.readFile(join(this.dir, entry, "meta.json"))) as ShareMeta;
        if (Date.parse(meta.expiresAt) <= this.io.now()) {
          await this.io.rm(join(this.dir, entry), { recursive: true });
          removed += 1;
        }
      } catch {
        /* unreadable dir: leave it; rm-ing unknown junk is not sweep's job */
      }
    }
    return removed;
  }
}

// ------------------------------------------------------------ public page
// Rendered server-side: the share page is public and must not load the app
// shell (which holds credentials), any script, or any external asset.

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PAGE_STYLE = `:root{color-scheme:dark}body{margin:0;background:#16181d;color:#e6e6e6;font:16px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:52rem;margin:0 auto;padding:2rem 1rem}h1{font-size:1.3rem;margin:0 0 .25rem}
.meta{color:#9aa0aa;font-size:.85rem;margin-bottom:1.5rem}
details{border:1px solid #2a2d34;border-radius:10px;margin:.75rem 0;background:#1b1e24}
summary{padding:.6rem .9rem;cursor:pointer;font-weight:600}
pre{margin:0;padding:0 1rem 1rem;white-space:pre-wrap;word-break:break-word;font:13.5px/1.55 ui-monospace,monospace;color:#cfd3da}
footer{color:#7c828c;font-size:.8rem;margin-top:2rem}`;

/** The public share page: transcripts only, inline-styled, zero scripts. */
export function renderSharePage(doc: ShareDocument): string {
  const agents = doc.agents
    .map(
      (agent, i) =>
        `<details${i === 0 ? " open" : ""}><summary>${escapeHtml(agent.name)}</summary><pre>${escapeHtml(agent.markdown)}</pre></details>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(doc.meta.title)}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${escapeHtml(doc.meta.title)}</h1>
<p class="meta">Shared ${escapeHtml(doc.meta.createdAt.slice(0, 16).replace("T", " "))} · expires ${escapeHtml(doc.meta.expiresAt.slice(0, 16).replace("T", " "))} · read-only</p>
${agents}
<footer>Shared from a durable-pi device. The link stops working when the share expires.</footer>
</main></body></html>`;
}

/** A public 404 that never says whether the token ever existed. */
export function renderShareNotFound(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>No such share</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>No such share</h1><p class="meta">The link is wrong, or the share expired.</p></main></body></html>`;
}
