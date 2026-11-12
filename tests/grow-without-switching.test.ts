/**
 * "Grow without switching" (245 [SP2], unit 1; lib/plan-growth.ts, app/grow-without-switching; added 12 November
 * 2026). Checked: every line of what a plan adds is a row of the pricing page's own table, with the same values,
 * and only the rows that change from one plan to the next; the prices are the published ones; nothing is typed
 * on the page that could drift from lib/plan.ts; no promise of earnings; while plans are not on sale, it says so;
 * the data the page says can be downloaded matches the studio's own description of the file; it is in the sitemap.
 */
import { readFileSync } from "node:fs";
import { growthSteps } from "@/lib/plan-growth";
import { PRICING_GROUPS, PRICING_PLANS } from "@/lib/pricing-page-data";
import { PLAN_TITLES, TIERS, publishedPriceWords } from "@/lib/plan";
import { done, is, part } from "./check";

part("What each plan adds");
const steps = growthSteps();
is("two steps up: Store to Studio, Studio to Scale", steps.map((s) => [s.fromTitle, s.toTitle]), [[PLAN_TITLES.creator, PLAN_TITLES.pro], [PLAN_TITLES.pro, PLAN_TITLES.scale]]);
const rows = PRICING_GROUPS.flatMap((g) => g.rows.map((r) => ({ group: g.title, ...r })));
for (const step of steps) {
  const changed = rows.filter((r) => r.values[step.from] !== r.values[step.to]);
  is(`${step.toTitle}: exactly the pricing rows that change, with their values`, step.lines, changed.map((r) => ({ group: r.group, label: r.label, from: r.values[step.from], to: r.values[step.to] })));
  is(`${step.toTitle}: its published prices`, [step.toPrice.monthly, step.toPrice.annual], [publishedPriceWords(step.to, "month"), publishedPriceWords(step.to, "year")]);
}
is("the plans listed are the pricing page's, all of them", PRICING_PLANS.map((p) => p.tier), [...TIERS]);

part("The page");
const page = readFileSync("app/grow-without-switching/page.tsx", "utf8");
// What a reader can see: the page without its comments and class names.
const shown = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/className="[^"]*"/g, "");
is("no figure typed on the page", /\$\d|\b\d{2,}\b/.test(shown), false);
is("no promise of earnings or a global brand", /\b(earn|earnings|income|revenue|guarantee|global brand)\b/i.test(shown), false);
is("while plans are not on sale, it says so", page.includes("{PLANS_ON_SALE ? null : <p className=\"mt-3 font-semibold\">Paid plans and paid selling are not open yet. You can prepare your store now.</p>}"), true);
const studio = readFileSync("app/studio/page.tsx", "utf8");
is("the data it says can be downloaded is what the studio's file holds", ["products and their pages", "courses", "forms and their answers", "contacts and a summary of your orders", "Files and videos download from their own pages"].every((part) => page.includes(part) && studio.toLowerCase().includes(part.toLowerCase().replace("products and their pages", "products and their pages").replace("courses", "courses").replace("files and videos download from their own pages", "files and videos download from their own pages"))), true);
is("in the sitemap", readFileSync("app/sitemap.ts", "utf8").includes('{ path: "/grow-without-switching", priority: 0.5 }'), true);

done();
