/**
 * Challenges for affiliates (384 [TB10], unit 1): the pure rules.
 *
 * A creator sets a period, a goal or a number of winning places, and a prize
 * of their own (a product, access or a coupon). The standings are worked out
 * from the affiliate book the affiliates page already reads
 * (lib/affiliates.ts readBook), so a challenge adds no read, no write and no
 * call of its own:
 *
 *   - only a paid sale an affiliate brought counts (a click, a code, a buyer
 *     who stays theirs, a buyer who was their lead), inside the dates, of a listed
 *     product when the creator lists some. A renewal, a partner's share, a
 *     bonus, the second tier and a lead are not new sales;
 *   - the book already counts refunds and disputes from the creator's Stripe
 *     account, so a refunded or disputed sale is off, and a refund that comes
 *     after the end takes the sale off too. The count is of whole sales only:
 *     a sale refunded in part is off as well, never counted as a share of a
 *     sale, and the page says so. A book whose refunds could not be checked
 *     gives no standings at all, never a guess;
 *   - the affiliate's own purchase never counts; an affiliate who is not
 *     approved, who is held for the creator to look at (a shared address,
 *     paid search clicks) or whom the creator left out is not placed;
 *   - on the same number of sales, who got there first is ahead; the same
 *     number at the same second shares the place, and a shared winning
 *     place wins for everybody on it;
 *   - another affiliate is shown by the name they chose for the board, only
 *     when they chose one, and never by their address; a name the board uses
 *     itself ("You", "An affiliate") cannot be chosen, nor a look-alike of one;
 *   - the title and the prize say no money and promise no earnings: a
 *     currency sign or money emoji, an amount with a currency code or name,
 *     cash, transfers, cheques, vouchers, store credit, payment services,
 *     gift cards, "guaranteed" and "earn" are refused, checked after
 *     full-width forms, accents, hidden characters, look-alike letters and
 *     digits for letters are set aside. A title or a prize with a hidden
 *     character (outside an emoji) or a word in mixed scripts is refused.
 *
 * Marktmorgen holds no money and pays no prize: the prize is the creator's,
 * given by them. Nothing here changes a commission, a rate or a payout.
 */
import type { Book, Credit, LineStatus, Row } from "@/lib/affiliates";

/** The longest title, in characters. */
export const CHALLENGE_MAX_TITLE = 80;
/** The shortest challenge is a day; the longest is about three months. */
export const CHALLENGE_MIN_DAYS = 1;
export const CHALLENGE_MAX_DAYS = 92;
/** How far ahead a challenge may start, in days. */
export const CHALLENGE_MAX_LEAD_DAYS = 365;
/**
 * Days after the end to wait before handing out prizes. Most refund windows
 * are 30 days or less; a refund or a chargeback after that still takes a
 * sale off, and the page says so.
 */
export const CHALLENGE_SETTLE_DAYS = 30;
/** The most winning places, and the highest goal. */
export const CHALLENGE_MAX_PLACES = 10;
export const CHALLENGE_MAX_GOAL = 10_000;
/** The most products a challenge can be limited to. */
export const CHALLENGE_MAX_PRODUCTS = 50;
/** The longest prize description, in characters. */
export const CHALLENGE_MAX_PRIZE = 120;
/** The most affiliates a challenge can leave out: every affiliate a store can have (lib/affiliate-setting.ts MAX_AFFILIATES). */
export const CHALLENGE_MAX_EXCLUDED = 1_000;
/** How many rows the board shows by default. */
export const CHALLENGE_BOARD_ROWS = 10;

const DAY = 86_400;
/** Seconds since 1970 stay below this until the year 5138; milliseconds never do. */
const SECONDS_CEILING = 100_000_000_000;

/** What the prize is: always the creator's own. There is no cash kind: Marktmorgen pays no prize. */
export type PrizeKind = "product" | "access" | "coupon";
const PRIZE_KINDS: readonly PrizeKind[] = ["product", "access", "coupon"];

export type ChallengePrize = { kind: PrizeKind; label: string };

