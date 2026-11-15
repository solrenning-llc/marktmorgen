/**
 * The name shown as an email's sender, checked as a reader sees it (Claude 7's outgoing-email audit and its security
 * reads, 15 November 2026).
 *
 * Refused: an address ("@"), an encoded word ("=?"), a direction override or isolate, letters of two alphabets in one
 * word, a link ("://", "www.", "mailto:", "data:"), a local host, an IP or hex address, a domain under a top-level
 * domain of the IANA root zone (written in lower or upper case: "paypal.com", "PAYPAL.COM"; "Ricardo.Dev" or "Jo.Me",
 * written as a name, is kept) or spelled out ("paypal dot com"); anything read as Marktmorgen or Solrenning, a mail
 * system (postmaster, mailer-daemon), or within one letter of "marktmorgen" (two letters side by side swapped count as
 * one); a payment, bank, tax, delivery or platform brand, also spelled one letter at a time or one letter off (brands
 * of six letters or more, never a common English word such as "Finance"), standing alone or only with words that pass
 * for its staff or its payments ("PayPal Security", "Stripe Receipts", "Microsoft 365", "UPS"), never a brand inside a
 * real business's name ("Wise Owl Tutoring", "Apple Support Group"); a brand that is also an everyday word (Visa, Wise,
 * Chase, Meta) only alone or with its payments' words, so "Visa Services" is kept; and the titles only a scam uses
 * ("Security Alert", "Security Team", "Billing Department", "IT Department", "Mail Delivery Subsystem", "Your Bank").
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
    .filter(Boolean)
    .reduce<string[]>((words, word, at, all) => {
      // Letters spelled one at a time ("P a y P a l") are read as the word they spell.
      if (word.length === 1 && at > 0 && all[at - 1].length === 1) words[words.length - 1] += word;
      else words.push(word);
      return words;
    }, []);
}

/** Whether two words are at most one letter apart (one added, removed or changed, or two side by side swapped). */
function nearlySame(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const differ = [...a].flatMap((c, at) => (c === b[at] ? [] : [at]));
    if (differ.length === 2 && differ[1] === differ[0] + 1 && a[differ[0]] === b[differ[1]] && a[differ[1]] === b[differ[0]]) return true;
  }
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

/** Payment, bank, tax, delivery and platform brands, as their letters run together. */
const BRANDS = [
  "paypal", "stripe", "apple", "icloud", "itunes", "google", "gmail", "amazon", "venmo", "zelle", "cashapp", "visa",
  "mastercard", "amex", "americanexpress", "shopify", "microsoft", "outlook", "docusign", "coinbase", "wise", "revolut",
  "chase", "wellsfargo", "irs", "usps", "fedex", "dhl", "ups", "meta", "facebook", "instagram", "netflix", "binance",
  "bankofamerica", "citi", "citibank", "hsbc", "barclays", "nubank", "itau", "bradesco", "santander", "bancodobrasil",
  "receitafederal", "steam", "gumroad", "kajabi", "patreon", "resend", "mailchimp", "etsy", "ebay", "discord", "tiktok",
  "adobe", "walmart",
];
/**
 * Brands that are also everyday words ("Visa Services" helps with travel visas, "Chase the Sun Tours"): refused alone or
 * only with the words of their payments (PAYMENT_STAFF), never with the other staff words.
 */
