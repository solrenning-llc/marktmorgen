/** Static, sourced final S1 comparisons. No network, account or provider operations. */
import type { Block, TopicPage } from "@/lib/site-pages";
import { COMPETITOR_PRICES, type CompetitorPlanPrice, type OfficialPriceSource } from "@/lib/competitor-prices";
import { TIERS, PLAN_TITLES, publishedPriceWords, commissionBps, monthlyEmails } from "@/lib/plan";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { PLANS_ON_SALE } from "@/lib/opening";

type Key = "substack" | "patreon" | "linktree" | "podia" | "thinkific" | "systeme";
type FeatureLinks = Extract<Block, { kind: "features" }>["items"];
type Detail = {
  key: Key; intro: string; lead: string;
  rows: [string, string, string][]; ahead: string[];
  tools: FeatureLinks; sources: OfficialPriceSource[];
  starting: string;
};
function quotedPrices(plans: readonly CompetitorPlanPrice[], interval: "month" | "year"): string {
  return plans.map(p => {
    const cents=interval==="month"?p.monthlyCents:p.annualCents;
    if(cents!==null)return p.name+": $"+(cents/100).toLocaleString("en-US")+"/"+interval;
    if(interval==="year" && p.annualEquivalentMonthlyCents!==undefined)
      return p.name+": $"+p.annualEquivalentMonthlyCents/100+"/month equivalent under annual billing; exact annual invoice unverified";
    return p.name+": "+interval+" purchase quote unverified";
  }).join("; ");
}
/**
 * The date a page may claim its sources were read: the oldest read among every dated source of that competitor and
 * of the page (#4571, batch 6). The six pages used one shared date; a competitor whose pages sit behind a check we do
 * not pass (Substack, Patreon, Thinkific) keeps its own true date instead of holding the others back or being
 * dated as re-read when it was not.
 */
