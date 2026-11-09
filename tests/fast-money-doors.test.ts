/**
 * 567 [GD1] (d): the promise of fast or easy money that the Terms forbid is refused on every door that puts a page
 * in front of the public, not only on the product page route (tests/fast-money-page.test.ts):
 *   (1) a saved section: "apply" writes the section's blocks into the pages that use it, a published product's page
 *       and a visible or scheduled page of the store's own among them;
 *   (2) a store's own page: "save" in site-page, visible or scheduled (a hidden draft may hold the words, as a draft
 *       product's page may; the check runs when it is shown).
 * A page the check stops is left as it was and said in `skipped` (apply) or 409 `fast_money` (save), in the words of
 * fastMoneyMessage. Nothing the creator wrote is changed.
 *
 * What fails here: a published product's page or a shown page that receives the promise by either door; a draft
 * product's page that is refused (it is checked when published); a section that stops working for innocent words.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductHidden, storeForEmail } from "@/lib/store";
import { emptyBlock, type PageBlock } from "@/lib/sales-page";
import { blocksForPage } from "@/lib/saved-blocks";
import { siteKey } from "@/lib/site-page-rules";
import { readPage } from "@/lib/sales-page-store";
import { pageWords } from "@/lib/page-translate";
import { fastMoneyOnPage } from "@/lib/terms-check-rules";
import { POST as savePage } from "@/app/api/store/page/route";
import { POST as SAVED } from "@/app/api/store/saved-blocks/route";
import { POST as SITE_PAGE } from "@/app/api/store/site-page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "fastmoney.doors@example.com";
const ORIGIN = "https://marktmorgen.com";
const text = (id: string, body: string): PageBlock => ({ id, kind: "text", heading: "Why", body });
const BAD = "Make easy money from home with no effort, starting today.";
const GOOD = "Because it works.";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "fastdoors", "Fast Doors", "");
  await ensureStatsId(OWNER);
  const published = await addProduct(OWNER, "Guide", "", "29", null);
  const draft = await addProduct(OWNER, "Draft guide", "", "29", null);
  if (!published.ok || !draft.ok) throw new Error("no product");
  await setProductHidden(OWNER, published.product.id, false);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const post = async (fn: (r: NextRequest) => Promise<Response>, path: string, body: unknown) => {
    const response = await fn(new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const statsId = (await storeForEmail(OWNER))!.statsId;
  const wordsOf = async (key: string) => pageWords(await readPage(statsId, key));
  const held = async (key: string) => fastMoneyOnPage(await wordsOf(key)) !== null;

  part("Control: the product page door refuses the promise");
  const direct = await post(savePage, "/api/store/page", { id: published.product.id, page: { blocks: [emptyBlock("hero"), text("bad00001", BAD)] } });
  is("a published product's page with the promise is refused", [direct.status, direct.json.error], [409, "fast_money"]);

  part("(1) A saved section applied to a published product, a draft product and a store page");
  const saved = await post(SAVED, "/api/store/saved-blocks", { action: "save", name: "Why", blocks: [text("why00001", GOOD)] });
  if (!saved.json.ok) throw new Error(`section: ${JSON.stringify(saved.json)}`);
  const section = saved.json.section as { id: string; blocks: PageBlock[] };
  const around = [emptyBlock("hero"), ...blocksForPage(section)];
  is("the published product's page takes the innocent section", (await post(savePage, "/api/store/page", { id: published.product.id, page: { blocks: around } })).status, 200);
  is("the draft product's page takes it", (await post(savePage, "/api/store/page", { id: draft.product.id, page: { blocks: around } })).status, 200);
  const shownPage = await post(SITE_PAGE, "/api/store/site-page", { action: "add", title: "Start here" });
  const shownId = (shownPage.json.id ?? (shownPage.json.page as { id?: string } | undefined)?.id ?? (shownPage.json.pages as { id: string }[] | undefined)?.at(-1)?.id) as string;
  const hiddenPage = await post(SITE_PAGE, "/api/store/site-page", { action: "add", title: "Later" });
  const hiddenId = (hiddenPage.json.pages as { id: string }[] | undefined)?.at(-1)?.id as string;
  is("two store pages exist", [typeof shownId, typeof hiddenId, shownId !== hiddenId], ["string", "string", true]);
  is("the visible store page takes the innocent section", (await post(SITE_PAGE, "/api/store/site-page", { action: "save", id: shownId, page: { blocks: around, style: "plain", hidden: false } })).status, 200);
  is("the hidden store page takes it", (await post(SITE_PAGE, "/api/store/site-page", { action: "save", id: hiddenId, page: { blocks: around, style: "plain", hidden: true } })).status, 200);

  const updated = await post(SAVED, "/api/store/saved-blocks", { action: "update", id: section.id, blocks: [text("why00001", BAD)] });
  is("the section may be changed (it is a library entry, not a page)", updated.json.ok, true);
  const keys = [published.product.id, draft.product.id, siteKey(shownId), siteKey(hiddenId)];
  const applied = await post(SAVED, "/api/store/saved-blocks", { action: "apply", id: section.id, pages: keys });
  const doneKeys = (applied.json.done as string[] | undefined) ?? [];
  const skipped = (applied.json.skipped as { key: string; why: string }[] | undefined) ?? [];
  is("the apply answers", applied.json.ok, true);
  is("the published product's page is skipped, not written", [doneKeys.includes(published.product.id), skipped.some((s) => s.key === published.product.id)], [false, true]);
  is("the visible store page is skipped, not written", [doneKeys.includes(siteKey(shownId)), skipped.some((s) => s.key === siteKey(shownId))], [false, true]);
  is("the draft product's page takes it (checked when published)", doneKeys.includes(draft.product.id), true);
  is("the hidden store page takes it (checked when shown)", doneKeys.includes(siteKey(hiddenId)), true);
  is("the skipped reason is the Terms sentence", /fast or easy money/.test(skipped.find((s) => s.key === published.product.id)?.why ?? ""), true);
  is("the published page still holds the innocent words", [await held(published.product.id), (await wordsOf(published.product.id)).includes(GOOD)], [false, true]);
  is("the visible store page still holds the innocent words", [await held(siteKey(shownId)), (await wordsOf(siteKey(shownId))).includes(GOOD)], [false, true]);
  is("no public page holds the promise", [await held(published.product.id), await held(siteKey(shownId))], [false, false]);

  part("(2) A store's own page: save");
  const blocks = [{ ...emptyBlock("hero"), headline: "Hello" }, text("bad00002", BAD)];
  const shown = await post(SITE_PAGE, "/api/store/site-page", { action: "save", id: shownId, page: { blocks, style: "plain", hidden: false } });
  is("a visible page with the promise is refused (409 fast_money)", [shown.status, shown.json.error], [409, "fast_money"]);
  is("the refusal quotes the passage", typeof (shown.json.passage as { excerpt?: unknown } | undefined)?.excerpt, "string");
  is("the page was left as it was", await held(siteKey(shownId)), false);
  const later = Math.floor(Date.now() / 1000) + 3600;
  const scheduled = await post(SITE_PAGE, "/api/store/site-page", { action: "save", id: hiddenId, page: { blocks, style: "plain", hidden: true, showFrom: later } });
  is("a scheduled page with the promise is refused", [scheduled.status, scheduled.json.error], [409, "fast_money"]);
  const hidden = await post(SITE_PAGE, "/api/store/site-page", { action: "save", id: hiddenId, page: { blocks, style: "plain", hidden: true } });
  is("a hidden draft may hold the words until it is shown", hidden.status, 200);
  const turnedOn = await post(SITE_PAGE, "/api/store/site-page", { action: "save", id: hiddenId, page: { blocks, style: "plain", hidden: false } });
  is("showing it with the promise is refused", [turnedOn.status, turnedOn.json.error], [409, "fast_money"]);
  const plain = await post(SITE_PAGE, "/api/store/site-page", { action: "save", id: shownId, page: { blocks: [{ ...emptyBlock("hero"), headline: "Hello" }, text("ok000003", "Ten loaves, step by step.")], style: "plain", hidden: false } });
  is("a visible page with plain words is saved", plain.status, 200);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
