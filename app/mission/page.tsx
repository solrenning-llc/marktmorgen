import type { Metadata } from "next";
import Link from "next/link";
import { Icon, iconFor, type IconName } from "@/components/icons";
import { RevealOnScroll } from "@/components/home-parts";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { isBillingConfigured } from "@/lib/billing";
import { PUBLISHED_PLAN_PRICES as PLAN_PRICES, PUBLISHED_PRICE_CENTS as PRICE_CENTS, REFUND_DAYS, TRIAL_DAYS, PUBLISHED_YEAR_PRICE_CENTS as YEAR_PRICE_CENTS } from "@/lib/plan";
import { isConnectConfigured } from "@/lib/stripe-connect";
import { ASSISTANT_ON_SALE, PLANS_ON_SALE } from "@/lib/opening";
import { ASSISTANT_MESSAGES_MONTHLY, ASSISTANT_NAME, ASSISTANT_PRICE_CENTS } from "@/lib/store-assistant-rules";
import { isDomainsConfigured } from "@/lib/domains";
import { feeWords } from "@/lib/fee-words";

export const metadata: Metadata = {
  title: "Our mission — Marktmorgen",
  description:
    "Why Marktmorgen exists, what we believe, what we have built so far and what we have not built yet. Written plainly, including the parts that are not finished.",
};

const VALUES = [
  {
    emoji: "🧾",
    title: "Charge fairly, promise only what we can deliver",
    text: feeWords().missionPromise,
    tone: "bg-lilac",
  },
  {
    emoji: "🔑",
    title: "The money is yours from the first second",
    text: "Your buyer pays into your own Stripe account. We never hold your balance, never set your payout schedule, and never stand between you and your customer's card.",
    tone: "bg-cream",
  },
  {
    emoji: "🪟",
    title: "Say the uncomfortable part out loud",
    text: "Where a competitor is better than us, we write it down. Where we have not built something yet, the page says so instead of going quiet.",
    tone: "bg-mint-brand/12",
  },
  {
    emoji: "⚡",
    title: "Fast is a feature, not a bonus",
    text: "Your buyer is on a phone, on mobile data, with three seconds of patience. The store page is measured on a phone, and the scores are published on the site.",
    tone: "bg-sky-brand/12",
  },
  {
    emoji: "🚪",
    title: "Easy to leave",
    text: "Your Stripe account, your customer list and your files stay yours. A product people stay with because leaving is hard is not a product we want to run.",
    tone: "bg-pink-brand/10",
  },
  {
    emoji: "🎨",
    title: "A store worth putting in your bio",
    text: "Color, movement and a page that looks like a person made it. A store that looks like a form is a store people close.",
    tone: "bg-amber-brand/12",
  },
];

