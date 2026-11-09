/**
 * Pictures, a countdown and templates on a sales page (lib/sales-page.ts,
 * added 7 October 2026).
 *
 * Measured that day: Kajabi and Hotmart Pages have image sections, a
 * countdown and a gallery of templates; theirs can count down "evergreen",
 * starting again for every visitor. What is checked:
 *
 *   - a picture is only a file in a picture folder, with its size; each is
 *     shown once, a block holds six and a page twenty-four, and a page sent
 *     with one that was not kept is refused, said as such;
 *   - a countdown is one moment, the same for everybody: it needs one, not
 *     more than a year away; a moment that has passed is kept but not live;
 *   - a template is an order of blocks under the product's own title, and
 *     writes no sentence about the product;
 *   - a picture belongs to the one page that first showed it: another page
 *     cannot take it, and only its own page's leaving it deletes the file.
 */
import {
  MAX_PAGE_PICTURES,
  MAX_PICTURES,
  PAGE_TEMPLATES,
  blocksFromTemplate,
  countdownLive,
  pageProblem,
  parsePage,
  picturePaths,
} from "@/lib/sales-page";
import { PageDropIncomplete, claimPictures, dropPage, picturesOfFailedDrop, releasePictures, writePage } from "@/lib/sales-page-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const FOLDER = "a".repeat(24);
const path = (n: number) => `images/${FOLDER}/${String(n).padStart(32, "0")}.webp`;
const picture = (n: number, more: Record<string, unknown> = {}) => ({ path: path(n), width: 1200, height: 800, alt: "A page of the book", caption: "Week one", ...more });

