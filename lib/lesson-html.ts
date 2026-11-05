/**
 * The deliberately small HTML vocabulary a creator may preview in a lesson.
 * The result is still drawn in a sandboxed iframe (components/lesson-text.tsx):
 * this allowlist is defense in depth, not a substitute for the sandbox.
 */
const TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
]);

const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', "&quot;");

function safeHttpsHref(attributes: string): string | null {
  const match = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!value?.startsWith("https://")) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function safeTag(raw: string): string {
  const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)([\s\S]*?)>$/.exec(raw);
  if (!match) return "&lt;HTML&gt;";
  const closing = match[1] === "/";
  const tag = match[2].toLowerCase();
  const attributes = match[3];
  if (!TAGS.has(tag)) return `&lt;${closing ? "/" : ""}${tag}&gt;`;
  if (closing) return attributes.trim() ? `&lt;/${tag}&gt;` : `</${tag}>`;
  if (tag === "a") {
    const href = safeHttpsHref(attributes);
    return href ? `<a href="${escapeAttribute(href)}">` : "<a>";
  }
  return tag === "br" ? "<br>" : `<${tag}>`;
}

/**
 * Keep text and a small set of structural tags. Every supplied attribute is
 * discarded except an explicit HTTPS href. Unknown tags are shown as text,
 * with their attributes removed, so scripts, remote media, forms, CSS and
 * event handlers cannot become active or make a request.
 */
export function sanitizeLessonHtml(source: string): string {
  let out = "";
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf("<", at);
    if (open < 0) return out + escapeText(source.slice(at));
    out += escapeText(source.slice(at, open));
    const close = source.indexOf(">", open + 1);
    if (close < 0) return out + escapeText(source.slice(open));
    out += safeTag(source.slice(open, close + 1));
    at = close + 1;
  }
  return out;
}

/** A complete, self-contained document. All CSS is fixed product code. */
export function lessonHtmlDocument(source: string): string {
  const body = sanitizeLessonHtml(source);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width"><style>html{color-scheme:light dark}body{box-sizing:border-box;margin:0;padding:16px;font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}h1,h2,h3,h4,h5,h6{line-height:1.25}pre{overflow:auto;padding:12px}a{color:LinkText;text-decoration:underline}</style></head><body>${body}</body></html>`;
}
