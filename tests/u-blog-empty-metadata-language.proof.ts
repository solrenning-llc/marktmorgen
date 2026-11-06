import { readFileSync } from "node:fs";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

type MetadataResult = {
  title?: string;
  description?: string;
  alternates?: { canonical?: string };
  openGraph?: { title?: string; description?: string; url?: string; type?: string };
};

type KnownStore = { handle: string; name: string; bio: string; language: LanguageCode; posts: number };

const page = readFileSync("app/[handle]/blog/page.tsx", "utf8");
const source = page.match(/export async function generateMetadata[\s\S]*?\n}\n\n\/\*\*/)?.[0]
  .replace(/\n\n\/\*\*[\s\S]*$/, "")
  .replace("export async function generateMetadata", "async function generateMetadata")
  .replace(/\(\{ params \}: Params\): Promise<Metadata>/, "({ params })");

if (!source) throw new Error("blog metadata function was not found");

const makeMetadata = new Function(
  "load",
  "speech",
  "storeRoot",
  "SITE_URL",
  `${source}; return generateMetadata;`,
) as (
  load: (handle: string) => Promise<KnownStore | null>,
  speech: (store: KnownStore) => { w: ReturnType<typeof wordsIn> },
  storeRoot: (store: KnownStore) => string,
  siteUrl: string,
) => (input: { params: Promise<{ handle: string }> }) => Promise<MetadataResult>;

async function metadataFor(language: LanguageCode, posts: number, storeExists = true, bio = ""): Promise<MetadataResult> {
  const store: KnownStore = { handle: "sample", name: "Sample Store", bio, language, posts };
  const generateMetadata = makeMetadata(
    async () => (storeExists ? store : null),
    (known) => ({ w: wordsIn(known.language) }),
    (known) => `https://marktmorgen.com/@${known.handle}`,
    "https://marktmorgen.com",
  );
  return generateMetadata({ params: Promise.resolve({ handle: "@sample" }) });
}

async function main(): Promise<void> {
  part("A known empty store blog uses that store's language in the tab");
  for (const language of LANGUAGE_CODES) {
    is(`${language}: empty blog title`, (await metadataFor(language, 0)).title, `${wordsIn(language).missingTitle} — Sample Store`);
  }

  part("Unknown stores and existing blogs keep their unrelated behavior");
  is("an unknown store keeps the site-wide fallback", (await metadataFor("es", 0, false)).title, "Not found — Marktmorgen");
  const existing = await metadataFor("de", 1);
  is("an existing blog keeps its localized title", existing.title, wordsIn("de").blogOf("Sample Store"));
  is("an existing blog keeps its canonical address", existing.alternates?.canonical, "https://marktmorgen.com/@sample/blog");
  is("an existing blog keeps its localized Open Graph title", existing.openGraph?.title, wordsIn("de").blogOf("Sample Store"));
  is("the rendered empty blog still reaches the localized store not-found boundary", page.includes("if (total === 0) notFound();") && page.includes("const say = speech(store);"), true);
  done();
}

void main();
