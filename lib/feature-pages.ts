import { PAGE_TEST_WORDS } from "@/lib/headline-test-words";
import { funnelBeginnerQuestions } from "@/lib/funnel-faq";
import { courseBeginnerQuestions } from "@/lib/course-faq";
import { membershipBeginnerQuestions } from "@/lib/membership-faq";
import { callBeginnerQuestions } from "@/lib/call-faq";
import { storeBeginnerQuestions } from "@/lib/store-page-faq";
import { deliveryBeginnerQuestions } from "@/lib/delivery-faq";
import { checkoutBeginnerQuestions } from "@/lib/checkout-faq";
import { stripeBeginnerQuestions } from "@/lib/your-stripe-faq";
import { salesPageBeginnerQuestions } from "@/lib/sales-page-faq";
import { optionsBeginnerQuestions } from "@/lib/price-options-faq";
import { bundleBeginnerQuestions } from "@/lib/bundle-faq";
import { keyBeginnerQuestions } from "@/lib/license-key-faq";
import { quizBeginnerQuestions } from "@/lib/quiz-faq";
import { stampBeginnerQuestions } from "@/lib/pdf-stamp-faq";
import { calendarBeginnerQuestions } from "@/lib/calendar-faq";
import { webhookBeginnerQuestions } from "@/lib/webhook-faq";
import { discordBeginnerQuestions } from "@/lib/discord-faq";
import { affiliateBeginnerQuestions } from "@/lib/affiliate-faq";
import { phoneBeginnerQuestions } from "@/lib/phone-faq";
import { MAX_DEVICES } from "@/lib/phone-alerts-rules";
import { teamBeginnerQuestions } from "@/lib/team-faq";
import { securityBeginnerQuestions } from "@/lib/security-faq";
import { domainBeginnerQuestions } from "@/lib/domain-faq";
import { insightsBeginnerQuestions } from "@/lib/insights-faq";
import { reviewsBeginnerQuestions } from "@/lib/reviews-faq";
import { INVITE_DAYS } from "@/lib/team-roles";
import { MAX_COOKIE_DAYS } from "@/lib/affiliate-setting";
import { NEW_CREATOR_PAGES } from "@/lib/creator-situations";
import { withFeatureMechanisms } from "@/lib/feature-mechanisms";
import { paidVideoWords, TRIAL_VIDEO_SECONDS } from "@/lib/video-admission-rules";
import { BUYER_RESERVE_BPS, SETUP_VISITS, VISITS_INCLUDED, countWords, publicVisitLimit } from "@/lib/traffic-rules";
import { hoursWords } from "@/lib/watch-rules";
import { SETUP_VIDEO_SECONDS } from "@/lib/plan-standing";
import {answerAllowanceWords} from "@/lib/answers-rules";
import { ASSISTANT_NAME, assistantAllowanceWords, assistantPriceWords } from "@/lib/store-assistant-rules";
import { ASSIST_REMINDER_WORDS } from "@/lib/buyer-words/assistant-reminder";
// The feature pages and the pages for each kind of creator.
//
// Every sentence here describes something a creator can open and use today,
// or says plainly that it cannot be done. When a feature changes, its page
// changes the same day: the help centre and these pages are read against the
// code, not against a plan.
import { CENTS_PER_MINUTE, GIVE_UP_HOURS, MAX_AUTO_MINUTES, dollars } from "@/lib/auto-captions-rules";
import { isDomainsConfigured } from "@/lib/domains";
import { PUBLISHED_PLAN_PRICES as PLAN_PRICES, PRO_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS, TRIAL_MONTHLY_EMAILS } from "@/lib/plan";
import { AI_PLANS_WORDS, aiAllowanceWords } from "@/lib/ai-rules";
import { SHARE_LIMITS, bytesWords } from "@/lib/funnel-share-rules";
import { MAX_SECTION_BLOCKS } from "@/lib/saved-blocks";
import { SAMPLE_VIEWS } from "@/lib/funnel-diagnosis";
import { healthRuleWords, rampRuleWords } from "@/lib/mail-health-rules";
import { workflowLimitWords } from "@/lib/flow-limits";
import { pipelineLimitWords, PIPELINES_BY_TIER, MAX_CRM_FIELDS, MAX_STAGES, MAX_DEALS } from "@/lib/crm-rules";
import { DATA_ROOM_BYTES, dataWords } from "@/lib/store-data-rules";
import { EXPECTATION, OPEN_COUNTRIES_WORDS, PITCHES_PER_DAY, REPITCH_DAYS } from "@/lib/outreach-rules";
import type { TopicPage } from "@/lib/site-pages";
import { PLAN_AT, feeWords } from "@/lib/fee-words";
import { paypalAtCheckout, paypalConnectionWords } from "@/lib/public-explanations";
import { TEAM_LIMITS, teamLimitWords } from "@/lib/team-scheduling-rules";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { COMMUNITY_PICTURES } from "@/lib/community-picture-rules";
import { TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { storageWords } from "@/lib/storage-quota";
import { MAX_AUTO_REMINDERS, MAX_LINES, OPEN_DAYS, REQUEST_LIMITS } from "@/lib/payment-request-rules";
import { MAX_VERSIONS as AGREEMENT_VERSIONS, SIGN_DAYS } from "@/lib/agreement-rules";
import { PLAN_TITLES, TIERS } from "@/lib/plan";

/** Whether stores can be put on their own domain on this deployment. */
const DOMAINS = isDomainsConfigured();
/** What Studio and the trial send in a month, as the pages say it: read from the limit the code enforces, never typed. */
const PRO_EMAILS = PRO_MONTHLY_EMAILS.toLocaleString("en-US");
const TRIAL_EMAILS = TRIAL_MONTHLY_EMAILS.toLocaleString("en-US");

const WORKING = { label: "Working today", tone: "live" as const };

/* ------------------------------------------------------------ features ---- */

const BASE_FEATURE_PAGES: TopicPage[] = [
  {
    slug: "crm",
    section: "platform",
    eyebrow: "The people behind your store",
    title: "People, deals",
    highlight: "and pipelines",
    intro: "Keep contact facts, deal stages and the next conversation in the same studio as your products. Deal values are what your team records, not a forecast or a promise of revenue.",
    seo: { title: "People, deals and pipelines — Marktmorgen CRM", description: "Custom contact fields, deal stages and separate pipelines for a creator's store, with published limits and opt-in email workflows. Paid selling remains closed." },
    badge: WORKING,
    accent: "from-violet-brand to-pink-brand",
    plan: "creator",
    group: "grow",
    menu: { label: "People, deals and pipelines", description: "Contact fields and recorded deals, in pipelines you name.", icon: "users" },
    related: ["email", "insights", "calls", "funnels"],
    blocks: [
      { kind: "lead", text: "A contact and an opportunity are different records. Keep the facts someone gave you on their contact, then use a deal for a conversation about a sale outside checkout. Only your team sees these records. Paid plan availability and your store's limits still apply." },
      { kind: "how", title: "From a person to a recorded next step", items: [
        { title: "Keep the facts you need", body: "Add custom contact fields for the details your work uses, such as a company, date or product of interest. Their export includes those fields as columns; import and record-space rules still apply." },
        { title: "Give each kind of work its own pipeline", body: "Name stages for coaching, partnerships or another process. Move a deal as the conversation changes; mark it open, won or lost. Removing a stage or pipeline asks where its deals should go." },
        { title: "Connect a stage to a workflow", body: "A team member moving a deal for someone on your list into the stage you selected can start a configured workflow. Email consent, permissions, active-workflow and daily-run limits still apply; moving a card is not permission to send marketing." },
      ] },
      { kind: "table", title: "Published CRM ceilings", head: ["Plan", "Pipelines", "Other per-store ceilings"], note: "Held at once, not monthly quotas. Contacts, products, orders and community share record space; a byte limit can be reached before a count ceiling.", rows: TIERS.map((tier): [string,string,string] => [
        PLAN_TITLES[tier], String(PIPELINES_BY_TIER[tier]),
        MAX_CRM_FIELDS + " custom contact fields; " + MAX_DEALS.toLocaleString("en-US") + " deals; " + MAX_STAGES + " stages per pipeline; " + dataWords(DATA_ROOM_BYTES[tier]) + " shared record space.",
      ]) },
      { kind: "features", title: "Use the recorded facts", items: [
        { icon: "list", title: "Separate recorded value from a forecast", body: "Each pipeline adds up open, won and lost values from the deals your team entered. A total does not predict what a contact will buy." },
        { icon: "mail", title: "Follow up with permission", body: "Use the existing email and workflow tools within their plan allowances. Email is separate from SMS, WhatsApp and phone-call sending; those channels are not included here.", href: "/platform/email" },
        { icon: "chart", title: "Review what the store recorded", body: "Read visits, paid records and sources in Numbers alongside the work your team recorded in CRM. Missing attribution is not proof of a channel's performance.", href: "/platform/insights" },
      ] },
      { kind: "features", title: "Choose the scope you need", items: [
        { icon: "scale", title: "Compare with HighLevel", body: "HighLevel's agency accounts, phone and SMS tools and SaaS resale have different scope and usage costs. CRM records in a creator's store are not an equivalent phone system or agency platform.", href: "/proof/highlevel" },
        { icon: "list", title: "Read all the plan allowances", body: "Record space, contacts, email sends and workflow starts have their own limits. Stripe processing and optional add-ons are separate.", href: "/pricing" },
      ] },
    ],
  },

  {
    slug: "store-page",
    section: "platform",
    eyebrow: "Store page",
    title: "A store page that looks like",
    highlight: "you, not like a template",
    intro:
      "One address with your name, your photo, a line about you, your links and everything you sell. Built to be read on a phone in a few seconds, because that is where your buyer opens it.",
    badge: WORKING,
    accent: "from-violet-brand to-sky-brand",
    visual: "store",
    plan: "creator",
    group: "sell",
    menu: { label: "Store page", description: "Your photo, your links and everything you sell, at one address.", icon: "store" },
    related: ["sales-pages", "price-options", "reviews", "domain"],
    blocks: [
      {
        kind: "how",
        title: "Live in three steps",
        items: [
          { title: "Take your address", body: "marktmorgen.com/@yourname is yours the moment you take it, and the page is up right away." },
          { title: "Put up what you sell", body: "Its name, what is inside, the price and a picture. Files, courses, memberships, calls and live sessions, bundles of your products, free things for an email, and plain links. A community for your buyers sits beside them. On " + AI_PLANS_WORDS + ", AI can draft it from two sentences about what you make — the line under your name, your first products and your questions — and you keep what you like." },
          { title: "Make it look like you", body: "Your photo, one of four themes, one of ten colors or your own, one of five pairings of letters — Modern, Editorial, Elegant, Friendly or Bold — each downloaded only by the pages that use it, and a background behind the cards: plain, a glow of your color, dots, a grid or a slow aurora. The studio shows the page before you save." },
        ],
      },
      {
        kind: "features",
        title: "What the page carries",
        items: [
          { icon: "user", title: "You, at the top", body: "Your photo, your name and a line about you, on every theme — not locked behind one — and if you like, a welcome video from YouTube, Vimeo or Loom under them, loaded only when a visitor presses play. Stuck on the line? On " + AI_PLANS_WORDS + ", AI writes three from what you sell, in your store's language, and you pick one or none; sharing the store, it drafts a post for X, an Instagram caption and a LinkedIn post about it too, each with your store's tagged link." },
          { icon: "file", title: "Up to 2,000 products", body: "Each with its price, what the buyer gets and the button that buys it, in the order you choose, and up to 100 links beside them. A long store shows 24 products a page and a search box above them that finds a product by any words of its name or its one-line summary, accents or not; your studio finds any product by name too." },
          { icon: "notebook", title: "A blog on your address", body: "Posts at your store's address, /blog, written in the studio as plain text with headings and lists, each with its own address and title for search engines, and able to end on one of your products. Drafts stay in the studio; the blog has an RSS feed; on " + AI_PLANS_WORDS + ", AI can draft a post from a few words. Your store page links to it once a post is published." },
          { icon: "layout", title: "Pages of your own", body: "Up to 10 pages beside your products — About, Start here, Work with me, Questions, or any page you name — each built from the same blocks as a sales page: a headline, text, pictures, a video, steps, questions, your products and a button to your store or to one product. Each lives at your store's address and on your own domain, and can sit in a menu at the top of your store. Start one from a ready set of blocks, or from nothing." },
          { icon: "list", title: "Sections, and a line of news", body: "Cut a long store into up to 20 sections with a heading over each: a section starts at the product you pick, and moving that product moves its heading. Across the top, one line of your own news of up to 120 characters, which can lead to one of your products." },
          { icon: "layout", title: "Collections, each with its own page", body: "Group products under a name of your own, like \u201cBeginner guides\u201d: up to 12 collections of up to 24 products each, and a product can be in more than one. Each gets its own page at /@you/shop/<name> to link to from a bio, an email or an ad, and a link above your products on your store page. On it, the products that can go in a cart can be added together, up to four at a time." },
          { icon: "plus", title: "Goes well with", body: "On each product, pick up to three of your other products that go with it. Its page shows them under \u201cGoes well with\u201d, said as your pick, with Add to cart where they can go in one, and the open cart offers them while that product is in it. Nothing about it claims anything about other buyers." },
          { icon: "camera", title: "A picture on each product", body: "Shown three ways, product by product: small beside the title, beside the title and the summary, or across the top of the card." },
          { icon: "sparkle", title: "A cover made in one click", body: "No picture yet? Make a cover in the studio from the product's title, a short line saying what it is (in your store's language) and a line under it, in your store's color and letters. Six designs, each word drawn with enough contrast to read whatever your color. On Stan, by its help center read on October 11, 2026, you select an image of your own, 400 by 400." },
          { icon: "window", title: "Sell from your own website", body: "Copy a card or a button for any product and paste it into your blog or site. The card shows the picture, the price and its buyers' rating, changes when you change the product, and opens Stripe's checkout in a new tab. Sales from it are listed under the name you give the place." },
          { icon: "window", title: "Checkout over your own pages", body: "A link and a short script for WordPress, Webflow, Squarespace, Ghost or your own HTML: pressed, it opens a product's card or your list's sign-up form over the page, on up to 10 sites you list, and a plain link anywhere else. Buyers pay on Stripe's page, on your own Stripe account. Your page hears marktmorgen:checkout, marktmorgen:optin and, back from paying, marktmorgen:purchase; your webhooks get the sale with its utm tags and site. The script sets no cookie and asks for nothing until it is pressed.", href: "/developers/checkout-script" },
          { icon: "music", title: "A private podcast", body: "Sell a show as a product, once or as a membership. Each buyer gets a feed of their own for Apple Podcasts, Overcast, Pocket Casts or most other apps, and new episodes arrive in it like any show's. A refund, or a membership that ends, stops every episode from playing for that buyer within minutes, and podcast directories are told to keep out." },
          { icon: "gift", title: "Buy it as a gift", body: "Under the buy button on a product's page, a buyer can give it instead: the recipient's email, their own name and a message. They pay on Stripe's page; the recipient gets one email and opens it on their own address — its download, its course, the community it opens — and a full refund takes it back. For products bought once that hand over a file, a link, a course or a bundle, at any of their price options." },
          { icon: "users", title: "Bought for a whole team", body: "Under the buy button, a buyer can pay for 2 to 200 people at once, your price times that many, on Stripe's page. They get one link to pass on; each person types their own email, opens the link sent to it and has the product on their own address. Never one place more than was paid for, a mistyped address takes none, and a full refund takes every place back. On a product with price options they pick one for everybody. You set up nothing and grant nobody by hand." },
          { icon: "clock", title: "Coming soon, with a waitlist", body: "Mark a paid product coming soon and its card and page take email addresses instead of payments, each confirmed from the inbox. When you put it on sale, everyone who confirmed gets one email with its link and price, and a note from you if you write one. The box to hear more from you starts empty." },
          { icon: "calendar", title: "Pre-orders, paid today", body: "Sell it before it is ready: a product coming soon can take pre-orders, with the day it is expected and your word that you refund every pre-order in full if it does not come out. Buyers pay at once and get a receipt with the day. The moment you put it on sale, each one is handed over and its buyer is emailed the way in. Pre-orders stop by themselves after the expected day." },
          { icon: "eye", title: "A page for each product", body: "At /@you/p/<product>: the picture, a long description of up to 5,000 characters, and a title and preview card of its own for search engines and shared links. Or a sales page you build from blocks.", href: "/platform/sales-pages" },
          { icon: "sparkle", title: "A description written with AI", body: "Type a few words about a product and a draft of its short and long description is written into the boxes, in your store's language, from only what you typed: no invented reviews, numbers, results or deadlines. Nothing is saved until you press Save. " + aiAllowanceWords() + " The jobs are shared by all the writing help." },
          { icon: "star", title: "Stars from real buyers", body: "Reviews only people who paid can write, with the average on the product's card and page.", href: "/platform/reviews" },
          { icon: "gift", title: "Free things, for an email", body: "Set a price of zero and it is handed out for a confirmed email address that joins your list." },
          { icon: "link", title: "Links with no price", body: "Your channel, your podcast, your booking page — each with a plain icon for the kind of place it leads to, or a small picture of your own in its place (a show's cover, your face), and that site's address printed under it. Group them under headings of your own; put one in the spotlight, larger and in your color; give one a start and an end, for a launch or a live, and it appears and goes by itself; and play a YouTube, Vimeo or Loom video, or a song, album, playlist or podcast from Spotify, SoundCloud, Apple Music or Apple Podcasts, right on the page, loaded only when a visitor presses play. Your studio counts each link's clicks." },
          { icon: "users", title: "Your profiles under your name", body: "Instagram, TikTok, YouTube, X and 15 more networks, an email and a website, as a row under your name with each network's name and a plain icon. Type a handle or paste an address: a pasted address picks its own network, and a link goes only to that network's own site." },
          { icon: "handshake", title: "Support my work", body: "A box where a fan who has nothing to buy today can still say thank you: three amounts you choose, each one press away from Stripe's page, or an amount of their own, with a message for you if they want. It goes to your own Stripe account like every sale, and no affiliate or partner share is taken from it. Each one is listed with your sales, with its message. What Ko-fi and Buy Me a Coffee are built on, beside everything you sell." },
          { icon: "chart", title: "A media kit for brands", body: "A page of its own at /@you/media-kit, in your store's look: your introduction (on " + AI_PLANS_WORDS + ", AI drafts three from what you sell and the numbers you give, never others), your audience on each platform with the combined reach, a few lines about who they are, what a collaboration costs, and the brands you have worked with, as plain names. The numbers are yours to type, and the page says so with the day you last changed them; beside them it shows what we counted ourselves, your products and your buyers' rating. Brands write to you through your contact form, and save the page as a PDF with one press." },
          { icon: "mail", title: "An email sign-up box", body: "A box on your store page where visitors join your list without taking anything. An address joins only after its owner presses the button in a confirmation email, so your list holds real inboxes, and sign-ups go on to your welcome emails and your email platform." },
          { icon: "info", title: "Questions answered on the store page", body: "Up to 12 questions and answers for the whole store — how files arrive, how to pay, how to reach you — opened with a tap and given to search engines as an FAQ. On " + AI_PLANS_WORDS + ", AI drafts them only from what your store says; you edit and save." },
          { icon: "chat", title: "A contact form", body: "Visitors write to you from your store page — a question before buying, a collaboration, a booking — and the message lands in your own inbox, with Reply going straight back to them. Nothing is ever sent to the address they type, and up to 20 messages a day reach you." },
          { icon: "sparkle", title: "\"Not sure which one is for you?\"", body: "On " + AI_PLANS_WORDS + ", with three products or more, a visitor says what they want and sees which of yours fit, and why, picked by AI only from your titles, one-line summaries, prices and notes. When nothing fits, what they looked for reaches your studio — never who asked." },
          { icon: "star", title: "What buyers say, on the store page", body: "Under your name, the average of every product's reviews; further down, the newest reviews with words, each with the product it is about. Never a hidden or refunded review, and nothing chosen for its stars." },
          { icon: "arrow-up-right", title: "A Share button", body: "Under your name: the phone's own share sheet, or the address copied on a computer." },
          { icon: "arrow-right", title: "What buyers get next", body: "Your studio shows, for each product, what its buyers went on to buy on a later visit and usually how many days after, counted from your Stripe sales from three buyers up. One press offers it right after paying, or starts a bundle of the two." },
          { icon: "users", title: "What its buyers also bought", body: "Show how many times each product was bought, and each product's page also says what the same buyers bought with it: \u201c5 buyers bought both\u201d, counted from your own Stripe sales, from three buyers up, never typed. The open cart offers the same, with Add to cart beside each." },
          { icon: "list", title: "Your page in your order", body: "Choose what comes first under your name: what you sell, what buyers say, your links, Support my work, the sign-up box, your questions and answers, the contact form and the way into your community. Links first for a page that is mostly links, buyers' words above the products, the sign-up box at the top while you build a list. A visitor who searches your store still sees the results first." },
          { icon: "palette", title: "Colors that stay readable", body: "Every color is checked for contrast before your page uses it, so your words never disappear into it." },
          { icon: "phone", title: "Your store, as an app", body: "On iPhone and Android, straight from the browser, your store installs to the home screen as an app of its own, with its name, its icon and its color. No app store." },
          { icon: "refresh", title: "Change your address freely", body: "Old addresses stay with your store and lead to the new one, up to ten at once, so the link in your bio keeps working." },
          { icon: "target", title: "A coach in your studio", body: "Once something is on your store, the studio scores it out of 100 against what stores that sell well have — a picture and a line on every product, a sales page, answers before buying, reviews asked for, a way to stay in touch — and takes you to the place to fix each one." },
          { icon: "gauge", title: "Fast on a phone", body: "The demo store, a real store with photos on it, scored 93 and 94 for performance on Google PageSpeed, on a simulated phone, on October 5, 2026." },
        ],
      },
      {
        kind: "uses",
        title: "Made for the link in your bio",
        items: [
          { icon: "camera", who: "You post on Instagram or TikTok", what: "One link that holds the free guide, the paid plan and the call, instead of a different link every week." },
          { icon: "video", who: "You teach on YouTube", what: "The course, the templates from the video and the channel itself, on one page people can find again." },
          { icon: "mic", who: "You run a podcast or a newsletter", what: "The episode links next to the things you sell, with no price on the links and nothing to check out." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        intro: "Said here so nobody signs up expecting it.",
        items: [
          "There is one layout, a single column that reads on a phone: you choose the theme, the color, the letters, the background and which part of the page comes first, not where parts sit beside each other.",
          "Each store supports up to 2,000 products and 100 links.",
          "No custom code on the page, and the whole store cannot be put inside another website. One product can, as a card or a button.",
          "Buyers pay through Stripe, with the ways to pay your own Stripe account has on. Do not count on PayPal: Stripe offers it only to accounts in the EU (except Hungary), the UK, Switzerland, Norway and Liechtenstein, and its documentation, read on September 28, 2026, lists it as not supported for direct charges, which is how every sale here is charged.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about the store page",
        items: [
          // 534 [FQ1], unit 5: what someone starting out asks, answered by the code (lib/store-page-faq.ts).
          ...storeBeginnerQuestions(),
          { q: "Can I change my store address later?", a: "Yes, from your studio, whenever you want. The addresses your store holds keep working and send people to the current one, up to ten at once. An address you let go of stops working, and after 30 days anyone may take it." },
          { q: "Is the page up before I connect Stripe?", a: "Yes. The page, the editor and your address are free and stay free; without a plan, the page is shown for " + countWords(publicVisitLimit(SETUP_VISITS)) + " visits a month. Taking a card needs two things: Stripe has cleared your account, and your plan or its 14-day trial is running. Until then the page says plainly that it cannot take a payment." },
          { q: "Can I use my own domain?", a: DOMAINS ? `Yes, on the ${PLAN_AT.pro} Studio plan. You add one record where you bought the domain, and the certificate is made for you. Your marktmorgen.com address keeps working as well.` : "Not yet. It is planned for the Studio plan, and this page will say so on the day it works." },
          { q: "How do I see what the page looks like before I save?", a: "The studio shows the page with your photo, theme, color and letters as you change them, before anything is saved." },
          { q: "Is there a limit on how many people can visit?", a: `Your plan covers a number of visits a month: ${countWords(VISITS_INCLUDED.creator)} on the ${PLAN_AT.creator} plan, ${countWords(VISITS_INCLUDED.pro)} on the ${PLAN_AT.pro} plan and ${countWords(VISITS_INCLUDED.scale)} on the ${PLAN_AT.scale} plan. A visit is one person opening your store on one day, however many pages they look at, and you are never counted. Visits are never billed: public pages pause at ${(10_000 - BUYER_RESERVE_BPS) / 100}% of the figure until the month turns or a plan change gives a larger one, and the last ${BUYER_RESERVE_BPS / 100}% are kept for your buyers' courses, community and podcasts. Your studio shows the count as it grows.` },
          { q: "Can one account run more than one store?", a: "Yes, up to five, each with its own address, products and Stripe account, and a plan of its own to take payments. You switch between them at the top of your studio." }
        ],
      },
    ],
  },
  {
    slug: "price-options",
    section: "platform",
    eyebrow: "Price options",
    title: "One product,",
    highlight: "several prices",
    intro:
      "A one-week plan for $27 and a five-week plan for $39, from the same product card. The buyer picks, and each option hands over its own file or its own link.",
    badge: WORKING,
    accent: "from-pink-brand to-amber-brand",
    visual: "options",
    plan: "creator",
    group: "sell",
    menu: { label: "Price options", description: "Up to 50 prices on one product, compared side by side. The buyer picks.", icon: "tag" },
    related: ["checkout", "instant-delivery", "store-page", "courses"],
    blocks: [
      {
        kind: "how",
        title: "How it works",
        items: [
          { title: "Add up to 50 options", body: "A name the buyer reads — “1 week,” “Commercial license” — a price for each, and, if you like, a few lines on what each one includes." },
          { title: "Give each option its own delivery", body: "Its own file, up to 5 GB, or its own link. The buyer of the small size never receives the big one. On a course, every option opens the course, and a file or link on one is what that one adds." },
          { title: "The buyer compares and picks", body: "With what each includes written down, the options stand side by side, and the one you recommend opens chosen. More than six become a list to pick from. What is charged is read from what you saved, never from the page." },
        ],
      },
      {
        kind: "lead",
        text: `Stan's own help center lists pricing tiers among its most requested features and says there is no native way to offer them under one product — read on September 18, 2026. Here they are on the ${PLAN_AT.creator} plan.`,
      },
      {
        kind: "uses",
        title: "Where a second price earns its keep",
        items: [
          { icon: "calendar", who: "Sizes of the same plan", what: "One week to try, five weeks for the person who already trusts you, the whole season for the fan. Named “1 week” and “5 weeks,” the bigger one shows what each week costs in it and how much less that is, worked out from your own prices." },
          { icon: "key", who: "Licenses", what: "Personal use, commercial use and a team license, each delivering its own file and terms." },
          { icon: "video", who: "Plain and complete", what: "The PDF on its own, or the PDF with the videos, at a price that tells the buyer the difference." },
          { icon: "repeat", who: "The bigger option, in payments", what: "Add a payment plan and each price gets payments of its own: three monthly payments of $13 for five weeks, of $9 for one. Each card says its own, and the buyer picks the price and then how to pay it." },
        ],
      },
      {
        kind: "facts",
        title: "Measured on October 5, 2026",
        items: [
          { value: "$27", label: "Test purchase of the one-week option on the demo store, in production", tone: "" },
          { value: "2,364", label: "Bytes delivered — identical to the original file", tone: "" },
          { value: "76", label: "Automated checks passing on the demo store that day", tone: "" },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "50 options per product at most, and 4,000 across a store.",
          "A course or podcast sold as a membership has one price: what a member pays each time is what it costs.",
          "A payment plan on a product with options spreads each price in the same number of payments, each price with an amount of its own; the plan is paused while a price that can be bought has none.",
          "A product with options has fixed prices: pay-what-you-want pricing is for products with one price.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about price options",
        items: [
          // 534 [FQ1], unit 10: what someone starting out asks, answered by the code (lib/price-options-faq.ts).
          ...optionsBeginnerQuestions(),
          { q: "Can I change a price after people have bought?", a: "Yes. What changes is what the next buyer pays. Whoever already bought keeps what they paid for, and the file of the option they chose." },
          { q: "Do discount codes and the box at checkout work with options?", a: "Yes. A code comes off the option the buyer picked, and the box at checkout adds its product to whichever option they chose." },
          { q: "Can an option be a membership?", a: "Yes. A membership can have options too — monthly members choosing between two levels, for example — each charged on your own Stripe account." },
        ],
      },
    ],
  },
  {
    slug: "courses",
    section: "platform",
    eyebrow: "Courses",
    title: "Courses your students",
    highlight: "open without a password",
    intro:
      "Modules and lessons with video that plays in the size each student's connection can carry, text and downloads, free preview lessons on your store, and modules that open on the day you choose. Students get in with the email they paid with.",
    badge: WORKING,
    accent: "from-sky-brand to-violet-brand",
    visual: "course",
    plan: "creator",
    group: "sell",
    menu: { label: "Courses", description: "Video lessons, free previews and modules that open over time.", icon: "book" },
    related: ["quizzes-and-certificates", "community", "memberships", "checkout"],
    blocks: [
      {
        kind: "how",
        title: "From a product to a course",
        items: [
          { title: "Turn a product into a course", body: "Any paid product with no file, link or price options of its own can become a course from your studio. Add modules, then lessons inside them, and then, if you like, several prices: the course alone, or with a live Q&A." },
          { title: "Fill the lessons", body: "A video of up to 5 GB, your text, up to five downloads and a link on each. The video uploads in parts, so a dropped connection costs one part. Mark any lesson as a free preview." },
          { title: "Sell it your way", body: "Paid once, in a payment plan, in a bundle with your other products, or as a membership that stays open while the member pays." },
        ],
      },
      {
        kind: "features",
        title: "What a course holds",
        items: [
          { icon: "play", title: "Video that does not stop to load", body: "Each video is made into up to five sizes, from 240p to 1080p and never larger than the video itself. The player sends the size the student's connection can carry and changes it as the connection changes." },
          { icon: "video", title: "A player students control", body: "Students can pick a size and a playback speed, watch full screen or in a small window, and the video goes on from where they stopped on that device." },
          { icon: "phone", title: "Video that stays upright", body: "Up to 5 GB a lesson. A video filmed upright on a phone plays upright, in a frame of its own shape." },
          { icon: "type", title: "Captions in up to 12 languages", body: "Upload a .vtt or .srt file for a language and the player shows a captions button. Bold, italics and where a caption sits are kept; a file that is not captions is refused instead of shown as nothing." },
          { icon: "sparkle", title: "Captions written by AI", body: `One press writes a lesson's captions from what is said in it, in the language spoken and, if you like, translated into up to two more. ${dollars(CENTS_PER_MINUTE)} a minute of video for each language, shown before you press and charged then to the card your plan is paid with; anything not delivered within ${GIVE_UP_HOURS} hours is refunded.` },
          { icon: "lock", title: "A video address that expires", body: "The player on a lesson page is signed for a few hours. Without that signature, the video and its files are refused." },
          { icon: "eye", title: "Free preview lessons", body: "Any lesson can be watched from your store before buying, so the buyer knows what they are paying for." },
          { icon: "calendar", title: "Modules that open over time", body: "A module can open a set number of days after each student joins, and the student gets an email the day it does." },
          { icon: "key", title: "No password to make", body: "The course opens right away in the browser that paid. On any other device, a link is emailed to the address they paid with." },
          { icon: "list", title: "Lessons from a folder of videos", body: "Choose up to 50 videos at once in a module and each becomes a lesson of its own, named after its file and in the order of the file names: \u201c02 - First loaf.mp4\u201d becomes the lesson \u201cFirst loaf.\u201d A video that does not upload takes its lesson away again, and you are told which file and why." },
          { icon: "sparkle", title: "An outline drafted with AI, on " + AI_PLANS_WORDS, body: "Say what the course covers and who it is for, and up to 8 modules of up to 8 lesson titles come back for you to look at. Nothing is added until you press Add, and every title can be changed." },
          { icon: "chat", title: "Questions under each lesson", body: "Students ask and answer under every lesson, under a name they choose; their email address is never shown, and only the course's students and you read them. You answer as the creator from the lesson or your studio, and the student gets an email with your words. Hide or delete any comment, or switch comments off for a course." },
          { icon: "chart", title: "Each student's progress", body: "Your studio shows who opened the course and how many lessons each one marked done." },
          { icon: "users", title: "Your list of students", body: "See every student, and take one off the course if you need to." },
          { icon: "cap", title: "Quizzes and certificates", body: "Up to 20 questions after any lesson, a pass mark, and a certificate with a page anyone can open to check it.", href: "/platform/quizzes-and-certificates" },
          { icon: "chat", title: "A community for students", body: "Your store's community can open to the buyers of a course, for questions and work shared where everyone can learn from it.", href: "/platform/community" },
          { icon: "video", title: "Live Q&As for a course", body: "A live event in your community can be kept for the buyers of the course, with a replay afterward.", href: "/platform/live-events" },
          { icon: "door", title: "Students from another platform", body: "Import the people who bought the course elsewhere, up to 20,000 a file, and they open it here with the email they bought with.", href: "/platform/switching-to-marktmorgen" },
        ],
      },
      {
        kind: "uses",
        title: "Who sells courses here",
        items: [
          { icon: "cap", who: "A coach with a method", what: "Six weeks of lessons that open one module a week, with the worksheets inside each lesson." },
          { icon: "utensils", who: "A cook with a system", what: "Batch cooking, filmed in your own kitchen, with a free first lesson on the store." },
          { icon: "palette", who: "A designer who teaches", what: "The techniques on video, and the source files as downloads beside each lesson." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "The certificate's PDF file is drawn in Latin, Greek and Cyrillic letters; a name in another script is printed from the certificate's page instead.",
          "No live lessons inside the course itself. Hold them as live events in your community, or put a link in a lesson to where you hold them.",
          `Stream video has a finite threshold of ${paidVideoWords()} a month across your store. New playback pauses at the recorded threshold. The meter is read about once an hour; existing player links may remain valid until they expire. Your studio shows the recorded hours.`,
          `Without a paid plan, lesson videos pause past the store's hours until the plan is paid (for a store with no plan, until the month turns): ${hoursWords(TRIAL_VIDEO_SECONDS)} a month in the free trial, and ${hoursWords(SETUP_VIDEO_SECONDS)} a month before a plan starts and after one ends.`,
          "Video is kept up to 1080p: a 4K file plays at 1080p.",
          `Captions written by AI are machine transcription: read them before you rely on them, and replace a language with your own file whenever you like. They are for videos of up to ${MAX_AUTO_MINUTES / 60} hours, need a paid plan, and come as captions in the player, not as a separate transcript.`,
          "A signed address stops a link from being passed around. It does not stop a student from recording their own screen; nothing does.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about courses",
        items: [
          // 534 [FQ1], unit 2: what someone starting out asks, answered by what the code does (lib/course-faq.ts).
          ...courseBeginnerQuestions(),
          { q: "How long until a video I upload can be watched?", a: "It plays as soon as its first size is made, and the larger sizes follow by themselves. Your studio says when it is ready, and a student who opens the lesson before that is told the video is being prepared." },
          { q: "How does a student come back next week?", a: "On the device they paid on, the course simply opens. On any other, they ask for a link on the course page and it is emailed to the address they paid with. No account, no password." },
          { q: "Can I sell a course monthly?", a: "Yes. Sold as a membership, the course stays open while the member pays and closes when the membership ends." },
          { q: "Can students pay in installments?", a: "Yes. A course with one price can be offered in two to twelve weekly or monthly payments. The student gets in after the first." },
          { q: "What if I refund a student?", a: "Refunds are made in your own Stripe dashboard. A refund in full closes the course for that student within ten minutes; a partial refund keeps it open. On a payment plan, a refund in full of the first payment closes it too; a refund of a later payment is not detected, so take that student off the course in your studio." },
        ],
      },
    ],
  },
  {
    slug: "memberships",
    section: "platform",
    eyebrow: "Memberships",
    title: "Get paid every month,",
    highlight: "on your own account",
    intro:
      "Any paid product that delivers a file, a link or a course can charge daily, weekly, monthly or yearly instead of once. The member is your customer, in your Stripe dashboard, and cancels on their own, without writing to you.",
    badge: WORKING,
    accent: "from-violet-brand to-pink-brand",
    visual: "membership",
    plan: "creator",
    group: "sell",
    menu: { label: "Memberships", description: "Daily, weekly, monthly or yearly, on your own Stripe.", icon: "repeat" },
    related: ["courses", "community", "your-stripe", "email"],
    blocks: [
      {
        kind: "how",
        title: "How it works",
        items: [
          { title: "Choose how often", body: "Daily, weekly, monthly or yearly, on any paid product that delivers a file, a link or a course. Calls and bundles are sold once." },
          { title: "The member subscribes", body: "The subscription is made on your own Stripe account, like every charge here, with 0% to us on every renewal." },
          { title: "They leave on their own", body: "Under every membership: “Already a member? Manage or cancel.” An emailed link opens their memberships, each with its own Cancel, and Stripe's own page for the card and the receipts." },
        ],
      },
      {
        kind: "features",
        title: "What makes it fair to both sides",
        items: [
          { icon: "bank", title: "Your customer, not ours", body: "Members sit in your Stripe dashboard. If you ever leave Marktmorgen, the paying members stay with you." },
          { icon: "door", title: "Canceling on their own", body: "On Stripe's page, at the end of the period already paid for. Nobody has to write to you and wait." },
          { icon: "clock", title: "A pause instead of goodbye", body: "If you choose, a member who would cancel can pause instead, for up to the one, two or three months you allow, from the same page. What they paid for stays open to the last day; then nothing is charged and the membership is closed until the pause ends and starts again by itself. Coming back early takes a payment that day. Monthly memberships only, once a year each, and the member is emailed the dates in your store's language. Read on September 30, 2026: Kajabi lets a creator pause a member by hand." },
          { icon: "gift", title: "An offer before they go", body: "If you choose, a member who presses Cancel is offered a discount you set — 10% to 50% off one to three payments — once per membership, on Stripe's own page, and declines it in one press. An offer of more than one payment is made only on monthly memberships." },
          { icon: "card", title: "When a card fails", body: "The member gets one email with a link that pays that renewal and makes the card that worked the one used next time. It says when the card on file is tried again, or that it will not be." },
          { icon: "chart", title: "Membership numbers", body: "Monthly recurring revenue, paying members and trials, churn over 30 days and the share of trials that became paying, overall and by membership, read from your own Stripe account, with how each is worked out written beside it." },
          { icon: "refresh", title: "A come-back offer", body: "If you choose, somebody whose membership ended gets one email, 3 to 21 days later, with 10% to 50% off one to three payments to come back, and a link that opens your checkout with it applied. Only to people who agreed to hear from you, never to anybody who already came back." },
          { icon: "refresh", title: "Switching plans, up or down", body: "Pick 2 to 6 memberships as tiers and members move between them on their own, seeing Stripe's exact amount first. Up charges the new price less what was left of their last payment, at once; down turns what was left into a credit on their next payments. What the new plan includes opens as soon as it is paid, and a declined card changes nothing." },
          { icon: "card", title: "Card changes without you", body: "The member changes their card and sees their receipts on the same page." },
          { icon: "book", title: "A course that stays open", body: "A course sold as a membership is open while the member pays, and closes when it ends." },
          { icon: "gift", title: "A free trial, said plainly", body: "1 to 90 days. The card is saved at the start and nothing is charged until the trial ends. The page and the button say so, and the confirmation email gives the date of the first payment." },
          { icon: "calendar", title: "Monthly, or yearly for less", body: "Give a monthly membership a yearly price too. Buyers pick Monthly or Yearly before paying, Yearly says what it saves against twelve monthly payments, and the subscription is made at that price, once a year, on your own Stripe account." },
          { icon: "tag", title: "A first month for less", body: "Or start members on an introductory price: $5 the first month, or for the first 1 to 12 months, then the regular price by itself. The page, the button and Stripe's checkout say both prices before anyone pays, and the confirmation says them again." },
          { icon: "calendar", title: "Or a set number of payments", body: "2 to 36 payments, and then it ends by itself. The member can still cancel before that." },
          { icon: "lock", title: "Access that ends with it", body: "When a membership ends, its files, its course and your community close, and the member is shown how to join again." },
          { icon: "chat", title: "A community for members", body: "Open your store's community to a membership. A member who stops paying loses access within five minutes.", href: "/platform/community" },
        ],
      },
      {
        kind: "uses",
        title: "What people sell as a membership",
        items: [
          { icon: "utensils", who: "A monthly meal plan", what: "A new plan every month, delivered as a link to where you keep it." },
          { icon: "dumbbell", who: "A training club", what: "The program as a course that stays open while the member pays." },
          { icon: "users", who: "A group session", what: "A monthly class, with the meeting link as what the membership hands over." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "A free trial is a number of free days, the same for every member of that product. An introductory price is one price for the first payment, or the first months of a monthly membership, never beside a trial. Neither can be checked against who joined before, so a member who cancels and joins again starts with it again, unless a come-back offer applies instead.",
          "A membership is charged at its set price: it cannot use pay-what-you-want pricing.",
          "Files, courses and the community close when a membership ends: canceled, or unpaid once Stripe stops retrying. A link you sell stays wherever you keep it, so remove the member there.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about memberships",
        items: [
          // 534 [FQ1], unit 3: what someone starting out asks, answered by what the code does (lib/membership-faq.ts).
          ...membershipBeginnerQuestions(),
          { q: "What does Marktmorgen take from a renewal?", a: feeWords().fromARenewal },
          { q: "What happens if my own Marktmorgen plan lapses?", a: "Your page stops selling, but members can still cancel on their own. Nobody is ever trapped in a charge they want to stop." },
          { q: "Do discount codes work on memberships?", a: "Yes, on the first charge. A code comes off the payment it is typed into, not every renewal after it." },
        ],
      },
    ],
  },
  {
    slug: "calls",
    section: "platform",
    eyebrow: "Paid calls",
    title: "Sell your time,",
    highlight: "booked and paid in one go",
    intro:
      "One person at a time, a group of up to 50, or live sessions on dates you set. Buyers see the free times in their own time zone, pick one and pay on your Stripe account. Then the buyer and you get an email; on a team call, the host gets yours. The link to meet is a Google Meet link made for the booking, your own link or a private video room. With none, the buyer is told you will send it.",
    badge: WORKING,
    accent: "from-mint-brand to-sky-brand",
    visual: "calls",
    plan: "creator",
    group: "sell",
    menu: { label: "Paid calls", description: "Your hours, their time zone, paid before it is booked.", icon: "calendar" },
    related: ["calendar-sync", "live-events", "checkout", "your-stripe"],
    blocks: [
      {
        kind: "how",
        title: "How it works",
        items: [
          { title: "Set your hours once", body: "How long a call lasts, your time zone, and the hours you take calls each day — up to two stretches a day." },
          { title: "The buyer picks a time", body: "Free times are shown in the buyer's own time zone. The time is held for them for 30 minutes while they pay." },
          { title: "Paid, then booked", body: "The buyer gets an email with a calendar file and the link to meet, or a note that you will send it. You get one too, or the host does on a team call. If the call is already in that person's Google Calendar, their email has no file. The call appears in your studio under Upcoming calls, and in the buyer's list of purchases." },
        ],
      },
      {
        kind: "features",
        title: "The rules are yours",
        items: [
          { icon: "clock", title: "Length", body: "15, 20, 30, 45, 60, 90 or 120 minutes." },
          { icon: "alert", title: "Notice", body: "From 1 hour to 72 hours before a call, so nobody books you for the next ten minutes." },
          { icon: "calendar", title: "How far ahead", body: "From a week to three months of free times on show." },
          { icon: "minus", title: "A gap between calls", body: "Up to an hour between one call and the next." },
          { icon: "video", title: "Google Meet, made for you", body: "Connect your Google Calendar and each booking gets an event with a Meet link on your primary calendar, the buyer on its guest list. Google emails nobody: the link comes in our emails and calendar file." },
          { icon: "video", title: "Your meeting link", body: "Zoom, Google Meet, Whereby — the link you already use goes into every invitation." },
          { icon: "video", title: "Or a private video room", body: "Switch it on and each booking gets its own Jitsi Meet room, a link nobody can guess, with nothing to set up. A group call or a live session has one room per time, shared by everyone booked into it." },
          { icon: "shield", title: "Never booked twice", body: "A time being paid for is held, so two people can never pay for the same time, or for the last seat." },
          { icon: "users", title: "Group calls", body: "Up to 50 people at each time. Buyers see how many seats are left." },
          { icon: "users", title: "Team event types", body: `One call booked with whoever on your team is free, shared out evenly (round robin), or only when all of them are (collective). Each host has their own hours in their own time zone, their own gap, notice and cap of team calls a day, and nobody is held twice for the same time, on any store. ${PLAN_AT.creator} plan: ${teamLimitWords(TEAM_LIMITS.creator)}; ${PLAN_AT.pro} plan: ${teamLimitWords(TEAM_LIMITS.pro)}; ${PLAN_AT.scale} plan: ${teamLimitWords(TEAM_LIMITS.scale)}.` },
          { icon: "gift", title: "Packages of sessions", body: "Sell 2 to 20 sessions at one price, with 30 days to a year to use them, or no limit. The buyer pays once and books each session from their own link whenever they like, with the reminders, meeting link and moves of any booking. Their purchases show how many are left." },
          { icon: "video", title: "Live sessions on dates", body: "Up to 50 dates per product, each with 1 to 500 seats, its own length and its own link. Sales close when you say, up to 72 hours before." },
          { icon: "mail", title: "Reminders", body: "A day and an hour before, to every buyer in their time zone, with the link to join or a note that you will send it. You get one per time, listing everyone booked. A reminder that would come less than an hour after the booking is skipped." },
          { icon: "refresh", title: "Buyers move their own booking", body: "Up to twice, from the link in their email, until the notice you set before the call. Nothing is charged or refunded." },
          { icon: "calendar", title: "Your calendar's busy times", body: "Up to three Google, Outlook or iCloud calendars, read by their private address: when you are busy there, that time is not offered.", href: "/platform/calendar-sync" },
        ],
      },
      {
        kind: "uses",
        title: "Who sells calls",
        items: [
          { icon: "cap", who: "Coaches", what: "The hour of your time, next to the workbook and the program, as the top step of the ladder." },
          { icon: "dumbbell", who: "Trainers", what: "A 20-minute form check that is booked and paid, not a free message that eats your evening." },
          { icon: "palette", who: "Designers", what: "A portfolio review or a consultation before a commission." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "Your calendars are read for busy times, and only calls set to Google Meet, and team calls whose host connected their own Google Calendar, are written into Google Calendar. Other bookings reach your calendar as a feed you subscribe to, and a new busy time can take about ten minutes to close a slot.",
          "Two-way Google Calendar sync for team hosts is built and switches on once Google approves the added permissions for our app; until then, hosts add their calendar's private iCal address, which is read the same way but writes nothing.",
          "A team call has one person per time, keeps its host when the buyer moves it, and sends its booking email to one address: yours when you host it, otherwise its first host's. Its reminders before the call come to you. A host's daily cap counts team calls only.",
          "Buyers move a booking themselves, but canceling is a reply to their confirmation email, which reaches you; a refund is made from your Stripe dashboard.",
          "Zoom links are not made for you yet. Connecting Zoom opens to every store once Zoom approves our app; until then, for Zoom, you type your own link. Stan creates Zoom links automatically.",
          "On a free personal Google account, Google ends meetings of three or more people after 60 minutes.",
          "Jitsi Meet is a free service run by a third party, not by us. Nobody needs an account to join, but the first person to open a room may be asked to sign in to Jitsi to start it, and the others wait until then.",
          "The call or the session itself happens on that service. Nothing is streamed or recorded here.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about paid calls",
        items: [
          // 534 [FQ1], unit 4: what someone starting out asks, answered by the code (lib/call-faq.ts).
          ...callBeginnerQuestions(),
          { q: "What if two people try to book the same time?", a: "The first to reach payment holds it for 30 minutes. The second no longer sees it. If the first does not pay, the time comes back." },
          { q: "Can a call be paid in installments?", a: "No. A call is paid in full when it is booked. Installments are for products with one price." },
          { q: "Can I hold a free session for my members instead?", a: "Yes, as a live event in your community: members RSVP, get reminders and join from the event's page. Paid calls and live sessions are for selling seats; live events are for the people already let into your community." },
          { q: "Is sales tax added to calls?", a: "When you switch Stripe Tax on, it is added to calls as it is to everything else, on your own account." },
          { q: "Where is the video room, and who runs it?", a: "At meet.jit.si, the free Jitsi Meet service run by 8x8, not by us. Its link is in the booking and reminder emails, the calendar file, your bookings feed and the buyer's list of purchases. Open it a few minutes early: the first person in may be asked to sign in to Jitsi (with a Google account, for example) to start the meeting." },
          { q: "What if a buyer picks a time and leaves without paying?", a: "The time is held for them while Stripe's page is open, about half an hour, and goes back on sale when it closes. With checkout reminders on, a buyer who agreed on that page to hear from you gets one email: the time they picked, that it was not kept, and a link to the times still open, at today's price. It is sent only while a time is left to book, never twice in a week, and never once they have booked." },
          { q: "How do team event types work?", a: "Under a call with weekly hours and one person per time, choose Make it a team event, pick round robin or collective, and select who hosts it: you and anyone on your store's team. Each host gets their own hours, time zone, gap between calls, notice and a cap of team calls a day, read on their own clock, daylight saving included. Round robin gives each booking to the free host with the fewest bookings of it so far. Each host sets their own calendar once, under Your calendar in the studio: a private iCal address, or their Google Calendar for two-way sync once it is switched on. A host whose calendar was last read more than 45 minutes ago, or cannot be read, is left out until it can be, so nobody is booked over a meeting we could not see; the other hosts' times stay open. Every hold and booking takes its hosts' time in one step, so the same person can never be held twice for one time, even by two stores." },
          { q: "How are Google Meet links made?", a: "Connect your own Google Calendar under Video calls in your studio, then choose Google Meet (automatic) under Where the call happens. Each booking gets an event with a Meet link on your primary calendar, with the buyer on its guest list; a group call or a live session has one event per time, with up to 200 guests who do not see one another. Google emails nobody: buyers get the link in our booking email, reminders and calendar file. A moved booking moves its event, and a full refund deletes a one-to-one call's event or takes the buyer off a group's guest list. If a meeting cannot be made, the booking gets your own link or a Jitsi Meet room, and we keep trying for a few hours. If a Meet link is made more than two hours before the call, it is emailed to those booked, up to 20 people." },
        ],
      },
    ],
  },
  {
    slug: "checkout",
    section: "platform",
    eyebrow: "Checkout tools",
    title: "Earn more from every buyer,",
    highlight: `on the ${PLAN_AT.creator} plan`,
    intro:
      "Discount codes, a product added at checkout, one-click offers after paying, payment plans, pay what you want, questions at checkout, limited quantities and sales tax. On Stan, the first four are on the $99 plan.",
    badge: WORKING,
    accent: "from-amber-brand to-pink-brand",
    visual: "checkout",
    plan: "creator",
    group: "paid",
    menu: { label: "Checkout tools", description: "Codes, add-ons, one-click offers, installments and tax.", icon: "percent" },
    related: ["funnels", "currencies-and-ways-to-pay", "sales-pages", "price-options"],
    blocks: [
      {
        kind: "features",
        title: "Every tool on your own account",
        intro: "Stan's pricing page, read on September 20, 2026, puts discount codes, order bumps, upsells and payment plans on its $99 plan.",
        items: [
          { icon: "clock", title: "A sale with a real end", body: "Pick a percentage and when it starts and ends, for every product or only some. While it runs the old price is crossed out on your store and on each product's page, with when it ends, and Stripe takes it off with no code to type. At the end it stops by itself, and the discount stops working at Stripe too." },
          { icon: "percent", title: "Discount codes", body: "A word you choose, a percentage or an amount off, and a cap on uses if you want one. Up to twenty codes, kept as coupons on your own Stripe. Shared as a link (?code=SPRING), a code applies itself at checkout." },
          { icon: "globe", title: "Fair prices by country", body: "Switch it on and buyers where money buys less see a lower price, taken off on Stripe's page with no code. Automatic from the World Bank's price levels, up to the most you allow, or only the countries you list, each at the level you choose, on every product or only the ones you pick. Built in, as on Gumroad; on Kajabi it takes an outside app." },
          { icon: "plus", title: "Add it at checkout", body: "Up to three boxes above the buy button, each offering another of your products at a price of your own. Never pre-checked for the buyer, each checked on its own, and the button says the total of what is checked. Stan allows one per product." },
          { icon: "basket", title: "A cart", body: "Once two or more of your products could go in one, each card and product page offers \u201cAdd to cart\u201d. The cart sits at the top of your store with each product at its price now, a sale or a fair price already taken off, and buyers pay for up to four in one payment. Each one is handed over exactly as if bought on its own. The open cart offers what you picked to go with what is in it, then what its buyers really bought with it, and one of your bundles shown on your store's first page when swapping the products it holds for it makes the cart cost less, with the exact saving. Switch on \u201cBuy more, save more\u201d and every Add to cart says, say, 10% off for 2 or more, while the cart counts down to it." },
          { icon: "bolt", title: "One click after paying", body: "The thank-you page offers one more product, or up to five in a row as a funnel, charged to the card just used. Only in that browser, for an hour, and only after a card, Apple Pay or Google Pay payment.", href: "/platform/funnels" },
          { icon: "calendar", title: "Payment plans", body: "Two to twelve weekly or monthly payments. The buyer gets what they bought after the first payment, and the plan ends by itself after the last." },
          { icon: "receipt", title: "Payment requests and invoices", body: `Ask one person to pay a custom amount, from your studio or from a deal: up to ${MAX_LINES} lines of what it is for, a note, a due date if you want one and up to ${MAX_AUTO_REMINDERS} reminders a week apart. They get an email from your store's name and a page that says who is asking, what for and the total; they pay on Stripe's page, on your own account, and get a receipt they can print. Each status shows in your studio: open, paid, canceled, expired or refunded. Nothing is added to what they pay, and no late fee is charged. Each email is one of your store's emails for the month.` },
          { icon: "receipt", title: "Proposals and agreements to sign", body: `Write the terms in plain text, with lines and amounts if you want them, and send them to one person. They read the exact text on your store's page and sign by typing their full name and the address it was sent to. The exact text, its SHA-256 fingerprint, the version, the name, the time and a one-way code made from their internet address are recorded, and both of you are emailed the signed copy. An edit is a new version that needs a new signature, up to ${AGREEMENT_VERSIONS}; a link takes a signature for ${SIGN_DAYS} days. Whether an agreement can be enforced depends on local law; Marktmorgen gives no legal advice.` },
          { icon: "list", title: "Limited quantity", body: "Sell fifty and stop. The count shown is the real one, and a unit being paid for is held so the last one is never sold twice." },
          { icon: "receipt", title: "Sales tax and VAT", body: "Stripe Tax works it out from each buyer's address, on your account, once your Stripe tax setup is complete." },
          { icon: "scroll", title: "A VAT number box and invoices, for business buyers", body: "Two switches, off until you turn them on. A company can enter its VAT or tax number at checkout, saved on your Stripe account and printed on its invoice, and Stripe can draw up an invoice for every single payment, with you as the seller. Stripe charges you for those invoices, and filing the tax stays yours." },
          { icon: "tag", title: "Pay what you want", body: "Your price becomes the minimum, at least $1 or the smallest price your store's currency allows, with a suggested price already in the box. Stripe refuses anything under the minimum." },
          { icon: "card", title: "The ways to pay your Stripe has on", body: "Apple Pay, Google Pay, Link, Klarna, Afterpay, Affirm, iDEAL, Bancontact and others you switch on in your own Stripe account, in any of 15 currencies.", href: "/platform/currencies-and-ways-to-pay" },
          { icon: "store", title: "Physical products, shipped by you", body: "A printed book, a poster, merch in sizes: set a shipping cost and the countries you ship to. Stripe asks for the address and adds the shipping before paying, the address is on the sale, and \u201cMark as shipped\u201d emails the buyer with your tracking link." },
          { icon: "type", title: "Questions at checkout", body: "Up to three, on Stripe's page before paying: a short answer, a number, a list to choose from, or a phone number in Stripe's own box, which checks it is a real one. The answers are in your list of sales." },
          { icon: "mail", title: "One reminder after a checkout left unpaid", body: "Only to a buyer who said yes: by asking for it on the page the way back from the checkout leads to, in any country, or by checking Stripe's own box where Stripe shows one. About an hour later, once. A cart left at checkout gets one too, naming everything in it, with a link that puts the cart back as it was. A visitor not ready yet can also ask for one on the product's page, for in an hour, tomorrow or in three days. Off until you switch it on." },
        ],
      },
      {
        kind: "how",
        title: "What keeps it honest",
        items: [
          { title: "Nothing pre-checked for them", body: "An extra charge the buyer did not choose is not a sale, and in Europe it is not allowed either." },
          { title: "The button says the total", body: "Check the box or pick the plan, and the buy button changes to what is charged today." },
          { title: "Scarcity that is true", body: "The number left is counted from real payments. No invented countdowns, no fake stock." },
          { title: "Latest purchases that happened", body: "Switch it on and your front page and product pages show a card with a recent purchase: what was bought, how long ago and the country it was billed in, never who. Only payments settled on your Stripe account in the last 7 days, up to 3 a visit, each once; refunded ones are left out, and nothing can be typed in." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "A discount code comes off the payment it is typed into. On a membership, that is the first charge.",
          "One product can be offered in the box under each product, and up to five after paying.",
          "While sales tax is on, offers after paying are paused, because tax cannot be added to a one-click charge.",
          "Offers after paying are shown only to a buyer who paid by card, Apple Pay or Google Pay. A buyer who paid with Klarna, Link or a bank goes straight to what they bought.",
          "A payment plan cannot be canceled from your page; a buyer who needs to change something replies to their order confirmation email, which reaches you.",
          `A payment request is one payment: no installments on requests yet. Up to ${REQUEST_LIMITS.creator.open} open at once on ${PLAN_TITLES.creator}, ${REQUEST_LIMITS.pro.open} on ${PLAN_TITLES.pro} and ${REQUEST_LIMITS.scale.open} on ${PLAN_TITLES.scale}; each link takes payment for ${OPEN_DAYS} days.`,
          "Pay what you want is for a product with one price, sold once: not with memberships, price options, payment plans, the box at checkout, calls or discount codes.",
          "Questions are short answers, numbers, lists or a phone number: no checkbox question, and none on free products.",
          "Stripe shows its own consent box only on checkouts of US businesses, so outside the United States the reminder after an unpaid checkout reaches only a buyer who goes back from the checkout and asks for it. A call's reminder needs that box, so outside the United States none is sent for calls or live sessions.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about the checkout tools",
        items: [
          // 534 [FQ1], unit 7: what someone starting out asks, answered by the code (lib/checkout-faq.ts).
          ...checkoutBeginnerQuestions(),
          { q: "Is the one-click offer safe for the buyer?", a: "The card is kept only for payments made while the buyer is there, never to charge them later. The offer works only in the browser that paid, for an hour, and once; if the bank asks the buyer to confirm, they confirm it." },
          { q: "Who files the tax that Stripe collects?", a: "You do, because you are the seller. Stripe Tax works it out and collects it on your account, and gives you reports of what was collected. Stripe charges for Stripe Tax at its own published price." },
          { q: "Can a buyer who chose a payment plan also take the box at checkout?", a: "Yes. The added product is charged with the first payment, and the button says the total due today." },
        ],
      },
    ],
  },
  {
    slug: "your-stripe",
    section: "platform",
    eyebrow: "Your own Stripe",
    title: "The money goes to",
    highlight: "your own Stripe account",
    intro:
      "Every sale is charged on your account, in your name. We never hold your sales, so there is no balance of yours for us to freeze, delay or set a minimum on.",
    badge: WORKING,
    accent: "from-violet-brand to-pink-brand",
    visual: "stripe",
    plan: "creator",
    group: "paid",
    menu: { label: "Your own Stripe", description: "The money lands in your account, not in ours.", icon: "bank" },
    related: ["currencies-and-ways-to-pay", "checkout", "memberships", "instant-delivery"],
    blocks: [
      {
        kind: "how",
        title: "How it works",
        items: [
          { title: "Connect Stripe from your studio", body: "You get a full Stripe account in your name, with your own login and dashboard at stripe.com." },
          { title: "Buyers pay you directly", body: "The charge, the receipt and the line on your buyer's card statement carry your business name, not ours." },
          { title: "Stripe pays you out", body: "On the payout schedule you set in your own Stripe dashboard. There is nothing for us to release." },
        ],
      },
      {
        kind: "table",
        title: "Where the money sits",
        note: "Stan's structure checked on its own help center and terms in September 2026.",
        head: ["", "Platform-held model", "Marktmorgen"],
        rows: [
          ["Whose Stripe account", "One the platform manages for you, with no Stripe login of your own", "Yours: a full Stripe account in your name, with your own login"],
          ["Who can pause the money", "The platform, by policy", "Your bank and Stripe's own rules"],
          ["Getting paid", "A cash-out or payout on the platform's terms, above a minimum", "Your Stripe payout schedule"],
          ["If you leave", "You migrate customers and payouts", "Nothing to migrate — the account was always yours"],
        ],
      },
      {
        kind: "features",
        title: "What that means in practice",
        items: [
          { icon: "percent", title: feeWords().cardTitle, body: feeWords().cardBody },
          { icon: "receipt", title: "You are the seller", body: "The sale is yours, in your name. Refunds and disputes are handled in your own Stripe dashboard." },
          { icon: "door", title: "Nothing to take with you", body: "Customers, members and payouts were always on your account. Leaving costs you nothing to move." },
        ],
      },
      {
        kind: "limits",
        title: "The honest limits",
        items: [
          `Card payments run on Stripe. Buyers meet the ways to pay your Stripe account has on, and Stripe's own PayPal is not one to count on: Stripe offers it only to accounts in the EU (except Hungary), the UK, Switzerland, Norway and Liechtenstein, and its documentation lists it as not supported for direct charges, which is how every sale here is charged. ${paypalConnectionWords()}${paypalAtCheckout() ? "" : " Stan lets creators connect a PayPal Business account."}`,
          "You need a Stripe account in one of the 42 countries the studio offers — the United States, Canada, the United Kingdom, Australia, Japan, Singapore, Mexico and most of Europe among them, but not everywhere.",
          "Because we never touch your money, we cannot advance it, split it with an affiliate automatically, or refund a buyer for you.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about your Stripe account",
        items: [
          // 534 [FQ1], unit 8: what someone starting out asks, answered by the code (lib/your-stripe-faq.ts).
          ...stripeBeginnerQuestions(),
          { q: "What do I pay Marktmorgen?", a: feeWords().whatYouPay },
          { q: "Who handles refunds and disputes?", a: "You do, in your own Stripe dashboard, with the same tools any business has. A refund is a refund you issue, not a request you file with us." },
          { q: "Can I charge in euros or pounds?", a: "Yes. Each store charges in one currency, which you choose in your studio from 15. The ways to pay are the ones you switch on in Stripe." },
          { q: "What happens to my money if Marktmorgen closes?", a: "Nothing. It was never here. Your Stripe account, your customers and your payouts carry on without us." },
        ],
      },
    ],
  },
  {
    slug: "instant-delivery",
    section: "platform",
    eyebrow: "Instant delivery",
    title: "The file lands",
    highlight: "the second the payment clears",
    intro:
      "No manual sending and no waiting for an email. Stripe confirms, and the download is on the buyer's screen — and if they lose it a month later, they get it back themselves.",
    badge: WORKING,
    accent: "from-mint-brand to-sky-brand",
    visual: "delivery",
    plan: "creator",
    group: "deliver",
    menu: { label: "Instant delivery", description: "On screen when paid, and back by email whenever it is lost.", icon: "bolt" },
    related: ["license-keys", "pdf-stamping", "price-options", "courses"],
    blocks: [
      {
        kind: "how",
        title: "From paid to delivered",
        items: [
          { title: "Stripe confirms the payment", body: "Nothing is released before Stripe says it is paid. An unpaid or unfinished checkout gets a clear refusal, not a file." },
          { title: "The download is on screen", body: "Tied to that order, and working for three days. The file itself is never at a public address." },
          { title: "Lost later? Back by email", body: "“Bought something here? Get it again” on every store: the address they paid with gets back everything bought with it, any time." },
        ],
      },
      {
        kind: "features",
        title: "What you can hand over",
        items: [
          { icon: "file", title: "Files up to 5 GB", body: "PDF, ePub, ZIP, images, audio, video, text, and Word, Excel and PowerPoint. Large files upload in parts, so a dropped connection costs one part." },
          { icon: "link", title: "Or a link", body: "Too big, or not a file at all — a Drive folder, a Notion page, a private video — and the buyer is sent there the moment they pay." },
          { icon: "download", title: "200 GB of downloads a month", body: "A published limit, shown in your studio as it is used. Going over never cuts a buyer off; your store keeps working as usual." },
          { icon: "shield", title: "Nothing that runs", body: "Programs, installers and scripts are refused, so a taken-over account cannot hand out malware." },
          { icon: "mail", title: "A confirmation email", body: "Every buyer gets one from your store's name: what they bought, what they paid and the way back to it. Replies reach you." },
          { icon: "chat", title: "A note from you after paying", body: "Tell buyers what to do first, on the thank-you page under what they bought and in their confirmation email: your words, a welcome video from YouTube, Vimeo or Loom, and one button to your group, a booking or a next step." },
          { icon: "refresh", title: "Sent again from your studio", body: "A buyer who cannot find it? Send the purchase email again from your list of sales. It goes only to the address they paid with." },
          { icon: "key", title: "A license key with each sale", body: "One key per buyer, never given twice, on the thank-you page, in the email and in their list of purchases.", href: "/platform/license-keys" },
          { icon: "file", title: "The buyer's email on their PDF", body: "Switch on stamping and every page of the PDF they download carries their email, the date and their order.", href: "/platform/pdf-stamping" },
          { icon: "file", title: "The first pages, free to read", body: "Let anyone read the first 1 to 10 pages of a PDF before buying. They get a separate PDF holding only those pages; the rest of the file never leaves your store." },
        ],
      },
      {
        kind: "facts",
        title: "What the tests cover",
        items: [
          { value: "402", label: "Refused when the payment is not confirmed", tone: "" },
          { value: "410", label: "Refused after the three-day window, which is when getting it again by email takes over", tone: "" },
          { value: "502", label: "Honest error when Stripe is unreachable", tone: "" },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "Stamping a PDF discourages sharing; it does not stop it, and it covers PDFs up to 50 MB.",
          "Getting a purchase back needs the address the buyer paid with. If they typed it wrong, you see the sale in Stripe and can send the file yourself.",
          "A link you sell stays wherever you keep it: we cannot take it back from someone who has it.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about delivery",
        items: [
          // 534 [FQ1], unit 6: what someone starting out asks, answered by the code (lib/delivery-faq.ts).
          ...deliveryBeginnerQuestions(),
          { q: "How does a buyer get a file again after three days?", a: "At the bottom of your store page: “Bought something here? Get it again.” They type the address they paid with and receive a link to a page with everything that address bought from you, read from your Stripe account. No account and no password." },
          { q: "Can a buyer pass the download around?", a: "The download is tied to their order and to a short window, and the file is fetched through a link that expires in minutes. A leaked link does not become a free copy for everyone. With stamping on, a PDF also carries the buyer's email on every page." },
          { q: "What if a buyer was refunded?", a: "A sale you refunded in full stops downloading at once and no longer appears when they ask to get their purchases again, because both read your Stripe account each time. A partial refund keeps both. A file already saved cannot be taken back." },
        ],
      },
    ],
  },
  {
    slug: "email",
    section: "platform",
    eyebrow: "Email to your list",
    title: "Write to the people",
    highlight: "who asked to hear from you",
    intro:
      `One-off emails, emails for later and sequences that send themselves, under your name, to everyone who agreed. Up to ${PRO_EMAILS} a month on Studio.`,
    badge: { label: "Working today, on Studio", tone: "live" as const },
    accent: "from-violet-brand to-sky-brand",
    visual: "email",
    plan: "pro",
    group: "grow",
    menu: { label: "Email to your list", description: "Broadcasts and sequences, only to people who agreed.", icon: "mail" },
    related: ["email-platforms", "reviews", "memberships", "domain"],
    blocks: [
      {
        kind: "how",
        title: "How your list grows and hears from you",
        items: [
          { title: "People join", body: "A free product for an email, or a box checked at checkout. Every free-product address is confirmed from its own inbox." },
          { title: "Sequences welcome them", body: "A welcome when someone joins, a few emails after someone gets one product, after the first time they buy anything at all, or once another sequence gives them a label. Each person goes through a sequence once." },
          { title: "You write when you have news", body: "To everyone who agreed, to everyone who has bought something, to everyone who has not bought yet, or to the people who got one product. Now, or at the time you choose." },
        ],
      },
      {
        kind: "features",
        title: "What every email carries",
        items: [
          { icon: "user", title: "Your name, your replies", body: "Emails go out under your name, and replies come to you." },
          { icon: "layout", title: "Design an email in blocks", body: "Headings, text, lists, buttons, lines across and pictures, laid out block by block with the email shown beside it as it is sent, buttons in your store's color, or written in its box: both write the same email. Four templates to start from, whose parts to write are marked, and an email still holding one cannot go out." },
          { icon: "camera", title: "Pictures in your emails", body: "Add up to six pictures to an email or a sequence step, where the cursor is, with what each shows for readers who cannot see it. Each is made smaller on your device and kept on this site, so it shows in Gmail, Apple Mail and Outlook alike, and readers without pictures see its description." },
          { icon: "ban", title: "One-click unsubscribe", body: "In every email, and in the header mail apps use. Whoever leaves is never written to again, whatever a later import says." },
          { icon: "shield", title: "Delete a person from your whole store", body: "From their page under Buyers, you or an Admin delete someone from every part of your store at once, after reading what goes and what stays; people can do it themselves from the link at the foot of your store's page, and you are emailed when they do. A one-way fingerprint of the address keeps your store from ever writing to them again, and no import or API call puts them back. Their payments stay on your Stripe account, and their posts in your community stay without their name." },
          { icon: "pin", title: "Your postal address", body: "In every email, as US law (CAN-SPAM) requires of commercial email, with a line on why the reader is getting it." },
          { icon: "shield", title: "Dead addresses taken off for you", body: "An address that cannot be delivered to, or whose owner reports an email as spam, is taken off your list by itself and never written to again. Mail apps judge a sender by exactly those two things." },
          { icon: "download", title: "Your list is yours", body: "Download it as a CSV any time, from any plan. Bring one in from a spreadsheet, up to 50,000 addresses a file, confirming each time that those people agreed.", href: "/platform/switching-to-marktmorgen" },
          { icon: "download", title: "Your whole store as one file", body: "Your products and their pages, posts, courses with every lesson's text, forms and their answers, contacts and a summary of your orders, downloaded as one file from your studio: from your studio's requests by its size while a plan runs, and up to five times once it has ended, before your store closes 30 days later. Files and videos download from their own pages." },
          { icon: "target", title: "Sequences that stop selling to buyers", body: "End a sequence for anyone who buys, or gets one product, checked before each email, so a launch sequence never pitches the course to somebody who already owns it. And send any email of it only to those who have a product or do not, who have bought or not yet, or who carry a label, from your import or from a sequence; everyone else skips it or leaves the sequence there. Or only to those who used a link in the email before, or did not: counted only for readers who allowed it with a box of their own when they joined, and never from opens." },
          { icon: "ladder", title: "Steps that act, not only emails", body: "A step can give someone a label, take one off, start them on another sequence or tell your webhooks, with the same conditions an email has, and a sequence can split its people into halves A and B to try two versions on one list. “If they used the link and have not bought, label them interested”, and a sequence that starts with that label takes it from there: automations, in the sequences you already have." },
          { icon: "ladder", title: "Workflows that branch, with a goal and a history", body: "Any step can be an IF/ELSE: those its condition holds for do it and go on to a later step you choose, everyone else goes to another, or the run ends. A goal (bought anything, got one product, carries a label) ends a run before its next step. Before switching a workflow on, preview the exact path someone would take: describe them, or pick someone from your list. New workflows are saved paused. Every run keeps its history: each step attempted, then confirmed, failed or uncertain. An uncertain step is never repeated by itself; the run waits for you to say it went through, try it again or end it." },
          { icon: "play", title: "Two sequences written for you", body: "A welcome for everyone who joins and a thank-you after a first purchase, written from your store's name, products and links in one press. They are left switched off: nothing is sent until you have read one and turned it on." },
          { icon: "sparkle", title: "A whole sequence, written with AI, on " + AI_PLANS_WORDS, body: "Pick the moment it starts on and how many emails, 3 to 7, and AI writes them from your products' names, prices and links, in your store's language, paced a few days apart. Only your store's own links stay in; nothing goes out until you read it and save it." },
          { icon: "refresh", title: "Tell buyers about an update", body: "A new edition, more templates, new lessons: one press emails everyone who bought that product, with your words and the link to get the new version, in your store's language. Once a week at most per product, with a link to stop these emails." },
          { icon: "chart", title: "What each email brought", body: "Links to your store in an email carry that email's tag, so the visits it brought and the sales made on the page a link opened are counted for it, the sales read from your own Stripe account. One tag per email, never one per reader: no tracking pixel and no open rate. Who used a link is kept only in sequences, only for readers who allowed it, and only to choose their next email." },
          { icon: "flask", title: "Two subject lines, the better one to the rest", body: "Try a second subject on 20%, 30% or 50% of a list of 100 people or more, half each, chosen at random. After the hours you choose, everyone else gets the one whose links brought more visits or sales for each email sent. When neither did better they get the first, and your studio says so with the counts." },
          { icon: "mail", title: "An email you sent, published on your store", body: "Press Publish on your store under a sent email and it gets a page of your store, listed with every other one you chose at /letters, in your store\u2019s look. Nothing is published by itself, and you are asked first, because anyone can read it once it is. Only its subject and words go up, with the links as you typed them, never who received it. Take it off and its copy is deleted." },
          { icon: "repeat", title: "An email that worked, used again", body: "From the list of what you sent: write it again as a new email, or keep sending it by itself to everyone who joins from now on. Written only to those who had not bought, or did not own a product, it keeps going only to them. It becomes one more email of a sequence you can open, pause or delete, counted in the same monthly emails." },
          { icon: "sparkle", title: "A first draft with AI, on " + AI_PLANS_WORDS, body: "Pick what the email is for and which product it is about, say it in a few words, and the subject and body are filled in for you to read and change, with the product's link. Your unsubscribe link and postal address are added at the bottom as always." },
          { icon: "chat", title: "Announcements to your community", body: "A post in your community can also go by email to the members who asked for it, counted in the same monthly emails.", href: "/platform/community" },
          { icon: "star", title: "One email that asks for a review", body: "Switch it on and each buyer is asked once per order, 3 to 30 days after buying, for an honest review. Counted in the same monthly emails.", href: "/platform/reviews" },
          { icon: "list", title: "Fields of your own, and deals in pipelines", body: "Up to 10 things you keep about each person — their company, a date, which offer interests them — filled in on their page and written into your list's file as columns. And deals: people you are talking to about a sale made outside a checkout, with what each is worth, in pipelines of their own (coaching, partnerships), each with stages you name and order, open, won or lost. Each pipeline adds up its open, won and lost deals from the values you recorded, nothing forecast; removing a stage or a pipeline asks where its deals go. " + pipelineLimitWords() + " Only your team sees them. A workflow can start when your team moves a deal with someone on your list into a stage you choose." },
          { icon: "type", title: "Drafts your team can write", body: "Up to 20 drafts per store. An Editor writes one; you or an Admin reads it and sends it.", href: "/platform/teams-and-stores" },
        ],
      },
      {
        kind: "uses",
        title: "What creators send",
        items: [
          { icon: "gift", who: "After the free guide", what: "Three emails over a week that end with the product the guide was the first step of, and stop the day they buy it." },
          { icon: "book", who: "After a purchase", what: "How to get the most from it, and a word about the next thing when they are ready." },
          { icon: "mail", who: "When something is new", what: "A launch, a new season of the plan, a date for the next cohort." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "Email layouts use one column. You can start from four templates or design your own with headings, text, lists, buttons, dividers and up to six pictures.",
          "No open counts, on purpose: nothing in an email reports back. A visit is a page of your store opened through one of the email's links, so a link to anywhere else is not counted, and a sale is one made on the page a link opened; somebody who comes back later by themselves is not counted for it.",
          "A test compares two subject lines, not two versions of the email itself, and only for a one-off email, not a sequence.",
          `During the free trial a store sends up to ${TRIAL_EMAILS} emails; the full ${PRO_EMAILS} opens with the first payment.`,
          `${workflowLimitWords()} A workflow starts from a deal stage only when your team makes or moves a deal there, not when a form response becomes a deal, a workflow step moves it, or a stage is removed; each stage starts one workflow. A step that acts gives or takes off a label, starts another workflow, sets a field, moves or assigns a deal, writes a note, emails you or tells your webhooks: it does not wait for a reply, read an open, send a text message, or grant or take away access to a course or community, and a label an import brought starts nothing. Branches only go forward, so a run never loops.`,
          `Every store sends from the same sender, so one bad list could cost everyone their inbox. ${healthRuleWords()} Nothing waiting is lost.`,
          rampRuleWords(),
        ],
      },
      {
        kind: "faq",
        title: "Questions about email",
        items: [
          { q: `Why is email on Studio and not on the ${PLAN_AT.creator} plan?`, a: `Because every email sent costs us money, and the ${PLAN_AT.creator} plan is priced to cover a store, not a mailing list. Stan puts email on its $99 plan as well — read on its pricing page on September 20, 2026.` },
          { q: "Can I import the list I already have?", a: "Yes, on every plan, from a CSV file of up to 50,000 rows, as long as those people agreed to hear from you. You confirm that each time, a consent column in the file narrows it further, and anyone who unsubscribed here stays unsubscribed. Nobody is emailed because of the import." },
          { q: `What if my list needs more than ${PRO_EMAILS} emails a month?`, a: `Move up to Scale from your studio: the same plan with up to ${SCALE_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month, at $${PLAN_PRICES.scale.month / 100} a month or $${(PLAN_PRICES.scale.year / 100).toLocaleString("en-US")} a year. You are charged the difference for the rest of the period you already paid for, and you can go back to Studio whenever you like. Without it, an email that passes the month's number waits and goes out by itself when the month turns.` },
          { q: `Can I email people on the ${PLAN_AT.creator} plan at all?`, a: `Your list downloads as a CSV on every plan, and on the ${PLAN_AT.creator} plan your store can send the people who agree straight to your own Mailchimp, Kit, beehiiv or MailerLite. Writing to them from Marktmorgen is what Studio adds.` },
        ],
      },
    ],
  },
  {
    slug: "domain",
    section: "platform",
    eyebrow: "Your own domain",
    title: "Your store,",
    highlight: "on your own domain",
    intro: DOMAINS
      ? "shop.yourname.com or yourname.com, with the certificate made and renewed for you. Your marktmorgen.com address keeps working as well."
      : "shop.yourname.com or yourname.com, on the Studio plan. It is not switched on here yet, and this page says so rather than pretending.",
    badge: DOMAINS ? { label: "Working today, on Studio", tone: "live" as const } : { label: "Coming to Studio", tone: "building" as const },
    accent: "from-sky-brand to-mint-brand",
    visual: "domain",
    plan: "pro",
    group: "grow",
    menu: { label: "Your own domain", description: "shop.yourname.com, with the certificate handled.", icon: "globe" },
    related: ["store-page", "email", "insights", "your-stripe"],
    blocks: [
      {
        kind: "how",
        title: "Three steps, most of them waiting",
        items: [
          { title: "Type the domain you own", body: "In your studio, on Studio. A domain you already have, bought wherever you like." },
          { title: "Add one record", body: "The studio shows exactly what to add where you bought it — usually one record, sometimes a second to prove it is yours." },
          { title: "Press Check again", body: "When the record shows up, usually within minutes, your store opens on the domain with its own certificate." },
        ],
      },
      {
        kind: "features",
        title: "What changes, and what does not",
        items: [
          { icon: "globe", title: "The whole store moves with it", body: "Its pages keep their short paths on your domain: the thank-you page, courses, bookings and getting a purchase again." },
          { icon: "link", title: "Old links keep working", body: "marktmorgen.com/@yourname stays up, so nothing you shared before breaks." },
          { icon: "lock", title: "The certificate is handled", body: "Made for you when the record shows up, and renewed for you." },
          { icon: "door", title: "If Studio ends", body: "Visitors to the domain are sent to your marktmorgen.com address, so no buyer meets a dead page." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "We do not sell domains. You buy one wherever you like and keep it there.",
          "One domain per store.",
          "Email addresses on your domain are set up where you bought it, not here.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about your own domain",
        items: [
          // 534 [FQ1], unit 22: what someone starting out asks, answered by the code (lib/domain-faq.ts).
          ...domainBeginnerQuestions(DOMAINS),
          { q: "Does Stan offer this?", a: "No. Our comparison with Stan, checked against their own help center and pricing in September 2026, lists a custom domain as not available." },
          { q: "Who owns the domain?", a: "You do, and you keep access to its settings. If you ever leave, remove the record and point it wherever you like." },
          { q: "How long does it take?", a: "Adding it takes a minute. The record usually shows up within minutes, and can take up to 48 hours, depending on where you bought the domain." },
        ],
      },
    ],
  },
  {
    slug: "insights",
    section: "platform",
    eyebrow: "Your numbers",
    title: "See what sells,",
    highlight: "and where buyers come from",
    intro:
      "Visitors, checkouts, sales and conversion for the last 7, 30 or 90 days or all time, where each visit came from, every product and link on its own line, and all of it as CSV files. Counted without cookies.",
    badge: WORKING,
    accent: "from-mint-brand to-violet-brand",
    visual: "insights",
    plan: "creator",
    group: "grow",
    menu: { label: "Numbers and pixels", description: "Visits, sources, sales, and your ad pixels.", icon: "chart" },
    related: ["checkout", "store-page", "email", "your-stripe"],
    blocks: [
      {
        kind: "how",
        title: "How it is counted",
        items: [
          { title: "Visits, without cookies", body: "A visitor is one person on one device on one day, told apart by a one-way fingerprint that is never stored. Your own visits are not counted." },
          { title: "Sources, even from apps", body: "Instagram and TikTok hide where a visit came from, so we read the app's name. Add utm_source, utm_medium and utm_campaign to a link to count it under your own words." },
          { title: "Sales, from Stripe", body: "New purchases and new members are read from your own Stripe account, not counted by us." },
        ],
      },
      {
        kind: "features",
        title: `Your ad pixels, on the ${PLAN_AT.creator} plan`,
        intro: "Stan puts advertising pixels on its $99 plan, according to its pricing page, read on September 20, 2026.",
        items: [
          { icon: "target", title: "Meta, Google, TikTok and Pinterest", body: "Paste the pixel's ID. Your pages report every view, every checkout started, every lead and every purchase with its amount." },
          { icon: "shield", title: "Asked first, where the law says so", body: "Visitors in the European Economic Area, the UK, Switzerland and Brazil are asked in plain words, and nothing loads unless they say yes." },
          { icon: "eye", title: "Global Privacy Control respected", body: "Everywhere else, a browser that sends it gets no pixels." },
        ],
      },
      {
        kind: "features",
        title: "Your numbers, to keep",
        items: [
          { icon: "download", title: "Sales as a file", body: "Every paid sale for the last 30 or 90 days or all time, read from your Stripe account, as a CSV. Up to 5,000 sales in one file, and it says so when there are more." },
          { icon: "chart", title: "Visits and sources as files", body: "Your visits day by day, and where visitors came from, as CSV files." },
          { icon: "target", title: "Every product on its own line", body: "Each product's page views, checkouts started, sales and revenue side by side for each window, with how many sales every 100 views of its page brought. No cookie." },
          { icon: "chart", title: "Complete figures in API and periodic summaries", body: "The public numbers API marks incomplete paid readings explicitly and keeps unknown amounts unavailable. Weekly and monthly summaries preserve traffic, withhold partial sales or renewal totals and wait for complete payments before reporting goal progress, the best day or revenue by channel." },
          { icon: "mail", title: "Your week, every Monday", body: "An email with the week's visitors, checkouts, sales and the three channels that brought the most, while your store has visitors. One click at its foot stops it, and the busy-day note with it." },
          { icon: "eye", title: "Where in the world, and on what", body: "Page views by country and by phone, tablet or computer, for the last 7, 30 and 90 days. Counted, not guessed, and nothing about who." },
          { icon: "chart", title: "Which channel made you money", body: "Every sale, and every renewal after it, under the channel that brought the buyer: a link you tagged, a site, or the Instagram or TikTok app, remembered for 30 days so a buyer who comes back later by typing your address still counts where they came from. Beside it, where buyers first found you, and the path from visit to checkout to sale." },
          { icon: "link", title: "Which post made you money", body: "Make a link for one post — the October reel, issue 12 of your newsletter — and see what that post brought: visits, sales and revenue, post by post." },
          { icon: "eye", title: "Who is on your store right now", body: "How many people opened your store page in the last five minutes, and where they came from. Nobody is named." },
          { icon: "mail", title: "A note on a busy day", body: "When your store is clearly busier than usual, an email says so while it is happening, and where the visitors are coming from, so you can answer comments or post again. At most once a day." },
          { icon: "sparkle", title: "Ask your AI assistant", body: "Connect Claude, ChatGPT or another assistant to your numbers with your API key, and ask in plain words. It reads; it changes nothing, and it never sees your buyers' addresses." },
          { icon: "chart", title: "Up or down, at a glance", body: "Every figure beside the same stretch before it: visitors, checkouts, sales and revenue against the 7, 30 or 90 days before. The weekly email says it too." },
          { icon: "notebook", title: "Notes on the chart", body: "Mark the day you posted, launched or changed a price, and the mark sits under that day's bar, so a rise has its reason beside it." },
          { icon: "target", title: "Profit, not only revenue", body: "Type what an ad or a sponsored post cost and the days it ran, and each channel and post shows what was left after it and what came back for every dollar." },
          { icon: "mail", title: "Where buyers say they heard of you", body: "After paying, buyers can tap one answer: a friend, a message, a podcast, Instagram. It finds what no link can see. You can switch it off." },
          { icon: "eye", title: "Your store page, item by item", body: "How far down your store page people go, and of those who reach each product or link, how many click it, so you know what to move up." },
          { icon: "sparkle", title: "Visits from AI assistants", body: "Someone who found you through ChatGPT, Perplexity, Claude, Gemini or Copilot is counted under that name, not lost in direct." },
          { icon: "mail", title: "A note when sales stop", body: "When your store goes clearly longer than usual without a sale, an email says so, with what to check first. Measured against your own pace, so a quiet week that is normal for you stays quiet." },
          { icon: "users", title: "Who stays", body: "For memberships: the share of each month's new members still paying one, two, three, six and twelve months later, and which channel brings the members who stay." },
          { icon: "sparkle", title: "Worth knowing, in words", body: "The few things worth acting on, said as sentences at the top of your numbers and in the Monday email: an ad that cost more than it brought, a product opened often and not bought, checkouts started and not paid." },
          { icon: "target", title: "Conversions sent from the server too", body: "With a token from Meta, TikTok, Google Analytics or Pinterest, each purchase is sent from our server the moment Stripe confirms it, even when the buyer closes the tab, marked as a new or returning customer. Membership renewals and free sign-ups go too. Only for visitors who allowed ad measurement." },
          { icon: "chart", title: "Which ad sold", body: "Put utm_content on each ad's link, as Meta, TikTok and Google can do for you, and every sale is credited to the ad it came from, remembered for 30 days like the channel." },
          { icon: "globe", title: "Sales by the buyer's country", body: "Where your money comes from, by the country on each payment, beside where your visitors are: where people come and do not buy." },
          { icon: "refresh", title: "Refunds by channel and product", body: "Each refund under the channel and the product of the sale it gave back, and what one buyer from each channel came to, renewals in and refunds out." },
          { icon: "list", title: "Searched for and not found", body: "What visitors typed in your store's search and found nothing for: a product to make, or a word your titles are missing." },
          { icon: "chat", title: "What stops visitors from buying", body: "Turn it on, and a visitor who has seen the buy box, stayed and not paid can tap what holds them back: the price, the fit, the details. Asked once, of one visitor in eight at most." },
          { icon: "play", title: "How far your sales video is watched", body: "Of those who reach the video, how many press play, and how many watch a quarter, half and to the end. YouTube and Vimeo say how far; Loom says it was played." },
          { icon: "mail", title: "The Monday email for your team", body: "Choose who on your team gets the weekly email too. Each has a link that stops only their copy." },
          { icon: "users", title: "Why members cancel", body: "When a member cancels, Stripe's page asks why: too expensive, not used enough, something missing. The answers are added up for you, with the revenue each reason cost and the latest words members wrote, without their names." },
          { icon: "mail", title: "A note when a checkout will not open", body: "If Stripe refuses to open your payment page — your account needs something, a price was archived — you get an email that day with Stripe's own reason and what usually puts it right, instead of finding out from a quiet month." },
          { icon: "target", title: "After refunds and ads", body: "Each channel's payments, including renewals, less recorded refunds and ad spend. The result waits when figures are incomplete. Before fees, tax, commissions and other costs; not profit or an instruction to increase a budget. Said in the Monday email too. Download the selected days as a CSV with the dates, currency and coverage of the figures." },
          { icon: "users", title: "Buyers who buy again, by channel", body: "Buyers grouped by the channel of their first observed purchase, with repeat purchases and revenue per buyer. The 30-day rate counts only buyers observed for a full 30 days. Up to 180 days of history, not predicted lifetime value. Download these channel totals as a CSV without buyer identities." },
          { icon: "chart", title: "Independent payment and refund coverage", body: "Daily and channel results keep unknown payment totals blank in the dashboard, CSV downloads and connected analysis. Payments include renewals and have their own coverage check: a failed refund reading leaves complete payments available, while missing purchases or renewals withhold paid totals and derived results. Recorded ad spend stays available." },
          { icon: "chart", title: "Dashboard totals with independent coverage", body: "Sales, revenue and conversion wait for complete purchase readings. Visits and checkouts remain visible, and product ranking uses traffic when paid amounts are unavailable. The all-time reading has its own coverage check, so complete history can still be shown when the recent reading is partial." },
          { icon: "link", title: "Complete figures for funnel and product analysis", body: "The numbers assistant and connected funnel/product reports withhold paid totals and conversion rates on partial purchase readings. Traffic remains available, and paid-derived alerts wait for complete figures rather than interpreting missing purchases as a drop in sales." },
          { icon: "link", title: "Consistent channel figures for connected assistants", body: "Channel reports sent to connected assistants include explicit payment coverage, first-visit payments with no identified channel and variant scope notes. Incomplete paid readings and missing first-visit details remain unavailable instead of becoming zero or complete totals." },
          { icon: "link", title: "Search and sort campaign results", body: "Find campaigns by name or recorded payment/ad channel, sort by visits, paid records, amounts, ads or recorded gross less ads, and download the displayed view. Unknown figures remain unknown and sort last when ordering by that metric; a separate download keeps the full report." },
          { icon: "link", title: "Compare payments with the previous period", body: "Compare equal consecutive 7- or 30-day UTC periods by channel, including channels with payments in only one period. See payment differences and changes in share, download CSV or ask your numbers assistant. Complete payments remain available independently of refund coverage; results after refunds still wait for their own complete reading. A missing complete previous period remains unavailable." },
          { icon: "link", title: "See payment concentration by channel", body: "See the largest identified channel, the top three and payments without an identified marketing channel. Every share uses all recorded payments, including renewals. Download the breakdown or ask your numbers assistant. Complete payments remain available independently of refund coverage; incomplete purchase or renewal readings remain unavailable." },
          { icon: "link", title: "Compare first and last visits", body: "Keep unattributed sales in both visit models, compare them with buyer answers and download the comparison as CSV. Alternative visit readings are not added together; buyer answers cover respondents and the day they answered. Incomplete purchase readings wait for complete figures." },
          { icon: "link", title: "Links for campaigns and ad variants", body: "Create links for organic posts, email campaigns and paid ads, with an optional creative or link variant. Existing tracking tags are replaced without duplicates; other query values and page anchors are preserved. Reused creative names remain separate by channel and campaign in your paid-record reports. Download all variant results as CSV, including rows beyond the first 15 shown; incomplete purchase readings wait for complete figures." },
          { icon: "target", title: "Campaigns with recorded ad spend", body: "Campaign tags combined across channels, with visits, paid records, gross amounts and recorded ad spend. All recorded payment and ad channels are shown, and spend-only campaigns stay visible. Untagged spend is disclosed separately. Download the report or ask your numbers assistant; gross less ads is before refunds and other costs, not profit." },
          { icon: "calendar", title: "Daily result after refunds and ads", body: "Payments, recorded refunds and ads for each UTC day, including renewals. Multi-day ad entries preserve every smallest currency unit when split across days. Download the daily figures as CSV or ask your numbers assistant; incomplete results stay unknown, and this is before fees and other costs." },
          { icon: "refresh", title: "Recorded refunds by channel", body: "Refund records and amounts beside payments received in the same days, including renewals. Purchases may have been earlier, so the amount ratio is not a refund rate for those sales. Only complete, matched readings; CSV download and the same figures in alerts and your numbers assistant." },
          { icon: "users", title: "Repurchase by first purchase week", body: "See which weeks brought buyers who purchased again within 7, 30, 60 and 90 days. Each rate uses only buyers with the full observation time and shows its denominator. Up to 180 days of history, CSV download and the same figures available to your numbers assistant." },
          { icon: "refresh", title: "When ads paid for themselves", body: "How many days it took a channel's money — first sales and the renewals of the members it brought — to cover what you spent there." },
          { icon: "download", title: "Your buyers, for ad audiences", body: "A file of your buyers who agreed to hear from you, in the format Meta and TikTok take, to stop showing ads to people who already bought or to find more like them." },
          { icon: "chat", title: "Your numbers in Slack or Discord", body: "Paste a channel's webhook address and the week's numbers are posted there every Monday, and the month's on the 1st." },
          { icon: "target", title: "A goal for the month", body: "Set what you want the month to bring, and see progress and pace once purchases and renewals have been read completely. Incomplete payment readings leave goal progress unavailable while you can still set or change the target. Goal alerts and highlights of the best payment day or week also wait for complete figures. In the Monday email too." },
          { icon: "mail", title: "Your month, on the 1st", body: "An email with the month's visitors, sales and money beside the month before, where the money came from, its best day and your goal. The same link stops it." },
          { icon: "sparkle", title: "Records", body: "Your best day and your best week of the last 90 days, said when they happen, so you can find what you did and do it again." },
          { icon: "globe", title: "Google searches that found you", body: "What people typed into Google when your store came up: each search, how many clicked, how often you were shown and where you stood. Read for you from our own Search Console; you connect nothing." },
          { icon: "eye", title: "Today so far", body: "Today's visitors, checkouts, sales and money, and where today's visitors came from, beside who is on your store right now: the view for the day of a launch." },
          { icon: "chart", title: "Each step against the period before", body: "From visit to checkout and from checkout to sale, each step's rate now beside its rate in the same stretch before, so you see which step changed." },
          { icon: "ban", title: "Your own people left out", body: "Your visits and your team's while signed in are not counted, and you can mark the phone or browser you check your store from so it never is." },
          { icon: "chart", title: "The next three months of memberships", body: "Your recurring revenue three months from now if the last 90 days' pace of members joining and leaving holds. Said as an estimate, and only once enough members make a pace." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "Renewals — memberships renewed and later plan payments — are shown apart from revenue, for up to the last 90 days, and by channel only for memberships sold from October 11, 2026; all of them are in your Stripe dashboard.",
          "A channel is remembered in the buyer's browser, so one who changes device, clears cookies or is in a place where the law asks first (the EU, the UK, Switzerland, Brazil) is credited only by the tags on the page they bought from.",
          "Ad spend is what you type in; it is not read from the ad networks. Profit there is before Stripe's fee and leaves out renewals that came later.",
          "How far your pages are read is measured on one visitor in eight, chosen at random, to keep it inside what a visit costs; shares are shown once 30 are measured.",
          "Purchases are sent from the server to Meta and TikTok; Google and Pinterest are told by their pixel alone. Refunds are read for the last 90 days, and one is put under a channel when the sale it gave back is from the last 180.",
          "All time starts at the first visit still on record; daily visits are kept for about thirteen months.",
          "Records and payback read the last 90 days of money, so a best day is the best of those 90, and payback counts money the channel brought without ads too.",
          "A member's reason for canceling is there only when they cancel on the page your emails link to; one you cancel in Stripe has none.",
          "Google searches are shown for stores at marktmorgen.com, not on a domain of your own; Google leaves out searches made by very few people, and its figures arrive about two days late.",
          "A test compares two versions of one product's page, or two headlines, with no more than two at once. " + PAGE_TEST_WORDS,
        ],
      },
      {
        kind: "faq",
        title: "Questions about your numbers",
        items: [
          // 534 [FQ1], unit 23: what someone starting out asks, answered by the code (lib/insights-faq.ts).
          ...insightsBeginnerQuestions(),
          { q: "Do the visit counts set cookies?", a: "No. They set no cookie and keep no personal data, so there is nothing about them to ask a visitor. The ad pixels are different, which is why visitors are asked first where the law says so." },
          { q: "How do you know which channel a sale came from?", a: "From the tags on the page it was bought from, or, without tags, from the last place the buyer came from in the 30 days before (or the 7, 60 or 90 you choose), which a cookie of your store's remembers. Your numbers also set that beside the first place each buyer came from and what buyers said when asked. The channel is written on the payment in your own Stripe account, so you can check any sale there. Nothing about the buyer is kept by us, and where the law asks visitors first, or a browser asks not to be followed, no such cookie is set." },
          { q: "Why do my numbers differ from Stripe's?", a: "Sales here are new purchases and new members before Stripe's fee and any refund. Renewals and refunds are in your Stripe dashboard." },
        ],
      },
    ],
  },
  {
    slug: "community",
    section: "platform",
    eyebrow: "Community",
    title: "A community for the people",
    highlight: "who bought from you",
    intro:
      "One members' area on your store, with spaces, posts, comments, a live room, private messages, search and live events, open only to the buyers of the products you choose. Members come in with a link sent to their email: no account, no password.",
    visual: "community",
    badge: WORKING,
    accent: "from-violet-brand to-mint-brand",
    plan: "creator",
    group: "sell",
    menu: { label: "Community", description: "Posts and comments, open only to your buyers.", icon: "chat" },
    related: ["live-events", "memberships", "courses", "email"],
    blocks: [
      {
        kind: "how",
        title: "How people get in",
        items: [
          { title: "Choose what opens it", body: "Any paid product can: a course, a file, a call, or a membership while it is being paid for. Free products too, if you want them to. A bundle holding one of them opens it as well." },
          { title: "They come in by email", body: "A member types the address they paid with and opens the link we send. That browser stays in for 90 days." },
          { title: "Checked on every visit", body: "Who bought what is read from your own Stripe account. A membership that ends loses access within five minutes, and a member you take out loses it at once." },
        ],
      },
      {
        kind: "features",
        title: "What the community holds",
        items: [
          { icon: "list", title: "Up to 20 spaces", body: "Each with its own name and a line about what it is for. A space can be open to the whole community or kept for the buyers of the products you choose, and it can be yours alone to post in, with members still commenting." },
          { icon: "type", title: "Posts with a picture, and polls", body: "A title of up to 120 characters, up to 5,000 characters of text and one picture, which its writer can edit afterward, marked as edited for everyone. A post can carry a poll of up to 12 answers, one choice or several, with an end date if you want one." },
          { icon: "chat", title: "Comments, replies and likes", body: "Comments of up to 2,000 characters, one level of replies, up to 300 under a post, and one like per member on each post and each comment." },
          { icon: "star", title: "Points, levels and a leaderboard", body: "Every like a member's post or comment gets from somebody else is one point, and points make 9 levels, shown beside every name. A leaderboard for 7 days, 30 days and all time. A space can open for posting at a level, and a level can hand over one of your courses, free, for good." },
          { icon: "pin", title: "Pinned posts and Start here", body: "Up to three posts held at the top, and one post every member sees first." },
          { icon: "bolt", title: "A live room", body: "A room for talking while everyone is there, which keeps its last 500 messages. You can slow it down to one message every few seconds or minutes, keep web addresses out, keep it for your own messages, remove any message, empty it or close it." },
          { icon: "lock", title: "Private messages", body: "Members write to you privately, and to each other if you allow it. You can have a first message wait until the person it is sent to accepts it, and anyone can decline and not hear from that person again." },
          { icon: "eye", title: "One search box", body: "Posts and every comment under them, the lessons of the courses a member has, the events, the people in the directory, the room and the member's own messages. Each result is shown only to somebody who may open it." },
          { icon: "sparkle", title: "Mentions and notifications", body: "Members mention each other with @. They are told when somebody mentions them, comments on their post or answers their comment, in the community and, if they allow it, as a notification on their computer or phone." },
          { icon: "mail", title: "Announcements", body: "Posts labeled as yours. On Studio they can also go by email to the members who checked the box for it, with a one-click unsubscribe." },
          { icon: "video", title: "Live events", body: "Workshops and Q&As on the community's calendar, with RSVPs, reminders, a private video room in the page and replays.", href: "/platform/live-events" },
          { icon: "door", title: "Welcoming new members", body: "Up to three questions every member answers once, before their first post or comment, read only by you. And a welcome message sent privately from you on their first visit, when private messages are on." },
          { icon: "users", title: "A member directory they opt into", body: "Members choose the name they are seen by and whether to be listed. Their email address is never shown to other members." },
          { icon: "shield", title: "Reports and moderation", body: "Members report a post or a comment and it lands in your queue. You hide it, delete it, mute a member or take them out." },
          { icon: "clock", title: "Limits that stop a spammer", body: "Each member can make 5 posts an hour and 20 a day, 30 comments an hour, and 10 picture uploads an hour. You are never limited." },
          { icon: "phone", title: "In your store's look", body: "Your theme and color, and part of your store's installable app. Nothing in it is kept offline on a device." },
        ],
      },
      {
        kind: "uses",
        title: "What creators use it for",
        items: [
          { icon: "cap", who: "A course with a cohort", what: "Students of the course post their work and questions, and you answer where everyone can learn from it." },
          { icon: "repeat", who: "A paid monthly club", what: "Open it to a membership, and whoever stops paying stops seeing it, without you lifting a finger." },
          { icon: "users", who: "Coaching clients", what: "A space for wins, a space for questions, and your announcements pinned at the top." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        intro: "Said here so nobody signs up expecting it.",
        items: [
          "Posts and comments appear when a page is opened, not as they are written. The room checks for new messages every 5 seconds while people are talking and every 30 while it is quiet, and not at all in a background tab or after 20 minutes without a touch. Time in the room counts toward your plan's visits.",
          "Live events happen in a private Jitsi Meet room, at your own meeting link or in a Google Meet made on your connected Google Calendar. Unlike Stan's webinars, no Zoom link is made for you yet: connecting Zoom opens to every store once Zoom approves our app; until then, the Zoom option does not show.",
          "No emails about replies or mentions: those are told in the community and as notifications on a computer or phone. On iPhone, a notification needs the page added to the home screen, as Apple requires.",
          "Search does not listen to what is said inside a video: only titles and written text are searched. Private messages are searched in a member's 30 most recent conversations.",
          "One community per store.",
          "Up to 10,000 posts and 50,000 members in one community.",
          `Each billing month covers a number of buyer actions (posts, comments, likes, messages, RSVPs, pictures): ${STORE_ALLOWANCES.creator.buyer.toLocaleString("en-US")} on the ${PLAN_AT.creator} plan, ${STORE_ALLOWANCES.pro.buyer.toLocaleString("en-US")} on the ${PLAN_AT.pro} plan and ${STORE_ALLOWANCES.scale.buyer.toLocaleString("en-US")} on the ${PLAN_AT.scale} plan; past them members can still read everything, and what they would write waits for the next month. A community keeps up to ${COMMUNITY_PICTURES.creator.toLocaleString("en-US")}, ${COMMUNITY_PICTURES.pro.toLocaleString("en-US")} or ${COMMUNITY_PICTURES.scale.toLocaleString("en-US")} pictures in its posts.`,
          "No app-store app. It opens in the browser, and in your store's app on the home screen.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about the community",
        items: [
          { q: "How are points counted?", a: "One point for every like a member's post or comment gets from somebody else, and one taken away if that like is taken back. Your own likes earn you nothing, and the creator collects no points. Levels start at 5, 20, 65, 155, 515, 2,015, 8,015 and 33,015 points, and the leaderboard page shows every member exactly what each level opens." },
          { q: "Who can see what is posted?", a: "Only the people let in, and you. Community pages and their pictures are shown only to a browser that is let in, and they are kept out of search engines." },
          { q: "Can members see each other's email addresses?", a: "No. Other members see only the name someone chose, and the directory lists only those who asked to be listed. You see members' addresses in your studio, because they are your buyers." },
          { q: "What happens after a refund?", a: "A payment you refund in full on your Stripe account stops opening the community, within five minutes." },
          { q: "Can buyers I bring over from another platform get in?", a: "Yes. A buyer you import for a product that opens the community is let in, like anyone who bought it here." },
          { q: "Does Stan have this?", a: `Yes. Stan has a community, and its help center, read on September 27, 2026, adds webinars to it as a product members sign up for, with Zoom or Google Meet links made automatically. Ours holds live events members RSVP to, in a private video room, at your own link or in a Google Meet made on your Google Calendar, with no Zoom link made for you yet. Ours is on the ${PLAN_AT.creator} plan; emailing announcements needs Studio.` },
        ],
      },
    ],
  },
  {
    slug: "live-events",
    section: "platform",
    eyebrow: "Live events",
    title: "Live events",
    highlight: "inside your community",
    intro:
      "A workshop, a Q&A or a coworking hour for your members. They RSVP in the community, get a reminder, and join from the event's page: in a private video room shown right in the page, at your own meeting link, or in a Google Meet made on your Google Calendar. The way in shows 15 minutes before the start, and only to members who may come.",
    visual: "events",
    badge: WORKING,
    accent: "from-mint-brand to-violet-brand",
    plan: "creator",
    group: "sell",
    menu: { label: "Live events", description: "RSVPs, reminders and replays, for your members.", icon: "video" },
    related: ["community", "calls", "memberships", "phone-notifications"],
    blocks: [
      {
        kind: "how",
        title: "From the studio to the room",
        items: [
          { title: "Schedule it", body: "A title, a few words about it, a start in your time zone and a length from 15 minutes to four hours, up to a year ahead. Announce it in the feed if you want to." },
          { title: "Members RSVP", body: "One click in the community takes a place, and one gives it back. Each member sees the time in their own time zone, and can add it to their calendar." },
          { title: "Doors open 15 minutes before", body: "The event's page shows the room or your link to whoever may come, checked again on that visit. A member who keeps the page open sees it appear by itself." },
        ],
      },
      {
        kind: "features",
        title: "What an event does",
        items: [
          { icon: "calendar", title: "Up to 50 coming up", body: "And up to 500 kept in all, the past ones with their replays. After that, the oldest past event makes room for a new one." },
          { icon: "users", title: "A cap, if you want one", body: "From 1 to 5,000 places. With a cap, only members with a place see the way in, and two members pressing at the same second can never both take the last one." },
          { icon: "video", title: "A private room, in the page", body: "A Jitsi Meet room made for each event, with a name nobody can guess. Members press Join here to open it inside the event's page, or open it in a tab of its own. Nothing loads from Jitsi until they press. Best for small groups: for a big audience, use your own meeting link." },
          { icon: "link", title: "Or your own link", body: "Zoom, Google Meet, a livestream: any https address you already use, opened in a new tab." },
          { icon: "video", title: "Or Google Meet, made for you", body: "Connect your Google Calendar and pick it under Where: one meeting is made, with nobody on its guest list. Members see its link on the event's page from 15 minutes before, ask to join, and you let them in." },
          { icon: "lock", title: "For some buyers only", body: "Keep an event for the buyers of some of the products that open your community. Other members see it and what opens it, but cannot RSVP or join. Checked on every visit." },
          { icon: "mail", title: "Reminders a day and an hour before", body: "To the members who RSVP'd and asked for the community's emails, with a one-click way to stop. They lead to the event's page, never to the room itself." },
          { icon: "refresh", title: "Moved or canceled, everyone is told", body: "A new time or a cancellation is emailed once to everyone coming, whether or not they asked for the community's emails." },
          { icon: "play", title: "Replays", body: "Once it has started, add a replay from YouTube, Vimeo or Loom. It plays on the event's page for the members the event was for." },
          { icon: "phone", title: "Your phone, 15 minutes before", body: "A notification from the studio on your home screen, so you open the room first.", href: "/platform/phone-notifications" },
          { icon: "users", title: "Your team can run them", body: "Admins and Editors schedule, move and cancel events; Support sees who is coming.", href: "/platform/teams-and-stores" },
        ],
      },
      {
        kind: "uses",
        title: "What creators hold",
        items: [
          { icon: "cap", who: "A course with a cohort", what: "A weekly Q&A kept for the course's buyers, with the replay posted for whoever missed it." },
          { icon: "repeat", who: "A paid monthly club", what: "A live session every month. Whoever stops paying stops seeing the way in, with nothing for you to do." },
          { icon: "users", who: "A coaching program", what: "A group call for everyone in it, on the community's calendar, without selling each seat." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        intro: "Said here so nobody signs up expecting it.",
        items: [
          "Zoom links are not made for you yet: you choose the private room, a Google Meet made on your connected Google Calendar, or your own link. Connecting Zoom opens to every store once Zoom approves our app; until then, the Zoom option does not show. Stan's webinars create Zoom and Google Meet links automatically.",
          "With Google Meet, nobody is on the meeting's guest list: each member asks to join and you let them in. On a free personal Google account, Google ends meetings of three or more people after 60 minutes.",
          "Jitsi Meet is a free service run by a third party (8x8), not by us. Nobody needs an account to join, but the first person to open a room may be asked to sign in to Jitsi to start it, so open it a few minutes early.",
          "An event is for your community's members and is not sold on its own. To sell seats to anyone, sell live sessions on dates as a paid product.",
          "Nothing is streamed or recorded here. A replay is a video you put on YouTube, Vimeo or Loom: use an unlisted one, because anyone with its address can watch it.",
          "Reminders go only to members who checked the box for the community's emails, which starts empty. Moves and cancellations go to everyone coming.",
          "No chat beside the room, no polls and no waiting list when an event is full. An event cannot be moved once it has started.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about live events",
        items: [
          { q: "Which plan is it on?", a: `Every plan, the ${PLAN_AT.creator} one included, with the community. The reminders and the emails about a move or a cancellation are sent on every plan and are not counted in Studio's monthly emails.` },
          { q: "Can someone who is not a member get the link?", a: "Not from us. Emails, calendar files and the feed point to the event's page, and the page shows the way in only from 15 minutes before, only to a member who may come, checked again on every visit. A member whose membership lapsed, or who was refunded or taken out, loses it with the rest of the community." },
          { q: "How does this compare with Stan?", a: "Stan adds webinars to its community as a product members sign up for on its landing page, with Zoom or Google Meet links made automatically, according to its help center, read on September 27, 2026. Ours are events members RSVP to, with reminders, a cap, a room in the page or a Google Meet made on your Google Calendar, and replays, with no Zoom link made for you yet." },
        ],
      },
    ],
  },
  {
    slug: "funnels",
    section: "platform",
    eyebrow: "Funnels",
    title: "Pages in order,",
    highlight: "then the next best offer",
    intro:
      "Up to 20 pages walked in order from one address — your own pages and your products' pages — and up to five offers after someone pays, each charged in one click to the card they just used. A yes and a no can lead to different next offers, so a no can meet something smaller.",
    visual: "funnels",
    badge: WORKING,
    accent: "from-amber-brand to-violet-brand",
    plan: "creator",
    group: "paid",
    menu: { label: "Funnels", description: "Pages in order, and one-click offers after paying.", icon: "ladder" },
    related: ["sales-pages", "checkout", "your-stripe", "insights"],
    blocks: [
      {
        kind: "how",
        title: "How a funnel works",
        items: [
          { title: "Line up the pages", body: "Up to 20 steps, in the order you want: a page that gives a guide for an email, a page with a video, a sales page. Each step's way on leads to the next, from one address you share." },
          { title: "Pick what follows paying", body: "Any one-off product can have offers after it. Each offer is another of your products, at a price you set for the offer." },
          { title: "Draw the two paths", body: "For every offer, where yes leads and where no thanks leads: a later offer, or the end. A path only ever moves forward, so nobody sees an offer twice." },
          { title: "One click, same card", body: "The thank-you page shows the first offer. Taking it charges the card just used, on your own Stripe account, once." },
        ],
      },
      {
        kind: "lead",
        text: `On Stan, funnels of up to 20 pages are on the $99 plan. Here, a funnel of up to 20 pages is on the ${PLAN_AT.creator} plan, made of pages you already have — your own pages, landing pages that ask for an email, sales pages built from blocks — with a box at checkout and up to five offers after paying.`,
      },
      {
        kind: "features",
        title: "What each offer carries",
        items: [
          { icon: "type", title: "Its own words", body: "A headline of up to 90 characters, a few sentences of up to 400, and the picture of one of your products." },
          { icon: "tag", title: "Its own price", body: "Never more than the product costs on its own, so the offer is always a real one." },
          { icon: "ladder", title: "Downsells", body: "A no can lead to the same product for less, or to something else entirely." },
          { icon: "check", title: "Nothing sold twice", body: "The product just bought is never offered again, and anything already in the order is passed over." },
          { icon: "lock", title: "Only for the buyer who paid", body: "The offers show only in the browser that paid, within an hour of paying." },
          { icon: "mail", title: "A confirmation for each", body: "Every offer taken is delivered on the thank-you page and gets its own confirmation email." },
          { icon: "layout", title: "Pages in order", body: "Your own pages and your products' pages, up to 20 in a row, from one address: marktmorgen.com/@you/go/launch, or yourdomain.com/go/launch.", href: "/platform/sales-pages" },
          { icon: "list", title: "Eight kinds to start from", body: "Lead magnet, video training, challenge, product launch, book, small first purchase, application and quiz: pick one, choose your products for its steps, and the funnel is made with the pages it needs, empty and hidden until you write them, and the form it asks." },
          { icon: "copy", title: "Copy and share a funnel", body: `Make a copy inside your store or in another of your own stores, or share a funnel with another Marktmorgen creator by a link or a file. They preview it, choose their own products for its steps and get it as a draft, with a list of what to fill in. Only the words and the shape go: never your pictures, files, buyers, contacts, form answers, reviews, prices or numbers, and not your about text, guarantee, videos or deadlines. A link can be revoked at any time and works for 7, 30 or 90 days or a year. Share links at once: ${SHARE_LIMITS.creator.shares} on Store, ${SHARE_LIMITS.pro.shares} on Studio, ${SHARE_LIMITS.scale.shares} on Scale.` },
          { icon: "list", title: "Starters with first words", body: "Six funnels with their first words written: a free guide then your first offer, a recorded workshop, a coaching application with its form, a membership with the page that sells it, a free lesson then the full course, and a paid call. Every sentence is one you can say as it stands, or a part in [brackets] for you to fill in; none states a result, a number or a deadline." },
          { icon: "sparkle", title: "A first draft of the whole funnel, with AI", body: "On " + AI_PLANS_WORDS + ", the funnel's review step can draft every new page's words, the form's questions, offers from your own products and three follow-up emails, from the products you chose and what you type: who it is for, what they get and the proof you actually have. Before it runs it says how many of your monthly AI uses it takes: 2, or 3 with the emails, from the same monthly AI budget as every draft. It fills the setup's fields for you to change, invents no testimonial, result, number or deadline, removes any sentence with a number your products and words do not carry, and marks what only you know ⟦like this⟧. A page holding one stays hidden until you replace it, and the emails are saved only if you check the box, as a sequence that is switched off.", href: "/platform/ai-writing" },
          { icon: "type", title: "Forms, surveys and quizzes", body: "Up to 12 questions on one of your own pages: short and long answers, an email, one or several choices, a scale of 1 to 10. A quiz shows each person the result their answers point at, or, scored, the result whose range holds their total of points, with their score and a product of yours for it; the studio checks every total has exactly one result before it saves. Every answer is kept for you, as a file too, and on a step of a funnel sending it leads on to the next." },
          { icon: "chart", title: "Counted step by step", body: "How many people opened each step, and how many signed up or paid there, each person once a step, never you or your team." },
          { icon: "target", title: "What the counts point to", body: `Under each funnel, the counts are read for you, free and without AI: a step nobody reached after the one before it, a product step nobody paid at, and the largest fall between two steps, each with a link to the step to look at. Nothing is judged until a step has been opened ${SAMPLE_VIEWS} times, and it never says why.` },
          { icon: "door", title: "Nobody is trapped", body: "A paid step says “No thanks, continue” under its buy box, and a step you take off or keep back is passed over instead of leading nowhere." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "A step is a page that exists on its own: one of your pages or a product's page. Nothing is drawn only for a funnel, and the thank-you page after paying is the store's own, with a note from you and, in a funnel, a button to the next step once the offers are answered.",
          "Each page or product is one step of a funnel, once. A call cannot be a step, because it is booked on a page of its own.",
          "A kind of funnel writes nothing for you unless you ask the AI for a first draft: the pages it makes are hidden, and a funnel goes past them until you finish them and let them out. A training is recorded and called recorded; nothing here pretends to be live.",
          "The AI draft does not design pages, make pictures or videos, write a quiz's choices and results, set up or price an offer, or switch a sequence on. Its summary of who the funnel is for reads only your store's own records and what you type, each source shown with its date; it does not search the web.",
          "A funnel is carried by the address of its pages. Someone who opens a step from a bookmark is not in the funnel, and the next step after paying or signing up is found from the page the button was pressed on, so a browser set to hide that address goes on to the thank-you page alone.",
          "Up to 10 funnels in a store. A person is counted once a step by their connection and browser, so somebody who changes device is counted again.",
          `A shared funnel is a snapshot: changes made after the link or file was made are not in it. Funnels brought in a billing month, copies included: ${SHARE_LIMITS.creator.importsPerMonth} on Store, ${SHARE_LIMITS.pro.importsPerMonth} on Studio, ${SHARE_LIMITS.scale.importsPerMonth} on Scale; share links made a month: ${SHARE_LIMITS.creator.sharesPerMonth}, ${SHARE_LIMITS.pro.sharesPerMonth} and ${SHARE_LIMITS.scale.sharesPerMonth}; updates from a saved section a month: ${SHARE_LIMITS.creator.appliesPerMonth}, ${SHARE_LIMITS.pro.appliesPerMonth} and ${SHARE_LIMITS.scale.appliesPerMonth}; one funnel's file up to ${bytesWords(SHARE_LIMITS.creator.bundleBytes)}, ${bytesWords(SHARE_LIMITS.pro.bundleBytes)} and ${bytesWords(SHARE_LIMITS.scale.bundleBytes)}. Pictures are never shared, and a copy inside your store leaves them on the original pages.`,
          "Offers are shown only after a card, Apple Pay or Google Pay payment.",
          "Up to five offers after each product.",
          "Offers are one-off products with one price: not memberships, payment plans or calls.",
          "While sales tax is on, offers after paying are paused, because tax cannot be added to a one-click charge.",
          "A buyer who closes the page, or comes back after the hour, is not shown the offers again.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about funnels",
        items: [
          // Questions from someone starting out, answered from the code (lib/funnel-faq.ts, 534 [FQ1]).
          ...funnelBeginnerQuestions(),
          { q: "Can a buyer be charged without meaning to?", a: "No. An offer is charged only when the buyer presses to take it, in the browser that paid, within the hour, and once. If the bank asks them to confirm, they confirm it." },
          { q: "Where do I see what was taken?", a: "In your numbers and your sales export, marked as taken after paying, and in your own Stripe dashboard." },
          { q: "Does Marktmorgen take anything from an offer?", a: feeWords().fromAnOffer },
          { q: "Does a funnel change any price?", a: "No. A product step is that product's own page, with its own price and checkout, the same as anyone opening it from your store sees." },
        ],
      },
    ],
  },
  {
    slug: "bundles",
    section: "platform",
    eyebrow: "Bundles",
    title: "Several products,",
    highlight: "one price",
    intro:
      "Put 2 to 20 of your products in one bundle, at a price you set. The buyer gets every one of them exactly as if they had bought each on its own: the downloads, the links, the courses and the license keys.",
    visual: "bundles",
    badge: WORKING,
    accent: "from-amber-brand to-violet-brand",
    plan: "creator",
    group: "paid",
    menu: { label: "Bundles", description: "2 to 20 of your products, at one price.", icon: "basket" },
    related: ["price-options", "checkout", "funnels", "courses"],
    blocks: [
      {
        kind: "how",
        title: "How it works",
        items: [
          { title: "Make a product the bundle", body: "Its name, picture, page and price are its own. It holds no file of its own: it hands over the products in it." },
          { title: "Pick what goes in", body: "2 to 20 of your one-off products, in the order the buyer sees them, from a list you search by name." },
          { title: "Your store shows the saving", body: "“$120 of products for $49,” worked out from the products' prices today, and shown only when the products on their own really cost more." },
        ],
      },
      {
        kind: "features",
        title: "What a bundle hands over",
        items: [
          { icon: "file", title: "Everything, as if bought alone", body: "Each product's download or link, its course, its license key, its stamped PDF, its place on the buyer's list of purchases, and the right to review it." },
          { icon: "lock", title: "What they paid for stays theirs", body: "What a buyer gets is written onto their order when they pay. Change the bundle later and it changes for the next buyer; everyone before keeps what was in it." },
          { icon: "chat", title: "The community, when it opens", body: "When a product in the bundle opens your community, buying the bundle lets the buyer in.", href: "/platform/community" },
          { icon: "percent", title: "At checkout and after", body: "A bundle can be the box a buyer checks at checkout, and one of the offers after paying, unless it holds a course.", href: "/platform/checkout" },
          { icon: "check", title: "Or let the buyer build it", body: "“Any 3 of these 8 for $49.” Its page lists the products with their own prices, the buyer selects that many, sees what those cost on their own beside the bundle's price, and gets exactly those. Bought from its own page only." },
          { icon: "eye", title: "Drafts inside a bundle", body: "Any product can be taken off your store and kept as a draft, and a draft can still go in a bundle: sell a guide only as part of one, if you like." },
          { icon: "mail", title: "Your email platform hears each one", body: "A bundle's products reach Mailchimp, Kit, beehiiv or MailerLite as if each had been bought on its own.", href: "/platform/email-platforms" },
        ],
      },
      {
        kind: "uses",
        title: "Who sells bundles",
        items: [
          { icon: "palette", who: "Designers", what: "Every preset pack in one purchase, for less than buying them one by one." },
          { icon: "cap", who: "Coaches", what: "The course and its workbooks together, as the top step of the ladder." },
          { icon: "utensils", who: "Cooks", what: "A season of meal plans and the grocery lists that go with them." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        intro: "Said here so nobody signs up expecting it.",
        items: [
          "What goes in: one-off paid products with one price and a file, a link or a course with lessons. Not memberships, calls, free products, products with several prices or pay-what-you-want pricing, not a product with a limited number for sale, and not another bundle.",
          "A bundle has one price, charged once: no price options, no pay-what-you-want pricing, and it cannot be a membership or a call.",
          "A product you delete is gone from the bundles that held it, for their past buyers too, as it is for its own buyers; their pages say so.",
          "A bundle is not reviewed itself: its buyers review each product in it.",
          "A bundle that holds a course is not offered after paying, and a bundle with fewer than two products that can be handed over right now is not sold until you fix it.",
          "A bundle the buyer builds is bought from its own page only: not in a box at checkout, as an offer after paying, as a gift, for several people or through PayPal, and its page shows no total for the whole list.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about bundles",
        items: [
          // 534 [FQ1], unit 11: what someone starting out asks, answered by the code (lib/bundle-faq.ts).
          ...bundleBeginnerQuestions(),
          { q: "What happens when I change a product in a bundle?", a: "Its buyers get the product as it is now, its current file, link or lessons, exactly as the product's own buyers do. Which products they get is fixed when they pay." },
          { q: "Does Stan have bundles?", a: "Its help center, read on September 28, 2026, lists bundles among the files you can sell as one digital download, and we found no product type there that hands over other products. Here a bundle is its own product, and each product in it is delivered as itself." },
        ],
      },
    ],
  },
  {
    slug: "affiliates",
    section: "platform",
    eyebrow: "Affiliates",
    title: "Let the people who love it",
    highlight: "sell it for you",
    intro:
      "People apply and you approve, or everyone who buys takes a link at once. Each affiliate gets a page of their own with their clicks, sales and what they are owed. You pay them from your own PayPal in one press, or by itself on your payday: every sale lands in full in your own Stripe account, and nothing is held.",
    visual: "affiliates",
    badge: WORKING,
    accent: "from-mint-brand to-sky-brand",
    plan: "creator",
    group: "grow",
    menu: { label: "Affiliates", description: "A link and a page for each. You pay them.", icon: "handshake" },
    related: ["your-stripe", "insights", "funnels", "webhooks"],
    blocks: [
      {
        kind: "how",
        title: "How your program runs",
        items: [
          { title: "Set the terms", body: `A share of 1% to 90%, for the whole store or product by product, and a window of up to ${MAX_COOKIE_DAYS} days after a click, for as long as the buyer's browser keeps it.` },
          { title: "Approve who you want", body: "People apply on your store's affiliate page with an email address they confirm, and nobody is in until you say so. Or switch on buyers joining without applying: the thanks page and the purchase email offer everyone who buys their own link, approved at once." },
          { title: "Pay what is owed", body: "Connect your own PayPal Business account and pay everyone owed in one press, or let it pay by itself on your payday. Or download the batch for PayPal or Wise and mark it paid." },
        ],
      },
      {
        kind: "note",
        title: "Paid from your PayPal, not from money we hold",
        body: `Stan pays affiliates out of your sale, on its $99 plan, after holding it for 7 business days. We never hold your money: your sale lands in full in your Stripe account at once, and your affiliates are paid from your own PayPal, in one press or by itself on your payday, on the ${PLAN_AT.creator} plan. It needs a PayPal Business account with PayPal's Payouts switched on, and PayPal charges you its own fee on each payment.`
      },
      {
        kind: "features",
        title: "What the program keeps track of",
        items: [
          { icon: "user", title: "A page for each affiliate", body: "Their link, their clicks, their sales, what they earned and what you paid them. They never see who the buyers were." },
          { icon: "link", title: "Last click wins, or the first", body: "You choose: the most recent affiliate link a buyer followed inside your window gets the sale, or the first one does. One sale earns one affiliate either way." },
          { icon: "scale", title: "Worked out fairly", body: "The share is a percentage of what was paid, before tax. A refund on your Stripe account cancels it, and a partial refund reduces it." },
          { icon: "shield", title: "Hard to game", body: "No commission on an affiliate's own purchase, even from their address written another way, a click counted once per visitor per day, and your own clicks not counted. Two affiliates sharing an inbox or payout address, or a link reached from a paid search ad on your name, have their commission held until you look." },
          { icon: "refresh", title: "Memberships that keep paying", body: "Choose whether a membership sold through a link earns on its first payment, on every payment for 3, 6, 12 or 24 months, or for as long as the member pays; a payment plan earns on each of its payments. Read from your Stripe account as each payment arrives, and a membership keeps the terms it was sold with." },
          { icon: "star", title: "Monthly bonuses", body: "Up to three goals, such as $50 for 10 sales in a calendar month, each paid once a month it is reached, worked out from the sales that earn after refunds." },
          { icon: "users", title: "A second tier", body: "Choose 2% to 20%, and each approved affiliate gets an invitation link. Somebody who applies through it and whom you approve is theirs: on each sale that person brings, the affiliate who invited them earns that share too, on top of the first share and never out of it. One level only, with everything promised on one sale, partners' shares included, never past 90%, nothing on anyone's own purchase, and nothing while the person they brought is held. Each recruit keeps the share of the day they joined." },
          { icon: "target", title: "Pay per lead, as well as per sale", body: "Pay a fixed amount, from 0.50 to 100 in your store's currency, for each confirmed lead an affiliate brings: an email sign-up to your list that the person confirmed from the email they were sent, a free product claimed from its emailed link, or a booked call that took place. One lead per person, written any way, never the affiliate's own address. You set a hold of 7 to 90 days, how many leads earn per affiliate a day (an hour holds a quarter of it) and a monthly budget for all of them; past those a lead is shown to both of you and earns nothing. After its hold a lead waits for your approval before it can be paid, and you can reverse any lead that is not genuine, with the reason your affiliate sees. Paid by you, with your sales commissions." },
          { icon: "download", title: "The book, as a file", body: "Download who is owed what as a CSV, and note each payment with its date and reference." },
          { icon: "users", title: "Up to 1,000 people", body: "Per store, applications included. You approve or decline each one." },
          { icon: "star", title: "A share for one affiliate", body: "Give your best partner 40% while everyone else earns 20%: 1% to 90% for one affiliate, on every product except those you set to 0%. Sales already made keep what they earned." },
          { icon: "handshake", title: "A partner's share of a product", body: "Somebody who made a product with you, or lent it their audience, takes a share of every sale of it, not only of the buyers they sent: 1% to 80%, on the products you name, for up to 10 partners per product. It is recorded against each sale and paid from your own PayPal in the same batch as your affiliates. A partner never earns on their own purchase, and the shares promised on one product, affiliates included, cannot pass 90%." },
          { icon: "target", title: "Found by affiliates looking for something to promote", body: "Check one box and your program is listed at marktmorgen.com/affiliate-programs: your share, how long a click counts, your payment day and the products that earn, each with what one sale earns at today's price, read from your store. Check a second box to show your program's own numbers there too: how many affiliates and since when, the clicks they brought, the sales those clicks made, what they earned before refunds and what you recorded as paid them, with a rate per click once there are 100 clicks. Affiliates search it and filter it, and the order is written on the page: nobody pays to be placed higher. Uncheck it and your program leaves the page at once." },
          { icon: "shield", title: "Honest promotion, asked of every affiliate", body: "Your program page, each affiliate's own page and the email that approves them ask them to say they earn from the link wherever they share it, and to promise only what the product does. In the United States the FTC holds a brand responsible for what its affiliates claim; this is said to every one of them, in your store's language." },
          { icon: "sparkle", title: "Posts drafted for your affiliates", body: "On their own page, an approved affiliate picks one of your products, says in a line who they share with, and gets three posts — for X, Instagram and LinkedIn — written from that product's page in your store's language. Each one ends with their own link to the product and a line saying they earn from it, added after the writing so it can never be left off, and none claims they used it unless they said so. On " + AI_PLANS_WORDS + ", up to 3 a day each; each draft is one of your writing jobs for the month, never more than a quarter of them, and you can switch it off." },
          { icon: "mail", title: "They choose where PayPal pays them", body: "On their own page, each affiliate gives the PayPal address to pay them at, and the address they joined with hears of every change. Otherwise they are paid at the address they joined with." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "Paying through us is PayPal only, from a PayPal Business account with Payouts switched on, to the email address each affiliate joined with; an affiliate with no PayPal account there has 30 days to claim it, or it comes back to you and stays owed. Wise or a bank transfer is a file you upload yourself.",
          "A PayPal account in Brazil can send these payments only in Brazilian reais, to accounts in Brazil, under PayPal's own terms there, so paying through us does not work from one; the batch file still does.",
          "Commission on memberships is worked out on the payments your Stripe account says were paid; a membership sold before you switch it on earns nothing.",
          "A dispute on your Stripe account does not cancel a commission by itself: check your dashboard before you pay.",
          "Contracts, tax forms and payments between you and your affiliates are yours to arrange.",
          "The directory lists a program while its store can take payments and has a product that earns; it shows up to four of those products, and the rest are on the store. Nobody checks what an affiliate posts: the rules are said to each of them, and who stays in your program is your call.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about affiliates",
        items: [
          // 534 [FQ1], unit 18: what someone starting out asks, answered by the code (lib/affiliate-faq.ts).
          ...affiliateBeginnerQuestions(),
          { q: "Does Marktmorgen take a cut of affiliate sales?", a: feeWords().fromAffiliateSale },
          { q: "How is a sale tied to an affiliate?", a: "Their link is your store's address with their code on the end. Following it leaves a cookie on your store's own address with the code and the time of the click, and a purchase inside your window is credited to them. Visitors in the European Economic Area, the United Kingdom, Switzerland and Brazil, whose rules require consent first, are asked in one line on the page, and the cookie is set when they allow it." },
          { q: "What does someone need to join?", a: "An email address they can open. They apply on your store's affiliate page, confirm with the link we email, and you approve them in your studio. If you let buyers join without applying, a buyer presses Get my link on the thanks page or follows the link in their purchase email, and joins with the address they paid with. Anyone you declined or removed stays out." },
        ],
      },
    ],
  },
  {
    slug: "calendar-sync",
    section: "platform",
    eyebrow: "Calendar sync",
    title: "Busy in your calendar,",
    highlight: "not bookable on your store",
    intro:
      "Paste the private address of up to three calendars, from Google, Outlook or iCloud, and the times you are busy there stop being offered as call times. Your bookings come back the other way, as a calendar you subscribe to.",
    visual: "calendar",
    badge: WORKING,
    accent: "from-sky-brand to-violet-brand",
    plan: "creator",
    group: "sell",
    menu: { label: "Calendar sync", description: "Your busy times hide call slots.", icon: "refresh" },
    related: ["calls", "webhooks", "checkout", "store-page"],
    blocks: [
      {
        kind: "how",
        title: "Three steps, no account to connect",
        items: [
          { title: "Copy your calendar's private address", body: "Google calls it the secret address in iCal format; Outlook, a published calendar; iCloud, a public calendar. No sign-in and no password." },
          { title: "Paste it in your studio", body: "Up to three. The studio shows which service each one is and when you added it, never the address." },
          { title: "Busy means not offered", body: "Times you are busy there, up to 120 days ahead, drop out of your call times, usually within ten minutes." },
        ],
      },
      {
        kind: "features",
        title: "Both directions",
        items: [
          { icon: "eye", title: "Only busy times are kept", body: "Never a title, a guest or a place from your calendar: only when you are busy." },
          { icon: "calendar", title: "Your bookings, in your calendar", body: "A private address of your own lists every upcoming call and session with who booked it, for Google, Outlook or Apple Calendar to subscribe to." },
          { icon: "door", title: "Stopped whenever you like", body: "Remove an address in your studio, or reset it in your calendar app, and it stops working. Your own feed's address can be replaced the same way." },
          { icon: "alert", title: "When a calendar stops answering", body: "Its last good reading is used for up to six hours, and your studio says what went wrong." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "For your own calls it is not a two-way sync. Only calls set to Google Meet are written into your calendar, on a Google Calendar you connect under Video calls; other bookings reach it through the feed you subscribe to, which your calendar app refreshes on its own schedule.",
          "Hosts of team calls set their own calendar under Your calendar: a private iCal address, or their own Google Calendar for two-way sync (busy times read from the calendars they pick, bookings written to the one they choose), which switches on once Google approves the added permissions for our app.",
          "A new busy time can take about ten minutes to close a slot.",
          "Up to three calendars, read 120 days ahead.",
          "Busy times are read only through a private iCal address, not through a Google or Microsoft connection. A calendar that cannot give one cannot be read.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about calendar sync",
        items: [
          // 534 [FQ1], unit 15: what someone starting out asks, answered by the code (lib/calendar-faq.ts).
          ...calendarBeginnerQuestions(),
          { q: "Does Stan do this?", a: "Stan's help center, read on September 26, 2026, lists Google Calendar for its calls. Ours reads Google, Outlook and iCloud calendars by their private address, and writes events only for calls set to Google Meet, on a Google Calendar you connect." },
          { q: "What happens to my calendar's address?", a: "It is stored with your store and used only to read your busy times. Once saved it is never shown again, not even to you. If you are ever unsure, reset it in your calendar app and the old one stops working." },
          { q: "Does it block group calls and live sessions too?", a: "It hides call times you are busy for. Live sessions are on the dates you set yourself, so they are yours to place around your calendar." },
        ],
      },
    ],
  },
  {
    slug: "webhooks",
    section: "platform",
    eyebrow: "Webhooks",
    title: "Tell your other tools",
    highlight: "what just happened",
    intro:
      "Up to five addresses of your own, such as a Zapier Catch Hook, a Make scenario or your own server, told about sales, members, leads, bookings and refunds as they happen, in signed JSON.",
    visual: "webhooks",
    badge: WORKING,
    accent: "from-violet-brand to-sky-brand",
    plan: "creator",
    group: "grow",
    menu: { label: "Webhooks", description: "Sales, leads and bookings, sent to Zapier or Make.", icon: "plug" },
    related: ["insights", "calls", "affiliates", "email"],
    blocks: [
      {
        kind: "how",
        title: "How to connect a tool",
        items: [
          { title: "Add an address", body: "An https address, and the events it should hear. Its signing secret is shown to you once." },
          { title: "Send a test", body: "One press sends a test message, and the delivery log shows what the address answered." },
          { title: "Let it run", body: "Each event is sent when it happens. Those read from your Stripe account can take up to about five minutes." },
        ],
      },
      {
        kind: "features",
        title: "Nine events, and how they arrive",
        items: [
          { icon: "receipt", title: "sale.completed and refund.issued", body: "A paid checkout of any product, each one-click offer taken after it, and a refund, even one made in your Stripe dashboard." },
          { icon: "repeat", title: "membership.started and membership.canceled", body: "A membership bought, and a membership set to end or ended." },
          { icon: "gift", title: "lead.captured", body: "Someone confirmed their address for a free product." },
          { icon: "mail", title: "list.joined", body: "Someone confirmed their address to join your email list, from your store page, a form or the checkout script on your own site." },
          { icon: "calendar", title: "call.booked and call.moved", body: "A call or a seat in a session booked and paid, and a booking the buyer moved." },
          { icon: "ladder", title: "sequence.step", body: "Somebody reached a step of one of your sequences that tells your webhooks: their email, the sequence and the step, once for each person." },
          { icon: "lock", title: "Signed", body: "Every message carries a Marktmorgen-Signature header: an HMAC-SHA256 of its time and body under that address's secret." },
          { icon: "refresh", title: "Tried again", body: "When an address does not answer, the message is tried six more times over about forty hours, then marked failed." },
          { icon: "list", title: "A log you can read", body: "Your studio keeps the last 50 deliveries, each for up to seven days, with what the address answered." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "There is no Marktmorgen app in Zapier's directory. In Zapier, use its Webhooks by Zapier trigger, Catch Hook.",
          "Webhooks only send. To read your store from your own tools, use an API key: the API reads your list, members, a course's students, your affiliates and your bookings. A key made to write also adds people who agreed to your list, changes their labels and gives or takes back products, for Zapier, Make or your own server. The developers page lists every address.",
          "Up to five addresses per store, https only, and redirects are not followed.",
          `Each billing month covers a number of deliveries, every try, retry and test counted: ${STORE_ALLOWANCES.creator.webhook.toLocaleString("en-US")} on the ${PLAN_AT.creator} plan, ${STORE_ALLOWANCES.pro.webhook.toLocaleString("en-US")} on the ${PLAN_AT.pro} plan and ${STORE_ALLOWANCES.scale.webhook.toLocaleString("en-US")} on the ${PLAN_AT.scale} plan. Past them a message is not sent, and the log says so.`,
        ],
      },
      {
        kind: "faq",
        title: "Questions about webhooks",
        items: [
          // 534 [FQ1], unit 16: what someone starting out asks, answered by the code (lib/webhook-faq.ts).
          ...webhookBeginnerQuestions(),
          { q: "How do I know a message came from you?", a: "Check its Marktmorgen-Signature header against the secret you were shown when you added the address, and check that its time is recent. When you make a new secret, the old one keeps signing beside it for a day, as a second v1 in the same header: accept a message when any v1 matches." },
          { q: "What if a message did not arrive?", a: "It is tried again by itself for about forty hours. If it still failed, press Send again beside it in your studio's log: the same message, with the same event id, is sent once more, so a receiver that already has it can ignore the repeat." },
          { q: "What if the same event arrives twice?", a: "Every event has an ID made from what it is about, and it is sent once however often it is noticed. Keep the IDs you have seen and ignore a repeat, in case a retry crosses a slow answer." },
          { q: "Does Stan have webhooks?", a: "Not according to its help center, read on September 17, 2026." },
        ],
      },
    ],
  },
  {
    slug: "quizzes-and-certificates",
    section: "platform",
    eyebrow: "Quizzes and certificates",
    title: "Quizzes that teach,",
    highlight: "a certificate that proves it",
    intro:
      "A quiz after any lesson, marked on our side, or an assignment students hand in that you can read and approve, and a certificate of completion with a page of its own that anyone can open to check it.",
    visual: "quizzes",
    badge: WORKING,
    accent: "from-pink-brand to-violet-brand",
    plan: "creator",
    group: "deliver",
    menu: { label: "Quizzes and certificates", description: "Questions or an assignment after a lesson, a certificate at the end.", icon: "cap" },
    related: ["courses", "memberships", "community", "email"],
    blocks: [
      {
        kind: "how",
        title: "From a lesson to a certificate",
        items: [
          { title: "Add a quiz to a lesson", body: "Up to 20 questions, each with one right answer or several, and a line of explanation shown afterward. On " + AI_PLANS_WORDS + ", AI can also draft 3 to 10 from the lesson's text, with answers of the same length and the right one in a different place each time, for you to read, change and save." },
          { title: "Set the rules", body: "The pass mark, how many tries (1 to 10), and whether later lessons stay locked until it is passed." },
          { title: "Or give an assignment", body: "Ask students to do something and hand it in: a few paragraphs, a file of up to 10 MB, or both. You read it, write back, and approve it or ask for another try; what you write reaches them by email, in your store's language." },
          { title: "Switch certificates on", body: "A student who finishes every lesson and passes every quiz that has to be passed types their name and gets a certificate." },
        ],
      },
      {
        kind: "features",
        title: "What makes it worth having",
        items: [
          { icon: "lock", title: "Marked on the server", body: "The right answers are not sent to the page before the student answers, so they cannot be read from it." },
          { icon: "eye", title: "Answers shown fairly", body: "After a try the student sees what they got right. The rest are shown once they pass or run out of tries." },
          { icon: "type", title: "The name as they typed it", body: "The certificate carries the student's name exactly as typed, with the course title and your name as they were that day." },
          { icon: "globe", title: "A page that proves it", body: "Each certificate has its own address on your store that anyone can open to check it. It is kept out of search engines." },
          { icon: "link", title: "On their LinkedIn, pointing at your store", body: "One press opens LinkedIn's own form to add it to the student's profile, filled in: the course, you as the issuer, the month, its ID and its page as the credential. Another opens a LinkedIn post with its link, which unfolds into a picture of the certificate in your store's colors. Every student who shows it off sends people to your store." },
          { icon: "ban", title: "Withdrawn when it has to be", body: "Issued to the wrong name, or to someone you refunded? Withdraw it, and its page says it was withdrawn." },
          { icon: "list", title: "Your list of certificates", body: "Your studio lists the certificates of each course, who earned them and when." },
          { icon: "check", title: "Work you read, answers they get", body: "Handed-in work waits for you in the studio, with one email an hour at most when there is some. On " + AI_PLANS_WORDS + ", AI can draft your reply from the assignment and the student's answer, for you to change before anything is sent. Approving finishes the lesson, and can be what opens the next one." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        items: [
          "The certificate is a page of its own and a PDF file the student downloads. The file is drawn in Latin, Greek and Cyrillic letters; a name in another script is printed from the page instead.",
          "Quiz questions are multiple choice, with one right answer or several. Written answers and files are what an assignment is for.",
          "One quiz or one assignment per lesson, not both. A quiz holds up to 20 questions.",
          "The AI reply draft (" + AI_PLANS_WORDS + ") reads what a student wrote; it does not open the files they hand in.",
          `A store's students keep up to ${storageWords(TASK_ROOM_BYTES.creator)} of handed-in files together on the ${PLAN_AT.creator} plan, ${storageWords(TASK_ROOM_BYTES.pro)} on the ${PLAN_AT.pro} plan and ${storageWords(TASK_ROOM_BYTES.scale)} on the ${PLAN_AT.scale} plan. Past that they hand in text until old work is removed with its assignment.`,
          "A student who used all their tries asks you for more by replying to their purchase email.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about quizzes and certificates",
        items: [
          // 534 [FQ1], unit 13: what someone starting out asks, answered by the code (lib/quiz-faq.ts).
          ...quizBeginnerQuestions(),
          { q: "Can a certificate be faked by editing a link?", a: "No. Its page is read from our record of it, never from anything in the address. Anyone checking one should open its page on your store." },
          { q: "Does passing a quiz count as finishing the lesson?", a: "Yes. Passing marks the lesson done, which is what a certificate counts." },
          { q: "When is a lesson with an assignment done?", a: "When the student hands it in, or, if you read each one, when you approve it. Either way it counts toward the certificate, and you choose whether the lessons after it wait." },
          { q: "Where are the files students hand in kept?", a: "Privately, with your store's files, where only the student who handed one in and you and your team can download it. Removing the assignment or the lesson deletes them." },
          { q: "Does Kajabi take written work and files?", a: "Its assessments take a paragraph or a file upload of up to 10 MB, according to its help center, read on October 11, 2026." },
          { q: "Does Stan have quizzes and certificates?", a: "Not according to its help center, read on September 17, 2026." },
        ],
      },
    ],
  },
  {
    slug: "discord-access",
    section: "platform",
    eyebrow: "Discord access",
    title: "Your Discord server,",
    highlight: "opened by what people buy",
    intro:
      "Choose which products give which roles in your own Discord server. A buyer joins in two presses after paying, keeps the roles while they hold what they bought, and loses them by themselves when a membership ends or a purchase is refunded in full.",
    visual: "discord",
    badge: WORKING,
    accent: "from-violet-brand to-pink-brand",
    plan: "creator",
    group: "deliver",
    menu: { label: "Discord access", description: "Roles in your own server, given and taken back by themselves.", icon: "users" },
    related: ["memberships", "community", "courses", "bundles"],
    blocks: [
      {
        kind: "how",
        title: "From a purchase to a role",
        items: [
          { title: "Connect your server", body: "Add the Marktmorgen bot to your server on Discord's own page. It asks to put people in the server, to give and take back roles, and to remove people, which it does only if you ask it to." },
          { title: "Pick the roles", body: "Up to three roles for each product, on up to 20 products, chosen among the roles the bot can give, or made from the studio in one step." },
          { title: "A buyer joins", body: "\u201cJoin the Discord\u201d is on their thank-you page and on their orders. They say yes on Discord's page and are in, with the roles." },
        ],
      },
      {
        kind: "features",
        title: "What it takes care of",
        items: [
          { icon: "refresh", title: "Taken back by itself", body: "Everyone who joined is checked again about every six hours against your own Stripe account. A membership that ended or a purchase refunded in full loses its roles, with nothing for you to do." },
          { icon: "shield", title: "Never taken on a guess", body: "When Stripe cannot be reached, nobody loses anything; the check simply runs again later. Roles you gave by hand are never touched." },
          { icon: "lock", title: "One Discord account per purchase", body: "A buyer who joins with a second account moves the roles to it, so one purchase cannot open the server for a friend too." },
          { icon: "door", title: "Out of the server, if you want", body: "By default a buyer whose access ended keeps your public channels and loses the paid ones. Switch it on and they are removed from the server instead." },
          { icon: "list", title: "Who joined", body: "Your studio lists everyone given roles by a purchase, with the address that bought and when." },
          { icon: "eye", title: "No messages read", body: "The bot never reads or sends a message. It puts people in, gives and takes roles, and nothing else." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "Roles are taken back at the next check, which comes about every six hours, not in the same second. While Stripe or Discord cannot be reached, or Discord will not let the bot remove a role, nothing is taken until it can be.",
          "One Discord server per store.",
          "The bot can only give, and take back, roles below its own in your server's list of roles; keep the Marktmorgen role above the roles it gives.",
          "A buyer has to press the button and say yes on Discord's page: nobody is added to a server without agreeing.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about Discord access",
        items: [
          // 534 [FQ1], unit 17: what someone starting out asks, answered by the code (lib/discord-faq.ts).
          ...discordBeginnerQuestions(),
          { q: "Does it work with bundles and memberships?", a: "Yes. A product in a bundle gives its roles to the bundle's buyers, and a membership keeps them for as long as it is paid." },
          { q: "What does Discord learn about my buyers?", a: "Nothing from us. Discord tells us the buyer's Discord id and name when they agree on its page, and we keep those with the address that bought, as the privacy policy says." },
        ],
      },
    ],
  },
  {
    slug: "license-keys",
    section: "platform",
    eyebrow: "License keys",
    title: "A unique key",
    highlight: "with every sale",
    intro:
      "For software, plugins and anything that unlocks with a code. Upload the keys your own system made, or have them made here, and each buyer gets one nobody else has.",
    visual: "keys",
    badge: WORKING,
    accent: "from-amber-brand to-mint-brand",
    plan: "creator",
    group: "deliver",
    menu: { label: "License keys", description: "One unique key per sale, and a check for your app.", icon: "key" },
    related: ["instant-delivery", "pdf-stamping", "webhooks", "checkout"],
    blocks: [
      {
        kind: "how",
        title: "How keys reach a buyer",
        items: [
          { title: "Choose where they come from", body: "A text or CSV file of up to 10,000 keys, handed out in the order you uploaded them, or keys made here in a shape you set, like STUDIO-7K2Q-9XFD-M3PL." },
          { title: "A buyer pays", body: "They see their key on the thank-you page, in their confirmation email and in their list of purchases." },
          { title: "Your software asks", body: "A public address answers whether a key is valid, revoked or unknown, and nothing about who bought it." },
        ],
      },
      {
        kind: "features",
        title: "What it takes care of",
        items: [
          { icon: "check", title: "Never given twice", body: "Two buyers paying in the same moment get two different keys, and a key uploaded twice is handed out once." },
          { icon: "type", title: "Keys people can type", body: "Made keys leave out the characters people confuse, like 0 and O, and are long enough that nobody guesses one." },
          { icon: "alert", title: "A warning before you run out", body: "An email when the pool runs low, at 20 keys unless you choose another number. When it is empty, the product shows as sold out." },
          { icon: "ban", title: "Revoke and restore", body: "A key given for a payment refunded in full is revoked by itself within about five minutes, and you can revoke any key by hand. Restore it if you change your mind." },
          { icon: "list", title: "Who has which key", body: "Your studio shows every key given, to whom and for which sale." },
          { icon: "mail", title: "Nobody left without one", body: "A buyer who paid at the moment the last key ran out is not left with nothing: the next keys you upload go to them first, by email." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "Paid one-off products only: not memberships, calls, courses, shipped products or bundles (a bundle hands out its products' keys).",
          "No activation or seat counting. The check says whether a key is good; your software decides the rest.",
          "Revoking is a record your software has to ask about. Nothing here can switch off a copy that never checks.",
          "Up to 10,000 keys waiting in one product's pool.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about license keys",
        items: [
          // 534 [FQ1], unit 12: what someone starting out asks, answered by the code (lib/license-key-faq.ts).
          ...keyBeginnerQuestions(),
          { q: "How does my software check a key?", a: "It asks /api/store/license with your store's address, the product and the key, and gets back valid, revoked or unknown. It can be called from a website or an app, up to 120 times a minute from one connection." },
          { q: "Can I use keys my own system already made?", a: "Yes. Upload them as a text or CSV file. A key that was already uploaded is skipped, so it can never go to two buyers." },
        ],
      },
    ],
  },
  {
    slug: "pdf-stamping",
    section: "platform",
    eyebrow: "PDF stamping",
    title: "Every page says",
    highlight: "whose copy it is",
    intro:
      "Switch it on for an ebook or a workbook, and each page of the PDF a buyer downloads carries their email, the date and their order along the bottom.",
    visual: "stamp",
    badge: WORKING,
    accent: "from-pink-brand to-amber-brand",
    plan: "creator",
    group: "deliver",
    menu: { label: "PDF stamping", description: "The buyer's email on every page of their PDF.", icon: "file" },
    related: ["instant-delivery", "license-keys", "price-options", "courses"],
    blocks: [
      {
        kind: "how",
        title: "How it works",
        items: [
          { title: "Switch it on per product", body: "One box on the product, for the PDF it delivers." },
          { title: "The buyer downloads", body: "One quiet line along the bottom of every page: “Sold to maya@example.com on Sep 26, 2026 · order …E54F2A · for personal use.”" },
          { title: "Made once per sale", body: "The stamped copy is kept beside your original, so downloading again gives the buyer the same file." },
        ],
      },
      {
        kind: "note",
        title: "What it is, and what it is not",
        body: "It discourages sharing: a copy that turns up somewhere else says whose it was, and that makes a buyer think twice. It is not copy protection. It does not stop anyone from sharing the file, and someone determined can remove the line.",
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "PDFs up to 50 MB. A bigger one, or one locked with a password or damaged, is handed over as you uploaded it, and your studio tells you.",
          "PDFs only. Images, ZIP files and everything else are handed over as uploaded.",
          "A product sold as a link is not stamped: the file is wherever you keep it.",
          "A free download is handed over as you uploaded it: only a paid one is stamped.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about PDF stamping",
        items: [
          // 534 [FQ1], unit 14: what someone starting out asks, answered by the code (lib/pdf-stamp-faq.ts).
          ...stampBeginnerQuestions(),
          { q: "Does it change my original file?", a: "No. Your upload stays as it is. Each buyer's copy is made from it, kept beside it, and deleted with it." },
          { q: "Is the file sent to another company to be stamped?", a: "No. It is stamped by our own code on the servers that run Marktmorgen, and not sent anywhere else." },
          { q: "Should I tell buyers?", a: "Yes. Their email is printed on the file they receive, so say so on the product." },
        ],
      },
    ],
  },
  {
    slug: "sales-pages",
    section: "platform",
    eyebrow: "Sales and landing pages",
    title: "A page that sells it,",
    highlight: "built from blocks",
    intro:
      "Any product's own page can be laid out by you: a headline with a picture or a video, your own pictures, what the buyer gets, what is inside, who it is for and who it is not for, how it works step by step, a comparison table, bonuses, numbers counted by your store, things said about it elsewhere with links to where, who made it, questions, your guarantee, a countdown to a real deadline, buttons and real buyers' reviews. Start from a template, from an AI draft (" + AI_PLANS_WORDS + ") or from nothing. For something free, the same page asks for an email.",
    badge: WORKING,
    accent: "from-pink-brand to-violet-brand",
    plan: "creator",
    group: "sell",
    menu: { label: "Sales pages", description: "Up to 30 blocks per product, and landing pages for free ones.", icon: "layout" },
    related: ["reviews", "funnels", "checkout", "store-page"],
    blocks: [
      {
        kind: "how",
        title: "From a product to a page",
        items: [
          { title: "Open the product's page", body: "In your studio, under Sales pages. A product without blocks keeps the plain page it always had." },
          { title: "Stack the blocks, or have AI draft them on " + AI_PLANS_WORDS, body: "Start from another of your products' pages, its blocks copied with their words for you to change, or from one of six templates — an ebook, a course, a call, a membership, a launch with a deadline, a free download — each an order of blocks with its headings and the questions buyers of it ask, and the words yours to write. Drag a block to move it. Up to 30, in the order you want, with a preview beside them before anything is saved. Or press Write the whole page with AI: a full draft — headline, what the buyer gets, what is inside, questions and buttons — from the product's own description, for you to read and change. Selling in another language? Translate the whole page with AI in one step, into Spanish, French, German, Italian, Dutch, Portuguese or English: every heading, point, question, button and picture description, names and numbers kept as they are, and Undo puts it back. For a PDF, it can read the first ten pages of the file itself first, so what is inside is listed from the real contents." },
          { title: "Share one link", body: "Your store address, /p/ and the product. The buy button on the page opens the same checkout the store page does." },
        ],
      },
      {
        kind: "features",
        title: "What a page is built from",
        items: [
          { icon: "plus", title: "A gallery of blocks", body: "Every block with its icon and what it is for, grouped by what it does on the page, with a box to find one by name. Add it at the end or right between two blocks, where it goes." },
          { icon: "phone", title: "Phones, or computers", body: "Keep any block to phones only, or to computers and tablets only: a shorter list where the screen is small, a wide table where it fits. The preview shows each width." },
          { icon: "link", title: "Share it anywhere", body: "The page's link to copy, a QR code to download as SVG for print or PNG for slides, and X, Facebook, LinkedIn, WhatsApp and email ready to post from. Each link is tagged with where it went, so your numbers show which one brought visitors and sales. Short of words? On " + AI_PLANS_WORDS + ", AI drafts a post for X, an Instagram caption and a LinkedIn post from what the page says, in your store's language, with the right tagged link in each, for you to change and copy." },
          { icon: "eye", title: "Work on it out of sight", body: "Switch a page off and save as often as you like: visitors see the product's plain page until you switch it on, or until a moment you choose, when it shows by itself. Nothing on a hidden page is answered from or counted." },
          { icon: "history", title: "Earlier versions", body: "Undo and Redo while you edit, a step at a time, from the buttons or Ctrl+Z. And the page as it was before each of your last five saves, kept as long as the page is: load one into the editor, look it over, and save it to put it back live. Duplicate any block to start the next one from it." },
          { icon: "copy", title: "Saved sections", body: `Keep a group of up to ${MAX_SECTION_BLOCKS} blocks under a name and put it on any page of your store. Change it on one page, then update it on the other pages you check, after seeing which pages use it. Sections in your library: ${SHARE_LIMITS.creator.savedBlocks} on Store, ${SHARE_LIMITS.pro.savedBlocks} on Studio, ${SHARE_LIMITS.scale.savedBlocks} on Scale. Pictures stay on the page that shows them, and a page with its own pictures in the section, or a test running, is changed by hand.` },
          { icon: "layout", title: "Three page styles", body: "Plain, bands or cards: every other section on a soft wash of your store's color, or each section on a card of its own. Switch in the preview and see the page redraw before you save. The colors are checked so every line still reads." },
          { icon: "type", title: "Hero", body: "A headline of up to 120 characters and a line under it, beside the product's picture or a video, centered above it, or with the picture behind the words, darkened so they read on any picture. A button under the headline, if you want one." },
          { icon: "play", title: "Video that waits", body: "One beside the headline and as many more as the page needs, each in a block of its own with a heading and a line under it. From YouTube, Vimeo or Loom. Nothing from them loads until the visitor presses play, and YouTube plays from its privacy-enhanced address." },
          { icon: "camera", title: "Your own pictures", body: "Pages of the book, a screen of the course, the finished result: up to 6 in a block and 24 on a page, each with a line under it and a description for people who cannot see it, which AI can write for you on " + AI_PLANS_WORDS + " from the picture itself, in your store's language. Shrunk in your browser before they are sent, served from our own address. A press opens them large on the page itself, one after another by arrow, swipe or button, and Escape goes back to where the reader was." },
          { icon: "clock", title: "A countdown that cannot be faked", body: "Days, hours, minutes and seconds to one moment you set — a launch price ending, doors closing, a session starting — shown to each visitor in their own time zone. It is the same moment for everybody and never starts again for anyone, and once it has passed the block disappears by itself. Up to a year ahead." },
          { icon: "list", title: "Benefits and what is inside", body: "Up to 12 points with a check mark, and up to 20 numbered parts, each with a line about it. For a course, one press fills the parts from its own outline: each module with its lessons, as the course shows them." },
          { icon: "layout", title: "Picture and text", body: "One of your pictures beside a heading and paragraphs, on the left or the right, above the words on a phone. Several in a row, alternating sides, read like a story." },
          { icon: "target", title: "Who it is for, and who it is not", body: "Two lists side by side, up to 8 points each. Saying who should not buy is the most honest line on a page, and the one that sends back the fewest refunds." },
          { icon: "ladder", title: "How it works", body: "Up to 8 numbered steps joined into one path, from the moment they pay to the result." },
          { icon: "scale", title: "A comparison table", body: "Up to 12 rows: your product beside another way of getting there, with check marks, crosses or a few words in each cell, the way a buyer weighs a decision." },
          { icon: "gift", title: "Bonuses", body: "Up to 8 extras that come with it, each on its own numbered card. No made-up “worth $497” beside them, on purpose." },
          { icon: "basket", title: "Another of your products", body: "A card for the course beside the ebook, or the next step after the free guide: its picture, name and price as they are today, and a link to its own page, with a line about why it goes well with this one." },
          { icon: "chart", title: "By the numbers, counted for you", body: "Lessons, episodes, products in a bundle, a call's length, how many times it was bought and the average rating, drawn as big figures. Every number is counted by your store and stays up to date by itself; none can be typed, so none can be wrong." },
          { icon: "user", title: "Text, and about you", body: "A heading and paragraphs in your own words, and who made it, with your store photo." },
          { icon: "chat", title: "Questions", body: "Up to 15 questions and answers that open and close." },
          { icon: "shield", title: "Your guarantee", body: "Your refund promise, in your own words." },
          { icon: "bolt", title: "Buttons", body: "Anywhere on the page, each leading to the checkout, or to the sign-up form on a free product." },
          { icon: "star", title: "Reviews", body: "Where your buyers' verified reviews sit on the page. Pick up to three to show first, marked as picked by you: only reviews from buyers who paid can be picked, never a testimonial typed in, and the average still counts every review.", href: "/platform/reviews" },
          { icon: "chat", title: "Said elsewhere", body: "Up to 6 things people said about it in public — a post on X, a comment under a video, a newsletter — in their words, with who said them and a link to where, so a visitor can check each one. Kajabi, Hotmart and Stan let anyone type a testimonial with nothing behind it; here one without its address is not saved. Never translated, never rewritten, and never shown as a review." },
          { icon: "sparkle", title: "Improve any block with AI, on " + AI_PLANS_WORDS, body: "An empty block of benefits, who it is for, how it works or questions is drafted from your product's description and page. Under each block of words: Clearer, Shorter, More specific or Warmer. Your own words, said another way, in your store's language, with Undo beside it. A rewrite that brings a number or a promise your page does not already make is thrown away, not shown." },
          { icon: "gauge", title: "A coach for every page", body: "Each page gets a score out of 100, with how often the page was opened and how many checkouts it started in the last 30 days, and the questions visitors asked its answer box that the page could not answer, a press away from your questions. It also lists what pages that sell have in common and yours is missing — a button near the top, three things they get, who it is for, three questions answered, a refund promise — each with a button that adds the block. It points at the block where readers stop most. And the writing help reviews the page as visitors read it: what to change first, three headlines to try or test against yours, who it is for and not for, and the questions buyers will ask that your page leaves open, each a press away from your page. It counts as one of your monthly drafts and never invents reviews, numbers, results or deadlines." },
          { icon: "chart", title: "Where readers stop", body: "Each block of your page shows the share of visitors who read down to it, measured on one visitor in eight and shown once 30 are, so you can see which block to rewrite or move up. No cookie, nothing about who." },
          { icon: "chart", title: "Two headlines, tested", body: "Write a second headline and half your visitors see each. Once the current rule finds a winner, your page shows it to everybody by itself. " + PAGE_TEST_WORDS },
          { icon: "layout", title: "Two whole pages, tested", body: "Make version B from the page itself and change its blocks, their order, words, pictures or video. Half your visitors read each. Once the current rule finds a winner, it becomes the page for everybody by itself. " + PAGE_TEST_WORDS + " Use the page you already have, with no separate page builder to pay for." },
          { icon: "chat", title: "Buyers' questions, answered from your page", body: "Switch it on and every product page gets a box: \u201cA question before you buy?\u201d The visitor is answered in seconds, in their own language, only from what that page says and from the notes you write for it. It never states a price, a refund, a deadline or a result that is not on your page, and it says the answer is automatic. What your page could not answer is told plainly and listed in your studio, with nothing about who asked, so you can see what the page is missing. " + answerAllowanceWords() + " Past the allowance, the box closes until the month turns. Cached answers can still be shown without another model call." },
          { icon: "chat", title: "The " + ASSISTANT_NAME + ", an add-on (not on sale yet)", body: "A chat on every page of your store that answers buyers at any hour, in their language, only from what you published: your products and prices, how each is delivered, your pages' questions and refund promises, your store's questions and answers, and your notes. Every reply is labeled as AI. It says when it does not know; a reply naming a number, a deal or a code that is not in your own words is never shown; and a complaint, a refund request, a request for a person or any question it cannot answer goes to your inbox with the buyer's email. " + assistantAllowanceWords() + " " + assistantPriceWords() + ", on any plan once your plan is paid; it opens with Marktmorgen's plans." },
          { icon: "sparkle", title: "One next product after a purchase, with the " + ASSISTANT_NAME, body: "Switch it on and the page after paying shows one more of your own products, at its published price, with its own description and a \u201cNo thanks\u201d; if you allow it, the same lines go in the order's confirmation email, only to buyers who checked the box to hear from you, and never as an email of its own. Never what the buyer just bought or already owns from you (read from your own Stripe account), never what they turned down after paying, and never while one of your offers after paying is waiting on their answer. Your own choices decide first: what you said goes well with the product, its offers after paying, its checkout boxes, the rest of a collection it is in. Only when you set none does an AI choose among your products, labeled \u201cAI suggestion\u201d, and each such choice is one reply of the add-on's month; once those are used, your store's own order decides, at no AI cost. No discount, no countdown, no count of buyers: just your product and your price." },
          { icon: "mail", title: "One reminder after a checkout left unpaid, only when asked for, with the " + ASSISTANT_NAME, body: "Switch it on and your checkout shows an unchecked box, \u201c" + ASSIST_REMINDER_WORDS.en.box + "\u201d, in your store's language, with a place for the buyer's email once it is checked. Nothing is read into an address being typed: only a buyer who checks it gets one email from you, about an hour after that checkout closes unpaid, with what they left, its link and today's price, the sentence they checked and the day, your postal address and a link that stops your reminders at once. Never when they paid, paid for it since, stopped or left your emails, and never twice for one checkout. An AI adds one short, neutral line about those products from your own descriptions, labeled as written by AI, with no price, deal, deadline or claim; once the add-on's month of replies is used, the same email goes without it. It is one of your store's own emails for the month, and the address is deleted three days after the checkout opened." },
          { icon: "sparkle", title: "A whole page drafted with AI, on " + AI_PLANS_WORDS, body: "From the product's name, price and description, plus anything you add. It never writes your story or a guarantee you did not give, never invents reviews, numbers, results or deadlines, and never puts a price on a button. Nothing is saved until you press Save. It counts as one of your monthly drafts." },
          { icon: "globe", title: "Search and sharing", body: "An address in words from the product's name — /p/knife-skills-… — that follows a rename without breaking a link shared before. A title of up to 70 characters and a description of up to 160 for search engines, and a share picture drawn for you from the product's picture, name, price and stars." },
        ],
      },
      {
        kind: "features",
        title: "Landing pages for free products",
        items: [
          { icon: "gift", title: "The page asks for the email", body: "The same blocks, with the sign-up form where the buttons are. Every address is confirmed from its own inbox before it joins your list." },
          { icon: "ladder", title: "One paid product next", body: "After someone asks for the free one, the page can show one of your paid products, with a link to its own page. Nothing is charged or added for them." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do yet",
        intro: "Said here so nobody signs up expecting it.",
        items: [
          "No custom code, HTML or styles: every block is plain text, drawn in your store's theme and color. Blocks stack in the order you set; there are no columns or free layout.",
          "Pictures are your own uploads (JPEG, PNG, WebP, GIF or AVIF, shrunk to a megabyte at most), the product's picture and your store photo; nothing is loaded from another site. Videos come only from YouTube, Vimeo or Loom.",
          "A countdown runs to one fixed moment. There is no timer that starts again for each visitor, on purpose: that is a deadline that is not real.",
          "A button cannot state a price or a deal of its own: it leads to the checkout with the prices the store page shows.",
          "One page per product. To walk several pages in order, put them in a funnel (Funnels in the studio): each step is a page that exists on its own. The thank-you page is the store's own, with what was bought on top; yours is the note under it, with your words, a video and one button.",
          "A test compares two versions: two headlines, or two whole pages. Never two prices: everyone pays the same. While two whole pages are tested, how far down the page is read is not shown, because there are two pages.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about sales pages",
        items: [
          // 534 [FQ1], unit 9: what someone starting out asks, answered by the code (lib/sales-page-faq.ts).
          ...salesPageBeginnerQuestions(),
          { q: "Which plan is it on?", a: `Every plan, the ${PLAN_AT.creator} one included. On Stan, by its help center read on September 28, 2026, each product has a checkout page with a description and a video that can be made a private landing page on every plan, and funnels of several pages are on its $99 plan.` },
          { q: "Who on my team can edit them?", a: "You, an Admin and an Editor. Support cannot." },
          { q: "Can I put a testimonial I collected on the page?", a: "Yes, in the Said elsewhere block, if it was said in public: their words as they said them, who said them, and the address of the post, video or comment, shown as a link so visitors can check it. The Reviews block shows only reviews written by people who paid, with their stars, and nothing you type can appear as one." },
        ],
      },
    ],
  },
  {
    slug: "ai-writing",
    section: "platform",
    eyebrow: "Writing help with AI",
    title: "AI that writes from",
    highlight: "your own words",
    intro:
      "Drafts for every part of a store — a product's description, a whole sales page, a course outline, an email — in your store's language, from what you typed and what your store already says, on " + AI_PLANS_WORDS + ". It never invents a review, a number, a result or a deadline, and nothing is saved, posted or sent until you press the button that does it.",
    badge: WORKING,
    accent: "from-violet-brand to-pink-brand",
    plan: "pro",
    group: "sell",
    menu: { label: "Writing help with AI", description: "Drafts in your store's language, from your own words, on " + AI_PLANS_WORDS + ". Nothing invented.", icon: "sparkle" },
    related: ["sales-pages", "reviews", "email", "store-page"],
    blocks: [
      {
        kind: "how",
        title: "How every draft is made",
        items: [
          { title: "From what is yours", body: "What you type in the box, and what your store already says: the product's name, price, description and page. Nothing about your buyers, ever." },
          { title: "Held to the same rules", body: "No invented testimonial, review, number of students or sales, result, guarantee, discount, deadline or urgency, said to the model in full every time." },
          { title: "Yours to keep, or not", body: "It fills the boxes in the studio. You read it, change it and press Save, Post or Send yourself — or leave it." },
        ],
      },
      {
        kind: "features",
        title: "Where it helps",
        items: [
          { icon: "chat", title: "\"How do I…?\" answered in your studio", body: "Ask how to do anything in your own words — sell a course in payments, add your own domain, offer a refund — and get the answer from our help center's own answers, with links to read them in full. When the help center does not cover it, it says so and tells you where a person answers." },
          { icon: "store", title: "Your whole store, drafted", body: "Say what you make and for whom: AI drafts the line under your name, up to three products with a summary, and the questions visitors ask, from your words only. A price is filled in only from a price you wrote, and you check each one before keeping it. You see it all first and keep what you choose; the products wait as drafts until you add what each one hands over." },
          { icon: "file", title: "A product's description", body: "The short line and the long description, from a few words about it." },
          { icon: "layout", title: "A whole sales page", body: "Headline, what the buyer gets, what is inside, questions and buttons, laid out as blocks you can move and change.", href: "/platform/sales-pages" },
          { icon: "sparkle", title: "Any block, better", body: "An empty block of benefits, steps, who it is for or questions filled in; any block of words made clearer, shorter, more specific or warmer, with Undo beside it." },
          { icon: "gauge", title: "A second opinion on a page", body: "What to change first, three headlines to try, who it is for and not for, and the questions your page leaves open — including what visitors asked it and it could not answer." },
          { icon: "globe", title: "A page in another language", body: "The whole page translated into any of the store's seven languages in one step, names, numbers and prices kept, with Undo." },
          { icon: "camera", title: "Pictures described", body: "The description a person who cannot see a picture hears, written from the picture itself." },
          { icon: "list", title: "A course outline", body: "Up to 8 modules of up to 8 lessons, from what the course is about.", href: "/platform/courses" },
          { icon: "check", title: "A quiz for a lesson", body: "Questions drawn from the lesson's own text, or the main points you type for a video, with believable wrong answers of the same length and the right one moved around. They land in the quiz for you to read, change and save.", href: "/platform/quizzes-and-certificates" },
          { icon: "user", title: "The line about your store", body: "Three lines for under your store's name, from what it sells, to pick from or not.", href: "/platform/store-page" },
          { icon: "star", title: "Replies to reviews", body: "A public reply drafted from the buyer's own review, in their language. For a low rating it owns the problem without arguing or promising anything you did not.", href: "/platform/reviews" },
          { icon: "link", title: "Posts that bring visitors", body: "A post for X, an Instagram caption and a LinkedIn post about a product or the whole store, each with the right tagged link, so your numbers show which one brought the sale." },
          { icon: "notebook", title: "Blog posts", body: "A useful post on a topic you give, with headings and lists, mentioning one of your products only where it fits, for your store's blog.", href: "/platform/store-page" },
          { icon: "ladder", title: "A whole funnel", body: "In a funnel's review step: every new page's words, its form's questions, offers from your own products and three follow-up emails, from the products of its steps and what you say about who it is for and the proof you have. 2 of your monthly AI uses, or 3 with the emails, said before it runs. What only you know is marked ⟦like this⟧, and a page holding one stays hidden until you replace it.", href: "/platform/funnels" },
          { icon: "target", title: "Who a funnel is for", body: "A short summary of the audience and how your offer reads, from your own store's records only: what you typed, your products as saved, verified review counts, the last 30 days of visits and the questions visitors asked that your pages could not answer. Each statement names its source and date; anything a source does not hold is dropped, and it says what the records cannot tell. It does not search the web. 1 of your monthly AI uses.", href: "/platform/funnels" },
          { icon: "mail", title: "Emails to your list, on Studio", body: "A subject and a body to announce a product, remind people about one, teach something useful or share news, from a few words. Or a whole sequence of 3 to 7, for when someone joins, gets a product or first buys.", href: "/platform/email" },
          { icon: "chat", title: "Answers for your visitors", body: "Switch it on and visitors' questions on a product's page are answered only from what the page says; a question it cannot answer is shown to you, to answer on the page." },
          { icon: "info", title: "Your store's questions and answers", body: "The questions visitors ask before buying anything from you, answered only from what your store says, for your store page and for search engines.", href: "/platform/store-page" },
          { icon: "target", title: "Help to choose, on your store page", body: "With three products or more, a visitor says what they want and sees which of yours fit, and why, from your titles, summaries, prices and notes only. What they looked for and you do not sell yet reaches your studio.", href: "/platform/store-page" },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          `It has a monthly allowance: ${aiAllowanceWords()} Translating a long page takes one job for every 4,000 characters, and drafting a whole funnel 2, or 3 with its follow-up emails, each said before it runs.`,
          "It does not post, send or publish anything by itself, and it never writes in your buyers' names.",
          "It does not make images or videos.",
          "It does not rewrite what other people said: reviews and things said elsewhere are shown in their own words.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about the writing help",
        items: [
          { q: "Which model writes it?", a: "Anthropic's Claude, through its API, with our key. It receives what you typed and what the product's page says, and nothing about your buyers, members or list." },
          { q: "Which language does it write in?", a: "Your store's: English, Spanish, French, German, Italian, Dutch or Portuguese. A reply to a review is written in the review's own language." },
          { q: "Can it make claims I would not make?", a: "It is told never to invent a result, a number, a testimonial or a deadline, and a rewrite that brings in a number your page did not have is thrown away rather than shown. Read every draft before you publish it: it goes out under your name." },
        ],
      },
    ],
  },
  {
    slug: "reviews",
    section: "platform",
    eyebrow: "Verified reviews",
    title: "Reviews only a buyer",
    highlight: "can write",
    intro:
      "Stars and words from people your own Stripe account says paid. You can answer a review, and hide one only when it breaks a review rule (the same rules for every rating), but never change a word of it, and hiding one never lifts your average.",
    badge: WORKING,
    accent: "from-amber-brand to-pink-brand",
    plan: "creator",
    group: "grow",
    menu: { label: "Verified reviews", description: "Only from people who paid. You cannot edit them.", icon: "star" },
    related: ["sales-pages", "email", "store-page", "security"],
    blocks: [
      {
        kind: "how",
        title: "Where a review comes from",
        items: [
          { title: "A buyer pays", body: "For a file, a course, a membership that has charged, or an offer taken after paying." },
          { title: "They write it", body: "From their thank-you page, from their list of purchases, or from the one email that asks. Each one checks the order on your Stripe account first." },
          { title: "It goes live", body: "At once, with 1 to 5 stars, up to 1,000 characters, and the name they choose or “Verified buyer.” Your studio lists what has arrived since you last looked." },
        ],
      },
      {
        kind: "lead",
        text: "On Stan, reviews are added by the creator: its help center, read on September 27, 2026, says there is no way for customers to write one on a Stan store. Here, only customers can.",
      },
      {
        kind: "features",
        title: "The rules, and why they help you",
        items: [
          { icon: "check", title: "One voice per buyer", body: "One review per buyer and product, even if they bought it twice. They can change it or delete it." },
          { icon: "eye", title: "Hiding is said out loud", body: "A review is hidden only for a review rule, such as private information or abuse, never for its stars. Its words leave the page, but its stars stay in the average and the count, and the page says how many are hidden." },
          { icon: "ban", title: "A refund takes its stars back", body: "A payment refunded in full takes that review's stars out of the average. Its words stay, marked as refunded." },
          { icon: "chat", title: "Your answer, in public", body: "Up to 1,000 characters under any review. On " + AI_PLANS_WORDS + ", AI can draft it from the review itself, in the buyer's language: thanking them, answering what they said, and for a low rating owning it without arguing or promising anything you did not. You read it, change it and post it." },
          { icon: "user", title: "Their email is never shown", body: "Only the name they chose. Each review keeps its order reference, so you can find the payment in your Stripe dashboard." },
          { icon: "mail", title: "One email that asks, on Studio", body: "Off until you switch it on: each buyer is asked once per order, 3 to 30 days after buying, never offering anything in return. It counts in your monthly emails.", href: "/platform/email" },
          { icon: "camera", title: "A photo from the buyer", body: "A buyer can add one photo to their review: what they made, cooked or printed with what you sold. It is shrunk on their device before it is sent, kept with the review, and shown beside it. You cannot add or swap one, but you can take a photo off a review, and the review stays." },
          { icon: "star", title: "Stars where buyers decide", body: "The average on the product's card, on its page and on the preview image a shared link shows. Ten reviews on the page, the rest on a page of their own." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "You cannot edit or delete a buyer's review, or add one of your own. Only its buyer can change or delete it; deleting the whole product deletes its reviews.",
          "Booked calls and free products are not reviewed.",
          `The email that asks for reviews needs Studio, as email to your list does. On the ${PLAN_AT.creator} plan, buyers review from their thank-you page and their list of purchases.`,
          "One photo per review, no videos, and no reviews imported from another platform.",
          "Up to 2,000 reviews per product.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about reviews",
        items: [
          // 534 [FQ1], unit 24: what someone starting out asks, answered by the code (lib/reviews-faq.ts).
          ...reviewsBeginnerQuestions(),
          { q: "Why can't I delete a bad review?", a: "Because a rating you could clean up would be worth nothing to a buyer. You can hide its words, answer it, or refund the order in full, which takes its stars out." },
          { q: "Who on my team can moderate them?", a: "You, an Admin, an Editor and Support can hide and answer reviews. Switching on the email that asks is a setting, for you and Admins." },
        ],
      },
    ],
  },
  {
    slug: "currencies-and-ways-to-pay",
    section: "platform",
    eyebrow: "Currencies and ways to pay",
    title: "Your currency, and",
    highlight: "the ways your buyers pay",
    intro:
      "Each store charges in one of 15 currencies. At checkout, buyers meet the ways to pay you switched on in your own Stripe account: Apple Pay, Google Pay, Link, Klarna, Afterpay, Affirm, iDEAL, Bancontact and more, where they fit the buyer and the amount.",
    visual: "ways",
    badge: WORKING,
    accent: "from-mint-brand to-sky-brand",
    plan: "creator",
    group: "paid",
    menu: { label: "Currencies and ways to pay", description: "15 currencies, and the ways to pay your Stripe has on.", icon: "card" },
    related: ["your-stripe", "checkout", "funnels", "memberships"],
    blocks: [
      {
        kind: "how",
        title: "How it is set",
        items: [
          { title: "Pick the currency", body: "US, Canadian, Australian, New Zealand, Singapore and Hong Kong dollars, euros, pounds, Swiss francs, Swedish kronor, Norwegian and Danish kroner, Polish zloty, Japanese yen or Mexican pesos — among those your Stripe account can charge in." },
          { title: "Switch ways to pay on in Stripe", body: "Your studio lists what your Stripe account has on, read from Stripe each time, and links straight to the page in Stripe where you switch more on." },
          { title: "Stripe shows what fits", body: "Each buyer meets the ways that fit their country, the currency and the amount. Memberships and payment plans show only the ways Stripe can charge again each period." },
        ],
      },
      {
        kind: "features",
        title: "What it gives your buyers",
        items: [
          { icon: "phone", title: "Wallets", body: "Apple Pay, Google Pay and Link, and others such as Revolut Pay where your account has them." },
          { icon: "calendar", title: "Pay later", body: "Klarna, Afterpay or Clearpay, Affirm and the rest: the buyer pays in installments, and you are paid in full." },
          { icon: "bank", title: "Bank payments confirmed on the spot", body: "iDEAL, Bancontact, BLIK, Przelewy24 and others that confirm while the buyer waits." },
          { icon: "globe", title: "Prices written their way", body: "Every page, email, spreadsheet and number in your studio writes money in your store's currency: ¥2,700, not $27.00." },
          { icon: "chat", title: "Your store in seven languages", body: "English, Spanish, French, German, Italian, Dutch or Portuguese (Portugal), chosen once in your studio. Every page your buyers read, Stripe's checkout and every email your store sends them speak it, with dates, numbers and prices written that language's way. Drafts written with AI on " + AI_PLANS_WORDS + " — descriptions, sales pages, course outlines, emails — come in it too, and a page written in another language is translated in one step. Your studio stays in English." },
          { icon: "bolt", title: "Delivery that stays instant", body: "Ways to pay that are not confirmed while the buyer waits are left out, so nobody pays and then meets a page saying nothing was paid." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        intro: "Said here so nobody signs up expecting it.",
        items: [
          "One language per store. A page does not change language with each visitor's browser, and what you write yourself, such as product names, descriptions and lessons, is shown as you wrote it, not translated.",
          `Do not count on Stripe's own PayPal here. Stripe offers PayPal only to accounts in the EU (except Hungary), the UK, Switzerland, Norway and Liechtenstein, and its documentation, read on September 28, 2026, lists it as not supported for direct charges, which is how every sale here is charged. ${paypalConnectionWords()}${paypalAtCheckout() ? "" : " Stan lets creators connect a PayPal Business account, so on PayPal Stan is ahead for now."}`,
          "Slow bank debits and vouchers — ACH, SEPA and Bacs Direct Debit, bank transfers, Boleto, OXXO, Konbini, Multibanco — and stablecoins are left out on purpose, because they are not confirmed while the buyer waits.",
          "One-click offers after paying are shown only to buyers who paid by card, Apple Pay or Google Pay.",
          "One currency per store at a time. Changing it keeps every price's number — 49 dollars becomes 49 euros — so check your prices; it waits while a membership or payment plan is still running, and moving between the yen and a currency with cents is refused while the store has prices.",
          "Which ways to pay exist is up to Stripe and your country. We switch nothing on or off for you.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about currencies and ways to pay",
        items: [
          { q: "Does Marktmorgen take a cut of Klarna or other methods?", a: feeWords().fromAMethod },
          { q: "What does Stan offer?", a: "Stan offers Stripe and PayPal, and one currency per store chosen from ten, according to its help center, read on September 28, 2026. We offer 15, so we are ahead on currencies, and behind on PayPal." },
          { q: "Who can change the currency?", a: "You and an Admin. You are emailed whenever it changes." },
        ],
      },
    ],
  },
  {
    slug: "email-platforms",
    section: "platform",
    eyebrow: "Your email platform",
    title: "Your list, sent straight to",
    highlight: "the email tool you use",
    intro:
      `Connect Mailchimp, Kit, beehiiv or MailerLite, and the people who agree to hear from you are added there as they come in: free sign-ups once they confirm, buyers once they have paid, with the tags you choose. On the ${PLAN_AT.creator} plan, with no Zapier in between.`,
    visual: "emailPlatforms",
    badge: WORKING,
    accent: "from-violet-brand to-sky-brand",
    plan: "creator",
    group: "grow",
    menu: { label: "Email platforms", description: "Mailchimp, Kit, beehiiv or MailerLite, built in.", icon: "mail" },
    related: ["email", "webhooks", "store-page", "insights"],
    blocks: [
      {
        kind: "how",
        title: "Connected in a minute",
        items: [
          { title: "Paste an API key", body: "From your own account on the platform. It is checked with the platform, encrypted and kept; your studio shows only its last four characters." },
          { title: "Pick where people go", body: "The audience, form, publication or group, read fresh from your account." },
          { title: "Choose who is added", body: "Free sign-ups, buyers of every product or of some, and up to three tags per product — groups, on MailerLite." },
        ],
      },
      {
        kind: "lead",
        text: `Stan's help center, read on September 28, 2026, connects Mailchimp and other email tools through Zapier. Here all four are built in, on the ${PLAN_AT.creator} plan.`,
      },
      {
        kind: "features",
        title: "What it respects",
        items: [
          { icon: "check", title: "Only people who agreed", body: "A free sign-up who checked the box, or a buyer who checked “Also send me emails” or agreed on Stripe's page. Anyone else is never added, whatever the setting." },
          { icon: "ban", title: "Unsubscribed stays unsubscribed", body: "Mailchimp and beehiiv never resubscribe someone who left, and MailerLite is never asked to change anyone's status." },
          { icon: "refresh", title: "Tried again", body: "When the platform does not answer, we try again over about forty hours, seven tries in all." },
          { icon: "list", title: "A log you can read", body: "The last 50 people, each for up to a week, with what the platform did, or why someone was not added." },
          { icon: "mail", title: "An email when it changes", body: "You are told when a platform is connected or disconnected. Disconnecting deletes the key." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "One platform per store at a time.",
          "It only adds people. An unsubscribe or a change on the platform is not read back, and nothing is removed there.",
          "People who joined before you connected are not added: download your list as a CSV and import it there.",
          "Only an email address, a first name when there is one, and tags are sent: no order amounts or other details.",
          "Other platforms can be reached with webhooks and Zapier, not built in.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about email platforms",
        items: [
          { q: "Do I still need Studio?", a: "No. Connecting a platform is on every plan. Studio is for writing to your list from Marktmorgen itself." },
          { q: "What starts on the platform?", a: "Whatever you set up there. On Kit, people are added to the form you pick, which starts what you attached to it." },
        ],
      },
    ],
  },
  {
    slug: "outreach",
    section: "platform",
    eyebrow: "Outreach",
    title: "Write to the business",
    highlight: "that could pay you",
    intro:
      "Name a brand that could sponsor you, a partner who could sell your product for a share, or a company that could buy it. Your store finds the address that business published for being written to, writes a short email from what you tell it, and opens it as a draft in your own mailbox. You read it and send it yourself. On " + AI_PLANS_WORDS + ".",
    badge: WORKING,
    accent: "from-violet-brand to-sky-brand",
    plan: "pro",
    group: "grow",
    menu: { label: "Outreach", description: "A pitch to a sponsor, a partner or a business.", icon: "target" },
    related: ["affiliates", "email", "store-page", "insights"],
    blocks: [
      {
        kind: "how",
        title: "From a name to a draft in your mailbox",
        items: [
          { title: "Name the business", body: "Type its website, pick its country, and say in a sentence or two what you would offer: a sponsored video, a share of each sale, a product for its team." },
          { title: "Pick where to write", body: "Your store reads up to four pages of that website and lists the addresses the business printed there itself, the desk for partnerships first, each with the page it came from." },
          { title: "Read it, change it, send it", body: "A short email is written from your words and the business's own description of itself. It opens as a draft in your Gmail or your mail app, and you press Send." },
        ],
      },
      {
        kind: "lead",
        text: "Stan has no tool for writing to a sponsor, and Beacons writes a pitch without finding who to send it to or checking where it may be sent (both read on October 5, 2026). Here the contact, the rules of each country and the email are one tool, inside the plan you already pay for.",
      },
      {
        kind: "features",
        title: "What it holds every email to",
        items: [
          { icon: "check", title: "An address the business published", body: "Only an address at the business's own domain, printed on its own website. The page and the date it was read are kept with each email, so you can show where it came from." },
          { icon: "globe", title: "The law of the country", body: `For businesses in ${OPEN_COUNTRIES_WORDS}. Where only a company, or only a desk like partnerships@, may be written to, anything else is refused.` },
          { icon: "ban", title: "No means no", body: "A page that says it does not want proposals is not written to, and a website that closes itself to our reader in robots.txt is not read." },
          { icon: "mail", title: "Who you are, on every one", body: "Your name, your store, your postal address, where you found the address and how to stop it, under your own words. Those lines stay." },
          { icon: "shield", title: "A way out that needs nobody", body: "Every email carries a link the business can press to close itself to your store, or to every store here, for good. Your studio has the same button." },
          { icon: "list", title: "What became of each", body: "Draft, sent, answered, a deal, or asked to stop, in one list." },
        ],
      },
      {
        kind: "uses",
        title: "Three reasons to write",
        items: [
          { icon: "target", who: "A sponsor", what: "A brand whose customers are the people who follow you, for a paid mention or a collaboration." },
          { icon: "handshake", who: "A partner who sells for a share", what: "Somebody with an audience of their own, who would recommend your product through your affiliate program." },
          { icon: "basket", who: "A business that would buy", what: "A company your product or your time would be useful to, for its team or its customers." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "It does not choose the businesses: you name each one.",
          "It does not send anything. Every email leaves from your own mailbox, when you press Send.",
          "It does not write to private people, only to businesses.",
          "It does not write to businesses in Germany, the Netherlands, Spain, Italy or Poland, where the law asks for consent first, or in a country whose law we have not read yet.",
          "A business that prints no address on its own website cannot be written to from here. Many use a contact form instead, and the page links you to their site.",
          "It does not read your mailbox: you mark a pitch as sent, answered or a deal yourself.",
          `At most ${PITCHES_PER_DAY} a day, and the same business once in ${REPITCH_DAYS} days.`,
          "It is not legal advice. The email is yours, and you are its sender.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about Outreach",
        items: [
          { q: "Does it cost extra?", a: `No. It is part of the writing help, included on ${AI_PLANS_WORDS}. Each email written uses one of the month's writing jobs: ${aiAllowanceWords()}` },
          { q: "Will businesses answer?", a: EXPECTATION },
          { q: `Why only ${PITCHES_PER_DAY} a day?`, a: "A mailbox that writes to many strangers in a day gets marked as spam, and then stops reaching the people who asked to hear from you. A few specific emails do better than many." },
          { q: "What does the business see?", a: "An email from you, from your own address, with your name, your store and your postal address under it, the page where you found their address, and a link to stop it." },
        ],
      },
    ],
  },
  {
    slug: "teams-and-stores",
    section: "platform",
    eyebrow: "Teams and stores",
    title: "Help to run it,",
    highlight: "without sharing your login",
    intro:
      "Up to five stores in one account, and up to five people on each store's team as Admin, Editor or Support, each signing in with their own email. What each role may do is checked on our server for every request.",
    visual: "team",
    badge: WORKING,
    accent: "from-sky-brand to-violet-brand",
    plan: "creator",
    group: "grow",
    menu: { label: "Teams and stores", description: "Five stores per account, five people per store.", icon: "users" },
    related: ["security", "phone-notifications", "email", "store-page"],
    blocks: [
      {
        kind: "how",
        title: "How someone joins",
        items: [
          { title: "Invite them by email", body: `With a role. The link works once, for ${INVITE_DAYS} days.` },
          { title: "They tap it", body: "That proves the inbox is theirs. From then on they sign in the way you do, and find your store in their studio." },
          { title: "You are told", body: "An email when someone joins and when a role changes. Removing someone takes effect on their next click." },
        ],
      },
      {
        kind: "lead",
        text: "Stan's help center, read on September 28, 2026, says there is no way to give a team member admin access to your store without sharing your login. Here each person has their own.",
      },
      {
        kind: "features",
        title: "Three roles, and the owner",
        items: [
          { icon: "user", title: "Owner", body: "Everything. Only the owner pays for the store, connects its Stripe account, manages the team and deletes the store." },
          { icon: "shield", title: "Admin", body: "Everything else: the address, domain, pixels, tax, webhooks, discounts, affiliates, sending email, importing from another platform and downloading buyers' data." },
          { icon: "type", title: "Editor", body: "Products, courses, calls, bundles, sales pages, the store page, the community's live events, and moderating the community and reviews. Writes email drafts but does not send them." },
          { icon: "chat", title: "Support", body: "Reads orders and bookings, sends a buyer their purchase email again, sees who is coming to live events, and moderates the community and reviews. Edits nothing else." },
          { icon: "list", title: "An activity log", body: "Every change and download the people you invited make, and every change to the team: the last 500 lines." },
          { icon: "mail", title: "Email drafts", body: "Up to 20 per store, written by you, an Admin or an Editor, and sent only by you or an Admin." },
        ],
      },
      {
        kind: "features",
        title: "Your account, and more than one store",
        items: [
          { icon: "store", title: "Up to five stores", body: "Each with its own address, products, buyers and Stripe account, and a plan of its own to take payments. You switch between them at the top of your studio." },
          { icon: "copy", title: "One store copied into another", body: "Open a new store with everything you made in another: its products, pages, forms and funnels arrive as drafts, and its store page's setup if you ask. You see what it makes and what it leaves out before anything is written, and a copy that does not fit as a whole is refused. Customers, orders, contacts, emails, answers, reviews, payments, files and pictures never come across." },
          { icon: "key", title: "Passkeys, if you want them", body: "Sign in with the face, fingerprint or PIN that unlocks your phone or laptop. Up to ten per account, and the emailed link keeps working." },
          { icon: "alert", title: "A new browser, an email", body: "After your first sign-in, signing in from a browser your account has not used before sends you an email saying when, how and in which browser." },
          { icon: "refresh", title: "Purchase emails sent again", body: "From your list of sales, to the address the buyer paid with, never to one typed in." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        items: [
          "Five people per store, invitations still waiting included. Roles are the three above: no custom roles, and no role for one product only.",
          "Each extra store needs a plan of its own to take payments, charged from the day its plan starts. The free trial is for an account's first store.",
          "A store can be deleted from the studio only while it has no products; your first store stays with your account.",
          "A booked call's confirmation cannot be sent again from the studio.",
          "Passkeys sign you in on marktmorgen.com, where the studio is, not on a store's own domain.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about teams and stores",
        items: [
          // 534 [FQ1], unit 20: what someone starting out asks, answered by the code (lib/team-faq.ts).
          ...teamBeginnerQuestions(),
          { q: "Does a team member need a plan?", a: "No. Someone you invite needs no plan or payment of their own." },
          { q: "Can Support see my buyers' addresses?", a: "Yes, in orders and bookings, because answering buyers is the job. Support cannot download your list or sales as files." },
        ],
      },
    ],
  },
  {
    slug: "phone-notifications",
    section: "platform",
    eyebrow: "Phone notifications",
    title: "A sale, and your phone",
    highlight: "tells you",
    intro:
      "Turn notifications on in your studio, on your phone or your computer: every sale, every booking, a report in your community, a new affiliate application, a live event about to start, and a comment under a lesson.",
    visual: "phone",
    badge: WORKING,
    accent: "from-pink-brand to-amber-brand",
    plan: "creator",
    group: "grow",
    menu: { label: "Phone notifications", description: "Sales and bookings on your lock screen.", icon: "phone" },
    related: ["teams-and-stores", "calls", "community", "affiliates"],
    blocks: [
      {
        kind: "how",
        title: "How it works",
        items: [
          { title: "On iPhone, install the studio", body: "In Safari: Share, then “Add to Home Screen.” On Android and on a computer, notifications come straight from the browser, and the studio can be installed there too." },
          { title: "Turn notifications on", body: "In the studio, choose which ones you want on that device, and send yourself a test." },
          { title: "It arrives as it happens", body: "Sent the moment the sale or the booking is confirmed, without making any buyer wait for it." },
        ],
      },
      {
        kind: "features",
        title: "What it tells you",
        items: [
          { icon: "receipt", title: "Sales", body: "The product and the amount, for every paid order and every one-click offer taken after it." },
          { icon: "calendar", title: "Bookings", body: "The product, the time and what was paid." },
          { icon: "alert", title: "Reports", body: "A member reported a post or a comment in your community." },
          { icon: "handshake", title: "Affiliate applications", body: "Someone confirmed an application to your program." },
          { icon: "chat", title: "Course comments", body: "A student commented under a lesson: which lesson, and the start of what they wrote." },
          { icon: "video", title: "Live events", body: "One of your community's live events starts in 15 minutes: time to open the room.", href: "/platform/live-events" },
          { icon: "lock", title: "Written for a lock screen", body: "Amounts, titles, times and the start of a lesson comment, as the student wrote it. We never add a buyer's name or email address." },
          { icon: "users", title: "Each person their own", body: `Up to ${MAX_DEVICES} devices each. Your team members see only their own devices, and hear only what their role may see.` },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        intro: "Said here so nobody signs up expecting it.",
        items: [
          "It is not an app from the App Store or Google Play: it is the studio installed from the browser. Stan has a native iPhone app.",
          "On iPhone and iPad it needs iOS 16.4 or later and the studio added to the home screen.",
          "It uses the browser's own Web Push, so a browser or phone setting that blocks notifications blocks these too.",
          "Reports, affiliate applications and course comments are sent at most 20 an hour per store, each; sales and bookings are never held back.",
          "Notifications only tell you: answering and changing things happens in the studio.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about phone notifications",
        items: [
          // 534 [FQ1], unit 19: what someone starting out asks, answered by the code (lib/phone-faq.ts).
          ...phoneBeginnerQuestions(),
          { q: "Which plan is it on?", a: `Every plan, the ${PLAN_AT.creator} one included.` },
          { q: "Does a new device get notifications without me knowing?", a: "No. You are emailed each time notifications are turned on for a new device." },
        ],
      },
    ],
  },
  {
    slug: "switching-to-marktmorgen",
    section: "platform",
    eyebrow: "Moving to Marktmorgen",
    title: "Bring your store",
    highlight: "with you",
    intro:
      "Four spreadsheets, from Stan, Gumroad, Kajabi, Patreon, Mailchimp or anywhere else: your list, your products, the people who already bought from you and your members. You say which column is which, and every row that is not brought in is listed with the reason.",
    badge: WORKING,
    accent: "from-violet-brand to-sky-brand",
    plan: "creator",
    group: "grow",
    menu: { label: "Moving from another platform", description: "Your list, products, past buyers and members, from a spreadsheet.", icon: "door" },
    related: ["move-from-clickfunnels", "email", "community", "courses"],
    blocks: [
      {
        kind: "how",
        title: "How a move works",
        items: [
          { title: "Export from where you are", body: "A CSV file from your old platform or email tool. The studio reads it in your browser first and shows you the rows." },
          { title: "Match the columns", body: "Email, name, labels and consent for a list; title, price, description and link for products; email and product for buyers; email, membership and renewal date for members. The studio guesses, and you check." },
          { title: "See what came in", body: "What was added, what was already there and what was left out, and a spreadsheet of every row that was not brought in, with its row number and why." },
        ],
      },
      {
        kind: "features",
        title: "Four imports",
        items: [
          { icon: "mail", title: "Your list, up to 50,000 a file", body: "Only people who agreed to hear from you: you confirm it each time, and a consent column in the file narrows it further. Nobody who unsubscribed here is added back, and nobody is emailed because of the import.", href: "/platform/email" },
          { icon: "tag", title: "Labels that come along", body: "The labels in your file, and one you add to everyone in it, go with each contact, next to their name." },
          { icon: "store", title: "Products, up to 500 a file, as drafts", body: "Title, price in your store's currency, description with the HTML of another platform turned into plain text, free or paid, and a link when the product is a link. Each waits in your studio until you publish it." },
          { icon: "users", title: "Past buyers, up to 20,000 a file", body: "Each gets what they bought (the file, the link, the course or each product of a bundle) on your store's list of purchases, marked as brought over from another platform. No payment is taken and no receipt is sent." },
          { icon: "repeat", title: "Members, up to 20,000 a file", body: "Each member gets one email with their own link to keep their membership here, on your Stripe account. Their card is first charged on the day the membership would have renewed where it was, the date in your file, so nobody pays twice for the same weeks; one reminder goes three days before that date to those who have not kept it. You stop the renewals on the other platform yourself, and the studio asks you to confirm you will." },
          { icon: "chat", title: "Into your community", body: "A buyer brought over for a product that opens your community is let in, like anyone who bought it here.", href: "/platform/community" },
          { icon: "gift", title: "One email, if you choose", body: "Check it, and each buyer gets one email from your store's name saying what moved and how to open it. Up to 20,000 buyers per store in 30 days, and nothing else is sent because of it." },
          { icon: "shield", title: "Checked row by row", body: "Every row is checked again on our side, the way the studio checks a product or an address, and importing the same file twice gives nobody anything twice." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        intro: "Said here so nobody signs up expecting it.",
        items: [
          "Files, pictures and course lessons are not imported from the other platform. Add a product's file from its row in the studio, and a course's videos as lessons, up to 50 at once, then import the buyers who should have it.",
          "Memberships are never given: a member keeps theirs by paying here, from its renewal date, with the link they are emailed, and somebody who does nothing is never charged. Calls and products with several prices cannot be given to past buyers.",
          "A membership that ends after a set number of payments cannot be moved, because how many each member has left is not known.",
          "Buyers brought over get no license key here; the key they had on the old platform is still theirs.",
          "Buyers brought over are not sales: they are not in your numbers, not sent to webhooks, not credited to affiliates, and cannot write a review.",
          "An import cannot be undone in one step. A student can be taken off a course, and a member out of the community, one at a time.",
          "Posts and comments from a community elsewhere do not come across. One import runs at a time per store.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about moving",
        items: [
          { q: "In what order should I import?", a: "Products first, because the buyers' file names them by their title or their ID here. Then add each product's file or lessons, then your list and your buyers." },
          { q: "Which plan is it on, and who can run it?", a: "Every plan. You and your Admins can import; Editors and Support cannot. The one email to past buyers, and the emails to members, are sent only while your plan or its trial is running." },
          { q: "How do my members move without paying twice?", a: "Make the membership here first, at the same price. Export your members with the date each would next renew, import them under Your members, and stop the renewals where they are now. Each member keeps theirs with their own link: the card is taken then and first charged on that date. A date less than two days away is charged when they keep it, and their page says so before they press." },
          { q: "Is my file kept?", a: "The file itself never reaches us: your browser reads it and sends the columns you matched. Those rows, the report of what was left out and the import's counts are deleted two weeks after the import began, so download the report before then. What the import added (contacts, drafts and purchases) stays." },
          { q: "What does Stan offer here?", a: "According to its help center, read on September 27, 2026, Stan imports up to 5,000 contacts per store in all, and has you send them an email to opt in again; it gives a customer a download, a course or the community one customer at a time, with no way to undo that in bulk. We found no import for products there. Here you confirm your contacts agreed instead of us emailing them, and buyers come in from a file." },
        ],
      },
    ],
  },
  {
    slug: "move-from-clickfunnels",
    section: "platform",
    eyebrow: "Moving from ClickFunnels",
    title: "Bring your ClickFunnels business",
    highlight: "with you",
    intro:
      "Your contacts with their consent status, your products, the people who already bought from you and your funnel's pages, from the files ClickFunnels lets you export and the pages you save from your own browser. Each one is checked in a dry run that saves nothing and shows what every row and every page will become, then imported once.",
    badge: WORKING,
    accent: "from-violet-brand to-amber-brand",
    plan: "creator",
    group: "grow",
    menu: { label: "Move from ClickFunnels", description: "Contacts, products, past buyers and funnel pages, checked in a dry run first.", icon: "door" },
    related: ["switching-to-marktmorgen", "funnels", "email", "sales-pages"],
    blocks: [
      {
        kind: "how",
        title: "How a move from ClickFunnels works",
        items: [
          { title: "Export what ClickFunnels exports", body: "Your Products, Contacts and Orders, each from its own page in ClickFunnels, with the fields you choose. Your funnel's pages: open each published page in your browser and save it as “Webpage, HTML Only”." },
          { title: "Check it in a dry run", body: "The studio reads each file, matches ClickFunnels' column names, and checks every row and every page on our side the way the import will, against your store as it is. It lists what will be made, what maps to what, and what cannot come across, and saves nothing." },
          { title: "Import it once", body: "Then import. Running the same file or the same funnel again makes nothing twice. A funnel is made switched off, its pages kept from visitors until you check them." },
        ],
      },
      {
        kind: "features",
        title: "What comes across, and as what",
        items: [
          { icon: "mail", title: "Contacts, up to 50,000 a file", body: "With their names and tags. Only those ClickFunnels marks Subscribed, after you confirm they agreed, can be emailed here. Everyone else comes in as a contact you cannot email, and those marked Unsubscribed or Undeliverable stay unsubscribed here: no later import can make them people you email.", href: "/platform/email" },
          { icon: "tag", title: "Products, up to 500 a file", body: "Each one a draft in your studio with its name, price in your store's currency and description, until you publish it. A product already in your store by the same name is not made again." },
          { icon: "users", title: "Past buyers, up to 20,000 rows", body: "From your Orders export: each buyer is given what they bought, matched to your products by name. Orders its Billing status marks refunded, failed, canceled or pending are left out. No payment is taken, and one email to each buyer is sent only if you choose it." },
          { icon: "layout", title: "Funnel pages, up to 10 at a time", body: "Each saved page's headings, paragraphs, lists, buttons, YouTube, Vimeo and Loom videos and its form become blocks of one of your store's own pages, kept from visitors until you let it out, and the pages a funnel of pages, switched off.", href: "/platform/funnels" },
          { icon: "card", title: "Checkouts and order bumps", body: "A page you say was an order form becomes your product's own page and checkout in the funnel. Each order bump it had becomes a box at that checkout for the product you pick, at that product's own price." },
          { icon: "ladder", title: "Upsells and downsells", body: "A page you say was an upsell becomes an offer after paying for the checkout before it, in one click, with the page's headline and first lines. A downsell is shown to whoever says no to the upsell just before it." },
          { icon: "list", title: "A repair report", body: "For every file, each row that cannot come in, with its row number, column and why, as a spreadsheet. For every page, everything that was not brought over and why: scripts, tracking, pictures, other video players, payment fields, consent boxes, countdown timers, menus." },
          { icon: "shield", title: "Only your own files", body: "We never sign in to ClickFunnels, fetch your pages or load their pictures. Only the files you choose are read, and no code from them ever runs here: what comes across is your words, in this platform's own blocks." },
        ],
      },
      {
        kind: "limits",
        title: "What it does not do",
        intro: "Said here so nobody moves expecting it.",
        items: [
          "ClickFunnels has no export for a whole funnel: its share link copies a funnel into another ClickFunnels account only. So you say, page by page, whether each was a page, an order form, an upsell or a downsell, and which of your products it sells.",
          "Pictures are not copied: they are files on ClickFunnels' servers. Upload yours to each page from the page editor.",
          "The page's design, layout, fonts, scripts and custom code do not come across, and neither do ClickFunnels' templates. Your pages use your store's look.",
          "Workflows, email broadcasts and automations are not imported. Courses, their lessons and their members, memberships and subscriptions are not read from ClickFunnels files; bring members with the Your members import, where each keeps their membership by paying here from its renewal date.",
          "Products are made with one price each. Variants, several prices and subscription prices from a Products export are not read: add them on the product afterward.",
          "An order bump's price is the bumped product's own price here, and an upsell's the offered product's own price; change either afterward, never above the product's own price.",
          "Countdown timers are not carried over. A countdown here runs to one real date you set.",
          "An import cannot be undone in one step. Imported pages, forms and funnels are removed like any other, from the studio.",
          "ClickFunnels is a trademark of its owner. Marktmorgen is not affiliated with it; this import reads the files ClickFunnels lets its users export, as its help center describes them.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about moving from ClickFunnels",
        items: [
          { q: "In what order should I import?", a: "Products first, because your Orders file and your funnel name them. Then your contacts, your past buyers, and last your funnel's pages." },
          { q: "Which contacts can I email after the move?", a: "Only those ClickFunnels marks Subscribed, and only after you check the box confirming those people agreed to receive your emails. Nobody is emailed because of the import." },
          { q: "Is anything saved during the dry run?", a: "No. The dry run checks every row and every page and lists what would happen. Nothing is added to your store until you press import." },
          { q: "What if I run the same import twice?", a: "Nothing is made twice: contacts already on your list are left as they are, products already in your store by name are not made again, buyers keep what they have, and the same funnel import answers with what the first one made." },
          { q: "Which plan is it on, and who can run it?", a: "Every plan. You and your Admins can import; Editors and Support cannot." },
        ],
      },
      { kind: "features", title: "Compare before moving", items: [
        { icon: "scale", title: "Marktmorgen vs ClickFunnels", body: "Read the dated comparison of plans, page editing and payment fees alongside this migration guide.", href: "/proof/clickfunnels" },
      ] },
    ],
  },
  {
    slug: "security",
    section: "platform",
    eyebrow: "Security",
    title: "How your store",
    highlight: "and your buyers are protected",
    intro:
      "What we do, written so you can check it: payments on your own Stripe account, sign-in without passwords, strict rules on what your pages may run, and a refund that closes what it paid for. And, at the end, what none of it does.",
    badge: WORKING,
    accent: "from-violet-brand to-mint-brand",
    plan: "creator",
    group: "paid",
    menu: { label: "Security", description: "Sign-in, checkout, files and refunds, in plain words.", icon: "shield" },
    related: ["your-stripe", "instant-delivery", "webhooks", "license-keys"],
    blocks: [
      {
        kind: "features",
        title: "Your money and your account",
        items: [
          { icon: "bank", title: "Sales on your own Stripe", body: "The buyer pays on Stripe's own checkout, on your account. We never see a card number and never hold a balance of yours." },
          { icon: "tag", title: "Prices worked out on our side", body: "What a buyer is charged is read on our server from what you saved, never from anything the page sends." },
          { icon: "key", title: "No password to steal", body: "You sign in with a link sent to your email. It works once, stops working after 15 minutes, and there is a limit on how often a link can be requested." },
          { icon: "phone", title: "Passkeys, if you want them", body: "Optional: sign in with the face, fingerprint or PIN that unlocks your phone or laptop. We keep only the public half of the key, and the emailed link keeps working." },
          { icon: "lock", title: "Two-step login", body: "Turn it on and the emailed link also asks for the six-digit code in your authenticator app, so somebody who gets into your email still cannot open your studio. Ten recovery codes for when your phone is not at hand, each good once; a passkey needs no code. A code is never taken twice, five wrong ones end the login, and turning it on or off emails you. Turning it on asks for a recovery address, a second inbox: lose your phone and your codes, and a link sent there lets you straight back in." },
          { icon: "mail", title: "Lost your email? Still yours", body: "Add a recovery address, a second inbox you confirm with a code, and a passkey. If you can no longer open the inbox you log in with, a passkey logs you in with everything open, and a link to your recovery address lets you in at once, with payments, exports, settings, sending and your sign-in address opening a week later, unless your old inbox answers first. Then move your sign-in address to one you have. Nobody here has to open anything for you." },
          { icon: "users", title: "Team roles checked on our server", body: "What an Admin, an Editor or Support may do is checked on the server for every request, not only hidden on the screen." },
          { icon: "refresh", title: "A fresh session every time", body: "Each sign-in starts a new session, and a session the browser held before is closed." },
          { icon: "door", title: "Log out of all devices", body: "One button at the bottom of your studio closes every session you have open, everywhere." },
          { icon: "mail", title: "An email when something important changes", body: "Whenever your Stripe account, your domain or your webhooks change, we write to your sign-in address saying what changed and when." },
        ],
      },
      {
        kind: "features",
        title: "Your pages",
        items: [
          { icon: "lock", title: "A strict policy on what runs", body: "Store pages, on marktmorgen.com and on your own domain, the studio and signing in carry a Content-Security-Policy with a new nonce on every response, so text somebody typed cannot run as a script." },
          { icon: "target", title: "Pixels only where allowed", body: "Your Meta, Google, TikTok and Pinterest pixels load only after the visitor agrees, where the law says they must be asked." },
          { icon: "shield", title: "Forged requests refused", body: "Every request that changes something must come from this site, and our cookies are HttpOnly and SameSite." },
          { icon: "globe", title: "The usual browser protections", body: "HSTS, nosniff, a referrer policy, Cross-Origin-Opener-Policy, a Permissions-Policy that switches off camera, microphone and location, and no framing by other sites." },
          { icon: "link", title: "Emailed links go to us or to you", body: "Every link we email points at marktmorgen.com or at your store's own domain, never at an address a request made up." },
        ],
      },
      {
        kind: "features",
        title: "Files, refunds and bots",
        items: [
          { icon: "download", title: "Downloads that expire", body: "The download on the thank-you page works for 3 days; after that the buyer gets it again by email. Where a file is stored is never shown, and large files go through signed links that expire in minutes." },
          { icon: "file", title: "Files that cannot run", body: "Every file is handed over as a download, with headers that stop a browser running anything inside it." },
          { icon: "ban", title: "A full refund closes the door", body: "Refund a payment in full on your Stripe account and its download stops at once, its course closes within 10 minutes, the community within 5 minutes, and its license key is revoked within about 5 minutes. A partial refund keeps access." },
          { icon: "clock", title: "Limits that stop bots", body: "Checkouts are limited to 20 per 10 minutes per connection per store, and bookings and every form that sends an email have limits of their own, so a script cannot sit on your limited stock or your call times." },
          { icon: "plug", title: "Signed webhooks, guarded addresses", body: "Webhooks are signed with HMAC-SHA256, and a calendar or webhook address that points into a private network is refused." },
          { icon: "lock", title: "Email platform keys kept encrypted", body: "The API key of your Mailchimp, Kit, beehiiv or MailerLite is encrypted before it is stored, and never shown again." },
          { icon: "star", title: "Reviews only from paying buyers", body: "A review can be written only for an order your own Stripe account says was paid and not refunded in full." },
        ],
      },
      {
        kind: "limits",
        title: "What this does not do",
        intro: "Said here so nobody relies on it for more than it does.",
        items: [
          "Two-step login is off until you turn it on. Without it, your account is as safe as your email inbox: protect that one.",
          "Lose your phone, your recovery codes and every passkey, and a link to your recovery address gets you straight back in. Lose that inbox too, and you still get in at once, with the emailed link alone: you can sell, edit your products and pages and answer buyers, while payments, your plan, your team, exports, settings, sending to your list and your sign-in address stay locked for 7 days, until two-step login turns off. That lock is what stops somebody who only has your sign-in inbox, and a login with a code or a passkey, or Cancel in your studio, logs them out.",
          "On a payment plan, a refund in full of the first payment closes access like any refund in full; a refund of a later payment is not detected, so take the buyer off the course, or remove their access, yourself. A refunded membership closes when its subscription is canceled in Stripe.",
          "A refund cannot take back a file already saved, or a product delivered as a link to somewhere else.",
          "The limits on checkouts, bookings and forms are counted in our database. If it cannot be reached, they let requests through rather than stop a buyer from paying.",
          "Pages built ahead of time, such as the home page, the help center and the blog, carry a policy without a nonce. Nothing on them comes from a creator or a visitor.",
        ],
      },
      {
        kind: "faq",
        title: "Questions about security",
        items: [
          // 534 [FQ1], unit 21: what someone starting out asks, answered by the code (lib/security-faq.ts).
          ...securityBeginnerQuestions(),
          { q: "What if I get an email about a change I did not make?", a: "Log in, choose “Log out of all devices” at the bottom of your studio, put the setting back, and reply to that email so we can help." },
          { q: "Who handles a refund?", a: "You do, in your own Stripe dashboard. What a full refund closes here happens by itself, read from Stripe." },
          { q: "Can I sign in with a password?", a: "No. There is no password to set, and none kept here to be stolen. Each link we email works once, for 15 minutes." },
          { q: "How do I report a security problem?", a: "Email support@marktmorgen.com with what you found and how to see it, and a person answers by email. Please test only your own store and your own data. The same address is in our security.txt file, at marktmorgen.com/.well-known/security.txt, the standard place security researchers look." },
        ],
      },
    ],
  },
];

/* ------------------------------------------------------- for creators ---- */

const BASE_CREATOR_PAGES: TopicPage[] = [
  {
    slug: "coaches",
    section: "for",
    eyebrow: "For coaches and teachers",
    title: "A store for coaches,",
    highlight: "from free worksheet to paid hour",
    intro:
      "The worksheet that starts the conversation, the program that does the work and the hour of your time — on one page, each at its own price, paid into your own Stripe account.",
    badge: WORKING,
    accent: "from-sky-brand to-violet-brand",
    related: ["calls", "courses", "checkout", "email"],
    photo: { id: "photo-1758599880979-f6a64947b541", alt: "A woman sitting on the floor of her living room, talking through a lesson to a camera" },
    blocks: [
      {
        kind: "storecard",
        title: "What a coaching store looks like",
        creator: "Marcus Reid",
        tagline: "Career coaching for first-time managers",
        photo: "photo-1775196610640-5e70ef38f846",
        alt: "A man with a short beard, photographed outdoors",
        items: [
          { label: "The first-week worksheet", detail: "Free, for an email address", price: "Free" },
          { label: "Interview workbook", detail: "PDF, 18 pages", price: "$19" },
          { label: "Six-week program", detail: "A course, one module a week; or 3 payments of $30", price: "$89" },
          { label: "One hour with Marcus", detail: "A call, booked in your time zone", price: "$180" },
        ],
      },
      {
        kind: "ladder",
        title: "The path from follower to client",
        intro: "Each step is a real product type here, and each one leads to the next.",
        items: [
          { step: "1", icon: "gift", title: "A free worksheet", price: "Free", body: "Given for a confirmed email, so the people who want more are on your list.", href: "/platform/store-page" },
          { step: "2", icon: "file", title: "A workbook", price: "$19", body: "The first thing they pay for, delivered the second the payment clears.", href: "/platform/instant-delivery" },
          { step: "3", icon: "book", title: "A program", price: "$89", body: "A course whose modules open week by week, in one payment or in installments.", href: "/platform/courses" },
          { step: "4", icon: "calendar", title: "Your time", price: "$180", body: "A call booked into your hours, paid before it is on your calendar.", href: "/platform/calls" },
        ],
      },
      {
        kind: "features",
        title: "What coaches use most",
        items: [
          { icon: "calendar", title: "Calls in their time zone", body: "Set your hours once, in your own time zone; each client sees the free times in theirs, and each of you gets an email about the booking.", href: "/platform/calls" },
          { icon: "calendar", title: "Programs in installments", body: "Two to twelve payments: the program opens after the first, and the plan ends by itself after the last.", href: "/platform/checkout" },
          { icon: "refresh", title: "A sequence after each sale", body: "On Studio, a few emails in the days after someone buys — what to do first, and when to book the call.", href: "/platform/email" },
          { icon: "users", title: "A monthly group", body: "A membership that hands over the meeting link, which members cancel themselves.", href: "/platform/memberships" },
        ],
      },
      {
        kind: "limits",
        title: "Where it falls short for coaches today",
        items: [
          "Calls read your calendar's busy times but write bookings into it only when they use Google Meet: otherwise you subscribe to a feed of them.",
          "Clients can move their own booking up to twice, but to cancel they reply to the confirmation email, and a refund is yours to make in Stripe.",
          "No Zoom link is made for you yet: calls happen in a Google Meet made on your connected Google Calendar, on the meeting service whose link you give, or in a Jitsi Meet room made for each booking. Live events in your community work the same way.",
        ],
      },
      {
        kind: "faq",
        title: "Questions coaches ask",
        items: [
          { q: "Can I sell a package of several calls?", a: "Yes, for a call with weekly hours: 2 to 20 sessions at one price, with a time limit you choose or none. The buyer pays once and books each session from their own link whenever they like, with the reminders and the meeting link every booking gets." },
          { q: "Where does the video call happen?", a: "In a Google Meet made for each booking once you connect your Google Calendar, on the service whose link you give — Zoom or any other — or in a private Jitsi Meet room made for each booking. The link goes into every invitation." },
          { q: "Can I see who finished the program?", a: "Yes. Your studio shows each student and how many lessons they marked done." },
        ],
      },
    ],
  },
  {
    slug: "cooks",
    section: "for",
    eyebrow: "For cooks and nutritionists",
    title: "A store for cooks",
    highlight: "that sells the week, then the season",
    intro:
      "Meal plans in sizes, a free recipe that brings people to your list, and a monthly plan for the ones who want every week. The meal plans are in the demo store, and you can buy them right now.",
    badge: WORKING,
    accent: "from-mint-brand to-amber-brand",
    related: ["price-options", "memberships", "checkout", "email"],
    photo: { id: "photo-1780277993159-b4ca60e8922d", alt: "A cook in an apron plating a dish in a bright kitchen" },
    blocks: [
      {
        kind: "storecard",
        title: "The live demo store",
        creator: "Harbor Kitchen",
        tagline: "Simple family meals by Jenny",
        photo: "photo-1543871595-e11129e271cc",
        alt: "A woman with long dark hair, smiling",
        items: [
          { label: "Weekly meal planner, 1 week", detail: "PDF, 1 page", price: "$27" },
          { label: "Weekly meal planner, 5 weeks", detail: "PDF, 5 pages", price: "$39" },
        ],
      },
      {
        kind: "ladder",
        title: "The path from recipe to regular",
        intro: "Built only from what works here today.",
        items: [
          { step: "1", icon: "gift", title: "The free recipe", price: "Free", body: "For a confirmed email. The part people share is the part that brings the next buyer.", href: "/platform/store-page" },
          { step: "2", icon: "tag", title: "A plan in sizes", price: "$27 or $39", body: "One week to try, five for the person who already trusts you — one product, two prices.", href: "/platform/price-options" },
          { step: "3", icon: "plus", title: "The shopping list, added at checkout", price: "+$4", body: "A box above the buy button, never checked for the buyer.", href: "/platform/checkout" },
          { step: "4", icon: "repeat", title: "Every month", price: "$12 a month", body: "A membership for the regulars, canceled by them on their own.", href: "/platform/memberships" },
        ],
      },
      {
        kind: "features",
        title: "What food creators use most",
        items: [
          { icon: "phone", title: "Opened in a kitchen, on a phone", body: "The demo store, a real store with photos on it, scored 93 and 94 on Google PageSpeed on a simulated phone, on October 5, 2026.", href: "/proof/speed" },
          { icon: "book", title: "A cooking course", body: "Batch cooking on video, a free first lesson on your store, a module that opens each week.", href: "/platform/courses" },
          { icon: "download", title: "Lost the plan? Back by email", body: "A buyer who changes phones gets everything they bought again, with the address they paid with.", href: "/platform/instant-delivery" },
          { icon: "chart", title: "Which post sold the plan", body: "Visits from Instagram, TikTok and Pinterest counted separately, next to the sales from your Stripe.", href: "/platform/insights" },
        ],
      },
      {
        kind: "limits",
        title: "Where it falls short for cooks today",
        items: [
          "A printed cookbook ships from you: one shipping charge per order, to the countries you choose, and you mark each order shipped. No print-on-demand, and no live shipping rates from carriers.",
          "No printed plans made to order, and no personal plans generated for each buyer.",
          "A membership that hands over a link keeps working for someone who stops paying: change the link each month, or deliver the plans as a course.",
        ],
      },
      {
        kind: "faq",
        title: "Questions cooks ask",
        items: [
          { q: "Can I try buying from a cook's store before signing up?", a: "Yes. Open the demo store, pick a size and pay with the Stripe test card 4242 4242 4242 4242. The PDF of the size you chose arrives on screen." },
          { q: "Can I give the recipe away without an email?", a: "Yes: put it on your page as a link with no price. A free product is the one that asks for an email." },
          { q: "Is sales tax added to a meal plan?", a: "Only when you switch Stripe Tax on in your studio, once your Stripe tax setup is done." },
        ],
      },
    ],
  },
  {
    slug: "fitness",
    section: "for",
    eyebrow: "For fitness creators",
    title: "A store for trainers,",
    highlight: "from starter block to program",
    intro:
      "A short block to start, a full program as a course with video, a form check booked and paid, and a monthly club — on one page, charged on your own Stripe.",
    badge: WORKING,
    accent: "from-pink-brand to-violet-brand",
    related: ["courses", "calls", "memberships", "checkout"],
    photo: { id: "photo-1787647090008-4b88ffc977b7", alt: "A movement teacher showing a stretch to someone in a light studio" },
    blocks: [
      {
        kind: "storecard",
        title: "What a fitness store looks like",
        creator: "Dani Cole",
        tagline: "Strength for people with desk jobs",
        photo: "photo-1770393391946-7d9b658deec3",
        alt: "A woman with natural hair, photographed against a dark green wall",
        items: [
          { label: "4-week starter block", detail: "PDF with video links", price: "$29" },
          { label: "12-week program", detail: "A course, one module a week; or 3 payments of $27", price: "$79" },
          { label: "Form check", detail: "A 20-minute call", price: "$45" },
          { label: "The club", detail: "Membership, cancel any time", price: "$15 a month" },
        ],
      },
      {
        kind: "ladder",
        title: "The path from first workout to regular",
        items: [
          { step: "1", icon: "file", title: "A starter block", price: "$29", body: "The sample: four weeks that show how you coach.", href: "/platform/instant-delivery" },
          { step: "2", icon: "book", title: "The program", price: "$79", body: "Twelve weeks as a course, each week's module opening on its day, with an email.", href: "/platform/courses" },
          { step: "3", icon: "video", title: "A form check", price: "$45", body: "A short call, booked into your hours and paid first.", href: "/platform/calls" },
          { step: "4", icon: "repeat", title: "The club", price: "$15 a month", body: "A course that stays open while the member pays.", href: "/platform/memberships" },
        ],
      },
      {
        kind: "features",
        title: "What trainers use most",
        items: [
          { icon: "video", title: "Workout videos in the course", body: "Up to 5 GB a lesson, and videos filmed upright on a phone play upright.", href: "/platform/courses" },
          { icon: "calendar", title: "Weekly unlocks", body: "A module opens a set number of days after each person joins, so nobody skips to week twelve.", href: "/platform/courses" },
          { icon: "calendar", title: "Programs in installments", body: "Three monthly payments for a twelve-week program, ending by itself.", href: "/platform/checkout" },
          { icon: "list", title: "Challenges with a real limit", body: "A cap such as fifty places, counted from real payments, with no invented countdown.", href: "/platform/checkout" },
        ],
      },
      {
        kind: "limits",
        title: "Where it falls short for trainers today",
        items: [
          "No workout-tracking app and no progress photos: students mark lessons done, and that is what you see.",
          "The community's live room is text only: there is no group video inside it, so a live workout runs as a live event on Google Meet, Jitsi or your own link.",
          `Stream video has a finite threshold of ${paidVideoWords()} a month. New playback pauses at the recorded threshold; existing player links may remain valid until they expire.`,
        ],
      },
      {
        kind: "faq",
        title: "Questions trainers ask",
        items: [
          { q: "Can my program have videos I already host on YouTube?", a: "Yes. A lesson can hold a link as well as a video, so unlisted videos can stay where they are." },
          { q: "Can a form check be a video they send me?", a: "Not yet: a product that asks the buyer to upload a video is not built. Sell it as a call, booked and paid." },
        ],
      },
    ],
  },
  {
    slug: "designers",
    section: "for",
    eyebrow: "For designers and photographers",
    title: "A store for designers",
    highlight: "that sells while you work",
    intro:
      "Presets, templates and brush packs in personal, commercial and studio licenses, files up to 5 GB, launch codes and limited editions, with every file delivered the second the payment clears.",
    badge: WORKING,
    accent: "from-amber-brand to-pink-brand",
    related: ["price-options", "instant-delivery", "checkout", "insights"],
    photo: { id: "photo-1765429158141-b283bbe7d0e4", alt: "A photographer holding a camera among tall trees" },
    blocks: [
      {
        kind: "storecard",
        title: "What a design store looks like",
        creator: "Theo Lang",
        tagline: "Film-look presets and Lightroom recipes",
        photo: "photo-1780585328302-747a6eee7694",
        alt: "A man in a dark shirt, photographed against a plain wall",
        items: [
          { label: "Starter pack", detail: "6 presets, ZIP", price: "$15" },
          { label: "Full collection", detail: "Personal, commercial or studio license", price: "from $49" },
          { label: "Launch edition", detail: "50 copies, with the color guide as a PDF", price: "$79" },
        ],
      },
      {
        kind: "ladder",
        title: "The path from free sample to studio license",
        items: [
          { step: "1", icon: "gift", title: "A free preset", price: "Free", body: "For a confirmed email, so launch day has someone to tell.", href: "/platform/store-page" },
          { step: "2", icon: "tag", title: "The collection, three licenses", price: "$49 / $99 / $149", body: "Personal, commercial and studio — one product, each delivering its own file.", href: "/platform/price-options" },
          { step: "3", icon: "bolt", title: "One click after paying", price: "+$19", body: "The matching brushes, charged to the same card on the thank-you page.", href: "/platform/checkout" },
          { step: "4", icon: "percent", title: "A launch code", price: "20% off", body: "A code you choose, capped at a number of uses, kept on your own Stripe.", href: "/platform/checkout" },
        ],
      },
      {
        kind: "features",
        title: "What designers use most",
        items: [
          { icon: "file", title: "Files up to 5 GB", body: "ZIP, PNG, SVG, video and more. Anything heavier is sold as a link to where you keep it.", href: "/platform/instant-delivery" },
          { icon: "list", title: "Limited editions that are real", body: "The count shown is the true one, and the last copy is never sold twice.", href: "/platform/checkout" },
          { icon: "target", title: "Pixels for your ads", body: `Meta, Google, TikTok and Pinterest, with each purchase and its amount, on the ${PLAN_AT.creator} plan.`, href: "/platform/insights" },
          { icon: "globe", title: "Your own domain", body: "shop.yourstudio.com on Studio, with the certificate made for you.", href: "/platform/domain" },
          { icon: "key", title: "License keys", body: "A unique key with each sale, for plugins and apps, checked by your software through a public address.", href: "/platform/license-keys" },
          { icon: "file", title: "Stamped PDFs", body: "The buyer's email on every page of a guide or a color book, so anyone thinking of sharing it thinks twice.", href: "/platform/pdf-stamping" },
          { icon: "star", title: "Reviews from real buyers", body: "Stars and words only people who paid can leave, on the product's card and its page.", href: "/platform/reviews" },
        ],
      },
      {
        kind: "limits",
        title: "Where it falls short for designers today",
        items: [
          "Stamping works on PDFs only: presets, brushes and images are handed over as uploaded.",
          "No marketplace that sends you buyers: people arrive from your own links.",
          "Reviews come only from buyers, so a new product starts with none. A testimonial said in public can go in the Said elsewhere block with its link, never as a review.",
        ],
      },
      {
        kind: "faq",
        title: "Questions designers ask",
        items: [
          { q: "Can each license deliver different files?", a: "Yes. Each price option carries its own file or link, and the buyer receives only the one they paid for." },
          { q: "What if my pack is bigger than 5 GB?", a: "Sell it as a link to where you keep it — a Drive or Dropbox folder — and the buyer is sent there the moment they pay." },
        ],
      },
    ],
  },
  ...NEW_CREATOR_PAGES,
];

export const FEATURE_PAGES = withFeatureMechanisms(BASE_FEATURE_PAGES);
export const CREATOR_PAGES = withFeatureMechanisms(BASE_CREATOR_PAGES);