const EVERYDAY_BRANDS = new Set(["visa", "wise", "chase", "meta"]);
/** Common English words one letter off a brand: never read as that brand ("Finance" is not Binance). */
const COMMON_WORDS = new Set([
  "finance", "strive", "stride", "strife", "stripes", "discard", "discords", "resent", "resends", "goggle", "amazons",
  "outlooks", "patrons",
]);
/** Words that, beside a brand and nothing else, pass for its own staff or service. */
const STAFF = new Set([
  "security", "billing", "support", "id", "account", "accounts", "team", "service", "services", "alert", "alerts",
  "payment", "payments", "notification", "notifications", "notice", "verification", "verify", "help", "center", "centre",
  "official", "noreply", "no", "reply", "department", "fraud", "safety", "trust", "customer", "customers", "care", "pay",
  "wallet", "inc", "llc", "corp", "com", "net", "org", "io", "co", "the", "and", "of", "desk", "helpdesk", "online",
  "login", "signin", "secure", "update", "updates", "mail", "email", "admin", "refund", "refunds", "dispute", "disputes",
  "store", "shop", "prime", "bank", "banking", "card", "cards", "express", "delivery", "tracking", "shipping", "tax",
  "receipt", "receipts", "invoice", "invoices", "order", "orders", "payout", "payouts", "resolution", "statement",
  "statements", "workspace", "informed", "purchase", "purchases", "subscription", "subscriptions", "renewal",
  "membership", "premium", "business", "message", "messages", "ads", "drive", "one", "plus", "alerts", "records",
]);
/** The words of a brand's payments: the only ones that, beside an everyday brand (EVERYDAY_BRANDS), make it a claim. */
const PAYMENT_STAFF = new Set([
  "card", "cards", "payment", "payments", "pay", "billing", "security", "fraud", "account", "accounts", "id", "bank",
  "banking", "wallet", "alert", "alerts", "verification", "verify", "login", "signin", "secure", "refund", "refunds",
  "dispute", "disputes", "receipt", "receipts", "invoice", "invoices", "noreply", "official", "payout", "payouts",
]);

/**
 * Whether a word (or words run together) is a brand: the brand itself, or one letter off a brand of six letters or
 * more when the word is at least as long and is not a common English word (COMMON_WORDS).
 */
function brandOf(joined: string, single: boolean): string | null {
  for (const name of BRANDS) {
    if (joined === name) return name;
    if (single && name.length >= 6 && joined.length >= name.length && !COMMON_WORDS.has(joined) && nearlySame(joined, name)) return name;
  }
  return null;
}

/**
 * A brand alone, or a brand only with words that pass for its staff (STAFF, or a short word such as the "365" of
 * "Microsoft 365"); an everyday brand only alone or with the words of its payments.
 */
function claimsBrand(words: string[]): boolean {
  const rest: string[] = [];
  const found: string[] = [];
  for (let at = 0; at < words.length; ) {
    let taken = 0;
    for (let count = 1; count <= 4 && at + count <= words.length && !taken; count += 1) {
      const name = brandOf(words.slice(at, at + count).join(""), count === 1);
      if (name) {
        taken = count;
        found.push(name);
      }
    }
    if (taken) at += taken;
    else {
      rest.push(words[at]);
      at += 1;
    }
  }
  if (!found.length) return false;
  const everyday = found.every((name) => EVERYDAY_BRANDS.has(name));
  return rest.every((word) => (everyday ? PAYMENT_STAFF.has(word) : STAFF.has(word) || word.length <= 2));
}

/** The phrases only a scam uses as a sender's name. */
const SCAM = new RegExp(
  "(?:^| )(?:" +
    [
      "security alerts?", "security team", "account security", "fraud (?:department|team|alert)", "account services",
      "trust (?:and )?safety", "no ?reply", "do not reply", "your bank", "billing (?:team|department)",
      "payment services", "verification team", "it department", "compliance team", "mail delivery subsystem",
    ].join("|") +
    ")(?: |$)",
);

/** A link, an IP address, or a domain under a real top-level domain written as one (lower or upper case). */
function looksLikeAddress(text: string): boolean {
  if (/:\/\/|\bwww\./i.test(text)) return true;
  // A local host, a bracketed or hex address, a link scheme without slashes, or a domain spelled out ("paypal dot com").
  if (/\blocalhost\b|\[[0-9a-f:.]*\]|\b0x[0-9a-f]{6,}\b|\b(?:mailto|data|javascript|file|tel|sms):/i.test(text)) return true;
  if (/[\p{L}\p{N}]\s*[([]?\s*\bdot\b\s*[)\]]?\s*(?:com|net|org|io|co|gov|edu|info|biz|us|uk|de|br)\b/iu.test(text)) return true;
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
