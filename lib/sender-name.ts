/**
 * The name shown as an email's sender, checked as a reader sees it (Claude 7's outgoing-email audit and its security
 * reads, 15 November 2026).
 *
 * Refused: an address ("@"), an encoded word ("=?"), a direction override or isolate, letters of two alphabets in one
 * word, a link ("://", "www."), an IP address, a domain under a top-level domain of the IANA root zone (written in
 * lower or upper case: "paypal.com", "PAYPAL.COM"; "Ricardo.Dev" or "Jo.Me", written as a name, is kept); anything
 * read as Marktmorgen or Solrenning, a mail system (postmaster, mailer-daemon), or within one letter of "marktmorgen";
 * a payment, bank, delivery or platform brand standing alone or only with words that pass for its staff ("PayPal
 * Security", "Stripe Billing", "Apple ID", "UPS"), never a brand inside a real business's name ("Wise Owl Tutoring",
 * "Apple Support Group", "Google Ads Masterclass"); and the phrases only a scam uses ("Security Alert", "Fraud
 * Department", "Account Services", "Trust & Safety", "noreply", "Your Bank").
 *
 * Kept on purpose (decision recorded in the commit): generic words a real business uses alone, such as "Support",
 * "Billing", "Admin", "Help Desk" or "Customer Service", and dotted names that are not domains ("Node.js", "Mr.Smith").
 *
 * What is compared is a skeleton of the name: NFKC, small capitals and the Latin alpha as plain letters, Cyrillic and
 * Greek look-alikes as Latin, accents removed, the digits and signs that pass for letters (0 o, 1 l, 3 e, 4 a, 5 s,
 * 7 t, $ s, | l, a capital I after a small letter l) and "rn" as "m".
 */
import { mixedScriptWord } from "@/lib/ad-creative-check";
import { IANA_TLDS } from "@/lib/iana-tlds";

/**
 * Characters a reader never sees, removed: zero-width space, word joiner and invisible operators, byte order mark, soft
 * hyphen, combining grapheme joiner, fillers, Mongolian selectors, tags. Not the joiners emoji and Persian are made of
 * (U+200C, U+200D), as lib/ad-creative-check.ts keeps them.
 */
const INVISIBLE = /[\u200B\u2060-\u2064\uFEFF\u00AD\u034F\u115F\u1160\u3164\u180B-\u180F]|[\u{E0000}-\u{E007F}]/gu;
/** Direction overrides, embeddings and isolates: a name holding one can read backwards. Plain direction marks are kept. */
const DIRECTION = /[\u202A-\u202E\u2066-\u2069]/u;
/** Top-level domains a name uses with a dot that are not domains there ("Node.js"). */
const NOT_DOMAINS = new Set(["js", "ts", "py", "rb"]);

const LOOK_ALIKES: Record<string, string> = {
  // Small capitals and other Latin letters that read as plain ones.
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n",
  ᴏ: "o", ᴘ: "p", ǫ: "q", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z", ɑ: "a", ɡ: "g", ı: "i", ȷ: "j",
  // Cyrillic.
  а: "a", в: "b", с: "c", ԁ: "d", е: "e", һ: "h", і: "i", ј: "j", к: "k", ӏ: "l", м: "m", н: "h", о: "o", р: "p",
  ԛ: "q", ѕ: "s", т: "t", у: "y", х: "x", ԝ: "w", ү: "y", ɩ: "i",
  // Greek.
  α: "a", β: "b", ϲ: "c", ε: "e", η: "n", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
  ω: "w", γ: "y", ζ: "z",
  // Digits and signs.
  "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", $: "s", "|": "l",
};

/** The name as compared: the letters only, lower case, look-alikes read as the letter they pass for, words kept apart. */
function skeleton(text: string): string[] {
  const read = [...text.normalize("NFKC").replace(/(?<=\p{Ll})I/gu, "l").toLowerCase()].map((c) => LOOK_ALIKES[c] ?? c).join("");
  return read
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/rn/g, "m")
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
}

