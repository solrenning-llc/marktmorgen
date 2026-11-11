/**
 * VR (owner, 25/10/2026, Part A item 2), found by Claude 4 on 11/11/2026 by
 * clicking every studio button on the real production build: "See campaign
 * results" in "Prepare your next promotion" (components/promotion-planner.tsx)
 * scrolled to the "Campaigns, payments and recorded ads" panel, which is not
 * drawn while no campaign is recorded (components/campaign-results.tsx), so
 * the button did nothing. It is shown only when that panel is, by the same
 * rule (hasCampaignResults, lib/campaign-results.ts).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromotionPlanner } from "@/components/promotion-planner";
import { CampaignResultsPanel } from "@/components/campaign-results";
import { campaignResultsFrom, hasCampaignResults } from "@/lib/campaign-results";
import type { StatsData } from "@/lib/stats";
import { done, is, part } from "./check";

const row = { views: 100, sales: 1, cents: 12345, checkouts: 2 };
const base = {
  sales: "ok", partial: false, currency: "usd", days: [{ date: "2026-11-10" }],
  products: [{ id: "a", title: "A", d7: row, d30: row, d90: row }],
  channels: { d7: [{ source: "x", visits: 100, cents: 12345, sales: 1 }], d30: [], d90: [] },
};
const noCampaign = { ...base, posts: { d7: [], d30: [], d90: [] } } as unknown as StatsData;
const withCampaign = { ...base, posts: { d7: [{ campaign: "spring", visits: 12, sales: 1, cents: 1900, sources: ["instagram"] }], d30: [], d90: [] } } as unknown as StatsData;
const products = [{ id: "a", title: "Synthetic product", url: "https://shop.example/p/a" }];
const planner = (data: StatsData, campaignResults: boolean) => renderToStaticMarkup(createElement(PromotionPlanner, { data, range: "d7", products, campaignResults }));
const panel = (data: StatsData) => renderToStaticMarkup(createElement(CampaignResultsPanel, { data, range: "d7", spends: [] }));

part("The panel the button leads to");
is("with no campaign recorded, no panel is drawn", panel(noCampaign), "");
is("and the rule says so", hasCampaignResults(campaignResultsFrom(noCampaign, "d7", [])), false);
is("with a campaign recorded, the panel is drawn under its heading", panel(withCampaign).includes('id="numbers-posts"'), true);
is("and the rule says so", hasCampaignResults(campaignResultsFrom(withCampaign, "d7", [])), true);
is("ads not tied to a campaign also draw it", hasCampaignResults(campaignResultsFrom(noCampaign, "d7", [{ id: "s1", channel: "instagram", campaign: "", cents: 500, from: "2026-11-10", to: "2026-11-10" }])), true);
is("nothing read is nothing shown", hasCampaignResults(null), false);

part("The button");
is("not offered while there are no results to go to", planner(noCampaign, false).includes("See campaign results"), false);
is("offered when the panel is on the page", planner(withCampaign, true).includes("See campaign results"), true);
is("the planner itself still renders without it", planner(noCampaign, false).includes("Copy campaign link"), true);

part("The studio wires both to the same rule");
const stats = readFileSync("components/stats-panel.tsx", "utf8");
is("the numbers page tells the planner whether the panel is drawn", /<PromotionPlanner[^>]*campaignResults=\{/.test(stats), true);
is("the panel hides itself by the same rule", readFileSync("components/campaign-results.tsx", "utf8").includes("if (!hasCampaignResults(report)) return null;"), true);
done();
