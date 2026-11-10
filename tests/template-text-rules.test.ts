/**
 * 754 [STN1], unit 1: words a template left for the creator to write are never
 * shown to visitors. A part marked ⟦like this⟧ (lib/funnel-ai-rules.ts) and
 * a part in [brackets] from one of the campaigns (lib/funnel-starters.ts),
 * matched exactly, so the creator's own brackets are never taken for one,
 * stop a page from going out: a store's own page while it is shown or
 * scheduled, a product's page while the product is on the store, either
 * version. A hidden page and a draft's page keep them. The refusal says the
 * block and the part, so the editor can open that block.
 *
 * What fails here: a published product's page saved with a part to write in
 * either version; a shown store page saved with a campaign's [bracket]; a
 * refusal that does not say where; a hidden page or a draft's page refused;
 * the creator's own brackets refused.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId } from "@/lib/store";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { POST as savePage } from "@/app/api/store/page/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "template.words@example.com";
const ORIGIN = "https://marktmorgen.com";

/** A campaign's own part in [brackets], exactly as a page made from it holds it. */
const physical = FUNNEL_STARTERS.find((starter) => starter.id === "physical-product");
const STARTER_PART = "[Give its measurements and weight, what it is made of and how to look after it. Say anything it needs that is not in the box.]";

async function main(): Promise<void> {
  redis.clear();
  is("the campaign still holds the part this test uses", JSON.stringify(physical?.bundle.pages ?? []).includes(STARTER_PART), true);
  await claimHandle(OWNER, "templatewords", "Template Words", "");
  await ensureStatsId(OWNER);
  const shown = await addProduct(OWNER, "Guide", "", "29", null);
  const draft = await addProduct(OWNER, "Draft guide", "", "19", null, null, true);
  if (!shown.ok || !draft.ok) throw new Error("no product");
  const session = await openSession(OWNER);
  const post = async (route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) => {
    const response = await route(
      new NextRequest(`${ORIGIN}/api/store/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const why = { id: "text0001", kind: "text", heading: "Why", body: "Because it works for me." };
  const marked = { id: "text0002", kind: "text", heading: "About me", body: "I teach bread. ⟦Add one sentence about who you are⟧" };
  const bracketed = { id: "text0003", kind: "text", heading: "Size and materials", body: STARTER_PART };
  const own = { id: "text0004", kind: "text", heading: "Notes", body: "Sizes run small [see the chart] and ship in 2 days [US only]." };

  part("A product's page, while the product is on the store");
  const refused = await post(savePage, "page", { id: shown.product.id, page: { blocks: [why, marked] } });
  is("a part ⟦like this⟧ is refused, with the block and the part", [refused.status, refused.data.error, refused.data.block, refused.data.kind, refused.data.part], [400, "placeholder", "text0002", "text", "⟦Add one sentence about who you are⟧"]);
  const second = await post(savePage, "page", { id: shown.product.id, page: { blocks: [why], variant: { id: "", blocks: [{ ...why, heading: "Why not" }, bracketed] } } });
  is("a campaign's part in the second version is refused too", [second.status, second.data.error, second.data.block, second.data.part], [400, "placeholder", "text0003", STARTER_PART]);
  const ownWords = await post(savePage, "page", { id: shown.product.id, page: { blocks: [why, own] } });
  is("the creator's own brackets are words, and save", [ownWords.status, ownWords.data.ok], [200, true]);
  const kept = await post(savePage, "page", { id: draft.product.id, page: { blocks: [why, marked, bracketed] } });
  is("a draft's page keeps its parts to write", [kept.status, kept.data.ok], [200, true]);

  part("A store's own page, while it is shown or scheduled");
  const added = await post(sitePage, "site-page", { action: "add", title: "Your product", slug: "your-product" });
  const id = String(added.data.id);
  const open = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [why, bracketed], hidden: false } });
  is("a campaign's part in [brackets] is refused, with the block and the part", [open.status, open.data.error, open.data.block, open.data.kind, open.data.part], [400, "placeholder", "text0003", "text", STARTER_PART]);
  const later = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [bracketed], hidden: true, showFrom: Math.floor(Date.now() / 1000) + 3_600 } });
  is("nor scheduled to show by itself", [later.status, later.data.error], [400, "placeholder"]);
  const markedOut = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [marked], hidden: false } });
  is("a part ⟦like this⟧ still is, now saying where", [markedOut.data.error, markedOut.data.block], ["placeholder", "text0002"]);
  const hidden = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [why, bracketed, marked], hidden: true } });
  is("kept hidden, it saves", hidden.data.ok, true);
  const written = await post(sitePage, "site-page", { action: "save", id, page: { blocks: [why, own], hidden: false } });
  is("once written in the creator's own words, it can be shown", written.data.ok, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