const BUILT = [
  "A store page with your photo, up to 100 links and up to 2,000 products shown 24 at a time, in one of four themes, the color you choose and one of five pairings of letters, with search over your products in the studio",
  "A picture on each product, shown on its card in one of three styles, and a page of its own for each product with a long description and its own title and preview card for search engines and shared links",
  "Price options on one product — one week, five weeks, the season — up to 50, compared side by side, each handing over its own file or link, and on a course each opening it",
  `A Stripe checkout that charges the creator's account directly, ${feeWords().onTop} — running in test mode on the demo store`,
  "The file delivered the second the payment clears, with a link that expires",
  "A buyer who loses that link gets everything they bought from the store again, by email, at any time while the store is open — no account, no password",
  "A creator account you log in to with an emailed link, and no password at all",
  "Your own store address, live the moment you take it",
  "A change of address that keeps the link already in your bio working, with up to ten addresses held at once",
  "An editor for your own store: the name, the description, and what you sell with its price",
  "The file you sell, uploaded straight from your browser and kept where only you can reach it",
  "Or a link instead of a file, for what is too big to upload or is not a file at all",
  "Memberships: daily, weekly, monthly or yearly, charged on your own Stripe account, with, if you want them, a free trial of 1 to 90 days and an end after a set number of payments, from 2 to 36",
  "Members who cancel on their own, on Stripe's own page, without having to write to you",
  "Your numbers: visitors, where they came from, checkouts started and sales for 7, 30 or 90 days or all time, with UTM tags and CSV files of sales, visits and sources — visits counted without cookies, sales read from your own Stripe",
  "Your own Meta, Google, TikTok and Pinterest pixels, told of every page view, checkout, lead and purchase with its amount, and loaded only once a visitor allows it where the law asks for that",
  "Order bumps: up to three of your other products, each in its own box the buyer checks at checkout, at your price, never checked for them, and delivered with the first",
  "A one-click upsell: another product offered on the thank-you page, charged in one press to the card just used, only in the browser that paid, within the hour and once",
  "Funnels: up to five offers after paying, one at a time, each with its own path for yes and for no, charged in one click to the same card",
  "Payment plans: two to twelve weekly or monthly payments on your own Stripe account, the product delivered after the first, and the plan given its end so no buyer is charged after the last payment",
  "Sales tax and VAT worked out by Stripe Tax on your own account and added at checkout, switched on once Stripe says your tax setup is complete",
  "Limited quantities: the page shows how many are left, counted from real payments, and a unit someone is paying for is held so the last one is never sold twice",
  "Courses: modules of lessons with video, text, downloads and a link, free preview lessons, modules that open a set number of days after each student joins, with an email to the student the day each one opens, and each student's progress in your studio — students open them with their email, no password",
  "Paid calls with a calendar: your weekly hours in your time zone, the free times shown to each buyer in theirs, the time held while they pay, and an email about each booking to the buyer and to you",
  "Group calls of up to 50 people, and live sessions on dates you set with up to 500 seats each, held on the meeting service whose link you give or in a video room made for them",
  "A private Jitsi Meet video room made for each booking if you choose it, in every email, reminder and calendar file, and a buyer's booked calls on their list of purchases",
  "Google Meet links made for each booking and live event once you connect your own Google Calendar, with a call's buyers on its event's guest list",
  "Reminders a day and an hour before each booking, when it leaves time for them, and buyers who move their own booking up to twice",
  "Pay what you want: your price as the minimum, a suggested price in the box, and Stripe refusing anything under it",
  "Up to three questions at checkout — a short answer, a number or a list — with the answers in your list of sales",
  "A confirmation email to every buyer, from your store's name, with the way back to what they bought",
  "One reminder after a checkout left unpaid, only to buyers who agreed on Stripe's page, for Stripe accounts in the United States",
  "Links to everywhere else you are — the channel, the podcast, the booking page — with no price and no checkout on them",
  "Discount codes a buyer types at checkout, made as coupons on your own Stripe account",
  "Free products given for an email address, each address confirmed by its owner, and the list downloadable from your studio at any time",
  "Email to your list, on Studio: one-off emails now or at a time you choose, and sequences that send themselves after someone joins or buys — only to people who agreed, with a one-click unsubscribe in every one",
  "Every store installs to the home screen on iPhone and Android as an app of its own, with its name, its icon and its color",
  "A community for your buyers, open only to the buyers of the products you choose: up to 20 spaces, each for the whole community or for the buyers of some products, posts with a picture that can be edited, polls, comments, likes, @mentions, pinned posts, an opt-in member directory, reports and moderation — with announcements emailed to members who asked, on Studio",
  "A live room in the community, with a cooldown, links on or off and a creator-only mode, and private messages to you, and between members if you allow it, with first messages that wait to be accepted if you choose",
  "Notifications when somebody mentions a member, comments on their post or answers their comment: in the community, and on their computer or phone when they allow it (on iPhone, once the page is on the home screen, as Apple requires)",
  "One search box across posts and comments, course lessons, events, the member directory, the room and a member's own messages, each result shown only to somebody who may open it",
  "An offer made once to a member who presses Cancel on a membership — a discount you choose, on Stripe's own cancellation page, declined in one press",
  "An email to a member whose renewal failed, once, with a link that pays it and makes the card that worked the one used next time",
  "An API with up to five keys you make and revoke in the studio: it reads your list, members, a course's students, your affiliates and your bookings, and a key made to write adds people who agreed to your list, changes their labels, and gives or takes back products",
  "Memberships whose files, course and community close when the membership ends",
  "An affiliate program: commission of 1% to 90%, a window of 1 to 90 days, a link and a page for each affiliate, and a record of who is owed what — paid out by you",
  "Calendar sync: busy times in up to three Google, Outlook or iCloud calendars hide call times, and a private feed puts your bookings in your calendar",
  "Webhooks: up to five addresses told about sales, members, leads, bookings and refunds, signed, for Zapier, Make or your own server",
  "Course quizzes of up to 20 questions, and certificates of completion with a page anyone can open to check them",
  "Discord access: your own server opened by what people buy, with roles given on joining and taken back by themselves when access ends",
  "Members moved from another platform, up to 20,000 a file: each is emailed a link of their own to keep their membership here, first charged on the day it would have renewed there, with one reminder before that day",
  "Lessons made from videos, up to 50 at once: each becomes a lesson named after its file, in the order of the file names, and a video that does not upload leaves no empty lesson behind",
  "Course assignments: students hand in writing or a file, and you approve it or ask for another try, with a reply AI can draft and the student gets by email",
  "License keys: one unique key per sale, uploaded or made here, with a public check your software can call",
  "PDF stamping: the buyer's email, the date and the order on every page of the PDF they download",
  "A full refund that closes what it paid for by itself: the download at once, the course within 10 minutes, the community within 5, and the license key revoked within about 5",
  "Security you can check: single-use sign-in links that expire in 15 minutes, “Log out of all devices,” an email when your Stripe account, domain or webhooks change, a strict Content-Security-Policy on store pages and the studio, forged requests refused, and limits on checkouts, bookings and emails",
  "Sales pages of up to 30 blocks for any product, with video from YouTube, Vimeo or Loom, their own search title and description and a share picture drawn for them, and landing pages that give something free for an email and show a paid product next",
  "Funnels of up to 20 pages walked in order from one address — your own pages and your products' pages — counted step by step, with “No thanks, continue” on every paid step",
  "Reviews only buyers can write, checked on your own Stripe account, that you can answer and hide but never edit, with hidden ones still counted in the average and one email that asks for them on Studio",
  "15 currencies for a store, and the ways to pay you switch on in your own Stripe account — Apple Pay, Google Pay, Link, Klarna, Afterpay, Affirm, iDEAL, Bancontact and more",
  "Mailchimp, Kit, beehiiv and MailerLite built in: the people who agree to hear from you, sent to your own list there",
  "Up to five stores in one account, each with its own plan, and a team of up to five per store as Admin, Editor or Support, with an activity log",
  "Optional passkeys, an email when your account signs in from a new browser, email drafts, and purchase emails sent again from your studio",
  "Notifications of sales, bookings, reports, affiliate applications and live events about to start, from the studio installed on your phone",
  "Live events in the community: up to 50 coming up, RSVPs with a cap of 1 to 5,000 if you want one, the way in on the event's page from 15 minutes before, only to members who may come, in a private Jitsi Meet room shown on the page or at your own link, reminders a day and an hour before, emails when one moves or is canceled, and replays from YouTube, Vimeo or Loom",
  "Bundles: 2 to 20 of your one-off products at one price, each delivered as if bought on its own, with what the buyer keeps fixed when they pay",
  "Drafts: any product unpublished and kept in the studio until you publish it again",
  "Outreach: a short email to a business you name, at the address it printed on its own website, held to the law of its country, written for you and opened as a draft in your own mailbox for you to send",
  "Moving from another platform, from a spreadsheet: your list, up to 50,000 a file, only people you confirm agreed; your products, up to 500 a file, as drafts; and your past buyers, up to 20,000 a file, who keep what they bought and come into your community, with one email to them if you choose",
  "A live demo store anyone can buy from with a test card, before signing up",
];

