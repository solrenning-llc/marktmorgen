/**
 * Saved sections (lib/saved-blocks.ts), through the routes the studio uses:
 * saved from a page's blocks without pictures, put on other pages by the
 * page's own save, listed with the pages that use them, and changed on the
 * pages the creator checks, never on one with its own pictures in it.
 */
import { NextRequest } from "next/server";
import { emptyBlock, parsePage, type PageBlock } from "@/lib/sales-page";
import { blocksForPage, readSectionInput, sectionsOn, updateProblem, withSection } from "@/lib/saved-blocks";
import { SITE_KINDS, siteKey } from "@/lib/site-page-rules";
import { SHARE_LIMITS } from "@/lib/funnel-share-rules";
import { readPage } from "@/lib/sales-page-store";
import { sectionUses } from "@/lib/saved-block-store";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET, POST } from "@/app/api/store/saved-blocks/route";
import { POST as SITE_PAGE } from "@/app/api/store/site-page/route";
import { done, is, part } from "./check";

const faq = (q: string): PageBlock => ({ ...(emptyBlock("faq") as Extract<PageBlock, { kind: "faq" }>), items: [{ q, a: "An answer." }] });
const cta = (label: string): PageBlock => ({ ...(emptyBlock("cta") as Extract<PageBlock, { kind: "cta" }>), label });
const picture = { path: `images/${"a".repeat(24)}/${"b".repeat(32)}.webp`, width: 10, height: 10, alt: "", caption: "" };

async function main() {
  part("The rules");
  is("a hero cannot be in a section", (readSectionInput("Top", [emptyBlock("hero")]) as { error?: string }).error, "kind");
  is("nor the reviews", (readSectionInput("Reviews", [emptyBlock("reviews")]) as { error?: string }).error, "kind");
  is("a section needs a name", (readSectionInput(" ", [faq("Q?")]) as { error?: string }).error, "name");
  is("at most eight blocks", (readSectionInput("Many", Array.from({ length: 9 }, () => cta("Go"))) as { error?: string }).error, "too_many");
  const withPicture = readSectionInput("Look", [{ ...(emptyBlock("pictures") as Extract<PageBlock, { kind: "pictures" }>), items: [picture] }]);
  is("pictures stay on their page, and are counted", withPicture.ok ? [withPicture.blocks[0].kind === "pictures" ? withPicture.blocks[0].items.length : -1, withPicture.picturesLeft] : null, [0, 1]);
  const section = { id: "sect000001", blocks: [faq("New?"), cta("Buy")] };
  const page = parsePage({ blocks: [emptyBlock("hero"), ...blocksForPage({ id: "sect000001", blocks: [faq("Old?")] }), cta("Stay")] });
  const updated = withSection(page, section, SITE_KINDS);
  is("an update replaces the run in its place", updated?.blocks.map((b) => [b.kind, b.saved ?? ""]), [["hero", ""], ["faq", "sect000001"], ["cta", "sect000001"], ["cta", ""]]);
  is("the page says which sections it carries", sectionsOn(page), ["sect000001"]);
  const ownPictures = parsePage({ blocks: [{ ...emptyBlock("pictures"), items: [picture], saved: "sect000001" }] });
  is("a page with its own pictures in the section is left alone", updateProblem(ownPictures, "sect000001"), "pictures");
  is("a page whose section was taken off is passed over", updateProblem(parsePage({ blocks: [cta("x")] }), "sect000001"), "gone");

  part("Through the studio");
  const OWNER = "sections@example.com";
  await claimHandle(OWNER, "sectionshop", "Sections", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const site = async (body: Record<string, unknown>) => (await SITE_PAGE(new NextRequest("https://marktmorgen.com/api/store/site-page", { method: "POST", headers, body: JSON.stringify(body) }))).json();
  const send = async (body: Record<string, unknown>) => (await POST(new NextRequest("https://marktmorgen.com/api/store/saved-blocks", { method: "POST", headers, body: JSON.stringify(body) }))).json();
  const list = async (query = "") => (await GET(new NextRequest(`https://marktmorgen.com/api/store/saved-blocks${query}`, { headers }))).json();

  const a = await site({ action: "add", title: "About" });
  const b = await site({ action: "add", title: "Start here" });
  const c = await site({ action: "add", title: "Questions" });
  const saved = await send({ action: "save", name: "Buyer questions", blocks: [faq("Is it for me?"), cta("Get it")] });
  is("saved in the library", [saved.ok, (await list()).sections.map((s: { name: string }) => s.name), (await list()).limit], [true, ["Buyer questions"], SHARE_LIMITS.creator.savedBlocks]);
  const id = saved.section.id as string;
  for (const page of [a, b, c]) {
    const result = await site({ action: "save", id: page.id, page: { blocks: [{ ...emptyBlock("hero"), headline: "Hello" }, ...blocksForPage(saved.section)], style: "plain" } });
    if (!result.ok) throw new Error(`page not saved: ${result.error}`);
  }
  const store = (await storeForEmail(OWNER))!;
  is("each page that carries it is written down", (await sectionUses(store.statsId!, id)).length, 3);

  const changed = await send({ action: "update", id, blocks: [faq("Is it for me? (new)"), cta("Get it now")], except: siteKey(a.id) });
  is("an update lists the other pages using it, before any is changed", [changed.ok, changed.uses.map((u: { title: string; why: string }) => [u.title, u.why]).sort()], [true, [["Questions", ""], ["Start here", ""]]]);
  const untouched = await readPage(store.statsId, siteKey(c.id));
  is("nothing changed on the pages yet", (untouched.blocks[1] as { items: { q: string }[] }).items[0].q, "Is it for me?");
  const applied = await send({ action: "apply", id, pages: [siteKey(b.id)] });
  const bNow = await readPage(store.statsId, siteKey(b.id));
  const cNow = await readPage(store.statsId, siteKey(c.id));
  is("only the checked page changes", [applied.done.length, (bNow.blocks[1] as { items: { q: string }[] }).items[0].q, (bNow.blocks[2] as { label: string }).label, (cNow.blocks[1] as { items: { q: string }[] }).items[0].q], [1, "Is it for me? (new)", "Get it now", "Is it for me?"]);
  is("a page that does not use it cannot be asked for", (await send({ action: "apply", id, pages: ["site-zzzzzzzzzz"] })).error, "pages");

  const taken = await site({ action: "save", id: c.id, page: { blocks: [{ ...emptyBlock("hero"), headline: "Hello" }, cta("Plain")], style: "plain" } });
  is("a page that drops the section is no longer listed", [taken.ok, (await sectionUses(store.statsId!, id)).includes(siteKey(c.id))], [true, false]);

  for (let i = 1; i < SHARE_LIMITS.creator.savedBlocks; i += 1) await send({ action: "save", name: `Section ${i}`, blocks: [cta(`Go ${i}`)] });
  is("the library stops at the plan's number", (await send({ action: "save", name: "One more", blocks: [cta("No")] })).error, "sections_full");
  const removed = await send({ action: "remove", id });
  const kept = await readPage(store.statsId, siteKey(b.id));
  is("removing a section keeps the pages' blocks", [removed.ok, kept.blocks.length, (await sectionUses(store.statsId!, id)).length], [true, 3, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
