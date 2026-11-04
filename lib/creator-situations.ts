import { audienceBeginnerQuestions } from "@/lib/audience-faq";
import type { Block, TopicPage } from "@/lib/site-pages";

export const CREATOR_PHOTOS = {
 "course-creators":{id:"photo-1637979910474-38e3ad8d5cab",alt:"People working on laptops around a conference table.",author:"Joao paulo m ramos paulo",source:"https://unsplash.com/photos/a-group-of-people-sitting-around-a-table-with-laptops-mYt2I8PIPN0"},
 "community-builders":{id:"photo-1758518730037-a16581a040e8",alt:"A group discussing paperwork around a white office table.",author:"Vitaly Gariev",source:"https://unsplash.com/pt-br/fotografias/profissionais-de-negocios-em-uma-reuniao-ao-redor-de-uma-mesa-5txln04Cx7I"},
 "newsletter-writers":{id:"photo-1631611114026-8df828ba1ab2",alt:"A hand making notes with a pen in an open notebook.",author:"Pradamas Gifarry",source:"https://unsplash.com/photos/a-person-writing-on-a-notebook-with-a-pen-7KMmMCyn4sQ"},
 "consultants-and-mentors":{id:"photo-1610050731821-f58da5e8abc6",alt:"A person in a gray shirt taking notes at a wooden table.",author:"Fa Barboza",source:"https://unsplash.com/photos/person-in-gray-dress-shirt-writing-on-white-paper-Lf3S2zRXKXk"},
} as const;
export const CREATOR_PHOTO_LICENSE={url:"https://unsplash.com/license",readOn:"2026-10-20",scope:"The individual source pages identify the standard Unsplash License, not Unsplash+. Free commercial permission, not a billed API quota. Direct image-host delivery uses the existing renderer; no app-side image transformation."};
type Ladder=Extract<Block,{kind:"ladder"}>["items"];
type Features=Extract<Block,{kind:"features"}>["items"];
type Situation={
 slug:keyof typeof CREATOR_PHOTOS;eyebrow:string;title:string;highlight:string;intro:string;store:string;plan:"creator"|"pro";
 examples:{label:string;detail:string;price:string}[];ladder:Ladder;features:Features;limits:string[];related:string[];
};
const situations:Situation[]=[
 {
  slug:"course-creators",eyebrow:"For course creators",title:"Your course, with the work",highlight:"that goes around it",
  intro:"Put the course, supporting files, community and booked sessions in the same store. Describe the material and its access schedule, then let a buyer inspect the actual offer. The structure below is illustrative, not a customer story.",
  store:"Course library",plan:"creator",related:["courses","quizzes-and-certificates","community","calls"],
  examples:[{label:"A lesson preview",detail:"Optional preview you configure",price:"Your terms"},{label:"The course",detail:"Your actual lessons and access schedule",price:"Set in USD"},{label:"Supporting workbook",detail:"A separate file, if you offer one",price:"Set in USD"},{label:"A booked session",detail:"Available times and published terms",price:"Set in USD"}],
  ladder:[
   {step:"1",icon:"book",title:"Let someone inspect a lesson",price:"Your terms",body:"Use a supported preview so a visitor can inspect the format before deciding about the course.",href:"/platform/courses"},
   {step:"2",icon:"book",title:"Publish the actual course",price:"Set in USD",body:"List what is included and when lessons open. Completion and quiz requirements are the ones you configure.",href:"/platform/quizzes-and-certificates"},
   {step:"3",icon:"users",title:"Offer a place for discussion",price:"Set in USD",body:"Choose the products or membership that grant community access. A purchase is not marketing-email consent.",href:"/platform/community"},
   {step:"4",icon:"calendar",title:"Offer your available time",price:"Set in USD",body:"A learner can choose a paid call from the times and terms you publish, subject to booking checks.",href:"/platform/calls"},
  ],
  features:[
   {icon:"book",title:"Teach in an order you choose",body:"Organize lessons and drip access, with quizzes and certificates where configured. These record the learning conditions you set, not a promised learner outcome.",href:"/platform/courses"},
   {icon:"mail",title:"Follow up with permission",body:"Email and workflow sending require eligible plan allowances and consent. Compare those limits before choosing the store plan.",href:"/pricing"},
   {icon:"chart",title:"Review the recorded journey",body:"Use recorded visits, payments and course activity to decide what to review next; missing data is not a forecast.",href:"/platform/insights"},
  ],
  limits:["Storage, watched video, record space, products and workflow usage have separate limits.","This store is not presented as an equivalent of every dedicated school's student experience. Compare course tools and catalog limits before migrating.","Paid plans and paid selling remain closed; the public demo shows the buyer experience."],
 },
 {
  slug:"community-builders",eyebrow:"For community builders",title:"Membership and conversation,",highlight:"at the same address",
  intro:"Keep the membership offer and the member discussion together. Publish the access terms and recurring interval, then choose what members can open. This is an example structure, with no invented member count or customer result.",
  store:"Community hub",plan:"creator",related:["community","memberships","live-events","email"],
  examples:[{label:"An introductory resource",detail:"The file or preview you actually offer",price:"Your terms"},{label:"Community membership",detail:"Published access and renewal terms",price:"Set in USD"},{label:"A live session",detail:"Time, access conditions and replay",price:"Your terms"},{label:"Supporting material",detail:"A separate product if you choose",price:"Set in USD"}],
  ladder:[
   {step:"1",icon:"file",title:"Explain what members find inside",price:"Your terms",body:"Describe the topics, access conditions and material that exist before asking someone to join.",href:"/platform/store-page"},
   {step:"2",icon:"repeat",title:"Publish membership terms",price:"Set in USD",body:"Show the recurring interval and access it grants, with the supported cancellation controls.",href:"/platform/memberships"},
   {step:"3",icon:"chat",title:"Keep the discussion with the access",price:"Your terms",body:"Use posts, comments, chat and private messages under the community's membership and permission rules.",href:"/platform/community"},
   {step:"4",icon:"video",title:"Add a session members can return to",price:"Your terms",body:"Publish the event's time, RSVP information and replay using the supported event tools and provider connections.",href:"/platform/live-events"},
  ],
  features:[
   {icon:"users",title:"One place for the member's next visit",body:"A member can return to the posts and material their access permits. A membership count does not predict participation or retention.",href:"/platform/community"},
   {icon:"repeat",title:"Keep access and renewal terms visible",body:"Use the recurring intervals the product supports, rather than promising an unsupported membership contract.",href:"/platform/memberships"},
   {icon:"mail",title:"Send only within the actual permission",body:"List email and workflows have plan allowances. Joining a paid product is not by itself permission to receive marketing.",href:"/platform/email"},
  ],
  limits:["Native live rooms, discovery networks and media-chat depth differ across community platforms; do not assume identical scope.","Record space, notifications, event providers and email allowances still apply.","Paid plans and paid selling remain closed; inspect the live demo and the sourced community comparisons before deciding."],
 },
 {
  slug:"newsletter-writers",eyebrow:"For newsletter writers",title:"Your writing, your products,",highlight:"and the people who opted in",
  intro:"Use the list-email tools alongside a creator's store, with published sending limits and explicit consent. A product purchase and a newsletter subscription are different choices. This example does not claim a dedicated publication platform's paywall or reader network.",
  store:"Newsletter desk",plan:"pro",related:["email","email-platforms","memberships","store-page"],
  examples:[{label:"An email sign-up",detail:"Explicit permission and confirmation rules",price:"Opt-in"},{label:"A digital guide",detail:"The file and terms you publish",price:"Set in USD"},{label:"A course or workshop",detail:"Separate product access",price:"Set in USD"},{label:"Community access",detail:"A membership, not an assumed publication paywall",price:"Set in USD"}],
  ladder:[
   {step:"1",icon:"mail",title:"Ask for permission to write",price:"Opt-in",body:"Use the supported sign-up and confirmation path. An address on a purchase is not automatic newsletter consent.",href:"/platform/email"},
   {step:"2",icon:"file",title:"Offer a product from your work",price:"Set in USD",body:"Describe the guide or other file actually delivered, at its published price and terms.",href:"/platform/store-page"},
   {step:"3",icon:"book",title:"Separate the deeper material",price:"Set in USD",body:"A course or workshop has its own product and access conditions, rather than an invented promise about what a reader will achieve.",href:"/platform/courses"},
   {step:"4",icon:"users",title:"Choose membership access deliberately",price:"Set in USD",body:"Use membership and community access for the content they support; do not assume an equivalent paid-publication paywall.",href:"/platform/memberships"},
  ],
  features:[
   {icon:"mail",title:"Campaigns, templates and workflows",body:"Prepare the emails and conditions your eligible plan supports. Sending still needs consent, a healthy sender and available allowance.",href:"/platform/email"},
   {icon:"list",title:"Choose the email tool you need",body:"Use supported connections to an existing email platform, with its own account and charges, or inspect the included plan's list-email tools.",href:"/platform/email-platforms"},
   {icon:"scale",title:"Compare the actual scope and bill",body:"Read the sourced Substack and Kit comparisons alongside the plan's email, AI and workflow limits. A store subscription is not a promise of equivalent publishing or discovery.",href:"/proof/comparisons"},
  ],
  limits:["List email is not included on every plan; compare the canonical prices and allowances before choosing.","Paid-publication paywalls, reader ecosystems and sponsorship tools are not claimed as equivalents here.","Paid plans and paid selling remain closed. The example is a product structure, not a customer or an income claim."],
 },
 {
  slug:"consultants-and-mentors",eyebrow:"For consultants and mentors",title:"The conversation, the scope,",highlight:"and the agreed work",
  intro:"Keep booked calls, contact facts, form answers, agreements and payment requests in the studio tools that support them. State the work and payment terms before a client chooses to sign or pay. No client, result or testimonial is attributed to this example.",
  store:"Mentoring studio",plan:"creator",related:["calls","calendar-sync","crm","checkout"],
  examples:[{label:"A preparation resource",detail:"The file or questions you choose",price:"Your terms"},{label:"A booked call",detail:"Availability, time zone and booking terms",price:"Set in USD"},{label:"An agreed project",detail:"Scope and payment terms you review",price:"Set in USD"},{label:"Continuing access",detail:"Only the supported recurring terms you publish",price:"Set in USD"}],
  ladder:[
   {step:"1",icon:"list",title:"Collect the relevant questions",price:"Your terms",body:"Use the existing form and contact tools for the facts you need, within permissions and record limits.",href:"/studio/forms"},
   {step:"2",icon:"calendar",title:"Offer a bookable conversation",price:"Set in USD",body:"Publish available times and the paid call's actual terms. Calendar and meeting-provider conditions still apply.",href:"/platform/calls"},
   {step:"3",icon:"scroll",title:"Record the agreed scope",price:"Your terms",body:"Use the agreement tool to show the text version and record its signature. It does not promise a legal result in every situation.",href:"/studio/agreements"},
   {step:"4",icon:"receipt",title:"Ask for the agreed payment",price:"Set in USD",body:"A payment request can show line items and a due date; the client opens Stripe to pay. A due date is not an automatic debit.",href:"/studio/requests"},
  ],
  features:[
   {icon:"users",title:"People and deals without a forecast",body:"Keep the contact fields and recorded deal stages together. Entered deal values are not predicted revenue.",href:"/platform/crm"},
   {icon:"card",title:"Supported payment terms",body:"Use the recurring or installment terms that checkout supports, or a custom payment request for agreed work. These are Stripe payment flows, not a claim about local bank financing.",href:"/platform/checkout"},
   {icon:"clock",title:"Bounded request reminders",body:"Optional payment-request reminders follow the creator's configuration and existing send limits. They stop when the request is paid, withdrawn or expired; sending permissions still apply.",href:"/studio/requests"},
  ],
  limits:["Studio forms, agreements and payment requests require sign-in and their existing permissions and allowances.","A recorded signature is not a guarantee of legal enforceability, and a due date does not authorize an automatic charge.","No SMS, WhatsApp or phone-call sending is included in this description. Paid plans and paid selling remain closed."],
 },
];
export const NEW_CREATOR_PAGES:TopicPage[]=situations.map((situation):TopicPage=>({
 slug:situation.slug,section:"for",eyebrow:situation.eyebrow,title:situation.title,highlight:situation.highlight,intro:situation.intro,
 seo:{title:situation.eyebrow+" — Marktmorgen",description:situation.intro},
 badge:{label:"An illustrative product path",tone:"proof"},accent:"from-violet-brand to-sky-brand",plan:situation.plan,
 photo:{id:CREATOR_PHOTOS[situation.slug].id,alt:CREATOR_PHOTOS[situation.slug].alt},related:situation.related,
 blocks:[
  {kind:"storecard",title:"One possible product structure",creator:situation.store,tagline:"Illustrative products — choose your own actual terms.",alt:"",example:"An illustrative product structure, not a customer or a live store. You choose the products and publish their actual prices in USD.",items:situation.examples},
  {kind:"ladder",title:"A path you can prepare",intro:"Each step uses an existing product or studio tool. The order is an example, not a required package or a prediction of purchases.",items:situation.ladder},
  {kind:"features",title:"Tools for this kind of work",items:situation.features},
  {kind:"limits",title:"Read the boundaries before choosing",items:situation.limits},
  // 534 [FQ1], unit 40: what someone starting out asks, answered by the code (lib/audience-faq.ts).
  {kind:"faq",title:"Questions about starting",items:audienceBeginnerQuestions()},
 ],
}));