export type Challenge = {
  title: string;
  /** First second it counts, and the second it stops (not counted), in seconds. */
  start: number;
  end: number;
  /** Sales that win on their own; 0 for none. */
  goal: number;
  /** How many top places win; 0 for none. */
  places: number;
  /** Product ids whose sales count; empty for every product. */
  products: string[];
  prize: ChallengePrize;
  /** Affiliates the creator left out of this challenge. */
  excluded?: string[];
};

export type ChallengeProblem = "title" | "dates" | "winners" | "prize" | "products" | "excluded" | "money";

export type ChallengePhase = "upcoming" | "running" | "settling" | "over";

export type Standing = {
  aff: string;
  sales: number;
  /** When they reached their count: the time of their last counted sale, in seconds. */
  reachedAt: number;
  place: number;
  wins: boolean;
};

export type BoardRow = { place: number; label: string; sales: number; you: boolean; wins: boolean };

/** The sales an affiliate brought, as the book credits them. */
const BROUGHT_NEW: readonly Credit[] = ["click", "code", "buyer", "contact"];
/** The book state of a sale that was paid and kept whole; a sale refunded in part is not a whole sale. */
const KEPT: readonly LineStatus[] = ["earned"];

const LINK = /https?:|:\/\/|www\./i;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The book's own affiliate id shape (lib/affiliates.ts AFFILIATE_ID_PATTERN), kept here so this file reads nothing. */
const AFFILIATE_ID = /^[0-9a-f]{12}$/;

/**
 * ISO 4217 codes (as Intl.supportedValuesOf("currency") lists them on
 * 7 November 2026), less the ones that are everyday words or names
 * (ALL, AMD, BAM, BOB, CUP, GEL, MAD, MOP, PEN, PHP, RON, SOS, TOP, TRY), so
 * "Top 3" or "My PHP 8 course" still pass. A code counts as money next to a
 * number, in either order, with or without a space.
 */
const CURRENCY_CODES =
  "AED AFN ANG AOA ARS AUD AWG AZN BBD BDT BGN BHD BIF BMD BND BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MDL MGA MKD MMK MNT MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PGK PKR PLN PYG QAR RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SRD SSP STN SVC SYP SZL THB TJS TMT TND TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XDR XOF XPF XSU YER ZAR ZMW ZWG ZWL".split(" ");
/** The codes of the currencies most often written alone ("paid in USD"), which are never everyday words. */
const MAJOR_CODES = "USD EUR GBP BRL JPY CHF AUD NZD MXN INR CNY HKD SGD ZAR SEK NOK DKK PLN KRW".split(" ");
/** An amount in any decimal digits (NFKC has already turned full-width digits into ASCII ones). */
const AMOUNT = "\\p{Nd}[\\p{Nd},.]*";
/** "CAD" is also computer-aided design: "3 CAD templates" is a product, "100 CAD" is money. */
const CAD_WORK = "templates?|files?|models?|drawings?|designs?|courses?|lessons?|tutorials?|projects?|exercises?|parts?";
const CODE_NEXT_TO_AMOUNT = new RegExp(
  `(?<![\\p{L}])(?:${CURRENCY_CODES.join("|")}) ?${AMOUNT}(?![\\p{Nd}])(?:[kmb](?![\\p{L}])|(?![\\p{L}]))` +
    `|${AMOUNT}[kmb]? ?(?:${CURRENCY_CODES.map((c) => (c === "CAD" ? `CAD(?! (?:${CAD_WORK})(?![\\p{L}]))` : c)).join("|")})(?![\\p{L}])`,
  "iu",
);
/**
 * Currency names that are also everyday words or names (a pound of coffee, Penny Lane): money
 * only right after an amount, and not after "lose 10" or before "of".
 */
