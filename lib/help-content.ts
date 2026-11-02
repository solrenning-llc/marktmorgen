import { PAGE_TEST_WORDS } from "@/lib/headline-test-words";
import { ASSIST_REMINDER_WORDS } from "@/lib/buyer-words/assistant-reminder";
import { LETTER_KEEP_DAYS, MAX_PUBLISHED_LETTERS } from "@/lib/letter-rules";
import {answerAllowanceWords} from "@/lib/answers-rules";
import { ASSISTANT_KEEP_SECONDS, ASSISTANT_NAME, assistantAllowanceWords, assistantPriceWords } from "@/lib/store-assistant-rules";
import { IMPORT_ALLOWANCES, importAllowanceWords } from "@/lib/import-limits";
import { AI_PLANS_WORDS, aiAllowanceWords } from "@/lib/ai-rules";
/**
 * The help center's questions and answers, kept apart from its page so the
 * studio's help assistant (lib/help-ask.ts) answers from the very same words
 * the page shows. Each answer is plain text; numbers come from the rules they
 * describe, so the two can never disagree.
 */
import { BUYER_RESERVE_BPS, EXTRA_REQUESTS, REQUESTS_PER_VISIT, SETUP_VISITS, TRIAL_VISITS, VISITS_INCLUDED, countWords, publicVisitLimit } from "@/lib/traffic-rules";
import { hoursWords } from "@/lib/watch-rules";
import { paidVideoWords, TRIAL_VIDEO_SECONDS } from "@/lib/video-admission-rules";
import { SETUP_STORAGE_BYTES, SETUP_VIDEO_SECONDS, TRIAL_STORAGE_BYTES } from "@/lib/plan-standing";
import { PAID_STORAGE_BYTES, storageBrakeFor } from "@/lib/storage-rules";
import { storageWords } from "@/lib/storage-quota";
import { CLOSING_DAYS, ENDED_STORE_EXPORTS, ERASE_WITHIN_DAYS, KEEP_NOTHING_FROM, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { COMMUNITY_PICTURES } from "@/lib/community-picture-rules";
import { NON_PAYING_DATA_ROOM_BYTES, PAST_CALL_DAYS, dataRoomListWords, dataWords } from "@/lib/store-data-rules";
import { CALL_ORDER_UNITS, ORDERS_INCLUDED, TRIAL_ORDERS } from "@/lib/order-rules";
import { API_WRITE_UNITS, allowanceListWords } from "@/lib/store-allowance-rules";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { FREE_POOL_BASE_STORES, PAID_STORES_PER_FREE_STORE } from "@/lib/free-pool-rules";
import { CENTS_PER_MINUTE, GIVE_UP_HOURS, MIN_CENTS, dollars } from "@/lib/auto-captions-rules";
import { isDomainsConfigured } from "@/lib/domains";
import { TEAM_LIMITS, teamLimitWords } from "@/lib/team-scheduling-rules";
import { PLAN_TITLES, PRO_MONTHLY_EMAILS, REFUND_DAYS, TRIAL_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS } from "@/lib/plan";
import { workflowLimitWords } from "@/lib/flow-limits";
import { pipelineLimitWords } from "@/lib/crm-rules";
import { PLAN_BREAKS_ENABLED, PAID_MONTHS_BEFORE_PAUSE, PAUSE_MONTHS } from "@/lib/plan-pause-rules";
import { healthRuleWords, rampRuleWords } from "@/lib/mail-health-rules";
import { formatMoney } from "@/lib/money";
import { INVITE_BONUS_CENTS, INVITE_HOLD_DAYS, INVITE_SHARE_PERCENT } from "@/lib/creator-invite-rules";
import { EXPECTATION, MAX_PAGES_READ, OPEN_COUNTRIES_WORDS, PITCHES_PER_DAY, REPITCH_DAYS } from "@/lib/outreach-rules";
import { PLAN_AT, feeWords, planPriceWords, yearSavingWords } from "@/lib/fee-words";
import { paypalAtCheckout, paypalConnectionWords } from "@/lib/public-explanations";
import { IMPORTS_PER_SHARE_MONTH, MAX_SHARE_DAYS, PREVIEWS_PER_SHARE_MONTH, SHARE_LIMITS, bytesWords } from "@/lib/funnel-share-rules";
import { MAX_SECTION_BLOCKS } from "@/lib/saved-blocks";
import { ERASE_STUDIO_UNITS } from "@/lib/erasure-rules";
import { KEEP_DAYS as AGREEMENT_KEEP_DAYS, MAX_VERSIONS, SIGN_DAYS } from "@/lib/agreement-rules";
import { KEEP_DAYS, MAX_AUTO_REMINDERS, MAX_LINES, MAX_PER_PERSON, MAX_SENDS, OPEN_DAYS, REMIND_EVERY_DAYS, REQUEST_LIMITS } from "@/lib/payment-request-rules";
import { LEAVING_ANSWER, LEAVING_QUESTION, STAN_QUESTION, stanComparison } from "@/lib/home-faq";

/** An anchor for one answer, from its question. */
export function answerId(q: string): string {
  return q.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export type HelpSection = {
  id: string;
  emoji: string;
  title: string;
  blurb: string;
  tone: string;
  items: { q: string; a: string[] }[];
};

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: "getting-started",
    emoji: "🚀",
    title: "Getting started",
    blurb: "What Marktmorgen is right now, and what it costs to start.",
    tone: "bg-lilac",
    items: [
      {
        q: "What is Marktmorgen today?",
        a: [
          "You sign up, take your own store address and build the page: its name, its description, and what you sell with its price. You connect your own Stripe account, and once Stripe has cleared it and your plan or free trial is running, your page can take a card. The money is charged on your account, not ours.",
          "You can see the whole path before signing up. The demo store has price options on a product, a Stripe checkout made on the creator's own account, and the file delivered the second the payment clears. You can buy from it with a test card.",
          "The mission page lists everything that is built and everything that is not, in two columns, so nobody signs up expecting the wrong thing.",
        ],
      },
      {
        q: "Can I put my own products on my store?",
        a: [
          "Yes. In your studio you write the name of the store, the line under it, and each thing you sell with what the buyer gets and the price. It is on your page the moment you save it, and you can reorder or remove any of it.",
          "A store holds up to 2,000 products and up to 100 links. Products are priced in your store's currency — one of 15, US dollars unless you choose another — with one price each, up to 50 if you want the buyer to choose, or a price the buyer chooses, at or above your minimum. You can also put the file itself on each one, and open it again to check it is the right one. A long store shows 24 products a page, and your studio finds any product by name. You can cut the list into up to 20 sections with a heading over each, and put one line of your own news across the top of the page, leading to one of your products if you like.",
          "Each product can have a picture, shown on its card in one of three ways (no picture? press Make a cover under the product: six designs drawn in your store's color and letters from its title, a short line saying what it is and a line under it, each word readable whatever your color), and a page of its own at your store address followed by /p/ and the product's name in words (knife-skills, then a short code), with a long description of up to 5,000 characters. That page has its own title and preview card, so a link to one product shared anywhere unfolds into that product. Rename the product and its address follows; every link shared before keeps working. Share it from the studio: the link to copy, a QR code to download for print or slides, and X, Facebook, LinkedIn, WhatsApp and email, each opening that site's own page to post from, with each link tagged so your numbers show which one brought visitors and sales. You can also build it as a sales page, from blocks.",
          "Your page can take a card as soon as two things are true: Stripe has cleared your connected account, and your subscription is running — the trial counts. Until then the page says so plainly, to you and to anyone who opens it.",
        ],
      },
      {
        q: "What file can I sell, and how big?",
        a: [
          "Up to 5 GB, in any of these: PDF, ePub, ZIP, PNG, JPG, GIF, WebP, SVG, MP3, WAV, M4A, MP4, MOV, WebM, TXT, CSV, Markdown, Word, Excel and PowerPoint. Anything over about 20 MB is uploaded in parts, so a dropped connection costs you one part rather than the whole thing.",
          "Bigger than that, or not a file at all? Sell it as a link. You paste an https address \u2014 a Google Drive folder, a private video page, a Notion page \u2014 and the buyer is sent there the moment they pay, with the address shown on the page and kept in their receipt. There is no size limit on that, because the files stay where you already keep them.",
          "A product carries one or the other, never both, so a buyer who has paid is shown one thing to open rather than a choice.",
          "Anything that runs — a program, an installer, a script — is refused. A store that hands out software is a store that hands out malware the day an account is taken over.",
          "The file goes straight from your browser to storage that needs a key to read. It is never named or linked on your public page, and the only way it comes out is through us, after we have checked who is asking. You can open it yourself from your studio to be sure it is the right one.",
        ],
      },
      {
        q: "What does it cost to start?",
        a: [
          "Nothing to sign up. Your store address, your page, the editor and connecting Stripe are free and stay free. Without a plan, your page is shown for " + countWords(publicVisitLimit(SETUP_VISITS)) + " visits a month.",
          `What the subscription switches on is your checkout: your page taking a card, and handing out what you give away for an email address. It is ${planPriceWords("creator")}, or ${planPriceWords("creator", "year")}, which is ${yearSavingWords("creator")} less than paying monthly. Studio, which adds email to your list${isDomainsConfigured() ? " and your own domain" : ""}, is ${planPriceWords("pro")} or ${planPriceWords("pro", "year")}. Scale, which is Studio for a list that sends up to ${SCALE_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month instead of ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")}, is ${planPriceWords("scale")} or ${planPriceWords("scale", "year")}. The first 14 days are free on any plan, monthly or yearly. Stripe takes your card details when the trial starts and first charges the card when the 14 days end; we email you a week before that charge, and if you cancel before it, from your studio, it is never charged. So you can put a product up and make a sale before you decide whether it is worth paying for.`,
        ],
      },
      {
        q: "What will it cost?",
        a: [
          feeWords().costLine,
          `Visits and lesson video have finite monthly thresholds. Public pages pause at the plan's counted-visit threshold, and new lesson video playback pauses at the recorded threshold: ${paidVideoWords()} each month. These thresholds do not authorize unlimited overages. Orders beyond the plan's included count retain their separate published billing terms.`,
          "Sending capacity includes reserved attempts. When a provider cannot confirm delivery, the reservation is retained and a retry uses new capacity. The price is published on the home page. If it ever changes, existing subscribers are told before it applies to them.",
        ],
      },
      {
        q: "Can I switch between monthly and yearly, or between the plans?",
        a: [
          "Yes to both, from your studio, whenever you like. Monthly to yearly charges the year that day, less what is left of the month you already paid for. Yearly to monthly keeps what is left of your year as credit on your account, and that credit pays your months until it runs out.",
          `Moving up to Studio charges that day the difference for what is left of the period you already paid for; going back to the ${PLAN_AT.creator} plan keeps what is left of Studio as credit on your account. Inside the trial, no switch charges anything.`,
          "On a yearly plan we email you about a month before it renews, with the date, the amount and the link to cancel.",
        ],
      },
      {
        q: "Can I run more than one store, or have someone help me?",
        a: [
          "Both. One account runs up to five stores, each with its own address, products, buyers, Stripe account and plan, and you switch between them at the top of your studio. The 14-day free trial is for an account's first store; each other store is charged from the day its plan starts, and canceling one touches no other.",
          "Each store can have a team of up to five people, invitations still waiting included, each signing in with their own email: an Admin runs everything except the plan, the Stripe connection, the team and deleting the store; an Editor looks after products, courses, calls, bundles, sales pages, the store page and the community's live events, moderates the community and reviews, and writes email drafts without sending them; Support reads orders and bookings, sends purchase emails again, sees who is coming to live events and moderates the community and reviews. What each role may do is checked on our server for every request. You are emailed when someone joins or changes role, and the activity log shows the last 500 changes and downloads your team made.",
          "Stan's help center, read on September 28, 2026, says the only way to give a team member admin access there is to share your login.",
        ],
      },
      {
        q: "Can I move my store from Stan, Gumroad or another platform?",
        a: [
          "Yes, from a spreadsheet, in three imports from “Moving from another platform” in your studio, on every plan. Your list: up to 50,000 rows a file, and only people who agreed to hear from you \u2014 you confirm it each time, a consent column in the file narrows it further, nobody who unsubscribed here is added back, and nobody is emailed because of it. Your products: up to 500 a file, each made a draft that waits in your studio until you publish it, with its title, price, description and link. Your past buyers: up to 20,000 a file, each given what they bought on your store's list of purchases, marked as brought over from another platform, with no payment and no receipt.",
          "Bring products first, because the buyers' file names them by their title or their ID here, then add each product's file or lessons. A buyer brought over for a product that opens your community is let in. If you check “Email each buyer once,” each buyer gets one email from your store's name saying what moved and how to open it \u2014 on Studio and Scale those emails count in your plan's monthly emails, and on Store up to " + IMPORT_ALLOWANCES.creator.movedEmails + " go out a month \u2014 and nothing more is sent because of it. The studio reads the file in your browser, you say which column is which, and every row that is not brought in is listed with its row number and the reason, as a spreadsheet you download.",
          "What it does not do: files, pictures and lessons are not imported from the other platform (a course's videos can be made into lessons up to 50 at once, with \u201cAdd lessons from videos\u201d under each module); calls and products with several prices cannot be given to past buyers, and a membership is never given (members are invited to keep theirs instead, with “Your members,” first paying here on the day it would have renewed); buyers brought over get no license key here and are not counted as sales, sent to webhooks, credited to affiliates or able to review; and an import cannot be undone in one step. You and your Admins can import. Stan's help center, read on September 28, 2026, allows up to 5,000 imported contacts per store in all, has you send them an opt-in email, and grants a customer access to a product one at a time.",
        ],
      },
      // Moved from the home page (VS1, 31/10/2026); the same facts, nothing dropped.
      {
        q: STAN_QUESTION,
        a: [stanComparison()],
      },
      {
        q: "Can I move from ClickFunnels?",
        a: [
          "Yes, from “Move from ClickFunnels” under “Moving from another platform” in your studio, in four steps: the Products, Contacts and Orders files ClickFunnels lets you export, and your funnel's pages, each saved from your own browser as “Webpage, HTML Only”. ClickFunnels' column names are matched for you. Each file and each funnel is checked first in a dry run that saves nothing and lists what every row and page will become, then imported; running the same import again makes nothing twice.",
          "Contacts ClickFunnels marks Subscribed can be emailed here once you confirm they agreed; everyone else comes in as a contact you cannot email, and those marked Unsubscribed or Undeliverable stay unsubscribed here. Paid orders give past buyers what they bought; refunded, failed, canceled and pending ones are left out. Each saved page's headings, text, buttons, YouTube, Vimeo and Loom videos and form become one of your store's own pages, kept from visitors until you let it out, and the pages a funnel, switched off. A page you say was an order form becomes your product's own checkout, its order bumps boxes at that checkout, and pages you say were upsells or downsells offers after paying.",
          "What it does not do: we never sign in to ClickFunnels or fetch your pages, and pictures, design, scripts, tracking, countdown timers, workflows, courses and memberships are not brought over. Every page lists what was left out and why.",
          `How much a month: ${importAllowanceWords()} Moving funnels: ${IMPORT_ALLOWANCES.creator.pageReads}, ${IMPORT_ALLOWANCES.pro.pageReads} and ${IMPORT_ALLOWANCES.scale.pageReads} saved pages read, ${IMPORT_ALLOWANCES.creator.funnelChecks}, ${IMPORT_ALLOWANCES.pro.funnelChecks} and ${IMPORT_ALLOWANCES.scale.funnelChecks} funnel checks, and ${IMPORT_ALLOWANCES.creator.funnelSaves}, ${IMPORT_ALLOWANCES.pro.funnelSaves} and ${IMPORT_ALLOWANCES.scale.funnelSaves} funnels made, on Store, Studio and Scale. Dry runs: ${IMPORT_ALLOWANCES.creator.checks}, ${IMPORT_ALLOWANCES.pro.checks} and ${IMPORT_ALLOWANCES.scale.checks} batches of contacts or products, and ${IMPORT_ALLOWANCES.creator.buyerChecks}, ${IMPORT_ALLOWANCES.pro.buyerChecks} and ${IMPORT_ALLOWANCES.scale.buyerChecks} of past buyers (each batch is up to 1,000 rows). Each figure starts again with your billing month (for a store with no plan, on the 1st, UTC); past one, that step waits for the next month or a larger plan.`,
        ],
      },
      {
        q: "Is it open, or is this a waiting list?",
        a: [
          "Open. You can take an address and be selling the same day.",
          "It is also young, and the mission page lists what is built and what is not, in two columns, so you can see what you are signing up to before you do. That page is updated the day something new actually works, not the day it is planned.",
        ],
      },
    ],
  },
  {
    id: "demo-store",
    emoji: "🧪",
    title: "The demo store",
    blurb: "How to test a real checkout without spending anything.",
    tone: "bg-cream",
    items: [
      {
        q: "How do I try it?",
        a: [
          "Open the demo store, pick a price option and pay with the Stripe test card 4242 4242 4242 4242, any future expiration date, any three digits for the security code and any ZIP code.",
          "The checkout is a real Stripe checkout running in test mode. No real money moves, and no real card is ever charged.",
        ],
      },
      {
        q: "Is the file real?",
        a: [
          "Yes. The sample planner is a real PDF, and the page delivers the file that matches the option you paid for — the one-week file for the one-week price, the five-week file for the five-week price.",
        ],
      },
      {
        q: "Can I put my own file in it?",
        a: [
          "Not in the public demo, which is a fixed sample everyone shares. Your own store is where your file goes: take an address, upload it, and the page and the file are yours.",
        ],
      },
    ],
  },
  {
    id: "money",
    emoji: "💳",
    title: "Money, fees and payouts",
    blurb: "Who charges the buyer, who holds the money, and when you get it.",
    tone: "bg-mint-brand/12",
    items: [
      {
        q: "Whose account is the buyer charged on?",
        a: [
          "Yours. You connect your own Stripe account and the charge is made on it directly. The receipt and the line on your buyer's card statement carry your business name, not ours.",
        ],
      },
      {
        q: "What does Marktmorgen take from a sale?",
        a: [
          feeWords().fromASale,
          "Stripe charges its own processing fee on each payment, published on Stripe's own pricing page, and that is taken on your account by Stripe.",
        ],
      },
      {
        q: "How do I send a proposal or an agreement to sign?",
        a: [
          `Open Agreements in your studio, write a title and the text in plain words (with lines and amounts if you want them) and send it to one person. They get one email from your store's name with a link to a page that shows the exact text. To sign, they type their full name and the email address it was sent to, and check "I agree to sign this electronically, and I am the person it was sent to." The link takes a signature for ${SIGN_DAYS} days.`,
          `What is recorded: the exact text they read, its SHA-256 fingerprint, the version number, the name they typed, the time, the sentence they checked, and a one-way code made from their internet address, never the address itself. Both of you get the signed copy by email, with the text and the record in the email and in an attached HTML file, and the page can be printed or saved as PDF. Each of those emails is one of your store's emails for the month.`,
          `A version that was sent never changes. Changing it writes a new version (up to ${MAX_VERSIONS}), which needs a new signature; an earlier signature stays recorded against the text it signed. Nobody may sign for the person it was sent to: the address they type must be the one it went to, and a browser signed in to your studio can't sign it. You can attach one of your open payment requests, shown once it is signed. Each agreement is kept ${AGREEMENT_KEEP_DAYS} days, then deleted by itself.`,
          "Marktmorgen is not a law firm and gives no legal advice or templates. Whether an agreement can be enforced depends on the law where you and they are and on what it says: some documents, such as wills, may need another form. Ask a lawyer where it matters.",
        ],
      },
      {
        q: "How do I ask one person to pay me a custom amount?",
        a: [
          `Open Payment requests in your studio (or press Request payment on a deal with a person): their email, up to ${MAX_LINES} lines of what it is for, a note, a due date if you want one and up to ${MAX_AUTO_REMINDERS} reminders ${REMIND_EVERY_DAYS} days apart. They get one email from your store's name with a link to a page that shows who is asking, what for and the total, and pay on Stripe's page, on your own Stripe account. Paid, they get a receipt by email and the page becomes one they can print.`,
          `It is paid like any sale: it is listed with your sales, your plan's share of a sale applies, it is one of the month's orders, sales tax and Stripe's invoice apply where you switched them on, and you refund it from Stripe. Nothing is added to what they pay: no fee, no interest, no late charge. It earns no affiliate or partner share. The request and each reminder are each one of your store's emails for the month, and do not go once those are used.`,
          `Open at once: ${REQUEST_LIMITS.creator.open} on ${PLAN_TITLES.creator}, ${REQUEST_LIMITS.pro.open} on ${PLAN_TITLES.pro} and ${REQUEST_LIMITS.scale.open} on ${PLAN_TITLES.scale}; ${REQUEST_LIMITS.creator.kept.toLocaleString("en-US")}, ${REQUEST_LIMITS.pro.kept.toLocaleString("en-US")} and ${REQUEST_LIMITS.scale.kept.toLocaleString("en-US")} kept, and ${MAX_PER_PERSON} for one person. Each link takes payment for ${OPEN_DAYS} days, a request is kept for ${KEEP_DAYS} days, and no request is emailed more than ${MAX_SENDS} times or twice in a day. Send one only to someone who agreed to pay you for it. A single payment for now: installments are not offered on requests.`,
        ],
      },
      {
        q: "When am I paid?",
        a: [
          "On your own Stripe payout schedule, which you set in your own Stripe dashboard. We never hold a balance for you, so there is nothing for us to release.",
        ],
      },
      {
        q: "Can I see everything one buyer has bought from me?",
        a: [
          "Yes. Every sale in your studio has a link to its buyer's page, and the Buyers page finds anyone by the email address they paid with. Their page shows what they bought and paid, what was refunded, what came later \u2014 extras taken in one click and membership payments \u2014 where they first found your store and where their latest purchase came from, their memberships, how far they are in each course, the calls they have coming up, whether they are on your list and which sequences they were started on.",
          "It is read from your own Stripe account each time you open it, so it is never out of date, and we keep no second copy of anyone's payments. You and your team can leave notes on it; the buyer never sees them.",
          "The owner, Admins and Support see it: the same people who see orders with the buyer's address. Sales from before October 11, 2026 have no channel written on them, and a sale paid with PayPal shows what was bought, with the amount in your PayPal account.",
          "Your numbers in the studio also show who bought in the last 7, 30 or 90 days: how many people, what an order comes to on average, how many had bought from you before and how many bought more than once. The owner, Admins and Support also see the biggest buyers of the last 90 days there, each opening their own page.",
          "You can ask your numbers a question in plain words, under \u201cAsk your numbers\u201d in the same place: \u201cwhich channel brought the most money this month?\u201d or \u201cwhere do visitors stop before buying?\u201d. The answer is written from what your Numbers panel shows and nothing else, with the figures it used beside it, each one checked against your numbers, and a button that opens the panel at those days and that part. Nothing about any buyer is sent to answer it. The weekly email can also open with two to four sentences written the same way, if you turn it on at the bottom of your numbers. Each question, and each weekly summary, is one of your month\u2019s AI jobs, on " + AI_PLANS_WORDS + ".",
          "You can show others numbers this site counted, never typed. Your media kit can show your store\u2019s visitors and sales of the last 30 days and where your buyers are, as shares, with the day they were read and where each comes from. And under \u201cShare your numbers with a link\u201d you make a read-only page for a partner or a sponsor, with its own password and an end date of 7, 30 or 90 days: visitors, page views, checkouts and sales for the last 7, 30 and 90 days, channels, products sold and buyers\u2019 countries, with revenue only if you select it. The numbers are read once a day; a link opens a few hundred times a day at most, and you can take it back at any time.",
          "Besides the last 7, 30 and 90 days and all time, \u201cAny dates\u201d reads any stretch of the last 400 days, a launch from its first day to its last: visitors, page views, checkouts, sales and revenue, each set beside the same number of days just before, with each day, each channel and each product. \u201cWhen your buyers buy\u201d shows the last 90 days of checkouts by day of the week and hour of the day, in your own time, and names the day and the three hours that brought the most once there are at least 10 sales. The chart also marks on its own the days an email went to your list, a product was added and a store sale began or ended, beside the notes you type.",
          "Your numbers also set sales at full price beside sales with each kind of discount, over the last 90 days: a code, your store sale, a fair price for the buyer\u2019s country, a membership\u2019s introductory price and a come-back offer. Each row says how many sales and how much money it brought, how much the discount took off, the share refunded and the share of those buyers who bought something again afterward. It is worked out from what Stripe already records on each checkout. Your Membership numbers page does the same for members: of those who joined in the last year at full price or with each discount, how many are still members, how many were still paying three months in, and how many months each stayed.",
          "Under \u201cWhat customers are saying\u201d, your numbers sum up the last 90 days of what customers wrote: the words members left when canceling, questions your pages could not answer, reviews, and searches on your store that found nothing. They are sorted into the few themes that repeat, most first, each with how many said it and up to three of their own sentences. AI, on " + AI_PLANS_WORDS + ", only sorts them and names each theme; the counts and the words are your customers\u2019. Names never go with them, and any email address, phone number or link in them is taken out first. It is read once a month, when you press the button, as one of your month\u2019s AI jobs, and only once there are at least 8 things to read.",
          "Above your numbers, \u201cWorth knowing\u201d says in a sentence what changed that is worth acting on, read by fixed rules, and each sentence has its step beside it: a product opened and not bought opens its page with a second headline ready to test; checkouts left unpaid turn on the checkout reminders, or open your store as a buyer; fewer visitors opens an email to your list; the rest open the part of your numbers that shows it. Where money is at stake, the sum beside it is made from your numbers alone, such as checkouts not paid times your average order: arithmetic, not a promise of what a change would bring.",
          "Your store also tells you when its numbers go off course, by email, on your phone if you turn on Alerts there, and in your Slack or Discord channel if you check \u201cAlso post each sale, and each alert\u201d: when visits over three days fall under 40% of the usual, when sales from the last week's visits fall under half of what your rate would give while visits held up, when refunds pile up, and when the month's goal is off pace (from the 10th) or reached. Each is said only when the numbers are big enough and the change unlikely to be chance, at most once a week (the goal ones once a month), and the email stops with the weekly one.",
        ],
      },
      {
        q: "Can I give a countdown offer to people who download my freebie?",
        a: [
          "Yes. Under \u201cA welcome offer with a deadline of their own\u201d, choose a paid product, a discount of 10% to 50% and how long it lasts: 24, 48 or 72 hours, or 7 days. Whoever asks for one of your free products sees it on the page they pick their copy up from, with the time left counting down, and a button that opens your checkout with the discount already taken off by Stripe, for the address the free copy went to.",
          "The deadline is real. It starts when the person asks for the free product and is kept for them, so asking again, on another device or a month later, never starts it again. When it ends, the button goes, the page says when it ended, and the product is at its usual price. With the reminder on, one email goes before the end, only to someone who agreed to hear from you and confirmed their address. Your numbers count these sales as \u201cWelcome offer\u201d beside the other discounts.",
        ],
      },
      {
        q: "How do I know if my numbers are good?",
        a: [
          "Your numbers set four of your rates beside stores your size, under \u201cBeside stores your size\u201d: visits that became a sale, checkouts that were paid, sales refunded and buyers who had bought before, all over the last 90 days. Stores are grouped by their visitors in those 90 days (300 to 2,999, 3,000 to 29,999, and 30,000 or more), and for each rate you see your own figure, the middle half of those stores, their median, and whether you are in the middle half, above it or below it.",
          "A rate is shown only once at least 10 stores your size have it, and only once your own counts are big enough to mean something: 300 visitors, and 10 checkouts, sales or buyers for the rates made from them. The ranges are worked out once a day from the stores' own numbers. No store is named or can be picked out, and nothing about any buyer is used.",
        ],
      },
      {
        q: "Can I make a short link for a post?",
        a: [
          "Yes. In your studio, under \u201cShare the store,\u201d give the post a name, say where you post it and where the link goes: your store or one of your products. You get an address like marktmorgen.com/l/k7p2qa, short enough for a caption, a bio, a slide or a flyer, and its own QR code to download as SVG or PNG. The letters leave out 0, o, 1, l and i, so nobody misreads it from print.",
          "The link opens the page already tagged with where you posted it and the post's name, so each link has its own line of visits, sales and revenue for the last 90 days beside it, and the same row in your numbers under \u201cWhich post made you money.\u201d You can change where a link goes at any time without touching the post, and end a link you no longer want; a change reaches everyone within five minutes. The visit is counted by the page it opens, like any other visit to your store. A store can have up to 100 links.",
        ],
      },
      {
        q: "Can my numbers read what I spent on Meta ads?",
        a: [
          "Yes, once Marktmorgen's Meta app is approved to read ads. At the bottom of your numbers, under what you spent on ads, press \u201cConnect Meta ads\u201d and allow it on Meta's page. Your numbers then read what each campaign spent on each day, on Facebook, Instagram and Threads, for the last 30 days, and read it again once a day. Each channel's row counts it with whatever you typed: the initial revenue less ads, the recorded result including renewals and matched refunds, and gross payback days. The result after refunds waits when payments or refunds are incomplete; fees, tax, commissions and other costs are not included, so it is not profit or a recommendation to increase a budget.",
          "Only what was spent is read: nothing about who saw or clicked your ads, and nothing is ever changed in your ad account. The amounts are read only when your ad account pays in your store's currency, because no exchange rate is guessed. Meta asks for the permission again every 60 days or so; your studio says when, and you are emailed if it stops. Disconnecting gives the permission back to Meta and deletes what was read; what you typed stays.",
          "For each campaign to get its own row beside your posts, tag your ads' links in Ads Manager with utm_source={{site_source_name}}&utm_campaign={{campaign.name}}. The owner and Admins connect and disconnect it; anyone who sees your numbers sees what was read.",
        ],
      },
      {
        q: "Can I give someone a discount code?",
        a: [
          `Yes, and it is on the ${PLAN_AT.creator} plan. On Stan, discount codes are on the $99 Creator Pro plan, according to its help center, read on September 28, 2026.`,
          "You pick the word, say whether it takes a percentage or an amount off, and cap how many times it can be used if you want to. The buyer types it at checkout and Stripe works out the new total.",
          "Or share it as a link: add ?code= and the word to your store's address or any product's page, like marktmorgen.com/@yourname?code=SPRING. Whoever opens it has the code applied at checkout without typing it, for a week. If the code has ended, is used up or does not fit that order, the checkout opens with the box as usual.",
          "The code is a coupon on your own Stripe account, not a record of ours. So the count of how many times it has been used is Stripe's count, a code you switch off in your own dashboard is off here too, and if you ever leave, your codes leave with you.",
          "One limit, said plainly: a code comes off the payment it is typed into. On a membership that is the first charge, not every renewal forever.",
        ],
      },
      {
        q: "Can my buyers pay with PayPal?",
        a: [
          "Not through Stripe. Your buyers are offered the ways to pay you switch on in your own Stripe account. Every sale here is a direct charge on that account, and Stripe's documentation, read on September 28, 2026, lists PayPal as not supported for direct charges. Stripe also offers PayPal only to accounts in the EU (except Hungary), the UK, Switzerland, Norway and Liechtenstein. So even if your Stripe dashboard shows PayPal as on, your buyers should not expect it at checkout here.",
          `${paypalConnectionWords()}${paypalAtCheckout() ? "" : " Stan lets creators take PayPal, Beacons offers it too, and until then we are behind them on this one."}`,
          "Two things follow from that, and you should know them before you sign up. You need a Stripe account in one of the 42 countries the studio offers \u2014 the United States, Canada, the United Kingdom, Australia, Japan, Singapore, Mexico and most of Europe among them, but not everywhere. And a buyer who has only a PayPal balance and no card, wallet or other way to pay cannot buy from you here.",
        ],
      },
      {
        q: "Which currencies and ways to pay can I offer?",
        a: [
          "Your store charges in one of 15 currencies: US, Canadian, Australian, New Zealand, Singapore and Hong Kong dollars, euros, pounds, Swiss francs, Swedish kronor, Norwegian and Danish kroner, Polish zloty, Japanese yen or Mexican pesos, among those your Stripe account can charge in. You or an Admin choose it in your studio, and you are emailed when it changes. Changing it keeps every price's number, so check your prices; it cannot be changed while a membership or payment plan is still running.",
          "The ways to pay are the ones you switch on in your own Stripe account: cards, Apple Pay, Google Pay, Link, and where they fit the buyer and the amount, Klarna, Afterpay or Clearpay, Affirm, iDEAL, Bancontact and others. Your studio lists what is on, read from Stripe, and links to where you switch more on. Memberships and payment plans show only the ways Stripe can charge again each period.",
          "Ways to pay that are not confirmed while the buyer waits \u2014 ACH, SEPA and Bacs Direct Debit, bank transfers, Boleto, OXXO, Konbini, Multibanco, stablecoins \u2014 are left out on purpose, because what your buyers pay for is handed over the moment the payment is confirmed. And one-click offers after paying are shown only to buyers who paid by card, Apple Pay or Google Pay.",
        ],
      },
      {
        q: "Who handles refunds and disputes?",
        a: [
          "You do, in your own Stripe dashboard, with the same tools any business has. Because the charge was made on your account, a refund is a refund you issue, not a request you file with us.",
        ],
      },
      {
        q: "Why does my checkout ask buyers to check a box about access?",
        a: [
          "In the EU, the UK and some other places, a buyer online usually has 14 days to cancel. For digital content (a file, a link, a course, a private podcast or a bundle), they lose that right once access starts only if they agreed that it may start before the 14 days end, said they understood they would lose the right, and got a confirmation of both. A membership is at least partly a service: the buyer asks for it to start now, keeps the right to cancel within the 14 days, and if they use it pays only for what they were given until then. So before anyone pays, the checkout shows one unchecked box that says the one that fits, in your store's language. The payment does not open until it is checked, and each one-click offer after paying asks again. A product you ship is not asked.",
          "The buyer's \u201cyes\u201d, the version and kind of the words and the time are kept on the order in your own Stripe account (with a PayPal payment, in our record of that order for 400 days), and the confirmation email quotes them and says what follows: access started, starts on a pre-order's release day, or the membership's 14 days. If a member cancels within those 14 days, refunding what they paid beyond what they were given is yours to do. It is asked of every buyer, because a page cannot know who has the right, and its words say it is for buyers who have it where they live. It does not replace your own terms, and it is not legal advice.",
        ],
      },
      {
        q: "What about refunds on the Marktmorgen subscription itself?",
        a: [
          `Your first payment to us is refunded in full if you ask within ${REFUND_DAYS} days of it, for any reason or none. A yearly plan is refunded at any time for the months you have not started, with the months you used charged at the monthly price and Stripe's card fee on that payment kept, since Stripe does not give it back. You can cancel at any time and keep access until the end of the period you already paid for; a renewal is not refunded, except where the law requires it. The refund policy page has the exact wording.`,
        ],
      },
      {
        q: "Can I take a break instead of canceling?",
        a: [
          !PLAN_BREAKS_ENABLED ? "Plan breaks are not available. You can cancel at any time in your studio under What you pay us. Your subscription continues until the end of the period you paid for, and buyers keep access to what they bought." : `Yes, on a monthly plan that has been paid for at least ${PAID_MONTHS_BEFORE_PAUSE} months, once a year. In your studio, under What you pay us, choose Take a break instead and ${PAUSE_MONTHS.map((m) => (m === 1 ? "1 month" : `${m} months`)).join(" or ")}. Your store keeps taking payments until the end of the period you already paid for. Then nothing is charged and your checkout is closed, while your page stays up, everything you put up is kept and buyers can still download what they bought. On the last day your plan starts again by itself, at the price it had, on the card you pay with; we email you a week before, and you can say no in one click. To sell sooner, start your plan again from the studio on any day.`,
        ],
      },
      {
        q: "Are creator invitations available?",
        a: [
          "New creator invitations are paused. Existing invitation credits and recorded referral terms are preserved.",
          `Existing invitations retain their accepted terms, including the ${INVITE_SHARE_PERCENT}% recurring credit and ${formatMoney(INVITE_BONUS_CENTS, "usd")} first-payment credit where applicable. Credit is added after ${INVITE_HOLD_DAYS} days and remains account credit rather than cash.`,
          "An invite previously accepted in this browser can still be completed within its original 60-day lifetime. The pause does not renew that cookie. You can view recorded invitations and credits in your studio.",
        ],
      },
    ],
  },
  {
    id: "your-store",
    emoji: "🏪",
    title: "Your store",
    blurb: "What it can hold today, and what it cannot.",
    tone: "bg-sky-brand/12",
    items: [
      {
        q: "Is there a limit on how much my buyers download?",
        a: [
          "Your plan covers 200 GB of downloads a month for your store. Your studio shows what you have sent out so far, counted from the moment each download starts.",
          "If you go past it, nothing is cut off. Somebody paid you for that file and they get it — we are not going to take a sale and then break it to protect our own bill. Your studio marks the month as past what your plan covers, and your store keeps selling as usual.",
          "For a sense of scale: 200 GB is two hundred copies of a one-gigabyte course, or forty thousand copies of a five-megabyte guide, in a single month.",
        ],
      },
      {
        q: "How many visits does my plan cover?",
        a: [
          `Store covers ${countWords(VISITS_INCLUDED.creator)} visits a billing month, Studio ${countWords(VISITS_INCLUDED.pro)}, and Scale ${countWords(VISITS_INCLUDED.scale)}. A visit is one person opening your store on one day, however many of its pages they look at. You are never counted when you are signed in, and neither is a robot that says it is one.`,
          "A buyer who comes back counts the same way: a student or a member who opens a course or your community on a day is that day's visit, once. A subscriber to a private podcast is one visit on each day their app checks for episodes. Your community's live room checks for new messages for as long as it is open in front of a member, so it counts by the 10 minutes it is open, for each member: 2.6 visits while people are talking, when it checks every 5 seconds, and 0.6 of a visit while the room is quiet. A room in a background tab, or one nobody has touched for 20 minutes, checks nothing and counts nothing.",
          `Visits are never billed. Your store's public pages (its page, products, blog and collections) rest at ${(10_000 - BUYER_RESERVE_BPS) / 100}% of the month's figure: ${countWords(publicVisitLimit(VISITS_INCLUDED.creator))} on Store, ${countWords(publicVisitLimit(VISITS_INCLUDED.pro))} on Studio and ${countWords(publicVisitLimit(VISITS_INCLUDED.scale))} on Scale. The last ${BUYER_RESERVE_BPS / 100}% are kept for what your buyers already have: courses and lessons, the community and its live room, and private podcasts, which rest once the whole figure is used, with a page that tells your buyers their access is kept. Everything opens again when the calendar month turns, or when a plan change gives the store a larger figure. A checkout already open always finishes. Your studio shows the recorded count. A failed or unreadable count also pauses new public-page admission.`,
          `The same in the free trial (${countWords(TRIAL_VISITS)} visits for the whole trial) and before a plan starts or after it ends (${countWords(SETUP_VISITS)} a calendar month).`,
          `Your store's public side also answers up to ${countWords(REQUESTS_PER_VISIT)} requests for each visit its plan covers, and ${countWords(EXTRA_REQUESTS.creator)} more on Store, ${countWords(EXTRA_REQUESTS.pro)} on Studio and ${countWords(EXTRA_REQUESTS.scale)} on Scale: pages opened again, searches, the cart, downloads and the page after paying. Past them its pages rest the same way.`,
          `Downloads of what was bought are not visits and are not stopped by them. Lesson video has its own finite playback threshold. The live room stops checking by itself and shows new messages when a member presses a button.`,
        ],
      },
      {
        q: "What if I sell a very large number of things?",
        a: [
          `Your plan covers ${countWords(ORDERS_INCLUDED.creator)} orders a month on ${PLAN_TITLES.creator}, ${countWords(ORDERS_INCLUDED.pro)} on ${PLAN_TITLES.pro}, and ${countWords(ORDERS_INCLUDED.scale)} on ${PLAN_TITLES.scale}. An order is a purchase confirmed (a bundle or a cart of several products is one), an offer taken after paying, a PayPal order, a place in a purchase made for several people, or a free copy sent.${feeWords().ordersShared}`,
          "Orders are never billed. When a paid store reaches its plan's figure, new orders pause until its next billing month or until it moves to a larger plan: a buyer who presses buy is told plainly that the store is not taking new orders right now, and nothing is charged. Anybody already paying finishes and gets everything they bought, because a checkout opened in the last day counts toward the figure until it is paid or closes. A PayPal order counts like a card order. We email you the first time a month reaches the figure, and your studio shows the count as it grows.",
          "Selling video works the same way at any volume. A video sold as a file is sent to each buyer at no cost to you however many buy it. A video inside a course counts by the hour watched, as the question on lesson video says.",
          `In the free trial, new orders (paid ones and free copies together) pause once the store has had ${countWords(TRIAL_ORDERS)} in the trial, until the plan is paid. A package of calls is one order, and a call booked counts as ${countWords(CALL_ORDER_UNITS)}, for the emails and reminders it sends.`,
        ],
      },
      {
        q: "When do my plan's monthly figures start again?",
        a: [
          "With your billing month, not on the 1st. A paid plan's figures (visits, orders, emails, AI, uploads, imports and the rest) are counted from the day your plan renews until the next payment's month begins, so each payment buys one whole month of every figure. On a yearly plan they are monthly too, each month starting on the day of the month your year began. Your studio shows the dates.",
          "A free trial counts its figures for the trial as a whole. A store with no plan, before one starts or after it ends, counts them by calendar month (UTC).",
        ],
      },
      {
        q: "What else does my plan cover each month?",
        a: [
          `On ${PLAN_TITLES.creator}: ${allowanceListWords("creator")}. On ${PLAN_TITLES.pro}: ${allowanceListWords("pro")}. On ${PLAN_TITLES.scale}: ${allowanceListWords("scale")}.`,
          `A studio request is any page of your studio you open (each counts as ${STUDIO_PAGE_UNITS}), any save, and the studio's own refreshing. An API request is one made with one of your keys; a contact added or a product given counts as ${API_WRITE_UNITS}. Store emails are what your store's own tools send outside your monthly emails and your orders: inbox notices and replies, a purchase sent again, reminders, offers and notices to members. Access emails hand buyers what they already have, such as the link to their purchases or a place in a purchase made for several people. Buyer actions are what your buyers do inside what they bought, other than opening its pages: a community post, comment, like, message, RSVP or picture, a lesson comment, a hand-in, a lesson marked done, a certificate. What you do there yourself counts as studio requests, and deleting what one wrote is not counted. A webhook delivery is each try to send one of your webhooks, retries and tests included, and each one not sent because your plan's renewal payment did not go through or a payment for it is disputed.`,
          "When your buyer actions are used, your buyers can still open everything they have; what they would write waits for your next billing month, and they are told your store is resting for now. A webhook past the figure is not sent and shows in your studio as not sent, with the reason. A place in a purchase for several people taken after its first day is one of that month's orders, so when the month's orders are used, the person is told so and their place stays open for them.",
          "When one is used, that use is refused with a plain message until your next billing month, or at once on a larger plan. Nothing is ever billed past a figure. Changing your plan, canceling it, deleting your store and downloading your sales always work.",
          `Free trials and stores without a paid plan share a limited number of places each calendar month (${countWords(FREE_POOL_BASE_STORES)}, and one more for every ${countWords(PAID_STORES_PER_FREE_STORE)} paying stores). If they are taken, such a store is told so, and what it asked for waits until the next month or until its plan is paid.`,
        ],
      },
      {
        q: "How much can my store hold?",
        a: [
          `Paid storage is up to ${storageWords(PAID_STORAGE_BYTES.creator)} on ${PLAN_TITLES.creator}, ${storageWords(PAID_STORAGE_BYTES.pro)} on ${PLAN_TITLES.pro} and ${storageWords(PAID_STORAGE_BYTES.scale)} on ${PLAN_TITLES.scale}, for files and lesson videos combined. A free trial has up to ${storageWords(TRIAL_STORAGE_BYTES)}, capped by the chosen plan: ${storageWords(storageBrakeFor("trial", "creator"))} on ${PLAN_TITLES.creator}, ${storageWords(storageBrakeFor("trial", "pro"))} on ${PLAN_TITLES.pro} and ${storageWords(storageBrakeFor("trial", "scale"))} on ${PLAN_TITLES.scale}. A store with no plan, before one starts, holds ${storageWords(SETUP_STORAGE_BYTES)}.`,
          `Files your students hand in have room of their own: ${storageWords(TASK_ROOM_BYTES.creator)} on ${PLAN_TITLES.creator}, ${storageWords(TASK_ROOM_BYTES.pro)} on ${PLAN_TITLES.pro} and ${storageWords(TASK_ROOM_BYTES.scale)} on ${PLAN_TITLES.scale}. Your community keeps up to ${COMMUNITY_PICTURES.creator.toLocaleString("en-US")}, ${COMMUNITY_PICTURES.pro.toLocaleString("en-US")} or ${COMMUNITY_PICTURES.scale.toLocaleString("en-US")} pictures in its posts; deleting a post with a picture makes room for another.`,
          "Past its figure a store is asked to delete something before adding more. While a plan runs, nothing already there stops working and nothing already sold is touched.",
          `Your store's words and records have a data room of their own: ${dataRoomListWords(PLAN_TITLES)}, and ${dataWords(NON_PAYING_DATA_ROOM_BYTES.trial)} in a free trial. It holds your products, pages, posts, courses, contacts, forms and their answers, and what each order keeps: the buyer's access, their contact, their marks. Each order is counted at what it really writes, so a buyer who has bought from you before adds next to nothing, and a booked call's line in your diary is let go ${PAST_CALL_DAYS} days after the call. Your studio shows how full it is. When it is full, what you or your buyers would add is refused with a plain message until you delete something you no longer need, such as old posts, drafts, pages or contacts, or move to a larger plan; deleting is never refused. An order already paid for is never refused: room for every checkout still open is held before it opens, so when the room is close to full, new checkouts pause like they do at your monthly orders, and nobody is stopped while paying.`,
        ],
      },
      {
        q: "What happens when my plan ends?",
        a: [
          `Your store stays as it is for ${CLOSING_DAYS} days: its page, products, files, courses, community, contacts and orders, and your buyers go on reaching what they bought. Then it closes. We email you when the plan ends, ${WARN_MONTH_DAYS} days before that day and ${WARN_WEEK_DAYS} days before it, each time with the date, and nothing is removed sooner than a week after the last of those emails. Your studio shows the date too. Starting a plan again before then stops all of it.`,
          `On that day your store's files are removed (the files your products hand over, your lessons' videos and downloads, your podcast's episodes, the files your students handed in and the pictures in your community's posts), and the renewals of the memberships and payment plans you sold through it are stopped at Stripe, each at the end of the period already paid; refunds stay your decision. Within ${ERASE_WITHIN_DAYS} days, usually the same day, everything else it keeps with us is deleted: its page, products, pages, posts, courses and the certificates they gave, community, contacts, forms, numbers and your buyers' access to what they bought from it. Your store leaves your buyers' library on Marktmorgen at once, and nothing else of theirs is touched.`,
          `Before then, download your whole store as one file from your studio: at any time while your plan runs, and ${ENDED_STORE_EXPORTS === 1 ? "once" : `${ENDED_STORE_EXPORTS} times`} from the notice at the top of your studio once it has ended, whatever your store's size. It holds your products and their pages, posts, courses with every lesson's text, forms and their answers, contacts and your orders as a spreadsheet. Files and videos download from their own pages. Tell your students to download their course certificates, which they can until that day, and tell your buyers, and give them another way to what they bought if you sell elsewhere.`,
          `What we keep: no copy of your sales. Every sale, refund and payout is on your own Stripe account, and stays there. Our own records of your store are our invoices for your plan, which stay in our billing records. Your account and sign-in stay.`,
          `A plan that ended before ${new Date(KEEP_NOTHING_FROM).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })} keeps the rule it ended under: the store and its records stay, a store that keeps ${storageWords(SETUP_STORAGE_BYTES)} or less is not touched, and one that keeps more than ${storageWords(SETUP_STORAGE_BYTES)} has a date for its files, which deleting enough to keep ${storageWords(SETUP_STORAGE_BYTES)} or less also stops.`,
        ],
      },
      {
        q: "What can I sell?",
        a: [
          "Digital files, courses, memberships that charge on a schedule, paid calls, one-on-one or in groups of up to 50, live sessions on dates you set, and bundles of 2 to 20 of your products at one price. What is too big to upload, or is not a file at all, is sold as a link to where it already lives. And anything can be given away for free, in exchange for an email address.",
          "One product can carry up to 50 prices — one week and five weeks, personal and commercial — and each one hands over its own file or its own link. A course or private podcast can have several prices too, unless it is sold as a membership: every price opens it, and a file or link on one is what that one adds. Write a few lines on what each price includes and the buyer sees them side by side; mark one as recommended and it opens chosen. The buyer picks on the card, and what they are charged is read from what you saved rather than from the page they are looking at.",
          "Your page also holds links that are not for sale, with no price and no checkout on them: the channel, the podcast, the profile, the booking page you already pay someone else for.",
        ],
      },
      {
        q: "Can I sell content with resale or private label rights?",
        a: [
          "Yes, when the license you bought lets you sell it the way you sell it here, and when what you sell gives the buyer something to use, not only the right to sell it again. Keep the license: we may ask for it, and a product whose license cannot be shown is taken down. A product may not promise fast or easy money, which is also a rule of Stripe's, since your payments run through it.",
        ],
      },
      {
        q: "Can I give something away for an email address?",
        a: [
          "Yes. Set a product's price to 0 and it becomes free: a visitor types their email, we send them a link to it, and when they use that link their address joins your list. Because the link has to be opened from their own inbox, every address on the list is real \u2014 no typos, and nobody signed up by someone else.",
          "Under the email field there is a box, empty until the visitor checks it, that says they want to hear from you. Your list keeps the two apart: you can download everyone who asked for something, or only the people who checked the box, as a CSV file that email tools can import. It is yours to take at any time, with nothing to ask for.",
          "Free products are handed out while your subscription or trial is on, and they do not need Stripe, because no money moves. A list holds up to 100,000 addresses.",
        ],
      },
      {
        q: "Can it write my descriptions, outlines and emails?",
        a: [
          "Yes, as a first draft, on " + AI_PLANS_WORDS + ". In your studio, a box under a product's name, above a course's modules and at the top of a new email takes a few words from you and fills in the product's short and long description, a course outline of up to 8 modules of up to 8 lessons, or an email's subject and body. Under your store's name and description, it suggests three lines about your store, from what it sells, to pick from.",
          "It writes in your store's language (American English for a store in English) from only what you typed and what the product is. It is told never to invent a review, a testimonial, a number of students or sales, a result, a guarantee, a discount or a deadline, and nothing is saved, added or sent until you press the button that does it. Read it before you publish: it goes out under your name.",
          "Each store gets " + aiAllowanceWords() + " The jobs are shared by all the writing help. Translating a whole sales page takes one for every 4,000 characters of it, and drafting a whole funnel takes 2, or 3 with its follow-up emails; each says how many before it runs. The drafts are written by Anthropic's Claude, which receives what you typed, the product's name, price and kind, and your store's name, and nothing about your buyers, members or list.",
        ],
      },
      {
        q: "Can I sell a private podcast?",
        a: [
          `Yes, on the ${PLAN_AT.creator} plan. Under a paid product in your studio, choose \u201cSell this as a private podcast,\u201d then put out episodes as MP3 or M4A files. It can be sold once or as a membership, and goes on sale with its first episode.`,
          "Each buyer gets a feed of their own, from the thanks page, their confirmation email or their list of purchases, and adds it to Apple Podcasts, Overcast, Pocket Casts or most other apps in one tap; new episodes arrive there like any show's, within about four hours of going out. Spotify does not take private feeds. Every time an episode is fetched, we check that the buyer still has the podcast, so a refund or a membership that ends stops every episode from playing within minutes; the list of episodes in their app empties within about four hours. Podcast directories and search engines are told to keep out.",
          "A podcast app checks its feed about once an hour whether or not anybody is listening, so each subscriber counts as one visit to your store on a day their app checks, however often it does.",
        ],
      },
      {
        q: "Can I run a sale, like Black Friday?",
        a: [
          `Yes, on the ${PLAN_AT.creator} plan. In your studio, under \u201cA sale across the store,\u201d pick a percentage, when it starts and ends (at most 31 days), and whether it covers every product it can or only some. While it runs, your store and each product's page show the old price crossed out, the new one and when it ends, and Stripe takes it off at checkout with no code to type.`,
          "It ends by itself at the time you set: the prices go back, and the discount stops working at Stripe too. It covers products bought once at one price. Memberships, calls, products with price options or a price the buyer chooses keep their price, and on a product with a payment plan the sale price is for paying in full, as its page says.",
        ],
      },
      {
        q: "Can my buyers give something as a gift?",
        a: [
          "Yes, on any paid product bought once that hands over a file, a link, a course or a bundle. Under the buy button on its page there is \u201cBuy it as a gift\u201d: the buyer types the recipient's email, their own name and a message, and pays on Stripe's page as for anything else, on your own Stripe account.",
          "The recipient gets one email with the buyer's name, the message and a link to open it. It is theirs on their own address, as if they had bought it: the download, the course with its modules opening from the day it was paid, the community it opens. The buyer gets the receipt and does not get a copy. A full refund takes the gift back within minutes.",
          "A product with price options can be given at any of them: the buyer picks which one, pays that price, and that option is what the recipient owns. Memberships, calls, a price the buyer chooses and license keys cannot be given.",
        ],
      },
      {
        q: "Can buyers in poorer countries pay less?",
        a: [
          "Yes, if you switch it on, for the countries you choose, at the level you choose and on the products you choose. In your studio, under \u201cFair prices by country,\u201d check the box. It is off on every store until its creator turns it on.",
          "Then pick how. Automatic: every country gets what the World Bank's price levels for 2024 suggest, up to the most you allow (20% to 60% off), and you can change or remove any country. India, for example, gets the most you allow; Brazil and Mexico about half off; the United States, Canada, the UK, most of Western Europe, Australia, Japan and the other high-income countries nothing. Or only the countries you list, each at its own level from 5% to 90% off.",
          "A buyer in one of those countries sees your price lowered with a line saying why, and pays that on Stripe's page with no code to type. It covers products bought once at one price, the same ones a sale covers: every one of them, or only the ones you pick, so a small file can keep its price while a course is lowered. When a sale is running, the larger of the two comes off, never both. One thing to know: the country comes from the internet connection, so somebody using a VPN can be shown another country's price, and the card's country is not checked before paying. The levels you set are what that can cost you.",
        ],
      },
      {
        q: "Can my store have a blog?",
        a: [
          "Yes, on every plan. In your studio, open Blog and write a post: a title, then plain text where a blank line starts a paragraph, a line starting with \u201c## \u201d is a heading and one starting with \u201c- \u201d is a point in a list. Publish it, or keep it as a draft that only your studio shows. Each post can end on one of your products, with its card.",
          "Posts are at your store's address followed by /blog, each with its own address in words, its own title and description for search engines, and the blog has an RSS feed at /blog/feed.xml. Your store page links to the blog once a post is published. A blog holds up to 200 posts of up to 20,000 characters each, and on " + AI_PLANS_WORDS + " AI can draft one from a few words about the topic.",
        ],
      },
      {
        q: "Can my store speak another language to my buyers?",
        a: [
          "Yes: English, Spanish, French, German, Italian, Dutch or Portuguese (Portugal). In your studio, under \u201cYour store\u2019s language,\u201d pick one and press Save. Every store speaks English until its creator picks another. Drafts written with AI (" + AI_PLANS_WORDS + ") come in the language you pick, and a sales page written in another can be translated into it with AI in one step.",
          "From then on your buyers read it everywhere: your store and product pages, Stripe's checkout, the page after paying, their purchases, bookings, courses, memberships, your community, and every email your store sends them, with dates, numbers and prices written that language's way. Your studio stays in English.",
          "What you write yourself is shown exactly as you wrote it: product names, descriptions, lessons, posts and emails you compose. Write them in the same language, so a page never mixes two. One store speaks one language; a page does not switch by each visitor's browser.",
        ],
      },
      {
        q: "Can I sell a product from my own website or blog?",
        a: [
          "Yes, one product at a time. In your studio, under \u201cSell from your own website,\u201d pick the product and copy the code: a card with its picture, price, buyers' rating and buy button, or a plain button in your store's color that leads to the product's page. Paste it into a block that takes HTML, called Embed, Code or Custom HTML in most website builders.",
          "The card is drawn by us on every visit, so a new price, a sale or a sell-out shows on your site at once. Its button opens Stripe's checkout in a new tab, on your own Stripe account, and your site stays open behind it. A product with options to pick, a time to book or an email to give opens its own page instead.",
          "Give the place a name, such as blog, and sales made through that code are listed under it in your numbers, in Where the money came from. Nothing is counted as a visit and no cookie is set on your site. The whole store cannot be put inside another site, only one product per code.",
          "To open the checkout over your own pages instead, use \u201cCheckout on your own website\u201d in the same place: list up to 10 of your sites, then copy a link and a short script. Pressed on one of those sites, the link opens the product's card, or your list's sign-up form, over the page, and your page is told what happened; anywhere else it opens the product's page. Each person who presses one counts as a visit to your store, once a day. The developers page, under Checkout script, says exactly what it does.",
        ],
      },
      {
        q: "Can a company buy one of my products for its whole team?",
        a: [
          "Yes, and you do nothing. Under the buy button on a product's page there is \u201cBuy it for a team\u201d: the buyer types how many people, from 2 to 200, and pays once on Stripe's page, your price times that many, on your own Stripe account. A sale or a discount code comes off the same way as on any purchase, and if you switched on tax numbers and invoices, the company gets those too.",
          "Right after paying, the buyer gets one link, on the page and in their receipt, to pass on. Each person opens it and types their own email address; a link arrives in their inbox, and opening it puts the product on that address as if they had bought it: the download, the course with its modules opening from the day they took their place, the community it opens. A mistyped address takes no place, the page shows how many places are left, and it never hands out one more than was paid for. The buyer takes a place the same way.",
          "In your sales the order reads \u201c(for 5 people)\u201d. A full refund takes every place back within minutes; a partial refund takes none. It is offered wherever a gift is, except on products with a limited quantity or a private podcast. On a product with price options the buyer picks one for everybody.",
        ],
      },
      {
        q: "Can I take a waitlist before something goes on sale?",
        a: [
          "Yes, on any paid product. In your studio, check \u201cComing soon, with a waitlist\u201d under the product: its card and its page then take an email address instead of a payment, and no checkout opens. Each address is confirmed from its own inbox before it counts, and the box to hear more from you starts empty.",
          "When it is ready, press \u201cPut it on sale and tell the waitlist.\u201d It goes on sale that moment, and everyone who confirmed gets one email with its link, its price and a note from you if you write one, with the postal address US law asks for at the bottom. That is the only email a waitlist sends; afterward its addresses are deleted, and whoever checked the box is on your list.",
          "You see how many are waiting and how many confirmed. The emails go out in batches every five minutes and do not count toward your monthly email allowance.",
        ],
      },
      {
        q: "Can I sell something before it is ready, as a pre-order?",
        a: [
          "Yes, on any paid product with one price, sold once: a file, a link or a course. Mark it coming soon, then under \u201cPre-orders\u201d choose the day it is expected, from tomorrow to a year ahead, and check that you refund every pre-order in full if it does not come out. Its page then offers \u201cPre-order\u201d at its price, with the day and that promise, and the waitlist stays for whoever would rather wait.",
          "Buyers pay at once on your own Stripe account, with nothing added at checkout and no offer after it, and get a receipt with the day. Nothing opens before it comes out. When you put it on sale, every pre-order still paid is handed over at that moment and its buyer is emailed the way in; one you refunded is not. It cannot go on sale while it has nothing in it, and it cannot be deleted while pre-orders wait for it.",
          "Pre-orders stop by themselves after the expected day; set a new day to take more. Memberships, calls, bundles, private podcasts, products with several prices, a limited number, license keys or a price the buyer chooses cannot be pre-ordered, and a pre-order cannot be a gift or bought for several people. Pre-order buyers cannot leave a review.",
        ],
      },
      {
        q: "Can I sell a physical product, like a printed book or merch?",
        a: [
          "Yes, on any paid product sold once that hands over nothing else, at one price or at several for sizes or versions (S, M, L; signed or not). Under the product, choose \u201cShip it: a physical product, sent by you\u201d, then set the shipping cost per order (0 for free shipping), where it ships (the United States, the United States and Canada, the EU, Europe, everywhere Stripe ships, or only the countries you list) and, if you like, when it ships.",
          "Its page says what shipping costs and where it goes before anybody pays. Stripe's own page asks the buyer for an address in one of those countries and adds the shipping as its own line; with sales tax on, the product is taxed as goods and the shipping as shipping. The address is on the page after paying, in the buyer's confirmation email, on the sale in your studio and in your Stripe dashboard.",
          "You send it yourself. On the sale, \u201cMark as shipped\u201d emails the buyer that it is on its way, with a tracking link if you paste one, once. A limited quantity and the boxes at checkout work as on any product; a product you ship cannot also be a gift, part of a cart or bundle, have a payment plan or a price the buyer chooses.",
        ],
      },
      {
        q: "Can I sell a membership?",
        a: [
          "Yes. Any product can charge on a schedule instead of once: daily, weekly, monthly or yearly. The subscription is created on your own Stripe account, like every other charge here, so the member is your customer, in your dashboard, and " + feeWords().renewals,
          "Members cancel on their own. Under every membership on your page there is a link: the member types the email they pay with, we send them a link, and it opens Stripe's own page for their membership, where they cancel it themselves. It ends at the end of the period they have paid for, and nobody has to write to you or wait for you. They can change their card and see their receipts there too.",
          "A membership can start with a free trial of 1 to 90 days: the card is taken when they join, nothing is charged until the trial ends, and your page and the buyer's confirmation say so. It can also run for a set number of payments, 2 to 36, and then end by itself; the member can still cancel before that.",
          "A monthly membership can have a yearly price beside it, below twelve monthly payments. Buyers pick Monthly or Yearly in the buy box before paying, Yearly shows what it saves, and the subscription is made at that price, once a year; the thank-you page and the confirmation say \u201ca year\u201d. It is not offered beside an introductory price, on a membership with a set number of payments or several prices, or on memberships members switch between.",
          "Members already paying monthly can move to the yearly price themselves: their membership page shows \u201cPay yearly\u201d with what it saves, and before anything is charged Stripe works out the exact amount, the year less what is left of the month they already paid. What the membership includes stays the same. With \u201cEmail monthly members the yearly price, once\u201d on, each of them also gets one email from your store from their third monthly payment on, only if they agreed to hear from you. It is never offered on a membership with a discount, while an affiliate\u2019s share for a set number of months still runs on it, or where a year would not cost the member less than twelve of their own monthly payments.",
          "Or it can start with an introductory price instead of a trial: what the first payment costs, or the first 1 to 12 months of a monthly membership, always less than the regular price. Your page, its button, the course page and Stripe's checkout say both prices, \u201c$5 the first month, then $20 a month\u201d; Stripe takes the difference off with a coupon on your own account, and the regular price starts by itself. It is not offered beside a free trial, on a membership with a set number of payments or several prices, or on memberships members switch between, and a come-back offer replaces it.",
          "When a membership ends \u2014 canceled, or unpaid once Stripe has stopped retrying \u2014 its file, its course and your community close by themselves, and the member is shown a page that says so, with the way to join again. While Stripe is still retrying a failed payment, they keep access.",
          "When a renewal fails, the member gets an email from your store with Stripe\u2019s page that pays it, with the same card or a new one, and the card that pays is used for their next payments too. You choose one, two or three emails about the same payment: the first within a day of it failing, then 3 and 7 days after the first, each only while it is still unpaid. And when the card a member pays with expires before their next payment, they are emailed up to 10 days ahead, once per card, with a page that puts a new card on that membership and charges nothing; you can switch that off. Your Membership numbers page shows what came back: renewals paid in the last 30 days after failing, and how many of them after an email.",
          "Your studio's Membership numbers page shows your monthly recurring revenue, paying members and trials, churn over the last 30 days and the share of trials that became paying, overall and for each membership, read from your own Stripe account. It also shows recurring revenue month by month for the last year, with what moved it each month: members who joined, who came back, who moved to a dearer or cheaper plan, and who left, counted per member, so a move to another plan is not counted as somebody leaving. Beside it: a year at this rate, the average per paying member, and how much of what members paying a year ago brought they bring now.",
          "Members can move between your memberships, up or down, on their own. In your studio, under Membership tiers, pick 2 to 6 memberships that run until canceled at one price. On their membership page, a member then sees \u201cSwitch plan\u201d with the others, and before anything happens, the exact amount from Stripe: moving up charges the new price less what was left of their last payment, at once, to the card they pay with; moving down turns what was left into a credit taken off their next payments. What the new plan includes opens as soon as it is paid and what only the old one included closes. If the card is declined, nothing changes and nothing is owed. A member in a free trial switches without paying, and the new price starts when the trial ends. They get a receipt and you get an email. Memberships that end after a set number of payments, or have price options or pay what you want, cannot be tiers.",
          "Three things keep members, if you switch them on. A member who presses Cancel is offered a discount you choose, once, on Stripe's own page. A member can pause instead of canceling, for up to the one, two or three months you allow: what they paid for stays open to the last day, then nothing is charged and the membership is closed until the pause ends and starts again by itself with a payment; coming back early takes a payment that day, and it works on monthly memberships, once a year each. And some days after a membership ends, somebody who agreed to hear from you gets one email with a discount to come back, and a link that opens your checkout with it applied; never somebody who already came back.",
          "You can also ask why before a member cancels. With \u201cAsk why before members cancel\u201d on, pressing Cancel opens a page of your store that asks for the reason, from the ones you choose and up to three of your own, and \u201cCancel my membership\u201d is on it from the start, so answering is never required. Each answer is met with what fits: \u201cIt costs too much\u201d with a cheaper plan you sell and a pause, \u201cI don\u2019t use it enough\u201d with a pause, and something missing, too hard or not good enough with a way to write to you. Your discount, if you set one, is still offered last on Stripe\u2019s page, which does not ask again. The answers add up under \u201cWhy members leave\u201d, with how many paused or switched plan instead.",
          "Your Membership numbers page gives every running member a score of 0 to 100, from rules it shows: a failed payment, a membership already canceled and a pause take points off, and so does being away from the course or community the membership includes, after the member\u2019s first week. Members are listed from the lowest score, with the reasons beside each one and the monthly revenue of those at risk. With \u201cEmail members who stopped coming\u201d on, a member at risk only for being away gets one email from your store with the way back in, once for each period they pay for, and only if they agreed to hear from you.",
          "One thing it cannot do, said plainly: if what you deliver is a link to somewhere else, that link keeps working, so remove the member's access wherever you actually keep it. Your Stripe dashboard is where you see who is still paying.",
        ],
      },
      {
        q: "Can I sell paid calls?",
        a: [
          "Yes. Any one-off product with a price can be sold as a call. You pick how long it lasts, your time zone and the hours you take calls on each day of the week, with up to two stretches a day. You also choose how much notice you need, how far ahead people can book, a gap between calls, and where the call happens: a Google Meet link made for each booking once you connect your Google Calendar, the meeting link you already use, or a private Jitsi Meet room made for each booking.",
          "A call can take one person at each time, or a group of up to 50. Or sell live sessions on dates you set instead of weekly hours: up to 50 dates on one product, each with 1 to 500 seats, its own length and its own link, with sales closing when you say, up to 72 hours before. Buyers see how many seats are left.",
          "The buyer sees the free times in their own time zone, picks one and pays on your own Stripe account. The time is held for them for about 30 minutes while they pay, so two people can never pay for the same time. Once it is paid, the buyer gets an email with a calendar file. You get one too, or the host does on a team call. If the call is already in that person's Google Calendar, their email has no file. The call appears in your studio under Upcoming calls, and the buyer's thank-you page and list of purchases have the link to join.",
          "Every buyer gets a reminder a day before and an hour before, in their time zone, with the link to join or a note that you will send it. You get one for each time, listing everyone booked, even on a team call you do not host. A reminder that would come less than an hour after the booking is skipped. A buyer can move their booking to another open time themselves, up to twice, from the link in their email, until the notice you set before the call.",
          "Your own calendars can close times too. Paste the private iCal address of up to three calendars \u2014 Google's secret address, an Outlook calendar published as ICS, an iCloud public calendar \u2014 and the times you are busy there, up to 120 days ahead, stop being offered, usually within about ten minutes. Only the busy times are kept, never a title or a guest. The other way round, your studio gives you a private calendar address that lists your upcoming bookings, for Google, Outlook or Apple Calendar to subscribe to.",
          "Google Meet links can be made for you. Connect your own Google Calendar in your studio under Video calls, then pick \u201cGoogle Meet (automatic)\u201d under \u201cWhere the call happens\u201d on a call, a group call or live sessions. Each booking then gets an event with a Google Meet link on your primary calendar, with the buyer on its guest list; a group call or a session has one event per time, with up to 200 guests who do not see one another. Google emails nobody: buyers get the link in our booking email, reminders and calendar file. A moved booking moves its event, and a full refund deletes a one-to-one call's event or takes the buyer off a group's guest list. Only the store's owner and Admins can connect or disconnect it, and the owner is emailed each time; disconnecting withdraws our access. If a meeting cannot be made, the booking gets your own link or a private Jitsi Meet room, and we keep trying for about 16 hours; if it works more than two hours before the call, the new link is emailed to those booked, up to 20 (a bigger group keeps the link it has). On a free personal Google account, Google ends meetings of three or more people after 60 minutes.",
          `A call with weekly hours and one person per time can be a team event type: booked with whichever host on your team is free, shared out evenly (round robin), or only at times all of them are free (collective). Each host has their own hours in their own time zone, their own gap between calls, notice and a cap of team calls a day, and sets their own calendar once under \u201cYour calendar\u201d in the studio: a private iCal address, or their own Google Calendar for two-way sync (busy times read from the calendars they pick, each booking written with a Meet link to the one they choose, moved and deleted with it), which switches on once Google approves the added permissions for our app. A host whose calendar was last read more than 45 minutes ago, or cannot be read, is left out until it can be; the other hosts' times stay open. Every hold and booking takes its hosts' time in one step, so the same person is never held twice for one time, even by two stores. The ${PLAN_TITLES.creator} plan allows ${teamLimitWords(TEAM_LIMITS.creator)}; ${PLAN_TITLES.pro}, ${teamLimitWords(TEAM_LIMITS.pro)}; ${PLAN_TITLES.scale}, ${teamLimitWords(TEAM_LIMITS.scale)}.`,
          "What it does not do, said plainly: apart from calls set to Google Meet, and team calls whose host connected their own Google Calendar, nothing is written into your calendar as an event: bookings arrive through the feed you subscribe to, which your calendar app refreshes on its own schedule, and busy times are read only from the private addresses you paste. And a buyer cannot cancel on their own: they reply to their confirmation email, which reaches you, and a refund is made from your own Stripe dashboard. Unlike on Stan, Zoom links are not made for you yet: our Zoom app is waiting for Zoom to approve it, and until then you type your own Zoom link. Jitsi Meet is a free service run by a third party, not by us; nobody needs an account to join, but the first person to open a room may be asked to sign in to Jitsi to start it, so open it a few minutes early. The call itself happens on that service; nothing is streamed or recorded here.",
        ],
      },
      {
        q: "Can I sell a package of sessions, like 5 calls booked one at a time?",
        a: [
          "Yes, on a call with weekly hours. Under the call in your studio, open \u201cAlso sell a package of sessions\u201d and choose how many sessions (2 to 20), the price for all of them, and how long the buyer has to use them: 30, 60, 90, 180 or 365 days, or no limit. The call's page then offers the package beside the single session, with what it saves when it saves anything.",
          "The buyer pays once, on your own Stripe account, and gets an email with a link of their own. Each time they open it, they pick a free time on the call's page and confirm it on Stripe's page with nothing to pay. Every session is a booking like any other: the calendar file, the reminders, the meeting link, moving it up to twice, and Upcoming calls in your studio. Their list of purchases shows how many sessions are left.",
          "A session counts from the moment its time is held; if the buyer leaves Stripe's page without confirming, it comes back within an hour. After the last day to use them, or after a full refund of the package, no more sessions can be booked; sessions already booked stay booked. A group call with weekly hours can be sold as a package too, one seat per session; live sessions on dates cannot. The box for a discount code is not shown when booking from a package.",
        ],
      },
      {
        q: "Can I offer something extra, before or after they pay, or sell a limited number?",
        a: [
          "Yes, all three. Under any one-off product you can offer up to three of your other products, each at a price of your own: the buyer sees a box above the buy button for each, checks the ones they want, and the button says the new total. None is ever checked for them. Everything checked is paid in one checkout and delivered on the thank-you page.",
          "Or offer it right after they pay: the thank-you page shows it, and one press charges the card they just used, on your own Stripe account. It only works in the browser that paid, for an hour, so a forwarded link can never charge anyone. If the bank wants the buyer to confirm, they confirm it, and nothing is handed over until the payment is through.",
          "After a product you can line up to five such offers, shown one at a time: a funnel. For each one you choose where yes leads and where no thanks leads, so a no can meet the same product for less. Each offer has its own headline, text, picture and price, never above what that product costs on its own, and each one taken gets its own confirmation email. Offers after paying are shown only to buyers who paid by card, Apple Pay or Google Pay, and while sales tax is on, they are paused. Before the checkout, up to 20 pages can lead the way in order from one address: under Funnels, line up your own pages and your products' pages, and each one's way on leads to the next, through the checkout and the offers after it.",
          "On " + AI_PLANS_WORDS + ", the review step of a new funnel can draft it for you: each new page's words, its form's questions, offers from your own products and, if you want, three follow-up emails. Type who it is for, what they get and the proof you actually have; it uses only that and your products as saved, never invents testimonials, results, numbers or deadlines, and marks what only you know \u27e6like this\u27e7. A page holding one stays hidden until you replace it in the page editor, and the emails are saved only if you check the box, as a switched-off sequence in the Email Studio. \u201cSummarize who it is for\u201d reads only your store's own records, each shown with its date, and does not search the web.",
          "You can also limit how many of a product can be sold. Your page shows how many are left, counted from real payments, and stops selling at zero. A buyer who is paying right now holds one for about 30 minutes, so the last one is never sold to two people; if they do not pay, it comes back.",
        ],
      },
      {
        q: "Can buyers put several products in a cart?",
        a: [
          "Yes, on every plan, once two or more of your products could go in one. Each product's card and page then shows \u201cAdd to cart\u201d under its buy button, and the cart appears at the top of your store with each product at its price now \u2014 a sale or a fair price for the buyer's country already taken off \u2014 and the total. Buyers pay for up to four products in one payment, on your own Stripe account, and each is handed over exactly as if bought on its own: its download or link, its course, its license key, its place on their list of purchases.",
          "What can go in a cart: a paid product at one price, sold once \u2014 a file, a link, a course with lessons or a bundle. Not memberships, calls, products with several prices, a limited number, a price the buyer chooses or questions asked at checkout, products coming soon, or a bundle the buyer builds. A discount code box is shown only when nothing in the cart is already on sale. The cart is kept only in the buyer's own browser, and emptied once paid. With checkout reminders on, a cart left at its checkout gets the same one reminder a product does, naming everything in it with a link that puts the cart back as it was.",
          "\u201cBuy more, save more\u201d, in your studio next to your sale and fair prices, takes a percent you choose, from 5% to 50%, off every product in a cart once it holds 2 or more (or 3, or 4, as you choose), on top of any sale or fair price. Every \u201cAdd to cart\u201d then says so, the cart tells the buyer how many more it takes, and shows what the deal took off before they pay. It is off until you switch it on, and the order records the percent, so your numbers and any refund add up.",
        ],
      },
      {
        q: "Can I group products into collections, or suggest what goes with a product?",
        a: [
          "Yes, on every plan. In your studio, next to sections, Collections groups products under a name of your own: up to 12 collections of up to 24 products each, in the order you set, and a product can be in more than one. Each collection has its own page at /@you/shop/<name>, which you can link to from anywhere, and your store page shows a link to each one above your products. Only published products are shown in one, and a product you remove is taken out of every collection. On a collection's page, the products that can go in a cart can be added to it together, up to four at a time.",
          "On each product, \u201cGoes well with\u201d lets you pick up to three of your other products. The product's page shows them as your pick, with \u201cAdd to cart\u201d where they can go in one, and the open cart offers them while that product is in it, above what its buyers really bought with it (that part comes only from your own Stripe sales, from three buyers up, when you show what was bought). Your picks never say anything about other buyers.",
        ],
      },
      {
        q: "Can I sell a bundle of products?",
        a: [
          "Yes, on every plan. Make a product the bundle, give it a price, and choose 2 to 20 of your one-off products to go in it: those with one price and a file, a link or a course with lessons. The buyer gets every one exactly as if bought on its own \u2014 its download or link, its course, its license key, its stamped PDF, its place on their list of purchases and the right to review it \u2014 and your community, if one of them opens it. Your store shows what the products cost on their own next to the bundle's price, worked out from their prices today, only when they really cost more.",
          "What a buyer gets is written onto their order when they pay, so changing the bundle later changes it for the next buyer and nobody loses what they paid for. A bundle can be offered in the box at checkout, and as an offer after paying unless it holds a course. The open cart also offers a bundle shown on your store's first page in place of the products in the cart it holds, but only when that makes the whole cart cost less, and it says by exactly how much. Memberships, calls, free products, products with several prices or pay what you want, and other bundles cannot go in one, and a bundle itself has one price, charged once. Any product can also be unpublished and kept as a draft, and a draft can still go in a bundle.",
          "Or let each buyer build their own: check \u201cLet each buyer choose which ones they get\u201d and say how many, at least 2 and fewer than the bundle holds \u2014 \u201cany 3 of these 8 for $49.\u201d Its page lists the products with what each costs on its own; the buyer selects that many, sees what those cost on their own beside the bundle's price, and gets exactly those, written onto their order. Such a bundle is bought from its own page only: not in the box at checkout, as an offer after paying, as a gift, for several people or through PayPal.",
        ],
      },
      {
        q: "Can buyers pay in installments?",
        a: [
          "Yes. Under any one-off product, offer a payment plan: two to twelve payments, weekly or monthly, of an amount you choose, adding up to at least the full price. On a product with several prices, you set what each payment is for each price, and each price shows its own payments beside it. The buyer picks between paying in full and the plan, and the button says what is charged today.",
          "They get the product after the first payment. The rest are charged to the same card on your own Stripe account, and the plan's end date is set as soon as the first payment is through \u2014 and checked again every day for anyone who paid and closed the page \u2014 so no buyer is ever charged one payment more than they agreed to. A plan is not a membership, so it is not canceled from your page; a buyer who needs to change something replies to their order confirmation email, which reaches you.",
        ],
      },
      {
        q: "Can the buyer choose the price?",
        a: [
          "Yes, on a product with one price, sold once. Your price becomes the minimum \u2014 at least $1, or the smallest price in your store's currency \u2014 and you add a suggested price, which is already in the box on Stripe's page. The buyer types what they want to pay, and Stripe refuses anything under the minimum.",
          "It does not mix with a membership, price options, a payment plan, the box at checkout, a call or discount codes: the buyer already names the price. A one-click offer after paying, a limited quantity, sales tax and a course all work with it.",
        ],
      },
      {
        q: "Can I ask buyers something before they pay?",
        a: [
          "Yes. Up to three questions on any paid product, shown on Stripe's page under the card: a short answer, a number, or a list to choose from, each required or optional. Or the buyer's phone number, in Stripe's own phone box with their country, which is always required. The answers are in your list of sales and in your Stripe dashboard, and for a call they are in your booking email too.",
          "There is no checkbox question, and nothing is asked for a free product, which never reaches Stripe.",
        ],
      },
      {
        q: "Does a buyer who leaves the checkout get a reminder?",
        a: [
          "If you switch it on, and only if they agreed. Stripe's checkout asks the buyer whether they want to hear from you; a buyer who said yes and left without paying gets one email about an hour later with a link back to the product. One per checkout, at most one per buyer and product in a week, and none to anyone who has paid for it since.",
          "It is off until you switch it on, needs your postal address, and needs a Stripe account in the United States, because Stripe asks for that consent only on checkouts of US businesses. While it is on, a checkout left open closes after an hour instead of Stripe's usual day. For a call or a live session, the time the buyer picked goes back on sale when its checkout closes, so the reminder names that time, says it was not kept, and leads to the times still open; it is not sent when none is left.",
        ],
      },
      {
        q: "Is sales tax or VAT added?",
        a: [
          "If you switch it on. Stripe Tax works out sales tax or VAT from each buyer's address, for the places where you have told Stripe you are registered, and adds it at checkout, on your own Stripe account, for one-off sales, offers at checkout, payment plans, memberships and calls. You choose whether your prices already include it or it is added on top.",
          "It switches on once Stripe says your tax setup is complete: your head office address, what you sell, and where you are registered, all set in your own Stripe dashboard. You are the seller, so filing and paying the tax stays yours, with Stripe's reports of what was collected. Stripe charges for Stripe Tax on your account at its own published price. While tax is on, the one-click offer after paying is paused, because tax cannot be added to a one-click charge.",
        ],
      },
      {
        q: "Can I see how my store is doing?",
        a: [
          "Yes. Your studio shows the last 7, 30 or 90 days, or all time: visitors, page views, checkouts started, sales, revenue and conversion, renewals of memberships and payment plans apart from new sales, where your visitors came from, and each product and link on its own line, with how many times each product's page was opened and how many sales every 100 of those views brought. The payment comparison shows equal consecutive 7- or 30-day UTC periods within the complete 90-day ledger, including the current day as recorded so far. It includes channels with payments only now or only before. Payment change needs previous payments; share change is in percentage points and requires payments in both periods. Missing prior coverage stays unavailable, including a previous 90-day period that does not fit the ledger. Download CSV or ask your numbers assistant. Amounts include renewals and are gross before refunds, fees and ads, not new customers, profit or causal marketing lift. The payment mix panel shows the largest identified channel, the top three and payments without an identified marketing channel. All shares divide by all recorded payments in the selected UTC days, including renewals at their recorded subscription channel. Direct or unknown, pre-tracking sales and imported origins are excluded from the identified-channel ranking but remain in its denominator and the breakdown. Download payment shares as CSV or ask your numbers assistant. Complete ledger coverage is required; no payments means shares cannot be calculated. Amounts are gross before refunds, fees and ads, not acquisition shares, profit or proof of advertising lift. The numbers assistant and connected funnel/product reports use complete purchase readings for paid totals and paid conversion rates. A successful but partial reading is identified as incomplete, not a provider failure or zero sales. Traffic and checkouts remain available; product rankings use page views when paid amounts are unavailable, and paid-derived alerts wait for complete figures. Channel reports sent to connected assistants include explicit paid-figure coverage. Incomplete purchase readings withhold paid totals, attribution and variant results while traffic counts can remain available. First-visit no-channel amounts are included separately; older missing first-visit details stay null. Variant results describe paid records, not unique buyers, and disclose the 25-row limit and total variant count when available. Missing variant details remain unavailable even if the purchase reading succeeded. The attribution comparison keeps no-channel amounts separately for first and last visits and downloads as CSV. Do not add alternative visit columns or buyer answers to revenue: answers cover respondents and belong to the day answered. Older readings without first-visit no-channel figures show unavailable rather than zero. Comparisons, downloads and assistant figures wait for complete purchase readings. Under Share, choose the link type for an organic post, email campaign or paid ad, name the campaign and optionally name an ad or link variant. The generated address replaces existing attribution tags instead of duplicating them, preserves other query values and page anchors, and displays the normalized names used in the reports. Names are limited to 40 characters. Reuse the same campaign tag in ad-spend records. Paid variant records are grouped by channel, campaign and variant together, so an ad name reused in another campaign or channel does not merge different ads. Download all variant results as CSV: every row in the selected UTC period is included, even beyond the first 15 displayed, with dates, currency and definitions. Variant totals, downloads and assistant amounts wait for complete purchase readings. These records include purchases and one-click extras, not unique buyers, and their gross amounts are before refunds and fees with renewals excluded. Search the campaign table by campaign name or recorded payment/ad channel, ignoring case and accents. Sort by visits, paid records, gross amount, recorded ads, gross less ads (highest or lowest first), or name. Unknown values sort last when ordering by that numeric metric. Download displayed campaigns to export the current search and order with filter metadata; the full campaign download includes every campaign. Untagged ad spend stays a whole-report figure even in a filtered view. The campaign table combines the same utm_campaign tag across channels and shows the recorded payment and ad channels separately. Visits belong to the campaign tag as a whole and are not assigned to payment channels. Paid records include purchases and one-click extras, not unique buyers; renewals are excluded. Campaigns with recorded ad spend remain visible even without visits or paid records. Ad spend without a campaign tag is disclosed separately, never guessed into rows. Gross amount less recorded ads is before refunds and all other costs, not profit or proof of advertising lift. Incomplete paid readings stay unknown. Download the report as CSV or ask your numbers assistant. The daily result table shows payments, including renewals, recorded refunds including pending refunds, recorded ads and what remains for each UTC day. Multi-day ad entries are allocated evenly using cumulative rounding so daily amounts sum to their recorded total, including every smallest currency unit. Complete daily payment and refund records are required; missing figures stay unknown. Refunds can relate to earlier purchases, and the result is before fees, tax, commissions and other costs, not profit or advertising lift. Download these figures as CSV or ask your numbers assistant about them. The refund activity table shows recorded refunds by channel, including pending refunds, beside payments received in the same days, including renewals. The amount ratio can exceed 100% because refunded purchases may have been earlier; it is not the percentage of purchases or buyers refunded. With no payments, the ratio stays unknown. Refund records are not unique buyers or orders. Only complete, matched readings produce this table and its alerts, and it downloads as CSV. The weekly repurchase table groups buyers by the UTC Monday of their first observed purchase, using up to 180 days of history independently of the selected period. It shows cumulative repeat purchases within 7, 30, 60 and 90 days, with only buyers observed for the full period in each denominator; young cohorts show a dash instead of zero. Renewals and one-click extras do not count, incomplete history is disclosed, and these are observed purchases, not activity retention or lifetime acquisition. Download the table as CSV or ask your numbers assistant about it. The channel result and buyer-channel panels also download the selected days as CSV files with dates, currency and coverage notes, without buyer identities. Unknown results and rates stay blank; negative results stay numeric. Sales, visits day by day and sources each download as a CSV file; a sales file holds up to 5,000 sales and says so when there are more.",
          "Visits are counted without cookies. A visitor is one person on one device on one day, told apart by a one-way fingerprint that is never stored, and your own visits while logged in are not counted. Instagram and TikTok open links in their own browsers, which hide where a visit came from, so we read the app's name instead. To follow a link of your own, add ?utm_source= and a word to it, and its visits are counted under that word; utm_medium and utm_campaign are counted too.",
          "Sales are read from your own Stripe account, not counted by us: new purchases and new members, before Stripe's fee and any refund. Renewals are in your Stripe dashboard.",
          "Where the money came from is shown three ways side by side, for the days you picked: by the last place each buyer came from before buying, by the first place they came from in the 90 days before, and by what buyers answered after paying when asked where they heard of you. Answers that name a channel sit on its row (\u201cA search engine\u201d beside Google, Bing and DuckDuckGo), and the sales no link could credit are split by what their buyers said, such as a podcast or a friend. You choose how long after a visit a sale is still credited to it: 7, 30 (until you change it), 60 or 90 days.",
          "What buyers get next shows, for each product, what the same buyers went on to buy on a later visit, how many of them and usually how many days after, and which product is most often bought first, counted from every sale on your Stripe account, from three buyers up. One press offers that next product in one click after paying, at its own price, where nothing is offered there yet; another starts a bundle of the two.",
        ],
      },
      {
        q: "Can I add my Meta, Google, TikTok or Pinterest pixel?",
        a: [
          `Yes, on the ${PLAN_AT.creator} plan. Paste the pixel ID in your studio and your store's pages tell that platform about every page view, every checkout started, every lead from a free product, and every purchase with its amount, so your ads can learn who buys.`,
          "Those platforms set cookies, so visitors in the European Economic Area, the UK, Switzerland and Brazil, and anyone whose country we cannot tell, are asked first, in plain words, and nothing loads unless they say yes. Everywhere else the pixels load unless the visitor's browser sends Global Privacy Control. The ads and what they measure are yours: say in your own privacy notice that you use them.",
        ],
      },
      {
        q: "Can sales be sent to my ad platforms from the server?",
        a: [
          "Yes. Under your pixels in the studio, paste a token from each platform: a Conversions API access token from Meta Events Manager, an Events API access token from TikTok Events Manager, a Measurement Protocol API secret from Google Analytics (your Google field needs the Analytics tag ID, starting with G-), or a Conversions API token and your ad account ID from Pinterest Ads Manager. Each is sealed and never shown again.",
          "Then each purchase is sent from our server the moment Stripe confirms the payment, even when the buyer closes the tab before your thanks page or blocks the pixel, with the same order id as the pixel so it counts once, and marked as a new or returning customer. Each later payment of a membership goes as a purchase of its own, and sign-ups for something free, a waitlist or your list go as leads (not to Google, which could count them twice). Google receives purchases in your Analytics property, on the buyer's own visit; they reach Google Ads when the property is linked and the purchase is imported as a conversion.",
          "Only for visitors who allowed ad measurement on your store: never where they said no, and never without a yes where the law asks first. The studio shows each platform's last answer, and a Meta test code lets you watch events arrive under Test events.",
        ],
      },
      {
        q: "Can I sell a course?",
        a: [
          "Yes. Turn any paid product into a course from your studio and add modules and lessons. A lesson can have a video of up to 5 GB, text, up to five downloads and a link, and any lesson can be a free preview on your store. Upright phone videos stay upright.",
          "A module can open a set number of days after each student joins, and the student gets an email the day it does. Students open the course right away in the browser they paid in, and on any other device with a link sent to the address they paid with, so nobody makes a password. Your studio shows who opened it and how many lessons each marked done, and you can take a student off the course.",
          "Any lesson can end with a quiz: up to 20 questions, each with one right answer or several (or, on " + AI_PLANS_WORDS + ", drafted with AI from the lesson's text, for you to read, change and save), a pass mark, a number of tries, and if you want, later lessons locked until it is passed. It is marked on our side, so the answers are not in the page. Switch certificates on and a student who finishes gets one in the name they type, with a page of its own on your store that anyone can open to check it; they download it as a PDF file or print it, add it to their LinkedIn profile with LinkedIn's form filled in, or share it in a LinkedIn post, where its link shows a picture of the certificate.",
          "A lesson can have an assignment instead of a quiz: you write what the student should do, and they hand in a few paragraphs, a file of up to 10 MB (a PDF, Word, PowerPoint or Excel file, text, a picture or audio), or both. Either handing it in finishes the lesson, or you read each one in your studio, write back, and approve it or ask for another try; you get one email an hour at most when work is waiting, and the student gets what you wrote by email, in your store's language. On " + AI_PLANS_WORDS + ", AI can draft your reply from the assignment and what the student wrote, for you to change before anything is sent. You choose whether the lessons after it wait until it is done. Files are kept privately with your store's files and deleted with the assignment or the lesson.",
          "If your buyers already gather in a Discord server, connect it from the studio and choose which products give which roles there. A buyer presses \u201cJoin the Discord\u201d after paying or on their orders, says yes on Discord's own page, and is in with those roles. Everyone is checked again about every six hours against your Stripe account, and the roles go at the next check when a membership ends or a purchase is refunded in full; while Stripe or Discord cannot be reached, or Discord will not let the bot remove a role, nothing is taken. You can also have people removed from the server once their access ends.",
          "Under every lesson, students can ask questions and answer each other, under a name they choose; their email address is never shown, and only the course's students and you can read what they write. You answer as the creator from the lesson itself or from the course's page in your studio, the student gets an email with your answer, and your phone can tell you when a comment comes. You can hide or delete any comment, or switch comments off for the course without deleting them.",
          "The course can be sold once, in a payment plan, or as a membership that stays open while the member pays.",
          `Lesson video playback has a finite monthly threshold: ${paidVideoWords()} each month on paid plans, ${hoursWords(TRIAL_VIDEO_SECONDS)} in the free trial and ${hoursWords(SETUP_VIDEO_SECONDS)} before a plan starts or after it ends. New playback pauses at that threshold until capacity is available again. Existing player links can remain valid until they expire; raw video files use the download path instead.`, 
          `Captions can be uploaded as a .vtt or .srt file in any of 28 languages, or written by AI from what is said in the video: in the language spoken and up to two more, ${dollars(CENTS_PER_MINUTE)} a minute of video for each language, never less than ${dollars(MIN_CENTS)} a request. The price is shown before you confirm and charged then to the card your plan is paid with; anything not delivered within ${GIVE_UP_HOURS} hours is refunded. Read them before your students rely on them: a machine wrote them.`,
        ],
      },
      {
        q: "I bought from several creators here. Is there one place with all of it?",
        a: [
          "Yes: your library, at marktmorgen.com/library. Type the address you paid with and we email you a link that opens, for 24 hours, every store you bought from on Marktmorgen, each with a button to your purchases there: courses, files, memberships and calls. No account and no password.",
          "We send that email only if the address bought something here, and the page says the same either way. For your library we keep only which stores an address bought from, under a one-way hash of it; what you bought is read from each creator's own records when you open it. Purchases count from October 11, 2026, when the library opened; for anything bought before, each store's own link to your purchases still works.",
        ],
      },
      {
        q: "Can my store have pages besides its products, like an About page?",
        a: [
          "Yes, on every plan: up to 10 pages of your own, from Your pages in the studio. Each is built from the same blocks as a sales page (a headline, text, pictures, a video, steps, who it is for, questions, things said about you elsewhere, your products, a countdown and buttons) and follows your store's look.",
          "A page has its own address under your store, such as /@yourname/about, and on your own domain, such as yourname.com/about. Its buttons lead to your store, or to one product you choose. Put it in the menu at the top of your store and of your other pages, or keep it out of the menu and share its link. A new page stays out of sight until you switch it on, or until a moment you set.",
        ],
      },
      {
        q: "Can I email the people on my list?",
        a: [
          "Yes, on Studio. From your studio you write one-off emails to everyone who agreed to hear from you, or only to those who got one product, and send them now or at a time you choose. Sequences go out by themselves: a welcome when someone joins, a few emails in the days after someone buys. Each person goes through a sequence once. A sequence can end for anyone who buys, or gets one product, so it stops selling to people who already have it; and any of its emails can go only to those who have a product or do not, who have bought or not yet, or who carry a label, the others skipping it or leaving there. A step can also act instead of writing: give someone a label, take one off, start them on another sequence, set one of your fields, put their deal in a stage of your deals board (a new deal when they have no open one), write a note on their page, or email you who reached it. A sequence can start when another gives someone a label, so one sequence hands people to the next, or when someone on your list sends one of your forms that asks for an email address. An email can also go only to those who used a link to your store in the email before, or did not: that is counted only for readers who allowed it, with a box of its own when they joined, and they can stop it from any email. There is no open tracking. AI can write a sequence's emails for you on " + AI_PLANS_WORDS + ", 3 to 7 of them, from your products' names, prices and links, with only your store's own links kept; you read them and save. And when a product gets a new version, “Tell buyers about an update” under it emails everyone who bought it, once a week at most, with your words and the link to their orders.",
          "Only people who agreed are ever written to: those who checked the box when they got something free or bought from you, and those you import, where you confirm each time that they agreed. Every email carries a one-click unsubscribe, why the reader is getting it and your postal address, which US law requires; anyone who leaves is never written to again, whatever a later import says.",
          `An address that cannot be delivered to, or whose owner reports an email as spam, is taken off your list by itself. ${healthRuleWords()} Nothing waiting is lost. ${rampRuleWords()}`,
          `Emails go out under your name, and replies come to you. Studio sends up to ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} a month, one-off emails, sequences and community announcements together; during the free trial a store sends up to ${TRIAL_MONTHLY_EMAILS.toLocaleString("en-US")}, and the full ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} opens with the first payment. Your list stays downloadable as a file at any time.`,
          "Write an email in its box, or switch to Design and lay it out in blocks: headings, text, lists, buttons that lead to an https address, lines across and pictures, with the email shown beside it as it will be sent, buttons in your store's color. Four templates start you off: a newsletter, something new, a welcome and one product. A template only lays out blocks, with what to write in ⟦brackets⟧, and an email still holding one cannot go out. Both ways write the same email, so you can switch between them at any time.",
          "An email can carry up to six pictures, each added under its box where the cursor is, with what it shows for readers who cannot see it. Each is made smaller on your device, kept as a JPEG on this site so every mail app shows it, and stays for as long as your store does, so an email opened years later still has it.",
          "A sequence can also split its people in two, A and B: an email set to the first half goes only to them, one set to the second half only to the others, and each person stays in the same half at every step, so you can try two versions of a sequence on one list. A step can also tell your own server, through your webhooks, who reached it, once for each person.",
          `A sequence is also a workflow. Any step can branch, IF/ELSE: those its condition holds for do it and go on to a later step you choose, the others go to another later step or leave. A step can only wait, which with a condition makes a pure branch, or make a teammate responsible for the person's open deal. A workflow can end once someone buys, gets one product or carries a label, and it can start when someone opens a course for the first time, or when someone on your list leaves a checkout unpaid after checking the box on the checkout page to hear from you (that box is Stripe's, shown to stores with a US Stripe account; such a workflow must end once they buy). New workflows are saved paused: preview the path someone would take, then switch it on. Every run keeps its history for up to 400 days, each step attempted, then confirmed, failed or uncertain; an uncertain step is never repeated by itself, and the run waits for you to choose. When someone asks to be deleted, one press in a run's history erases them from every workflow: their runs, history and steps still waiting. Removing a workflow or deleting the store erases its runs too. ${workflowLimitWords()} Every email a workflow sends counts in your monthly emails.`,
          "A sequence can also follow your courses. It can start when someone who agreed to hear from you finishes a course, every lesson done, which is the moment to offer the next one; and any of its emails can go only to those who have, or have not, opened or finished a course. Wait three days after the purchase, send only to those who have not opened it, and the reminder reaches exactly the people who need it.",
          "You can also choose who gets an email by what your store knows about them: everyone who has spent at least an amount with you, everyone who first found you through one channel, like Instagram or a podcast, or everyone who has bought before but not in the last 30, 60, 90, 180 or 365 days. These are worked out from your own Stripe account when the email goes out, so they match buyers only, and nothing extra is recorded about anyone. Save any choice as a group with a name, up to 20, and pick it again for the next email.",
          "Someone on your team with the Editor role can write drafts, up to 20 per store; you or an Admin read them and send them. And, if you switch it on, one email asks each buyer for a review, 3 to 30 days after buying, counted in the same monthly emails.",
        ],
      },
      {
        q: "Can I publish an email I sent on my store?",
        a: [
          `Yes. In the list of what you sent, press Publish on your store under a sent email. It gets a page of your store, such as /@yourname/letters/…, and /@yourname/letters lists every email you published, newest first, in your store's look. Nothing is published by itself: you choose each one, and you are asked first, because anyone can read it once it is published, including people who are not on your list. An email you sent to the buyers of one product may hold what they paid for.`,
          `What is published is a copy of its subject and words as they went out, with its links as you typed them, and nothing about who received it. Take it off and the copy is deleted. A published email stays for ${LETTER_KEEP_DAYS} days from the day you published it, up to ${MAX_PUBLISHED_LETTERS} at once, each counted in your store's data like anything else it keeps. Share the list's address wherever you share your store, or add it as a link on your store page.`,
        ],
      },
      {
        q: "Can I send my list to Mailchimp, Kit, beehiiv or MailerLite?",
        a: [
          "Yes, on every plan. Paste an API key from your account on the platform, pick the audience, form, publication or group, and choose who is sent: free sign-ups once they confirm, buyers of every product or of some, with up to three tags per product. Only people who agreed to hear from you are ever sent, and someone who unsubscribed on Mailchimp or beehiiv is never subscribed again.",
          "The key is checked, encrypted and kept; your studio shows only its last four characters, and disconnecting deletes it. What is sent is an email address, a first name when there is one, and the tags. One platform per store; it only adds people, reads nothing back, and does not send those who joined before you connected it, so download your list and import it for them. Stan's help center, read on September 28, 2026, connects Mailchimp, Flodesk and AWeber through Zapier; here Mailchimp, Kit, beehiiv and MailerLite are built in, with no Zapier.",
        ],
      },
      {
        q: "Can buyers leave reviews?",
        a: [
          "Yes, and only buyers can. A review is written from the thank-you page, the buyer's list of purchases or the one email that asks, and each of those first checks the order on your own Stripe account: paid, and not refunded in full. One review per buyer and product, 1 to 5 stars, up to 1,000 characters and one photo if they like (made smaller on their device before it is sent), under the name they choose or \u201cVerified buyer\u201d; their email is never shown.",
          "You can answer a review in public, hide one and take its photo off, but you cannot change a word of it or delete it. You hide a review only for one of the review rules: it shares private information, is abusive or hateful, is not about the product, is clearly false, or breaks the law. The rules are the same for every rating, and low stars or criticism are never a reason. Hiding takes its words off the page but never its stars out of the average, and the page says how many are hidden. A refund in full takes its stars out. Booked calls and free products are not reviewed. On Stan, according to its help center, read on September 28, 2026, reviews are added by the creator, and customers cannot write one.",
        ],
      },
      {
        q: "Can I build a sales page or a landing page?",
        a: [
          "Yes, on every plan. Any product's own page can be built from up to 30 blocks: a hero with the product's picture or a video from YouTube, Vimeo or Loom (beside the words, centered, or the picture behind them, with a button if you want), your own pictures (up to 24 on a page, each with a description for people who cannot see it that AI can write from the picture on " + AI_PLANS_WORDS + "), text, benefits, what is inside, a picture beside text, who it is for and who it is not for, how it works, a comparison table, bonuses, a card for another of your products, numbers your store counts by itself (lessons, buyers, the average rating), things said about it in public elsewhere (each with a link to where it was said, so visitors can check it), about you, questions, your guarantee, a countdown, buttons and reviews. Start from another of your products' pages (its blocks and words are copied, its pictures stay with it), from one of six templates, from a draft written with AI on " + AI_PLANS_WORDS + " (which, for a PDF, can read its first ten pages first, so what is inside comes from the real contents), or from nothing, and drag the blocks into the order you want. Translate the whole page with AI into any of the store languages in one step; names, numbers and prices stay as they are, and nothing is saved until you press Save. Add a block from a gallery grouped by what it does, at the end or right between two others, keep one to phones or to computers and tablets, or duplicate one to start the next from it. The page as it was before each of your last five saves is kept under Earlier versions for as long as the page is, counted in your store's data room, so a save can be taken back; while you edit, Undo and Redo (Ctrl+Z and Ctrl+Shift+Z) go back and forward a step at a time. On a wide screen the page is drawn beside its blocks, as visitors will see it on a phone, and redrawn as you type; press a part of it to open that block. In the reviews block you can pick up to three of your buyers' verified reviews to show first; each is marked as picked by you, and the average and the count stay those of every review. Keep it from visitors while you work on it (they see the product's plain page) and show it when it is ready, or have it show by itself at a moment you set. Choose its style: plain, in bands (every other section on a soft wash of your store's color) or in cards. It has its own title and description for search engines, and a share picture drawn from the product's picture, name, price and stars. For a free product the page asks for the email, and afterward can show one of your paid products next.",
          "You can also have visitors' questions answered on the page. On " + AI_PLANS_WORDS + ", switch on \u201cAnswer buyers' questions with AI\u201d in your studio and each product page gets a box, \u201cA question before you buy?\u201d The answer comes only from what that page says and from your own notes, in the visitor's language, and it never states a price, a refund, a deadline or a result that is not there. When the page does not say, the visitor is told so and the question is listed in your studio, with nothing about who asked. " + answerAllowanceWords() + " Past the allowance, the box closes until the next month. Cached answers can still be shown without another model call.",
          "On " + AI_PLANS_WORDS + ", under each block of words there is \u201cImprove with AI\u201d: Clearer, Shorter, More specific or Warmer, in your store\u2019s language, with Undo. An empty block of benefits, who it is for, how it works or questions gets \u201cWrite it with AI\u201d: a first draft from your product\u2019s description and the rest of the page, never a refund promise, your story, bonuses or what is inside, which only you can say. It rewrites only your words and keeps the block\u2019s shape; a rewrite that brings a number or a promise your page does not already make is thrown away, and not counted.",
          "Above the blocks, the page coach gives the page a score out of 100 and lists what is missing, most important first, each with a button that adds the block. It also shows where most readers stop. With the writing help on, \u201cReview my page\u201d reads the page as visitors do and says what to change first, drafts three headlines (use one, or test it against yours), who it is for and not for, and the questions your page leaves open; nothing changes on your page until you press a button, and nothing is live until you save.",
          "Under the page editor of anything paid, \u201cAfter paying: a note from you\u201d puts your own words on the thank-you page, under what was bought, and in the confirmation email: what to do first, a welcome video from YouTube, Vimeo or Loom, and one button to an https page of yours, like your group or a booking. The button opens in a new tab with the site it leads to written under it.",
          "To test the whole page, press \u201cMake version B\u201d under the coach: version B starts as a copy of your page, and you change anything in it \u2014 blocks, their order, words, pictures, video \u2014 switching between Version A and Version B as you edit. Once saved, half your visitors read each, kept to the same one by a cookie. " + PAGE_TEST_WORDS + " The studio shows each version's views, sales and money per visitor, the chance one brings more, and at least how many days are left at the traffic the test has had, and \u201cKeep version A\u201d or \u201cKeep version B\u201d ends the test when you save. A page runs one test at a time, the price is the same for everyone, and changing either version starts the count again. A second headline is tested the same way, from \u201cTest a second headline\u201d in the hero, and \u201cWrite a second headline with AI\u201d drafts one from your page, said another way and with no number your page does not state.",
          "A countdown runs to one moment you set, the same for every visitor and shown in their own time zone. It never starts again for each visitor, and it disappears once the moment has passed, so it can only count down to something real.",
          "Every block is plain text and your own pictures in your store's theme and letters and one of three page styles: no custom code or stylesheets. A button leads to the checkout the store already has, so a page can never state a price of its own.",
        ],
      },
      {
        q: "Can I run a community or a webinar?",
        a: [
          "A community, yes, one per store. You choose which products open it: any paid product, a membership while it is being paid for, and free products if you want. Members come in with a link emailed to the address they bought with, and that browser stays in for 90 days. Who bought what is checked against your own Stripe account on every visit, so a membership that ends loses access within five minutes.",
          "Inside: up to 20 spaces, each open to the whole community or kept for the buyers of the products you choose; posts with a title, up to 5,000 characters and one picture, which can be edited after they are written; polls of up to 12 answers; comments and one level of replies; likes on posts and comments; and up to three pinned posts and a Start here post. Members mention each other with @, and are told when somebody mentions them, comments on their post or answers their comment, in the community and, if they allow it, as a notification on their computer or phone (on iPhone, once the page is added to the home screen, as Apple requires).",
          "There is a room for talking live, which you can slow down, keep for your own messages, or close. Members can write to you privately, and to each other if you allow it, with a first message that waits to be accepted if you choose. One search box looks through the posts and every comment under them, the lessons of the courses a member has, the events, the people in the directory, the room and the member's own messages.",
          "You can ask up to three questions every member answers once, before their first post or comment, and only you read the answers; and send a welcome message privately, from you, the first time each member comes in.",
          "Every like a member's post or comment gets from somebody else is one point, and points make 9 levels, shown beside every name, with a leaderboard for 7 days, 30 days and all time. You can open a space for posting only from a level, and have a level hand over one of your courses, free; it stays the member's if their points fall later.",
          "Members choose the name they are seen by and whether to appear in the directory; other members never see their email address. They can report a post or a comment, and you hide or delete it, mute a member or take them out. Your announcements can also go by email to members who asked for them, on Studio.",
          "It also holds live events members RSVP to, with reminders, a private video room in the event's page or your own link, and replays \u2014 the next answer has the details. A webinar you want to sell to anyone, not only to members, you sell as a live session on the dates you set, with up to 500 seats each.",
          "What it does not have: search does not listen to what is said inside a video, only to titles and written text. Stan adds webinars to its community with Zoom or Google Meet links made automatically; ours makes Google Meet links once you connect your Google Calendar, and no Zoom links yet.",
        ],
      },
      {
        q: "How do live events in the community work?",
        a: [
          "From the community in your studio you schedule an event: a title, a few words, a start in your time zone and a length from 15 minutes to four hours, up to a year ahead, with an announcement in the feed if you want one. Up to 50 can be coming up at once, and up to 500 are kept with their replays. Members RSVP with one click, and you can cap the places at anything from 1 to 5,000. An event can be for every member, or only for the buyers of some of the products that open the community; the others see it but cannot RSVP or join.",
          "The way in shows on the event's page from 15 minutes before the start until the end, only to members who may come \u2014 and, with a cap, only to those with a place \u2014 checked again on every visit. It is a private Jitsi Meet room made for the event, which members open inside the page or in a tab of its own, your own meeting link, or a Google Meet made on your connected Google Calendar: one meeting with nobody on its guest list, so members ask to join and you let them in. Emails, calendar files and the feed point to the page, never to the room. Members who asked for the community's emails get a reminder a day and an hour before; a move or a cancellation is emailed once to everyone coming; and, if you have turned on phone notifications, you get one 15 minutes before. After it starts you can add a replay from YouTube, Vimeo or Loom.",
          "What it does not do: unlike Stan's webinars, it does not make Zoom links for you yet. On a free personal Google account, Google ends meetings of three or more people after 60 minutes. Jitsi Meet is run by a third party, and the first person to open a room may be asked to sign in to Jitsi to start it, so open it a few minutes early. Jitsi publishes no size limit for its free rooms, and big video calls there get unsteady, so for more than a few dozen people use your own meeting link. Nothing is streamed or recorded here, there is no chat beside the room and no waiting list, and an event is not sold on its own: to sell seats, sell live sessions on dates.",
        ],
      },
      {
        q: "Can I run an affiliate program?",
        a: [
          "Yes. Switch it on, set a commission of 1% to 90% for the store or product by product, and a window of 1 to 90 days after a click. People apply on your store's affiliate page with an email address they confirm, and you approve them; or you let everyone who buys take their own link at once, from the thanks page or their purchase email, without applying. Each gets a link and a page of their own with their clicks, sales, what they earned and what you paid them; they never see who the buyers were. Up to 1,000 people, applications included. You can give one affiliate a share of their own, 1% to 90%, which replaces the program's on every product except those set to 0%; and each affiliate can choose, on their own page, the PayPal address they are paid at.",
          "The part to know first: the money is yours, and so are the payments. Every sale lands in full in your own Stripe account and we never hold any of it. Connect an app from your own PayPal Business account, with PayPal's Payouts switched on, and your studio pays everyone owed from your PayPal in one press \u2014 or by itself on the payday you set, with an email saying what was sent. Each affiliate is paid at the email address they joined with; the book says paid once PayPal confirms it, anyone PayPal cannot pay stays owed, and nobody is sent twice. PayPal charges you its own fee on each payment. A PayPal account in Brazil can only send these payments in reais, to Brazil, so it cannot pay through us. Without PayPal, download the batch for PayPal or Wise, or pay however you agree, and mark it paid. On Stan, affiliates are paid out of your sale, which Stan holds for 7 business days first.",
          "Commission is worked out on what was paid before tax, and a refund on your Stripe account cancels it or reduces it. So does a chargeback: while the bank holds the disputed amount, and for good if the dispute is lost; a dispute you win earns again. One-off sales and booked calls earn commission. Memberships and payment plans earn only if you choose: a membership on its first payment, on every payment in its first 3, 6, 12 or 24 months, or for as long as the member pays, read from your Stripe account as each one is paid; a payment plan on each of its payments. A membership keeps the terms it was sold with. The last affiliate link a buyer followed wins, and nobody earns on their own purchase, even from their address written another way.",
          "You can add up to three monthly bonuses, such as $50 when an affiliate's link brings 10 sales that earn in a calendar month; a refund that takes the month back under the goal takes the bonus back. Two checks hold commission before it is paid: two affiliates sharing an inbox or payout address, and, unless you allow it, an affiliate's link reached from a paid search ad on your name. What is held is left out of every payment until you look and release it. Visits and sales through affiliate links show as their own channel, Affiliates, in your numbers.",
          "You can also pay per lead: a fixed amount, from 0.50 to 100 in your store's currency, for each confirmed lead an affiliate brings. You choose one kind: an email sign-up to your list, counted once the person presses the button in the email they are sent and only for an address new to the list; a free product claimed, counted when its emailed link is opened, the first time that address gets it; or a booked call, counted once its time has passed, it was not refunded and you approve it as having taken place. A person is one lead in your program, ever, written any way, and never an affiliate's own address or yours. Each lead waits in a hold of 7 to 90 days that you set, then for your approval, before it can be paid; how many leads earn per affiliate a UTC day is yours to set, an hour holds a quarter of it, and a monthly budget caps them all. A lead past either is listed for you and your affiliate and earns nothing. You can reverse any lead that is not genuine, saying why, and your affiliate sees that reason; a reversed lead that was already paid comes off what you owe, as a refund does. Each lead keeps the terms of the day it came. A sign-up is credited while your store's monthly requests have room, and a lead takes a little of your store's data room, like any record.",
          "You can add a second tier of 2% to 20%. Each approved affiliate then has an invitation link on their page; somebody who applies through it and whom you approve is theirs, and on each sale that person brings the affiliate who invited them earns that share too, paid by you on top of the first share, never out of it. It goes one level only, everything promised on one sale, partners' shares included, never passes 90%, it follows refunds like any commission, and it waits while the person they brought is held. Each recruit keeps the share in force on the day they joined, so changing it later rewrites nobody's terms.",
          "To be found by people looking for something to promote, check \u201cList my program in the affiliate directory\u201d and save. Your program is listed at marktmorgen.com/affiliate-programs while your store can take payments and has a product that earns: your share, how long a click counts, your payment day and up to four products, each with what one sale earns at today's price. A second box, \u201cShow my program's numbers there too,\u201d adds your program's own figures: how many affiliates you have and since when, the clicks they brought, the sales those clicks made, what they earned before refunds and what you recorded as paid, with the share of clicks that became a sale and what 100 clicks earned once there are 100 clicks. Programs are listed by the highest share, then by how many products earn, then by name; nobody pays to be placed higher. Uncheck it and save, and it leaves the page at once. Every affiliate is asked, on your program page, on their own page and in the email that approves them, to say they earn from the link wherever they share it and to promise only what the product does. On " + AI_PLANS_WORDS + ", approved affiliates can also have three posts drafted on their own page, for X, Instagram and LinkedIn, from the page of a product they pick, in your store's language; each ends with their link and a line saying they earn from it. Up to 3 a day each, each one of your writing jobs for the month and never more than a quarter of them together; switch it off under \u201cDraft posts for my affiliates.\u201d",
          "Your affiliates keep every store they promote here in one place, at marktmorgen.com/affiliate: they type the address they joined with, and a link emailed to it shows each program with their link and where their application stands, opens each store's own page with their numbers, and leads to the directory to join more. What they see of your program there is what your own affiliate page shows them.",
        ],
      },
      {
        q: "Can I connect Zapier, Make or my own server?",
        a: [
          "Yes, with webhooks. Add up to five https addresses in your studio and choose the events each one hears: a sale, a membership started or canceled, a lead confirmed for a free product, a call booked or moved, a refund, and a step of a sequence that tells your webhooks. Each message is JSON, signed with an HMAC-SHA256 in its Marktmorgen-Signature header, and tried again over about forty hours if the address does not answer. Your studio keeps a log of the last deliveries for up to a week, and a button sends a test.",
          "There is no Marktmorgen app in Zapier's directory: in Zapier, use Webhooks by Zapier with a Catch Hook. Events read from your Stripe account can take up to about five minutes to arrive.",
          "To read your store from your own tools instead — your list, your community's members, a course's students, your affiliates and your bookings — make an API key in your studio, on every plan. A key reads unless you make it one that can also write: then it adds people who agreed to hear from you to your list, changes their labels, and gives or takes back products, as an import does. The developers page lists every address and what it returns.",
        ],
      },
      {
        q: "Can I sell software with license keys?",
        a: [
          "Yes, on any paid one-off product that is not a membership, a call or a course. Upload the keys your own system made, up to 10,000 at a time, or have them made here in a shape you set. Each buyer gets one no one else has, on the thank-you page, in their email and in their list of purchases, and you are emailed when the pool runs low.",
          "Your software can ask a public address whether a key is valid, revoked or unknown; the answer says nothing about who bought it. There is no activation or seat counting: revoking a key is a record your software has to check.",
        ],
      },
      {
        q: "Can I put the buyer's email on a PDF?",
        a: [
          "Yes. Switch on stamping for a product, and every page of the PDF a buyer downloads carries one line along the bottom with their email, the date and their order. It discourages sharing; it does not stop it, and it is not copy protection. PDFs up to 50 MB are stamped; a bigger one, or one locked with a password, is handed over as uploaded and your studio tells you. Say on the product that the buyer's email is printed on it.",
        ],
      },
      {
        q: "Does it work on a phone?",
        a: [
          "That is the case it is designed for. Your store installs to the home screen on both iPhone and Android as an app of its own, with its name, its icon and its color, straight from the browser, with no app store in between. It opens on your store, not on ours.",
          "Your studio installs the same way, and from it you can turn on notifications of every sale, booking, community report, affiliate application, live event about to start and comment under a lesson, on Android and on a computer, and on iPhone and iPad with iOS or iPadOS 16.4 or later once it is on the home screen. It is not an app from the App Store or Google Play; Stan has a native iPhone app, and we do not.",
        ],
      },
      {
        q: "Can my store show that people are buying?",
        a: [
          "Yes, with the truth only. Under \u201cLatest purchases on your store\u201d in your studio, switch it on, and your front page and product pages show a small card at the bottom: what was bought, how long ago, and the country the card was billed in, written in your store's language. It never says who bought, by name, city or picture.",
          "It shows only purchases paid on your own Stripe account with real money, from the moment you switch it on, for 7 days each: up to 3 a visit, each once, never repeated to fill the space. Test payments, free copies, trials, calls and tips are not shown. A payment refunded in any part is left out, and so is a product you hide or remove. With no purchase in the last 7 days, nothing is shown. There is no way to type one in, here or anywhere else. A visitor can close it, and it stays closed for the rest of their visit.",
        ],
      },
      {
        q: "Can I copy a funnel, or share one with another creator?",
        a: [
          "Yes, on every plan. Under Funnels in your studio, choose a funnel and make a copy here, make a share link, or download it as a file. A copy keeps your words, videos and products, makes pages of its own and leaves the pictures on the original pages. It arrives off, with its pages kept from visitors.",
          `A share link opens the funnel for another Marktmorgen creator: they see its steps, pages and forms, choose their own products for its steps (or leave one out), and bring it in as a draft. Only the words and the shape go. Your pictures, files, buyers, contacts, form answers, reviews, prices, numbers and products never do, and neither do your about text, guarantee, videos, deadlines or what others said about you: they are told what to fill in. The link is shown once; only its fingerprint is kept. Revoke it at any time, and it stops working at once; otherwise it works for the days you chose, ${MAX_SHARE_DAYS} at most.`,
          `It is a snapshot: what you change afterward is not in it. Share links at once: ${SHARE_LIMITS.creator.shares} on Store, ${SHARE_LIMITS.pro.shares} on Studio and ${SHARE_LIMITS.scale.shares} on Scale. Each calendar month (UTC), on Store, Studio and Scale: funnels brought in, copies and starters included, ${SHARE_LIMITS.creator.importsPerMonth}, ${SHARE_LIMITS.pro.importsPerMonth} and ${SHARE_LIMITS.scale.importsPerMonth}; previews before bringing one in, ${SHARE_LIMITS.creator.previewsPerMonth}, ${SHARE_LIMITS.pro.previewsPerMonth} and ${SHARE_LIMITS.scale.previewsPerMonth}; share links made, ${SHARE_LIMITS.creator.sharesPerMonth}, ${SHARE_LIMITS.pro.sharesPerMonth} and ${SHARE_LIMITS.scale.sharesPerMonth}; files downloaded, ${SHARE_LIMITS.creator.exportsPerMonth}, ${SHARE_LIMITS.pro.exportsPerMonth} and ${SHARE_LIMITS.scale.exportsPerMonth}; updates of your pages from a saved section, ${SHARE_LIMITS.creator.appliesPerMonth}, ${SHARE_LIMITS.pro.appliesPerMonth} and ${SHARE_LIMITS.scale.appliesPerMonth}. One share link can be previewed ${PREVIEWS_PER_SHARE_MONTH} times and brought in ${IMPORTS_PER_SHARE_MONTH} times a month, by everyone together. A funnel's file can be up to ${bytesWords(SHARE_LIMITS.creator.bundleBytes)}, ${bytesWords(SHARE_LIMITS.pro.bundleBytes)} and ${bytesWords(SHARE_LIMITS.scale.bundleBytes)}. A file is checked before anything is made: anything that is not part of a Marktmorgen funnel, or looks like code, is refused.`,
          "There are also six starters with first words written: a free guide then your first offer, a recorded workshop, a coaching application with its form, a membership with the page that sells it, a free lesson then the full course, and a paid call. Every sentence in them is one you can say as it stands, or a part in [brackets] for you to fill in.",
        ],
      },
      {
        q: "Can I copy a whole store into another of my stores?",
        a: [
          "Yes, if you own both. Open the store you want to copy, then Copy this store in your studio, choose the store to copy into and press See what it makes. It lists what it would make there and what it leaves out, and nothing is written until you press Copy.",
          "Its products come across with their words, prices, schedules, checkout questions, boxes at checkout, offers after paying, long descriptions and pages of blocks, each kept off the store until you publish it there. Its own pages arrive out of the menu and kept back from visitors, its forms and quizzes with their questions and no answers, and its funnels off. Check the box and the store page's setup comes too, replacing that store's: the about line, colors and letters, links, social profiles, questions and answers, the order of its parts, its sections and its line of news.",
          "Never copied: customers, orders, contacts, emails, form answers, reviews, numbers, payments, payout details, taxes, the domain, the email sender and its address, the team, integrations and keys, and every file and picture, which are the first store's: upload them again there. A call, a course, a private podcast, a product with options or license keys is not copied, and the list says which. Both stores must sell in the same currency.",
          "A copy is made in steps, each some of the receiving store's studio requests for its billing month, and everything it writes takes room in that store's data. When it does not fit as a whole, in products, pages, forms, funnels, data or the month's studio requests, nothing is written and the list says why. If a step stops, press the button again: the copy goes on from where it stopped and never makes anything twice.",
        ],
      },
      {
        q: "Can I reuse a section on several pages?",
        a: [
          `Yes, on every plan. In the page editor, open Saved sections and save up to ${MAX_SECTION_BLOCKS} blocks of the page under a name; then add it to any other page of your store, product pages and your own pages alike. A headline at the top and the reviews cannot be in a section, because a page has one of each.`,
          "After changing a section on one page, press Update the saved section from this page. You see the other pages that use it and check the ones to update; nothing else changes. A page with its own pictures in the section, or running a test, is listed and left for you to change by hand. Every page updated keeps its earlier version, to bring back.",
          `Pictures stay on the page that shows them: a section keeps the block, and you add that page's pictures. Sections in your library: ${SHARE_LIMITS.creator.savedBlocks} on Store, ${SHARE_LIMITS.pro.savedBlocks} on Studio and ${SHARE_LIMITS.scale.savedBlocks} on Scale.`,
        ],
      },
      {
        q: "Can I add a form, a survey or a quiz?",
        a: [
          "Yes, on every plan. Make one under Forms in your studio: up to 12 questions, each a short or long answer, an email address, one choice or several from up to 8 options, or a scale of 1 to 10, marked required or not. Then add a Form block to one of your own pages under Your pages and choose it there. A store can have 20 forms.",
          "A quiz is a form with results: each option of a choice can point at one of up to 6 results you write, and each person sees the result most of their answers point at, the first in your list on a tie, with one of your products for it if you choose one. On a page that is a step of a funnel, sending the form leads on to the next step, after the result when there is one.",
          "A quiz can be scored instead: each option of a choice carries 0 to 100 points, optionally counted in one of up to 4 categories too, and each result is for a range of totals. A person's total is the sum of the points of the options they chose, and they see the result whose range holds it, with their score, the range, and their score in each category. The studio checks that every total from 0 to the highest possible has exactly one result, and saves the quiz only when it does; it shows which total gives which result, and lets you try answers to see the score and result they give before anyone answers. Someone who answers no scored question sees your thank-you, not a result. Points are never negative. The score and result are kept with the answers, in the spreadsheet too, and a workflow that starts with the form can start only for one result.",
          "Questions can branch. On a one-choice question, each answer can lead on to a later question, skipping those between, or end the form there; it only ever leads forward. A person sees only the questions their answers lead to, and the ones skipped are not asked and not kept. In a quiz, an answer that ends it and points at a result decides that person's result.",
          "The newest 2,000 answers of each form are kept for you: the newest 50 are shown in your studio, and all of them download as a spreadsheet. A form with an email question can offer to join your list: a box under the questions, empty until it is checked, which sends the person an email with a button, and they join only once they press it. Never ask for a card number, a password or anything a stranger could use.",
        ],
      },
      {
        q: "Can visitors chat with me, and where do I answer them?",
        a: [
          "Yes, on every plan. Under Inbox in your studio, switch on the chat, and a button shows in the corner of every page of your store. A visitor writes with their email, and their name if they like. Your answer shows in their chat while the page is open, and goes to their email too, with a link back to the conversation, so nobody has to wait on the page. Messages from your contact form land in the same inbox, and still reach your own email as before.",
          "You are emailed when someone writes, at most every half hour for each conversation. In the inbox, give a conversation to someone on your team whose role answers buyers (Admin or Support), keep saved replies for what you are asked often, and close a conversation when it is done: it opens again if they write. Where the writing help is on, \u201cSuggest an answer\u201d writes one from your store's questions and answers and the conversation, for you to change before sending; their address, phone numbers and links are taken out first, and it uses one of the month's writing jobs.",
          "Your answers only ever go to the person who wrote, and only in answer to them. Conversations are kept 180 days after their last message, the newest 500 of them. A visit to your store asks nothing more of our servers for the chat: only writing in it does.",
        ],
      },
      {
        q: "Can an AI answer my buyers' questions at any hour?",
        a: [
          `Yes, with the ${ASSISTANT_NAME}, an add-on at ${assistantPriceWords()}, on any plan once your plan is paid. It is not on sale yet: it opens with Marktmorgen's plans. Once it is on and switched on under Pages in your studio, a chat in the corner of every page of your store answers buyers in their language, only from what you published: your products, their prices and how each is delivered, the questions and refund promises on their pages, your store's questions and answers, and your notes for it. Every reply is labeled as AI.`,
          "It says when it does not know, and never states a price, a deal, a code, a deadline or a result you did not publish: a reply that names a number or a deal that is not in your store's own words is never shown. A complaint, a refund request, a payment problem, a request for a person, or any question it cannot answer is passed to your inbox with the buyer's email, for you to answer; your answer goes to their email. The questions it could not answer are listed in your studio, with nothing about who asked.",
          assistantAllowanceWords(),
          `A conversation is kept for ${ASSISTANT_KEEP_SECONDS / 3_600} hours after its last message, without the buyer's name or address, and the buyer can delete it at once. It is a subscription of its own, charged each month to the card your plan is paid with; stop it at any time and it stays on until the end of the month paid. Its payments are not refunded, except where the law requires it.`,
        ],
      },
      {
        q: "Can the Store assistant suggest one next product after a purchase?",
        a: [
          `Yes, with the ${ASSISTANT_NAME}: switch on \u201cSuggest one next product after a purchase\u201d under Pages in your studio. The page after paying then shows one more of your own products, at its published price, with its own description and a \u201cNo thanks\u201d that hides it for that order. It never shows what the buyer just bought or already owns from you (read from your own Stripe account by the address they paid with, and from purchases you brought over), anything they turned down after paying, a draft, or a product with a limited number for sale, and it waits while one of your offers after paying is still asking for an answer.`,
          "Your own choices decide first, in this order: what you said goes well with the product, what it offers after paying, what it offers in a box at checkout, the rest of a collection it is in. Only when you set none does an AI choose among your products; it is then labeled \u201cAI suggestion\u201d, and its one sentence of why is shown only when it says nothing your own words do not, otherwise your product's own description is. Each AI choice is one reply of the add-on's month; once those are used, your store's own order decides, at no AI cost. One choice is made per order and kept three days, so opening the page again costs nothing more.",
          "Check \u201cAlso in the order's confirmation email\u201d and the same product is a few lines of the email the buyer already gets, never an email of its own, and only for buyers who checked the box to hear from you at checkout. A purchase that follows it is an ordinary sale on the product's own page.",
        ],
      },
      {
        q: "Can the Store assistant send one reminder after a checkout left unpaid?",
        a: [
          `Yes, with the ${ASSISTANT_NAME}, only to a buyer who asks for it: switch on \u201cOffer one reminder at checkout\u201d under Pages in your studio, with the postal address your reminders carry given under Checkout reminders (US law asks every email about buying something to include one; without it the box is not shown and nothing is sent). Your checkout then shows an unchecked box, \u201c${ASSIST_REMINDER_WORDS.en.box}\u201d, in your store's language, and a place for the buyer's email once it is checked. Typing an address is never taken as a yes: only the box is, and the sentence they checked is kept with the time and its version.`,
          "One email, from your name, about an hour after that checkout closes unpaid: what they left (a product or a whole cart), its link and today's price, the sentence they checked and the day, your postal address and a link that stops your reminders at once, with a one-click unsubscribe for mail apps. Never when the checkout was paid, when the address paid for it since in another checkout, pressed stop, left your list, bounced or was deleted from your store, and never twice for one checkout. No discount, countdown, stock count or review is ever added.",
          "An AI adds one short, neutral line about the products in that checkout, written only from your own titles and descriptions and labeled as written by AI; a line with a number, a link, an exclamation or a word of pressure is never sent. Each line is one reply of the add-on's month; once those are used, or the AI does not answer, the same email goes without it. The email is one of your store's own emails for the month and is not sent once those are used. What the buyer typed is deleted three days after the checkout opened, or at once when you delete them.",
        ],
      },
      {
        q: "What if I can no longer open the email I log in with?",
        a: [
          "Two things get you back in without it, and both are set up ahead of time under Account in your studio. A passkey logs you in with your fingerprint, face or device PIN, with everything open; then move your sign-in address to an inbox you have. A recovery address is a second inbox you confirm with a code: from \u201cCannot open your email any more?\u201d on the login page, type the address you log in with, and a link goes there that lets you in at once.",
          "Through the recovery address, your products, pages, buyers, numbers and drafts are open straight away. Payments, your plan, your team, exports, settings, sending to your list, imports and your sign-in address open 7 days later, and the inbox you log in with is told at once. That week is only so that somebody who got into an old recovery inbox cannot quietly take your store: logging in with your sign-in email, a passkey or your two-step code before then logs them out. After the week, the recovery address opens everything, so you can move your sign-in address.",
          "With neither a passkey nor a recovery address, the account cannot be opened without that inbox, and nobody here can open it for you. That is what keeps it yours: get the inbox back through your email provider's own recovery.",
        ],
      },
      {
        q: "Can I keep my own details about people, and track deals?",
        a: [
          "Yes, on every plan, under Deals and fields in your studio. A field is something you keep about each person: up to 10, each text, a number, a date or one of a few choices you name. You fill it in on the person's page under Buyers, and your list's file has a column for each. Taking a field away takes every answer to it.",
          "A deal is somebody you are talking to about a sale that does not happen at your checkout, such as a coaching package or a project, with what it is worth in your store's currency. It sits on a stage you name, each open, won or lost, and each stage is added up. Only people on your team who see your orders see any of it, and nothing in it emails anybody by itself.",
          "Deals sit in pipelines: one for coaching and one for brand partnerships, say, each with its own stages in the order you choose. You rename, reorder, add and remove stages; removing a stage that still holds deals asks you where they go, and removing a pipeline moves its deals to a stage of another, so no deal is deleted that way. A deal moves to any stage of any pipeline. Each pipeline shows what its open, won and lost deals add up to, from the values you recorded: nothing is weighted or forecast. " + pipelineLimitWords(),
          "A workflow can start when a deal enters a stage you choose: when your team makes a deal in that stage, or moves one there. It starts only for the person the deal names by email, only if they are on your list and agreed to hear from you, and once per person, like every workflow. A deal made from a form response, moved by a workflow step, or moved because you removed its stage starts nothing. Each stage starts one workflow at most, which can start others with a step. On a plan with workflows, a deal entering a stage takes one more studio request, for that check.",
        ],
      },
      {
        q: "Will search engines find my store?",
        a: [
          "Yes. Every store has its own map for search engines, at marktmorgen.com/@yourname/sitemap.xml: your front page once it has something on it, every product a visitor can see, each of your pages that is out, your blog and each published post. Nothing you hide, nothing kept back for later, and nothing behind a purchase is in it, and each address is the one the page itself names as its own.",
          "On your own domain the map is at yourdomain.com/sitemap.xml and lists your domain's addresses, and yourdomain.com/robots.txt points search engines to it, so you can add it in Google Search Console for your domain. A product, page or post that is gone shows a page in your store's look and language that leads back to your front page, instead of ours.",
        ],
      },
      {
        q: "Can I use my own domain?",
        a: [
          ...(isDomainsConfigured()
            ? [
                "Yes, on Studio. In your studio, type the domain you own — shop.yourname.com, or yourname.com — and we show you the two records to add where you bought it: one that sends visitors to your store, and a TXT record that proves the domain is yours, so no other store can use it. When they show up, your store opens on that domain, with its certificate handled for you. Your marktmorgen.com address keeps working too, and if Studio ends, visitors to the domain are sent there.",
              ]
            : ["Not yet. It is next on the list, on Studio, and this page will say so on the day it works."]),
        ],
      },
      {
        q: "Can I change my store address later?",
        a: [
          "Yes, whenever you want, from your studio. Nobody has to be asked and there is nothing to wait for.",
          "Your store does not move: same page, same name, same description, same products. Only the address changes.",
          "Every address your store holds keeps working and sends people to the current one, so the link already in your bio, in old posts and in messages other people sent still leads to you. A store holds up to ten addresses at once. When it is full, you can still go back to one you already had; for a new one, let an old one go first. An address you let go stops working at once, leads nowhere for 30 days, and after that anyone may take it, so only let go of one you are sure was never given to anyone.",
        ],
      },
    ],
  },
  {
    id: "delivery",
    emoji: "📦",
    title: "Files and delivery",
    blurb: "What happens in the seconds after someone pays.",
    tone: "bg-pink-brand/10",
    items: [
      {
        q: "How does the buyer get the file?",
        a: [
          "On the screen, immediately after Stripe confirms the payment. There is no waiting for an email to arrive before they can open what they bought.",
          "An email follows anyway: every buyer gets a confirmation from your store's name, with what they bought, what they paid and the way back to it, and replies reach you. It goes out once, even if the buyer closed the page before it loaded. A booked call gets its own confirmation instead, with the time and a calendar file.",
        ],
      },
      {
        q: "Does the download link expire?",
        a: [
          "Yes. The link on the thank-you page works for three days and is tied to that order, so a link that leaks does not turn into a free copy for everyone. A large file is fetched through a signed link that expires in minutes, and where a file is stored is never shown.",
          "A buyer who loses it does not lose what they paid for, a week or a year later. At the bottom of every store page there is \u201cBought something here? Get it again\u201d: they type the address they paid with, and we email that address a link to a page with everything it bought from that store, up to the 40 most recent purchases \u2014 downloads, links and courses \u2014 ready to open again. No account, no password.",
          "The list is read from your own Stripe account each time it opens, so a sale you refunded in full, or a membership that has ended, is not on it, and its download stops working. The page answers the same whether or not the address bought anything, so nobody can use it to find out who your customers are.",
        ],
      },
      {
        q: "A buyer says the file never arrived. What now?",
        a: [
          "Send them to \u201cGet it again\u201d at the bottom of your store page, at your store address followed by /orders \u2014 they type the address they paid with and a link to everything they bought arrives in their inbox. That answers most of these without you doing anything.",
          "If it still does not appear, check the payment in your own Stripe dashboard: a payment that did not complete is the most common cause. If Stripe shows the payment succeeded and the file still did not arrive, email us with the order details and we will look at it with you.",
        ],
      },
    ],
  },
  {
    id: "outreach",
    emoji: "🤝",
    title: "Outreach",
    blurb: "Writing to a business that could sponsor you, sell for you or buy from you.",
    tone: "bg-lilac",
    items: [
      {
        q: "Can my store help me find sponsors and partners?",
        a: [
          `Yes, one business at a time. In your studio, Outreach takes the website of a business you name and what you would offer it. We read that website for an address the business prints there itself, write a short email from what you typed and what its own site says, and open it as a draft in your own Gmail or mail app. You read it, change it and press Send yourself. Nothing is ever sent from our side, and nothing goes out that you did not read.`,
          `It is for three things: a brand that would sponsor you, somebody with an audience who would sell your product for a share, and a company that would buy what you make. It is part of the writing help on ${AI_PLANS_WORDS} and uses the same monthly jobs: ${aiAllowanceWords()}`,
          EXPECTATION,
        ],
      },
      {
        q: "Who can I write to, and what are the rules?",
        a: [
          `Businesses only, never a private person, and only at an address that business published on its own website. An address found anywhere else is not used, and we keep which page printed it and when, so you can show where it came from.`,
          `For businesses in ${OPEN_COUNTRIES_WORDS}, where the law allows a first email to a business. For the United Kingdom and Sweden that means companies, not sole traders; and for the United Kingdom, Ireland, France and Sweden, only an address that names a desk, like partnerships@ or hello@, not a person. Germany, the Netherlands, Spain, Italy and Poland ask for the business's consent first, so nothing is written there, and for every other country we have not read the law yet, so nothing is written there either.`,
          `Every email ends with your name, your store address and your postal address, where the address was found, and a line saying that a reply stops it, with a link the business can press to stop it without you. Those lines are not yours to remove: each is something the law asks for. A page that says it does not want proposals is not written to. You can write at most ${PITCHES_PER_DAY} a day, and to the same business once in ${REPITCH_DAYS} days. When a business asks you to stop, one press in your studio records it, or the business presses its own link, and your store can never write to it again.`,
          "This is not legal advice, and the email is yours: you are its sender. If you are unsure whether you may write to somebody, do not.",
        ],
      },
      {
        q: "I run a website and saw MarktmorgenOutreach in my logs. What is it?",
        a: [
          `It is the reader behind Outreach. A creator typed your website's address because they want to propose something to your business, and we read up to ${MAX_PAGES_READ} pages of it, once, to see what you do and which address you publish for being written to. It follows your robots.txt: a path you disallow is not read, and “User-agent: MarktmorgenOutreach” with “Disallow: /” keeps it out entirely.`,
          "It does not crawl, does not come back on a schedule and does not build a list: what it read is kept only with the one email that creator wrote. No email is sent by us; the creator sends it from their own mailbox. If one reached you and you would rather it had not, press the link at the end of it: one button closes your business to that store, and a second closes it to every store here, for good. Or reply to the creator and say so: their studio has a button for exactly that.",
        ],
      },
    ],
  },
  {
    id: "privacy",
    emoji: "🔒",
    title: "Your data",
    blurb: "What we keep, and how to have it removed.",
    tone: "bg-amber-brand/12",
    items: [
      // Moved from the home page (VS1, 31/10/2026), unchanged.
      {
        q: LEAVING_QUESTION,
        a: [LEAVING_ANSWER],
      },
      {
        q: "What do you store about me?",
        a: [
          "For your store: the email address that logs you in, the store you build, and the Stripe account ID you connect. If you ask a store for something free: your email address, what you asked for, and whether you checked the box to hear from that store \u2014 kept for that store and nobody else. If you join a store's community or its affiliate program: your email address, the name you chose and what you write or earn there, for that store. If you review something you bought: your stars, your words, your photo if you add one, the name you chose and the order they came from. If you RSVP to a community's live event: that you are coming, for that event. If a store brought you over from another platform: the products it gave you, kept against a one-way hash of your address. If you are on a store's team: your email address, your role and the changes you make there. For the creator research form (“Tell us what you sell”): what you typed in it and, if you checked the box, your email address. The privacy page lists it in full.",
        ],
      },
      {
        q: "How are my store and my buyers protected?",
        a: [
          "Sales are charged on Stripe's own checkout, on your own Stripe account, and what a buyer is charged is worked out on our server from what you saved. You sign in with a link sent to your email that works once and stops working after 15 minutes, or with a passkey if you add one. Under Two-step login in your studio, you can also have the link ask for the six-digit code from an authenticator app such as Google Authenticator, 1Password or Authy, with ten recovery codes, each good once, for when your phone is not at hand; a passkey needs no code. Turning it on asks for a recovery address, a second inbox you confirm with a code: lose your phone, your codes and your passkeys, and the login page emails a link there that turns two-step login off and logs you in at once. Lose that inbox too, and you still get in at once with the emailed link alone, with payments, your plan, your team, exports, settings, sending to your list and your sign-in address locked for 7 days; then two-step login turns off. A login with a code or a passkey, or Cancel in your studio, ends that and logs out whoever got in that way. Each sign-in starts a fresh session, and \u201cLog out of all devices\u201d at the bottom of your studio closes every session at once. When your Stripe account, your domain or your webhooks change, we email you saying what changed. What each role on your team may do is checked on our server for every request, the API key of an email platform you connect is stored encrypted, and reviews can be written only for orders your Stripe account says were paid.",
          "Store pages, on our address and on your own domain, the studio and signing in carry a strict Content-Security-Policy with a new nonce on every response, so text somebody typed cannot run as a script. Your ad pixels load only after consent where the law asks for it. Every request that changes something must come from this site, our cookies are HttpOnly and SameSite, and pages carry HSTS, nosniff, a referrer policy, Cross-Origin-Opener-Policy and a Permissions-Policy, and cannot be framed by other sites. Links we email point only at marktmorgen.com or your store's own domain.",
          "Files are handed over as downloads that cannot run anything in the browser. A full refund on your Stripe account closes what it paid for by itself: the download at once, the course within 10 minutes, the community within 5, and the license key within about 5; a partial refund keeps access. Checkouts are limited to 20 per 10 minutes per connection per store, and bookings and forms that send an email have limits too, so a script cannot sit on your limited stock or call times. Webhooks are signed, and calendar and webhook addresses cannot reach private networks.",
          "What it does not do: two-step login is off until you turn it on, so until then keep your email inbox safe; and with it on, losing your phone, your recovery codes and every passkey is solved at once by a link to your recovery address; lose that inbox too and you get in at once, with payments, settings, exports and sending locked for 7 days. On a payment plan only a refund in full of the first payment is detected, and a refunded membership closes when its subscription is canceled. If our database cannot be reached, the limits let requests through rather than stop a buyer from paying.",
        ],
      },
      {
        q: "Can I have it deleted?",
        a: [
          "Yes, and you do it yourself. If you bought from a store, joined its list or asked it for something free, open marktmorgen.com/privacy/delete, or the link at the foot of that store's page, and type your address. If the store knows it, we email you a link that works for an hour; the page it opens says what is deleted and what is kept, and its button deletes you from that store, or from every store you bought from or signed up with. The store's owner is told it was done. You do not have to give a reason, and nobody has to approve it.",
          "What stays: a one-way fingerprint of your address, so that store never emails you again; your payments, which are on the creator's own Stripe account as their sales records; and the few order records a refund or a delivery still needs. Posts and comments you wrote in a community stay, without your name; delete them there first if you want them gone. The privacy page lists each one.",
          "For your own account as a creator, email us from the address you sign in with and we remove what we hold about you.",
        ],
      },
      {
        q: "Someone asked me to delete their data. What do I do?",
        a: [
          "Open their page under Buyers in your studio (find them by the address they paid with or joined your list with), press Delete this person at the bottom, read what goes and what stays, type DELETE and press Delete this person again. It is done at once: their place on your list, your fields, notes and deals about them, their form answers, inbox conversations, waitlist places, workflow history and any email still waiting for them, their course progress, work, comments and certificates, their community record, points and messages, their podcast feeds and Discord roles, and the links your store emailed them.",
          "Two things stay when you delete someone, and go when they delete themselves: reviews they wrote, because a store may not take a review down by deleting its writer (the FTC's rule on consumer reviews), and what an import from your old platform gave them, which is how they keep what they bought there.",
          "Your store will not email them again: a one-way fingerprint of the address stays, so no import or API call puts them back, and only they can lift it by joining your list again themselves. Their payments stay on your own Stripe account, and the few order records a refund or a delivery still needs stay with only what they need. If you also keep them in a connected email platform or your own files, delete them there too.",
          "Only you and your Admins can do it; Editors and Support cannot. Each deletion takes " + `${ERASE_STUDIO_UNITS} of your plan's studio requests, and more for a store with many products, courses, deals, conversations or live events (each deletion works out how many before it starts), and is written in your team's activity log, without the address. People can also delete themselves from the link at the foot of your store's page, and you get an email when they do.`,
        ],
      },
      {
        q: "Do you sell or share it?",
        a: [
          "We never sell it, to anyone, for any price.",
          "We share it only where running the product needs it: with Stripe for payments, with our host, database and email provider, with the store it belongs to, and with the services a creator connects. The privacy page lists each one and what it receives.",
        ],
      },
    ],
  },
];

