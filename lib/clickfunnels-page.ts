/**
 * Moving from ClickFunnels, the page half (added 17 October 2026): one of a
 * creator's own published funnel pages, saved from their browser, read into
 * this platform's own blocks.
 *
 * ClickFunnels has no file export for a funnel or a page: its "share" link
 * copies a funnel into another ClickFunnels account and nowhere else (see
 * docs/clickfunnels-import.md). What a creator always has is their own page,
 * published at their own address, which any browser saves as an HTML file
 * ("Save Page As", web page, HTML only). That file is what this reads, and
 * only that file: nothing here signs in to ClickFunnels, fetches a page,
 * follows a link or loads a picture.
 *
 * What comes across is the creator's words, never ClickFunnels' code:
 *
 *   headings     the first one is the page's big headline, the rest start sections
 *   paragraphs   and list items, under the heading before them
 *   buttons      a button block, with the button's words; where it leads is
 *                this platform's to decide (the funnel's next step, or the
 *                product chosen for the page)
 *   videos       YouTube, Vimeo and Loom, rebuilt from their id (lib/sales-page.ts)
 *   a form       its questions (email, short and long answers) and its button's words
 *   a checkbox   at checkout, the order bump's words, to be offered here as a
 *                box at checkout for a product the creator picks
 *
 * Everything else is listed as not brought over, with what it was and how
 * many: scripts and tracking, styles and layout, pictures (they are files on
 * ClickFunnels' servers, and a picture here is one the creator uploads), other
 * video players and embeds, payment and address fields (a product's own
 * checkout asks for those), consent checkboxes (this platform's forms and
 * checkout ask for consent themselves), countdown timers (a countdown here
 * runs to one real moment the creator sets), menus and footers, and anything
 * past what one page holds. A text too long for its place is shortened at a
 * word, and the page says so with the whole text, before anything is saved.
 *
 * The same words appearing twice (pages often carry a phone and a computer
 * copy of each section) are kept once.
 *
 * Pure and browser-safe: the studio trims a file before sending it
 * (trimSavedPage), and the server reads what arrives itself.
 */
import {
  MAX_BLOCKS,
  MAX_CTA_LABEL,
  MAX_CTA_NOTE,
  MAX_HEADING,
  MAX_HEADLINE,
  MAX_SUBHEADLINE,
  MAX_TEXT,
  type PageBlock,
  oversized,
  parsePage,
  readVideo,
} from "@/lib/sales-page";
import { MAX_BUTTON, MAX_FIELDS, MAX_LABEL } from "@/lib/forms";
import { MAX_SITE_TITLE } from "@/lib/site-page-rules";
import { MAX_HEADLINE_LENGTH, MAX_STEP_TEXT_LENGTH } from "@/lib/funnel";
import { MAX_PITCH_LENGTH } from "@/lib/product-extras";
import { MAX_SAVED_PICTURES, type SavedPicture, savedPictureRef } from "@/lib/clickfunnels-pictures";

/** The biggest file the studio reads, as it is on the creator's computer. */
export const MAX_SAVED_PAGE_BYTES = 15 * 1024 * 1024;
/** The most of a page, once trimmed, that is sent and read: a page's words fit many times over. */
export const MAX_TRIMMED_PAGE_CHARS = 1_500_000;
/** Button blocks on one imported page: a long page repeats the same button many times. */
export const MAX_IMPORTED_BUTTONS = 3;
/** Order bump boxes a product can carry (lib/product-extras.ts, MAX_BUMPS). */
export const MAX_IMPORTED_BUMPS = 3;

export type FormFieldSpec = { type: "short" | "long" | "email"; label: string; required: boolean };
export type FormSpec = { fields: FormFieldSpec[]; button: string };
export type BumpSpec = { pitch: string };

/** One kind of thing that was not brought over, and how many. */
export type DroppedItem = { what: DroppedKind; count: number; examples: string[] };

