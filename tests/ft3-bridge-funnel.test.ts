/**
 * The "Bridge page" funnel type (530 [FT3], lib/funnel-types.ts).
 *
 * A bridge page stands between a post or an ad and one of the creator's own
 * products: a title, a short video of the creator in the players the store
 * already has, and one button to that product's page, where its checkout is.
 * It asks nothing (no form). The type writes no sentence: it makes the one
 * page, empty under its title and kept from visitors, and a funnel of that
 * page and the product that starts switched off.
 *
 * What is checked:
 *   - the type exists, after the kinds the site's picture of funnels shows,
 *     asks for one product (free or paid, never a call) and makes one page:
 *     a title, a video and a button, with no form;
 *   - its words carry no figure, price, deadline or pressure word;
 *   - building it through the real route refuses a missing product and, with
 *     one, makes the hidden page and the switched-off funnel;
 *   - the button leads to the product chosen: as the funnel's next step, with
 *     the funnel's mark, and when the page is opened on its own, through the
 *     page's own target;
 *   - the AI draft's facts read the same rule, without any call to a model;
 *   - the Funnels page names and counts the kinds from the list itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { FUNNEL_TYPES, type FunnelType, choicesOf, funnelType, pagesOf, slotProblem } from "@/lib/funnel-types";
import { readFunnelFacts } from "@/lib/funnel-ai";
import { FEATURE_PAGES } from "@/lib/feature-pages";
import { readPageFunnels, nextHref, stepStates } from "@/lib/page-funnel-store";
import { readPage } from "@/lib/sales-page-store";
import { siteKey } from "@/lib/site-page-rules";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/page-funnels/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("The type");
  const found = funnelType("bridge");
  is("it exists, by its id", found?.label ?? null, "Bridge page");
  // Without it, the rest still runs against the shape it must have, and fails where the code does.
  const type: FunnelType = found ?? ({ id: "bridge", label: "", hint: "", slots: [] } as FunnelType);
  const ids = FUNNEL_TYPES.map((t) => t.id);
  is("it comes right after the small first purchase", ids[ids.indexOf("first-purchase") + 1], "bridge");
  is("the first five kinds, which the site's picture of funnels shows, stay as they were", ids.slice(0, 5), ["lead-magnet", "training", "challenge", "launch", "book"]);
  is("one step asks for a product, free or paid", choicesOf(type).map((slot) => [slot.key, slot.kind === "product" ? slot.wants : slot.kind]), [["product", "any"]]);
  const pages = pagesOf(type);
  is("it makes one page: a title, a video and one button, and no form", pages.map((page) => [page.blocks, page.form ?? null]), [[["hero", "video", "cta"], null]]);
  is("the page's button leads to the product chosen for it", pages.map((page) => page.target ?? null), ["product"]);
  is("the page comes first, then the product's own page", type.slots.map((slot) => slot.kind), ["page", "product"]);
  const words = [type.label, type.hint, ...type.slots.map((slot) => (slot.kind === "page" ? slot.title : slot.label))].join(" ");
  is("its words carry no figure, price or currency", /[0-9$€£%]/.test(words), false);
  is("nor a deadline or a pressure word", /\b(now|today|hurry|limited|only|last|save|saving|deal|discount|ends?|left|free|before it's gone)\b/i.test(words), false);
  is("it says the button leads to the product's page, where its checkout is", [/one button/i.test(type.hint), /checkout/i.test(type.hint), /no form/i.test(type.hint)], [true, true, true]);

  part("What fills its step");
  const step = choicesOf(type)[0] ?? { kind: "product" as const, key: "product", label: "", wants: "paid" as const };
  is(
    "a paid or a free product fits; a call or nothing does not",
    [slotProblem(step, { free: false, call: false }), slotProblem(step, { free: true, call: false }), slotProblem(step, { free: false, call: true }), slotProblem(step, null)],
    [null, null, "call", "missing"],
  );

  part("Building it");
  const OWNER = "bridgefunnel@example.com";
  await claimHandle(OWNER, "bridgeshop", "Bridge Shop", "");
  await ensureStatsId(OWNER);
  const course = await addProduct(OWNER, "Course", "", "49", null);
  if (!course.ok) throw new Error("no product");
  const session = await openSession(OWNER);
  const send = (body: Record<string, unknown>) =>
    POST(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));

  const missing = await send({ action: "from-type", type: "bridge", name: "From my video", products: {} });
  is("without a product it is refused, and nothing is made", [missing.status, (await missing.json()).error, (await storeForEmail(OWNER))!.sitePages.length], [400, "slot_missing", 0]);
  const made = await (await send({ action: "from-type", type: "bridge", name: "From my video", products: { product: course.product.id } })).json();
  const store = (await storeForEmail(OWNER))!;
  const funnels = await readPageFunnels(store.statsId);
  const page = store.sitePages[0];
  is("made: its page, then the product", [made.ok, funnels.length, funnels[0]?.steps.map((s) => s.kind), Boolean(page) && funnels[0]?.steps[0]?.id === page?.id, funnels[0]?.steps[1]?.id], [true, 1, ["page", "product"], true, course.product.id]);
  is("the funnel starts switched off", funnels[0]?.on, false);
  const blocks = page ? await readPage(store.statsId, siteKey(page.id)) : null;
  is("its page is out of the menu, empty under its title and kept from visitors", [page?.nav, blocks?.hidden, blocks?.blocks.map((b) => b.kind), blocks?.blocks[0]?.kind === "hero" ? blocks.blocks[0].headline : ""], [false, true, ["hero", "video", "cta"], type.slots[0]?.kind === "page" ? type.slots[0].title : "?"]);
  is("the video starts empty, for the creator's own", blocks?.blocks.find((b) => b.kind === "video")?.kind === "video" ? (blocks.blocks.find((b) => b.kind === "video") as { video: unknown }).video : "no video block", null);

  part("The button leads to the product chosen");
  const funnel = funnels[0];
  const states = funnel ? await stepStates(store, funnel) : [];
  const next = funnel ? nextHref(funnel, states, 0) : null;
  is("in the funnel: the product's page, with the funnel's mark", [next?.startsWith("/@bridgeshop/p/") ?? false, next?.endsWith(`?f=${funnel?.id}`) ?? false, states[1]?.step.id], [true, true, course.product.id]);
  is("opened on its own: the page's own target is that product", page?.target, course.product.id);
  is("and a page with a target sends its buttons to that product's page", /page\.target \? await readListing\(store, page\.target\)/.test(source("app/[handle]/[slug]/page.tsx")) && /productPath\(store, target\)/.test(source("app/[handle]/[slug]/page.tsx")), true);

  part("The AI draft reads the same rule");
  const facts = await readFunnelFacts(store, type, { product: course.product.id });
  is("the product is read as the step's product", facts.ok ? facts.facts.products.map((p) => p.id) : facts.error, [course.product.id]);
  const refused = await readFunnelFacts(store, type, {});
  is("no product is refused before any model call", refused.ok ? "ok" : refused.error, "slot_missing");

  part("The Funnels page counts and names the kinds from the list");
  const funnelsPage = FEATURE_PAGES.find((p) => p.slug === "funnels");
  const card = JSON.stringify(funnelsPage ?? {});
  is("it names the bridge page", /bridge page/i.test(card), true);
  is("it names every kind the studio offers", FUNNEL_TYPES.every((t) => card.toLowerCase().includes(t.label.toLowerCase())), true);
  is("and no longer says a fixed count", /Eight kinds to start from/.test(card), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
