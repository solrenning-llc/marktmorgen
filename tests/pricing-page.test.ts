import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PRICING_PLANS, PRICING_GROUPS, PRICING_ADDONS, PRICING_QUESTIONS, PRICING_OPEN } from "@/lib/pricing-page-data";
import { TIERS, PLAN_TITLES, PUBLISHED_PLAN_PRICES, publishedPriceWords, monthlyEmails } from "@/lib/plan";
import { SHARE_LIMITS } from "@/lib/funnel-share-rules";
import { PIPELINES_BY_TIER } from "@/lib/crm-rules";
import { ASSISTANT_PRICE_CENTS, ASSISTANT_MESSAGES_MONTHLY } from "@/lib/store-assistant-rules";
import { autoCaptionCents } from "@/lib/auto-captions-rules";
import sitemap from "@/app/sitemap";

const allRows=PRICING_GROUPS.flatMap(group=>group.rows);
const value=(key:string,tier:typeof TIERS[number])=>{const found=allRows.find(row=>row.key===key);assert.ok(found,key);return found.values[tier];};
test("pricing renders the canonical published plan prices for both intervals without opening sales",()=>{
 assert.equal(PRICING_OPEN,false);
 assert.equal(PRICING_PLANS.length,TIERS.length);
 for(const tier of TIERS){const plan=PRICING_PLANS.find(plan=>plan.tier===tier);assert.ok(plan);assert.equal(plan.title,PLAN_TITLES[tier]);assert.equal(plan.monthly,publishedPriceWords(tier,"month"));assert.equal(plan.annual,publishedPriceWords(tier,"year"));assert.equal(plan.monthlyCents,PUBLISHED_PLAN_PRICES[tier].month);assert.equal(plan.annualCents,PUBLISHED_PLAN_PRICES[tier].year);assert.equal(plan.share,"0% of each sale");}
});
test("pricing has complete distinct rows for every plan and preserves independent allowance windows",()=>{
 assert.equal(new Set(allRows.map(row=>row.key)).size,allRows.length);
 for(const row of allRows)for(const tier of TIERS)assert.ok(row.values[tier].length,row.key+" "+tier);
 for(const tier of TIERS){assert.equal(value("list-email",tier),monthlyEmails(tier).toLocaleString("en-US")+"/month");assert.equal(value("pipelines",tier),String(PIPELINES_BY_TIER[tier]));assert.equal(value("active-shares",tier),String(SHARE_LIMITS[tier].shares));}
 assert.match(allRows.find(row=>row.key==="delivery")!.note!,/not a hard block on paid downloads/);
 assert.match(allRows.find(row=>row.key==="operation-api")!.note!,/key permissions/);
 assert.match(PRICING_GROUPS.find(group=>group.id==="sharing")!.period,/UTC calendar month/);
 assert.match(PRICING_GROUPS.find(group=>group.id==="operating-allowances")!.period,/billing-month/);
});
test("pricing add-ons use the real separate subscription and caption quote",()=>{
 assert.ok(PRICING_ADDONS[0].price.includes("$"+ASSISTANT_PRICE_CENTS/100));
 assert.ok(PRICING_ADDONS[0].body.includes(String(ASSISTANT_MESSAGES_MONTHLY)));
 assert.ok(PRICING_ADDONS[1].body.includes("$"+autoCaptionCents(600,2)/100));
 assert.match(PRICING_QUESTIONS.find(q=>q.q.includes("refund"))!.a,/different refund terms/);
});
test("pricing is discoverable and uses a real comparison link, native FAQ and scoped accessible tables",()=>{
 assert.ok(sitemap().some(page=>page.url.endsWith("/pricing")));
 const page=readFileSync("app/pricing/page.tsx","utf8");
 assert.match(page,/href="\/proof\/comparisons"/);
 assert.match(page,/id="content" tabIndex=\{-1\}/);assert.match(page,/<summary/);assert.match(page,/scope="col"/);assert.match(page,/scope="row"/);
 for(const path of ["components/site-nav.tsx","components/site-footer.tsx","components/morning-header.tsx"])assert.ok(readFileSync(path,"utf8").includes('"/pricing"'),path);
 // VS1: the home page and /pricing share the morning header; /pricing marks itself current in it.
 assert.ok(readFileSync("app/page.tsx","utf8").includes("<MorningHeader />"));
 assert.ok(page.includes('<MorningHeader current="/pricing" />'));
 assert.doesNotMatch(page,/fetch\(|useEffect|Book a demo|Talk to an expert/);
});

test("pricing is a real route and legacy aliases point to it without shadowing it",()=>{
 const config=readFileSync("next.config.ts","utf8");
 assert.ok(config.includes('...to("/pricing", "/price", "/prices", "/plans")'));
 assert.ok(!config.includes('...to("/#pricing", "/pricing"'));
});