export type DroppedKind =
  | "scripts"
  | "tracking"
  | "styles"
  | "pictures"
  | "embeds"
  | "links"
  | "payment"
  | "consent"
  | "questions"
  | "countdown"
  | "menus"
  | "forms"
  | "buttons"
  | "repeats"
  | "overflow"
  | "shortened";

/** What each kind of dropped thing is, said to the creator. */
export const DROPPED_WORDS: Record<DroppedKind, string> = {
  scripts: "Scripts and custom code: never carried over. This platform's pages run only their own code.",
  tracking: "Tracking pixels and analytics tags: not carried over. Your store has its own numbers, and you can add your own pixels under Integrations.",
  styles: "Styles, fonts and layout: your store's own look is used instead.",
  pictures: "Pictures: not copied, because they are files on ClickFunnels' servers. Upload yours to the page from the page editor.",
  embeds: "Embedded frames and players other than YouTube, Vimeo and Loom.",
  links: "Links inside the text: the words are kept, the addresses are not. Buttons lead to your funnel's next step or to the product you choose.",
  payment: "Payment, billing and address fields: your product's own checkout asks for those.",
  consent: "Consent and terms checkboxes: this platform's forms and checkout ask for consent themselves.",
  questions: "Checkbox, choice and other questions the form had: add them to the form under Forms if you need them.",
  countdown: "Countdown timers: a countdown here runs to one real date you set, the same for every visitor. Add one from the page editor if you have a real deadline.",
  menus: "The page's menu and footer: your store's own menu and footer are shown instead.",
  forms: "More than one form on the page: the first is brought over.",
  buttons: `More than ${MAX_IMPORTED_BUTTONS} different buttons: the first ${MAX_IMPORTED_BUTTONS} are brought over.`,
  repeats: "Words that appeared twice (pages often carry a phone and a computer copy of the same section): kept once.",
  overflow: `Sections past the ${MAX_BLOCKS} blocks one page holds.`,
  shortened: "Shortened to fit at a word; the whole text is shown here so you can put it back where it fits.",
};

export type PageDraft = {
  /** The page's name in the studio, from the file's title or its headline. */
  title: string;
  /** Hero, text, video, button and form blocks, as a store's own page keeps them. The form block's form is made at import. */
  blocks: PageBlock[];
  /** The form the page asked, or null. */
  form: FormSpec | null;
  /** Checkboxes that read as an order bump, at most three. */
  bumps: BumpSpec[];
  /** Whether the page asked for payment: a checkout, in ClickFunnels' words an order form. */
  checkout: boolean;
  /** The page as an offer after paying, should the creator say it is one: its headline and first lines. */
  offer: { headline: string; text: string };
  dropped: DroppedItem[];
  /** What was found, for the summary. */
  found: { headings: number; paragraphs: number; buttons: number; videos: number; pictures: number; forms: number; scripts: number };
  /** Each picture, by its path in the saved page's own folder (null when it is only an address elsewhere), at most MAX_SAVED_PICTURES (394 [CX5]). */
  pictures: SavedPicture[];
};

// ---- Trimming, in the browser --------------------------------------------------

/**
 * A saved page made small enough to send: the insides of scripts, styles,
 * drawings and comments emptied (their tags stay, so they are still counted),
 * and pictures written into the file (data: addresses) cut to their kind.
 * Reading the trimmed page gives the same result as reading the whole one.
 */
export function trimSavedPage(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg|noscript|template)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, (_, name: string, attrs: string) => `<${name}${attrs}></${name}>`)
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+(;[a-z0-9=._-]+)*,[A-Za-z0-9+/=%._-]{64,}/gi, "data:");
}

// ---- Reading the file ----------------------------------------------------------

type Token =
  | { t: "open"; name: string; attrs: Record<string, string>; self: boolean }
  | { t: "close"; name: string }
  | { t: "text"; value: string };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose insides are not markup. */
