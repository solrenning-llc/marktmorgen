import assert from "node:assert/strict";
import test from "node:test";
import sitemap from "@/app/sitemap";
import { findPage, type TopicPage } from "@/lib/site-pages";
import { COMPETITOR_PRICES, type OfficialPriceSource } from "@/lib/competitor-prices";
import { TIERS, PLAN_TITLES, publishedPriceWords, monthlyEmails } from "@/lib/plan";
import { pipelineLimitWords } from "@/lib/crm-rules";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";

test("official comparison prices carry an HTTPS source and a real read date", () => {
  for (const competitor of Object.values(COMPETITOR_PRICES)) {
    assert.equal(competitor.currency, "USD");
    for (const plan of competitor.plans) {
      if (plan.monthlyCents !== null) assert.ok(Number.isSafeInteger(plan.monthlyCents) && plan.monthlyCents >= 0);
      assert.ok(plan.monthlyCents !== null || plan.annualCents !== null || ("annualEquivalentMonthlyCents" in plan && Number.isSafeInteger(plan.annualEquivalentMonthlyCents) && plan.annualEquivalentMonthlyCents > 0));
      if (plan.annualCents !== null) assert.ok(Number.isSafeInteger(plan.annualCents) && plan.annualCents >= 0);
      assert.equal(new URL(plan.source.url).protocol, "https:");
      assert.ok(plan.source.label.trim());
      assert.match(plan.source.readOn, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(plan.source.readOn).toISOString().slice(0, 10), plan.source.readOn);
    }
    const extraSources: OfficialPriceSource[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
      const record=value as Record<string, unknown>;
      if (typeof record.url==="string" && typeof record.label==="string" && typeof record.readOn==="string")
        extraSources.push({url:record.url,label:record.label,readOn:record.readOn});
      for (const entry of Object.values(record)) visit(entry);
    };
    visit(competitor);
    for (const source of extraSources) {
      assert.equal(new URL(source.url).protocol, "https:");
      assert.match(source.readOn, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});
test("the comparison reads every own published price, email limit and catalog cap", () => {
  const page = findPage("proof", "kajabi");
  assert.ok(page);
  assert.equal(page.seo?.title, "Marktmorgen vs Kajabi");
  assert.ok(page.seo?.description.startsWith("A Kajabi alternative where"));
  const table = page.blocks.find(b => b.kind === "table");
  assert.ok(table && table.kind === "table");
  const monthly = table.rows.find(r => r[0] === "Monthly subscription")![2];
  const annual = table.rows.find(r => r[0] === "Annual subscription")![2];
  const email = table.rows.find(r => r[0] === "Marketing email")![2];
  for (const tier of TIERS) {
    assert.ok(monthly.includes(PLAN_TITLES[tier] + ": " + publishedPriceWords(tier, "month")));
    assert.ok(annual.includes(PLAN_TITLES[tier] + ": " + publishedPriceWords(tier, "year")));
    assert.ok(email.includes(PLAN_TITLES[tier] + ": " + monthlyEmails(tier).toLocaleString("en-US") + " list emails/month"));
  }
  assert.ok(table.rows.find(r => r[0] === "Product catalog")![2].includes(MAX_PRODUCTS.toLocaleString("en-US")));
  const ahead = page.blocks.find(b => b.kind === "limits" && b.title === "Where they are ahead");
  assert.ok(ahead && ahead.kind === "limits" && ahead.items.length >= 3);
  assert.ok(table.rows.find(r => r[0] === "Getting started")![2].includes("not open yet"));
});
test("new proof pages are in the existing sitemap and the index links only actual proof pages", () => {
  for (const slug of ["kajabi", "skool", "clickfunnels", "circle", "kit", "whop", "hotmart", "highlevel", "teachable", "substack", "patreon", "linktree", "podia", "thinkific", "systeme", "comparisons"]) {
    assert.equal(sitemap().filter(e => new URL(e.url).pathname === "/proof/" + slug).length, 1);
  }
  const index = findPage("proof", "comparisons");
  assert.ok(index);
  const links = index.blocks.flatMap(b => b.kind === "features" ? b.items.map(i => i.href) : []);
  assert.ok(links.includes("/proof/kajabi"));
  for (const href of links) assert.ok(href && findPage("proof", href.split("/").at(-1)!));
});

test("Skool unknown annual charges and the ambiguous exact boundary are never zero", () => {
  const skool = COMPETITOR_PRICES.skool;
  assert.ok(skool.plans.every(p => p.annualCents === null && p.platformFeeBps === null));
  assert.ok(skool.feeScope.includes("exact $900"));
  assert.ok(skool.plans.every(p => p.feeSource.url && p.feeSource.readOn));
  const page = findPage("proof", "skool");
  assert.ok(page && page.seo?.title === "Marktmorgen vs Skool");
  assert.ok(page.seo?.description.startsWith("A Skool alternative where"));
  const table = page.blocks.find(b => b.kind === "table");
  assert.ok(table && table.kind === "table");
  for (const tier of TIERS) {
    assert.ok(table.rows.find(r => r[0] === "Monthly subscription")![2].includes(publishedPriceWords(tier, "month")));
    assert.ok(table.rows.find(r => r[0] === "Annual billing")![2].includes(publishedPriceWords(tier, "year")));
  }
  assert.ok(table.rows.find(r => r[0] === "Discovery and acquisition")![1].includes("30%"));
  assert.ok(page.blocks.some(b => b.kind === "limits" && b.title === "Where they are ahead"));
});

test("ClickFunnels annual-only billing and both migration links stay explicit", () => {
  const dominate=COMPETITOR_PRICES.clickfunnels.plans.find(p=>p.name==="Dominate");
  assert.ok(dominate && dominate.monthlyCents === null && dominate.annualCents > 0);
  const comparison=findPage("proof","clickfunnels");
  const migration=findPage("platform","move-from-clickfunnels");
  assert.ok(comparison && migration);
  assert.equal(comparison.seo?.title,"Marktmorgen vs ClickFunnels");
  const links=(page: TopicPage)=>page.blocks.flatMap(b=>b.kind==="features"?b.items.map(i=>i.href):[]);
  assert.ok(links(comparison).includes("/platform/move-from-clickfunnels"));
  assert.ok(links(migration).includes("/proof/clickfunnels"));
  const table=comparison.blocks.find(b=>b.kind==="table");
  assert.ok(table && table.kind==="table");
  for(const tier of TIERS){
    assert.ok(table.rows.find(r=>r[0]==="Monthly subscription")![2].includes(publishedPriceWords(tier,"month")));
    assert.ok(table.rows.find(r=>r[0]==="Annual subscription")![2].includes(publishedPriceWords(tier,"year")));
  }
  assert.ok(table.rows.find(r=>r[0]==="Monthly subscription")![1].includes("Dominate: annual only"));
  assert.ok(table.rows.find(r=>r[0]==="Page experiments")![1].includes("one variant"));
  assert.ok(table.rows.find(r=>r[0]==="Page experiments")![2].includes("second version of the whole page"));
});

test("Circle annual equivalents stay distinct from unknown invoices and existing chat is preserved", () => {
  const circle=COMPETITOR_PRICES.circle;
  assert.ok(circle.plans.every(p=>p.monthlyCents===null && p.annualCents===null));
  assert.deepEqual(circle.plans.map(p=>p.annualEquivalentMonthlyCents),[8900,19900,41900]);
  const page=findPage("proof","circle");
  assert.ok(page && page.seo?.title==="Marktmorgen vs Circle");
  const table=page.blocks.find(b=>b.kind==="table");
  assert.ok(table && table.kind==="table");
  assert.ok(table.rows.find(r=>r[0]==="Annual-billing display")![1].includes("not been verified"));
  for(const tier of TIERS) {
    assert.ok(table.rows.find(r=>r[0]==="Monthly subscription")![2].includes(publishedPriceWords(tier,"month")));
    assert.ok(table.rows.find(r=>r[0]==="Annual-billing display")![2].includes(publishedPriceWords(tier,"year")));
  }
  assert.ok(page.blocks.some(b=>b.kind==="lead" && b.text.includes("existing chat is not missing")));
  assert.ok(table.rows.find(r=>r[0]==="Private conversations")![2].includes("Text conversations"));
  assert.ok(page.blocks.some(b=>b.kind==="limits" && b.title==="Where they are ahead" && b.items.length>=3));
});

test("Kit inclusive processing and first-year promotion never become a false renewal quote", () => {
 const kit=COMPETITOR_PRICES.kit;
 const pro=kit.plans.find(p=>p.name==="Pro");
 assert.ok(pro && pro.annualCents===null && pro.monthlyCents===null);
 assert.ok(kit.plans.every(p=>p.listedPaymentFeeBps===350 && p.listedPaymentFixedCents===30 && p.platformFeeBps===60));
 assert.ok(kit.feeScope.includes("including card processing"));
 assert.ok(kit.billingScope.includes("first-year") && kit.billingScope.includes("not verified"));
 const page=findPage("proof","kit");assert.ok(page && page.seo?.title==="Marktmorgen vs Kit");
 const table=page.blocks.find(b=>b.kind==="table");assert.ok(table && table.kind==="table");
 for(const tier of TIERS){
  assert.ok(table.rows.find(r=>r[0]==="Subscription pricing")![2].includes(publishedPriceWords(tier,"month")));
  assert.ok(table.rows.find(r=>r[0]==="Email allowance")![2].includes(monthlyEmails(tier).toLocaleString("en-US")));
 }
 assert.ok(page.blocks.some(b=>b.kind==="limits" && b.title==="Where they are ahead"));
});

test("Whop payment quotes retain conditional additions and unknown platform share", () => {
 const whop=COMPETITOR_PRICES.whop;
 assert.equal(whop.plans[0].monthlyCents,0);
 assert.equal(whop.plans[0].platformFeeBps,null);
 assert.equal(whop.trial.days,null);
 assert.equal(whop.plans[0].listedPaymentFeeBps,270);
 assert.ok(whop.feeScope.includes("when enabled") && whop.feeScope.includes("6%"));
 assert.ok(whop.payoutScope.includes("4% + $2.50"));
 const page=findPage("proof","whop");assert.ok(page && page.seo?.title==="Marktmorgen vs Whop");
 const table=page.blocks.find(b=>b.kind==="table");assert.ok(table && table.kind==="table");
 for(const tier of TIERS)assert.ok(table.rows.find(r=>r[0]==="Subscription")![2].includes(publishedPriceWords(tier,"month")));
 assert.ok(page.blocks.some(b=>b.kind==="limits" && b.title==="Where they are ahead"));
});

test("Hotmart current fixed fee, microtransactions and policy conflict stay explicit", () => {
 const h=COMPETITOR_PRICES.hotmart;
 assert.equal(h.plans[0].monthlyCents,0);assert.equal(h.plans[0].platformFeeBps,990);
 assert.equal(h.plans[0].listedPaymentFixedCents,100);assert.equal(h.trial.days,null);
 assert.ok(h.feeScope.includes("At or below $15") && h.feeScope.includes("$0.10"));
 assert.ok(h.policyScope.includes("$0.50") && h.policyScope.includes("$1.00") && h.policyScope.includes("legacy Player"));
 const page=findPage("proof","hotmart");assert.ok(page && page.seo?.title==="Marktmorgen vs Hotmart");
 const table=page.blocks.find(b=>b.kind==="table");assert.ok(table && table.kind==="table");
 for(const tier of TIERS)assert.ok(table.rows.find(r=>r[0]==="Subscription")![2].includes(publishedPriceWords(tier,"month")));
 assert.ok(page.blocks.some(b=>b.kind==="limits" && b.title==="Where they are ahead"));
});

test("HighLevel comparison preserves real CRM caps and does not turn unlimited accounts into free usage", () => {
 const h=COMPETITOR_PRICES.highlevel;assert.ok(h.plans.every(p=>p.platformFeeBps===null));
 // #4571 batch 6: read November 15, 2026, the pricing page pairs $4,970/year with the $297 plan and $2,970/year with
 // the $497 one, the reverse of October 20; neither pairing is confirmed, so neither annual quote is shown as read.
 assert.deepEqual(h.plans.map(p=>p.annualCents),[97000,null,null]);
 const page=findPage("proof","highlevel");assert.ok(page && page.seo?.title==="Marktmorgen vs HighLevel");
 const table=page.blocks.find(b=>b.kind==="table");assert.ok(table && table.kind==="table");
 const annual=table.rows.find(r=>r[0]==="Annual subscription")![1];
 assert.ok(annual.includes("Starter: $970/year") && annual.includes("unconfirmed") && !/Unlimited: \$[\d,]+\/year|Agency Pro: \$[\d,]+\/year/.test(annual));
 assert.ok(table.rows.find(r=>r[0]==="CRM and accounts")![2].includes(pipelineLimitWords()));
 assert.ok(table.rows.find(r=>r[0]==="Communication channels")![2].includes("no SMS, WhatsApp"));
 assert.ok(table.rows.find(r=>r[0]==="Usage charges")![1].includes("not an all-in"));
 for(const tier of TIERS)assert.ok(table.rows.find(r=>r[0]==="Monthly subscription")![2].includes(publishedPriceWords(tier,"month")));
 assert.ok(page.blocks.some(b=>b.kind==="limits" && b.title==="Where they are ahead"));
});

test("Teachable current catalog caps and annual equivalents do not invent an invoice", () => {
 const h=COMPETITOR_PRICES.teachable;assert.ok(h.plans.every(p=>p.annualCents===null));
 assert.deepEqual(h.plans.map(p=>p.platformFeeBps),[750,0,0]);assert.equal(h.trial.days,7);
 const page=findPage("proof","teachable");assert.ok(page && page.seo?.title==="Marktmorgen vs Teachable");
 const table=page.blocks.find(b=>b.kind==="table");assert.ok(table && table.kind==="table");
 assert.ok(table.rows.find(r=>r[0]==="Product catalog")![1].includes("Starter: 5; Builder: 10; Growth: 50"));
 assert.ok(table.rows.find(r=>r[0]==="Product catalog")![2].includes(MAX_PRODUCTS.toLocaleString("en-US")));
 for(const tier of TIERS)assert.ok(table.rows.find(r=>r[0]==="Monthly subscription")![2].includes(publishedPriceWords(tier,"month")));
 assert.ok(table.rows.find(r=>r[0]==="Platform and processing fees")![1].includes("not free payment"));
});

const finalComparisonSlugs = ["substack","patreon","linktree","podia","thinkific","systeme"] as const;
test("all fifteen S1 comparisons are real indexed pages with canonical own prices and readable tradeoffs", () => {
 const slugs=["kajabi","skool","clickfunnels","circle","kit","whop","hotmart","highlevel","teachable",...finalComparisonSlugs];
 const index=findPage("proof","comparisons");assert.ok(index);
 const hrefs=index.blocks.flatMap(b=>b.kind==="features"?b.items.map(i=>i.href):[]);
 assert.deepEqual(hrefs.filter(h=>slugs.some(s=>h==="/proof/"+s)),slugs.map(s=>"/proof/"+s));
 for(const slug of finalComparisonSlugs){
  const page=findPage("proof",slug);assert.ok(page);
  assert.equal(page.seo?.title,"Marktmorgen vs "+COMPETITOR_PRICES[slug].name);
  const table=page.blocks.find(b=>b.kind==="table");assert.ok(table && table.kind==="table");
  for(const tier of TIERS){
   assert.ok(table.rows.find(r=>r[0]==="Monthly subscription")![2].includes(publishedPriceWords(tier,"month")));
   assert.ok(table.rows.find(r=>r[0]==="Annual billing")![2].includes(publishedPriceWords(tier,"year")));
  }
  assert.ok(table.rows.find(r=>r[0]==="Getting started")![2].includes("paid selling are not open yet"));
  assert.ok(page.blocks.some(b=>b.kind==="limits" && b.title==="Where they are ahead" && b.items.length>=2));
 }
});
test("uncertain quotes, legacy cohorts and conditional payment fees are not favorable zeroes", () => {
 assert.ok(COMPETITOR_PRICES.linktree.plans.every(p=>p.platformFeeBps===null));
 assert.ok(COMPETITOR_PRICES.linktree.feeScope.includes("9%") && COMPETITOR_PRICES.linktree.feeScope.includes("unconfirmed"));
 assert.ok(COMPETITOR_PRICES.patreon.feeScope.includes("August 4, 2025") && COMPETITOR_PRICES.patreon.feeScope.includes("legacy"));
 assert.ok(COMPETITOR_PRICES.podia.plans.every(p=>p.monthlyCents===null));
 assert.deepEqual(COMPETITOR_PRICES.podia.plans.map(p=>p.annualCents),[50400,100800,180000]);
 assert.equal(COMPETITOR_PRICES.substack.plans[0].usRecurringBillingBps,70);
 assert.deepEqual(COMPETITOR_PRICES.thinkific.plans.map(p=>p.externalProviderFeeBps),[500,200,100]);
 assert.ok(COMPETITOR_PRICES.thinkific.plans.every(p=>p.annualCents===null));
 assert.ok(COMPETITOR_PRICES.systeme.plans.slice(1).every(p=>p.annualCents===null && p.platformFeeBps===0));
});

test("Whop comparison does not claim a directory its cited address no longer shows", () => {
 // #4571 batch 6: read November 15, 2026, https://whop.com/discover/ is one business's page named Discover (22 members,
 // no posts) and Whop's home page links no directory; the directory read there in October is unconfirmed, not assumed.
 const w=COMPETITOR_PRICES.whop.discovery.source;
 assert.equal(w.readOn,"2026-11-15");
 assert.ok(!/directory/i.test(w.label));
 const page=findPage("proof","whop");assert.ok(page);
 const text=JSON.stringify(page);
 assert.ok(!text.includes("Whop has a public discovery directory") && !text.includes("A public Discover directory with business search"));
 assert.ok(text.includes("could not be confirmed"));
});

test("Beacons comparison says only what Beacons' help center states, its pricing page being unreadable", () => {
 // #4571 batch 6: read November 15, 2026, beacons.ai/pricing returns Cloudflare's block page. Beacons' help center
 // ("Beacons Pricing Plans", "Beacons Pro Page") lists order bumps, memberships and courses with video hosting on the
 // $30 Creator Plus plan, and none of its 174 articles mentions a 12,000-brand affiliate network.
 const page=findPage("proof","beacons");assert.ok(page);
 const text=JSON.stringify(page);
 assert.ok(!text.includes("the free one included") && !text.includes("12,000") && !text.includes("but only one"));
 assert.ok(!/read on September \d+, 2026/.test(text));
 const table=page.blocks.find(b=>b.kind==="table");assert.ok(table && table.kind==="table");
 assert.ok(table.rows.find(r=>r[0]==="Order bumps and upsells")![1].includes("$30"));
 assert.ok(table.note?.includes("was not read"));
});
