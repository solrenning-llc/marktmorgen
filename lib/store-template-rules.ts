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
 *     and takedown links, the studio, sign-in, a buyer's library, orders,
 *     payment requests, agreements and community messages; a link that
 *     carries an access value (token=, auth_token=, key=, sig=, pwd=,
 *     X-Amz-Signature=, ;jsessionid= and the like, in the query or after #,
 *     "#/reset?token=" included), a short value that reads as random
 *     (?t=, ?s=, ?c=, Vimeo's ?h=), a name and password, or a random part
 *     (a shared file); a link to someone's own files, photos, private videos
 *     or meetings (Dropbox, OneDrive, WeTransfer, Box, Google Photos, Vimeo's
 *     unlisted links, Google Meet, Zoom, Teams, Whereby), to an automation
 *     hook (Zapier, Slack, Make, a Telegram bot) or to the store's storage
 *     (Vercel Blob, Cloudflare R2, Amazon S3, Bunny); any link that is not a
 *     web page;
 *   - keys and account ids: Stripe keys, webhook secrets and account ids,
 *     OpenAI, Anthropic, GitHub, GitLab, Slack, AWS, Google, Telegram and
 *     Resend keys, signed tokens (JWT), the value of a KEY=value line
 *     (OPENAI_API_KEY=..., API_TOKEN=...), and a random string on its own,
 *     like a license key or a secret in base64;
 *   - email addresses, alone or in a mailto: link, also when written with
 *     %40 or &#64;;
 *   - phone numbers (nine digits or more, as people write them, with
 *     spaces, dots, dashes or slashes between) and tel:, sms: and callto:
 *     links.
 *
 * When unsure about a link, it is taken out: a lost link is better than a
 * leaked one. But a part of a link is random only when it reads so: a slug
 * of words joined by hyphens never is (a blog post, a product's address
 * with its short id), and utm_*, list= and v= are public. Dates, prices,
 * an ISBN, an IP address, a picture name (logo@2x.png) and a package version
 * (react@18.3.1) are not phone numbers or addresses. Every other word stays
 * exactly as written; inside an encoded word, only the private part is
 * replaced. Nothing of the first store is changed: this makes the copy's
 * words only.
 *
 * Fails closed: what is not words, what is longer than any field a store
 * keeps, and words that would show a private detail once read as a person
 * sees them are refused whole, never passed on. That second reading folds
 * compatibility forms (NFKC: a full-width ＠ or ｈｔｔｐｓ), drops invisible
 * characters, and maps the Cyrillic and Greek letters that look like Latin
 * ones (a Cyrillic ѕ in "httpѕ://"). NFKC alone does not fold such
 * look-alikes; the map covers the common ones, not every confusable.
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

/**
 * Keys and account ids, anywhere in a word. Each starts on a fixed prefix,
 * so a long word is read once; a prefix that is also an ordinary word start
 * (acct_, re_, sk-) counts only with a digit after it, so "acct_manager"
 * stays.
 */
const KEYS: RegExp[] = [
  /(?:^|[^A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/,
  /(?:^|[^A-Za-z0-9])whsec_[A-Za-z0-9]{6,}/,
  /(?:^|[^A-Za-z0-9])acct_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}/,
  /(?:^|[^A-Za-z0-9])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
  /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/,
  /(?:^|[^A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{10,}/,
  /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/,
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/,
  /(?:^|[^A-Za-z0-9])re_(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{16,}/,
  /(?:^|[^A-Za-z0-9])\d{8,10}:[A-Za-z0-9_-]{30,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

/** Upper case, lower case or digit: how often a run of characters changes between them. */
const classOf = (c: string) => (c >= "0" && c <= "9" ? 0 : c >= "a" && c <= "z" ? 1 : 2);
function switches(run: string): number {
  let count = 0;
  for (let i = 1; i < run.length; i += 1) if (classOf(run[i]) !== classOf(run[i - 1])) count += 1;
  return count;
}
/**
 * Whether one run of ASCII letters and digits reads as random, not as a word,
 * a number or a short id: letters and digits both, and either `long` or more
 * characters, or `mixed` or more with both cases, changing between upper
 * case, lower case and digits in a third of its places or more, as a random
 * string does ("McDonalds2026Campaign" changes 6 times in 21, and stays).
 */
function randomRun(run: string, long: number, mixed: number): boolean {
  if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return false;
  if (run.length >= long) return true;
  return run.length >= mixed && /[a-z]/.test(run) && /[A-Z]/.test(run) && switches(run) * 3 >= run.length;
}
/** Whether a part of a link or a word holds a random run; words joined by hyphens or underscores are read one by one, so a slug of words never is. */
const randomPart = (part: string, long: number, mixed: number) => (part.match(/[A-Za-z0-9]+/g) ?? []).some((run) => randomRun(run, long, mixed));
/** A word on its own that is a random string: a license key, a token, or a secret in base64 (letters, digits, + and /, = at the end). */
function randomWord(word: string): boolean {
  if (/^[A-Za-z0-9_-]+$/.test(word)) return randomPart(word, 32, 20);
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(word)) {
    const run = word.replace(/[^A-Za-z0-9]/g, "");
    return run.length >= 20 && /[a-z]/.test(run) && /[A-Z]/.test(run) && switches(run) * 3 >= run.length;
  }
  return false;
}

/**
 * The value of a KEY=value line (OPENAI_API_KEY=..., "api_key": "...",
 * PASSWORD=...): a name that is or ends in a word for a secret, then = or :,
 * then the value. Read only after the start, a space, a quote, a brace or a
 * comma (JSON), so a link's
 * own ?token= is left to the link rules. After ":" the name must look like a
 * setting (capitals or an underscore, or password, secret, token) and the
 * value hold a digit or 12 characters, so "Season pass: 12 months" stays.
 */
const ENV_LINE = /(?<=^|[\s"'`{,;(])(["']?)((?:[A-Za-z0-9]+_)*(?:api_?key|key|token|secret|password|passwd|pwd|pass|auth|credentials?|dsn)(?:_[A-Za-z0-9]+)*)\1([ \t]*[=:][ \t]*)(["']?)([^\s"'`<>[\]]+)/gi;
function envValue(name: string, sep: string, value: string): boolean {
  if (sep.includes("=")) return true;
  const setting = /_/.test(name) || (name.length >= 3 && name === name.toUpperCase()) || /^(?:password|passwd|pwd|secret|token|api_?key)$/i.test(name);
  return setting && (/\d/.test(value) || value.length >= 12);
}

/**
 * An email address, read from its first character only (so a long word is
 * never read again from each letter), with mailto: and its ?subject= when
 * there. The last part of the domain is letters (two or more) or an IDN's
 * xn--, so "react@18.3.1" is not one.
 */
const EMAIL = /(?:mailto:)?(?<![\p{L}\p{N}._%+-])([\p{L}\p{N}._%+-]+)@((?:[\p{L}\p{N}-]+\.)+(?:\p{L}{2,}|xn--[\p{L}\p{N}-]+))(?![\p{L}\p{N}])(?:\?[^\s"'`<>]*)?/giu;
/** File endings that are no domain's last part: "logo@2x.png" names a picture, not an address. */
const FILE_ENDINGS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp", "tif", "tiff", "heic", "pdf", "mp3", "mp4", "m4a", "wav", "webm",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "json", "htm", "html", "txt", "csv", "xml", "yml", "yaml", "woff", "woff2", "ttf", "otf",
]);
const isAddress = (domain: string) => !FILE_ENDINGS.has(domain.slice(domain.lastIndexOf(".") + 1).toLowerCase());
const hasEmail = (word: string) => word.includes("@") && Array.from(word.matchAll(new RegExp(EMAIL.source, "giu"))).some((m) => isAddress(m[2]));

/** Phone links. */
const PHONE_LINK = /^(?:tel|sms|callto):/i;
/**
 * A phone number as people write it: nine to twenty digits, with spaces,
 * dots, dashes (with spaces around or not), slashes or parentheses between.
 * Never read from the middle of a longer number: not right after a letter,
 * a digit, a plus, a dot, a dash or a slash.
 */
const PHONE = /(?<![\p{L}\p{N}+.\-\u2013\u2014/])\+?\(?\d(?:(?:[ \u00A0]?[-\u2013\u2014/.][ \u00A0]?|[ \u00A0])?\(?\d\)?){8,19}(?![\p{L}\p{N}])/gu;

/** Whether digits found as a phone number are one, and not a date, an IP address, an ISBN, a list of prices or years, or a large number. */
function phoneLike(found: string, before: string): boolean {
  const groups = found.split(/\D+/).filter(Boolean);
  if (/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d)/.test(found) || /(?<!\d)\d{1,2}\/\d{1,2}\/\d{2,4}(?!\d)/.test(found)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(found) && groups.every((g) => Number(g) <= 255)) return false;
  if (/\bISBN(?:-1[03])?:?\s*$/i.test(before)) return false;
  const digits = groups.join("");
  if (/-/.test(found) && digits.length === 13 && /^97[89]/.test(digits)) {
    const sum = Array.from(digits.slice(0, 12)).reduce((total, d, i) => total + Number(d) * (i % 2 ? 3 : 1), 0);
    if ((10 - (sum % 10)) % 10 === Number(digits[12])) return false;
  }
  if (groups.every((g) => /^(?:19|20)\d\d$/.test(g))) return false;
  // A big number in groups of three ("1 000 000 000"); a list of short numbers ("49 99 199 499"), unless written as a phone number is (+, a bracket or a leading 0).
  if (!/^[+(]/.test(found) && /^\d{1,3}(?:[ .\u00A0]\d{3})+$/.test(found) && (groups[0].length < 3 || groups.slice(1).includes("000"))) return false;
  if (!/^[+(0]/.test(found) && groups.length >= 4 && groups.every((g) => g.length <= 3)) return false;
  return true;
}

/** A host and a path without https:// ("ana.example/api/..."), or a host and its query ("example.com?token="). */
const HOST_PATH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i;
const HOST_QUERY = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}[?#;]/i;

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
  /^\/signin(?:\/|$)/,
  /^\/library(?:\/|$)/,
  /\/community\/messages(?:\/|$)/,
];
/**
 * A store's pages for one buyer or one deal, read as the first or second
 * part of a path (marktmorgen.com/ana/pay/..., or /pay/... on the creator's
 * own domain): what a buyer manages, orders, pays, signs, renews, moves or
 * left, and the page after paying.
 */
const PRIVATE_STORE_PAGES = new Set(["manage", "orders", "pay", "sign", "renew", "move", "left", "thanks"]);

/** Hosts of someone's own files and meetings, and of a store's storage (lib/ uses Vercel Blob, R2, S3 and Bunny). */
const PRIVATE_HOSTS = [
  "dropbox.com", "dropboxusercontent.com", "1drv.ms", "onedrive.live.com", "wetransfer.com", "we.tl", "box.com",
  "meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com", "whereby.com",
  "blob.vercel-storage.com", "r2.cloudflarestorage.com", "r2.dev", "amazonaws.com", "b-cdn.net", "bunnycdn.com", "mediadelivery.net",
  "photos.app.goo.gl", "photos.google.com", "hooks.zapier.com", "hooks.slack.com", "api.telegram.org",
];
/** Hosts whose ids in a link are public pages (a track, a video, a post): a short random-looking id there stays. */
const PUBLIC_ID_HOSTS = ["open.spotify.com", "youtube.com", "youtu.be", "instagram.com", "tiktok.com", "x.com", "twitter.com", "medium.com"];
const hostIn = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** Names of a link's values that carry access, read without case. */
const SECRET_PARAMS = new Set([
  "token", "access_token", "id_token", "refresh_token", "auth", "authorization", "key", "apikey", "api_key", "sig", "signature",
  "secret", "client_secret", "password", "pass", "pwd", "code", "session", "sessionid", "session_id", "jwt",
]);
const secretParam = (name: string) => {
  const n = name.toLowerCase();
  return SECRET_PARAMS.has(n) || n.startsWith("x-amz-") || n.startsWith("x-goog-") || /token|secret|passw|signature|api_?key|session|credential|jwt|sid$/.test(n);
};
/** Names of a link's values that are public: a video, a playlist, a search, a page or a language (and every utm_*). */
const PUBLIC_PARAMS = new Set(["v", "list", "index", "q", "page", "lang", "hl"]);
/** Whether one value of a link carries access: by its name, by a random run in it, or a short name (?t=, ?s=, ?c=, ?h=) with letters and digits. */
function privateParam(name: string, value: string, idsArePublic: boolean): boolean {
  const n = name.toLowerCase();
  if (n.startsWith("utm_") || PUBLIC_PARAMS.has(n)) return false;
  if (n === "t" && /^(?:\d+h)?(?:\d+m)?\d*s?$/.test(value)) return false;
  if (secretParam(n)) return true;
  if (randomPart(value, 24, idsArePublic ? 24 : 16)) return true;
  return n.length <= 2 && /^[A-Za-z0-9_-]{6,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
}

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
  if (hostIn(host, PRIVATE_HOSTS) || (host.startsWith("hook.") && host.endsWith(".make.com"))) return true;
  const idsArePublic = hostIn(host, PUBLIC_ID_HOSTS);
  const hash = url.hash.slice(1);
  const ask = hash.indexOf("?");
  const hashPath = ask >= 0 ? hash.slice(0, ask) : hash.includes("=") ? "" : hash;
  const hashQuery = ask >= 0 ? hash.slice(ask + 1) : hash.includes("=") ? hash : "";
  for (const raw of [url.pathname, hashPath]) {
    const path = raw.toLowerCase();
    if (PRIVATE_PATHS.some((p) => p.test(path))) return true;
    if (path.split("/").filter(Boolean).slice(0, 2).some((part) => PRIVATE_STORE_PAGES.has(part.split(";")[0]))) return true;
    for (const part of raw.split("/")) {
      // ;jsessionid=... and the like, inside a part of the path.
      for (const [, name] of part.matchAll(/;([^;=/]+)=/g)) if (secretParam(name)) return true;
      if (randomPart(part, 24, idsArePublic ? 24 : 16)) return true;
    }
  }
  if (hostIn(host, ["vimeo.com"])) {
    // An unlisted Vimeo video: vimeo.com/<id>/<hash>, or ?h=<hash> on the player.
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^[0-9a-f]{6,}$/i.test(parts[1])) return true;
    if (url.searchParams.has("h")) return true;
  }
  for (const params of [url.searchParams, new URLSearchParams(hashQuery)]) {
    for (const [name, value] of params) {
      if (privateParam(name, value, idsArePublic)) return true;
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
  return HOST_PATH.test(word) || HOST_QUERY.test(word) ? 0 : -1;
}

type Piece = { text: string; kept?: string };

/** Named characters a word may be written with in HTML. */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", commat: "@", period: ".", plus: "+", num: "#", quest: "?", equals: "=", percnt: "%", lowbar: "_", hyphen: "-",
};
/**
 * A word with %xx (ASCII only) and HTML character references written as
 * the characters they stand for, and where each character came from in the
 * word; null when nothing was encoded.
 */
function decodeWord(word: string): { text: string; at: number[] } | null {
  if (!/[%&]/.test(word)) return null;
  let text = "";
  const at: number[] = [];
  let i = 0;
  while (i < word.length) {
    let char: string | null = null;
    let size = 1;
    if (word[i] === "%") {
      const m = /^%([0-7][0-9A-Fa-f])/.exec(word.slice(i, i + 3));
      if (m) [char, size] = [String.fromCharCode(parseInt(m[1], 16)), 3];
    } else if (word[i] === "&") {
      const m = /^&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]{2,8}));/.exec(word.slice(i, i + 12));
      if (m) {
        const code = m[1] ? Number(m[1]) : m[2] ? parseInt(m[2], 16) : -1;
        const named = m[3] ? ENTITIES[m[3].toLowerCase()] : undefined;
        if (code >= 0 && code <= 0x10ffff) char = String.fromCodePoint(code);
        else if (named !== undefined) char = named;
        if (char !== null) size = m[0].length;
      }
    }
    if (char === null) char = word[i];
    for (let unit = 0; unit < char.length; unit += 1) at.push(i);
    text += char;
    i += size;
  }
  at.push(word.length);
  return text === word ? null : { text, at };
}

/** One word, without the stops after it: what it becomes, and whether it is a public link to keep whole. Read also decoded, so "ana%40example.com" and "ana&#64;example.com" go too. */
function scrubWord(word: string, removed: ScrubCounts): Piece {
  const decoded = decodeWord(word);
  if (decoded) {
    const found: ScrubCounts = { link: 0, key: 0, email: 0, phone: 0 };
    const piece = scrubPlainWord(decoded.text, found);
    if (KINDS.some((kind) => found[kind] > 0)) {
      for (const kind of KINDS) removed[kind] += found[kind];
      // The word stays as written outside the part that was replaced.
      const out = piece.text + (piece.kept ?? "");
      const from = decoded.text;
      let head = 0;
      while (head < out.length && head < from.length && out[head] === from[head]) head += 1;
      let tail = 0;
      while (tail < out.length - head && tail < from.length - head && out[out.length - 1 - tail] === from[from.length - 1 - tail]) tail += 1;
      return { text: word.slice(0, decoded.at[head]) + out.slice(head, out.length - tail) + word.slice(decoded.at[from.length - tail]) };
    }
  }
  return scrubPlainWord(word, removed);
}

function scrubPlainWord(word: string, removed: ScrubCounts): Piece {
  if (word === "") return { text: word };
  if (KEYS.some((k) => k.test(word)) || randomWord(word)) {
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
      text: word.replace(EMAIL, (found: string, _local: string, domain: string) => {
        if (!isAddress(domain)) return found;
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

/** Phone numbers in words already read, each checked before it is taken out; when one is not, reading goes on after its first digits. */
function scrubPhones(text: string, removed: ScrubCounts): string {
  const find = new RegExp(PHONE.source, "gu");
  let out = "";
  let last = 0;
  for (let m = find.exec(text); m !== null; m = find.exec(text)) {
    if (phoneLike(m[0], text.slice(Math.max(0, m.index - 16), m.index))) {
      out += text.slice(last, m.index) + TEMPLATE_MARKS.phone;
      last = m.index + m[0].length;
      removed.phone += 1;
    } else {
      find.lastIndex = m.index + (/^\+?\(?\d+/.exec(m[0])?.[0].length ?? 1);
    }
  }
  return out + text.slice(last);
}

function scrubOnce(input: string): { text: string; removed: ScrubCounts } {
  const removed: ScrubCounts = { link: 0, key: 0, email: 0, phone: 0 };
  const kept: string[] = [];
  const text = input.replace(ENV_LINE, (found: string, quote: string, name: string, sep: string, open: string, value: string) => {
    if (!envValue(name, sep, value)) return found;
    removed.key += 1;
    return `${quote}${name}${quote}${sep}${open}${TEMPLATE_MARKS.key}`;
  });
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
  const phoned = scrubPhones(parts.join(""), removed);
  const back = kept.length === 0 ? phoned : phoned.replace(HELD, (_, code: string) => kept[heldIndex(code)] ?? "");
  return { text: back, removed };
}

/** Cyrillic and Greek letters drawn like Latin ones, as the Latin ones (the common look-alikes; Unicode's full confusables list is longer). */
const LOOK_ALIKES: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "ѕ": "s", "і": "i", "ј": "j", "ԁ": "d", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w", "ь": "b",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "Ѕ": "S", "І": "I", "Ј": "J",
  "α": "a", "ο": "o", "ρ": "p", "ι": "i", "κ": "k", "ν": "v", "τ": "t", "υ": "u", "χ": "x", "ε": "e",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
const LOOK_ALIKE = new RegExp(`[${Object.keys(LOOK_ALIKES).join("")}]`, "gu");
const skeleton = (text: string) => text.replace(LOOK_ALIKE, (c) => LOOK_ALIKES[c]);

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
  // Read again as a person would see it: compatibility forms folded, invisible characters gone, Cyrillic and Greek look-alikes as Latin. Anything private left refuses the field.
  const seen = skeleton(once.text.normalize("NFKC").replace(/\p{Cf}/gu, ""));
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
