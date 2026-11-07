/**
 * A store shared as a template for another creator to copy (379 [TB5],
 * unit 1; added 7 November 2026). The rules, pure and browser-safe: before
 * any word of a shared store reaches another creator's account, every
 * private detail in it is taken out and a plain note is put in its place.
 *
 * What is taken out of the words (a product's description, a page, an
 * email, a funnel's text):
 *
 *   - private links: the store's own downloads, feeds, claims and every
 *     other address under /api/, a buyer's certificate, invitations, stop
 *     and takedown links, the studio; a link that carries an access value
 *     (token=, key=, sig=, pwd=, X-Amz-Signature= and the like, in the
 *     query or after #), a name and password, or a long random part (a
 *     shared file); a link to someone's own files or meetings (Dropbox,
 *     OneDrive, WeTransfer, Box, Google Meet, Zoom, Teams, Whereby) or to the
 *     store's storage (Vercel Blob, Cloudflare R2, Amazon S3, Bunny); any
 *     link that is not a web page;
 *   - keys and account ids: Stripe keys, webhook secrets and account ids,
 *     GitHub, Slack, AWS, Google and Resend keys, signed tokens (JWT), and a
 *     long random string on its own, like a license key;
 *   - email addresses, alone or in a mailto: link;
 *   - phone numbers (nine digits or more, as people write them) and tel:,
 *     sms: and callto: links.
 *
 * Public links (a site, a video, a store page) stay exactly as written, and
 * so does every other word. Nothing of the first store is changed: this
 * makes the copy's words only.
 *
 * Fails closed: what is not words, what is longer than any field a store
 * keeps, and words that would show a private detail once look-alike
 * characters are read as the plain ones (a full-width ＠, an invisible
 * character inside "https://") are refused whole, never passed on.
 *
 * Not covered here, for the units that read and write a template: links to
 * the first store's own public pages (the copy maps them, as
 * lib/store-copy-rules.ts does for products), files and pictures (never
 * copied), and details spelled out in words ("ana at example dot com").
 */

export type ScrubKind = "link" | "key" | "email" | "phone";
export type ScrubCounts = Record<ScrubKind, number>;
export type Scrubbed = { ok: true; text: string; removed: ScrubCounts } | { ok: false; why: "not_text" | "too_long" | "unchecked" };

const KINDS: ScrubKind[] = ["link", "key", "email", "phone"];

/**
 * The longest field the rules read, in characters. A store's largest stored
 * field is a sales page, MAX_STORED_PAGE_BYTES (360,000) in lib/sales-page.ts
 * (held by tests/store-template-rules.test.ts); a longer one is refused.
 */
export const TEMPLATE_FIELD_MAX_CHARS = 400_000;

/** The note the other creator sees where a private detail was. */
export const TEMPLATE_MARKS: Record<ScrubKind, string> = {
  link: "[private link removed]",
  key: "[key removed]",
  email: "[email address removed]",
  phone: "[phone number removed]",
};

