/**
 * Bounded, sanitized log collector for child processes.
 * Redacts every credential shape before anything is stored or printed:
 * dpi_/dpt_ tokens, pairing codes, PEM private keys. Failure output never
 * contains raw secrets beyond fake fixtures.
 */
export class BoundedLog {
  private lines: string[] = [];
  constructor(
    readonly name: string,
    private readonly maxLines = 500,
  ) {}

  push(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line === "") continue;
      if (this.lines.length >= this.maxLines) this.lines.shift();
      this.lines.push(sanitize(line));
    }
  }

  tail(n = 40): string {
    return this.lines.slice(-n).join("\n");
  }

  get size(): number {
    return this.lines.length;
  }
}

const TOKEN_PATTERERS: [RegExp, string][] = [
  [/\bdpi_[A-Za-z0-9_-]{43}\b/g, "dpi_<redacted>"],
  [/\bdpt_[A-Za-z0-9_-]{43}\b/g, "dpt_<redacted>"],
  [/\badm_[A-Za-z0-9_-]{32,}\b/g, "adm_<redacted>"],
  [/\bcode[=:"'\s]+((?:[A-Z2-7]{12}|[A-Z2-7]{8}))\b/g, "code=<redacted>"],
  // v2 offer links: the whole handoff rides the fragment — never let it reach test output.
  [/#offer=[A-Za-z0-9_-]+/g, "#offer=<redacted>"],
  // A minted code is a canonical UUID v4: the base32 pattern above cannot see it.
  [
    /\bcode[=:"'\s]+([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/gi,
    "code=<redacted>",
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "<private key redacted>",
  ],
  [/Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi, "Authorization: Bearer <redacted>"],
];

export function sanitize(text: string): string {
  let out = text;
  for (const [re, replacement] of TOKEN_PATTERERS) out = out.replace(re, replacement);
  return out;
}