/** Whether two words are at most one letter apart (one added, removed or changed). */
function nearlySame(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Ours and the mail system's own names: refused wherever they are, with spaces, dots and dashes ignored. */
const OURS_OR_SYSTEM = ["marktmorgen", "solrenning", "postmaster", "mailerdaemon"];

function claimsOurs(letters: string): boolean {
  if (OURS_OR_SYSTEM.some((word) => letters.includes(word))) return true;
  for (let size = 10; size <= 12; size += 1) {
    for (let at = 0; at + size <= letters.length; at += 1) {
      if (nearlySame(letters.slice(at, at + size), "marktmorgen")) return true;
    }
  }
  return false;
}

/** Payment, bank, delivery and platform brands, as their letters run together. */
const BRANDS = [
  "paypal", "stripe", "apple", "icloud", "itunes", "google", "gmail", "amazon", "venmo", "zelle", "cashapp", "visa",
  "mastercard", "amex", "americanexpress", "shopify", "microsoft", "outlook", "docusign", "coinbase", "wise", "revolut",
  "chase", "wellsfargo", "irs", "usps", "fedex", "dhl", "ups", "meta", "facebook", "instagram", "netflix", "binance",
];
/** Words that, beside a brand and nothing else, pass for its own staff or service. */
const STAFF = new Set([
  "security", "billing", "support", "id", "account", "accounts", "team", "service", "services", "alert", "alerts",
  "payment", "payments", "notification", "notifications", "notice", "verification", "verify", "help", "center", "centre",
  "official", "noreply", "no", "reply", "department", "fraud", "safety", "trust", "customer", "customers", "care", "pay",
  "wallet", "inc", "llc", "corp", "com", "net", "org", "io", "co", "the", "and", "of", "desk", "helpdesk", "online",
  "login", "signin", "secure", "update", "updates", "mail", "email", "admin", "refund", "refunds", "dispute", "disputes",
  "store", "shop", "prime", "bank", "banking", "card", "cards", "express", "delivery", "tracking", "shipping",
]);

/** A brand alone, or a brand only with words that pass for its staff. */
function claimsBrand(words: string[]): boolean {
  const rest: string[] = [];
  let brand = false;
  for (let at = 0; at < words.length; ) {
    let taken = 0;
    for (let count = 1; count <= 3 && at + count <= words.length && !taken; count += 1) {
      const joined = words.slice(at, at + count).join("");
      if (BRANDS.some((name) => joined === name || (name.length >= 5 && count === 1 && nearlySame(joined, name)))) taken = count;
    }
    if (taken) {
      brand = true;
      at += taken;
    } else {
      rest.push(words[at]);
      at += 1;
    }
  }
  return brand && rest.every((word) => STAFF.has(word));
}

/** The phrases only a scam uses as a sender's name. */
const SCAM = /(?:^| )(?:security alerts?|fraud (?:department|team|alert)|account services|trust (?:and )?safety|no ?reply|do not reply|your bank)(?: |$)/;

/** A link, an IP address, or a domain under a real top-level domain written as one (lower or upper case). */
function looksLikeAddress(text: string): boolean {
  if (/:\/\/|\bwww\./i.test(text)) return true;
  if (/(?:^|[^\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/.test(text)) return true;
  if (/[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){3,7}/i.test(text) && /::|(?:[0-9a-f]+:){3}/i.test(text)) return true;
  for (const [, tld] of text.matchAll(/[\p{L}\p{N}-]\.(\p{L}{2,})(?![\p{L}\p{N}])/gu)) {
    const lower = tld.toLowerCase();
    if (!IANA_TLDS.has(lower) || NOT_DOMAINS.has(lower)) continue;
    if (tld === lower || tld === tld.toUpperCase()) return true;
  }
  return false;
}

/** The name as it would be shown: what a reader sees, without quotes, angle brackets or line breaks, 60 at most. */
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

/** True when the name can be shown as an email's sender. */
export function senderNameOk(name: string): boolean {
  if (DIRECTION.test(name) || name.includes("=?")) return false;
  const t = cleaned(name);
  if (t === "" || t.includes("@") || t.includes("=?") || looksLikeAddress(t) || mixedScriptWord(t)) return false;
  const words = skeleton(t);
  if (claimsOurs(words.join(""))) return false;
  if (claimsBrand(words)) return false;
  return !SCAM.test(words.join(" "));
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
