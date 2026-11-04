/**
 * 274 [AX1] Part A item 6, "link without a clear purpose" (WCAG 2.4.4 and the
 * AAA 2.4.9, link purpose from the link's own words): "Can everyone use your
 * store?" names the links on the store's page whose words do not say where they
 * go ("Click here", "Read more", a bare address), with how to say it, and never
 * changes them (lib/store-access-check.ts, vagueLinkTitle).
 *
 * What fails here: a vague link left unnamed; a clear one named; a heading
 * (not a link) named; a link changed; the panel without the list, its advice
 * and where to change it; a store with links but no products left unchecked.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { StoreAccessCheck } from "@/components/store-access-check";
import { accessCheck, vagueLinkTitle } from "@/lib/store-access-check";
import { addStoreLink, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

part("Words that do not say where a link goes");
for (const title of ["Click here", "click here!", "Here", "Link", "This link", "Read more", "More", "Learn more", "See more", "Go", "Tap here", "https://example.com/shop", "www.example.com", "example.com", "→", "..."]) is(`vague: ${title}`, vagueLinkTitle(title), true);
for (const title of ["Book a call with me", "My YouTube channel", "Read more about the course", "Shop my presets", "Learn more about coaching", "Home", "Free guide: 10 bread recipes"]) is(`clear: ${title}`, vagueLinkTitle(title), false);

async function main(): Promise<void> {
  part("The store's links are checked, headings are not");
  redis.clear();
  const owner = "link-purpose@example.com";
  await claimHandle(owner, "linkpurposeshop", "Link Purpose Shop", "");
  await ensureStatsId(owner);
  is("no products and no links: nothing to check", accessCheck((await storeForEmail(owner))!), null);
  await addStoreLink(owner, "Click here", "https://example.com/one");
  await addStoreLink(owner, "My YouTube channel", "https://example.com/two");
  const store = (await storeForEmail(owner))!;
  const check = accessCheck(store);
  is("a store with links and no products is checked", check !== null, true);
  is("the vague link is named, the clear one is not", check?.links.vague.map((l) => l.title), ["Click here"]);
  is("nothing was changed", (await storeForEmail(owner))!.links.map((l) => l.title), ["Click here", "My YouTube channel"]);
  const withHeader = { ...store, links: [...store.links, { ...store.links[0], id: "hdr", title: "More", header: true }] };
  is("a heading between links is not a link", accessCheck(withHeader)?.links.vague.map((l) => l.title), ["Click here"]);

  part("What the studio shows");
  const shown = renderToStaticMarkup(StoreAccessCheck({ check: { pictures: { done: true, missing: [], unchecked: 0 }, links: { vague: [{ id: "a", title: "Read more" }, { id: "b", title: "https://example.com/x" }] } } }));
  is("each link named, with how to say it and where", [shown.includes("2 links do not say where they go"), shown.includes("<li>Read more</li>"), shown.includes("https://example.com/x"), /Say where it goes/.test(shown), shown.includes('href="#links"')], [true, true, true, true, true]);
  is("all links clear: said so", renderToStaticMarkup(StoreAccessCheck({ check: { pictures: { done: true, missing: [], unchecked: 0 }, links: { vague: [] } } })).includes('data-access-links="done"'), true);
  is("never a conformity claim", /fully accessible|ADA compliant|WCAG AAA certified|most accessible/i.test(shown), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
