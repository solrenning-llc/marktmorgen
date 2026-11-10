/**
 * "Make a copy" of a store's own page (582 [KB3], unit 2; added 10 November
 * 2026), through the real route with the creator's own session: a new page
 * after the others, "Copy of …" at "<address>-copy", kept back from visitors
 * and out of the menu, with the original's blocks and words in order (fresh
 * block ids) and none of its pictures, which stay the original's; the
 * original untouched; refused when the store has its most pages, when the
 * original cannot be read, and never made from an empty guess.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, imageFolder, setSitePages, storeForEmail } from "@/lib/store";
import { claimPictures, readPageExact, writePage } from "@/lib/sales-page-store";
import { emptyBlock, parsePage, type PageBlock } from "@/lib/sales-page";
import { MAX_SITE_PAGES, MAX_SITE_TITLE, MAX_SLUG, type SitePage, siteKey, slugProblem } from "@/lib/site-page-rules";
import { pageCopySlug, pageCopyTitle } from "@/lib/site-page-copy";
import { COPY_HELP, copyDoneWords } from "@/components/site-pages-editor";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "page-copy@example.com";
const ORIGIN = "https://marktmorgen.com";
const SITE = "aaaaaaaaaa";

async function main(): Promise<void> {
  part("The copy's title and address");
  const page = (id: string, slug: string): SitePage => ({ id, slug, title: slug, nav: true, target: "", from: 0 });
  is("Copy of the title, never Copy of Copy of", [pageCopyTitle("About me"), pageCopyTitle("Copy of About me"), pageCopyTitle("  ")], ["Copy of About me", "Copy of About me", "Copy of page"]);
  is("never longer than a title may be", pageCopyTitle("T".repeat(MAX_SITE_TITLE)).length, MAX_SITE_TITLE);
  is("<address>-copy, then -copy-2 when that is taken, from the original's own address", [pageCopySlug("about", [page("a", "about")]), pageCopySlug("about", [page("a", "about"), page("b", "about-copy")]), pageCopySlug("about-copy", [page("a", "about"), page("b", "about-copy")])], ["about-copy", "about-copy-2", "about-copy-2"]);
  const long = "a".repeat(MAX_SLUG);
  const slug = pageCopySlug(long, [page("a", long)]);
  is("never longer than an address may be, and one the rules take", [slug?.length ?? 99, slug?.endsWith("-copy"), slug ? slugProblem(slug, [page("a", long)]) : "none"], [MAX_SLUG, true, null]);

  part("Through the route");
  redis.clear();
  await claimHandle(OWNER, "pagecopy", "Page copy", "");
  await ensureStatsId(OWNER);
  const shop = await storeForEmail(OWNER);
  const statsId = shop?.statsId;
  if (!shop || !statsId) throw new Error("setup");
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const post = (body: unknown) => sitePage(new NextRequest(`${ORIGIN}/api/store/site-page`, { method: "POST", headers, body: JSON.stringify(body) }));
  const folder = await imageFolder(OWNER);
  const picture = (n: number) => ({ path: `images/${folder}/${n.toString(16).padStart(32, "0")}.jpg`, width: 1200, height: 800, alt: "A kitchen", caption: "" });
  const hero = { ...(emptyBlock("hero") as Extract<PageBlock, { kind: "hero" }>), headline: "Cook at home", media: "none" as const };
  const text = { ...(emptyBlock("text") as Extract<PageBlock, { kind: "text" }>), heading: "Why", body: "Because it is good." };
  const pictures = { ...(emptyBlock("pictures") as Extract<PageBlock, { kind: "pictures" }>), heading: "The kitchen", items: [picture(1), picture(2)] };
  const feature = { ...(emptyBlock("feature") as Extract<PageBlock, { kind: "feature" }>), heading: "A tip", body: "Salt early.", picture: picture(3) };
  const original = parsePage({ blocks: [hero, text, pictures, feature], seoTitle: "Cook at home with Pia", style: "plain" });
  if (!(await setSitePages(OWNER, [{ id: SITE, slug: "cook", title: "Cook at home", nav: true, target: "", from: 0 }])).ok) throw new Error("setup");
  await writePage(statsId, siteKey(SITE), original, shop);
  await claimPictures(statsId, siteKey(SITE), [1, 2, 3].map((n) => picture(n).path));
  const owners = async () => redis.pipeline([["HGETALL", `nl:product:pics:${statsId}`]]);
  const ownersBefore = JSON.stringify(await owners());
  const before = JSON.stringify((await readPageExact(statsId, siteKey(SITE))).page);

  const response = await post({ action: "copy", id: SITE });
  const answer = (await response.json()) as { ok?: boolean; id?: string; pictures?: number; pages?: SitePage[] };
  is("made", [response.status, answer.ok, typeof answer.id, answer.pictures], [200, true, "string", 3]);
  const entry = answer.pages?.find((p) => p.id === answer.id);
  is("a new page after the others, named and addressed as a copy, out of the menu and not out for visitors", entry && [answer.pages?.[0].id, answer.pages?.length, entry.title, entry.slug, entry.nav, entry.from], [SITE, 2, "Copy of Cook at home", "cook-copy", false, -1]);
  const copy = (await readPageExact(statsId, siteKey(answer.id ?? ""))).page;
  is("kept back from visitors", copy && [copy.hidden, copy.showFrom], [true, 0]);
  is("the same blocks and words, in order", copy?.blocks.map((b) => [b.kind, "heading" in b ? b.heading : "", "body" in b ? b.body : "", "headline" in b ? b.headline : ""]), original.blocks.map((b) => [b.kind, "heading" in b ? b.heading : "", "body" in b ? b.body : "", "headline" in b ? b.headline : ""]));
  is("with fresh block ids", copy?.blocks.some((b, i) => b.id === original.blocks[i].id), false);
  const shown = (copy?.blocks ?? []).flatMap((b) => (b.kind === "pictures" ? b.items : b.kind === "feature" && b.picture ? [b.picture] : []));
  is("none of the pictures: the pictures block stays, empty, and the picture beside words goes", [shown.length, copy?.blocks[2].kind === "pictures" && copy.blocks[2].items.length, copy?.blocks[3].kind === "feature" && copy.blocks[3].picture], [0, 0, null]);
  is("not the original's search title", copy?.seoTitle, "");
  is("the original and who owns each picture are untouched", [JSON.stringify((await readPageExact(statsId, siteKey(SITE))).page) === before, JSON.stringify(await owners()) === ownersBefore], [true, true]);
  const again = (await (await post({ action: "copy", id: SITE })).json()) as { pages?: SitePage[]; id?: string };
  is("a second copy takes the next address", again.pages?.find((p) => p.id === again.id)?.slug, "cook-copy-2");

  part("Refused");
  is("a page that is not there", [(await post({ action: "copy", id: "zzzzzzzzzz" })).status], [404]);
  const pipeline = redis.pipeline;
  redis.pipeline = async (commands) => {
    const reply = await pipeline.call(redis, commands);
    return commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith(`nl:product:page:${statsId}:`) ? ["{"] : reply;
  };
  const listBefore = (await storeForEmail(OWNER))!.sitePages.length;
  let unread: [number, string];
  try {
    const r = await post({ action: "copy", id: SITE });
    unread = [r.status, ((await r.json()) as { error?: string }).error ?? ""];
  } finally {
    redis.pipeline = pipeline;
  }
  is("an original nobody could read is never copied as an empty page, and nothing is added", [unread, (await storeForEmail(OWNER))!.sitePages.length], [[503, "page_unread"], listBefore]);
  // A store with no room left for the copy's blocks: refused with nothing added, never an empty page left behind.
  const listBeforeFull = JSON.stringify((await storeForEmail(OWNER))!.sitePages);
  redis.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes("marktmorgen:store-data:v1") ? [[0, 999_999_999]] : pipeline.call(redis, commands));
  let fullRoom: [number, string];
  try {
    const r = await post({ action: "copy", id: SITE });
    fullRoom = [r.status, ((await r.json()) as { error?: string }).error ?? ""];
  } finally {
    redis.pipeline = pipeline;
  }
  is("no room for the blocks: refused before the page is listed, and the list is exactly as it was", [fullRoom, JSON.stringify((await storeForEmail(OWNER))!.sitePages) === listBeforeFull], [[409, "copy_full"], true]);
  // The list refusing after the blocks were written (an address taken since): the blocks are taken back.
  const keysBefore = [...redis.keys()].filter((k) => k.startsWith(`nl:product:page:${statsId}:site-`)).length;
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:store:")) ? Promise.reject(new Error("synthetic: the list write fails")) : pipeline.call(redis, commands));
  let listRefused = 0;
  try {
    listRefused = (await post({ action: "copy", id: SITE })).status;
  } catch {
    listRefused = -1;
  } finally {
    redis.pipeline = pipeline;
  }
  is("the list write failing leaves no page and no blocks behind", [listRefused !== 200, JSON.stringify((await storeForEmail(OWNER))!.sitePages) === listBeforeFull, [...redis.keys()].filter((k) => k.startsWith(`nl:product:page:${statsId}:site-`)).length], [true, true, keysBefore]);
  const now = (await storeForEmail(OWNER))!.sitePages;
  await setSitePages(OWNER, [...now, ...Array.from({ length: MAX_SITE_PAGES - now.length }, (_, n) => ({ id: `f${String(n).padStart(9, "0")}`, slug: `filler-${n}`, title: `Filler ${n}`, nav: false, target: "", from: -1 }))]);
  const full = await post({ action: "copy", id: SITE });
  is("a store with its most pages makes none", [full.status, ((await full.json()) as { error?: string }).error, (await storeForEmail(OWNER))!.sitePages.length], [400, "too_many", MAX_SITE_PAGES]);

  part("In the studio");
  const editor = readFileSync("components/site-pages-editor.tsx", "utf8").replace(/\s+/g, " ");
  is("said before it is pressed: what comes across, what is kept back, and that the pictures stay", COPY_HELP, "Make a copy: the same blocks and words, as last saved, on a new page, hidden from visitors and out of the menu until you show it. Pictures stay with this page, so add them again in the copy.");
  is("the help is tied to the button; offered only while there is room, and not over unsaved settings", [editor.includes('aria-describedby="site-page-copy-help" onClick={() => void copy()}> Make a copy </button>'), editor.includes("{pages.length < MAX_SITE_PAGES ? ( <button"), editor.includes("disabled={busy || dirty}"), editor.includes('"Save these settings first to make a copy."')], [true, true, true, true]);
  is("and after, how many pictures stayed with the original", [copyDoneWords(0), copyDoneWords(1), copyDoneWords(3)], ["Copy made and opened, hidden from visitors.", "Copy made and opened, hidden from visitors. Its picture stayed with the original: add it again here.", "Copy made and opened, hidden from visitors. Its 3 pictures stayed with the original: add them again here."]);
  is("the copy is opened once made", editor.includes("router.push(`/studio/site?${sid ? `store=${sid}&` : \"\"}page=${a.id}`);"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
