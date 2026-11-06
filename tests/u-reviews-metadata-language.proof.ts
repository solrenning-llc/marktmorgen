import { readFileSync } from "node:fs";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

type MetadataResult = { title?: string; robots?: { index?: boolean; follow?: boolean } };
type Listing = { id: string; title: string };

const page = readFileSync("app/[handle]/p/[product]/reviews/page.tsx", "utf8");
const source = page.match(/export async function generateMetadata[\s\S]*?\n}\n\n\/\*\*/)?.[0]
  .replace(/\n\n\/\*\*[\s\S]*$/, "")
  .replace("export async function generateMetadata", "async function generateMetadata")
  .replace(/\(\{ params \}: Params\): Promise<Metadata>/, "({ params })");

if (!source) throw new Error("reviews metadata function was not found");

const makeMetadata = new Function(
  "storeForPage",
  "normaliseHandle",
  "readListing",
  "productIdFromAddress",
  "speech",
  `${source}; return generateMetadata;`,
) as (
  storeForPage: (handle: string) => Promise<unknown>,
  normaliseHandle: (handle: string) => string,
  readListing: (store: unknown, product: string) => Promise<Listing | null>,
  productIdFromAddress: (store: unknown, product: string) => string | null,
  speech: (store: { language: LanguageCode }) => { w: ReturnType<typeof wordsIn> },
) => (input: { params: Promise<{ handle: string; product: string }> }) => Promise<MetadataResult>;

async function metadataFor(language: LanguageCode, listing: Listing | null, storeExists = true): Promise<MetadataResult> {
  const store = { handle: "sample", name: "Sample Store", language };
  const generateMetadata = makeMetadata(
    async () => (storeExists ? store : null),
    (handle) => handle,
    async () => listing,
    (_store, product) => product,
    (known) => ({ w: wordsIn(known.language) }),
  );
  return generateMetadata({ params: Promise.resolve({ handle: "@sample", product: listing?.id ?? "missing" }) });
}

async function main(): Promise<void> {
  part("A known store's missing product reviews use that store's language in the tab");
  for (const language of LANGUAGE_CODES) {
    const result = await metadataFor(language, null);
    is(`${language}: missing reviews title`, result.title, `${wordsIn(language).missingTitle} — Sample Store`);
  }

  part("The real metadata path and unrelated behavior stay connected");
  is("an unknown store keeps the site-wide fallback", (await metadataFor("es", null, false)).title, "Not found — Marktmorgen");
  const found = await metadataFor("fr", { id: "guide", title: "Guide" });
  is("an existing product keeps its localized reviews title", found.title, `${wordsIn("fr").reviewsOf("Guide")} — Sample Store`);
  is("an existing product's reviews stay out of search indexes", found.robots, { index: false, follow: true });
  is("the page sends a missing product back to the known store", page.includes("if (!product) redirect(`/@${store.handle}`);"), true);
  done();
}

void main();
