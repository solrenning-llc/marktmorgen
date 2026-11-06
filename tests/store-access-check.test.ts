/**
 * 98 [D2-COMPLIANCE-REVIEW] unit 1: "Can everyone use your store?" in the
 * studio (lib/store-access-check.ts). Checked: an empty store gets nothing;
 * a product picture with no description is named, by product, with where it
 * is fixed; a described one is done; what Marktmorgen already does on every
 * store is said as done for the creator, and only what the code does.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { StoreAccessCheck } from "@/components/store-access-check";
import { addProduct, claimHandle, ensureStatsId, setImageAlt, setProductImage, storeForEmail, type Store } from "@/lib/store";
import { KIND } from "@/lib/catalog";
import { DigitalConsentMissing, requireDigitalConsent } from "@/lib/digital-consent";
import { contrast, lookColours } from "@/lib/store-look";
import { DISCLOSURE, DISCLOSURE_SHORT, finishPost } from "@/lib/affiliate-kit-rules";
import { accessCheck, ACCESS_DONE_FOR_YOU } from "@/lib/store-access-check";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const picture = (n: number) => ({ path: `images/${"a".repeat(24)}/${String(n).repeat(32)}.jpg`, width: 1200, height: 800, alt: "", bytes: 1, small: null });

async function main(): Promise<void> {
  redis.clear();
  const owner = "access-check@example.com";
  await claimHandle(owner, "accesscheckshop", "Access Check Shop", "");
  await ensureStatsId(owner);
  const check = async () => accessCheck((await storeForEmail(owner))!);

  part("Nothing before the first product");
  is("no check", await check(), null);

  part("Products with and without pictures");
  const bread = await addProduct(owner, "Bread Book", "", "19", null);
  const cake = await addProduct(owner, "Cake Course", "", "49", null);
  if (!bread.ok || !cake.ok) throw new Error("No synthetic products");
  is("no picture yet: nothing to describe, done", (await check())?.pictures, { done: true, missing: [], unchecked: 0 });
  await setProductImage(owner, bread.product.id, picture(1));
  await setProductImage(owner, cake.product.id, picture(2));
  is("two pictures with no description: both named", (await check())?.pictures, { done: false, missing: ["Bread Book", "Cake Course"], unchecked: 0 });
  await setImageAlt(owner, bread.product.id, "A loaf of sourdough bread on a board");
  is("one described: only the other is named", (await check())?.pictures, { done: false, missing: ["Cake Course"], unchecked: 0 });
  await setImageAlt(owner, cake.product.id, "   ");
  is("blank spaces are no description", (await check())?.pictures.missing, ["Cake Course"]);
  const stored = (await storeForEmail(owner))!;
  const hiddenCake: Store = { ...stored, catalog: { ...stored.catalog, items: stored.catalog.items.map((item) => item.id === cake.product.id ? { ...item, kind: item.kind | KIND.hidden } : item) } };
  is("a hidden product is not on the page, so not named", accessCheck(hiddenCake)?.pictures.missing, []);
  const notCarried: Store = { ...stored, catalog: { ...stored.catalog, head: stored.catalog.head.filter((l) => l.id !== cake.product.id) } };
  is("a first-page product whose card is not carried: unchecked, never done", accessCheck(notCarried)?.pictures, { done: false, missing: [], unchecked: 1 });
  const target = { ...stored.catalog.head.find((l) => l.id === cake.product.id)!, id: "offered-at-checkout-only" };
  const withTarget: Store = { ...stored, catalog: { ...stored.catalog, head: [...stored.catalog.head, target] } };
  is("a card carried only as a checkout offer, not on the first page: not named", accessCheck(withTarget)?.pictures.missing, ["Cake Course"]);
  await setImageAlt(owner, cake.product.id, "A chocolate cake with twelve candles");
  is("both described: done", (await check())?.pictures, { done: true, missing: [], unchecked: 0 });

  part("What the studio shows");
  const shown = renderToStaticMarkup(StoreAccessCheck({ check: { pictures: { done: false, missing: ["Bread Book", "Cake & Co"], unchecked: 0 }, links: { vague: [] } } }));
  is("a heading, each product named, the field's own label, and where to go", [shown.includes("Can everyone use your store?"), shown.includes("<li>Bread Book</li>"), shown.includes("Cake &amp; Co"), shown.includes("What the picture shows, for people who cannot see it"), shown.includes('href="#products"'), shown.includes("Go to your products to check descriptions")], [true, true, true, true, true, true]);
  is("never a conformity claim", /fully accessible|ADA compliant|WCAG AAA certified|most accessible/i.test(shown), false);
  is("says it is not a full review", shown.includes("It is not a full accessibility review."), true);
  is("done: said so, no list", renderToStaticMarkup(StoreAccessCheck({ check: { pictures: { done: true, missing: [], unchecked: 0 }, links: { vague: [] } } })).includes('data-access-pictures="done"'), true);
  is("an empty store: nothing", renderToStaticMarkup(StoreAccessCheck({ check: null })), "");

  const partly = renderToStaticMarkup(StoreAccessCheck({ check: { pictures: { done: false, missing: [], unchecked: 2 }, links: { vague: [] } } }));
  is("unchecked products are said, and not called done", [partly.includes("2 products on your first page could not be checked here"), partly.includes('data-access-pictures="done"')], [true, false]);
  is("the heading states, it does not order (a decorative picture may stay empty)", [shown.includes("2 product pictures have no description"), shown.includes("an empty description is right")], [true, true]);

  part("Done for you, and true");
  let refused = false;
  try { requireDigitalConsent(true, null); } catch (error) { refused = error instanceof DigitalConsentMissing; }
  is("a digital delivery without the buyer's yes opens no payment", refused, true);
  is("the sentence says so and claims no law", [ACCESS_DONE_FOR_YOU[0].includes("The payment does not open without it."), /require|gives up/.test(ACCESS_DONE_FOR_YOU[0])], [true, false]);
  const picks = ["#ffffff", "#000000", "#ffff00", "#7c3aed", "#00ff88", "#888888", "#ff0000", "#0000ff"];
  is("every picked button color keeps its words at 7:1 or more, on every theme", (["light", "sand", "night", "bold"] as const).every((theme) => picks.every((accent) => {
    const c = lookColours({ theme: theme as never, accent });
    return contrast(c.accent, c.onAccent) >= 7;
  })), true);
  is("an AI-drafted post ends with the disclosure, the long and the X one", [finishPost("Great book.", "https://x.example/a", DISCLOSURE.en).endsWith(DISCLOSURE.en), finishPost("Great book.", "https://x.example/a", DISCLOSURE_SHORT.en).endsWith(DISCLOSURE_SHORT.en)], [true, true]);
  is("the sentence matches both: an ad or an affiliate link, no claim about a commission", [/ad or an affiliate link/.test(ACCESS_DONE_FOR_YOU[2]), /commission/.test(ACCESS_DONE_FOR_YOU[2])], [true, false]);
  is("three things, each in plain words", [ACCESS_DONE_FOR_YOU.length, ACCESS_DONE_FOR_YOU.every((line) => line.length < 200 && !/fully accessible|ADA compliant|WCAG AAA certified|most accessible/i.test(line))], [3, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