function oldestRead(competitor: unknown, extra: readonly OfficialPriceSource[]): string {
  const dates: string[] = extra.map(s=>s.readOn);
  const walk=(v: unknown): void => {
    if(Array.isArray(v)){v.forEach(walk);return;}
    if(v && typeof v==="object"){
      const o=v as Record<string, unknown>;
      if(typeof o.readOn==="string")dates.push(o.readOn);
      Object.values(o).forEach(walk);
    }
  };
  walk(competitor);
  const oldest=[...dates].sort()[0];
  if(!oldest||!/^\d{4}-\d{2}-\d{2}$/.test(oldest))throw new Error("A final comparison page has no dated source");
  return new Date(oldest+"T00:00:00Z").toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric",timeZone:"UTC"});
}
function page(d: Detail): TopicPage {
  const competitor=COMPETITOR_PRICES[d.key];
  const read=oldestRead(competitor,d.sources);
  return {
    slug:d.key,section:"proof",eyebrow:"A sourced comparison",
    title:"Marktmorgen vs",highlight:competitor.name,
    intro:d.intro,
    seo:{title:"Marktmorgen vs "+competitor.name,description:"A "+competitor.name+" alternative where products and a creator's store share one studio. Compare sourced prices, practical limits and tradeoffs. Marktmorgen paid plans remain closed."},
    badge:{label:"Sources read "+read,tone:"proof"},accent:"#6d4aff",
    blocks:[
      {kind:"lead",text:d.lead},
      {kind:"table",title:"Subscriptions, fees and practical scope",head:["Compare",competitor.name,"Marktmorgen"],
       note:"USD. Sources read "+read+". Unknown quotes are not zero. Annual-billing equivalents are not monthly purchase options or verified annual invoices. Processing, optional services and applicable taxes may add costs.",
       rows:[
        ["Monthly subscription",quotedPrices(competitor.plans,"month"),TIERS.map(t=>PLAN_TITLES[t]+": "+publishedPriceWords(t,"month")).join("; ")],
        ["Annual billing",quotedPrices(competitor.plans,"year"),TIERS.map(t=>PLAN_TITLES[t]+": "+publishedPriceWords(t,"year")).join("; ")],
        ["Platform and payment fees",competitor.feeScope,TIERS.map(t=>PLAN_TITLES[t]+": "+commissionBps(t)/100+"% of each sale").join("; ")+". Your Stripe processing fees are separate."],
        ...d.rows,
        ["Getting started",d.starting,PLANS_ON_SALE?"Check the current plan terms before starting.":"Store setup is available. Paid plans and paid selling are not open yet."],
       ]},
      {kind:"features",title:"Inspect the existing tools",items:d.tools},
      {kind:"limits",title:"Where they are ahead",items:d.ahead},
      {kind:"features",title:"Official sources and scope",intro:"Read "+read+". No traffic, earnings, cost savings, worldwide tax exemption or net-margin result is promised.",
       items:[...d.sources.map(s=>({icon:"info" as const,title:s.label,body:"Read the provider's current terms and the scope of the quoted features and charges.",href:s.url})),
       {icon:"scale",title:"All published comparisons",body:"Read other comparisons and their own dated sources.",href:"/proof/comparisons"}]},
    ],
  };
}
const emailWords=TIERS.map(t=>PLAN_TITLES[t]+": "+monthlyEmails(t).toLocaleString("en-US")+" list emails/month").join("; ");
const catalogWords=MAX_PRODUCTS.toLocaleString("en-US")+" catalog products, within the separate upload, storage and delivery limits.";
export const FINAL_COMPARISON_PAGES: TopicPage[] = [
 page({
  key:"substack",
  intro:"A Substack alternative where opt-in email sits beside products in a creator's store. Compare a publication's reader network with the delivery model you actually need.",
  lead:"Both products use Stripe; that alone is not a reason to switch. Substack centers on publications and its reader network. Marktmorgen combines store products, memberships and opt-in email, without promising the same publication paywall or distribution.",
  rows:[
   ["Email model","Posts delivered to publication subscribers and its reader experience.",emailWords+". Existing templates and sequences require consent."],
   ["Reader discovery","A reader app with Notes, recommendations and a discovery feed.","Store addresses, sharing links and selected sent emails published on the store. No comparable cross-publication feed is offered here."],
  ],
  ahead:["Substack has a reader app, Notes and cross-publication discovery. Marktmorgen has no comparable feed or app-store listing.","Substack has no publishing subscription fee. Marktmorgen has subscriptions and bounded list-email sends.","Substack accepts paid subscriptions today. Marktmorgen's paid plans remain closed."],
  tools:[{icon:"mail",title:"Email and published letters",body:"Inspect consent, send limits and optional publication of sent emails.",href:"/platform/email"},{icon:"repeat",title:"Store memberships",body:"Inspect product-access rules before assuming an identical publication subscription.",href:"/platform/memberships"}],
  sources:[COMPETITOR_PRICES.substack.plans[0].source,COMPETITOR_PRICES.substack.discovery.source],
  starting:"Publishing has no fixed subscription fee; paid subscriptions incur the quoted share and processor charges.",
 }),
 page({
  key:"patreon",
  intro:"A Patreon alternative where memberships sit beside courses and other products in a creator's store. Compare the fan experience and applicable creator fee before moving.",
  lead:"A creator with a legacy Patreon page may have a different fee from a new creator. Check that account's actual plan before comparing costs. Membership access does not make two platforms' audience and media tools identical.",
  rows:[
   ["Pricing cohort","Standard pricing applies to newly published pages after August 4, 2025; continuously published legacy pages can retain different rates.","The published store subscription and visible limits apply. A former platform's legacy rate is not transferred."],
   ["Media and community","Native video and livestreaming, fan chats and creator discovery.","Existing product videos, communities and events using supported meeting providers. No Patreon-style reader network or native livestreaming is promised here."],
  ],
  ahead:["Patreon offers native livestreaming and creator discovery within its fan platform. Marktmorgen uses supported external meeting providers and does not promise that network.","Patreon has no fixed creator subscription fee; its paid share and other charges still apply.","Patreon accepts paid memberships today. Marktmorgen's paid plans remain closed."],
  tools:[{icon:"repeat",title:"Memberships and access",body:"Inspect the actual recurring-product and member-access rules.",href:"/platform/memberships"},{icon:"store",title:"Community in a store",body:"Read the existing conversation, event and moderation limits.",href:"/platform/community"}],
  sources:[COMPETITOR_PRICES.patreon.plans[0].source,COMPETITOR_PRICES.patreon.plans[0].feeSource],
  starting:"Publishing can start without a fixed subscription fee; earning through the platform incurs the applicable plan and payment charges.",
 }),
 page({
  key:"linktree",
  intro:"A Linktree alternative where a creator's links sit beside products and delivery tools. Compare a link-in-bio page with the kind of store and customer access you need.",
  lead:"Linktree's current pricing and another feature page disagree on Pro's digital-product fee. This comparison keeps that rate unconfirmed. A lower subscription headline cannot settle an uncertain selling fee or country eligibility.",
  rows:[
   ["Selling eligibility",COMPETITOR_PRICES.linktree.annualScope,"Store products have their own checkout and delivery rules; paid selling remains closed."],
   ["Link and social tools","A free basic link page; Premium lists social scheduling and Instagram auto-replies.","Links alongside products in a store. A share caption draft is not a promise of those social-channel automations."],
  ],
  ahead:["Linktree offers a free basic link-in-bio page for people who chiefly need outbound links.","Linktree Premium lists social scheduling and Instagram auto-replies. Choose by those documented channels rather than assuming a store provides the same service.","Eligible Linktree accounts can sell today. Marktmorgen's paid plans remain closed."],
  tools:[{icon:"store",title:"The store and its links",body:"Inspect actual store blocks and delivery before replacing a link page.",href:"/demo"}],
  sources:[COMPETITOR_PRICES.linktree.plans[0].source,COMPETITOR_PRICES.linktree.plans[0].feeSource,COMPETITOR_PRICES.linktree.eligibility.source,COMPETITOR_PRICES.linktree.conflictingDisplay.source],
  starting:"A free link page is available. Pro and Premium advertise a seven-day trial; selling depends on country and account eligibility.",
 }),
 page({
  key:"podia",
  intro:"A Podia alternative where a creator's products and direct Stripe charges share one store. Compare catalog limits, migration help and the actual subscription invoice.",
  lead:"Both products combine several creator tools. That does not make consolidation or a zero platform share unique to Marktmorgen. Compare the catalog, email allowance and help you need for the move.",
  rows:[
   ["Product catalog","Mover: 50; Shaker: 150; Earthquaker: unlimited products.",catalogWords],
   ["Email allowance","Included subscriber counts: 100 on Mover, 500 on Shaker and 1,000 on Earthquaker.",emailWords+". Subscribers and monthly sends are different measures."],
   ["Migration help","Migration help is listed among the included services.","Self-service supported imports with explicit refusal rules; no concierge service is promised."],
  ],
  ahead:["Podia includes migration help. Marktmorgen's importer is self-service and does not promise concierge onboarding.","Podia Earthquaker has no product-count cap. Marktmorgen has a catalog cap plus separate storage and delivery limits.","Podia sells paid plans today. Marktmorgen's paid plans remain closed."],
  tools:[{icon:"download",title:"Supported imports",body:"Inspect contacts, products and past-buyer imports and their refusal rules.",href:"/platform/switching-to-marktmorgen"},{icon:"mail",title:"Email and its limits",body:"Read the existing email templates, workflows and consent rules.",href:"/platform/email"}],
  sources:[COMPETITOR_PRICES.podia.plans[0].source],
  starting:"A 14-day trial is advertised. Exact annual charges are quoted here; monthly purchase quotes remain unverified.",
 }),
 page({
  key:"thinkific",
  intro:"A Thinkific alternative where courses sit beside other products in a creator's store. Compare school limits, payment choices and the student experience.",
  lead:"Thinkific is focused on learning businesses. Marktmorgen already has courses, quizzes and certificates, but that does not make every school feature or payment arrangement identical.",
  rows:[
   ["Course and download counts","Basic has unlimited published courses but 5 digital downloads; Start and Grow have unlimited downloads.",catalogWords+" A course and a download are different product types."],
   ["Student experience","Branded iOS and Android offering advertised at $199/month extra, included on select Plus contracts.","Browser-based course access; Marktmorgen has no app-store listing."],
  ],
  ahead:["Thinkific has no published-course count cap on its quoted plans. Marktmorgen's products share its catalog cap.","Thinkific offers branded iOS and Android access as an add-on or on select Plus contracts. Marktmorgen has no app-store listing.","Thinkific accepts paid course sales today. Marktmorgen's paid plans remain closed."],
  tools:[{icon:"book",title:"Existing course features",body:"Read lesson, quiz, certificate and delivery limits before moving a school.",href:"/platform/courses"}],
  sources:[COMPETITOR_PRICES.thinkific.plans[0].source,COMPETITOR_PRICES.thinkific.plans[0].feeSource],
  starting:"A 30-day trial is advertised. Annual displays are monthly equivalents; an exact annual invoice is not inferred from them.",
 }),
 page({
  key:"systeme",
  intro:"A Systeme.io alternative where a creator's store and product delivery share one studio. Compare email allowance, funnels and course limits before choosing.",
  lead:"Systeme.io also combines funnels, email and courses and advertises no platform transaction fee. Neither consolidation nor a zero platform share alone distinguishes Marktmorgen. Inspect the limits and the work you need to do.",
  rows:[
   ["Free plan and paid limits","Free: 2,000 contacts, 3 funnels and 1 course. Paid tiers increase those caps.","Published plan and per-feature limits apply; paid plans remain closed."],
   ["Email allowance","Unlimited email sends are advertised on all plans.",emailWords],
   ["Webinar scope","Webinar plan includes evergreen webinars.","The linked call product describes scheduled sessions using supported meeting providers; do not assume identical evergreen presentation automation."],
  ],
  ahead:["Systeme.io has a non-expiring free plan with published funnel, course and contact caps.","Systeme.io advertises unlimited email sends. Marktmorgen's monthly list-email sends are bounded by plan.","Systeme.io's Webinar offer includes evergreen webinars; compare that format with the scheduled calls described by Marktmorgen.","Systeme.io sells paid plans today. Marktmorgen's paid plans remain closed."],
  tools:[{icon:"layout",title:"Store pages and funnels",body:"Inspect actual blocks, experiments and limits.",href:"/platform/sales-pages"},{icon:"calendar",title:"Scheduled calls",body:"Read the actual meeting and booking scope.",href:"/platform/calls"}],
  sources:[COMPETITOR_PRICES.systeme.plans[0].source],
  starting:"The free plan does not expire. Paid monthly quotes are shown; exact annual charges remain unverified.",
 }),
];
