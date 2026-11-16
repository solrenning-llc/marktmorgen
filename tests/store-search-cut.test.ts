/**
 * The store page's search (app/[handle]/page.tsx, lib/catalog.ts searchStore) shows at most STORE_SEARCH_LIMIT
 * products and has no further page. It said "52 products for “lesson”" over 48 cards, with no word that the rest were
 * left out and no way to reach them (claude7/catalog-hunt-2, 13 November 2026). With more found than shown it now
 * says how many of how many are shown and how to find the rest; with all shown it says the count as before.
 * Synthetic store; no network.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import StorePage from "@/app/[handle]/page";
import { STORE_SEARCH_LIMIT } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId } from "@/lib/store";
import { blockWords } from "@/lib/buyer-words/blocks";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

async function html(url: string): Promise<string> {
  answering(new NextRequest(url));
  const q = new URL(url).searchParams.get("q") ?? undefined;
  const node = await StorePage({ params: Promise.resolve({ handle: "@searchcut" }), searchParams: Promise.resolve(q ? { q } : {}) } as never);
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "search-cut@example.test";
  await claimHandle(owner, "searchcut", "Search Cut", "");
  await ensureStatsId(owner);
  for (let n = 1; n <= STORE_SEARCH_LIMIT + 6; n++) {
    const made = await addProduct(owner, n <= STORE_SEARCH_LIMIT + 4 ? `Bread lesson ${n}` : `Cake class ${n}`, "", "9", null);
    if (!made.ok) throw new Error("product fixture");
  }
  const w = blockWords("en");

  part("More found than shown");
  const many = await html("https://marktmorgen.com/@searchcut?q=lesson");
  const cut = w.searchCut(STORE_SEARCH_LIMIT, STORE_SEARCH_LIMIT + 4, "lesson");
  is("never says the full count as if every one were shown", many.split(cut).join(" ").includes(w.searchFound(STORE_SEARCH_LIMIT + 4, "lesson")), false);
  is("says how many of how many are shown, and how to find the rest", many.includes(cut), true);

  part("All shown");
  const few = await html("https://marktmorgen.com/@searchcut?q=cake");
  is("the count as before", [few.includes(w.searchFound(2, "cake")), few.includes("Showing the first")], [true, false]);

  part("In every language the store can have");
  const codes = Object.keys(LANGUAGES) as LanguageCode[];
  is("each says both numbers and the words searched", codes.filter((code) => {
    const line = blockWords(code).searchCut(48, 52, "zq");
    return !(line.includes("48") && line.includes("52") && line.includes("zq"));
  }), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
