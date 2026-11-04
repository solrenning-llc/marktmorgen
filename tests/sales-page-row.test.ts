/**
 * A row of one, two or three columns (lib/sales-page.ts, RowBlock; queue item
 * 375 [TB1], unit 1): kept and drawn. Unit 2 offers it in the studio, with
 * its editor (tests/row-editor.test.ts).
 *
 * What is checked, against the real parser and the real drawing:
 *
 *   - a row of 1, 2 or 3 columns is kept as sent; 0 or 4 columns, or a
 *     column that is not a list, is not a row at all and is told back;
 *   - each column keeps at most MAX_COLUMN_ELEMENTS and the row at most
 *     MAX_ROW_ELEMENTS, in reading order, and more is told back;
 *   - each small element: the valid shape kept, the invalid one refused;
 *   - nothing typed is ever markup: a tag is drawn as text, a button's
 *     javascript:, data: or http address is refused, never linked;
 *   - a picture needs words that describe it unless marked decorative, and
 *     counts with the page's other pictures (kept, copied, brought back);
 *   - on the page, the columns' elements come in reading order, headings
 *     keep the outline, a button is the page's own or a checked link, and
 *     an empty row takes no place;
 *   - "row" is in the block gallery for a product's page, and only there.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BlockContext, BlockView, PageSections } from "@/components/sales-blocks";
import { BLOCK_GROUPS } from "@/components/block-picker";
import { KIND_ICONS } from "@/lib/sales-page-icons";
import { SITE_KINDS } from "@/lib/site-page-rules";
import { coachChecks } from "@/lib/page-coach";
import {
  BLOCK_KINDS,
  MAX_COLUMN_ELEMENTS,
  MAX_ROW_ELEMENTS,
  MAX_ROW_LIST_ITEMS,
  MAX_ROW_PARAGRAPH,
  ROW_ICONS,
  type PageBlock,
  copyOfPage,
  emptyBlock,
  keepPictures,
  pageProblem,
  parsePage,
  parseRowElement,
  picturePaths,
} from "@/lib/sales-page";
import { done, is, part } from "./check";

const path = (n: number) => `images/${"a".repeat(24)}/${String(n).padStart(32, "0")}.webp`;
const picture = (n: number, alt = "A page of the planner") => ({ path: path(n), width: 1200, height: 800, alt, caption: "" });
const youtube = { provider: "youtube", id: "dQw4w9WgXcQ", hash: "" };

const el = {
  heading: { kind: "heading", text: "Plan a week in ten minutes" },
  subheading: { kind: "subheading", text: "Three steps, one page" },
  paragraph: { kind: "paragraph", text: "Write what you have.\n\nThe planner does the rest." },
  list: { kind: "list", items: ["Shopping list", "Seven dinners"] },
  icon: { kind: "icon", name: "clock", label: "" },
  button: { kind: "button", label: "", url: "" },
  link: { kind: "button", label: "See the recipes", url: "https://example.com/recipes" },
  image: { kind: "image", picture: picture(1), decorative: false },
  video: { kind: "video", video: youtube, title: "A week, planned" },
};

const row = (columns: unknown, id = "row00001") => ({ id, kind: "row", columns });
const keep = (blocks: unknown[]) => {
  const raw = { blocks };
  const page = parsePage(raw);
  return { page, problem: pageProblem(raw, page) };
};

part("One, two or three columns");
for (const columns of [[[el.heading]], [[el.heading], [el.paragraph]], [[el.heading], [el.paragraph], [el.list]]]) {
  const { page, problem } = keep([row(columns)]);
  is(`${columns.length} column(s): kept as sent`, [page.blocks.length, problem, page.blocks[0]?.kind === "row" ? page.blocks[0].columns.length : 0], [1, null, columns.length]);
}
for (const [what, columns] of [
  ["no columns", []],
  ["four columns", [[el.heading], [el.heading], [el.heading], [el.heading]]],
  ["a column that is not a list", [[el.heading], "text"]],
  ["no columns at all", undefined],
] as const) {
  const { page, problem } = keep([row(columns)]);
  is(`${what}: not a row, and told back`, [page.blocks.length, problem], [0, "row"]);
}
is("an empty column is kept: it places the others", (keep([row([[el.heading], []])]).page.blocks[0] as { columns: unknown[][] }).columns, [[{ kind: "heading", text: "Plan a week in ten minutes" }], []]);

part("How many elements");
{
  const nine = Array.from({ length: MAX_COLUMN_ELEMENTS + 1 }, (_, i) => ({ kind: "heading", text: `Line ${i}` }));
  const { page, problem } = keep([row([nine])]);
  is(`a column keeps at most ${MAX_COLUMN_ELEMENTS}, and more is told back`, [(page.blocks[0] as { columns: unknown[][] }).columns[0].length, problem], [MAX_COLUMN_ELEMENTS, "row"]);
  const full = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "paragraph", text: `Part ${i}` }));
  const over = keep([row([full(5), full(5), full(5)])]);
  const counts = (over.page.blocks[0] as { columns: unknown[][] }).columns.map((c) => c.length);
  is(`a row keeps at most ${MAX_ROW_ELEMENTS}, in reading order`, counts, [5, 5, 2]);
  is("and more is told back", over.problem, "row");
  is(`exactly ${MAX_ROW_ELEMENTS} is fine`, keep([row([full(4), full(4), full(4)])]).problem, null);
  const items = Array.from({ length: MAX_ROW_LIST_ITEMS + 1 }, (_, i) => `Item ${i}`);
  is(`a list of more than ${MAX_ROW_LIST_ITEMS} points is told back`, keep([row([[{ kind: "list", items }]])]).problem, "row");
}

part("Each element");
for (const [kind, value] of Object.entries(el)) is(`${kind}: kept`, parseRowElement(value) !== null, true);
const refused: [string, unknown][] = [
  ["an unknown kind", { kind: "html", text: "<b>hi</b>" }],
  ["a heading with no words", { kind: "heading", text: "   " }],
  ["a subheading that is not text", { kind: "subheading", text: 42 }],
  ["an empty paragraph", { kind: "paragraph", text: "" }],
  ["a list with no points", { kind: "list", items: ["", "  "] }],
  ["an icon not on the list", { kind: "icon", name: "skull", label: "" }],
  ["a button to javascript:", { kind: "button", label: "Go", url: "javascript:alert(1)" }],
  ["a button to data:", { kind: "button", label: "Go", url: "data:text/html,<script>alert(1)</script>" }],
  ["a button to plain http", { kind: "button", label: "Go", url: "http://example.com" }],
  ["a button to this machine", { kind: "button", label: "Go", url: "https://localhost/admin" }],
  ["a button with a link and no words", { kind: "button", label: "", url: "https://example.com" }],
  ["a picture from elsewhere", { kind: "image", picture: { ...picture(1), path: "https://evil.example/x.png" }, decorative: false }],
  ["a picture with no description", { kind: "image", picture: picture(1, ""), decorative: false }],
  ["a video from elsewhere", { kind: "video", video: { provider: "evil", id: "x" }, title: "" }],
  ["not an object", "heading"],
];
for (const [what, value] of refused) is(`${what}: refused`, parseRowElement(value), null);
is("a decorative picture needs no description, and keeps none", parseRowElement({ kind: "image", picture: picture(1, "Ignored words"), decorative: true }), { kind: "image", picture: { ...picture(1, ""), alt: "" }, decorative: true });
is("every icon on the list is one", ROW_ICONS.every((name) => parseRowElement({ kind: "icon", name, label: "" }) !== null), true);
is("text is trimmed to its limit", (parseRowElement({ kind: "paragraph", text: "x".repeat(MAX_ROW_PARAGRAPH + 50) }) as { text: string }).text.length, MAX_ROW_PARAGRAPH);
is("a button's address is kept as the https it is", parseRowElement(el.link), { kind: "button", label: "See the recipes", url: "https://example.com/recipes" });
is("only the fields of its shape are kept", parseRowElement({ kind: "heading", text: "Hi", style: "color:red", onclick: "x()" }), { kind: "heading", text: "Hi" });
is("a page sent with a refused element is told back, not saved", keep([row([[el.heading, { kind: "button", label: "Go", url: "javascript:alert(1)" }]])]).problem, "row");

part("Pictures count with the page's");
{
  const { page } = keep([row([[el.image], [{ kind: "image", picture: picture(2), decorative: true }]])]);
  is("a row's pictures are the page's, kept with it", picturePaths(page), [path(1), path(2)]);
  const twice = keep([{ id: "pics0001", kind: "pictures", heading: "", items: [picture(1)] }, row([[el.image]])]);
  is("a picture already on the page is not shown twice, and is told back", [picturePaths(twice.page), twice.problem], [[path(1)], "pictures"]);
  const back = keepPictures(page, new Set([path(2)]));
  is("an earlier version brought back loses a picture no longer kept", [back.dropped, picturePaths(back.page)], [1, [path(2)]]);
  const copy = copyOfPage(page);
  is("a copy for another product leaves the pictures out, and counts them", [copy.picturesLeft, picturePaths({ blocks: copy.blocks })], [2, []]);
  const coach = (blocks: unknown[]) => coachChecks({ page: parsePage({ blocks }), productTitle: "Meal Planner", free: false, picture: false, pictureAlt: "", facts: {} }).find((c) => c.id === "described");
  is("the page coach does not ask a decorative picture for a description", coach([row([[{ kind: "image", picture: picture(2), decorative: true }]])])?.done ?? "not asked", "not asked");
  is("and counts a described one as described", coach([row([[el.image]])])?.done, true);
}

part("Drawn on the page");
const ctx: BlockContext = {
  storeName: "Harbor Kitchen",
  productTitle: "Meal Planner",
  picture: null,
  photo: null,
  action: { kind: "link", href: "#buy" },
  defaultLabel: "Get it now",
  now: 1_900_000_000,
};
const draw = (block: PageBlock, context: BlockContext = ctx) => renderToStaticMarkup(createElement(BlockView, { block, ctx: context, reviews: null }));
const three = keep([
  row([
    [el.heading, el.icon, el.paragraph],
    [el.subheading, el.list, el.image],
    [{ kind: "heading", text: "Third" }, el.link, el.button],
  ]),
]).page.blocks[0];
const html = draw(three);
const at = (text: string) => html.indexOf(text);
is("every element is drawn", ["Plan a week", "Write what you have", "Three steps", "Shopping list", "/api/image/", "Third", "See the recipes", "Get it now"].map((t) => at(t) >= 0), [true, true, true, true, true, true, true, true]);
is("in reading order: column one, then two, then three", at("Plan a week") < at("Write what you have") && at("Write what you have") < at("Three steps") && at("Three steps") < at("Shopping list") && at("Shopping list") < at("Third") && at("Third") < at("See the recipes"), true);
is("three columns side by side once there is room", html.includes('class="sp-row sp-row-3"'), true);
is("no table for the layout", html.includes("<table"), false);
is("a heading is a section heading, a subheading under it is one level down", [html.includes("<h2") && html.includes(">Plan a week in ten minutes</h2>"), html.includes(">Three steps, one page</h3>")], [true, true]);
is("a subheading with no heading before it does not skip a level", draw(keep([row([[el.subheading]])]).page.blocks[0]).includes(">Three steps, one page</h2>"), true);
is("an icon without words is decoration", html.includes('aria-hidden="true"'), true);
is("an icon with words says them", draw(keep([row([[{ kind: "icon", name: "shield", label: "Safe checkout" }]])]).page.blocks[0]).includes('role="img" aria-label="Safe checkout"'), true);
is("a picture is drawn from our own address with its description and size", html.includes(`alt="A page of the planner" width="1200" height="800"`), true);
is("a decorative picture is hidden from screen readers", draw(keep([row([[{ kind: "image", picture: picture(3), decorative: true }]])]).page.blocks[0]).includes('alt=""'), true);
is("a link button opens its checked address, and says it opens a new tab", html.includes('href="https://example.com/recipes" class="btn st-btn sp-row-btn" target="_blank" rel="noopener noreferrer nofollow ugc"') && html.includes("new-tab-note"), true);
is("a button with no address is the page's own", html.includes('href="#buy"'), true);
is("buttons use the theme's button, at least 44 pixels high", (html.match(/class="btn st-btn/g) ?? []).length, 2);
is("in the studio's preview a link button does nothing", draw(three, { ...ctx, preview: true }).includes("https://example.com/recipes"), false);
const video = draw(keep([row([[el.video]])]).page.blocks[0]);
is("a video is the lazy player, loading nothing before play", [video.includes("<iframe"), video.includes("A week, planned")], [false, true]);
const tags = draw(keep([row([[{ kind: "heading", text: "<script>alert(1)</script>" }, { kind: "paragraph", text: '<img src=x onerror="alert(1)">' }]])]).page.blocks[0]);
is("a tag typed is drawn as text, never as markup", [tags.includes("<script>"), tags.includes("&lt;script&gt;"), tags.includes("<img src=x")], [false, true, false]);
is("a row with nothing in it is not drawn", draw({ id: "row00009", kind: "row", columns: [[], []] }), "");
const sections = renderToStaticMarkup(createElement(PageSections, { blocks: [{ id: "row00009", kind: "row", columns: [[]] }, three], ctx, style: "bands", reviewsFor: () => null }));
is("and takes no band of its own", (sections.match(/data-block=/g) ?? []).length, 1);

part("Offered on a product's page, now that its editor exists");
is("in the block list", BLOCK_KINDS.some((k) => k.kind === "row"), true);
is("in the gallery, once", BLOCK_GROUPS.flatMap((g) => g.kinds).filter((k) => k === "row").length, 1);
is("not on the store's own pages", SITE_KINDS.includes("row"), false);
is("but it has an icon, like every kind", KIND_ICONS.row, "layout");
is("an empty one is two empty columns", emptyBlock("row", "row00001"), { id: "row00001", kind: "row", columns: [[], []] });

done();
