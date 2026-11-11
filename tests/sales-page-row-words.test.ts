/**
 * A row of columns (lib/sales-page.ts, RowBlock; queue item 375 [TB1]) is
 * held to the same rules as every other block's words and pictures:
 *
 *   - its words are among the page's words (lib/page-translate.ts), in
 *     reading order, so the Terms check (567 [GD1]) reads them and a
 *     translation puts each back where it was; never a button's address;
 *   - a copy of the page into another store leaves its pictures out and
 *     counts them (lib/store-copy-rules.ts, copiedBlocks), as a pictures or a
 *     feature block's;
 *   - a row sent outside the editor whose words would be cut short is told
 *     back as "row", not saved shorter; empty list lines are left out before
 *     points are counted, so eight points and a blank line are kept whole.
 */
import { fastMoneyOnPage } from "@/lib/terms-check-rules";
import { pageWords, withWords } from "@/lib/page-translate";
import { copiedBlocks, emptyBlocksLeft } from "@/lib/store-copy-rules";
import { MAX_CTA_LABEL, MAX_HEADING, MAX_ITEM, MAX_ROW_LIST_ITEMS, MAX_ROW_PARAGRAPH, MAX_SUBHEADLINE, pageProblem, parsePage } from "@/lib/sales-page";
import { done, is, part } from "./check";

const path = (n: number) => `images/${"a".repeat(24)}/${String(n).padStart(32, "0")}.webp`;
const picture = (n: number, alt: string, caption = "") => ({ path: path(n), width: 1200, height: 800, alt, caption });
const youtube = { provider: "youtube", id: "dQw4w9WgXcQ", hash: "" };
const keep = (columns: unknown) => {
  const raw = { blocks: [{ id: "row00001", kind: "row", columns }] };
  const page = parsePage(raw);
  return { page, problem: pageProblem(raw, page) };
};

const full = keep([
  [
    { kind: "heading", text: "Plan a week" },
    { kind: "subheading", text: "Three steps" },
    { kind: "paragraph", text: "Write what you have." },
    { kind: "list", items: ["Shopping list", "Seven dinners"] },
  ],
  [
    { kind: "icon", name: "clock", label: "Ten minutes" },
    { kind: "button", label: "See the recipes", url: "https://example.com/recipes" },
    { kind: "image", picture: picture(1, "A page of the planner", "Week one"), decorative: false },
    { kind: "video", video: youtube, title: "A week, planned" },
  ],
]).page;

part("A row's words are the page's words");
is(
  "every word a reader reads, in reading order, never the address",
  pageWords(full),
  ["Plan a week", "Three steps", "Write what you have.", "Shopping list", "Seven dinners", "Ten minutes", "See the recipes", "A page of the planner", "Week one", "A week, planned"],
);
const promise = keep([[{ kind: "heading", text: "Bread at home" }], [{ kind: "paragraph", text: "Make easy money baking at home." }]]).page;
is("a promise of easy money in a row is found by the Terms check", fastMoneyOnPage(pageWords(promise))?.field, "page");
const translated = withWords(full, pageWords(full).map((w) => `ES ${w}`));
is("a translation puts each word back in its place", pageWords(translated), pageWords(full).map((w) => `ES ${w}`));
const back = translated.blocks[0];
is(
  "into the same parts, the address and the video untouched",
  back?.kind === "row" ? [back.columns[0][3], back.columns[1][1], back.columns[1][3]] : null,
  [{ kind: "list", items: ["ES Shopping list", "ES Seven dinners"] }, { kind: "button", label: "ES See the recipes", url: "https://example.com/recipes" }, { kind: "video", video: youtube, title: "ES A week, planned" }],
);
const decorative = keep([[{ kind: "image", picture: picture(2, ""), decorative: true }, { kind: "icon", name: "star", label: "" }]]).page;
is("a decorative picture and an icon with no words give no words", pageWords(decorative), []);
{
  // Unit 5: a video behind a button. The button's words are read first, then the window's title; the video is never words.
  const windowed = keep([[{ kind: "video-window", video: youtube, title: "A tour of the planner", label: "Watch the tour" }]]).page;
  is("a video in a window gives its button words, then its title", pageWords(windowed), ["Watch the tour", "A tour of the planner"]);
  const es = withWords(windowed, ["ES Watch the tour", "ES A tour of the planner"]).blocks[0];
  is("and a translation puts each back, the video untouched", es?.kind === "row" ? es.columns[0][0] : null, { kind: "video-window", video: youtube, title: "ES A tour of the planner", label: "ES Watch the tour" });
  const left = emptyBlocksLeft();
  const [copied] = copiedBlocks(windowed.blocks, (id) => id, (id) => id, left);
  is("a copy into another store keeps it whole, nothing left out", [copied.kind === "row" ? copied.columns[0][0] : null, left.pictures], [{ kind: "video-window", video: youtube, title: "A tour of the planner", label: "Watch the tour" }, 0]);
}

