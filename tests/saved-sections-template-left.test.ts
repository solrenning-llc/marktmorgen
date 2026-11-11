/**
 * 754 [STN1], a sibling of #3593: a saved section updated onto the pages
 * that use it (app/api/store/saved-blocks/route.ts, "apply") never takes a
 * part a template left to write, ⟦like this⟧ or a campaign's [bracket]
 * part, onto a page visitors see: a store's own page that is shown or
 * scheduled, or the page of a product on the store. The whole request is
 * refused with the part and the pages, before the month's count is taken
 * and before any page is read or written; hidden pages and drafts' pages
 * still take it. The list of pages an update offers says why such a page
 * cannot be updated, so it is not checked to begin with.
 *
 * What fails here: a shown page, a scheduled page or a published product's
 * page updated with a section holding a part; a refusal that writes a page
 * or takes the month's count; a hidden page refused; the list offering a
 * shown page with nothing said.
 */
import { NextRequest } from "next/server";
import { emptyBlock, type PageBlock } from "@/lib/sales-page";
import { blocksForPage } from "@/lib/saved-blocks";
import { siteKey } from "@/lib/site-page-rules";
import { readPage } from "@/lib/sales-page-store";
import { storeMonthKey } from "@/lib/funnel-share-store";
import { monthOfUse } from "@/lib/funnel-share-rules";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/saved-blocks/route";
import { POST as SITE_PAGE } from "@/app/api/store/site-page/route";
import { POST as PAGE } from "@/app/api/store/page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const faq = (q: string): PageBlock => ({ ...(emptyBlock("faq") as Extract<PageBlock, { kind: "faq" }>), items: [{ q, a: "An answer." }] });
const hero = { ...emptyBlock("hero"), headline: "Hello" } as PageBlock;
const LEFT = "⟦Write the question buyers ask most⟧";

async function main() {
  redis.clear();
  const OWNER = "sections.left@example.com";
  await claimHandle(OWNER, "sectionsleft", "Sections Left", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const call = async (route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const site = (body: Record<string, unknown>) => call(SITE_PAGE, "site-page", body);
  const send = (body: Record<string, unknown>) => call(POST, "saved-blocks", body);

  const saved = await send({ action: "save", name: "Buyer questions", blocks: [faq("Is it for me?")] });
  const section = saved.data.section as { id: string; blocks: PageBlock[] };
  const id = section.id;
  const shown = String((await site({ action: "add", title: "Shown" })).data.id);
  const later = String((await site({ action: "add", title: "Later" })).data.id);
  const kept = String((await site({ action: "add", title: "Kept" })).data.id);
  const edited = String((await site({ action: "add", title: "Edited" })).data.id);
  const inHour = Math.floor(Date.now() / 1000) + 3_600;
  for (const [page, hidden, showFrom] of [[shown, false, 0], [later, true, inHour], [kept, true, 0], [edited, true, 0]] as const) {
    const result = await site({ action: "save", id: page, page: { blocks: [hero, ...blocksForPage(section)], style: "plain", hidden, showFrom } });
    if (!result.data.ok) throw new Error(`page not saved: ${String(result.data.error)}`);
  }
  const published = await addProduct(OWNER, "Guide", "", "29", null);
  const draft = await addProduct(OWNER, "Draft guide", "", "19", null, null, true);
  if (!published.ok || !draft.ok) throw new Error("no product");
  for (const product of [published.product.id, draft.product.id]) {
    const result = await call(PAGE, "page", { id: product, page: { blocks: blocksForPage(section) } });
    if (!result.data.ok) throw new Error(`product page not saved: ${String(result.data.error)}`);
  }
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const question = async (key: string) => ((await readPage(statsId, key)).blocks.find((b) => b.kind === "faq") as { items: { q: string }[] } | undefined)?.items[0]?.q;
  const countKey = storeMonthKey(statsId, "apply", monthOfUse(store)!);
  const count = async () => (await redis.pipeline([["GET", countKey]]))[0];

  part("The section changed on a hidden page, with a part still to write");
  const changed = await send({ action: "update", id, blocks: [faq(LEFT)], except: siteKey(edited) });
  const why = new Map((changed.data.uses as { key: string; why: string }[]).map((use) => [use.key, use.why]));
  is("the shown, the scheduled and the published product's pages say why they cannot take it", [siteKey(shown), siteKey(later), published.product.id].map((key) => Boolean(why.get(key))), [true, true, true]);
  is("the hidden page and the draft's page can", [why.get(siteKey(kept)), why.get(draft.product.id)], ["", ""]);

  part("Updating the pages that use it");
  for (const [name, pages] of [["a shown page", [siteKey(shown)]], ["a scheduled page", [siteKey(later)]], ["a published product's page", [published.product.id]], ["a shown page among hidden ones", [siteKey(kept), siteKey(shown)]]] as const) {
    const refused = await send({ action: "apply", id, pages });
    is(`${name}: refused, with the part and the pages`, [refused.status, refused.data.error, refused.data.part, refused.data.pages], [409, "placeholder", LEFT, pages.filter((key) => key !== siteKey(kept))]);
  }
  is("nothing was written, and the month's count was not taken", [await question(siteKey(shown)), await question(siteKey(later)), await question(siteKey(kept)), await question(published.product.id), await count()], ["Is it for me?", "Is it for me?", "Is it for me?", "Is it for me?", null]);
  const hiddenOnes = await send({ action: "apply", id, pages: [siteKey(kept), draft.product.id] });
  is("a hidden page and a draft's page take it", [hiddenOnes.status, hiddenOnes.data.done, await question(siteKey(kept)), await question(draft.product.id)], [200, [siteKey(kept), draft.product.id], LEFT, LEFT]);

  part("Once the part is written");
  await send({ action: "update", id, blocks: [faq("Who is it for?")], except: siteKey(edited) });
  const written = await send({ action: "apply", id, pages: [siteKey(shown), published.product.id] });
  is("the shown pages take it", [written.status, await question(siteKey(shown)), await question(published.product.id)], [200, "Who is it for?", "Who is it for?"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
