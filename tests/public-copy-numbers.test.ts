/**
 * Every number the public pages type by hand says what the code enforces
 * (VR rule, item 2: nothing a customer sees may show what is not true today).
 * Prices and plan allowances are already read from lib/plan.ts and the rules
 * files; these are the product limits written into sentences, which would
 * otherwise drift without a sound when a limit changes.
 *
 * Each claim names the sentence's pattern, where it appears and the constant
 * it states. The test fails when a sentence says another number than the
 * constant, and when a claim is no longer found where it was (so this list
 * cannot go stale). The terms read the trial's length from TRIAL_DAYS itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRIAL_DAYS } from "@/lib/plan";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_STORE_LINKS } from "@/lib/store-link";
import { STORE_PAGE_SIZE } from "@/lib/catalog";
import { CAPTION_LANGUAGES } from "@/lib/captions";
import { MAX_AUTO_LANGUAGES } from "@/lib/auto-captions-rules";
import { MAX_STORES_PER_ACCOUNT } from "@/lib/store";
import { MAX_TEAM } from "@/lib/team";
import { MAX_MOVED_MEMBERS } from "@/lib/move-rules";
import { IMPORT_LIMITS } from "@/lib/imports";
import { MAX_EVENT_CAP, MAX_MEMBERS, MAX_POSTS, MAX_UPCOMING_EVENTS } from "@/lib/community-text";
import { MAX_POOL_KEYS, MAX_UPLOAD_KEYS } from "@/lib/licence-key-rules";
import { MAX_QUESTIONS as MAX_QUIZ_QUESTIONS } from "@/lib/quiz";
import { MAX_VIDEOS_AT_ONCE } from "@/lib/course-videos";
import { MAX_FILE_BYTES } from "@/lib/product-file";
import { MAX_LESSON_FILES } from "@/lib/course";
import { MAX_ENDPOINTS } from "@/lib/webhook-limits";
import { MAX_KEYS } from "@/lib/api-key-rules";
import { MAX_FUNNEL_STEPS } from "@/lib/funnel";
import { MAX_COLLECTION_PRODUCTS, MAX_COLLECTIONS } from "@/lib/store-collections";
import { MAX_DISCORD_PRODUCTS, MAX_PRODUCT_ROLES } from "@/lib/discord-rules";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** "2,000", "20", "five" or "Five" as a number; NaN for anything else. */
const numberOf = (text: string) => (WORDS[text.toLowerCase()] ?? (/^[\d,]+$/.test(text) ? Number(text.replace(/,/g, "")) : Number.NaN));

type Claim = { what: string; pattern: RegExp; files: string[]; value: number };

const MISSION = "app/mission/page.tsx", FEATURES = "lib/feature-pages.ts", HELP = "lib/help-content.ts", HOME = "components/home-parts.tsx";
const SITE = "lib/site-pages.ts", BLOG = "lib/blog.ts", TERMS = "app/terms/page.tsx", PRIVACY = "app/privacy/page.tsx";
const GIB = 1024 ** 3;

