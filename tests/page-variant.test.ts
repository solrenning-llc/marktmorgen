/**
 * A test of a second version of the whole sales page (lib/sales-page.ts,
 * variant; lib/headline-test.ts counts it). What is checked: a second version
 * is kept only beside a page, only with blocks of its own and only when it
 * shows something the first does not; its id follows what the two show and
 * not their block ids; a page runs one test at a time; each visitor's version
 * is drawn from the right blocks; the two versions share pictures but hold no
 * more than one page together; what the studio sent is told back when it
 * would be saved differently; the second version is translated and counted
 * by the coach; it is kept and read back through storage.
 */
import { MAX_PAGE_BYTES, MAX_PAGE_PICTURES, asVersion, oversized, pageProblem, parsePage, picturePaths, runningTest } from "@/lib/sales-page";
import { readPage, writePage } from "@/lib/sales-page-store";
import { pageWords } from "@/lib/page-translate";
import { coachChecks } from "@/lib/page-coach";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const FOLDER = "b".repeat(24);
const path = (n: number) => `images/${FOLDER}/${String(n).padStart(32, "0")}.webp`;
const picture = (n: number) => ({ path: path(n), width: 1200, height: 800, alt: `Picture ${n}`, caption: "" });

const hero = (id: string, headline: string) => ({ id, kind: "hero", headline, sub: "For busy parents", media: "none", video: null });
const text = (id: string, body: string) => ({ id, kind: "text", heading: "", body });
const cta = (id: string) => ({ id, kind: "cta", label: "", note: "" });

const A = [hero("hero0001", "Forty dinners"), text("text0001", "Each one in thirty minutes."), cta("cta00001")];
const B = [hero("hero0002", "Dinner, sorted"), cta("cta00002"), text("text0002", "Each one in thirty minutes.")];

