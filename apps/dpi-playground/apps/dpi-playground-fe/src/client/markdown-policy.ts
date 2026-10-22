// What survives sanitising of transcript markdown. The text is written by a device or by an agent
// a device can prompt-inject, and it is rendered inside the admin origin: anything beyond the
// markdown subset (styles, forms, overlays, remote images) is an injection or phishing surface.

export const ALLOWED_TAGS = [
  "p", "br", "hr", "strong", "b", "em", "i", "del", "s", "code", "pre", "blockquote",
  "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6", "small", "sub", "sup",
  "table", "thead", "tbody", "tr", "th", "td", "img",
  // Only the disabled GFM task-list checkbox; anything else is removed by the attribute policy.
  "input",
];

export const FORBIDDEN_TAGS = [
  "form", "style", "script", "button", "select", "textarea", "iframe", "object", "embed", "svg", "math",
];

const ATTRIBUTES: Record<string, readonly string[]> = {
  a: ["href", "title"],
  img: ["src", "alt", "title"],
  th: ["colspan", "rowspan", "align"],
  td: ["colspan", "rowspan", "align"],
  ol: ["start"],
  code: ["class"],
  input: ["type", "checked", "disabled"],
};

export const ALLOWED_ATTR = [...new Set(Object.values(ATTRIBUTES).flat())];

const CODE_CLASS = /^language-[\w-]+$/;
const DIGITS = /^\d{1,4}$/;
const ALIGN = /^(left|right|center)$/i;

export function attributeAllowed(tag: string, name: string, value: string): boolean {
  if (!Object.hasOwn(ATTRIBUTES, tag) || !ATTRIBUTES[tag].includes(name)) return false;
  switch (name) {
    case "class":
      return CODE_CLASS.test(value);
    case "type":
      return value.toLowerCase() === "checkbox";
    case "colspan":
    case "rowspan":
    case "start":
      return DIGITS.test(value);
    case "align":
      return ALIGN.test(value);
    default:
      return true;
  }
}

const RASTER_DATA_URI = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i;

// Express matches routes case-insensitively, so /API/... reaches the same handlers.
const ADMIN_API_PATH = /^\/api(\/|$)/i;

/**
 * A remote image is a tracking channel: agent output can encode data in its URL. Only an image
 * served by the hub's static files or embedded in the text is kept; the admin API is not an
 * image host. The WHATWG parser decides what a browser would request, so tab, backslash, `//`
 * and dot-segment tricks resolve to their real origin and path.
 */
export function isSafeImageSrc(src: string, hubOrigin: string): boolean {
  if (RASTER_DATA_URI.test(src)) return true;
  if (!src.trim()) return false;
  let url: URL;
  try {
    url = new URL(src, hubOrigin);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.origin === hubOrigin &&
    !ADMIN_API_PATH.test(url.pathname)
  );
}