/**
 * One line that moves between the two lists depending on this deployment.
 *
 * The code is written either way; what changes is whether this site can
 * actually reach Stripe. The page says which of those is true here rather
 * than claiming a button that would do nothing.
 */
const STRIPE_LINE =
  "Connecting your own Stripe account from the studio, in any of 42 countries, so charges are made on it and not on ours";

const CHECKOUT_LINE =
  "Selling: the buyer pays on your account and the file is handed over the moment Stripe confirms it";

const ORDERS_LINE =
  "A list of what you have sold, read from your own Stripe account, with the buyer's email address so you can answer them";

/**
 * The line about our own income, which belongs to whether billing can reach
 * Stripe from this deployment rather than to whether we have written the code.
 */
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const BILLING_LINE = `The subscription that pays us: ${usd(PRICE_CENTS)} a month or ${usd(YEAR_PRICE_CENTS)} a year on Store, or ${usd(PLAN_PRICES.pro.month)} and ${usd(PLAN_PRICES.pro.year)} on Studio, or ${usd(PLAN_PRICES.scale.month)} and ${usd(PLAN_PRICES.scale.year)} on Scale for a bigger list, with a ${TRIAL_DAYS}-day trial only for an eligible first store, an email a week before the first charge, canceled in two clicks from your studio`;

