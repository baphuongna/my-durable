import { marked } from "marked";
import DOMPurify from "dompurify";
import { externalHref } from "./link-policy";
import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  FORBIDDEN_TAGS,
  attributeAllowed,
  isSafeImageSrc,
} from "./markdown-policy";

// DOMPurify only exists with a DOM; SSR and unit tests import this module without one.
if (DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const tag = node.nodeName.toLowerCase();
    // The tag allowlist is global; which attributes an element may keep is decided per element.
    for (const { name, value } of Array.from(node.attributes))
      if (!attributeAllowed(tag, name, value)) node.removeAttribute(name);
    if (tag === "img" && !isSafeImageSrc(node.getAttribute("src") ?? "", location.origin)) {
      node.replaceWith(document.createTextNode(node.getAttribute("alt") ?? ""));
      return;
    }
    if (tag === "input") {
      if (node.getAttribute("type") === null) node.remove();
      else node.setAttribute("disabled", "");
      return;
    }
    if (tag !== "a") return;
    const href = node.getAttribute("href");
    const safe = href === null ? null : externalHref(href, location.origin);
    if (safe) {
      node.setAttribute("href", safe);
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    } else {
      node.removeAttribute("href");
      node.removeAttribute("target");
    }
  });
}

const SANITIZE = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  FORBID_TAGS: FORBIDDEN_TAGS,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

// Transcripts re-render on every stream frame; cache rendered blocks by their source text.
const cache = new Map<string, string>();
export function markdown(text: string) {
  let html = cache.get(text);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, SANITIZE);
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
    cache.set(text, html);
  }
  return html;
}
