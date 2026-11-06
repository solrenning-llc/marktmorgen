import { pricingPerksMarkup, pricingTermsMarkup } from "@/lib/pricing-perks-markup";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pricing } from "@/components/home-parts";
import { COMMISSION_BPS, COMMISSION_LIVE, COMMISSION_PLANS_PUBLISHED, LEGACY_PLAN_PRICES, PLAN_PRICES, PLAN_TITLES, PRICES_WITH_COMMISSION, PRICES_WITHOUT_COMMISSION, PUBLISHED_PLAN_PRICES, TIERS, publishedPriceWords, publishedYearSaving } from "@/lib/plan";
import { feeWords, planPriceWords } from "@/lib/fee-words";
import { planOf } from "@/lib/billing";
import { shareBps } from "@/lib/platform-share";
import { PLANS_ON_SALE } from "@/lib/opening";
import { commercialMarginReady } from "@/lib/commercial-margin";
import { done, is } from "./check";
is("published names",PLAN_TITLES,{creator:"Store",pro:"Studio",scale:"Scale"});
// The owner's price decision of 18 October 2026 (11:21): one price list, no share of a sale (docs/value-presentation-2026-10-18.md).
is("published monthly cents",TIERS.map(t=>PUBLISHED_PLAN_PRICES[t].month),[6900,44900,99900]);
is("published annual cents",TIERS.map(t=>PUBLISHED_PLAN_PRICES[t].year),[69000,449000,999000]);
is("the commission variant is the same price list",PRICES_WITH_COMMISSION,PRICES_WITHOUT_COMMISSION);
is("the rates once proposed are kept, never shown",COMMISSION_BPS,{creator:625,pro:275,scale:0});
is("annual savings",TIERS.map(publishedYearSaving),[13800,89800,199800]);
for(const tier of TIERS){
 is(tier+" annual buys twelve months for ten monthly payments",PUBLISHED_PLAN_PRICES[tier].year,PUBLISHED_PLAN_PRICES[tier].month*10);
 is(tier+" annual quote names no share of a sale",planPriceWords(tier,"year"),planPriceWords(tier,"year",false));
 for(const cycle of ["month","year"] as const){
  const legacy=planOf({items:{data:[{price:{unit_amount:PRICES_WITHOUT_COMMISSION[tier][cycle],recurring:{interval:cycle}}}]}});
  is(tier+" today's "+cycle+" price carries no commission contract",[legacy.tier,legacy.cycle,legacy.shared],[tier,cycle,false]);
  for(const old of LEGACY_PLAN_PRICES){const was=planOf({items:{data:[{price:{unit_amount:old[tier][cycle],recurring:{interval:cycle}}}]}});is(tier+" a price published before 18 October at "+old[tier][cycle]+" is still read as its plan",[was.tier,was.cycle,was.shared],[tier,cycle,false]);}
  const offered=planOf({items:{data:[{price:{unit_amount:PUBLISHED_PLAN_PRICES[tier][cycle],recurring:{interval:cycle}}}]}});
  is(tier+" proposed "+cycle+" is recognized",[offered.tier,offered.cycle],[tier,cycle]);
 }
}
is("Store annual display",publishedPriceWords("creator","year"),"$690 a year");
is("Studio annual display",publishedPriceWords("pro","year"),"$4,490 a year");
is("Scale annual display",publishedPriceWords("scale","year"),"$9,990 a year");
is("the offer with a share of each sale is no longer published",COMMISSION_PLANS_PUBLISHED,false);
is("offer publication does not enable fee collection",COMMISSION_LIVE,false);
is("existing operational prices preserved",PLAN_PRICES,PRICES_WITHOUT_COMMISSION);
is("actual sales fee remains disabled",shareBps({shared:true,subscriptionActive:true,trialEnds:0,tier:"creator"}),0);
is("legacy sales never acquire a fee from publication",shareBps({shared:false,subscriptionActive:true,trialEnds:0,tier:"creator"},Date.now()/1000,true),0);
is("public fee wording says nothing is taken from a sale",feeWords().takes,feeWords(false).takes);
is("historical wording remains selectable",feeWords(false).editor,"Marktmorgen takes no cut of the sale.");
is("pricing approval is not margin certification",commercialMarginReady(),false);
is("commercial sales remain closed",PLANS_ON_SALE,false);
const html=renderToStaticMarkup(createElement(Pricing));
// Inert billing templates are not rendered/spoken terms. Keep exact visible
// counts while checking that both canonical alternatives remain available.
const templates=html.match(/<template\b[^>]*>[\s\S]*?<\/template>/g)??[];
const visibleHtml=html.replace(/<template\b[^>]*>[\s\S]*?<\/template>/g, "");
// 243 [CF6], owner's complement of 31/10/2026: the terms every plan shares are said once, under the three cards.
is("the shared terms keep both inert billing alternatives",templates.length,2);
is("one visible definition list of terms",(visibleHtml.match(/<dl\b/g)??[]).length,1);
for(const [i,cycle] of [[0,"month"],[1,"year"]] as const) is("the "+cycle+" first charge names every plan's price",TIERS.every(t=>(templates[i]??"").includes(PLAN_TITLES[t]+" $"+(PUBLISHED_PLAN_PRICES[t][cycle]/100).toLocaleString("en-US"))),true);
for(const name of ["Store","Studio","Scale"]) is(name+" appears as a plan",html.includes(">"+name+"</h3>"),true);
is("every card says 0% of sales",(html.match(/>0% of sales</g)??[]).length,3);
for(const rate of ["6.25%","2.75%"]) is(rate+" is not shown",html.includes(rate),false);
for(const price of ["$69","$449","$999"]) is(price+" is the card's monthly price",html.includes(">"+price+"<"),true);
for(const tier of TIERS) is(tier+" setup link preserves the selected plan",html.includes("plan="+tier+"&amp;billing=month"),true);
is("the cards no longer repeat that sales are not open (the page says it once, above them)",(visibleHtml.match(/not open yet|not on sale yet|Not yet\. Marktmorgen is still being built/gi)??[]).length,0);
is("no blanket zero-fee claim",html.includes("We take none of it"),false);
const hostile = pricingPerksMarkup(['<img src=x onerror="alert(1)">', "A & B's <plan>", "</span><script>bad()</script>"]);
is("plan words never create executable disclosure markup", /<img|<script|onerror="/.test(hostile), false);
is("literal HTML-looking plan words remain visible as text", hostile.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), true);
is("ampersands and apostrophes remain escaped", hostile.includes("A &amp; B&#39;s &lt;plan&gt;"), true);
is("the native disclosure keeps its summary and semantic list", [hostile.startsWith("<summary "), (hostile.match(/<li /g) ?? []).length, hostile.endsWith("</ul>")], [true, 3, true]);
const terms = pricingTermsMarkup([['<img src=x onerror="bad()">', "A & B's <terms>"], ["First charge", '$69 for the month.']]);
is("term labels and values cannot insert executable HTML", /<img|<script|onerror="/.test(terms), false);
is("term labels retain literal HTML as escaped text", terms.includes('&lt;img src=x onerror=&quot;bad()&quot;&gt;'), true);
is("term values retain punctuation and escaped markup", terms.includes("A &amp; B&#39;s &lt;terms&gt;"), true);
is("static terms retain one definition pair per row", [(terms.match(/<dt /g) ?? []).length, (terms.match(/<dd /g) ?? []).length], [2, 2]);
for (const label of ["Free trial", "First charge", "Money back", "Canceling", "Fees"]) {
 is("the " + label + " term is said once, for every plan", (visibleHtml.match(new RegExp(">" + label + "</dt>", "g")) ?? []).length, 1);
}
for(const label of ["Free trial","First charge","Money back","Canceling","Fees"]) {
 is("both inert alternatives keep the "+label+" term",templates.filter(fragment=>fragment.includes(">"+label+"</dt>")).length,2);
}
done();