const CLAIMS: Claim[] = [
  { what: "products in a store", pattern: /(?<!on |of |collections of )[Uu]p to ([\d,]+) products(?! each| a file| with pictures)/g, files: [MISSION, FEATURES, HELP, HOME, SITE, BLOG], value: MAX_PRODUCTS },
  { what: "products past the limit", pattern: /More than ([\d,]+) products in one store/g, files: [MISSION], value: MAX_PRODUCTS },
  { what: "products a store supports", pattern: /supports up to ([\d,]+) products/g, files: [FEATURES], value: MAX_PRODUCTS },
  { what: "links on a store page", pattern: /(?:up to|and) ([\d,]+) links/g, files: [MISSION, FEATURES, HELP, SITE], value: MAX_STORE_LINKS },
  { what: "products shown at a time", pattern: /shown (\d+) at a time|(\d+) products a page/g, files: [MISSION, SITE], value: STORE_PAGE_SIZE },
  { what: "caption languages to upload", pattern: /in any of (\d+) languages/g, files: [HELP], value: CAPTION_LANGUAGES.length },
  { what: "AI caption languages past the spoken one", pattern: /(?:language spoken and|translated into) up to (\w+) more/g, files: [HELP, FEATURES], value: MAX_AUTO_LANGUAGES - 1 },
  { what: "stores in one account", pattern: /(?:[Uu]p to|runs up to|run up to) (\w+) stores/g, files: [MISSION, TERMS, HELP, FEATURES, BLOG], value: MAX_STORES_PER_ACCOUNT },
  { what: "stores in one account (FAQ)", pattern: /more than one store\?", a: "Yes, up to (\w+),/g, files: [FEATURES], value: MAX_STORES_PER_ACCOUNT },
  { what: "people on a store's team", pattern: /team of (?:you plus )?up to (\w+)|invite up to (\w+) people|plus up to (\w+) people per store|up to (\w+) people on each store's team|invite up to (\w+) people to help/g, files: [MISSION, TERMS, HELP, HOME, FEATURES, PRIVACY], value: MAX_TEAM },
  { what: "members moved, a file", pattern: /[Mm]embers(?: moved from another platform)?, up to ([\d,]+) a file/g, files: [MISSION, FEATURES], value: MAX_MOVED_MEMBERS },
  { what: "past buyers imported, a file", pattern: /[Pp]ast buyers(?:: |, )up to ([\d,]+) a file/g, files: [MISSION, HELP, FEATURES], value: IMPORT_LIMITS.purchases },
  { what: "list imported, a file", pattern: /your list, up to ([\d,]+) a file/g, files: [MISSION], value: IMPORT_LIMITS.contacts },
  { what: "products imported, a file", pattern: /your products, up to ([\d,]+) a file/g, files: [MISSION], value: IMPORT_LIMITS.products },
  { what: "an event's places", pattern: /(?:cap of|[Ff]rom|anything from) 1 to ([\d,]+)/g, files: [MISSION, FEATURES, HELP, SITE], value: MAX_EVENT_CAP },
  { what: "events coming up", pattern: /up to (\d+) coming up/g, files: [MISSION, SITE], value: MAX_UPCOMING_EVENTS },
  { what: "keys in one upload", pattern: /file of up to ([\d,]+) keys/g, files: [FEATURES], value: MAX_UPLOAD_KEYS },
  { what: "keys waiting in a pool", pattern: /Up to ([\d,]+) keys waiting/g, files: [FEATURES], value: MAX_POOL_KEYS },
  { what: "community posts", pattern: /Up to ([\d,]+) posts and [\d,]+ members/g, files: [FEATURES], value: MAX_POSTS },
  { what: "community members", pattern: /Up to [\d,]+ posts and ([\d,]+) members/g, files: [FEATURES], value: MAX_MEMBERS },
  { what: "quiz questions", pattern: /quizzes of up to (\d+) questions/g, files: [MISSION], value: MAX_QUIZ_QUESTIONS },
  { what: "lesson videos at once", pattern: /videos, up to (\d+) at once/g, files: [MISSION], value: MAX_VIDEOS_AT_ONCE },
  { what: "a lesson's video size", pattern: /video of up to (\d+) GB/g, files: [FEATURES, HELP], value: MAX_FILE_BYTES / GIB },
  { what: "a lesson's downloads", pattern: /up to (\w+) downloads/g, files: [FEATURES, HELP], value: MAX_LESSON_FILES },
  { what: "webhook addresses", pattern: /Webhooks: up to (\w+) addresses|Add up to (\w+) https addresses/g, files: [MISSION, HELP, SITE], value: MAX_ENDPOINTS },
  { what: "API keys", pattern: /API with up to (\w+) keys|with up to (\w+) keys;/g, files: [MISSION, SITE], value: MAX_KEYS },
  { what: "collections in a store", pattern: /up to (\d+) collections of up to \d+ products each/g, files: [FEATURES, HELP], value: MAX_COLLECTIONS },
  { what: "products in a collection", pattern: /up to \d+ collections of up to (\d+) products each/g, files: [FEATURES, HELP], value: MAX_COLLECTION_PRODUCTS },
  { what: "Discord roles a product", pattern: /Up to (\w+) roles for each product/g, files: [FEATURES], value: MAX_PRODUCT_ROLES },
  { what: "Discord products", pattern: /roles for each product, on up to (\d+) products/g, files: [FEATURES], value: MAX_DISCORD_PRODUCTS },
  { what: "contacts imported, a file (comparison)", pattern: /Up to ([\d,]+) contacts a file/g, files: [SITE], value: IMPORT_LIMITS.contacts },
  { what: "products imported, a file (comparison)", pattern: /up to ([\d,]+) products a file/g, files: [SITE], value: IMPORT_LIMITS.products },
  { what: "past buyers imported, a file (comparison)", pattern: /up to ([\d,]+) past buyers a file/g, files: [SITE], value: IMPORT_LIMITS.purchases },
  { what: "offers after paying", pattern: /up to (\w+) (?:one-click )?offers after|up to (\w+) in a row as a funnel|[Ff]unnels: up to (\w+) offers/g, files: [MISSION, FEATURES, HOME, SITE], value: MAX_FUNNEL_STEPS },
];

part("every number a public sentence types by hand is the one the code enforces");
for (const claim of CLAIMS) {
  let found = 0;
  for (const file of claim.files) {
    const text = read(file);
    for (const match of text.matchAll(claim.pattern)) {
      const said = match.slice(1).find((group) => group !== undefined) ?? "";
      found += 1;
      is(`${claim.what}, ${file}: "${match[0]}"`, numberOf(said), claim.value);
    }
  }
  is(`${claim.what}: still said on the public pages`, found > 0, true);
}

part("the terms read the trial's length from the code");
{
  const terms = read(TERMS);
  is("no trial length typed by hand", /free trial of \d+ days/.test(terms), false);
  is("the trial's length is TRIAL_DAYS", /free trial of \$?\{TRIAL_DAYS\} days/.test(terms), true);
  is("which is what the plan gives", TRIAL_DAYS > 0, true);
}

done();