/** Characters that end a word: spaces, quotes, angle brackets, brackets and parentheses (so Markdown and HTML links are read alone). */
const DELIMITERS = /([\s"'`<>()[\]{}]+)/u;
/** Marks the end of a sentence, kept after a link or an address. */
const TAIL = new Set([".", ",", ";", ":", "!", "?"]);

/** Keys and account ids, anywhere in a word. Each starts on a fixed prefix, so a long word is read once. */
const KEYS: RegExp[] = [
  /(?:^|[^A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/,
  /(?:^|[^A-Za-z0-9])whsec_[A-Za-z0-9]{6,}/,
  /(?:^|[^A-Za-z0-9])acct_[A-Za-z0-9]{6,}/,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?:^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/,
  /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/,
  /(?:^|[^A-Za-z0-9])re_[A-Za-z0-9_]{16,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];
/** A long random string: letters and digits both, 32 or more, nothing else. */
const RANDOM = /^[A-Za-z0-9_-]{32,}$/;
const randomLike = (word: string, min: number) => word.length >= min && /^[A-Za-z0-9_-]+$/.test(word) && /\d/.test(word) && /[A-Za-z]/.test(word);

/** An email address, read from its first character only (so a long word is never read again from each letter), with mailto: and its ?subject= when there. */
const EMAIL = /(?:mailto:)?(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?:\?[^\s"'`<>]*)?/giu;
const hasEmail = (word: string) => word.includes("@") && new RegExp(EMAIL.source, "iu").test(word);

/** Phone links. */
const PHONE_LINK = /^(?:tel|sms|callto):/i;
/** A phone number as people write it: nine to twenty digits, with spaces, dots, dashes or parentheses between. */
const PHONE = /(?<![\p{L}\p{N}+])\+?\(?\d(?:[ .\- ]?\(?\d\)?){8,19}(?![\p{L}\p{N}])/gu;

/** A host and a path without https:// ("ana.example/api/..."). */
const HOST_PATH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i;

/** Paths that are never public, on marktmorgen.com and on a creator's own domain alike. */
const PRIVATE_PATHS: RegExp[] = [
  /^\/api\//,
  /\/certificate\//,
  /^\/invite\//,
  /^\/outreach\/stop\//,
  /^\/takedown\//,
  /^\/unsubscribe(?:\/|$)/,
  /^\/numbers\//,
  /^\/studio(?:\/|$)/,
];

/** Hosts of someone's own files and meetings, and of a store's storage (lib/ uses Vercel Blob, R2, S3 and Bunny). */
const PRIVATE_HOSTS = [
  "dropbox.com", "dropboxusercontent.com", "1drv.ms", "onedrive.live.com", "wetransfer.com", "we.tl", "box.com",
  "meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com", "whereby.com",
  "blob.vercel-storage.com", "r2.cloudflarestorage.com", "r2.dev", "amazonaws.com", "b-cdn.net", "bunnycdn.com", "mediadelivery.net",
];

/** Names of a link's values that carry access, read without case. */
const SECRET_PARAMS = new Set([
  "token", "access_token", "id_token", "refresh_token", "auth", "authorization", "key", "apikey", "api_key", "sig", "signature",
  "secret", "client_secret", "password", "pass", "pwd", "code", "session", "sessionid", "session_id", "jwt",
]);
const secretParam = (name: string) => {
  const n = name.toLowerCase();
  return SECRET_PARAMS.has(n) || n.startsWith("x-amz-") || n.startsWith("x-goog-");
};

/** Whether a web address is private; an address that cannot be read is. */
function privateUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return true;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return true;
  if (url.username || url.password) return true;
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  const path = url.pathname.toLowerCase();
  if (PRIVATE_PATHS.some((p) => p.test(path))) return true;
  if (url.pathname.split("/").some((part) => randomLike(part, 24))) return true;
  const hash = url.hash.slice(1);
  for (const params of [url.searchParams, new URLSearchParams(hash.includes("=") ? hash : "")]) {
    for (const [name, value] of params) {
      if (secretParam(name) || randomLike(value, 32)) return true;
    }
  }
  return false;
}

/** Where a web address starts in a word: after "href=" or the like, at its scheme or at "www."; -1 when the word holds none. */
function urlStart(word: string): number {
  const scheme = word.indexOf("://");
  if (scheme > 0) {
    let start = scheme;
    while (start > 0 && scheme - start < 32 && /[A-Za-z0-9+.-]/.test(word[start - 1])) start -= 1;
    while (start < scheme && !/[A-Za-z]/.test(word[start])) start += 1;
    return start < scheme ? start : -1;
  }
  const www = word.toLowerCase().indexOf("www.");
  if (www === 0 || (www > 0 && !/[A-Za-z0-9.-]/.test(word[www - 1]))) return www;
  return HOST_PATH.test(word) ? 0 : -1;
}

type Piece = { text: string; kept?: string };

/** One word, without the stops after it: what it becomes, and whether it is a public link to keep whole. */
function scrubWord(word: string, removed: ScrubCounts): Piece {
  if (word === "") return { text: word };
  if (KEYS.some((k) => k.test(word)) || (RANDOM.test(word) && randomLike(word, 32))) {
    removed.key += 1;
    return { text: TEMPLATE_MARKS.key };
  }
  const at = urlStart(word);
  if (at >= 0) {
    const before = word.slice(0, at);
    const link = word.slice(at);
    if (privateUrl(link)) {
      removed.link += 1;
      return { text: before + TEMPLATE_MARKS.link };
    }
    if (hasEmail(link)) {
      removed.email += 1;
      return { text: before + TEMPLATE_MARKS.email };
    }
    return { text: before, kept: link };
  }
  if (hasEmail(word)) {
    return {
      text: word.replace(EMAIL, () => {
        removed.email += 1;
        return TEMPLATE_MARKS.email;
      }),
    };
  }
  if (PHONE_LINK.test(word)) {
    removed.phone += 1;
    return { text: TEMPLATE_MARKS.phone };
  }
  return { text: word };
}

/** Marks a kept link while phone numbers are read, so a number inside a public link is never touched. */
const HOLD = "\uE000";
const HOLD_END = "\uE001";
/** A kept link's place: its index, each digit written as a letter (0 is "a"), so the phone numbers read next never see a digit in it. */
const holdFor = (index: number) => `${HOLD}${String(index).replace(/\d/g, (d) => "abcdefghij"[Number(d)])}${HOLD_END}`;
const heldIndex = (code: string) => Number(code.replace(/[a-j]/g, (c) => String(c.charCodeAt(0) - 0x61)));
const HELD = /\uE000([a-j]+)\uE001/g;

function scrubOnce(text: string): { text: string; removed: ScrubCounts } {
  const removed: ScrubCounts = { link: 0, key: 0, email: 0, phone: 0 };
  const kept: string[] = [];
  const parts = text.split(DELIMITERS);
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i];
    let end = part.length;
    while (end > 0 && TAIL.has(part[end - 1])) end -= 1;
    const piece = scrubWord(part.slice(0, end), removed);
    let out = piece.text;
    if (piece.kept !== undefined) {
      out += holdFor(kept.length);
      kept.push(piece.kept);
    }
    parts[i] = out + part.slice(end);
  }
  const phoned = parts.join("").replace(PHONE, () => {
    removed.phone += 1;
    return TEMPLATE_MARKS.phone;
  });
  const back = kept.length === 0 ? phoned : phoned.replace(HELD, (_, code: string) => kept[heldIndex(code)] ?? "");
  return { text: back, removed };
}

/**
 * The words of a template field with every private detail taken out, and
 * how many of each kind; refused whole when the field is not words, is too
 * long, or cannot be checked.
 */
export function scrubTemplateText(text: string): Scrubbed {
  if (typeof text !== "string") return { ok: false, why: "not_text" };
  if (text.length > TEMPLATE_FIELD_MAX_CHARS) return { ok: false, why: "too_long" };
  if (text.includes(HOLD) || text.includes(HOLD_END)) return { ok: false, why: "unchecked" };
  const once = scrubOnce(text);
  // Read again as a person would see it: look-alike characters as the plain ones, invisible ones gone. Anything private left refuses the field.
  const seen = once.text.normalize("NFKC").replace(/\p{Cf}/gu, "");
  const again = scrubOnce(seen);
  if (KINDS.some((kind) => again.removed[kind] > 0)) return { ok: false, why: "unchecked" };
  return { ok: true, text: once.text, removed: once.removed };
}

/**
 * A link field (a button's or a picture's address): kept only when it is a
 * public web address; emptied (null) when private, not a web address, or
 * written with characters that read differently.
 */
export function scrubTemplateUrl(url: string): { ok: true; url: string | null } | { ok: false; why: "not_text" } {
  if (typeof url !== "string") return { ok: false, why: "not_text" };
  const link = url.trim();
  if (link === "" || link.length > 2_048 || /\s/.test(link)) return { ok: true, url: null };
  if (link.normalize("NFKC").replace(/\p{Cf}/gu, "") !== link) return { ok: true, url: null };
  if (!/^https?:\/\//i.test(link)) return { ok: true, url: null };
  const once = scrubOnce(link);
  if (once.text !== link || KINDS.some((kind) => once.removed[kind] > 0)) return { ok: true, url: null };
  return { ok: true, url: link };
}

const NAMES: Record<ScrubKind, [string, string]> = {
  link: ["private link", "private links"],
  key: ["key", "keys"],
  email: ["email address", "email addresses"],
  phone: ["phone number", "phone numbers"],
};

/** What the preview says before a template is shared: what was left out, or that nothing was found. */
export function templateScrubSummary(removed: ScrubCounts): string {
  if (!removed || typeof removed !== "object" || KINDS.some((kind) => !Number.isSafeInteger(removed[kind]) || removed[kind] < 0)) {
    return "We could not check your words for private details, so nothing is shared yet.";
  }
  const found = KINDS.filter((kind) => removed[kind] > 0);
  if (found.length === 0) return "We found no private links, keys, email addresses or phone numbers in your words.";
  const items = found.map((kind) => `${removed[kind]} ${NAMES[kind][removed[kind] === 1 ? 0 : 1]}`);
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `Left out of the copy: ${list}. The other creator sees a note where each one was, such as ${TEMPLATE_MARKS[found[0]]}.`;
}
