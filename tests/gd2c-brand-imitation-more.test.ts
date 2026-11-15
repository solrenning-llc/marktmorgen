/**
 * 568 [GD2] (c), unit 2: posing as Marktmorgen is refused everywhere else a store's words reach its visitors.
 *
 * Unit 1 (tests/gd2c-brand-imitation.test.ts) refuses it on a product and its sales page. Here, with the real routes
 * on the in-memory database and a real session:
 *
 *   - the store's own pages (app/api/store/site-page): a page shown with posing words or a look-alike link is
 *     refused with "brand_imitation" and not written; a hidden page may keep them, as a draft product's page does,
 *     and is refused when it is shown;
 *   - a price's name and lines (app/api/store/option): refused with the field "option", and nothing added;
 *   - a saved section put on the pages that use it (app/api/store/saved-blocks, apply): a shown page is passed over
 *     with the reason and left exactly as it was; a hidden one takes it;
 *   - a bundle (app/api/store/bundle, create): refused before the product is made;
 *   - the bundle editor now says a refusal of what the Terms forbid with its passage, why and fix, not as an unknown
 *     error.
 *
 * Synthetic store and data only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, storeForEmail } from "@/lib/store";
import { readAllListings } from "@/lib/catalog";
import { readPage } from "@/lib/sales-page-store";
import { emptyBlock, type PageBlock } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { IMITATION_WHY } from "@/lib/brand-imitation-rules";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { POST as optionRoute } from "@/app/api/store/option/route";
import { POST as sections } from "@/app/api/store/saved-blocks/route";
import { POST as bundleRoute } from "@/app/api/store/bundle/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "posing.more@example.com";
type Json = Record<string, unknown> & { ok?: boolean; error?: string; passage?: { field?: string; why?: string } };

const text = (body: string, heading = "About"): PageBlock => ({ ...(emptyBlock("text") as Extract<PageBlock, { kind: "text" }>), heading, body });
const hero = (): PageBlock => ({ ...emptyBlock("hero"), headline: "Hello" }) as PageBlock;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "posingmore", "Posing More", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` };
  const call = (route: (r: NextRequest) => Promise<Response>, path: string) => async (body: unknown): Promise<Json & { status: number }> => {
    const response = await route(new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, ...((await response.json().catch(() => ({}))) as Json) };
  };
  const site = call(sitePage, "/api/store/site-page");
  const option = call(optionRoute, "/api/store/option");
  const send = call(sections, "/api/store/saved-blocks");
  const bundle = call(bundleRoute, "/api/store/bundle");
  const statsId = (await storeForEmail(OWNER))!.statsId!;

  part("The store's own pages");
  const shown = (await site({ action: "add", title: "About" })) as Json & { id: string };
  const draft = (await site({ action: "add", title: "Draft" })) as Json & { id: string };
  const before = await readPage(statsId, siteKey(shown.id));
  const posing = await site({ action: "save", id: shown.id, page: { blocks: [hero(), text("Regards, The Marktmorgen Team")], style: "plain", hidden: false } });
  is("a shown page that poses is refused, with the passage and why", [posing.status, posing.error, posing.passage?.field, posing.passage?.why], [409, "brand_imitation", "page", IMITATION_WHY]);
  is("and it is left as it was", await readPage(statsId, siteKey(shown.id)), before);
  const linked = await site({ action: "save", id: shown.id, page: { blocks: [hero(), text("See https://marktmorgen-login.com/start")], style: "plain", hidden: false } });
  is("so is a look-alike address in its words", [linked.status, linked.error], [409, "brand_imitation"]);
  const hidden = await site({ action: "save", id: draft.id, page: { blocks: [hero(), text("Regards, The Marktmorgen Team")], style: "plain", hidden: true } });
  is("a hidden page may keep the words", [hidden.status, hidden.ok], [200, true]);
  const showing = await site({ action: "save", id: draft.id, page: { blocks: [hero(), text("Regards, The Marktmorgen Team")], style: "plain", hidden: false } });
  is("and is refused when it is shown", [showing.status, showing.error], [409, "brand_imitation"]);
  const plain = await site({ action: "save", id: shown.id, page: { blocks: [hero(), text("My bakery runs on Marktmorgen.")], style: "plain", hidden: false } });
  is("plain words are saved on a shown page", [plain.status, plain.ok], [200, true]);

  part("A price's name and lines");
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("no product");
  const optionPosing = await option({ action: "add", id: made.product.id, label: "Marktmorgen Support plan", price: "29" });
  is("a price named as Marktmorgen's staff is refused, in the field option", [optionPosing.status, optionPosing.error, optionPosing.passage?.field], [409, "brand_imitation", "option"]);
  const lines = await option({ action: "add", id: made.product.id, label: "Full", price: "29", details: "Lifetime access\nVerify your Marktmorgen account to unlock" });
  is("so are its lines", [lines.status, lines.error], [409, "brand_imitation"]);
  const listed = (await readAllListings((await storeForEmail(OWNER))!)).find((listing) => listing.id === made.product.id);
  is("and no price was added", listed?.options?.length ?? 0, 0);
  const optionPlain = await option({ action: "add", id: made.product.id, label: "Full", price: "29", details: "Lifetime access" });
  is("a plain price is added", [optionPlain.status, optionPlain.ok], [200, true]);

  part("A saved section put on the pages that use it");
  const saved = await send({ action: "save", name: "Sign-off", blocks: [text("Thanks for reading.")] });
  const section = saved.section as { id: string; blocks: PageBlock[] };
  const other = (await site({ action: "add", title: "Hidden one" })) as Json & { id: string };
  for (const [page, hide] of [[shown.id, false], [other.id, true]] as const) {
    const put = await site({ action: "save", id: page, page: { blocks: [hero(), ...section.blocks.map((block) => ({ ...block, saved: section.id }))], style: "plain", hidden: hide } });
    if (!put.ok) throw new Error(`could not put the section: ${put.error}`);
  }
  const kept = await readPage(statsId, siteKey(shown.id));
  is("the section changes in the library", (await send({ action: "update", id: section.id, blocks: [text("Regards, The Marktmorgen Team")] })).ok, true);
  const applied = (await send({ action: "apply", id: section.id, pages: [siteKey(shown.id), siteKey(other.id)] })) as Json & { done: string[]; skipped: { key: string; why: string }[] };
  is("the shown page is passed over with the reason, the hidden one takes it", [applied.done, applied.skipped.map((s) => s.key), applied.skipped[0]?.why.includes(IMITATION_WHY)], [[siteKey(other.id)], [siteKey(shown.id)], true]);
  is("the shown page is left exactly as it was", await readPage(statsId, siteKey(shown.id)), kept);

  part("A bundle");
  const second = await addProduct(OWNER, "Workbook", "", "9", null);
  const third = await addProduct(OWNER, "Recipes", "", "12", null);
  if (!second.ok || !third.ok) throw new Error("no second product");
  // Each can be in a bundle: a price and something to hand over (lib/bundle-rules.ts, canBeInBundle).
  await setProductLink(OWNER, second.product.id, "https://example.com/workbook");
  await setProductLink(OWNER, third.product.id, "https://example.com/recipes");
  const count = (await readAllListings((await storeForEmail(OWNER))!)).length;
  const bundlePosing = await bundle({ action: "create", title: "Official Marktmorgen bundle", summary: "", price: "25", items: [second.product.id, third.product.id] });
  is("a bundle that poses is refused before it is made", [bundlePosing.status, bundlePosing.error], [409, "brand_imitation"]);
  is("and no product was made", (await readAllListings((await storeForEmail(OWNER))!)).length, count);

  part("The bundle editor says it");
  const editor = readFileSync("components/bundle-editor.tsx", "utf8");
  is("with the passage the route sent", /data\.error === "fast_money" \|\| data\.error === "brand_imitation"\) setError\(fastMoneyMessage\(data\.passage, "add"\)\)/.test(editor), true);
  is("the product editor says it for a price", /reason === "brand_imitation"\s*\?\s*fastMoneyMessage\(/.test(readFileSync("components/product-editor.tsx", "utf8")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
