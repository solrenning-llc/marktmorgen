/**
 * The order of a store's search results is told next to them (EU Consumer
 * Rights Directive 2011/83/EU Art. 6a(1)(a); Unfair Commercial Practices
 * Directive 2005/29/EC Art. 7(4a); docs/eu-consumer-audit-2026-11-06.md,
 * row 5 and unit 4). A store search (lib/catalog.ts, searchStore) shows the
 * matches in the creator's own product order, nothing else: no sorting by
 * price, date or sales, and no paid placement. The real store page is drawn
 * with a search, in each of the seven buyer languages, and must say so in
 * one line beside the results; with no match, there is no order to tell.
 *
 * Real page, against the in-memory store of the tests; next/headers reads the
 * request each render answers (tests/security/next-headers.ts).
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import StorePage from "@/app/[handle]/page";
import { BLOCK_WORDS } from "@/lib/buyer-words/blocks";
import { STORE_PAGE_SIZE, searchStore } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, moveProduct, setLanguage, setProductHidden, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { productSegment } from "@/lib/product-slug";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "order@example.com";
const NAME = "Kiln Works";
const LANGUAGES = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;

/** The order line of a language, read without trusting the type: before the fix it does not exist. */
function orderLine(language: (typeof LANGUAGES)[number]): string | null {
  const words = BLOCK_WORDS[language] as unknown as Record<string, unknown>;
  const line = words.searchOrder;
  return typeof line === "function" ? String((line as (store: string) => string)(NAME)) : null;
}

/** The store page drawn to HTML for one search, as a browser gets it. */
async function searchPage(q: string): Promise<string> {
  answering(new NextRequest(`https://marktmorgen.com/@kilnworks?q=${encodeURIComponent(q)}`, { headers: { "x-forwarded-for": "203.0.113.7" } }));
  const node = await StorePage({ params: Promise.resolve({ handle: "@kilnworks" }), searchParams: Promise.resolve({ q }) });
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return await new Response(stream).text();
}

/** HTML text with the escapes React writes turned back. */
function text(html: string): string {
  return html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", NAME, "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_order0001", subscriptionId: "sub_order0001", active: true, tier: "creator", period: paidPeriod() });
  // More products than one page holds, so the store offers a search. Titles
  // are added out of alphabetical order, so the creator's order is not A–Z.
  const titles = Array.from({ length: STORE_PAGE_SIZE + 2 }, (_, n) => `Glaze ${String.fromCharCode(90 - (n % 26))}${n}`);
  for (const title of titles) {
    const made = await addProduct(OWNER, title, "", "20", null);
    if (!made.ok) throw new Error(`no product: ${title}`);
  }
  const store = (await storeForEmail(OWNER)) as Store;

  part("The order the search really uses");
  const found = await searchStore(store, "glaze");
  const creatorOrder = store.catalog.items.map((item) => item.id);
  is("matches come in the creator's own order, not by title", found.listings.map((l) => l.id), creatorOrder.slice(0, found.listings.length));

  part("Every buyer language says it");
  for (const language of LANGUAGES) {
    const line = orderLine(language);
    is(`${language}: a line tells the order of search results`, typeof line === "string" && line.includes(NAME), true);
  }
  is("each language has its own words", new Set(LANGUAGES.map(orderLine)).size, LANGUAGES.length);
  // What the code guarantees is that Marktmorgen sells no placement, not that nobody can pay the creator for one
  // (Claude 5's LEVE, Claude 1's LOW on #2850): every language says who cannot be paid.
  for (const language of LANGUAGES) is(`${language}: it says Marktmorgen sells no placement`, orderLine(language)?.includes("Marktmorgen"), true);

  part("The store page shows it beside the results");
  for (const language of LANGUAGES) {
    await setLanguage(OWNER, language);
    const page = text(await searchPage("glaze"));
    const found = BLOCK_WORDS[language].searchFound(STORE_PAGE_SIZE + 2, "glaze");
    is(`${language}: the search found the products`, page.includes(found), true);
    const line = orderLine(language);
    is(`${language}: the order line is shown with them`, line !== null && page.includes(line), true);
    if (line !== null) is(`${language}: it comes right after the results count`, page.indexOf(line) > page.indexOf(found), true);
  }

  // Claude 5's LOW 2 on #2850: the line is held by the page itself, not only by searchStore: after the creator moves
  // a product to the top and turns another back into a draft, the results are drawn in that new order, without it.
  part("The page draws the creator's order, as it stands after a move and a draft");
  await setLanguage(OWNER, "en");
  const last = store.catalog.items[store.catalog.items.length - 1].id;
  const drafted = store.catalog.items[1].id;
  const moved = await moveProduct(OWNER, last, "top");
  is("control: the move is saved", moved.ok, true);
  is("control: the draft is saved", (await setProductHidden(OWNER, drafted, true)).ok, true);
  const after = (await storeForEmail(OWNER)) as Store;
  const expected = after.catalog.items.map((item) => item.id).filter((id) => id !== drafted);
  const drawn = text(await searchPage("glaze"));
  // A product's address on the page (components/store-product.tsx): /@handle/p/<title slug and id>.
  const allTitles = new Map(store.catalog.items.map((item, n) => [item.id, titles[n]]));
  const hrefOf = (id: string) => `/@kilnworks/p/${productSegment({ id, title: allTitles.get(id) ?? "" })}"`;
  const shown = expected.filter((id) => drawn.includes(hrefOf(id)));
  is("the moved product is drawn first", shown[0], last);
  is("the draft is not drawn", drawn.includes(hrefOf(drafted)), false);
  is("the drawn products follow the creator's order", shown.map((id) => drawn.indexOf(hrefOf(id))).every((at, i, all) => i === 0 || at > all[i - 1]), true);
  is("every match but the draft is drawn", shown.length, expected.length);

  // Claude 5's LOW 1 on #2850: many stores carry the creator's own name, so the English line names no pronoun for it.
  part("The English line reads right for a store named after a person");
  is("no \"its\" for the store", / its /.test(String(orderLine("en"))), false);

  part("No match, no order to tell");
  await setLanguage(OWNER, "en");
  const empty = text(await searchPage("teapot"));
  is("the empty search is answered", empty.includes(BLOCK_WORDS.en.searchNone("teapot")), true);
  const line = orderLine("en");
  is("no order line under nothing", line === null || !empty.includes(line), true);

  answering(null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
