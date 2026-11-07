/**
 * The "Product bundle" funnel type (576 [FT8], lib/funnel-types.ts).
 *
 * A bundle is already one product of the store that hands over two or more
 * of its other products at a price of its own (lib/bundle-rules.ts): its page
 * shows what is inside and, only when it is true, what those products cost on
 * their own; its checkout and the delivery of each product are the bundle's
 * own. The type adds no page that sells and writes no sentence: it walks the
 * creator's own bundle page, then a "what happens next" page that is made
 * empty and kept from visitors, in a funnel that starts switched off.
 *
 * What is checked:
 *   - the type exists, asks for exactly one bundle and makes one page;
 *   - its words carry no figure, price, deadline or pressure word;
 *   - only a bundle fills its step, and a product not known to be one never
 *     does (a caller that does not say "bundle" fails closed);
 *   - the studio says plainly that a bundle is needed and where to make one,
 *     and every list that reads products for a type passes whether each is a
 *     bundle;
 *   - building it through the real route refuses a product that is not a
 *     bundle, and with one makes the hidden page and the switched-off funnel;
 *   - the AI draft's facts accept the bundle and refuse a non-bundle, without
 *     any call to a model.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import * as funnelTypes from "@/lib/funnel-types";
import { FUNNEL_TYPES, type FunnelSlot, type FunnelType, choicesOf, funnelType, pagesOf, slotProblem } from "@/lib/funnel-types";
import { readFunnelFacts } from "@/lib/funnel-ai";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { readPage } from "@/lib/sales-page-store";
import { siteKey } from "@/lib/site-page-rules";
import { addProduct, claimHandle, ensureStatsId, setProductBundle, setProductLink, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/page-funnels/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");
// Read through the module, so a build without it fails these checks one by one rather than not at all.
const noneYet = (slot: FunnelSlot): { text: string; where: string } =>
  (funnelTypes as { noneYet?: (slot: FunnelSlot) => { text: string; where: string } }).noneYet?.(slot) ?? { text: "", where: "" };

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("The type");
  const found = funnelType("bundle");
  is("it exists, by its id", found?.label ?? null, "Product bundle");
  // Without it, the rest still runs against the shape it must have, and fails where the code does.
  const type: FunnelType = found ?? ({ id: "bundle", label: "", hint: "", slots: [{ kind: "product", key: "bundle", label: "", wants: "bundle" }] } as unknown as FunnelType);
  is("it is listed after the kinds that were there before it", FUNNEL_TYPES.at(-1)?.id, "bundle");
  is("one step asks for a bundle, and nothing else is chosen", choicesOf(type).map((slot) => [slot.key, slot.kind === "product" ? slot.wants : slot.kind]), [["bundle", "bundle"]]);
  is("it makes one page: what happens next, empty blocks under its title", pagesOf(type).map((page) => [page.slug, page.blocks]), [["all-set", ["hero", "steps", "cta"]]]);
  is("the bundle's own page comes first, then that page", type.slots.map((slot) => slot.kind), ["product", "page"]);
  const words = [type.label, type.hint, ...type.slots.map((slot) => (slot.kind === "page" ? slot.title : slot.label))].join(" ");
  is("its words carry no figure, price or currency", /[0-9$€£%]/.test(words), false);
  is("nor a deadline or a pressure word", /\b(now|today|hurry|limited|only|last|save|saving|deal|discount|ends?|left|free)\b/i.test(words), false);
  // Claude 1 review of #2933: a bundle whose buyers choose some of its products
  // (lib/bundle-rules.ts picks) fills this step too, and hands over only the
  // chosen ones (lib/answers.ts deliveryWords), so the card and the AI prompt
  // must not promise every product in it.
  is("it does not promise every product in the bundle", /each product in it/i.test(type.hint), false);
  is("it says the buyer gets what the bundle hands over, each as if bought on its own", [/what the bundle hands over/i.test(type.hint), /as if they bought it on its own/i.test(type.hint)], [true, true]);

  part("Only a bundle fills its step");
  const step = choicesOf(type)[0];
  is(
    "a bundle fits; a paid product, a free one, a call or nothing does not",
    [
      slotProblem(step, { free: false, call: false, bundle: true }),
      slotProblem(step, { free: false, call: false, bundle: false }),
      slotProblem(step, { free: true, call: false, bundle: false }),
      slotProblem(step, { free: false, call: true, bundle: false }),
      slotProblem(step, null),
    ],
    [null, "bundle", "bundle", "bundle", "missing"],
  );
  is("a product not said to be a bundle is not taken for one", slotProblem(step, { free: false, call: false }), "bundle");
  const paid = choicesOf(funnelType("first-purchase")!)[0];
  is("a bundle still fills a step that asks for any paid product, as before", slotProblem(paid, { free: false, call: false, bundle: true }), null);

  part("The studio says what it needs");
  const none = noneYet(step);
  is("with no bundle yet, it says what one is and where to make one", [none.where, /no bundle yet/i.test(none.text), /two or more of your products/i.test(none.text), /Bundles/.test(none.text)], ["bundles", true, true, true]);
  is("the other kinds keep pointing at Products", [noneYet({ kind: "product", key: "x", label: "x", wants: "paid" }).where, noneYet({ kind: "product", key: "x", label: "x", wants: "free" }).where, noneYet({ kind: "target", key: "x", label: "x", wants: "call" }).where], ["products", "products", "products"]);
  const picker = source("components/funnel-type-picker.tsx");
  is("the picker has words for a step that needs a bundle", /slot_bundle:\s*"[^"]*bundle[^"]*"/.test(picker), true);
  is("the picker says what is missing from the kind's own card and from its step", (picker.match(/noneYet\(/g) ?? []).length >= 2, true);
  is("the picker links to Bundles", picker.includes("/studio/bundles"), true);
  is("the studio tells the picker which products are bundles", /typeProducts[^\n]*bundle: bundleKinds\.has\(p\.id\)/.test(source("app/studio/funnels/page.tsx")), true);
  is("the route that builds a funnel passes whether each product is a bundle", /slotProblem\(slot, [^\n]*bundle: bundles\.has\(id\)/.test(source("app/api/store/page-funnels/route.ts")), true);
  is("so does the AI draft's reading of the facts", /slotProblem\(slot, [^\n]*bundle: bundles\.has\(id\)/.test(source("lib/funnel-ai.ts")), true);

  part("Building it");
  const OWNER = "bundlefunnel@example.com";
  await claimHandle(OWNER, "bundlefunnel", "Bundle Funnel", "");
  await ensureStatsId(OWNER);
  const guide = await addProduct(OWNER, "Guide", "", "19", null);
  const workbook = await addProduct(OWNER, "Workbook", "", "29", null);
  const kit = await addProduct(OWNER, "Starter kit", "", "39", null);
  if (!guide.ok || !workbook.ok || !kit.ok) throw new Error("no products");
  for (const product of [guide, workbook]) {
    const linked = await setProductLink(OWNER, product.product.id, `https://example.com/${product.product.id}`);
    if (!linked.ok) throw new Error("no link");
  }
  const bundled = await setProductBundle(OWNER, kit.product.id, [guide.product.id, workbook.product.id]);
  is("the fixture bundle is a real bundle of the store's two products", bundled.ok, true);
  const session = await openSession(OWNER);
  const send = (body: Record<string, unknown>) =>
    POST(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));

  const wrong = await send({ action: "from-type", type: "bundle", name: "Bundle", products: { bundle: guide.product.id } });
  is("a product that is not a bundle is refused, and nothing is made", [wrong.status, (await wrong.json()).error, (await storeForEmail(OWNER))!.sitePages.length], [400, "slot_bundle", 0]);
  const made = await (await send({ action: "from-type", type: "bundle", name: "Starter kit funnel", products: { bundle: kit.product.id } })).json();
  const store = (await storeForEmail(OWNER))!;
  const funnels = await readPageFunnels(store.statsId);
  const page = store.sitePages[0];
  is("made: the bundle's own page, then a page of its own", [made.ok, funnels.length, funnels[0]?.steps.map((s) => s.kind), funnels[0]?.steps[0]?.id, Boolean(page) && funnels[0]?.steps[1]?.id === page?.id], [true, 1, ["product", "page"], kit.product.id, true]);
  is("the funnel starts switched off", funnels[0]?.on, false);
  const blocks = page ? await readPage(store.statsId, siteKey(page.id)) : null;
  is("its page is out of the menu, empty under its title and kept from visitors", [page?.nav, blocks?.hidden, blocks?.blocks.map((b) => b.kind), blocks?.blocks[0]?.kind === "hero" ? blocks.blocks[0].headline : ""], [false, true, ["hero", "steps", "cta"], "You're all set"]);

  part("The AI draft reads the same rule");
  const facts = await readFunnelFacts(store, type, { bundle: kit.product.id });
  is("the bundle is read as the step's product", facts.ok ? facts.facts.products.map((p) => p.id) : facts.error, [kit.product.id]);
  const refused = await readFunnelFacts(store, type, { bundle: workbook.product.id });
  is("a product that is not a bundle is refused before any model call", refused.ok ? "ok" : refused.error, "slot_bundle");

  // From Claude 1's proof (review of #2933): the type also takes a bundle whose
  // buyers choose, so its words above are checked against that case.
  part("A bundle whose buyers choose fills it too");
  const checklist = await addProduct(OWNER, "Checklist", "", "9", null);
  const pickTwo = await addProduct(OWNER, "Choose two", "", "39", null);
  if (!checklist.ok || !pickTwo.ok) throw new Error("no products");
  const checklistLinked = await setProductLink(OWNER, checklist.product.id, `https://example.com/${checklist.product.id}`);
  if (!checklistLinked.ok) throw new Error("no link");
  const picked = await setProductBundle(OWNER, pickTwo.product.id, [guide.product.id, workbook.product.id, checklist.product.id], 2);
  is("the fixture is a real bundle of three where buyers choose two", picked.ok, true);
  const pickMade = await (await send({ action: "from-type", type: "bundle", name: "Choose two funnel", products: { bundle: pickTwo.product.id } })).json();
  is("the route builds the funnel with it", pickMade.ok, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
