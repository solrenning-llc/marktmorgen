/**
 * The automatic check of code an AI generates for a store, before it may be
 * published: 631 [AA1] (d), unit 4 (owner, 2 November 2026, 02h15 Fortaleza:
 * "É IMPORTANTE QUE A IA DO MEU SITE POSSA GERAR O CÓDIGO").
 *
 * The agent writes page blocks, interactive parts (a calculator, a quiz, a
 * comparison) and small store apps as HTML, CSS and JavaScript the creator
 * sees, edits and approves. What keeps a buyer safe is first where that code
 * runs: on a domain of its own for apps, apart from the studio, the checkout
 * and buyers' data, under a strict Content-Security-Policy, with no secret,
 * session or personal data in reach except through the API with the
 * permissions given (a later unit). This file is the second wall: it reads
 * the code itself and refuses, with the reason in the creator's words,
 *
 *   - anything loaded or sent from another address than the ones allowed
 *     (scripts, frames, styles, pictures, fonts, forms, connections), and
 *     any script that is not the code itself;
 *   - reaching out of its frame or into storage, cookies or saved passwords;
 *   - code that writes code (eval, Function, strings run as timers, HTML
 *     written from strings, inline handlers) and hidden code (atob,
 *     character codes, escaped text);
 *   - asking a visitor for a password, a card number, a card's security code
 *     or an identity number, with the same rules as a creator's forms (568
 *     [GD2] (c), lib/form-sensitive.ts), and pages that imitate signing in,
 *     a checkout or the Marktmorgen brand;
 *   - the accessibility faults that can be read from the code alone (AX274,
 *     WCAG 2.2 AAA): a picture without a text alternative, a field or button
 *     without a name, a focus order forced by tabindex, a hidden focus ring,
 *     justified text, zoom blocked, motion without a way to stop it,
 *     sound or video that starts by itself, anything that blinks.
 *
 * What only a rendered page can show (contrast of 7:1, targets of 44 by 44
 * pixels, reflow at 320 pixels and zoom to 400%, the keyboard order and the
 * names a screen reader hears while it runs) is listed in `notChecked`: a
 * pass here is never a pass of those, and publishing needs both (VR, AX274).
 *
 * Deliberately strict: a false refusal costs the creator one more request to
 * the agent; a false pass could cost a buyer their card. Pure: it reads text
 * and returns findings; nothing is fetched, run or published here.
 */
import { type SensitiveKind, SENSITIVE_WHY, sensitiveKindOf } from "@/lib/form-sensitive";

export type GeneratedCode = { html: string; css: string; js: string };

/** HTML, CSS and JavaScript together, at most this many bytes. */
export const GENERATED_CODE_MAX_BYTES = 200_000;

export type CodeRule =
  | "too_big"
  | "outside_load"
  | "outside_send"
  | "outside_script"
  | "frame_escape"
  | "storage"
  | "writes_code"
  | "hidden_code"
  | "sensitive_field"
  | "imitation"
  | "image_text"
  | "field_name"
  | "button_name"
  | "focus_order"
  | "focus_hidden"
  | "justified"
  | "zoom_blocked"
  | "motion"
  | "autoplay";

export type CodeFinding = { rule: CodeRule; why: string; at: string };

export type CodeCheck = {
  /** True only when nothing below was found: the static half of what publishing needs. */
  staticPass: boolean;
  findings: CodeFinding[];
  /** What this check cannot see, and a rendered check must. */
  notChecked: readonly string[];
};

export const NOT_CHECKED_HERE: readonly string[] = [
  "Text contrast of at least 7:1, and 3:1 for controls and graphics (WCAG 1.4.6, 1.4.11)",
  "Targets of at least 44 by 44 pixels (WCAG 2.5.5)",
  "Reflow at 320 pixels wide and zoom to 400% without losing anything (WCAG 1.4.10, 1.4.4)",
  "Keyboard order, no keyboard trap and a visible focus while it runs (WCAG 2.1.1, 2.1.2, 2.4.3, 2.4.13)",
  "Names, roles and states a screen reader announces while it runs (WCAG 4.1.2, 4.1.3)",
];

