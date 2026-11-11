import { decisionQuestions, type HomeQuestion } from "@/lib/home-faq";
/** Server-rendered pricing facts. Reads existing rules; never runs billing or provider operations.
 * The future browser calculator reads plan.ts and competitor-prices.ts directly, not this server module.
 */
import { TIERS, PLAN_TITLES, PUBLISHED_PLAN_PRICES, publishedPriceWords, monthlyEmails, TRIAL_DAYS, REFUND_DAYS, type Tier } from "@/lib/plan";
import { planShareWords } from "@/lib/fee-words";
import { PLANS_ON_SALE } from "@/lib/opening";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_FILE_BYTES } from "@/lib/product-file";
import { MAX_LEADS } from "@/lib/contact-rules";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { DATA_ROOM_BYTES, dataWords } from "@/lib/store-data-rules";
import { VISITS_INCLUDED, publicVisitLimit } from "@/lib/traffic-rules";
import { ORDERS_INCLUDED, CALL_ORDER_UNITS } from "@/lib/order-rules";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { AUTOMATIC_UPLOAD_CAPS, uploadBackendOpen } from "@/lib/upload-budget-policy";
import { ALLOWANCE_KINDS, STORE_ALLOWANCES, KIND_WORDS, API_WRITE_UNITS, API_SALES_UNITS } from "@/lib/store-allowance-rules";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { ANSWERS_MONTHLY } from "@/lib/answers-rules";
import { ACTIVE_FLOWS_BY_TIER, DAILY_RUNS_BY_TIER, MAX_FLOWS, MAX_STEPS } from "@/lib/flow-limits";
import { PIPELINES_BY_TIER, MAX_CRM_FIELDS, MAX_STAGES, MAX_DEALS } from "@/lib/crm-rules";
import { TEAM_LIMITS } from "@/lib/team-scheduling-rules";
import { SHARE_LIMITS, bytesWords } from "@/lib/funnel-share-rules";
import { ASSISTANT_PRICE_CENTS, ASSISTANT_MESSAGES_MONTHLY } from "@/lib/store-assistant-rules";
import { CENTS_PER_MINUTE, MIN_CENTS, MAX_AUTO_LANGUAGES, MAX_AUTO_MINUTES, autoCaptionCents } from "@/lib/auto-captions-rules";
import { DELIVERY_ALLOWANCE_BYTES, FREE_PAUSE_ABOVE_BYTES } from "@/lib/delivery";