const RAW = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp", "iframe"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·",
  times: "×", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", laquo: "«", raquo: "»",
  eacute: "é", egrave: "è", aacute: "á", agrave: "à", iacute: "í", oacute: "ó", uacute: "ú",
  ntilde: "ñ", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß", check: "✓", hearts: "♥", star: "☆",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,15});/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function readAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = pattern.exec(source)) && n < 60) {
    n += 1;
    const name = match[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** The file as a list of tags and texts; forgiving, as browsers are, of markup that does not close. */
function tokenize(html: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const lower = html.toLowerCase();
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push({ t: "text", value: html.slice(i) });
      break;
    }
    if (lt > i) out.push({ t: "text", value: html.slice(i, lt) });
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = html[lt + 1] === "/";
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(lt + (closing ? 2 : 1), lt + (closing ? 2 : 1) + 40));
    if (!nameMatch) {
      out.push({ t: "text", value: "<" });
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    // The end of the tag: the first > outside quotes.
    let j = lt + (closing ? 2 : 1) + nameMatch[0].length;
    let quote = "";
    for (; j < html.length; j += 1) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    const inner = html.slice(lt + (closing ? 2 : 1) + nameMatch[0].length, j);
    i = j + 1;
    if (closing) {
      out.push({ t: "close", name });
      continue;
    }
    const self = /\/\s*$/.test(inner) || VOID.has(name);
    out.push({ t: "open", name, attrs: readAttrs(inner.replace(/\/\s*$/, "")), self });
    if (RAW.has(name) && !self) {
      const end = lower.indexOf(`</${name}`, i);
      const body = html.slice(i, end < 0 ? html.length : end);
      if (body) out.push({ t: "text", value: body });
      if (end < 0) {
        i = html.length;
      } else {
        const close = html.indexOf(">", end);
        i = close < 0 ? html.length : close + 1;
      }
      out.push({ t: "close", name });
    }
  }
  return out;
}

// ---- What the page holds ---------------------------------------------------------

type Piece =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "item"; text: string }
  | { kind: "button"; text: string; note: string }
  | { kind: "video"; url: string }
  | { kind: "form" };

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "main", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "table", "tr", "td", "th",
  "br", "hr", "form", "blockquote", "figure", "figcaption", "button", "label", "dl", "dt", "dd", "pre", "center", "body", "html",
]);

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const clueOf = (attrs: Record<string, string>) => `${attrs.class ?? ""} ${attrs.id ?? ""} ${attrs.role ?? ""} ${attrs["data-title"] ?? ""} ${attrs["data-element"] ?? ""}`.toLowerCase();

const TRACKING_HOSTS = /(facebook\.(com|net)|connect\.facebook|google-analytics|googletagmanager|doubleclick|gtag|hotjar|tiktok|snapchat|pinterest|bing\.com|clarity\.ms|segment\.(io|com)|mixpanel|heap(analytics)?|linkedin\.com\/px|ads-twitter|analytics)/i;
const CONSENT_WORDS = /\b(agree|terms|privacy|consent|policy|gdpr|newsletter|subscribe|marketing|updates|remember me|keep me|opt[- ]?in|i accept|i have read)\b/i;
const BUMP_WORDS = /\b(yes|add|bump|upgrade|include|also get|special offer|one[- ]time|for just|only \$|get the)\b/i;
const PAYMENT_FIELD = /(card|cc[-_ ]?(num|number|exp|csc|cvc|name)|cvc|cvv|csc|expir|exp[-_ ]?(month|year|date)|security code|iban|routing|account number|billing|shipping|address|city|state|province|zip|postal|country)/i;

