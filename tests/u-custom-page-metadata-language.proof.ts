import { readFileSync } from "node:fs";
import { generateMetadata } from "@/app/[handle]/[slug]/page";
import { claimHandle, setLanguage } from "@/lib/store";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/[slug]/page.tsx", "utf8");
const notFoundPage = readFileSync("app/[handle]/not-found.tsx", "utf8");

async function main(): Promise<void> {
  redis.clear();

  part("A missing custom page under a known store uses that store's language in the tab");
  for (const language of LANGUAGE_CODES) {
    const handle = `missing-${language}`;
    const owner = `${handle}@example.test`;
    const name = `Sample ${language.toUpperCase()}`;
    await claimHandle(owner, handle, name, "");
    await setLanguage(owner, language);
    const metadata = await generateMetadata({ params: Promise.resolve({ handle: `@${handle}`, slug: "removed-page" }) });
    is(`${language}: missing custom-page title`, metadata.title, `${wordsIn(language).missingTitle} — ${name}`);
  }

  part("The site-wide fallback and localized body stay distinct");
  const unknown = await generateMetadata({ params: Promise.resolve({ handle: "@no-such-store", slug: "missing" }) });
  is("an unknown store keeps the site-wide fallback", unknown.title, "Not found — Marktmorgen");
  is("the custom page still sends a missing page to the not-found boundary", page.includes("if (!found) notFound();"), true);
  is("the store not-found boundary still reads the known store", notFoundPage.includes("storeForPage(normaliseHandle(asked))"), true);
  is("the boundary's heading still uses the localized missing title", notFoundPage.includes("{w.missingTitle}"), true);
  done();
}

void main();