export const RULE_WHY: Readonly<Record<Exclude<CodeRule, "sensitive_field">, string>> = {
  too_big: `Generated code is kept under ${GENERATED_CODE_MAX_BYTES / 1000} KB, so it stays fast on a slow phone. Ask for a smaller version.`,
  outside_load: "It loads something from another website. Generated code may only use files from your store, so nothing outside can change it or watch your visitors.",
  outside_send: "It sends or receives data from another website. Generated code may only talk to your store.",
  outside_script: "It runs a script that is not part of the code you see. Every line that runs must be the code shown here.",
  frame_escape: "It reaches outside its own box on the page (the page around it, or the window that opened it). Generated code stays in its box.",
  storage: "It reads or keeps cookies, saved passwords or browser storage. Generated code never touches a visitor's sessions or saved data.",
  writes_code: "It builds and runs code from text, or writes HTML from text. That is how attacks get in; generated code uses fixed code and plain text instead.",
  hidden_code: "Part of it is hidden or encoded, so you could not read what it does. Every line must be readable.",
  imitation: "It looks like a sign-in page, a payment page or Marktmorgen itself. Pages that imitate these are how scams start, so they are never published.",
  image_text: "A picture has no text alternative (alt). Add one that says what the picture shows, or alt=\"\" if it is only decoration.",
  field_name: "A field has no name a screen reader can say. Give it a visible label.",
  button_name: "A button has no name a screen reader can say. Give it words.",
  focus_order: "It forces the order the keyboard moves in (tabindex above 0). Keep the order of the page instead.",
  focus_hidden: "It hides the outline that shows where the keyboard is, with no visible focus style to replace it.",
  justified: "Text is justified, which leaves uneven gaps that make reading harder. Align it to the left.",
  zoom_blocked: "It stops visitors from zooming in.",
  motion: "It moves or animates without respecting the visitor's setting to reduce motion, or blinks or scrolls by itself.",
  autoplay: "Sound or video starts by itself. Let the visitor press play.",
};

const sensitiveWhy = (what: SensitiveKind) => `${SENSITIVE_WHY[what].replace(/^A form never/, "Generated code never")}`;

const bytes = (text: string) => new TextEncoder().encode(text).length;