function fieldLabel(attrs: Record<string, string>, fallback: string): string {
  const raw = attrs.placeholder || attrs["aria-label"] || fallback || attrs.title || attrs.name || attrs.id || "";
  const text = squash(raw.replace(/[_\[\]]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"));
  if (!text) return "";
  return text[0].toUpperCase() + text.slice(1);
}

/** Cuts a text at a word, no longer than `max`, with an ellipsis when it was cut. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  return `${(space > max / 2 ? room.slice(0, space) : room).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Splits a long text into pieces no longer than `max`, at paragraph, then sentence, then word boundaries. Nothing is lost. */
function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const room = rest.slice(0, max);
    let at = room.lastIndexOf("\n\n");
    if (at < max / 3) at = Math.max(room.lastIndexOf(". "), room.lastIndexOf("? "), room.lastIndexOf("! ")) + 1;
    if (at < max / 3) at = room.lastIndexOf(" ");
    if (at < max / 3) at = max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

type Reading = {
  title: string;
  pieces: Piece[];
  form: FormSpec | null;
  checkboxes: string[];
  checkout: boolean;
  drop: (what: DroppedKind, example?: string, count?: number) => void;
  found: PageDraft["found"];
  pictures: SavedPicture[];
};

/** Walks the file's tags, keeping what the page says and counting what it does. */
function readPage(html: string, drop: Reading["drop"]): Omit<Reading, "drop"> {
  const tokens = tokenize(html);
  const found: PageDraft["found"] = { headings: 0, paragraphs: 0, buttons: 0, videos: 0, pictures: 0, forms: 0, scripts: 0 };
  const pictures: SavedPicture[] = [];
  const pieces: Piece[] = [];
  const checkboxes: string[] = [];
  let title = "";
  let checkout = false;
  let form: FormSpec | null = null;

  // What we are inside of: an element, and what it makes of the text in it.
  type Frame = { name: string; skip: boolean; heading: number; item: boolean; button: boolean; label: boolean; checkbox: boolean; form: boolean; head: boolean };
  const stack: Frame[] = [];
  let text = "";
  /** A checkbox not inside a label: the words right after it are its own. */
  let pendingCheckbox = false;
  /** The words of the label being read, and of the last one closed, for the field it names. */
  let labelText = "";
  let lastLabel = "";
  let fields: FormFieldSpec[] = [];
  let formButton = "";
  let inForm = false;
  let linksDropped = 0;

  const top = () => stack[stack.length - 1];
  const skipping = () => stack.some((f) => f.skip);
  const inHead = () => stack.some((f) => f.head);
  const headingLevel = () => {
    for (let k = stack.length - 1; k >= 0; k -= 1) if (stack[k].heading) return stack[k].heading;
    return 0;
  };
  const within = (key: "item" | "button" | "label") => stack.some((f) => f[key]);
  const openLabel = () => {
    for (let k = stack.length - 1; k >= 0; k -= 1) if (stack[k].label) return stack[k];
    return null;
  };
  /** A label that named no field is words like any other. */
  const spendLabel = () => {
    if (lastLabel) pieces.push({ kind: "para", text: lastLabel });
    lastLabel = "";
  };

  const flush = () => {
    const raw = decodeEntities(text);
    text = "";
    const value = squash(raw.replace(/\u0001/g, " "));
    if (!value) return;
    if (within("button")) {
      // A button's own words, and the smaller line under them when it has one.
      const [label = "", ...more] = raw.split("\u0001").map(squash).filter(Boolean);
      pendingCheckbox = false;
      spendLabel();
      if (inForm) formButton = formButton || value;
      else pieces.push({ kind: "button", text: label, note: more.join(" ") });
      return;
    }
    if (within("label")) {
      labelText = squash(`${labelText} ${value}`);
      return;
    }
    spendLabel();
    const level = headingLevel();
    if (pendingCheckbox && !level && value.length <= 300) {
      pendingCheckbox = false;
      checkboxes.push(value);
      return;
    }
    pendingCheckbox = false;
    if (level) pieces.push({ kind: "heading", level, text: value });
    else if (within("item")) pieces.push({ kind: "item", text: value });
    else pieces.push({ kind: "para", text: value });
  };

  /** The words naming a field: its label around it, the label just before it, or its own attributes. */
  const nameOf = (attrs: Record<string, string>) => {
    const around = openLabel() ? labelText : "";
    const words = fieldLabel(attrs, around || lastLabel);
    if (!around) lastLabel = "";
    return words;
  };
  const addField = (spec: FormFieldSpec) => {
    if (!inForm) return;
    if (fields.length >= MAX_FIELDS) {
      drop("questions", spec.label);
      return;
    }
    fields.push(spec);
  };

  const videoFrom = (attrs: Record<string, string>) => {
    for (const [name, value] of Object.entries(attrs)) {
      if (!value || value.length > 500) continue;
      if (name === "src" || name === "data-src" || name.includes("video") || name === "data-url" || name === "href") {
        if (/youtu|vimeo|loom/i.test(value) && readVideo(value)) return value;
      }
    }
    return "";
  };

  for (const token of tokens) {
    if (token.t === "text") {
      const frame = top();
      if (frame?.name === "title" && inHead()) {
        if (!title) title = squash(decodeEntities(token.value));
        continue;
      }
      if (frame && RAW.has(frame.name)) continue;
      if (skipping() || inHead()) continue;
      text += token.value;
      continue;
    }

    if (token.t === "close") {
      const at = stack.map((f) => f.name).lastIndexOf(token.name);
      if (at < 0) continue;
      if (within("button") && !stack[at].button) text += "\u0001";
      const closing = stack.slice(at);
      if (BLOCK_TAGS.has(token.name) || closing.some((f) => f.heading || f.item || f.button || f.label)) flush();
      stack.length = at;
      for (const frame of closing.reverse()) {
        if (frame.label) {
          if (frame.checkbox) {
            if (labelText) checkboxes.push(labelText);
          } else if (labelText) {
            spendLabel();
            lastLabel = labelText;
          }
          labelText = "";
        }
        if (frame.form) {
          inForm = false;
          if (fields.length && !form) form = { fields, button: cutAtWord(formButton, MAX_BUTTON) };
          else if (fields.length) drop("forms", fields.map((f) => f.label).join(", "));
          fields = [];
          formButton = "";
        }
      }
      continue;
    }

    // An opening tag.
    const { name, attrs } = token;
    const clue = clueOf(attrs);
    if (within("button")) text += "\u0001";
    else if (BLOCK_TAGS.has(name)) flush();
    const frame: Frame = { name, skip: false, heading: 0, item: false, button: false, label: false, checkbox: false, form: false, head: name === "head" };
    if (name === "meta" || name === "link" || name === "base") {
      if (name === "link" && /stylesheet/i.test(attrs.rel ?? "")) drop("styles", attrs.href ? hostOf(attrs.href) : "");
      continue;
    }
    const outside = skipping();
    if (name === "script") {
      found.scripts += 1;
      const src = attrs.src ?? "";
      if (src && TRACKING_HOSTS.test(src)) drop("tracking", hostOf(src));
      else drop("scripts", src ? hostOf(src) : "inline");
      frame.skip = true;
    } else if (name === "style") {
      drop("styles");
      frame.skip = true;
    } else if (name === "noscript" || name === "template" || name === "svg" || name === "canvas" || name === "map") {
      frame.skip = true;
    } else if (name === "nav" || name === "footer") {
      if (!outside) drop("menus");
      frame.skip = true;
    } else if ("hidden" in attrs && name !== "input") {
      frame.skip = true;
    } else if (/countdown|timer/.test(clue)) {
      if (!outside) drop("countdown");
      frame.skip = true;
    }

    if (!outside && !frame.skip && !inHead()) {
      if (/^h[1-6]$/.test(name)) {
        frame.heading = Number(name[1]);
        found.headings += 1;
      } else if (name === "li") frame.item = true;
      else if (name === "label") {
        frame.label = true;
        labelText = "";
      } else if (name === "form") {
        frame.form = true;
        // The form is asked where it stood on the page; only the first one is.
        if (!found.forms) pieces.push({ kind: "form" });
        inForm = true;
        found.forms += 1;
      } else if (name === "button") frame.button = true;
      else if (name === "a") {
        if (/button|btn|cta/.test(clue)) {
          frame.button = true;
          // The words before a button in the same box are not the button's.
          flush();
        } else if (attrs.href && !attrs.href.startsWith("#")) linksDropped += 1;
      }

      const video = videoFrom(attrs);
      if (video) {
        flush();
        pieces.push({ kind: "video", url: video });
        found.videos += 1;
      } else if (name === "img") {
        const src = attrs.src ?? attrs["data-src"] ?? "";
        if ((attrs.width === "1" && attrs.height === "1") || TRACKING_HOSTS.test(src)) drop("tracking", hostOf(src));
        else {
          found.pictures += 1;
          drop("pictures", squash(attrs.alt ?? "") || fileOf(src));
          if (pictures.length < MAX_SAVED_PICTURES) pictures.push({ ref: savedPictureRef(src), alt: squash(attrs.alt ?? "").slice(0, 300) });
        }
      } else if (name === "iframe" || name === "embed" || name === "object" || name === "video" || name === "audio") {
        const src = attrs.src ?? attrs.data ?? "";
        if (src && TRACKING_HOSTS.test(src)) drop("tracking", hostOf(src));
        else if (src || (name !== "video" && name !== "audio")) drop("embeds", src ? hostOf(src) : name);
      } else if (name === "input" || name === "select" || name === "textarea") {
        const type = (attrs.type ?? (name === "input" ? "text" : name)).toLowerCase();
        const hint = `${attrs.name ?? ""} ${attrs.id ?? ""} ${attrs.autocomplete ?? ""} ${attrs.placeholder ?? ""}`;
        const required = "required" in attrs || attrs["aria-required"] === "true";
        if (type === "hidden") {
          // Hidden fields carry the page builder's own settings: nothing the creator wrote.
        } else if (type === "submit" || type === "button" || type === "image") {
          const words = squash(attrs.value ?? attrs.alt ?? "");
          if (words) {
            flush();
            if (inForm) formButton = formButton || words;
            else pieces.push({ kind: "button", text: words, note: "" });
          }
        } else if (type === "checkbox") {
          const words = squash(attrs["aria-label"] ?? attrs.title ?? "");
          const label = openLabel();
          if (words) checkboxes.push(words);
          else if (label) label.checkbox = true;
          else if (lastLabel) {
            checkboxes.push(lastLabel);
            lastLabel = "";
          } else {
            flush();
            pendingCheckbox = true;
          }
        } else if (type === "email" || /e-?mail/i.test(`${attrs.name ?? ""} ${attrs.id ?? ""} ${attrs.autocomplete ?? ""}`)) {
          addField({ type: "email", label: cutAtWord(nameOf(attrs) || "Your email", MAX_LABEL), required: true });
        } else if (PAYMENT_FIELD.test(hint) || (type === "tel" && /card/i.test(hint))) {
          checkout = true;
          drop("payment", nameOf(attrs));
        } else if (type === "radio" || name === "select" || ["range", "file", "date", "number", "color", "time", "month", "week"].includes(type)) {
          drop("questions", nameOf(attrs));
        } else {
          const words = nameOf(attrs);
          if (words) addField({ type: name === "textarea" ? "long" : "short", label: cutAtWord(words, MAX_LABEL), required });
        }
      }
    }
    if (!token.self && !VOID.has(name)) stack.push(frame);
  }
  flush();
  spendLabel();
  if (inForm && fields.length && !form) form = { fields, button: cutAtWord(formButton, MAX_BUTTON) };
  if (linksDropped) drop("links", "", linksDropped);
  return { title, pieces, form, checkboxes, checkout, found, pictures };
}

function hostOf(url: string): string {
  try {
    return new URL(url, "https://page.invalid/").hostname.replace(/^www\./, "").replace("page.invalid", "this page");
  } catch {
    return "";
  }
}

function fileOf(url: string): string {
  if (!url || url.startsWith("data:")) return "a picture in the file";
  const path = url.split(/[?#]/)[0];
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)).slice(0, 80) || hostOf(url);
}

// ---- Into blocks -----------------------------------------------------------------

/** Reads one saved page into this platform's blocks, with everything that was left out said. */
export function convertSavedPage(input: string, fileName = ""): PageDraft {
  const html = input.length > MAX_TRIMMED_PAGE_CHARS ? input.slice(0, MAX_TRIMMED_PAGE_CHARS) : input;
  const dropped = new Map<DroppedKind, DroppedItem>();
  const drop = (what: DroppedKind, example = "", count = 1) => {
    const item = dropped.get(what) ?? { what, count: 0, examples: [] };
    item.count += count;
    const shown = squash(example).slice(0, 300);
    if (shown && item.examples.length < 5 && !item.examples.includes(shown)) item.examples.push(shown);
    dropped.set(what, item);
  };
  const read = readPage(html, drop);

  // Each text once: a phone copy and a computer copy of a section are one section.
  const seen = new Set<string>();
  const pieces: Piece[] = [];
  for (const piece of read.pieces) {
    const key = piece.kind === "video" ? `v:${readVideo(piece.url)?.id ?? piece.url}` : piece.kind === "form" ? "f" : `${piece.kind === "heading" ? "h" : piece.kind}:${piece.text.toLowerCase()}`;
    if (piece.kind !== "form" && seen.has(key)) {
      drop("repeats", piece.kind === "video" ? "" : piece.text);
      continue;
    }
    seen.add(key);
    pieces.push(piece);
  }
  // A form with no question that can come across is not asked.
  if (!read.form) {
    const at = pieces.findIndex((p) => p.kind === "form");
    if (at >= 0) pieces.splice(at, 1);
  }

  const blocks: PageBlock[] = [];
  let next = 0;
  const id = () => `cfb${(next++).toString(36).padStart(3, "0")}`;
  const shortened = (full: string, max: number) => {
    const cut = cutAtWord(full, max);
    if (cut !== full) drop("shortened", full);
    return cut;
  };
  const full = () => blocks.length >= MAX_BLOCKS;

  // The hero: the first top-level heading, and the paragraph under it when it fits.
  const heroAt = (() => {
    const h1 = pieces.findIndex((p) => p.kind === "heading" && p.level === 1);
    if (h1 >= 0 && h1 < 12) return h1;
    return pieces.findIndex((p) => p.kind === "heading");
  })();
  const before = heroAt > 0 ? pieces.slice(0, heroAt) : [];
  const rest = heroAt >= 0 ? pieces.slice(heroAt + 1) : pieces;
  let headline = "";
  if (heroAt >= 0) {
    const heading = pieces[heroAt] as { text: string };
    headline = shortened(heading.text, MAX_HEADLINE);
    let sub = "";
    if (rest[0]?.kind === "para" && rest[0].text.length <= MAX_SUBHEADLINE) {
      sub = rest[0].text;
      rest.shift();
    }
    blocks.push({ id: id(), kind: "hero", headline, sub, media: "none", video: null });
  }

  // Then sections: a heading and the words under it, a video, a button, the form.
  let section: { heading: string; parts: string[]; listing: boolean } | null = null;
  const flushSection = () => {
    if (!section) return;
    const body = section.parts.join("");
    const chunks = body.trim() ? splitText(body, MAX_TEXT) : [""];
    chunks.forEach((chunk, i) => {
      if (full()) {
        drop("overflow", chunk.slice(0, 120) || section!.heading);
        return;
      }
      if (!chunk && !(i === 0 && section!.heading)) return;
      blocks.push({ id: id(), kind: "text", heading: i === 0 ? section!.heading : "", body: chunk });
    });
    section = null;
  };
  const addWords = (piece: Piece) => {
    if (!section) section = { heading: "", parts: [], listing: false };
    if (piece.kind === "item") {
      section.parts.push(`${section.parts.length && !section.listing ? "\n\n" : section.parts.length ? "\n" : ""}- ${piece.text}`);
      section.listing = true;
    } else if (piece.kind === "para" || piece.kind === "heading") {
      section.parts.push(`${section.parts.length ? "\n\n" : ""}${piece.text}`);
      section.listing = false;
    }
  };
  const buttons = new Set<string>();
  for (const piece of [...before, ...rest]) {
    if (piece.kind === "heading") {
      flushSection();
      if (piece.text.length > MAX_HEADING) {
        // Too long to be a heading here: kept whole, as the section's first lines.
        section = { heading: "", parts: [piece.text], listing: false };
      } else section = { heading: piece.text, parts: [], listing: false };
      continue;
    }
    if (piece.kind === "para" || piece.kind === "item") {
      addWords(piece);
      continue;
    }
    flushSection();
    if (full()) {
      drop("overflow", piece.kind === "button" ? piece.text : piece.kind);
      continue;
    }
    if (piece.kind === "video") {
      const video = readVideo(piece.url);
      if (video) blocks.push({ id: id(), kind: "video", heading: "", video, caption: "" });
    } else if (piece.kind === "button") {
      const label = piece.text;
      if (buttons.has(label.toLowerCase())) continue;
      if (buttons.size >= MAX_IMPORTED_BUTTONS) {
        drop("buttons", label);
        continue;
      }
      buttons.add(label.toLowerCase());
      blocks.push({ id: id(), kind: "cta", label: shortened(label, MAX_CTA_LABEL), note: piece.note ? shortened(piece.note, MAX_CTA_NOTE) : "" });
    } else if (piece.kind === "form") {
      blocks.push({ id: id(), kind: "form", heading: "", form: "" });
    }
  }
  flushSection();
  // A form that did not find room is not asked.
  const form = read.form && blocks.some((b) => b.kind === "form") ? read.form : null;

  // Kept as a store's page keeps it, and no heavier than one may be.
  let page = parsePage({ blocks });
  while (page.blocks.length > 1 && oversized(page)) {
    const last = page.blocks[page.blocks.length - 1];
    drop("overflow", last.kind === "text" ? last.heading || last.body.slice(0, 120) : last.kind);
    page = parsePage({ blocks: page.blocks.slice(0, -1) });
  }

  // Checkboxes: an order bump's words at a checkout, or a consent box, or a question.
  const bumps: BumpSpec[] = [];
  for (const words of read.checkboxes) {
    if (CONSENT_WORDS.test(words)) drop("consent", words);
    else if ((read.checkout || BUMP_WORDS.test(words)) && bumps.length < MAX_IMPORTED_BUMPS) bumps.push({ pitch: shortened(words, MAX_PITCH_LENGTH) });
    else drop("questions", words);
  }

  const firstText = page.blocks.find((b): b is Extract<PageBlock, { kind: "text" }> => b.kind === "text" && b.body !== "");
  const firstWords = firstText ? splitText(firstText.body, MAX_STEP_TEXT_LENGTH)[0] ?? "" : "";
  const hero = page.blocks[0]?.kind === "hero" ? page.blocks[0] : null;
  const offerText = hero?.sub || firstWords;
  const named = read.title || headline || fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ");
  return {
    title: cutAtWord(squash(named) || "Imported page", MAX_SITE_TITLE),
    blocks: page.blocks,
    form,
    bumps,
    checkout: read.checkout,
    offer: {
      headline: cutAtWord(hero?.headline ?? "", MAX_HEADLINE_LENGTH),
      text: cutAtWord(squash(offerText), MAX_STEP_TEXT_LENGTH),
    },
    dropped: [...dropped.values()],
    found: { ...read.found, paragraphs: pieces.filter((p) => p.kind === "para" || p.kind === "item").length, buttons: pieces.filter((p) => p.kind === "button").length },
    pictures: read.pictures,
  };
}