export type PricingRow = { key: string; label: string; values: Record<Tier,string>; note?: string };
export type PricingGroup = { id: string; title: string; period: string; rows: PricingRow[] };
const count=(n:number)=>n.toLocaleString("en-US");
const gigabytes=(n:number)=>count(n/(1024**3))+" GB";
export const pricingDollars=(cents:number)=>"$"+(cents/100).toLocaleString("en-US",{minimumFractionDigits:cents%100?2:0,maximumFractionDigits:2});
const values=(read:(tier:Tier)=>string):Record<Tier,string>=>({creator:read("creator"),pro:read("pro"),scale:read("scale")});
const row=(key:string,label:string,read:(tier:Tier)=>string,note?:string):PricingRow=>({key,label,values:values(read),...(note?{note}:{})});
export const PRICING_OPEN=PLANS_ON_SALE;
export const PRICING_PLANS=TIERS.map(tier=>({
 tier,title:PLAN_TITLES[tier],
 monthly:publishedPriceWords(tier,"month"),annual:publishedPriceWords(tier,"year"),
 monthlyCents:PUBLISHED_PLAN_PRICES[tier].month,annualCents:PUBLISHED_PLAN_PRICES[tier].year,
 share:planShareWords(tier),
 purpose:tier==="creator"?"A store for your products, memberships and community.":tier==="pro"?"The store, plus list email and AI writing with published limits.":"Studio's tools with larger usage allowances.",
}));
export const PRICING_GROUPS:PricingGroup[]=[
 {id:"selling-and-delivery",title:"Selling and delivery",period:"Monthly figures follow the studio's counter window; storage and catalog figures are held at once.",rows:[
  row("visits","Counted visits",t=>count(VISITS_INCLUDED[t]),"A counted allowance, not a promise of unique visitors. Some capacity is reserved for existing buyers."),
  row("public-visits","Public-page threshold",t=>count(publicVisitLimit(VISITS_INCLUDED[t])),"Public pages can pause before the full buyer reserve is used."),
  row("orders","Order allowance",t=>count(ORDERS_INCLUDED[t]),"A call checkout uses "+CALL_ORDER_UNITS+" order units. Existing paid buyers follow the delivery rules."),
  row("storage","File storage",t=>gigabytes(PAID_STORAGE_BYTES[t])),
  row("video","Watched lesson video",t=>count(PAID_VIDEO_HOURS[t])+" hours/month","New playback pauses at its threshold; this is separate from file downloads."),
  row("upload-opens","Default upload openings",t=>count(AUTOMATIC_UPLOAD_CAPS[t].opens)+"/UTC month"),
  row("upload-bytes","Default authorized upload volume",t=>gigabytes(AUTOMATIC_UPLOAD_CAPS[t].authorizedBytes)+"/UTC month","The studio's current policy and funding checks still determine whether an upload can start."),
  row("upload-controls","Default upload control requests",t=>count(AUTOMATIC_UPLOAD_CAPS[t].controlRequests)+"/UTC month"),
  row("data-room","Space for store records",t=>dataWords(DATA_ROOM_BYTES[t]),"Products, contacts, orders and community records share this space. Both count and byte limits apply."),
  row("catalog","Catalog products",()=>count(MAX_PRODUCTS)),
  row("single-file","Largest individual file",()=>gigabytes(MAX_FILE_BYTES),"Storage and monthly upload limits also apply."),
  row("contacts","Contact count ceiling",()=>count(MAX_LEADS),"The store-record space can fill before a count ceiling is reached."),
  row("delivery","Published file-delivery allowance",()=>gigabytes(DELIVERY_ALLOWANCE_BYTES)+"/month","This is not a hard block on paid downloads. Paid-file continuity follows the existing delivery rules; crossing it is not an automatic overage bill."),
  row("free-delivery","Free-file delivery pause threshold",()=>gigabytes(FREE_PAUSE_ABOVE_BYTES)+"/month"),
 ]},
 {id:"email-and-workflows",title:"Email, AI and workflows",period:"List-email and AI allowances are monthly. Workflow starts are counted per UTC day.",rows:[
  row("list-email","List emails",t=>count(monthlyEmails(t))+"/month","Campaigns, sequences and included announcements share the same allowance. Consent and sender-health checks still apply."),
  row("writing","AI writing jobs",t=>count(AI_MONTHLY[t])+"/month","Not included during a trial. This is separate from the optional Store assistant."),
  row("answers","Included short product answers",t=>count(ANSWERS_MONTHLY[t])+"/month"),
  row("active-workflows","Active workflows",t=>count(ACTIVE_FLOWS_BY_TIER[t])),
  row("workflow-starts","New workflow runs",t=>count(DAILY_RUNS_BY_TIER[t])+"/UTC day"),
  row("saved-workflows","Saved workflows",()=>count(MAX_FLOWS)),
  row("workflow-steps","Steps in a workflow",()=>count(MAX_STEPS)),
 ]},
 {id:"people-and-calls",title:"People, deals and team calls",period:"These are per-store ceilings. A team call is separate from a single-host booking.",rows:[
  row("pipelines","CRM pipelines",t=>count(PIPELINES_BY_TIER[t])),
  row("contact-fields","Custom contact fields",()=>count(MAX_CRM_FIELDS)),
  row("deals","Deals across pipelines",()=>count(MAX_DEALS)),
  row("stages","Stages per pipeline",()=>count(MAX_STAGES)),
  row("team-events","Team event types",t=>count(TEAM_LIMITS[t].eventTypes)),
  row("team-hosts","Hosts in a team event",t=>count(TEAM_LIMITS[t].hosts)),
 ]},
 {id:"sharing",title:"Sharing funnels and saved sections",period:"Monthly sharing figures use the UTC calendar month; active links and saved sections are held at once.",rows:[
  row("active-shares","Active funnel-share links",t=>count(SHARE_LIMITS[t].shares)),
  row("saved-sections","Saved sections",t=>count(SHARE_LIMITS[t].savedBlocks)),
  row("shares-created","New share links",t=>count(SHARE_LIMITS[t].sharesPerMonth)+"/month"),
  row("share-package","Largest shared package",t=>bytesWords(SHARE_LIMITS[t].bundleBytes)),
  row("share-imports","Imports from share links",t=>count(SHARE_LIMITS[t].importsPerMonth)+"/month"),
  row("share-previews","Share previews",t=>count(SHARE_LIMITS[t].previewsPerMonth)+"/month"),
  row("sections-applied","Saved-section applications",t=>count(SHARE_LIMITS[t].appliesPerMonth)+"/month"),
  row("share-exports","Package exports",t=>count(SHARE_LIMITS[t].exportsPerMonth)+"/month"),
 ]},
 {id:"operating-allowances",title:"Other monthly allowances",period:"These counters share the store's billing-month window, including on annual plans. A request or action can use more than one unit.",rows:
  ALLOWANCE_KINDS.map(kind=>row("operation-"+kind,KIND_WORDS[kind].what,t=>count(STORE_ALLOWANCES[t][kind]),
   kind==="api"?"Each contact added or product given through the API uses "+API_WRITE_UNITS+" units, and each page of sales read "+API_SALES_UNITS+"; key permissions and endpoint rules still apply.":undefined)),
 },
];
export const PRICING_ADDONS=[
 {key:"assistant",title:"Store assistant",price:pricingDollars(ASSISTANT_PRICE_CENTS)+" a month per store",body:count(ASSISTANT_MESSAGES_MONTHLY)+" messages a month in its own allowance. A separate subscription, with its own cancellation and refund terms. Paid availability remains closed with the plans.",href:"/refunds#store-assistant"},
 // AI captions exist only for a lesson video the video service keeps; listed only while its upload door can open (lib/upload-budget-policy.ts).
 ...(uploadBackendOpen("stream")?[{key:"captions",title:"AI captions for a lesson video",price:pricingDollars(CENTS_PER_MINUTE)+" per rounded-up minute, per requested language",body:"At least "+pricingDollars(MIN_CENTS)+" per request in total; up to "+MAX_AUTO_LANGUAGES+" languages and "+MAX_AUTO_MINUTES+" minutes of video. The quote is shown before purchase. For example, 10 minutes in two languages is "+pricingDollars(autoCaptionCents(600,2))+".",href:"/platform/courses"}]:[]),
];
export const PRICING_QUESTIONS: HomeQuestion[]=[
 ...decisionQuestions(),
 {q:"Can I buy a plan today?",a:PLANS_ON_SALE?"Check the plan's current terms and available features before subscribing.":"Paid plans and paid selling are not open yet. You can prepare a store and inspect the live demo; this page does not activate a paid checkout."},
 {q:"How do monthly and annual billing differ?",a:"Monthly billing charges the published monthly price each billing period. Annual billing is one payment of the published annual price, not twelve monthly payments. Monthly usage allowances still follow their own counter windows."},
 {q:"Does the platform share include payment processing?",a:"No. The platform share and your Stripe processing fees are separate. Your account's country, payment method and enabled Stripe services can affect what Stripe charges."},
 {q:"Can I cancel my subscription?",a:"The Terms allow cancellation at any time. Future billing periods are not charged, and access lasts through the period already paid unless a refund applies. The Refund Policy describes the studio controls and email route."},
 {q:"What are the trial and refund terms?",a:"The published trial is "+TRIAL_DAYS+" days for the first store on an account when plans open. Some trial allowances are smaller and paid AI writing is excluded. The first plan payment on an account can be refunded in full on request within "+REFUND_DAYS+" days. An annual refund later retains started months at the monthly price and Stripe's card fee. The separate Store assistant add-on has different refund terms."},
 {q:"What happens when an allowance is used?",a:"Affected new usage can pause until its counter resets or the plan changes. Other limits, consent, permissions and availability checks still apply. The file-delivery allowance is not a hard stop on already-paid downloads. There is no automatic overage charge for the listed plan allowances."},
];
