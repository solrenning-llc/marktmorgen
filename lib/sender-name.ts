/**
 * The name shown as an email's sender, checked as a reader sees it (Claude 7's outgoing-email audit and its security
 * read, 15 November 2026). A name is read after NFKC (so "＠" is "@" and "．" is "."), with the ideographic full stop
 * read as a dot and the characters that hide inside words removed. It is refused when it holds an address, a real
 * domain, an encoded word ("=?"), a direction override, letters of two alphabets in one word, or claims to be
 * Marktmorgen, a payment or platform brand, or a mail system. Generic words a real business uses ("Support", "Help
 * Desk", "Customer Service") and names with a dot that are not domains ("Node.js", "Mr.Smith") are kept.
 */
import { mixedScriptWord } from "@/lib/ad-creative-check";

/** Characters a reader never sees: zero-width ones, joiners, the byte order mark, the soft hyphen, tags. */
const INVISIBLE = /[\u200B-\u200D\u2060-\u2064\uFEFF\u00AD\u034F\u115F\u1160\u3164\u180B-\u180F]|[\u{E0000}-\u{E007F}]/gu;
/** Direction overrides, embeddings and isolates, and the direction marks: a name holding one can read backwards. */
const DIRECTION = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;
/** Top-level domains a reader takes for a real address. A dot before anything else ("Node.js", "Mr.Smith") is kept. */
const TLDS = [
  "com", "net", "org", "io", "co", "ai", "app", "dev", "info", "biz", "me", "us", "uk", "eu", "de", "fr", "es", "it",
  "nl", "br", "ca", "au", "in", "jp", "cn", "ru", "gov", "edu", "mil", "int", "shop", "store", "online", "site", "xyz",
  "email", "mail", "support", "help", "pay", "money", "bank", "cloud", "tech", "page", "link", "live", "tv", "ly", "gg",
];
const DOMAIN = new RegExp(`[\\p{L}\\p{N}-]\\.(?:${TLDS.join("|")})(?![\\p{L}\\p{N}])`, "iu");
/** Names that claim to be us or a mail system, matched with spaces, dots, dashes, accents and 0-for-o removed. */
const OURS_OR_SYSTEM = ["marktmorgen", "solrenning", "postmaster", "mailerdaemon", "paypal"];
/** Payment and platform brands, matched as whole words. */
const BRANDS = /\b(?:stripe|apple\s*(?:id|pay|support)|icloud|itunes|google|gmail|amazon|venmo|zelle|cash\s*app|visa|mastercard|amex|american\s*express|shopify|microsoft|outlook|docusign|coinbase|wise|revolut)\b/iu;

/** The name as it would be shown: read as a reader sees it, without quotes, angle brackets or line breaks, 60 at most. */
function cleaned(name: string): string {
  return name
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/[\u3002\uFF61]/g, ".")
    .replace(/["\\<>\r\n\u0000-\u001f\u007f\u2028\u2029]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

/** The letters only, lower case, without accents, with 0 read as o and 1 as l. */
function compact(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/[^\p{L}]/gu, "");
}

/** True when the name can be shown as an email's sender. */
export function senderNameOk(name: string): boolean {
  if (DIRECTION.test(name) || name.includes("=?")) return false;
  const t = cleaned(name);
  if (t === "" || t.includes("@") || t.includes("=?") || DOMAIN.test(t) || mixedScriptWord(t)) return false;
  const letters = compact(t);
  if (OURS_OR_SYSTEM.some((word) => letters.includes(word))) return false;
  return !BRANDS.test(t.normalize("NFD").replace(/\p{M}/gu, ""));
}

/**
 * The name, when it can be shown; else the fallback, when that can ("@handle" is checked without its "@"); else
 * "A store". The fallback is never shown unchecked.
 */
export function safeSenderName(name: string, fallback: string): string {
  if (senderNameOk(name)) return cleaned(name);
  const stand = fallback.startsWith("@") ? fallback.slice(1) : fallback;
  return senderNameOk(stand) ? cleaned(fallback) : "A store";
}