const AMOUNT_NAMES = new RegExp(
  `(?<![\\p{L}\\p{N}]|(?:lose|loses|lost|losing|drop|drops|dropped|shed|sheds|weigh|weighs|weighed|gain|gains|gained) )${AMOUNT}[kmb]? ?(?:pounds?|yen|rands?|franc|penny)(?![\\p{L}])(?! (?:of|lighter|heavier|down|off)(?![\\p{L}]))`,
  "iu",
);
/** Words that pay through Wise or Stripe; the names alone are everyday words ("wise words", "a stripe"). */
const PAID_THROUGH = "paid|pay|pays|paying|payment|payments|sent|send|sends|sending|via|by|through|using|with|on|over";
/**
 * Money, ways to pay or hand over money, and promises of earnings, as whole words in any case,
 * each in its closed forms (no open endings, so "cashmere", "Earnest" and "Transferable" pass).
 */
const MONEY_WORDS = new RegExp(
  `(?<![\\p{L}])(?:${[
    ...MAJOR_CODES,
    // cash, money, transfers
    "cash(?:es|ed|ing|back|backs|out|outs|ier|iers)?",
    "money",
    "moneys",
    "monies",
    "transfer(?:s|red|ring)?",
    "wire",
    "deposits?",
    "cheques?",
    `checks? (?:for|of|worth) ${AMOUNT}`,
    "(?:bank|personal|paper|certified|traveller'?s|traveler'?s) checks?",
    // vouchers and stored value
    "gift[ -]?cards?",
    "gift[ -]?certificates?",
    "vouchers?",
    "(?:store|shop|account|wallet|site) credits?",
    "prepaid (?:cards?|debit|visa|mastercard|balance)",
    // payment services
    "paypal",
    "venmo",
    "zelle",
    "payoneer",
    "revolut",
    "skrill",
    "neteller",
    "remitly",
    "western union",
    "moneygram",
    "alipay",
    "picpay",
    "interac",
    "pix",
    "mercado[ -]?pago",
    "(?:apple|google|samsung|amazon|wechat)[ -]?pay",
    `(?:${PAID_THROUGH}) (?:wise|stripe)`,
    "(?:wise|stripe) (?:accounts?|balance|cards?|credits?|payouts?)",
    // crypto
    "bitcoins?",
    "btc",
    "crypto(?:currenc(?:y|ies))?",
    "usdt",
    "usdc",
    "ethereum",
    "dogecoin",
    "litecoin",
    // currency names that are no everyday word
    "(?:us|usd|au|aud|ca|cad|nz|nzd|hk|hkd|sg|sgd)?dollars?",
    "bucks",
    "cents",
    "pence",
    "quid",
    "euros?",
    "eurocents?",
    "reais",
    "yuan",
    "renminbi",
    "rmb",
    "rupees?",
    "rupiahs?",
    "pesos?",
    "francs",
    "rubles?",
    "roubles?",
    "lira",
    "liras",
    "lire",
    "dinars?",
    "dirhams?",
    "riyals?",
    "rials?",
    "shekels?",
    "zloty",
    "zlotys",
    "korunas?",
    "kronor",
    "kroner",
    "kronur",
    "forints?",
    "baht",
    "ringgits?",
    "nairas?",
    "cedis?",
    "shillings?",
    "hryvnias?",
    "kwacha",
    // earnings
    "payouts?",
    "income",
    "profits?",
    "salary",
    "salaries",
    "commissions?",
    "guarantee(?:s|d|ing)?",
    "earn(?:s|ed|ing|ings|er|ers)?",
  ].join("|")})(?![\\p{L}])`,
  "iu",
);
/** Emoji that show money: money bag to money with wings, chart with yen, money-mouth face, coin, bank, ATM. */
const MONEY_EMOJI = /[\u{1F4B0}-\u{1F4B9}\u{1F911}\u{1FA99}\u{1F3E6}\u{1F3E7}]/u;

/**
 * Characters that show nothing: controls, format characters (zero-width spaces and joiners,
 * soft hyphens, direction marks, isolates and overrides) and the rest Unicode calls
 * default-ignorable (variation selectors, Hangul fillers).
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{DI}]/u;
const HIDDEN_ALL = /[\p{Cc}\p{Cf}\p{DI}]/gu;
/** The only hidden characters a title or a prize may have: the variation selector and the joiner inside an emoji (a red heart with U+FE0F, a woman and a laptop joined by U+200D). */
const EMOJI_JOINERS =
  /(?<=[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}])[\uFE0E\uFE0F]|(?<=[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}][\uFE0E\uFE0F]?)\u200D(?=\p{Extended_Pictographic})/gu;

