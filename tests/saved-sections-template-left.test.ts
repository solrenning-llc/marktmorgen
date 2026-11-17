/**
 * 754 [STN1], a sibling of #3593: a saved section updated onto the pages
 * that use it (app/api/store/saved-blocks/route.ts, "apply") never takes a
 * part a template left to write, ⟦like this⟧ or a campaign's [bracket]
 * part, onto a page visitors see: a store's own page that is shown or
 * scheduled, or the page of a product on the store. As "apply" does
 * for every rule a page's own save applies (saveProblem,
 * tests/saved-section-apply-checks.test.ts), such a page is passed over with
 * the part in its reason and left exactly as it was; hidden pages and
 * drafts' pages in the same request still take it. The list of pages an
 * update offers says why such a page cannot be updated, so it is not checked
 * to begin with.
 *
 * What fails here: a shown page, a scheduled page or a published product's
 * page updated with a section holding a part; a passed-over page said
 * without the part; a hidden page or a draft's page refused; the list
 * offering a shown page with nothing said.
 */
import { NextRequest } from "next/server";
import { emptyBlock, type PageBlock } from "@/lib/sales-page";
import { blocksForPage } from "@/lib/saved-blocks";
import { siteKey } from "@/lib/site-page-rules";
import { readPage } from "@/lib/sales-page-store";
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

  part("The section changed on a hidden page, with a part still to write");
  const changed = await send({ action: "update", id, blocks: [faq(LEFT)], except: siteKey(edited) });
  const why = new Map((changed.data.uses as { key: string; why: string }[]).map((use) => [use.key, use.why]));
  is("the shown, the scheduled and the published product's pages say why they cannot take it", [siteKey(shown), siteKey(later), published.product.id].map((key) => Boolean(why.get(key))), [true, true, true]);
  is("the hidden page and the draft's page can", [why.get(siteKey(kept)), why.get(draft.product.id)], ["", ""]);

  part("Updating the pages that use it");
  for (const [name, pages] of [["a shown page", [siteKey(shown)]], ["a scheduled page", [siteKey(later)]], ["a published product's page", [published.product.id]]] as const) {
    const applied = await send({ action: "apply", id, pages });
    const skipped = (applied.data.skipped ?? []) as { key: string; why: string }[];
    is(`${name}: passed over, with the part in its reason`, [applied.status, applied.data.done, skipped.map((s) => s.key), skipped.every((s) => s.why.includes(LEFT))], [200, [], pages, true]);
  }
  is("none of them was written", [await question(siteKey(shown)), await question(siteKey(later)), await question(published.product.id)], ["Is it for me?", "Is it for me?", "Is it for me?"]);
  const mixed = await send({ action: "apply", id, pages: [siteKey(kept), siteKey(shown), draft.product.id] });
  const passed = ((mixed.data.skipped ?? []) as { key: string; why: string }[]).map((s) => s.key);
  is("among hidden ones: the hidden page and the draft's page take it, the shown one is passed over", [mixed.status, mixed.data.done, passed, await question(siteKey(kept)), await question(draft.product.id), await question(siteKey(shown))], [200, [siteKey(kept), draft.product.id], [siteKey(shown)], LEFT, LEFT, "Is it for me?"]);

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