const excerpt = (text: string, index: number, length: number): string =>
  text
    .slice(Math.max(0, index - 20), index + Math.min(length, 60))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/** The few character references that matter for reading an attribute's real value. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

type Tag = { name: string; attrs: Map<string, string>; index: number; raw: string };

const TAG = /<([a-zA-Z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

export function tagsOf(html: string): Tag[] {
  const tags: Tag[] = [];
  for (const match of html.matchAll(TAG)) {
    const attrs = new Map<string, string>();
    for (const a of match[2].matchAll(ATTR)) attrs.set(a[1].toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
    tags.push({ name: match[1].toLowerCase(), attrs, index: match.index ?? 0, raw: match[0] });
  }
  return tags;
}

/** Whether a URL in a loading place points away from the store: another host, or a scheme that is not a plain file. */
export function outsideUrl(raw: string, allowedHosts: readonly string[]): boolean {
  // Browsers ignore control characters and spaces inside a scheme ("java\tscript:").
  const url = raw.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "");
  if (!url || url.startsWith("#")) return false;
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(url)) return false;
  const host = url.match(/^(?:(?:https?|wss?):)?\/\/([^/?#:@]+)(?::\d+)?(?:[/?#]|$)/i);
  if (host) return !allowedHosts.map((h) => h.toLowerCase()).includes(host[1].toLowerCase());
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return true;
  // A relative address on the apps domain itself ("/files/a.png", "a.png", "./a.png"); "\\host" reads as "//host" to browsers.
  return url.startsWith("\\") || url.startsWith("/\\");
}

const LOAD_ATTRS: Readonly<Record<string, readonly string[]>> = {
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src", "formaction"],
  button: ["formaction"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
  form: ["action"],
};

const NEVER_TAGS = new Set(["iframe", "frame", "frameset", "object", "embed", "applet", "portal", "base", "meta"]);

const JS_RULES: readonly [CodeRule, RegExp][] = [
  ["outside_script", /\bimport\s*\(|\bimport\s+[\w{*][^;]*?\bfrom\s*["'`]|\bimport\s*["'`]|\bimportScripts\s*\(|createElement\s*\(\s*["'`]script["'`]|\bnew\s+Worker\s*\(|\bnew\s+SharedWorker\s*\(|serviceWorker/],
  ["outside_send", /\bnew\s+WebSocket\s*\(|\bnew\s+EventSource\s*\(|\bsendBeacon\s*\(|\bRTCPeerConnection\b|\bwindow\.open\s*\(/],
  ["frame_escape", /(?<![\w.$])(?:(?:window|self|globalThis)\s*\.\s*)?(?:top|parent|opener)\s*(?:\.|\[)|\bdocument\.domain\b|\bframeElement\b/],
  ["storage", /\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bnavigator\.credentials\b|\bcaches\s*\.|\bcookieStore\b/],
  ["writes_code", /\beval\s*\(|\bnew\s+Function\s*\(|(?<![\w.$])Function\s*\(|\bset(?:Timeout|Interval)\s*\(\s*["'`]|\.(?:inner|outer)HTML\s*[+]?=|\binsertAdjacentHTML\s*\(|\bdocument\.write(?:ln)?\s*\(|\bcreateContextualFragment\s*\(|\bDOMParser\b|\bsrcdoc\b/],
  ["hidden_code", /\batob\s*\(|\bfromCharCode\s*\(|\bfromCodePoint\s*\(|\bunescape\s*\(|\\x[0-9a-fA-F]{2}|\\u\{?[0-9a-fA-F]{2,}/],
  ["sensitive_field", /\.type\s*=\s*["'`]password["'`]|["'`]type["'`]\s*,\s*["'`]password["'`]|autocomplete\s*=\s*["'`](?:cc-|current-password|new-password)/],
];

/**
 * Whether the written start of an address already decides that it stays on the store, whatever is joined after
 * it: a path ("/api/…", "./…", "../…"), or an allowed host closed by a "/" ("https://host/…"). An empty start
 * ("" + base, `${base}…`) or "/" alone ("/" + "/other.site") decides nothing, so it is refused.
 */
function safeStart(start: string, allowedHosts: readonly string[]): boolean {
  if (/^\/[^/\\]/.test(start) || start.startsWith("./") || start.startsWith("../")) return true;
  const absolute = start.match(/^https:\/\/([^/?#:@\\]+)(?::\d+)?\//i);
  return absolute !== null && allowedHosts.map((h) => h.toLowerCase()).includes(absolute[1].toLowerCase());
}

/** fetch() and XMLHttpRequest may only reach the store: a relative address, or an allowed host, written out in the code. */
function sendsOutside(js: string, allowedHosts: readonly string[]): { index: number; length: number } | null {
  for (const call of js.matchAll(/\bfetch\s*\(\s*|\.open\s*\(\s*["'`][A-Za-z]+["'`]\s*,\s*|\bnew\s+XMLHttpRequest\b/g)) {
    if (call[0].startsWith("new")) continue; // the request object itself; its .open(...) is checked
    const rest = js.slice((call.index ?? 0) + call[0].length);
    const literal = rest.match(/^(["'`])((?:(?!\1)[^\\$]|\\.)*?)(?:\1|\$\{)/);
    if (!literal || !safeStart(literal[2], allowedHosts)) return { index: call.index ?? 0, length: call[0].length + (literal?.[0].length ?? 20) };
  }
  return null;
}

const IMITATION = /\bmarkt\s*morgen\b|\bnimbus\s*labs\b|\b(?:secure\s+checkout|payment\s+details|billing\s+details|card\s+details|verify\s+your\s+(?:account|identity|payment)|confirm\s+your\s+(?:account|password|card|payment)|(?:sign|log)\s+in\s+to\s+(?:your\s+)?(?:account|stripe|paypal|google|apple|facebook|instagram))\b/i;

const MOTION_CSS = /@keyframes\b|\banimation(?:-name)?\s*:|\btransition\s*:|\bscroll-behavior\s*:\s*smooth/i;
const REDUCED = /prefers-reduced-motion/i;

const textOf = (html: string) => decodeEntities(html.replace(/<script\b[\s\S]*?(?:<\/script\b[^>]*>|$)|<style\b[\s\S]*?(?:<\/style\b[^>]*>|$)/gi, " ").replace(/<[^>]+>/g, " "));

/** Checks generated code; `allowedHosts` are the only other addresses it may load from or talk to (none by default). */
export function checkGeneratedCode(code: GeneratedCode, options: { allowedHosts?: readonly string[] } = {}): CodeCheck {
  const allowed = options.allowedHosts ?? [];
  const findings: CodeFinding[] = [];
  const seen = new Set<string>();
  const add = (rule: CodeRule, text: string, index: number, length: number, why?: string) => {
    const at = excerpt(text, index, length);
    const key = `${rule}|${at}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, why: why ?? RULE_WHY[rule as Exclude<CodeRule, "sensitive_field">], at });
  };

  const total = bytes(code.html) + bytes(code.css) + bytes(code.js);
  if (total > GENERATED_CODE_MAX_BYTES) {
    add("too_big", `${total} bytes`, 0, 20);
    return { staticPass: false, findings, notChecked: NOT_CHECKED_HERE };
  }

  const html = code.html;
  const tags = tagsOf(html);
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)(?:<\/script\b[^>]*>|$)/gi)];
  const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\b[^>]*>|$)/gi)].map((m) => m[1]);
  const handlers: string[] = [];
  const styleAttrs: string[] = [];

  // HTML: what loads, what runs, what is asked.
  const labelled = new Set(tags.filter((t) => t.name === "label" && t.attrs.get("for")).map((t) => t.attrs.get("for")!));
  const insideLabels = [...html.matchAll(/<label\b[\s\S]*?<\/label\b[^>]*>/gi)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
  for (const tag of tags) {
    const { name, attrs, index, raw } = tag;
    if (name === "script") {
      if (attrs.has("src") || attrs.has("href") || attrs.has("xlink:href")) add("outside_script", html, index, raw.length);
      const type = (attrs.get("type") ?? "").toLowerCase();
      if (type && !["module", "text/javascript", "application/javascript"].includes(type)) add("outside_script", html, index, raw.length);
      continue;
    }
    if (NEVER_TAGS.has(name)) {
      if (name === "meta") {
        const content = (attrs.get("content") ?? "").toLowerCase();
        if ((attrs.get("http-equiv") ?? "").toLowerCase() === "refresh") add("frame_escape", html, index, raw.length);
        if (/user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*(?:1(?:\.0*)?|0?\.\d+)(?![\d.])/.test(content)) add("zoom_blocked", html, index, raw.length);
        continue;
      }
      add(name === "base" ? "frame_escape" : "outside_load", html, index, raw.length);
      continue;
    }
    if (name === "link") {
      add("outside_load", html, index, raw.length);
      continue;
    }
    if (name === "marquee" || name === "blink") add("motion", html, index, raw.length);
    for (const attr of LOAD_ATTRS[name] ?? []) {
      const value = attrs.get(attr);
      if (value === undefined) continue;
      const urls = attr === "srcset" ? value.split(",").map((part) => part.trim().split(/\s+/)[0]) : [value];
      if (urls.some((u) => outsideUrl(u, allowed))) add(name === "form" || attr === "formaction" ? "outside_send" : "outside_load", html, index, raw.length);
    }
    for (const [attr, value] of attrs) {
      if (attr.startsWith("on")) handlers.push(value);
      if (attr === "style") styleAttrs.push(value);
      if (attr === "srcdoc") add("writes_code", html, index, raw.length);
      if (attr === "tabindex" && Number(value) > 0) add("focus_order", html, index, raw.length);
      if ((attr === "href" || attr === "xlink:href" || attr === "action" || attr === "formaction" || attr === "src") && /^javascript:/i.test(value.replace(/[\u0000-\u001f\u007f\s]+/g, ""))) add("writes_code", html, index, raw.length);
    }
    if (name === "a" && /^(?:data|vbscript):/i.test((attrs.get("href") ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, ""))) add("writes_code", html, index, raw.length);
    if ((name === "video" || name === "audio") && attrs.has("autoplay")) add("autoplay", html, index, raw.length);
    if (name === "img" && !attrs.has("alt")) add("image_text", html, index, raw.length);
    if (name === "input" || name === "select" || name === "textarea") {
      const type = (attrs.get("type") ?? "text").toLowerCase();
      if (type === "password") add("sensitive_field", html, index, raw.length, sensitiveWhy("password"));
      const auto = (attrs.get("autocomplete") ?? "").toLowerCase();
      if (/\bcc-|current-password|new-password/.test(auto)) add("sensitive_field", html, index, raw.length, sensitiveWhy(/password/.test(auto) ? "password" : /csc/.test(auto) ? "code" : "card"));
      for (const words of [attrs.get("placeholder"), attrs.get("aria-label"), attrs.get("name"), attrs.get("id"), attrs.get("title")]) {
        const what = words ? sensitiveKindOf(words.replace(/[-_]+/g, " ")) : null;
        if (what) add("sensitive_field", html, index, raw.length, sensitiveWhy(what));
      }
      if (type !== "hidden" && type !== "submit" && type !== "button" && type !== "reset" && type !== "image") {
        const id = attrs.get("id");
        const named = attrs.has("aria-label") || attrs.has("aria-labelledby") || attrs.has("title") || (id !== undefined && labelled.has(id)) || insideLabels.some(([from, to]) => index > from && index < to);
        if (!named) add("field_name", html, index, raw.length);
      }
    }
  }
  for (const match of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label\b[^>]*>/gi)) {
    const what = sensitiveKindOf(textOf(match[1]));
    if (what) add("sensitive_field", html, match.index ?? 0, match[0].length, sensitiveWhy(what));
  }
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button\b[^>]*>/gi)) {
    const attrs = tagsOf(`<button${match[1]}>`)[0]?.attrs ?? new Map<string, string>();
    const words = textOf(match[2]).trim() || [...match[2].matchAll(/<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).join(" ").trim();
    if (!words && !attrs.has("aria-label") && !attrs.has("aria-labelledby") && !attrs.has("title")) add("button_name", html, match.index ?? 0, match[0].length);
  }
  const pageText = textOf(html);
  const imitation = pageText.match(IMITATION);
  if (imitation) add("imitation", pageText, imitation.index ?? 0, imitation[0].length);

  // JavaScript: the file, the inline scripts and the inline handlers.
  const scripts = [code.js, ...inlineScripts.map((m) => m[2]), ...handlers];
  if (handlers.length) add("writes_code", handlers[0], 0, handlers[0].length, "It runs code from attributes such as onclick, which a strict security policy blocks. Use addEventListener in the script instead.");
  for (const js of scripts) {
    if (!js.trim()) continue;
    for (const [rule, pattern] of JS_RULES) {
      const found = js.match(pattern);
      if (found) add(rule, js, found.index ?? 0, found[0].length, rule === "sensitive_field" ? sensitiveWhy("password") : undefined);
    }
    const out = sendsOutside(js, allowed);
    if (out) add("outside_send", js, out.index, out.length);
    for (const literal of js.matchAll(/(["'`])((?:https?:|wss?:)?\/\/[^"'`\s]+)\1/gi)) {
      if (outsideUrl(literal[2], allowed)) add("outside_load", js, literal.index ?? 0, literal[0].length);
    }
    const said = js.match(IMITATION);
    if (said) add("imitation", js, said.index ?? 0, said[0].length);
    if (/\brequestAnimationFrame\s*\(|\.animate\s*\(/.test(js) && !REDUCED.test(js)) {
      const found = js.match(/\brequestAnimationFrame\s*\(|\.animate\s*\(/)!;
      add("motion", js, found.index ?? 0, found[0].length);
    }
    const autoplay = js.match(/\.autoplay\s*=\s*true|\.play\s*\(\s*\)/);
    if (autoplay && !/addEventListener\s*\(\s*["'`]click["'`]/.test(js)) add("autoplay", js, autoplay.index ?? 0, autoplay[0].length);
  }

  // CSS: the file, the style elements and the style attributes.
  const styles = [code.css, ...inlineStyles, ...styleAttrs];
  const allCss = styles.join("\n");
  for (const css of styles) {
    if (!css.trim()) continue;
    for (const match of css.matchAll(/@import\b[^;]*;?/gi)) add("outside_load", css, match.index ?? 0, match[0].length);
    for (const match of css.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)) {
      if (outsideUrl(decodeEntities(match[2]), allowed)) add("outside_load", css, match.index ?? 0, match[0].length);
    }
    const justified = css.match(/text-align\s*:\s*justify/i);
    if (justified) add("justified", css, justified.index ?? 0, justified[0].length);
    const motion = css.match(MOTION_CSS);
    if (motion && !REDUCED.test(allCss)) add("motion", css, motion.index ?? 0, motion[0].length);
    const hidden = css.match(/outline\s*:\s*(?:none|0)\b/i);
    if (hidden && !/:focus(?:-visible)?\b[^{]*\{[^}]*(?:outline\s*:\s*(?!none|0\b)|box-shadow\s*:|border)/i.test(allCss)) add("focus_hidden", css, hidden.index ?? 0, hidden[0].length);
    const blink = css.match(/text-decoration[^;]*\bblink\b/i);
    if (blink) add("motion", css, blink.index ?? 0, blink[0].length);
  }

  return { staticPass: findings.length === 0, findings, notChecked: NOT_CHECKED_HERE };
}