/**
 * Cyrillic, Greek and Armenian letters that look like Latin ones, mapped to the Latin letter
 * they imitate, so "cash" written all in Cyrillic letters still reads as "cash". Only for checking:
 * what the creator typed is kept as typed.
 */
const LOOK_ALIKE: Readonly<Record<string, string>> = {
  // Cyrillic
  "\u0430": "a", "\u0410": "A", "\u0412": "B", "\u044C": "b", "\u0441": "c", "\u0421": "C", "\u0501": "d",
  "\u0435": "e", "\u0415": "E", "\u04BB": "h", "\u041D": "H", "\u0456": "i", "\u0406": "I", "\u04C0": "I",
  "\u0458": "j", "\u0408": "J", "\u043A": "k", "\u041A": "K", "\u04CF": "l", "\u041C": "M", "\u043E": "o",
  "\u041E": "O", "\u0440": "p", "\u0420": "P", "\u051B": "q", "\u051A": "Q", "\u0455": "s", "\u0405": "S",
  "\u0422": "T", "\u051D": "w", "\u051C": "W", "\u0445": "x", "\u0425": "X", "\u0443": "y", "\u0423": "Y",
  "\u04AF": "y", "\u04AE": "Y",
  // Greek
  "\u03B1": "a", "\u0391": "A", "\u0392": "B", "\u03F2": "c", "\u03F9": "C", "\u0395": "E", "\u0397": "H",
  "\u03B9": "i", "\u0399": "I", "\u03F3": "j", "\u037F": "J", "\u03BA": "k", "\u039A": "K", "\u039C": "M",
  "\u039D": "N", "\u03BD": "v", "\u03BF": "o", "\u039F": "O", "\u03C1": "p", "\u03A1": "P", "\u03C4": "t",
  "\u03A4": "T", "\u03C5": "u", "\u03C7": "x", "\u03A7": "X", "\u03B3": "y", "\u03A5": "Y", "\u0396": "Z",
  // Armenian
  "\u0581": "g", "\u0570": "h", "\u0578": "n", "\u0585": "o", "\u0566": "q", "\u057D": "u",
};

/** What a text says once its look is set aside: compatibility forms folded (NFKC), hidden characters and accents dropped, look-alike letters read as Latin. */
function fold(text: string): string {
  const bare = text.normalize("NFKC").replace(HIDDEN_ALL, "").normalize("NFD").replace(/\p{M}/gu, "");
  return Array.from(bare, (ch) => LOOK_ALIKE[ch] ?? ch).join("").normalize("NFKC");
}

/** Digits written for letters inside a word ("m0ney", "c4sh"), read as the letters; a "1" is tried as both "i" and "l". */
function lettersForDigits(text: string, one: "i" | "l"): string {
  const as: Record<string, string> = { "0": "o", "1": one, "3": "e", "4": "a", "5": "s", "7": "t" };
  return text.replace(/[\p{L}\p{N}]+/gu, (w) => (/\p{L}/u.test(w) && /\p{N}/u.test(w) ? w.replace(/[013457]/g, (d) => as[d]) : w));
}

/** Whether free text says money or promises earnings: a currency sign or emoji, an amount with a code or a currency name, or a money word. */
function saysMoney(text: string): boolean {
  if (/\p{Sc}/u.test(text) || MONEY_EMOJI.test(text)) return true;
  const plain = fold(text);
  if (/\p{Sc}/u.test(plain) || CODE_NEXT_TO_AMOUNT.test(plain) || AMOUNT_NAMES.test(plain)) return true;
  return [plain, lettersForDigits(plain, "i"), lettersForDigits(plain, "l")].some((w) => MONEY_WORDS.test(w));
}

