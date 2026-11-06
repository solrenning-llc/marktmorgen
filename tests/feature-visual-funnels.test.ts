/**
 * The funnels page's card (531 [VP1], unit 1; added 1 November 2026): a
 * piece of the studio's real screen in HTML, its names from the code.
 * Checked: the funnels page shows it; its five rows are the first five funnel
 * types of lib/funnel-types.ts, in that order, each with what it asks for
 * counted from its own steps; the rest are counted, not named; and it is
 * real text, marked as a drawing beside its caption; and "On this page"
 * stays, just under the top.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeatureVisual } from "@/components/feature-visuals";
import { FUNNEL_TYPES, choicesOf, pagesOf } from "@/lib/funnel-types";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const text = (html: string) => html.replace(/<[^>]+>/g, "\n").split("\n").map((s) => s.trim()).filter(Boolean);

function main(): void {
  part("The funnels page's card");
  is("the funnels page shows it", findPage("platform", "funnels")?.visual, "funnels");
  const html = renderToStaticMarkup(createElement(FeatureVisual, { visual: "funnels", tone: "light" }));
  const words = text(html);
  const rows = FUNNEL_TYPES.slice(0, 5);
  is("its rows are the first five funnel types, in the studio's order", words.filter((w) => FUNNEL_TYPES.some((t) => t.label === w)), rows.map((t) => t.label));
  for (const type of rows) {
    is(`${type.label}: what it asks for, counted from its own steps`, words.includes(`${plural(choicesOf(type).length, "product")} to choose · ${plural(pagesOf(type).length, "new page")}`), true);
  }
  is("the rest are counted from the list", words.includes(`and ${plural(FUNNEL_TYPES.length - 5, "more kind")}`), true);
  is("under the studio's own heading, in its own word for them", [words.includes("Start from a kind of funnel"), readFileSync("components/funnel-type-picker.tsx", "utf8").includes("Start from a kind of funnel"), /\btypes?\b/.test(words.join(" "))], [true, true, false]);
  is("real text, the whole drawing hidden beside its read caption", [html.startsWith('<figure class="w-full min-w-0 max-w-[26rem]"><div aria-hidden="true">'), words.includes("The kinds of funnel the studio starts from, read from its own list.")], [true, true]);
  is("no figure that is not a count from the code", words.filter((w) => /\d/.test(w) && !/^(\d+ products? to choose · \d+ new pages?|and \d+ more kinds?)$/.test(w)), []);

  part("On this page stays");
  const topic = readFileSync("components/topic-page.tsx", "utf8");
  is("a page with a card shows On this page just under the top", topic.includes("{page.visual ? <HeroContents blocks={blocks} light /> : null}"), true);
}

main();
done();
