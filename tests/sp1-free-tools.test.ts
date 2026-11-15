/**
 * 244 [SP1], unit 1: free tools for creators, with no sign-up, at
 * /platform/free-tools. The first: what is left of one sale once the
 * visitor's own fees are taken, worked out in the visitor's browser from
 * what they type, with no tax figure assumed by the site.
 *
 * What fails here:
 *   - the arithmetic, a fee typed as a percentage read wrongly, a result in
 *     floating-point cents, or a total below zero said as if it were money left;
 *   - anything that is not a plain number read as zero, rather than refused;
 *   - the tool's code reaching the network (fetch, beacons, sockets, workers);
 *   - a page without its title, its one sentence, a "Start your store" link,
 *     labeled fields and a result announced politely;
 *   - the hub not listing the tool, the sitemap missing either page;
 *   - a tax rate, an income promise or a made-up figure on the page;
 *   - the pages' bandwidth counted as zero.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FREE_TOOLS, FREE_TOOLS_PATH, readAmount, readPercent, takeHome, TOOL_PAGE_COST } from "@/lib/free-tools";
import { TakeHomeTool } from "@/components/free-tool-take-home";
import { FreeToolsHub } from "@/components/free-tools-hub";
import { done, is, part } from "./check";

part("Reading what is typed");
is("a plain amount", readAmount("19.99"), 1999);
is("a comma for the decimal point", readAmount("19,99"), 1999);
is("whole number", readAmount(" 50 "), 5000);
is("thousands with commas", readAmount("1,250.50"), 125050);
is("empty is not zero", readAmount(""), null);
is("letters are refused", readAmount("abc"), null);
is("a negative is refused", readAmount("-5"), null);
is("three decimals are refused, not rounded", readAmount("1.999"), null);
is("a percentage in basis points", readPercent("2.9"), 290);
is("a percentage with a % sign", readPercent("2.9%"), 290);
is("over 100% is refused", readPercent("120"), null);
is("a percentage with three decimals is refused", readPercent("2.905"), null);

part("What is left of one sale");
is("$50 at 2.9% + $0.30", takeHome({ priceCents: 5000, percentBps: 290, fixedCents: 30, otherCents: 0 }), { feeCents: 175, otherCents: 0, leftCents: 4825, belowZero: false });
is("with another cost per sale", takeHome({ priceCents: 5000, percentBps: 290, fixedCents: 30, otherCents: 500 }), { feeCents: 175, otherCents: 500, leftCents: 4325, belowZero: false });
is("a fee rounded to the cent, half up", takeHome({ priceCents: 1050, percentBps: 290, fixedCents: 0, otherCents: 0 }).feeCents, 30);
is("costs above the price: said as below zero, never as money left", takeHome({ priceCents: 100, percentBps: 290, fixedCents: 30, otherCents: 200 }), { feeCents: 33, otherCents: 200, leftCents: -133, belowZero: true });
is("whole cents only", Number.isInteger(takeHome({ priceCents: 3333, percentBps: 333, fixedCents: 7, otherCents: 0 }).leftCents), true);

part("The tool reaches nothing outside the page");
for (const file of ["components/free-tool-take-home.tsx", "lib/free-tools.ts"]) {
  const text = readFileSync(file, "utf8");
  is(`${file}: no fetch, beacon, socket, worker or storage`, /\bfetch\(|sendBeacon|XMLHttpRequest|WebSocket|EventSource|new Worker|localStorage|sessionStorage|indexedDB|document\.cookie/.test(text), false);
}

part("The pages");
const tool = FREE_TOOLS.find((t) => t.slug === "what-is-left-of-a-sale");
is("the tool is listed", tool !== undefined, true);
const page = renderToStaticMarkup(createElement(TakeHomeTool));
const text = page.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
is("each field has a label tied to it", ["price", "percent", "fixed", "other"].every((f) => page.includes(`for="take-home-${f}"`) && page.includes(`id="take-home-${f}"`)), true);
is("the result is announced politely", /<output[^>]*aria-live="polite"/.test(page), true);
is("no tax rate assumed: it says so", /does not add or assume any tax/i.test(text), true);
is("no percentage typed by the site in a field", /value="\d/.test(page), false);
const hub = renderToStaticMarkup(createElement(FreeToolsHub));
const hubText = hub.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
is("the hub links to the tool", hub.includes(`href="${FREE_TOOLS_PATH}/what-is-left-of-a-sale"`), true);
is("the hub names it with its one sentence", hubText.includes(tool!.title) && hubText.includes(tool!.sentence), true);
for (const file of ["app/platform/free-tools/page.tsx", "app/platform/free-tools/what-is-left-of-a-sale/page.tsx"]) {
  const source = readFileSync(file, "utf8");
  is(`${file}: a discreet "Start your store" link`, source.includes('href="/signin"') && source.includes("Start your store"), true);
  is(`${file}: its own canonical address`, /alternates: \{ canonical: "\/platform\/free-tools/.test(source), true);
}
const all = [page, hub].join(" ");
is("no income promise, no invented figure, no urgency", /you (will|could) (earn|make)|guarantee|limited time|only \d+ left|\d+ creators use/i.test(all), false);
const sitemap = readFileSync("app/sitemap.ts", "utf8");
is("both pages in the sitemap", sitemap.includes('"/platform/free-tools"') && sitemap.includes("FREE_TOOLS"), true);

part("What the pages cost to serve is counted, never zero");
is("bytes and requests of one visit, measured", TOOL_PAGE_COST.bytes > 0 && TOOL_PAGE_COST.requests > 0, true);
is("priced at Vercel's on-demand rates, with the source and its date", [TOOL_PAGE_COST.perGbUsd, TOOL_PAGE_COST.perMillionRequestsUsd, /^https:\/\/vercel\.com\//.test(TOOL_PAGE_COST.source), /^\d{4}-\d{2}-\d{2}$/.test(TOOL_PAGE_COST.checkedOn)], [0.15, 2, true, true]);
is("one visit's cost is above zero", TOOL_PAGE_COST.perVisitUsd() > 0, true);

done();