/**
 * The same line while plans are not on sale (lib/opening.ts): the code is
 * there and nobody can press it, which this page counts as not built.
 */
const BILLING_CLOSED_LINE = `Starting a paid plan: the subscription is written, at ${usd(PRICE_CENTS)} a month or ${usd(YEAR_PRICE_CENTS)} a year on Store, ${usd(PLAN_PRICES.pro.month)} or ${usd(PLAN_PRICES.pro.year)} on Studio, and ${usd(PLAN_PRICES.scale.month)} or ${usd(PLAN_PRICES.scale.year)} on Scale for a bigger list, and it is not on sale until Marktmorgen opens`;

/**
 * The Store assistant add-on (lib/store-assistant-rules.ts): written and
 * tested, and nobody can buy it until it is on sale (lib/opening.ts), which
 * this page counts as not built. Its line of "What shipped" is written the
 * day it can be bought.
 */
const ASSISTANT_LINE = `The ${ASSISTANT_NAME}, an add-on at $${ASSISTANT_PRICE_CENTS / 100} a month for one store: an AI chat on every page of the store that answers only from what you published, labels every reply as AI and hands what it cannot answer to your inbox, ${ASSISTANT_MESSAGES_MONTHLY.toLocaleString("en-US")} replies a month`;
const ASSISTANT_CLOSED_LINE = `The ${ASSISTANT_NAME}: an AI chat on every page of a store that answers only from what the creator published, labels every reply as AI and hands what it cannot answer to the inbox, ${ASSISTANT_MESSAGES_MONTHLY.toLocaleString("en-US")} replies a month at $${ASSISTANT_PRICE_CENTS / 100} a month for one store; the code is written, and it is not on sale until Marktmorgen opens`;

/** The store on its own domain: built, and live where this deployment can add domains. */
const DOMAIN_LINE =
  "Your store on your own domain, on Studio: type it in the studio, add the one record we show you, and the certificate is handled for you";