/**
 * Scripts a letter can belong to. A word may use one script, or Latin with Han and the
 * Japanese kana, Latin with Han and Bopomofo, or Latin with Han and Hangul (Unicode
 * UTS #39, "highly restrictive"); any other mix, such as Latin with a Cyrillic "o" (U+043E), is
 * refused. A letter of a script not listed counts as "Other".
 */
const SCRIPTS: readonly (readonly [string, RegExp])[] = [
  "Latin", "Greek", "Cyrillic", "Armenian", "Hebrew", "Arabic", "Syriac", "Thaana", "Nko", "Devanagari", "Bengali", "Gurmukhi",
  "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan", "Myanmar", "Georgian",
  "Hangul", "Ethiopic", "Cherokee", "Canadian_Aboriginal", "Khmer", "Mongolian", "Hiragana", "Katakana", "Bopomofo", "Han",
  "Yi", "Lisu", "Vai", "Coptic", "Tifinagh", "Adlam", "Osage", "Deseret",
].map((name) => [name, new RegExp(`\\p{Script=${name}}`, "u")] as const);
const MIXES_ALLOWED: readonly ReadonlySet<string>[] = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]),
  new Set(["Latin", "Han", "Bopomofo"]),
  new Set(["Latin", "Han", "Hangul"]),
];
function scriptOf(letter: string): string | null {
  if (/[\p{Script=Common}\p{Script=Inherited}]/u.test(letter)) return null;
  for (const [name, re] of SCRIPTS) if (re.test(letter)) return name;
  return "Other";
}
function mixesScripts(text: string): boolean {
  const bare = text.normalize("NFKC").replace(HIDDEN_ALL, "").normalize("NFD").replace(/\p{M}/gu, "");
  for (const word of bare.match(/\p{L}+/gu) ?? []) {
    const used = new Set<string>();
    for (const letter of word) {
      const s = scriptOf(letter);
      if (s) used.add(s);
    }
    if (used.size > 1 && !MIXES_ALLOWED.some((ok) => [...used].every((s) => ok.has(s)))) return true;
  }
  return false;
}

/** Whether a title or a prize hides what it says: a hidden character outside an emoji, or a word in mixed scripts. */
function hidesLetters(text: string): boolean {
  return HIDDEN.test(text.normalize("NFKC").replace(EMOJI_JOINERS, "")) || mixesScripts(text);
}

/** How a board name is compared with the reserved ones: folded, letters and numbers only, lower case, with "rn" read as "m", "1" and "i" as "l", and "0" as "o". */
const boardKey = (text: string): string =>
  fold(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").replace(/rn/g, "m").replace(/[1i]/g, "l").replace(/0/g, "o");
/** Names the board uses itself. */
const RESERVED_NAMES = new Set(["You", "An affiliate", "Affiliate", "Marktmorgen"].map(boardKey));

const tidy = (raw: unknown): string => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "");
const whole = (raw: unknown, min: number, max: number): number | null =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= min && raw <= max ? raw : null;

