/**
 * 568 [GD2] (c), site page titles: a store's own page may not carry a title that poses as Marktmorgen itself.
 *
 * A store page's title is the link in the store's menu and the name the page is shown under, so "Marktmorgen
 * Support" or "Verify your Marktmorgen account" there is a fake sign-in's front door. With the real route on the
 * in-memory database and a real session (app/api/store/site-page):
 *
 *   - "meta" on a page that is shown, or scheduled to come out, is refused with "brand_imitation", the passage,
 *     why (said of a page, not a product) and the fix, and the title is left as it was;
 *   - a page held back may keep such a title, as a draft product keeps its words; saving its blocks so it comes
 *     out is then refused for the title, and nothing is written;
 *   - plain titles, and saying the store runs on Marktmorgen, pass;
 *   - the pages list and the page editor say it with the passage, why and fix, naming the page's title.
 *
 * Synthetic store and data only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { readPage } from "@/lib/sales-page-store";
import { emptyBlock, type PageBlock } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { IMITATION_FIX, IMITATION_WHY, imitationMessage, imitationWhy } from "@/lib/brand-imitation-rules";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "posing.title@example.com";
type Json = Record<string, unknown> & { ok?: boolean; error?: string; id?: string; passage?: { field?: string; excerpt?: string; why?: string; fix?: string } };

const text = (body: string): PageBlock => ({ ...(emptyBlock("text") as Extract<PageBlock, { kind: "text" }>), heading: "About", body });
const hero = (): PageBlock => ({ ...emptyBlock("hero"), headline: "Hello" }) as PageBlock;
const PAGE_WHY = imitationWhy("the page cannot be shown with it");

async function main(): Promise<void> {
  part("The reason and the sentence");
  is("the reason is said of a page, the rest kept", [PAGE_WHY.endsWith("so the page cannot be shown with it."), PAGE_WHY.startsWith(IMITATION_WHY.slice(0, 120)), PAGE_WHY === IMITATION_WHY], [true, true, false]);
  const said = imitationMessage({ excerpt: "Marktmorgen Support.", why: PAGE_WHY, fix: IMITATION_FIX }, "the page's title", "Your changes were not saved");
  is("the studio's sentence: what did not happen, where, the passage, why, the fix, nothing changed", said, `Your changes were not saved. In the page's title: “Marktmorgen Support”. ${PAGE_WHY} ${IMITATION_FIX} Nothing you wrote was changed.`);
  is("without a passage it still says why and the fix", imitationMessage(null, "the page's title", "Your changes were not saved"), `Your changes were not saved. In the page's title. ${IMITATION_WHY} ${IMITATION_FIX} Nothing you wrote was changed.`);

  redis.clear();
  await claimHandle(OWNER, "posingtitle", "Posing Title", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` };
  const site = async (body: unknown): Promise<Json & { status: number }> => {
    const response = await sitePage(new NextRequest(`${ORIGIN}/api/store/site-page`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, ...((await response.json().catch(() => ({}))) as Json) };
  };
  const pageOf = async (id: string) => (await storeForEmail(OWNER))!.sitePages.find((page) => page.id === id);
  const statsId = (await storeForEmail(OWNER))!.statsId!;

  part("A shown page's title");
  const shown = await site({ action: "add", title: "About" });
  const shownId = String(shown.id);
  const put = await site({ action: "save", id: shownId, page: { blocks: [hero(), text("Hello.")], style: "plain", hidden: false } });
  is("the page is out with a plain title", [put.status, (await pageOf(shownId))?.from], [200, 0]);
  const slug = (await pageOf(shownId))!.slug;
  const metaShown = (title: string) => site({ action: "meta", id: shownId, title, slug, nav: true, target: "" });
  const posing = await metaShown("Marktmorgen Support");
  is("a title posing as Marktmorgen's staff is refused, with the passage, why for a page and the fix", [posing.status, posing.error, posing.passage?.field, posing.passage?.excerpt?.includes("Marktmorgen Support"), posing.passage?.why, posing.passage?.fix], [409, "brand_imitation", "title", true, PAGE_WHY, IMITATION_FIX]);
  is("and the title is left as it was", (await pageOf(shownId))?.title, "About");
  const trouble = await metaShown("Verify your account with Marktmorgen");
  is("so is its account in trouble", [trouble.status, trouble.error], [409, "brand_imitation"]);
  const lookalike = await metaShown("Sign in at marktmorgen-login.com");
  is("so is a look-alike address", [lookalike.status, lookalike.error], [409, "brand_imitation"]);
  const plain = await metaShown("Our story");
  is("a plain title is saved", [plain.status, (await pageOf(shownId))?.title], [200, "Our story"]);
  const runsOn = await metaShown("Sold on Marktmorgen");
  is("saying the store runs on Marktmorgen is saved", [runsOn.status, (await pageOf(shownId))?.title], [200, "Sold on Marktmorgen"]);

  part("A scheduled page counts as shown");
  const later = await site({ action: "add", title: "Launch" });
  const laterId = String(later.id);
  const soon = Math.floor(Date.now() / 1000) + 86_400;
  const scheduled = await site({ action: "save", id: laterId, page: { blocks: [hero(), text("Soon.")], style: "plain", hidden: true, showFrom: soon } });
  is("the page is scheduled", [scheduled.status, (await pageOf(laterId))?.from], [200, soon]);
  const laterSlug = (await pageOf(laterId))!.slug;
  const scheduledPosing = await site({ action: "meta", id: laterId, title: "The Marktmorgen Team", slug: laterSlug, nav: true, target: "" });
  is("a posing title on it is refused", [scheduledPosing.status, scheduledPosing.error, (await pageOf(laterId))?.title], [409, "brand_imitation", "Launch"]);

  part("A page held back may keep it until it comes out");
  const draft = await site({ action: "add", title: "Draft" });
  const draftId = String(draft.id);
  const draftSlug = (await pageOf(draftId))!.slug;
  const kept = await site({ action: "meta", id: draftId, title: "Marktmorgen Support", slug: draftSlug, nav: true, target: "" });
  is("a page with no blocks out keeps the title", [kept.status, (await pageOf(draftId))?.title, (await pageOf(draftId))?.from], [200, "Marktmorgen Support", -1]);
  const heldBack = await site({ action: "save", id: draftId, page: { blocks: [hero(), text("Hello.")], style: "plain", hidden: true } });
  is("its blocks are saved while it is held back", [heldBack.status, (await pageOf(draftId))?.from], [200, -1]);
  const before = await readPage(statsId, siteKey(draftId));
  const out = await site({ action: "save", id: draftId, page: { blocks: [hero(), text("Now out.")], style: "plain", hidden: false } });
  is("putting it out is refused for its title", [out.status, out.error, out.passage?.field, out.passage?.why], [409, "brand_imitation", "title", PAGE_WHY]);
  is("and nothing is written", [await readPage(statsId, siteKey(draftId)), (await pageOf(draftId))?.from], [before, -1]);
  const scheduling = await site({ action: "save", id: draftId, page: { blocks: [hero(), text("Later.")], style: "plain", hidden: true, showFrom: soon } });
  is("scheduling it is refused too", [scheduling.status, scheduling.error], [409, "brand_imitation"]);
  await site({ action: "meta", id: draftId, title: "Draft", slug: draftSlug, nav: true, target: "" });
  const outPlain = await site({ action: "save", id: draftId, page: { blocks: [hero(), text("Now out.")], style: "plain", hidden: false } });
  is("with a plain title it comes out", [outPlain.status, (await pageOf(draftId))?.from], [200, 0]);

  part("Both editors say it");
  is("the pages list", /a\.error === "brand_imitation"\) return setError\(imitationMessage\(a\.passage, "the page's title"/.test(readFileSync("components/site-pages-editor.tsx", "utf8")), true);
  is("the page editor, on a store's own page", /data\.error === "brand_imitation" && site && \(data as \{ passage\?: \{ field\?: unknown \} \}\)\.passage\?\.field === "title" \? imitationMessage\(\(data as \{ passage\?: unknown \}\)\.passage, "the page's title"/.test(readFileSync("components/page-editor.tsx", "utf8")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
