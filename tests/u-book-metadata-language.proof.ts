import { readFileSync } from "node:fs";
import { bookingWords } from "@/lib/buyer-words/booking";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

type MetadataResult = { title?: string; robots?: { index?: boolean; follow?: boolean } };
type Listing = { title: string; call: null | { kind: "live" | "weekly" } };

const page = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
const source = page.match(/export async function generateMetadata[\s\S]*?\n}\n\n\/\*\* Where a buyer picks/)?.[0]
  .replace(/\n\n\/\*\* Where a buyer picks[\s\S]*$/, "")
  .replace("export async function generateMetadata", "async function generateMetadata")
  .replace(/\(\{ params \}: Params\): Promise<Metadata>/, "({ params })");

if (!source) throw new Error("booking metadata function was not found");

const makeMetadata = new Function(
  "storeForPage",
  "normaliseHandle",
  "readListing",
  "speech",
  "bookingWords",
  `${source}; return generateMetadata;`,
) as (
  storeForPage: (handle: string) => Promise<unknown>,
  normaliseHandle: (handle: string) => string,
  readListing: (store: unknown, product: string) => Promise<Listing | null>,
  speech: (store: { language: LanguageCode }) => { w: ReturnType<typeof wordsIn> },
  words: typeof bookingWords,
) => (input: { params: Promise<{ handle: string; product: string }> }) => Promise<MetadataResult>;

async function metadataFor(language: LanguageCode, listing: Listing | null, storeExists = true): Promise<MetadataResult> {
  const store = { handle: "sample", name: "Sample Store", language };
  const generateMetadata = makeMetadata(
    async () => (storeExists ? store : null),
    (handle) => handle,
    async () => listing,
    (known) => ({ w: wordsIn(known.language) }),
    bookingWords,
  );
  return generateMetadata({ params: Promise.resolve({ handle: "@sample", product: listing?.title ?? "missing" }) });
}

async function main(): Promise<void> {
  part("A known store's missing booking uses that store's language in the tab");
  for (const language of LANGUAGE_CODES) {
    const result = await metadataFor(language, null);
    is(`${language}: missing call title`, result.title, `${wordsIn(language).missingTitle} — Sample Store`);
  }

  part("The real metadata path and its unrelated behavior stay connected");
  is("an unknown store keeps the site-wide fallback", (await metadataFor("es", null, false)).title, "Book a call — Marktmorgen");
  const weekly = await metadataFor("de", { title: "Beratung", call: { kind: "weekly" } });
  is("a weekly call still names the localized time picker and product", weekly.title, `${wordsIn("de").pickTime}${bookingWords("de").colon}Beratung — Sample Store`);
  const live = await metadataFor("fr", { title: "Atelier", call: { kind: "live" } });
  is("a live call still names the localized session picker and product", live.title, `${wordsIn("fr").pickSession}${bookingWords("fr").colon}Atelier — Sample Store`);
  is("booking metadata remains out of search indexes", weekly.robots, { index: false, follow: true });
  is("the page sends a missing or non-call product back to the known store", page.includes("if (!product || !isCallProduct(product)) redirect(`/@${store.handle}`);"), true);
  done();
}

void main();