/** A challenge as the creator typed it, checked; anything unknown is refused, never guessed. */
export function readChallenge(raw: unknown, nowMs: number): { ok: true; challenge: Challenge } | { ok: false; problem: ChallengeProblem } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "title" };
  const value = raw as Record<string, unknown>;

  const title = tidy(value.title);
  if (!title || title.length > CHALLENGE_MAX_TITLE) return { ok: false, problem: "title" };
  if (saysMoney(title)) return { ok: false, problem: "money" };
  if (hidesLetters(title)) return { ok: false, problem: "title" };

  const now = Math.floor(nowMs / 1000);
  const start = whole(value.start, 1, SECONDS_CEILING);
  const end = whole(value.end, 1, SECONDS_CEILING);
  if (
    start === null ||
    end === null ||
    end - start < CHALLENGE_MIN_DAYS * DAY ||
    end - start > CHALLENGE_MAX_DAYS * DAY ||
    end <= now ||
    start > now + CHALLENGE_MAX_LEAD_DAYS * DAY
  ) {
    return { ok: false, problem: "dates" };
  }

  const goal = value.goal === undefined || value.goal === null ? 0 : whole(value.goal, 0, CHALLENGE_MAX_GOAL);
  const places = value.places === undefined || value.places === null ? 0 : whole(value.places, 0, CHALLENGE_MAX_PLACES);
  if (goal === null || places === null || (goal === 0 && places === 0)) return { ok: false, problem: "winners" };

  const prizeRaw = value.prize;
  if (!prizeRaw || typeof prizeRaw !== "object" || Array.isArray(prizeRaw)) return { ok: false, problem: "prize" };
  const kind = (prizeRaw as Record<string, unknown>).kind;
  const label = tidy((prizeRaw as Record<string, unknown>).label);
  if (
    typeof kind !== "string" ||
    !(PRIZE_KINDS as readonly string[]).includes(kind) ||
    !label ||
    label.length > CHALLENGE_MAX_PRIZE ||
    LINK.test(label) ||
    LINK.test(label.normalize("NFKC")) ||
    /[<>]/.test(label.normalize("NFKC"))
  ) {
    return { ok: false, problem: "prize" };
  }
  if (saysMoney(label)) return { ok: false, problem: "money" };
  if (hidesLetters(label)) return { ok: false, problem: "prize" };

  let products: string[] = [];
  if (value.products !== undefined && value.products !== null) {
    if (!Array.isArray(value.products) || value.products.length > CHALLENGE_MAX_PRODUCTS) return { ok: false, problem: "products" };
    if (!value.products.every((p) => typeof p === "string" && PRODUCT_ID.test(p))) return { ok: false, problem: "products" };
    products = [...new Set(value.products as string[])];
  }

  let excluded: string[] | undefined;
  if (value.excluded !== undefined && value.excluded !== null) {
    if (!Array.isArray(value.excluded) || value.excluded.length > CHALLENGE_MAX_EXCLUDED) return { ok: false, problem: "excluded" };
    if (!value.excluded.every((a) => typeof a === "string" && AFFILIATE_ID.test(a))) return { ok: false, problem: "excluded" };
    excluded = [...new Set(value.excluded as string[])];
  }

  const challenge: Challenge = { title, start, end, goal, places, products, prize: { kind: kind as PrizeKind, label } };
  if (excluded) challenge.excluded = excluded;
  return { ok: true, challenge };
}

/** Where a challenge is in time. */
export function challengePhase(c: Pick<Challenge, "start" | "end">, nowMs: number): ChallengePhase {
  const now = Math.floor(nowMs / 1000);
  if (now < c.start) return "upcoming";
  if (now < c.end) return "running";
  if (now < c.end + CHALLENGE_SETTLE_DAYS * DAY) return "settling";
  return "over";
}

/**
 * The standings, from the book as it reads today. `review` lists the
 * approved affiliates who would be placed but are held for the creator to
 * look at, so the creator can see why they are missing.
 */
export function challengeStandings(
  c: Challenge,
  book: Pick<Book, "lines" | "rows" | "refundsChecked">,
): { ok: true; standings: Standing[]; review: string[] } | { ok: false; problem: "refunds" } {
  if (book.refundsChecked !== true) return { ok: false, problem: "refunds" };
  const approved = new Map<string, Row>();
  for (const r of book.rows) if (r.affiliate.status === "approved") approved.set(r.affiliate.id, r);
  const excluded = new Set(c.excluded ?? []);
  const products = new Set(c.products);

  // One payment is one sale, however many times it shows on the book.
  const seen = new Set<string>();
  const sold = new Map<string, { sales: number; reachedAt: number }>();
  for (const line of book.lines) {
    if (!BROUGHT_NEW.includes(line.how) || line.self || !KEPT.includes(line.status)) continue;
    if (line.refunded !== 0 || !(line.base > 0)) continue;
    if (!(line.at >= c.start && line.at < c.end)) continue;
    if (products.size && !products.has(line.product)) continue;
    if (!approved.has(line.aff) || excluded.has(line.aff)) continue;
    if (seen.has(line.ref)) continue;
    seen.add(line.ref);
    const so = sold.get(line.aff);
    sold.set(line.aff, { sales: (so?.sales ?? 0) + 1, reachedAt: Math.max(so?.reachedAt ?? 0, line.at) });
  }

  const review: string[] = [];
  const counted: Omit<Standing, "place" | "wins">[] = [];
  for (const [aff, so] of sold) {
    if ((approved.get(aff)?.flags.length ?? 0) > 0) {
      review.push(aff);
      continue;
    }
    counted.push({ aff, ...so });
  }
  counted.sort((a, b) => b.sales - a.sales || a.reachedAt - b.reachedAt || (a.aff < b.aff ? -1 : a.aff > b.aff ? 1 : 0));

  const standings: Standing[] = [];
  counted.forEach((s, i) => {
    const before = standings[i - 1];
    const place = before && before.sales === s.sales && before.reachedAt === s.reachedAt ? before.place : i + 1;
    const wins = (c.places > 0 && place <= c.places) || (c.goal > 0 && s.sales >= c.goal);
    standings.push({ ...s, place, wins });
  });
  return { ok: true, standings, review: review.sort() };
}

