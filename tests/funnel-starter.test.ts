/**
 * A ready path for the offers after paying (487 [IT4], item 5; added 2
 * November 2026): from the creator's own published products that are not
 * bundles, the dearest first and, after "no thanks", the cheapest one that
 * costs strictly less, each at its own price; never when all cost the same;
 * words with the prices, true for what was picked; offered only on an empty
 * funnel; taken by the server's own check once saved; opened unsaved, said,
 * and the focus on the first offer's product.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { FunnelEditor } from "@/components/funnel-editor";
import { commonPath, commonPathWords } from "@/lib/funnel-starter";
import { funnelProblem, parseFunnel } from "@/lib/funnel";
import { addProduct, claimHandle, ensureStatsId, setProductLink, storeForEmail } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { formatMoney } from "@/lib/money";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const money = (cents: number) => formatMoney(cents, "usd");
const p = (id: string, title: string, priceCents: number, more: { bundle?: boolean; draft?: boolean } = {}) => ({ id, title, priceCents, ...more });

async function main(): Promise<void> {
  part("The path");
  const path = commonPath([p("list01", "Pantry List", 900), p("guide1", "Dinner Guide", 2900), p("pack01", "Recipe Pack", 4900), p("card01", "Meal Cards", 1900)]);
  is("the dearest first, whatever the order; after no thanks, the cheapest", [path?.first.id, path?.second.id], ["pack01", "list01"]);
  is("never a bundle nor a draft", commonPath([p("bund01", "All of it", 9900, { bundle: true }), p("draft1", "Not ready", 7900, { draft: true }), p("guide1", "Dinner Guide", 2900), p("list01", "Pantry List", 900)]), { first: p("guide1", "Dinner Guide", 2900), second: p("list01", "Pantry List", 900) });
  is("none with fewer than two that qualify, or when all cost the same", [commonPath([p("guide1", "Dinner Guide", 2900)]), commonPath([p("a00001", "A", 1900), p("b00001", "B", 1900)]), commonPath([p("bund01", "All", 9900, { bundle: true }), p("guide1", "Guide", 2900)])], [null, null, null]);
  is("the words, with the prices and the titles in quotes", commonPathWords(path!, money), "Buyers are offered “Recipe Pack” ($49). If they say no thanks, they are offered “Pantry List” ($9), which costs less. You can change either one; nothing is shown to buyers until you save.");

  part("As saved, the server's own check takes it");
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "pathshop", "Path Shop", "Recipes.");
  await ensureStatsId(OWNER);
  const made: string[] = [];
  for (const [title, price] of [["Course", "99"], ["Recipe Pack", "49"], ["Pantry List", "9"]] as const) {
    const added = await addProduct(OWNER, title, "Words.", price, null);
    if (!added.ok) throw new Error("no product");
    await setProductLink(OWNER, added.product.id, "https://example.com/" + title.length);
    made.push(added.product.id);
  }
  const store = (await storeForEmail(OWNER))!;
  const listings = await readListings(store, made);
  const owner = listings.find((l) => l.id === made[0])!;
  const offerable = listings.filter((l) => l.id !== owner.id).map((l) => ({ id: l.id, title: l.title, priceCents: l.priceCents, bundle: Boolean(l.bundle), draft: l.hidden }));
  const real = commonPath(offerable)!;
  const funnel = parseFunnel({ steps: [
    { id: "aaaa01", productId: real.first.id, priceCents: real.first.priceCents, headline: "", text: "", imageFrom: null, yes: null, no: "aaaa02" },
    { id: "aaaa02", productId: real.second.id, priceCents: real.second.priceCents, headline: "", text: "", imageFrom: null, yes: null, no: null },
  ] })!;
  is("the pack first, the list after no thanks; no problem for the server", [real.first.title, real.second.title, funnelProblem(funnel, listings, owner)], ["Recipe Pack", "Pantry List", null]);

  part("In the editor");
  const render = (list: ReturnType<typeof p>[], initial: unknown = null) =>
    renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { push() {}, refresh() {}, prefetch() {} } as never }, createElement(FunnelEditor, { owner: { id: "own001", title: "Course", priceCents: 9900 }, initial: initial as never, offerable: list, pictures: [], ownerPrice: "$99.00" })));
  const list = [p("guide1", "Dinner Guide", 2900), p("pack01", "Recipe Pack", 4900), p("list01", "Pantry List", 900)];
  const html = render(list);
  is("on an empty funnel: under its heading, its words tied to its button", [html.includes('<h3 id="funnel-starter-title"'), html.includes(`<p id="funnel-starter-words" class="mt-1 text-sm text-ink-soft">${commonPathWords(commonPath(list)!, money)}</p>`), html.includes('aria-describedby="funnel-starter-words">Use this path</button>')], [true, true, true]);
  is("after the main button, so its 'Or' follows it", html.indexOf("Add the first offer") < html.indexOf("Or start from a common path"), true);
  is("not when no path can be made, nor once there is an offer", [render([p("guide1", "Dinner Guide", 2900)]).includes("data-funnel-starter"), render(list, funnel).includes("data-funnel-starter")], [false, false]);
  const source = readFileSync("components/funnel-editor.tsx", "utf8");
  is("opened unsaved: two offers, each at its product's own price, no words of ours, the second after no thanks", [source.includes('{ id: first, productId: starter.first.id, price: moneyField(starter.first.priceCents, currency), headline: "", text: "", imageFrom: "", yes: "", no: second }'), source.includes('{ id: second, productId: starter.second.id, price: moneyField(starter.second.priceCents, currency), headline: "", text: "", imageFrom: "", yes: "", no: "" }')], [true, true]);
  is("said, and the focus moved to the first offer's product, whose field has that id", [source.includes('toast("Two offers added. Not saved yet.");'), source.includes("document.getElementById(`step-${first}-p`)?.focus()"), source.includes("id={`${base}-p`}")], [true, true, true]);
  const page = readFileSync("app/studio/funnels/page.tsx", "utf8");
  is("the studio says which products are bundles or drafts", [page.includes("bundle: Boolean(p.bundle),"), page.includes("draft: p.hidden,")], [true, true]);
  done();
}

void main();
