import { readFileSync } from "node:fs";
import { generateMetadata } from "@/app/[handle]/media-kit/page";
import { claimHandle, setKit, setLanguage } from "@/lib/store";
import { wordsIn } from "@/lib/buyer-words";
import { kitWords } from "@/lib/buyer-words/kit";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/media-kit/page.tsx", "utf8");
const notFoundPage = readFileSync("app/[handle]/not-found.tsx", "utf8");

async function main(): Promise<void> {
  redis.clear();

  part("A known store's unavailable media kit keeps the store's language in the tab");
  for (const language of LANGUAGE_CODES) {
    const handle = `kit-missing-${language}`;
    const owner = `${handle}@example.test`;
    const name = `Sample ${language.toUpperCase()}`;
    await claimHandle(owner, handle, name, "");
    await setLanguage(owner, language);
    const hidden = await generateMetadata({ params: Promise.resolve({ handle: `@${handle}` }) });
    is(`${language}: unavailable media-kit title`, hidden.title, `${wordsIn(language).missingTitle} — ${name}`);

    await setKit(owner, { on: true, pitch: "A public media kit." }, "2026-11-06");
    const shown = await generateMetadata({ params: Promise.resolve({ handle: `@${handle}` }) });
    is(`${language}: published media-kit title remains localized`, shown.title, `${name}: ${kitWords(language).title}`);
  }

  part("The site fallback and the localized store boundary stay distinct");
  const unknown = await generateMetadata({ params: Promise.resolve({ handle: "@no-such-store" }) });
  is("an unknown store keeps the site-wide fallback", unknown.title, "Not found — Marktmorgen");
  is("the unavailable media kit still uses the not-found boundary", page.includes("if (!store) notFound();"), true);
  is("the store boundary still reads the known store", notFoundPage.includes("storeForPage(normaliseHandle(asked))"), true);
  is("the store boundary still renders its localized title", notFoundPage.includes("{w.missingTitle}"), true);
  done();
}

void main();
