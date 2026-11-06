/** A missing published email under a known store keeps the store's language in metadata. */
import { readFileSync } from "node:fs";
import { generateMetadata } from "@/app/[handle]/letters/[letter]/page";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { claimHandle, setLanguage } from "@/lib/store";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const letterPage = readFileSync("app/[handle]/letters/[letter]/page.tsx", "utf8");
const notFoundPage = readFileSync("app/[handle]/not-found.tsx", "utf8");

async function main(): Promise<void> {
  redis.clear();

  part("A missing publication under a known store uses that store's language in the tab");
  for (const language of LANGUAGE_CODES) {
    const handle = `missing-letter-${language}`;
    const owner = `${handle}@example.test`;
    const name = `Letter Shop ${language.toUpperCase()}`;
    await claimHandle(owner, handle, name, "");
    await setLanguage(owner, language);
    const metadata = await generateMetadata({
      params: Promise.resolve({ handle: `@${handle}`, letter: "publication-that-does-not-exist" }),
      searchParams: Promise.resolve({}),
    });
    is(`${language}: missing publication title`, metadata.title, `${wordsIn(language).missingTitle} — ${name}`);
  }

  part("The site-wide fallback and localized body remain distinct");
  const unknown = await generateMetadata({
    params: Promise.resolve({ handle: "@no-such-letter-store", letter: "missing" }),
    searchParams: Promise.resolve({}),
  });
  is("an unknown store keeps the site-wide fallback", unknown.title, "Not found — Marktmorgen");
  is("the missing publication still enters the not-found boundary", letterPage.includes("if (!found) notFound();"), true);
  is("the store boundary still reads a known store", notFoundPage.includes("storeForPage(normaliseHandle(asked))"), true);
  is("the boundary heading still uses the localized missing title", notFoundPage.includes("{w.missingTitle}"), true);

  done();
}

void main();
