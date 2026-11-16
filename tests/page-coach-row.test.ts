/**
 * The page coach (lib/page-coach.ts) reads a row of columns (375 [TB1]) as it
 * reads the blocks a row can stand for: a row's own button (one with no
 * address, which is the page's own action) counts as a button near the top
 * or at the end; every button in a row has its words checked (274 [AX1] Part
 * A item 6; WCAG 2.4.4, 2.4.9), on both versions of the page; a row's
 * described picture or its video is a look inside; a row's pictures are asked
 * for their descriptions, a decorative one never.
 *
 * What fails here: a row's button not seen near the top or at the end; a
 * button leading elsewhere taken for the page's own; a "Click here" in a row
 * not counted, or the words check not shown on a page whose only button is
 * in a row; a row's picture or video not counted as a look inside.
 */
import { coachChecks, type CoachInput } from "@/lib/page-coach";
import type { PageBlock, RowElement } from "@/lib/sales-page";
import { done, is, part } from "./check";

const picture = { path: `images/${"a".repeat(24)}/${"b".repeat(32)}.webp`, width: 10, height: 10, alt: "A loaf on a board", caption: "" };
const row = (id: string, ...elements: RowElement[]): PageBlock => ({ id, kind: "row", columns: [elements] });
const ownButton = (label: string): RowElement => ({ kind: "button", label, url: "" });
const linkButton = (label: string): RowElement => ({ kind: "button", label, url: "https://example.com/more" });
const words: RowElement = { kind: "paragraph", text: "Some words" };
const hero: PageBlock = { id: "hero0001", kind: "hero", headline: "Bake bread at home", sub: "", media: "none", button: "", video: null } as unknown as PageBlock;
const text = (id: string): PageBlock => ({ id, kind: "text", heading: "", body: "Words" }) as unknown as PageBlock;
const input = (blocks: PageBlock[], variant?: PageBlock[]): CoachInput => ({
  page: { blocks, seoDescription: "", test: null, ...(variant ? { variant: { blocks: variant } as never } : {}) },
  productTitle: "Bread basics",
  free: false,
  picture: false,
  pictureAlt: "",
  facts: {},
});
const check = (i: CoachInput, id: string) => coachChecks(i).find((c) => c.id === id);
const filler = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => text(`text000${id}`));

part("A row's own button near the top and at the end");
is("near the top", check(input([hero, row("row00001", words, ownButton("Get the course")), ...filler]), "early-button")?.done, true);
is("at the end", check(input([hero, ...filler, row("row00001", words, ownButton("Get the course"))]), "closing-button")?.done, true);
is("a button leading elsewhere is not the page's own", [check(input([hero, row("row00001", linkButton("Read the reviews")), ...filler]), "early-button")?.done, check(input([hero, ...filler, row("row00001", linkButton("Read the reviews"))]), "closing-button")?.done], [false, false]);
is("a row with no button is not one", check(input([hero, row("row00001", words), ...filler]), "early-button")?.done, false);

part("Every button in a row says what it does");
is("the check is shown when the only buttons are in a row", check(input([hero, row("row00001", ownButton("Get the course"))]), "button_words")?.done, true);
is("a \"Click here\" in a row is counted", check(input([hero, row("row00001", ownButton("Click here"), linkButton("Read more"))]), "button_words")?.label, "Every button says what it does (2 do not)");
is("an empty one keeps the page's own words", check(input([hero, row("row00001", ownButton(""))]), "button_words")?.done, true);
is("the second version's rows are read too", check(input([hero, row("row00001", ownButton("Get the course"))], [hero, row("row00002", linkButton("Here"))]), "button_words")?.label, "Every button says what it does (1 does not)");

part("A row's pictures and videos");
const video = { provider: "youtube", id: "dQw4w9WgXcQ" } as unknown as Extract<RowElement, { kind: "video" }>["video"];
is("a row's described picture is a look inside", check(input([hero, row("row00001", { kind: "image", picture, decorative: false })]), "show")?.done, true);
is("a row's video is a look inside", check(input([hero, row("row00001", { kind: "video", video, title: "A lesson" })]), "show")?.done, true);
is("a row's video in a window is a look inside", check(input([hero, row("row00001", { kind: "video-window", video, title: "A lesson", label: "Watch a lesson" })]), "show")?.done, true);
is("a video window's \"Click here\" is counted as a vague button", check(input([hero, row("row00001", ownButton("Get the course"), { kind: "video-window", video, title: "", label: "Click here" })]), "button_words")?.label, "Every button says what it does (1 does not)");
is("a decorative picture is not", check(input([hero, row("row00001", { kind: "image", picture: { ...picture, alt: "" }, decorative: true })]), "show")?.done, false);
is("a row's picture without words is asked for its description", check(input([hero, row("row00001", { kind: "image", picture: { ...picture, alt: "" }, decorative: false })]), "described")?.done, false);
is("a decorative one is not", check(input([hero, row("row00001", { kind: "image", picture: { ...picture, alt: "" }, decorative: true })]), "described"), undefined);

done();