async function main(): Promise<void> {
  redis.clear();

  part("Kept beside the page");
  const page = parsePage({ blocks: A, variant: { blocks: B } });
  is("a second version with its own blocks, in its own order", page.variant?.blocks.map((b) => b.id), ["hero0002", "cta00002", "text0002"]);
  is("with an id what the two show gives it", /^p[0-9a-z]{7,8}$/.test(page.variant?.id ?? ""), true);
  is("which is the test the page runs", runningTest(page), page.variant?.id ?? "missing");
  const sameWords = parsePage({ blocks: A, variant: { blocks: B.map((b, i) => ({ ...b, id: `other00${i}` })) } });
  is("new block ids alone are not a new test", sameWords.variant?.id, page.variant?.id);
  const otherWords = parsePage({ blocks: A, variant: { blocks: [hero("hero0002", "Dinner, sorted fast"), ...B.slice(1)] } });
  is("other words are", otherWords.variant?.id !== page.variant?.id, true);
  const changedA = parsePage({ blocks: [hero("hero0001", "Forty dinners, quick"), ...A.slice(1)], variant: { blocks: B } });
  is("and so is a change to the first version", changedA.variant?.id !== page.variant?.id, true);
  is("not when it shows just what the first does", parsePage({ blocks: A, variant: { blocks: A.map((b, i) => ({ ...b, id: `copy000${i}` })) } }).variant, null);
  is("not with no blocks of its own", parsePage({ blocks: A, variant: { blocks: [] } }).variant, null);
  is("not beside a page with none", parsePage({ blocks: [], variant: { blocks: B } }).variant, null);
  is("a page runs one test at a time: no second headline beside it", parsePage({ blocks: A, variant: { blocks: B }, test: { headline: "Another", sub: "" } }).test, null);
  is("a second headline alone is still a test", runningTest(parsePage({ blocks: A, test: { headline: "Another", sub: "" } })) !== null, true);
  is("and a page with neither runs none", runningTest(parsePage({ blocks: A })), null);
  is("the second version keeps the same rules: one hero, at the top", parsePage({ blocks: A, variant: { blocks: [cta("cta00003"), hero("hero0003", "Late")] } }).variant?.blocks.map((b) => b.kind), ["cta"]);

  part("Each visitor's version");
  is("version A draws the page's own blocks", asVersion(page, "a").blocks.map((b) => b.id), ["hero0001", "text0001", "cta00001"]);
  is("version B draws the second version's", asVersion(page, "b").blocks.map((b) => b.id), ["hero0002", "cta00002", "text0002"]);
  is("and everything else about the page is the same for both", [asVersion(page, "b").seoTitle, asVersion(page, "b").style], [page.seoTitle, page.style]);
  const headlinePage = parsePage({ blocks: A, test: { headline: "Dinner in 30 minutes", sub: "No shopping list needed" } });
  const shown = asVersion(headlinePage, "b").blocks[0] as { headline: string; sub: string };
  is("a second headline is drawn in the hero, and nothing else changes", [shown.headline, shown.sub, asVersion(headlinePage, "b").blocks.length], ["Dinner in 30 minutes", "No shopping list needed", 3]);

  part("Pictures, shared and counted together");
  const many = Array.from({ length: MAX_PAGE_PICTURES }, (_, i) => picture(i + 1));
  const full = parsePage({
    blocks: [{ id: "pics0001", kind: "pictures", heading: "", items: many.slice(0, 6) }, ...[1, 2, 3].map((n) => ({ id: `pics000${n + 1}`, kind: "pictures", heading: "", items: many.slice(n * 6, n * 6 + 6) }))],
    variant: { blocks: [{ id: "pics0009", kind: "pictures", heading: "", items: [picture(1), picture(99)] }] },
  });
  is("the first version holds a full page of pictures", picturePaths({ blocks: full.blocks }).length, MAX_PAGE_PICTURES);
  is("the second may show one of them again, but no new one past what a page holds", full.variant?.blocks.flatMap((b) => (b.kind === "pictures" ? b.items.map((p) => p.path) : [])), [path(1)]);
  is("so all the files the page keeps are one page's worth", picturePaths(full).length, MAX_PAGE_PICTURES);
  const shared = parsePage({
    blocks: [{ id: "feat0001", kind: "feature", heading: "Week one", body: "x", picture: picture(1), side: "left" }],
    variant: { blocks: [{ id: "pics0010", kind: "pictures", heading: "", items: [picture(1), picture(2), picture(2)] }] },
  });
  is("each version shows a picture once, and the two keep both files", [shared.variant?.blocks[0]?.kind === "pictures" ? shared.variant.blocks[0].items.length : -1, picturePaths(shared)], [2, [path(1), path(2)]]);

  part("Told back, never saved differently");
  const raw = { blocks: A, variant: { blocks: B } };
  is("a good second version", pageProblem(raw, parsePage(raw)), null);
  const same = { blocks: A, variant: { blocks: A.map((b, i) => ({ ...b, id: `copy000${i}` })) } };
  is("one that shows just what the first does", pageProblem(same, parsePage(same)), "same_version");
  const late = { blocks: A, variant: { blocks: [cta("cta00003"), hero("hero0003", "Late")] } };
  is("one with its hero lower down", pageProblem(late, parsePage(late)), "hero_first");
  const longB = { ...page, variant: { id: "pxxxxxxx", blocks: [{ id: "long0001", kind: "text" as const, heading: "", body: "x".repeat(MAX_PAGE_BYTES) }] } };
  is("each version may weigh as much as a page, and no more", [oversized(page), oversized(longB), oversized({ ...longB, variant: null, blocks: longB.variant.blocks })], [false, true, true]);
  const heavyFirst = { blocks: [hero("hero0005", "Heavy"), ...Array.from({ length: 20 }, (_, i) => text(`hvya${String(i).padStart(4, "0")}`, "y".repeat(4_900)))], variant: { blocks: [hero("hero0006", "Heavy too"), ...Array.from({ length: 20 }, (_, i) => text(`hvyb${String(i).padStart(4, "0")}`, "z".repeat(4_900)))] } };
  const heavy = parsePage(heavyFirst);
  is("two near-full versions together are saved", [JSON.stringify(heavy).length > MAX_PAGE_BYTES, pageProblem(heavyFirst, heavy)], [true, null]);

  part("Kept and read back");
  await writePage("stats9", "prod9", heavy, ROOM);
  is("both versions come back from storage as they were saved", JSON.stringify(await readPage("stats9", "prod9")) === JSON.stringify(heavy), true);

  part("Translated and coached");
  const words = pageWords(page);
  is("every word of the second version is translated with the first", [words.includes("Forty dinners"), words.includes("Dinner, sorted")], [true, true]);
  const test = coachChecks({ page, productTitle: "Forty dinners", free: false, picture: false, pictureAlt: "", facts: {} }).find((c) => c.id === "test");
  is("the coach counts a second version as a test", test?.done, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