/**
 * The board one affiliate sees: the top rows, their own row as "You", others
 * by the name they chose for the board (`names`), or "An affiliate". Their
 * own place is given even when it is below the rows shown.
 */
export function challengeBoard(
  standings: Standing[],
  viewer: string,
  names: Record<string, unknown>,
  top = CHALLENGE_BOARD_ROWS,
): { rows: BoardRow[]; mine: { place: number | null; sales: number } } {
  const label = (aff: string): string => {
    if (aff === viewer) return "You";
    const chosen = Object.prototype.hasOwnProperty.call(names, aff) ? readBoardName(names[aff]) : null;
    return chosen ?? "An affiliate";
  };
  const rows = standings.slice(0, Math.max(0, top)).map((s) => ({ place: s.place, label: label(s.aff), sales: s.sales, you: s.aff === viewer, wins: s.wins }));
  const own = standings.find((s) => s.aff === viewer);
  return { rows, mine: own ? { place: own.place, sales: own.sales } : { place: null, sales: 0 } };
}

/** A name an affiliate chose for the board: letters, numbers, spaces and . ' _ -; never an address, a link or a name the board uses itself. */
export function readBoardName(raw: unknown): string | null {
  const name = tidy(raw);
  if (name.length < 2 || name.length > 30) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'_-]*$/u.test(name)) return null;
  const plain = name.normalize("NFKC");
  if (LINK.test(name) || LINK.test(plain) || /\.[a-z]{2,}/i.test(plain)) return null;
  // A hidden letter (a Hangul filler is a letter), a word in mixed scripts, or a look-alike of a reserved name.
  if (HIDDEN.test(plain) || mixesScripts(name) || RESERVED_NAMES.has(boardKey(name))) return null;
  return name;
}

const day = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });

/** What the creator's page says about a challenge, in plain words. Dates are in Coordinated Universal Time (UTC). */
export function challengeNotes(c: Challenge, nowMs: number): string[] {
  const notes = [
    `The prize comes from you: ${c.prize.label}. You give it yourself. Marktmorgen does not pay or hold prizes.`,
    "Only whole paid sales your affiliates bring count. Their own purchases, sales refunded in whole or in part, and chargebacks do not count.",
  ];
  const lastDay = day(c.end - 1);
  switch (challengePhase(c, nowMs)) {
    case "upcoming":
      notes.push(`It starts on ${day(c.start)} and ends on ${lastDay} (Coordinated Universal Time, UTC).`);
      break;
    case "running":
      notes.push(`It ends on ${lastDay} (Coordinated Universal Time, UTC).`);
      break;
    case "settling":
      notes.push(
        `It ended on ${lastDay}. Places can still change if a sale is refunded or disputed, so wait until ${day(c.end + CHALLENGE_SETTLE_DAYS * DAY)} before you hand out prizes.`,
      );
      break;
    case "over":
      notes.push(`It ended on ${lastDay}. A refund or a chargeback can still take a sale off.`);
      break;
  }
  return notes;
}
