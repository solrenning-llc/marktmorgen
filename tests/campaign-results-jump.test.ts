// "See campaign results" in the promotion planner did nothing when the period had no campaign results: it scrolled to
// #numbers-posts, which components/campaign-results.tsx does not draw then (VR site sweep, 12/11/2026). It now moves
// there and focuses the heading when the section is drawn, and says so plainly when it is not.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromotionPlanner } from "@/components/promotion-planner";
import { CAMPAIGN_RESULTS_ID, NO_CAMPAIGN_RESULTS, showCampaignResults } from "@/lib/campaign-results-jump";
import type { StatsData } from "@/lib/stats";
import { done, is } from "./check";

const calls: string[] = [];
const heading = {
  scrollIntoView: (options: ScrollIntoViewOptions) => calls.push("scroll:" + options.behavior + ":" + options.block),
  focus: (options?: FocusOptions) => calls.push("focus:" + String(options?.preventScroll)),
};
const asked: string[] = [];
is("with the section drawn, it is found", showCampaignResults((id) => { asked.push(id); return heading; }, false), true);
is("it looks for the Campaigns section's heading", asked, [CAMPAIGN_RESULTS_ID]);
is("it scrolls there and puts the focus on the heading", calls, ["scroll:smooth:start", "focus:true"]);
calls.length = 0;
showCampaignResults(() => heading, true);
is("with reduced motion, it jumps without animating", calls[0], "scroll:auto:start");
calls.length = 0;
is("without the section, it says it was not found", showCampaignResults(() => null, false), false);
is("and nothing is scrolled or focused", calls, []);
is("the words say there are no campaign results yet, in plain words", NO_CAMPAIGN_RESULTS.startsWith("No campaign results for this period yet."), true);

// The section's heading is the target and can take the focus.
const results = readFileSync("components/campaign-results.tsx", "utf8");
is("the Campaigns heading carries the id and can be focused", results.includes(`<h3 id="${CAMPAIGN_RESULTS_ID}" tabIndex={-1}`), true);
// The planner wires the button to it and keeps a status line for the answer, empty until pressed.
const planner = readFileSync("components/promotion-planner.tsx", "utf8");
is("the button uses showCampaignResults and shows NO_CAMPAIGN_RESULTS when it is not found", planner.includes("setNoResults(!showCampaignResults(") && planner.includes("noResults ? NO_CAMPAIGN_RESULTS"), true);
is("the planner no longer scrolls to the id on its own", planner.includes('getElementById("numbers-posts")?.scrollIntoView'), false);
const row = { views: 100, sales: 1, cents: 12345, checkouts: 2 };
const data = { sales: "ok", partial: false, currency: "usd", days: [{ date: "2026-10-16" }], products: [{ id: "a", title: "A", d7: row, d30: row, d90: row }], channels: { d7: [], d30: [], d90: [] } } as unknown as StatsData;
const html = renderToStaticMarkup(createElement(PromotionPlanner, { data, range: "d7", products: [{ id: "a", title: "A", url: "https://shop.example/p/a" }] }));
const status = html.match(/<p id="([^"]+-results-status)"[^>]*role="status"[^>]*>([^<]*)<\/p>/);
is("the status line is drawn, empty before the button is pressed", status ? status[2] : null, "");
is("the button is described by that status line", Boolean(status && html.includes(`aria-describedby="${status[1]}">See campaign results`)), true);
done();