async function main(): Promise<void> {
  redis.clear();

  part("Pictures");
  const sent = {
    blocks: [
      { id: "hero0001", kind: "hero", headline: "Bread", sub: "", media: "none", video: null },
      { id: "pics0001", kind: "pictures", heading: "A look inside", items: [picture(1), picture(2, { caption: "  Week   two " })] },
    ],
  };
  const page = parsePage(sent);
  is("kept in their order, with what was said of each", page.blocks[1].kind === "pictures" ? page.blocks[1].items.map((p) => [p.path, p.caption]) : [], [[path(1), "Week one"], [path(2), "Week two"]]);
  is("fine as sent", pageProblem(sent, page), null);
  is("every file the page shows", picturePaths(page), [path(1), path(2)]);

  const notOne = { blocks: [{ id: "pics0002", kind: "pictures", heading: "", items: [picture(3, { path: "https://example.com/x.png" }), picture(4, { path: `images/${FOLDER}/../secret.webp` }), picture(5, { width: 0 })] }] };
  is("an address from anywhere else is not a picture", picturePaths(parsePage(notOne)), []);
  is("and the page is refused, said as such", pageProblem(notOne, parsePage(notOne)), "pictures");

  const twice = { blocks: [{ id: "pics0003", kind: "pictures", heading: "", items: [picture(1), picture(1)] }, { id: "pics0004", kind: "pictures", heading: "", items: [picture(1), picture(2)] }] };
  is("one file is shown once on a page", picturePaths(parsePage(twice)), [path(1), path(2)]);
  is("so a second copy is refused", pageProblem(twice, parsePage(twice)), "pictures");

  const many = { blocks: [{ id: "pics0005", kind: "pictures", heading: "", items: Array.from({ length: 9 }, (_, i) => picture(i + 10)) }] };
  is("a block holds six", picturePaths(parsePage(many)).length, MAX_PICTURES);
  const full = { blocks: Array.from({ length: 5 }, (_, b) => ({ id: `pics10${b}0`, kind: "pictures", heading: "", items: Array.from({ length: 6 }, (_, i) => picture(100 + b * 6 + i)) })) };
  is("and a page twenty-four", picturePaths(parsePage(full)).length, MAX_PAGE_PICTURES);

  part("A countdown");
  const now = Math.floor(Date.now() / 1000);
  const timed = (until: unknown) => ({ blocks: [{ id: "cnt00001", kind: "countdown", heading: "The launch price ends in", until, note: "After that it is $49." }] });
  const soon = parsePage(timed(now + 86_400));
  is("kept as one moment", soon.blocks[0].kind === "countdown" ? [soon.blocks[0].until, soon.blocks[0].note] : [], [now + 86_400, "After that it is $49."]);
  is("fine as sent", pageProblem(timed(now + 86_400), soon), null);
  is("live until that moment, and not after", soon.blocks[0].kind === "countdown" ? [countdownLive(soon.blocks[0], now), countdownLive(soon.blocks[0], now + 86_400)] : [], [true, false]);
  is("it needs a moment", [pageProblem(timed(0), parsePage(timed(0))), pageProblem(timed("tomorrow"), parsePage(timed("tomorrow")))], ["countdown", "countdown"]);
  is("no more than a year away", pageProblem(timed(now + 400 * 86_400), parsePage(timed(now + 400 * 86_400))), "countdown");
  is("one that has passed can stay on a saved page; it is simply not live", [pageProblem(timed(now - 60), parsePage(timed(now - 60))), countdownLive({ until: now - 60 }, now)], [null, false]);

  part("Templates");
  is("one for something free, the rest for something paid", [PAGE_TEMPLATES.filter((t) => t.free).map((t) => t.id), PAGE_TEMPLATES.filter((t) => !t.free).length], [["free"], 5]);
  for (const template of PAGE_TEMPLATES) {
    const blocks = blocksFromTemplate(template.id, { title: "Sourdough Course", summary: "Bake your first loaf this weekend.", picture: true });
    const hero = blocks[0];
    const words = blocks.slice(1).flatMap((b) => ("body" in b ? [b.body] : "items" in b ? b.items.flatMap((item) => (typeof item === "string" ? [item] : "a" in item ? [item.a] : "detail" in item ? [item.detail] : [])) : []));
    is(
      `${template.id}: the product's own words on top, an order of blocks, and no sentence written for it`,
      [hero.kind === "hero" ? [hero.headline, hero.sub, hero.media] : null, blocks.length > 2, new Set(blocks.map((b) => b.id)).size === blocks.length, words.filter(Boolean)],
      [["Sourdough Course", "Bake your first loaf this weekend.", "picture"], true, true, []],
    );
  }
  is("a name that is not a template gives nothing", blocksFromTemplate("nope", { title: "x", summary: "", picture: false }), []);
  const launch = blocksFromTemplate("launch", { title: "x", summary: "", picture: false });
  is("a launch page asks for its moment before it can be saved", pageProblem({ blocks: launch }, parsePage({ blocks: launch })), "countdown");

  part("Whose picture it is");
  is("a page takes its new pictures", await claimPictures("stats1", "prod_a", [path(1), path(2)]), []);
  is("again is still fine", await claimPictures("stats1", "prod_a", [path(1)]), []);
  is("another product's page cannot take one of them", await claimPictures("stats1", "prod_b", [path(2), path(3)]), [path(2)]);
  is("letting go deletes only what that page was showing", await releasePictures("stats1", "prod_b", [path(2), path(3)]), [path(3)]);
  is("and the first page's picture is still its own", await releasePictures("stats1", "prod_a", [path(2)]), [path(2)]);
  await writePage("stats1", "prod_a", page, ROOM);
  is("a product removed takes its page's pictures with it", await dropPage("stats1", "prod_a", ROOM), [path(1)]);

  part("A page dropped while its test's counts cannot be counted");
  // The test's counts stay until they expire and are counted on their own: when not even the ask to count them
  // again can be written (lib/store-data.ts, DataCountUnconfirmed), the page's pictures are still let go and given
  // to the route to delete, never left kept and counted for good (Claude 5's pre-review, 09/11/2026).
  const tested = parsePage({ blocks: [{ id: "hero0002", kind: "hero", headline: "Rye", sub: "", media: "none", video: null }, { id: "pics0005", kind: "pictures", heading: "", items: [picture(6)] }], test: { headline: "Rye in a day", sub: "" } });
  is("a page with a test and a picture of its own", [tested.test !== null, await claimPictures("stats1", "prod_c", [path(6)])], [true, []]);
  await writePage("stats1", "prod_c", tested, ROOM);
  const real = redis.pipeline;
  redis.pipeline = async (commands) => {
    if (commands.some((c) => (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:")) || c[0] === "HINCRBY")) throw new Error("fetch failed");
    return real(commands);
  };
  let dropped: unknown = null;
  try {
    await dropPage("stats1", "prod_c", ROOM);
  } catch (error) {
    dropped = error;
  }
  redis.pipeline = real;
  is("the drop says it is incomplete, with the pictures it let go for the route to delete", [dropped instanceof PageDropIncomplete, picturesOfFailedDrop(dropped)], [true, [path(6)]]);
  is("and the page itself is gone, its picture no longer its own", [redis.run(["GET", "nl:product:page:stats1:prod_c"]), redis.run(["HGET", "nl:product:pics:stats1", path(6)])], [null, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
