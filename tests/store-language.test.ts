/**
 * A store in another language (lib/store-language.ts, lib/buyer-words/,
 * added 8 October 2026). What the type cannot check, checked here:
 *
 *   - every store speaks English until its creator picks another language,
 *     and anything else stored is read as English;
 *   - every language says every sentence with the names and amounts it is
 *     given — none is dropped, none is left as a placeholder — and no word
 *     is left in English where the language has its own;
 *   - French spaces its ":", "?", "!", ";" and "%" with a space that cannot
 *     break, and other languages never break a line before "%";
 *   - prices, numbers, dates and countries are written the language's way;
 *   - Stripe's payment page is opened in the store's language.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { LANGUAGES, LANGUAGE_CODES, parseLanguage, timeLeft } from "@/lib/store-language";
import { endsLine, planLine, speechFor, wordsIn } from "@/lib/buyer-words";
import { en } from "@/lib/buyer-words/en";
import { ORDERS_WORDS } from "@/lib/buyer-words/orders";
import { BOOKING_WORDS } from "@/lib/buyer-words/booking";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { MEMBERSHIP_WORDS } from "@/lib/buyer-words/membership";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import { THANKS_WORDS } from "@/lib/buyer-words/thanks";
import { BLOCK_WORDS } from "@/lib/buyer-words/blocks";
import { JOIN_WORDS } from "@/lib/buyer-words/join";
import { GUIDE_WORDS } from "@/lib/buyer-words/guide";
import { CONTACT_WORDS } from "@/lib/buyer-words/contact";
import { TIPS_WORDS } from "@/lib/buyer-words/tips";
import { KIT_WORDS } from "@/lib/buyer-words/kit";
import { PREORDER_WORDS } from "@/lib/buyer-words/preorder";
import { PICK_WORDS } from "@/lib/buyer-words/pick";
import { CART_WORDS } from "@/lib/buyer-words/cart";
import { DISCORD_WORDS } from "@/lib/buyer-words/discord";
import { MOVE_WORDS } from "@/lib/buyer-words/move";
import { ACCESS_WORDS } from "@/lib/buyer-words/access";
import { WELCOME_WORDS } from "@/lib/buyer-words/welcome";
import { CHAT_WORDS } from "@/lib/buyer-words/chat";
import { addProduct, claimHandle, ensureStatsId, setLanguage, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"l".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** Words that are the same in a language as in English, on purpose. */
const SAME: Record<string, Record<string, string[]>> = {
  // "Chat" is the word in these.
  "store chat": { es: ["launcher"], de: ["launcher"], it: ["launcher"], nl: ["launcher"] },
  "store and product pages": {
    // "Blog" is the word in every one of them, and "Collections" in French.
    es: ["namePlaceholder", "fromCapital", "blog"],
    fr: ["namePlaceholder", "perPerson", "recommended", "blog", "collections"],
    de: ["namePlaceholder", "guarantee", "blog"],
    it: ["namePlaceholder", "blog"],
    nl: ["namePlaceholder", "guarantee", "blog"],
    pt: ["namePlaceholder", "blog"],
  },
  // "Label: key", "Store: link", and "via" where the language says "via" too.
  orders: {
    es: ["keyIssued", "storeAt"],
    fr: ["ordersFrom"],
    de: ["keyIssued", "storeAt"],
    it: ["keyIssued", "storeAt"],
    nl: ["ordersFrom", "startTitleAt", "keyIssued", "storeAt"],
    pt: ["ordersFrom", "keyIssued", "storeAt"],
  },
  // Words the languages share with English: video, quiz, module, downloads, bytes.
  courses: {
    es: ["video", "bytes"],
    fr: ["module", "quiz", "codeBlock"],
    de: ["quiz", "downloads", "codeBlock"],
    it: ["video", "quiz"],
    nl: ["module", "video", "quiz", "crumb", "openSite", "downloads", "bytes", "codeBlock"],
    pt: ["bytes"],
  },
  membership: { fr: ["fromName"], nl: ["fromName"], pt: ["fromName"] },
  // "Label: link".
  // "Product" is the Dutch word too.
  affiliates: { es: ["doorText"], de: ["doorText"], it: ["doorText"], nl: ["doorText", "kit.product"], pt: ["doorText"] },
  // Words the languages took from English: Community, Feed, Level, Post, Messages, likes, studio; "7 h 7 min", "7 pts".
  community: {
    es: ["lengthHoursMinutes", "pts"],
    fr: ["tabMessages", "tabMessagesWaiting", "studio", "messageLink"],
    de: ["pageTitle", "tabFeed", "levelBadge"],
    it: ["pageTitle", "studio", "postPageTitle", "lengthHoursMinutes"],
    nl: ["pageTitle", "likes", "studio"],
    pt: ["lengthHoursMinutes", "pts"],
  },
  // "{price} {every}": the price and the words for how often, each already in the language.
  // "Bonus 7": Spanish says bonus too.
  // "Pages" is the French word for the menu of a store's own pages too.
  "page blocks": { es: ["bonusN"], fr: ["pagesMenu"], de: ["socialWebsite"], it: ["socialEmail"], nl: ["socialWebsite"] },
  // "Audience" is the French word too.
  "media kit": { fr: ["audienceTitle"] },
  // "Total" is the word in these languages too.
  cart: { es: ["total"], fr: ["total"], pt: ["total"] },
  thanks: { es: ["priceEvery"], fr: ["priceEvery"], de: ["priceEvery"], it: ["priceEvery"], nl: ["priceEvery"], pt: ["priceEvery"] },
};