const NOT_BUILT = [
  "PayPal at checkout: Stripe offers it only to accounts in the EU (except Hungary), the UK, Switzerland, Norway and Liechtenstein, and does not support it for the direct charges every sale here is made with",
  "Writing every booking into your calendar as an event: only calls set to Google Meet are written there, other bookings come as a feed you subscribe to, and calendars are read for busy times",
  "Paying affiliates with no PayPal account of your own: they are paid from your PayPal, in one press or on your payday, never from money we hold",
  "A thank-you page of your own: after paying, the store's own page hands over what was bought, with your note and, in a funnel, a button to the next step",
  "Automatic replies on Instagram",
  "An API that makes or changes products, prices or pages: it adds to your list, labels people and gives products, and webhooks send",
  "More than 2,000 products in one store",
  "Zoom links made for each booking or live event, for every store: the code is written, and it waits for Zoom to approve our Marketplace app",
  "An app in the App Store or Google Play",
  "Checkbox questions at checkout: short answers, numbers, a choice from a list and a phone number can be asked, but not a checkbox",
  "Streaming or recording live sessions and events here, rather than on the service whose link you give or on Jitsi Meet",
  "Importing a course's text, downloads and pictures from another platform (its videos become lessons, up to 50 at once), or giving past buyers a call",
];

/* What shipped, and when: read from the site's own history, not written for effect. */
const RELEASES: { date: string; items: string }[] = [
  { date: "September 17, 2026", items: "The live demo store: a Stripe checkout charged on a creator's own account, and the file handed over the moment Stripe confirms it." },
  { date: "September 18, 2026", items: "Logging in with a link sent to your email, and no password anywhere." },
  { date: "September 19, 2026", items: "Creator stores: an @address of your own, products and prices, the file each one delivers, and your own Stripe account connected." },
  { date: "September 20, 2026", items: "Memberships, discount codes, and several prices on one product in every store." },
  { date: "September 21, 2026", items: "Free products for an email address, members who cancel on their own, and canceling the Marktmorgen plan from the studio." },
  { date: "September 22, 2026", items: "Paid calls, courses, numbers and ad pixels, offers before and after paying, payment plans, sales tax, yearly plans, email to your list and your own domain on Studio, and buyers getting any purchase again by email." },
  { date: "September 26, 2026", items: "Up to 200 products with pictures and pages of their own, questions at checkout, pay what you want, free trials and fixed-length memberships, group calls and live sessions with reminders and self-serve moves, a confirmation email for every purchase, every store installable as its own app, 43 Stripe countries, and one reminder after an unpaid checkout. Then a community for your buyers, funnels of offers after paying, an affiliate program, calendar sync, webhooks, course quizzes and certificates, license keys, stamped PDFs, longer windows and exports for your numbers, and memberships whose access ends when they do." },
  { date: "September 27, 2026", items: "Up to 2,000 products, a private video room for each booking, up to five stores in one account and a team with roles for each, passkeys, 15 currencies and more ways to pay, sales and landing pages, reviews only buyers can write, Mailchimp, Kit, beehiiv and MailerLite built in, and notifications on your phone. Then live events in the community, bundles, drafts, moving your list, products and past buyers from another platform, and Google Meet links made on your own Google Calendar." },
  { date: "October 5, 2026", items: "The demo store became an ordinary store, made and drawn by the same code as every creator's, and product pictures reach a phone at the phone's own size. Then Outreach: one short email to a business that could sponsor you, sell for you or buy from you, written from what you say and opened as a draft in your own mailbox." },
  { date: "October 18, 2026", items: "A store whose plan ends closes after 30 days and three emails, with its whole store downloadable as one file first: its files, the renewals of what it sold and every record it kept go, and only a compressed record of its sales is kept for tax, for seven years." },
];

