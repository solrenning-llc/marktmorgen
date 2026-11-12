/**
 * Two blocks that only arrange the page (queue item 375 [TB1], fifth
 * complement, 29 October 2026): a divider, one line across the page, and a
 * space, empty room in one of three sizes. Neither holds a word of the
 * creator's, a file or an address, and neither costs anything to show.
 *
 * What is checked, against the real code:
 *
 *   - each is kept by the page's own parser with nothing but its id, its kind
 *     and, for a space, its size: a size it does not know becomes "medium",
 *     and any other field sent with it (words, markup, a style, a script, an
 *     address) is dropped;
 *   - they count toward the page's thirty blocks like any other, and a
 *     thirty-first is told back;
 *   - each is in the block list with plain words, in the side menu's
 *     "Arrange the page" group, and every block kind offered is in exactly
 *     one group, found by the search;
 *   - drawn, a divider is an <hr> and a space is empty room hidden from
 *     screen readers that never takes the focus; neither draws a word, and
 *     neither moves the bands of a page set in bands;
 *   - the translation sends nothing of theirs to the model and leaves the
 *     size as it was; copied to another store, they come across as they are,
 *     with nothing left out; the page coach reads a page with them exactly as
 *     the same page without them;
 *   - the editor offers only the space's size, from the sizes the parser
 *     keeps, and both have an icon.
 *
 * Not checked here (needs a browser): how the line and the room look at each
 * width, in forced colors and in dark stores.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BlockContext, BlockView, PageSections } from "@/components/sales-blocks";
import { BLOCK_GROUPS, blockGroupsFor } from "@/components/block-picker";
import { offeredKinds } from "@/lib/block-insert";
import { KIND_ICONS } from "@/lib/sales-page-icons";
import { coachChecks, coachScore } from "@/lib/page-coach";
import { pageWords, mapPageWords } from "@/lib/page-translate";
import { copiedBlocks, emptyBlocksLeft } from "@/lib/store-copy-rules";
import { BLOCK_KINDS, MAX_BLOCKS, type BlockKind, type PageBlock, emptyBlock, pageProblem, parsePage } from "@/lib/sales-page";
import { SITE_KINDS } from "@/lib/site-page-rules";
import { done, is, part } from "./check";

const divider = { id: "div00001", kind: "divider" };
const space = (size: unknown, id = "spc00001") => ({ id, kind: "space", size });
const kept = (raw: unknown) => parsePage({ blocks: [raw] }).blocks;
const read = (blocks: unknown[]) => {
  const raw = { blocks };
  const page = parsePage(raw);
  return { page, problem: pageProblem(raw, page) };
};

const ctx: BlockContext = {
  storeName: "Harbor Kitchen",
  productTitle: "Meal Planner",
  picture: null,
  photo: null,
  action: { kind: "link", href: "#buy" },
  defaultLabel: "Get it now",
  now: 1_900_000_000,
};
const draw = (block: unknown) => renderToStaticMarkup(createElement(BlockView, { block: block as PageBlock, ctx, reviews: null }));

async function main(): Promise<void> {
  part("Kept by the page's own parser");
  is("a divider: its id and kind, nothing else", kept(divider), [divider]);
  is("a space of each size", (["small", "medium", "large"] as const).map((size) => kept(space(size))), [
    [{ id: "spc00001", kind: "space", size: "small" }],
    [{ id: "spc00001", kind: "space", size: "medium" }],
    [{ id: "spc00001", kind: "space", size: "large" }],
  ]);
  is("a size it does not know is medium", [kept(space("huge")), kept(space(3)), kept(space(undefined)), kept({ id: "spc00001", kind: "space" })].map((b) => (b[0] as { size?: string } | undefined)?.size), [
    "medium",
    "medium",
    "medium",
    "medium",
  ]);
  const loaded = {
    heading: "<script>alert(1)</script>",
    body: "<b>words</b>",
    html: "<div onclick='x()'>",
    style: "height: 900px",
    url: "javascript:alert(1)",
    className: "evil",
    color: "#ff0000",
    screens: "phone",
    saved: "abcdefghij",
  };
  const fromDivider = kept({ ...divider, ...loaded });
  const fromSpace = kept({ ...space("large"), ...loaded });
  is("anything else sent with a divider is dropped (but where it shows and its saved section)", fromDivider, [{ id: "div00001", kind: "divider", screens: "phone", saved: "abcdefghij" }]);
  is("and with a space", fromSpace, [{ id: "spc00001", kind: "space", size: "large", screens: "phone", saved: "abcdefghij" }]);
  is("no markup or address survives in either", JSON.stringify([fromDivider, fromSpace]).match(/script|onclick|javascript|<|height|evil|#ff/g), null);
  is("without an id, neither is kept", [kept({ kind: "divider" }), kept({ kind: "space", size: "small", id: "<b>" })], [[], []]);
  is("an empty one of each is what the parser keeps", [emptyBlock("divider" as BlockKind, "div00002"), emptyBlock("space" as BlockKind, "spc00002")], [
    { id: "div00002", kind: "divider" },
    { id: "spc00002", kind: "space", size: "medium" },
  ]);
  is("a page with both is saved as sent", read([{ id: "txt00001", kind: "text", heading: "One", body: "Two" }, divider, space("small"), { id: "txt00002", kind: "text", heading: "Three", body: "" }]).problem, null);
  is("a page of only arrangement is still a page of blocks", read([divider, space("large", "spc00009")]).page.blocks.length, 2);

  part("Counted toward the page's blocks like any other");
  const many = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? space("small", `spc${String(i).padStart(5, "0")}`) : { id: `div${String(i).padStart(5, "0")}`, kind: "divider" }));
  is(`${MAX_BLOCKS} are kept`, read(many(MAX_BLOCKS)).page.blocks.length, MAX_BLOCKS);
  is(`${MAX_BLOCKS} are saved as sent`, read(many(MAX_BLOCKS)).problem, null);
  is(`one more is told back`, read(many(MAX_BLOCKS + 1)).problem, "too_many");
  is(`and not kept`, read(many(MAX_BLOCKS + 1)).page.blocks.length, MAX_BLOCKS);

  part("In the block list and in the menu");
  const about = (kind: string) => BLOCK_KINDS.find((k) => k.kind === kind);
  is("a divider, in plain words", about("divider")?.label, "Divider");
  is("a space, in plain words", about("space")?.label, "Space");
  is("each says what it does", [Boolean(about("divider")?.hint), Boolean(about("space")?.hint)], [true, true]);
  is("each has an icon", [KIND_ICONS["divider" as BlockKind], KIND_ICONS["space" as BlockKind]].every(Boolean), true);
  const arrange = BLOCK_GROUPS.find((g) => g.title === "Arrange the page");
  is("a group of their own", arrange?.kinds, ["divider", "space"]);
  const listed = BLOCK_GROUPS.flatMap((g) => g.kinds);
  const every = BLOCK_KINDS.map((k) => k.kind);
  is("every kind in the list is in exactly one group", every.filter((kind) => listed.filter((k) => k === kind).length !== 1), []);
  is("and no group holds a kind that is not in the list", listed.filter((k) => !every.includes(k)), []);
  const found = (words: string) => blockGroupsFor(every, words).flatMap((g) => g.kinds);
  is("the search finds the divider by its name", found("divider"), ["divider"]);
  is("and by what it is", found("line").includes("divider"), true);
  is("the search finds the space by its name", found("space").includes("space"), true);
  is("and by what it is", found("room").includes("space"), true);
  is("the search finds every kind by its name", every.filter((kind) => !found(about(kind)!.label).includes(kind)), []);
  is("offered on a product's page", ["divider", "space"].every((k) => offeredKinds([]).includes(k as BlockKind)), true);
  is("as often as wanted", ["divider", "space"].every((k) => offeredKinds(["divider", "space"] as BlockKind[]).includes(k as BlockKind)), true);

  part("Drawn");
  const line = draw(divider);
  is("a divider is a line", /^<hr class="sp-divider"\/?>$/.test(line), true);
  const room = (["small", "medium", "large"] as const).map((size) => draw(space(size)));
  is("a space is room of its size, hidden from screen readers", room, [
    '<div class="sp-space sp-space-small" aria-hidden="true"></div>',
    '<div class="sp-space sp-space-medium" aria-hidden="true"></div>',
    '<div class="sp-space sp-space-large" aria-hidden="true"></div>',
  ]);
  // No text between tags: every character after a ">" is the start of the next tag.
  is("neither draws a word", [line, ...room].some((html) => />[^<]/.test(html)), false);
  is("neither takes the focus", [line, ...room].some((html) => /tabindex|<a |<button/.test(html)), false);
  const text = (id: string) => ({ id, kind: "text", heading: id, body: "Words." });
  const bands = (blocks: unknown[]) =>
    [...renderToStaticMarkup(createElement(PageSections, { blocks: parsePage({ blocks }).blocks, ctx, style: "bands", reviewsFor: () => null })).matchAll(/data-block="(txt\d+)" class="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
  is(
    "on a page set in bands, the sections keep their bands",
    bands([text("txt00001"), divider, space("large"), text("txt00002"), text("txt00003")]),
    bands([text("txt00001"), text("txt00002"), text("txt00003")]),
  );
  const arranged = renderToStaticMarkup(createElement(PageSections, { blocks: parsePage({ blocks: [divider, space("small")] }).blocks, ctx, style: "cards", reviewsFor: () => null }));
  is("never on a card or a band of its own", arranged.includes("sp-section"), false);
  is("each in the page's wrapper, for how far down it was read", [arranged.includes('data-block="div00001"'), arranged.includes('data-block="spc00001"')], [true, true]);

  part("Translated, copied and coached");
  const page = parsePage({ blocks: [{ id: "txt00001", kind: "text", heading: "Plan a week", body: "In ten minutes." }, divider, space("large")] });
  is("the translation sends only the text's words", pageWords(page), ["Plan a week", "In ten minutes."]);
  is("and a page of only arrangement sends nothing", pageWords(parsePage({ blocks: [divider, space("small")] })), []);
  const translated = mapPageWords(page, (words) => `[${words}]`);
  is("translated, both come back as they were", translated.blocks.slice(1), page.blocks.slice(1));
  const left = emptyBlocksLeft();
  const copied = copiedBlocks(parsePage({ blocks: [{ ...divider, saved: "abcdefghij" }, space("small")] }).blocks, () => "", () => "", left);
  is("copied to another store: as they are, with no tie to a saved section", copied, [
    { id: "div00001", kind: "divider" },
    { id: "spc00001", kind: "space", size: "small" },
  ]);
  is("with nothing left out", left, emptyBlocksLeft());
  const sells = [
    { id: "hero0001", kind: "hero", headline: "Plan a week in ten minutes", sub: "", media: "none", video: null },
    { id: "ben00001", kind: "benefits", heading: "", items: ["One", "Two", "Three"] },
    { id: "cta00001", kind: "cta", label: "Get the planner", note: "" },
    { id: "faq00001", kind: "faq", heading: "", items: [{ q: "A?", a: "A." }, { q: "B?", a: "B." }, { q: "C?", a: "C." }] },
    { id: "cta00002", kind: "cta", label: "Get the planner", note: "" },
    { id: "rev00001", kind: "reviews", heading: "Reviews", first: [] },
  ];
  const coach = (blocks: unknown[]) => {
    const checks = coachChecks({ page: parsePage({ blocks }), productTitle: "Meal Planner", free: false, picture: false, pictureAlt: "", facts: {} });
    return { checks: checks.map((c) => `${c.id}:${c.done}`), score: coachScore(checks) };
  };
  const between = (blocks: unknown[]) =>
    blocks.flatMap((b, i) => (i === 0 ? [b] : [{ id: `div${String(i).padStart(5, "0")}`, kind: "divider" }, space("large", `spc${String(i).padStart(5, "0")}`), b]));
  is("the coach reads a page with dividers and spaces as the same page without them", coach(between(sells)), coach(sells));
  is("and with them all at the end", coach([...sells, ...many(8).map((b, i) => ({ ...b, id: `end${String(i).padStart(5, "0")}` }))]), coach(sells));

  part("The editor");
  const editor = readFileSync("components/page-editor.tsx", "utf8");
  is("the space's form offers its sizes", /case "space":[\s\S]{0,1500}SPACE_SIZES\.map/.test(editor), true);
  is("a divider has nothing to fill in", /case "divider":[\s\S]{0,400}Nothing to fill in/.test(editor), true);
  part("On a store's own pages too");
  is("a store's own page offers the divider and the space", [SITE_KINDS.includes("divider"), SITE_KINDS.includes("space")], [true, true]);
  is("so its menu shows the arrange group with both", blockGroupsFor(SITE_KINDS, "").find((g) => g.kinds.includes("divider"))?.kinds, ["divider", "space"]);
  is("and the side menu offers them there", [offeredKinds([], SITE_KINDS).includes("divider"), offeredKinds([], SITE_KINDS).includes("space")], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
