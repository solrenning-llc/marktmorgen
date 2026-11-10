/**
 * A store's words for its buyers, in the store's language
 * (lib/store-language.ts), with its prices, numbers and dates written the way
 * that language writes them.
 *
 * Every language is checked against the English list by the type below: a
 * language missing one word, or taking a number where English takes a price,
 * does not build. tests/store-language.test.ts checks what the type cannot:
 * that each says every sentence with the numbers and names it was given.
 */
import { formatMoney } from "@/lib/money";
import { parseEvery } from "@/lib/recurring-every-rules";
import { membershipWords } from "./membership";
import { MIN_BUNDLE_ITEMS, worthOf } from "@/lib/bundle-rules";
import { DEFAULT_LANGUAGE, LANGUAGES, type LanguageCode, type LanguageInfo, parseLanguage, timeLeft } from "@/lib/store-language";
import { en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { de } from "./de";
import { it } from "./it";
import { nl } from "./nl";
import { pt } from "./pt";

export type BuyerWords = typeof en;

const WORDS: Record<LanguageCode, BuyerWords> = { en, es, fr, de, it, nl, pt };

export function wordsIn(code: LanguageCode): BuyerWords {
  return WORDS[code] ?? en;
}

/** A store's way of speaking: its words, and how it writes a price, a number, a date and a country. */
export type Speech = {
  w: BuyerWords;
  lang: LanguageInfo;
  /** An amount in the store's currency, as this language writes it: "$27", "27 $", "27 US$". */
  money: (cents: number) => string;
  /** 1,234 or 1.234 or 1 234. */
  num: (n: number) => string;
  /** "October 8, 2026", "8 de octubre de 2026". */
  date: (at: Date | number) => string;
  /** "Oct 9, 3:00 PM UTC", for the end of a sale. */
  dateTime: (at: Date | number) => string;
  /** "India", "la India", "Indien". */
  country: (code: string) => string;
};

const speeches = new Map<string, Speech>();

/** How a store with this language and currency speaks to its buyers. */
export function speechFor(language: unknown, currency: string): Speech {
  const code = parseLanguage(language);
  const key = `${code}|${currency}`;
  const found = speeches.get(key);
  if (found) return found;
  const lang = LANGUAGES[code];
  const numbers = new Intl.NumberFormat(lang.locale);
  const dates = new Intl.DateTimeFormat(lang.locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const times = new Intl.DateTimeFormat(lang.locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  let regions: Intl.DisplayNames | null = null;
  try {
    regions = new Intl.DisplayNames([lang.locale], { type: "region" });
  } catch {
    regions = null;
  }
  const speech: Speech = {
    w: wordsIn(code),
    lang,
    money: (cents) => formatMoney(cents, currency, lang.locale),
    num: (n) => numbers.format(n),
    date: (at) => dates.format(new Date(at)),
    dateTime: (at) => times.format(new Date(at)),
    country: (region) => {
      try {
        return regions?.of(region) ?? region;
      } catch {
        return region;
      }
    },
  };
  speeches.set(key, speech);
  return speech;
}

/** How this store speaks to its buyers. */
export function speech(store: { language?: unknown; currency: string }): Speech {
  return speechFor(store.language ?? DEFAULT_LANGUAGE, store.currency);
}

type Speaks = { language?: unknown; currency: string };

/**
 * "3 monthly payments of $110", in the store's language. A plan over several
 * prices, each with its own amount (lib/product-extras.ts, planFor), is
 * "3 monthly payments": the amount is said beside each price instead.
 */
export function planLine(store: Speaks, plan: { payments: number; interval: "week" | "month"; amountCents: number; options?: Record<string, number> }): string {
  const { w, money } = speech(store);
  if (plan.options && Object.keys(plan.options).length > 0) return w.planCount(plan.payments, plan.interval);
  return w.planWords(plan.payments, plan.interval, money(plan.amountCents));
}

/**
 * How often a membership charges, in the store's language: "a month" for one,
 * "every 3 months" for more (609 [WP8]; the words the membership page already
 * says, lib/buyer-words/membership.ts every).
 */
export function everyPhrase(store: Speaks, interval: "day" | "week" | "month" | "year", count = 1): string {
  const n = parseEvery(interval, count);
  return n > 1 ? membershipWords(store.language).every(interval, n) : speech(store).w.every(interval);
}

/**
 * A membership line said every few weeks or months: the line's own last words, the single interval, swapped for
 * `phrase`. Should a language ever end the line otherwise, the line falls back to the price and the phrase alone,
 * never to the single interval (tests/recurring-every-wired.test.ts holds every language to the first path).
 */
function everyLine(line: string, single: string, phrase: string, price: string): string {
  return line.endsWith(single) ? `${line.slice(0, line.length - single.length)}${phrase}` : `${price} ${phrase}`;
}

/** "7-day free trial, then $9 a month", in the store's language; `price` is already written. */
export function membershipLine(
  store: Speaks,
  recurring: { trialDays: number; payments: number; interval: "day" | "week" | "month" | "year"; every?: number },
  price: string,
  /** An introductory price it offers now (lib/intro-price.ts, activeIntro): said first, before the regular price. */
  intro: { cents: number; count: number } | null = null,
): string {
  const { w, money } = speech(store);
  // Charged every N (609 [WP8]): said as "every 3 months", in the store's language, never as a single month.
  const count = parseEvery(recurring.interval, recurring.every);
  const once = w.membershipPrice(recurring.trialDays, recurring.payments, recurring.interval, price);
  // Every language ends a running membership's line with its interval ("…$9 a month"): that last part is said as
  // charged, so the trial before it keeps its own words (a set number of payments is refused above one, WP8 unit 2).
  const regular = count > 1 && recurring.payments === 0 ? everyLine(once, w.every(recurring.interval), everyPhrase(store, recurring.interval, count), price) : once;
  return intro ? w.introThen(money(intro.cents), intro.count, recurring.interval, regular) : regular;
}

/**
 * "$120 of products for $49", only when the products on their own cost more
 * than the bundle (lib/bundle-rules.ts, worthOf); otherwise null, and nothing
 * is claimed.
 */
export function worthLine(store: Speaks, items: { priceCents: number }[], priceCents: number): string | null {
  const worth = worthOf(items);
  if (worth <= priceCents || items.length < MIN_BUNDLE_ITEMS) return null;
  const { w, money } = speech(store);
  return w.worth(money(worth), money(priceCents));
}

/** "Ends in 2 days", in the store's language. */
export function endsLine(store: Speaks, ends: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const left = timeLeft(ends, nowSeconds);
  return speech(store).w.endsIn(left.unit, left.n);
}