/* Facts a creator can check before trusting us with a store. */
const TRUST: { icon: IconName; title: string; body: string; href: string; link: string }[] = [
  { icon: "user", title: "Who builds it", body: "An independent product studio. The person who writes the code is the person who answers the email.", href: "/proof/questions", link: "The awkward questions" },
  { icon: "mail", title: "How to reach us", body: "By email. A person reads every message and answers in writing, in English.", href: "mailto:support@marktmorgen.com", link: "Write to us" },
  { icon: "bank", title: "Where the money is", body: "Every sale is processed by Stripe on the creator's own account. We never hold a balance of yours.", href: "/platform/your-stripe", link: "How the money moves" },
  { icon: "shield", title: "What we keep about you", body: "What the service needs to run, listed in plain words, with who processes it for us. Nothing is sold.", href: "/privacy", link: "Privacy policy" },
  { icon: "receipt", title: "The rules, in writing", body: `The terms of the service, a full refund of your first payment to us, and of every plan payment for the same store made since, if you ask within ${REFUND_DAYS} days of the first, and the months of a yearly plan you have not started refunded at any time, less Stripe's card fee.`, href: "/terms", link: "Terms and refunds" },
  { icon: "door", title: "Leaving is free", body: "Your Stripe account, customers and payouts were always yours, and your list downloads as a file at any time.", href: "/proof/promises", link: "What we never do" },
];