const NUMBERS = new Set(["count", "n", "dates", "minutes", "seats", "episodes", "lessons", "sessions", "days", "trialDays", "payments", "page", "pages", "stars", "boxes", "least", "most", "percent", "more", "hours", "people", "left", "total", "done", "places", "weeks", "months"]);
const BOOLEANS = new Set(["plan", "alone", "untilCancel", "stripe", "paypal", "tomorrow", "oneWord"]);
const isBoolean = (p: string) => BOOLEANS.has(p) || /^(is|has|with)[A-Z]/.test(p);

/** Calls a word with arguments it can be told apart by: names in «», numbers, booleans both ways. */
function sayAll(words: Record<string, unknown>, english: Record<string, unknown> = en): { key: string; text: string; names: string[] }[] {
  const out: { key: string; text: string; names: string[] }[] = [];
  for (const [key, value] of Object.entries(words) as [string, unknown][]) {
    if (typeof value === "string") out.push({ key, text: value, names: [] });
    else if (typeof value === "function") {
      const fn = value as (...args: unknown[]) => unknown;
      // Each argument by the name the English word gives it.
      const params = english[key]!.toString().match(/^\(([^)]*)\)/)?.[1] ?? "";
      const names: string[] = [];
      const args = params
        .split(",")
        .map((p) => p.trim().replace(/^_/, ""))
        .filter(Boolean)
        .map((p, i) => {
          if (NUMBERS.has(p)) return key === "buyAllFor" ? 2 : 7;
          if (isBoolean(p)) return true;
          if (p === "interval") return "month";
          if (p === "unit") return "hour";
          if (p === "kind") return "post";
          const name = `\u00ab${key}${i}\u00bb`;
          names.push(name);
          return name;
        });
      const said = fn(...args);
      if (typeof said === "string") out.push({ key, text: said, names });
      else if (said && typeof said === "object") {
        for (const [k, v] of Object.entries(said)) out.push({ key: `${key}.${k}`, text: String(v), names: [] });
      }
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "string") out.push({ key: `${key}.${k}`, text: v, names: [] });
        else if (v && typeof v === "object") for (const [k2, v2] of Object.entries(v)) out.push({ key: `${key}.${k}.${k2}`, text: String(v2), names: [] });
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_language_only_a_stand_in";

  part("English until the creator picks another");
  is("anything else stored is read as English", [parseLanguage(undefined), parseLanguage("xx"), parseLanguage("EN"), parseLanguage("de")], ["en", "en", "en", "de"]);
  is("seven languages, each with its own Stripe page", LANGUAGE_CODES.map((c) => LANGUAGES[c].stripe), ["en", "es", "fr", "de", "it", "nl", "pt"]);

  const AREAS: [string, (code: (typeof LANGUAGE_CODES)[number]) => Record<string, unknown>][] = [
    ["store and product pages", (code) => wordsIn(code)],
    ["orders", (code) => ORDERS_WORDS[code]],
    ["booking", (code) => BOOKING_WORDS[code]],
    ["courses", (code) => COURSES_WORDS[code]],
    ["membership", (code) => MEMBERSHIP_WORDS[code]],
    ["giving", (code) => GIVING_WORDS[code]],
    ["affiliates", (code) => AFFILIATES_WORDS[code]],
    ["community", (code) => COMMUNITY_WORDS[code]],
    ["thanks", (code) => THANKS_WORDS[code]],
    ["page blocks", (code) => BLOCK_WORDS[code]],
    ["email sign-up", (code) => JOIN_WORDS[code]],
    ["store guide", (code) => GUIDE_WORDS[code]],
    ["contact form", (code) => CONTACT_WORDS[code]],
    ["support box", (code) => TIPS_WORDS[code]],
    ["media kit", (code) => KIT_WORDS[code]],
    ["pre-orders", (code) => PREORDER_WORDS[code]],
    ["bundles buyers build", (code) => PICK_WORDS[code]],
    ["cart", (code) => CART_WORDS[code]],
    ["discord", (code) => DISCORD_WORDS[code]],
    ["moving a membership", (code) => MOVE_WORDS[code]],
    ["given through the API", (code) => ACCESS_WORDS[code]],
    ["welcome offer", (code) => WELCOME_WORDS[code]],
    ["store chat", (code) => CHAT_WORDS[code]],
  ];
  for (const [area, wordsOf] of AREAS) {
    const englishWords = wordsOf("en");
    const english = sayAll(englishWords, englishWords);
    for (const code of LANGUAGE_CODES) {
      const said = sayAll(wordsOf(code), englishWords);
      part(`${LANGUAGES[code].english}, ${area}: every sentence`);
      is("as many sentences as English", said.length, english.length);
      const empty = said.filter((s) => !s.text.trim() && !["continued", "now", "was"].includes(s.key)).map((s) => s.key);
      is("none is empty", empty, []);
      const dropped = said.filter((s) => s.names.some((n) => !s.text.includes(n))).map((s) => s.key);
      is("every name and amount it is given is in it", dropped, []);
      const leftovers = said.filter((s) => /\$\{|undefined|NaN|\[object/.test(s.text)).map((s) => s.key);
      is("nothing left as a placeholder", leftovers, []);
      if (code !== "en") {
        const allowed = SAME[area]?.[code] ?? [];
        const same = said
          .filter((s, i) => s.text === english[i]?.text && s.text.length > 3 && !allowed.includes(s.key.split(".")[0]) && !allowed.includes(s.key))
          .filter((s) => !/^[«\u00ab][^»]*[»\u00bb]( — [«\u00ab][^»]*[»\u00bb])?$/.test(s.text))
          .map((s) => s.key);
        is("nothing left in English", same, []);
      }
      const breakable = said.filter((s) => / %/.test(s.text)).map((s) => s.key);
      is("a percentage never starts a line", breakable, []);
      if (code === "fr") {
        const spaced = said.filter((s) => /[^\u00a0\s][:?!;](\s|$)/.test(s.text.replace(/https?:\/\/\S+/g, "")) && !/\d:\d/.test(s.text)).map((s) => s.key);
        is("French spaces its : ? ! ; from the word before", spaced, []);
      }
    }
  }

  part("Written the language's way");
  const de = speechFor("de", "usd");
  const es = speechFor("es", "eur");
  const enUsd = speechFor("en", "usd");
  is("a price", [enUsd.money(2700), de.money(2750).replace(/\u00a0/g, " "), es.money(2700).replace(/\u00a0/g, " ")], ["$27", "27,50 $", "27 €"]);
  is("a number", [enUsd.num(1234), de.num(1234), speechFor("fr", "usd").num(1234).replace(/\u202f/g, " ")], ["1,234", "1.234", "1 234"]);
  is("a country", [enUsd.country("IN"), de.country("IN"), es.country("DE")], ["India", "Indien", "Alemania"]);
  is("a date", [enUsd.date(Date.UTC(2026, 9, 8)), de.date(Date.UTC(2026, 9, 8)), speechFor("it", "usd").date(Date.UTC(2026, 9, 8))], ["October 8, 2026", "8. Oktober 2026", "8 ottobre 2026"]);
  is("a payment plan", [planLine({ language: "en", currency: "usd" }, { payments: 3, interval: "month", amountCents: 11000 }), planLine({ language: "es", currency: "usd" }, { payments: 3, interval: "month", amountCents: 11000 }).replace(/\u00a0/g, " ")], ["3 monthly payments of $110", "3 pagos mensuales de 110 US$"]);
  is("how long a sale has left, in one unit", [timeLeft(1000 + 3 * 86_400, 1000), timeLeft(1000 + 3_700, 1000), timeLeft(1000 + 61, 1000)], [{ unit: "day", n: 3 }, { unit: "hour", n: 1 }, { unit: "minute", n: 2 }]);
  is("and said so", [endsLine({ language: "en", currency: "usd" }, 1000 + 3 * 86_400, 1000), endsLine({ language: "it", currency: "usd" }, 1000 + 3_700, 1000), endsLine({ language: "fr", currency: "usd" }, 1000 + 61, 1000).replace(/\u00a0/g, " ")], ["Ends in 3 days", "Termina tra 1 ora", "Se termine dans 2 minutes"]);
  is("one left, many left", [wordsIn("es").left(1, "1"), wordsIn("es").left(3, "3"), wordsIn("it").left(1, "1"), wordsIn("pt").left(2, "2")], ["Queda 1", "Quedan 3", "Ne resta 1", "Restam 2"]);
  is("French takes the singular for 0 and 1", [wordsIn("fr").course(1).replace(/\u00a0/g, " "), wordsIn("fr").course(0).replace(/\u00a0/g, " "), wordsIn("fr").course(2).replace(/\u00a0/g, " ")], ["Formation · 1 leçon", "Formation · 0 leçon", "Formation · 2 leçons"]);

  part("Stripe's page in the store's language");
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "lingua", "Lingua Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLingua0001", true);
  await setSubscription(OWNER, { customerId: "cus_Lingua00001", subscriptionId: "sub_Lingua00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Recetario", "", "27", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/recetario");
  const open = async () => {
    checkouts.length = 0;
    const store = (await storeForEmail(OWNER))!;
    await createCheckout(store, (await readProduct(store, made.product.id))!, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT });
    return checkouts[0];
  };
  is("a new store's is English", [(await storeForEmail(OWNER))!.language, (await open()).get("locale")], ["en", "en"]);
  await setLanguage(OWNER, "es");
  is("set to Spanish, Stripe's page is Spanish", [(await storeForEmail(OWNER))!.language, (await open()).get("locale")], ["es", "es"]);
  await setLanguage(OWNER, "klingon");
  is("anything else sent is English again", (await open()).get("locale"), "en");

  done();
}

void main();
