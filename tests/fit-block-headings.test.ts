/**
 * The "Who it is for" block (components/sales-blocks.tsx, "fit") keeps the page's outline whole (WCAG 1.3.1, 2.4.6,
 * 2.4.10; 274 [AX1]): its two sides are headings under the block's own heading (h3 under h2), and when the creator
 * leaves that heading empty they are section headings themselves (h2). Before, a block with no heading went from
 * the page's h1 straight to h3, a level skipped in what a screen reader lists. Nothing the creator wrote is changed.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BlockContext, BlockView } from "@/components/sales-blocks";
import type { PageBlock } from "@/lib/sales-page";
import { done, is, part } from "./check";

const ctx: BlockContext = {
  storeName: "Harbor Kitchen",
  productTitle: "Meal Planner",
  picture: null,
  photo: null,
  action: { kind: "link", href: "#buy" },
  defaultLabel: "Get it now",
  now: 1_900_000_000,
};
const draw = (block: PageBlock) => renderToStaticMarkup(createElement(BlockView, { block, ctx, reviews: null }));
const levels = (html: string) => [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
const fit = (heading: string, yes: string[], no: string[]): PageBlock => ({ id: "fit00001", kind: "fit", heading, yes, no, yesLabel: "", noLabel: "" }) as PageBlock;

part("With the block's own heading");
is("its sides sit under it", levels(draw(fit("Is it for you?", ["Busy cooks"], ["Chefs"]))), [2, 3, 3]);
is("one side only", levels(draw(fit("Is it for you?", ["Busy cooks"], []))), [2, 3]);

part("With no heading of its own");
is("its sides are section headings, never a level skipped", levels(draw(fit("", ["Busy cooks"], ["Chefs"]))), [2, 2]);
is("one side only", levels(draw(fit("", [], ["Chefs"]))), [2]);
is("the side's own words are kept", draw(fit("", ["Busy cooks"], [])).includes("Busy cooks"), true);

done();