export default function MissionPage() {
  // Whether this deployment can actually reach Stripe decides which list the
  // line belongs in. A feature nobody here can press is not a built feature.
  const ready = isConnectConfigured();
  const billingReached = isBillingConfigured();
  const billing = billingReached && PLANS_ON_SALE;
  const domains = isDomainsConfigured();
  const built = [
    ...BUILT,
    ...(domains ? [DOMAIN_LINE] : []),
    ...(ready ? [STRIPE_LINE, CHECKOUT_LINE, ORDERS_LINE] : []),
    ...(billing ? [BILLING_LINE] : []),
    ...(billing && ASSISTANT_ON_SALE ? [ASSISTANT_LINE] : []),
  ];
  const notBuilt = [
    ...(domains ? [] : ["Your own domain for your store"]),
    ...(ready ? [] : [STRIPE_LINE, CHECKOUT_LINE, ORDERS_LINE]),
    ...(billing ? [] : [billingReached ? BILLING_CLOSED_LINE : BILLING_LINE]),
    ...(billing && ASSISTANT_ON_SALE ? [] : [ASSISTANT_CLOSED_LINE]),
    ...NOT_BUILT,
  ];
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <RevealOnScroll />
      <SiteNav />

      <main id="content" className="flex-1">
        <section className="surface-daybreak on-dark overflow-hidden">
          <div className="awning" aria-hidden="true" />
          <div className="container-page grid items-center gap-12 py-16 sm:py-20 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
            <div>
              <p className="eyebrow">Our mission</p>
              <h1 className="t-h1 balance mt-5 text-white">
                Nobody should need a platform&apos;s permission{" "}
                <span className="serif font-normal text-[#cfc4ff]">to be paid for their work</span>
              </h1>
              <p className="t-lead mt-6 max-w-2xl text-white/80">
                What you pay us, and what we take from a sale, should both be clear before you choose. That is the whole idea, and
                everything we build is judged against it.
              </p>
            </div>
            {/*
              The state of the product, in three figures, at the top of the
              page that claims to be honest about it. A mission statement
              beside a count of what is still missing is a harder thing to
              write than a mission statement on its own, which is the point.
            */}
            <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              {[
                { value: String(built.length), label: "features built and working", tone: "mint" },
                { value: String(notBuilt.length), label: "named, and not built yet", tone: "plain" },
                { value: "3", label: "plans with their fees stated", tone: "plain" },
              ].map((s) => (
                <div
                  key={s.label}
                  className="flex items-baseline gap-4 rounded-[var(--r-lg)] border border-white/14 bg-white/[0.05] px-5 py-4 backdrop-blur-sm"
                >
                  <dd
                    className={`figure-big ${s.tone === "mint" ? "text-[#6fe3ba]" : "text-white"}`}
                  >
                    {s.value}
                  </dd>
                  <dt className="text-[0.9375rem] leading-snug text-white/80">{s.label}</dt>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="container-narrow py-16 sm:py-24">
          <h2 className="t-h2">Why Marktmorgen exists</h2>
          <div className="prose-nb mt-6">
            <p>
              A creator with an audience and a file to sell has never had more tools and never had less control. The
              common arrangement is this: the buyer pays the platform, the platform keeps a percentage, the platform holds
              the balance, and the platform decides when the money moves and under what rules.
            </p>
            <p>
              Each of those is a small thing on one sale. Together they decide whether the work you did is a business you
              own or an account somebody else can close.
            </p>
            <p>
              Marktmorgen is built the other way around. The buyer&apos;s card is charged on your Stripe account. The receipt
              carries your name. The payout schedule is yours. {feeWords().missionMoney}
            </p>
          </div>

          <figure className="mt-12 rounded-[var(--r-lg)] border border-line bg-white p-7 sm:p-8">
            <p className="font-semibold text-ink">A note on how we write</p>
            <blockquote className="mt-3 text-ink-soft">
              We do not publish invented reviews, invented customers or screenshots of money we never made. If a page shows
              a person, the photograph is licensed stock, and the page says so. When we compare ourselves with anyone, we name the
              page on their own site that each line comes from, and the date we read it, so you can check it. It is a slower way to sell, and it is the only one we are willing to use.
            </blockquote>
            <figcaption className="mt-5 border-t border-line pt-5 text-sm text-ink-mute">
              The Marktmorgen team
            </figcaption>
          </figure>
        </section>

        <section className="surface-sand section">
          <div className="container-page">
            <div className="max-w-2xl">
              <p className="eyebrow">What we hold ourselves to</p>
              <h2 className="t-h2 mt-4">Six rules you can check</h2>
              <p className="mt-4 text-ink-soft">Every one of them is something you can verify on the site or in the product.</p>
            </div>
            <ol className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {VALUES.map((value, i) => (
                <li key={value.title} className="card reveal p-7">
                  <div className="flex items-center justify-between">
                    <span className="icon-tile">
                      <Icon name={iconFor(value.emoji)} size={22} />
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-ink-mute">{String(i + 1).padStart(2, "0")}</span>
                  </div>
                  <h3 className="mt-6 text-[1.0625rem] font-semibold leading-snug text-ink">{value.title}</h3>
                  <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-soft">{value.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="section">
          <div className="container-page">
            <div className="max-w-2xl">
              <p className="eyebrow">Where the product is today</p>
              <h2 className="t-h2 mt-4">Both columns, in full</h2>
              <p className="mt-4 text-ink-soft">
                What works today and what does not exist yet, so nobody signs up expecting the second list.
              </p>
            </div>

            <div className="mt-12 grid gap-6 lg:grid-cols-2">
              {/*
                Thirty true lines in one column is a wall, and a wall gets
                skipped — which loses the argument the list was written to
                win. The first ten carry it; the rest are one press away, and
                the press says how many are behind it, so nothing is hidden,
                only folded.
              */}
              <div className="card reveal p-7 sm:p-8">
                <span className="tag tag-live">{`Built and working · ${built.length}`}</span>
                <ul className="mt-6 space-y-3">
                  {built.slice(0, 10).map((item) => (
                    <li key={item} className="flex gap-3 text-[0.9375rem] text-ink-soft">
                      <Icon name="check" size={18} strokeWidth={2.2} className="mt-0.5 shrink-0 text-mint-brand" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                {built.length > 10 ? (
                  <details className="group/all mt-4 border-t border-line pt-4">
                    <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-[8px] font-semibold text-violet-deep [&::-webkit-details-marker]:hidden">
                      <Icon
                        name="plus"
                        size={16}
                        className="transition-transform duration-200 group-open/all:rotate-45"
                      />
                      <span className="group-open/all:hidden">{`The other ${built.length - 10}`}</span>
                      <span className="hidden group-open/all:inline">Show fewer</span>
                    </summary>
                    <ul className="mt-4 space-y-3">
                      {built.slice(10).map((item) => (
                        <li key={item} className="flex gap-3 text-[0.9375rem] text-ink-soft">
                          <Icon name="check" size={18} strokeWidth={2.2} className="mt-0.5 shrink-0 text-mint-brand" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <Link href="/demo" className="btn btn-primary mt-8">
                  Try it in the demo store
                </Link>
              </div>

              <div className="card-flat reveal self-start p-7 sm:p-8">
                <span className="tag tag-next">{`Not built yet · ${notBuilt.length}`}</span>
                <ul className="mt-6 space-y-3">
                  {notBuilt.map((item) => (
                    <li key={item} className="flex gap-3 text-[0.9375rem] text-ink-soft">
                      <Icon name="minus" size={18} className="mt-0.5 shrink-0 text-ink-mute" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-7 border-t border-line pt-5 text-sm text-ink-soft">
                  Other platforms have many of these today. If you need them now, they are the better choice now, and{" "}
                  <Link href="/proof/compare" className="link">
                    our comparison page
                  </Link>{" "}
                  says so in writing.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="surface-sand section" aria-labelledby="trust-title">
          <div className="container-page">
            <div className="max-w-2xl">
              <p className="eyebrow">Before you trust us with a store</p>
              <h2 id="trust-title" className="t-h2 mt-4">Things you can check</h2>
              <p className="mt-4 text-ink-soft">No badges, no borrowed logos. Each of these leads to the page that proves it.</p>
            </div>
            <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {TRUST.map((t) => (
                <li key={t.title} className="card reveal flex flex-col p-7">
                  <span className="icon-tile">
                    <Icon name={t.icon} size={22} />
                  </span>
                  <h3 className="mt-6 text-[1.0625rem] font-semibold text-ink">{t.title}</h3>
                  <p className="mt-2 flex-1 text-[0.9375rem] leading-relaxed text-ink-soft">{t.body}</p>
                  {t.href.startsWith("mailto:") ? (
                    <a href={t.href} className="link-arrow mt-5 text-[0.9375rem]">
                      {t.link}
                      <Icon name="arrow-right" size={16} className="arrow" />
                    </a>
                  ) : (
                    <Link href={t.href} className="link-arrow mt-5 text-[0.9375rem]">
                      {t.link}
                      <Icon name="arrow-right" size={16} className="arrow" />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="section" aria-labelledby="history-title">
          <div className="container-narrow">
            <p className="eyebrow">Built in public</p>
            <h2 id="history-title" className="t-h2 mt-4">What shipped, and when</h2>
            <p className="mt-4 text-ink-soft">Each line went live on the day it says, and is listed as built above.</p>
            <ol className="relative mt-10 space-y-8 border-l border-line pl-8">
              {RELEASES.map((r) => (
                <li key={r.date} className="reveal relative">
                  <span className="absolute -left-[2.3rem] top-1.5 h-3 w-3 rounded-full border-2 border-paper bg-violet-brand" aria-hidden="true" />
                  <p className="text-sm font-semibold text-violet-deep">{r.date}</p>
                  <p className="mt-1.5 leading-relaxed text-ink-soft">{r.items}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="surface-signature on-dark overflow-hidden">
          <div className="container-narrow py-20 text-center sm:py-24">
            <h2 className="t-h2 balance text-white">Help decide what gets built next</h2>
            <p className="mx-auto mt-5 max-w-xl text-white/80">
              Tell us what you sell and what breaks today. It takes two minutes, there is nothing to buy, and it is what the
              roadmap is made of.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
              <Link href="/creators" className="btn btn-light btn-lg">
                Answer eight questions
              </Link>
              <Link href="/signin" className="link-arrow on-dark">
                Start your store
                <Icon name="arrow-right" size={18} className="arrow" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