part("A copy into another store leaves a row's pictures out");
{
  const left = emptyBlocksLeft();
  const [copied] = copiedBlocks(full.blocks, (id) => id, (id) => id, left);
  is("the picture is left out and counted", [copied.kind === "row" ? copied.columns.flat().some((e) => e.kind === "image") : true, left.pictures], [false, 1]);
  is("everything else is kept, in order", copied.kind === "row" ? copied.columns.map((c) => c.map((e) => e.kind)) : null, [["heading", "subheading", "paragraph", "list"], ["icon", "button", "video"]]);
  is("the page copied from is left as it was", full.blocks[0].kind === "row" ? full.blocks[0].columns[1].length : 0, 4);
}

part("Words that would be cut short are told back, not saved shorter");
const cut: [string, unknown][] = [
  ["a heading too long", { kind: "heading", text: "x".repeat(MAX_HEADING + 1) }],
  ["a smaller heading too long", { kind: "subheading", text: "x".repeat(MAX_SUBHEADLINE + 1) }],
  ["words too long", { kind: "paragraph", text: "x".repeat(MAX_ROW_PARAGRAPH + 1) }],
  ["a list point too long", { kind: "list", items: ["x".repeat(MAX_ITEM + 200)] }],
  ["an icon's words too long", { kind: "icon", name: "clock", label: "x".repeat(200) }],
  ["a button's words too long", { kind: "button", label: "x".repeat(60), url: "" }],
  ["a video title too long", { kind: "video", video: youtube, title: "x".repeat(MAX_HEADING + 1) }],
  ["a video window's title too long", { kind: "video-window", video: youtube, title: "x".repeat(MAX_HEADING + 1), label: "Watch" }],
  ["a video window's button words too long", { kind: "video-window", video: youtube, title: "", label: "x".repeat(MAX_CTA_LABEL + 1) }],
  ["a picture's description too long", { kind: "image", picture: picture(3, "x".repeat(400)), decorative: false }],
  ["a picture's line too long", { kind: "image", picture: picture(4, "A cat", "x".repeat(400)), decorative: false }],
];
for (const [what, element] of cut) is(`${what}: told back`, keep([[element]]).problem, "row");
is("spaces trimmed are not a cut", keep([[{ kind: "heading", text: "  Plan a week  " }, { kind: "list", items: [" One ", "Two"] }]]).problem, null);

part("Empty list lines are left out before points are counted");
{
  const eight = Array.from({ length: MAX_ROW_LIST_ITEMS }, (_, i) => `Point ${i + 1}`);
  const withBlank = keep([[{ kind: "list", items: [...eight.slice(0, 4), "", " ", ...eight.slice(4), ""] }]]);
  is(`${MAX_ROW_LIST_ITEMS} points and blank lines: kept whole`, [withBlank.problem, withBlank.page.blocks[0]?.kind === "row" ? withBlank.page.blocks[0].columns[0][0] : null], [null, { kind: "list", items: eight }]);
  is(`${MAX_ROW_LIST_ITEMS + 1} points: told back`, keep([[{ kind: "list", items: [...eight, "One more"] }]]).problem, "row");
}

done();
