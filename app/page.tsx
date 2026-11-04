/* eslint-disable @next/next/no-html-link-for-pages -- Static home navigation intentionally uses native anchors to avoid client link hydration; hrefs and browser/keyboard regressions remain checked. */
import type { Metadata } from "next";
import { Suspense } from "react";
import "./home.css";
import { SITE_OG_IMAGE } from "@/lib/site-og";
import { SiteFooter } from "@/components/site-footer";
import { MORNING_FONTS } from "@/components/morning-fonts";
import { MorningHeader } from "@/components/morning-header";
import { Faq } from "@/components/home-static";
import { ClaimForm, HeroClaim } from "@/components/home-claim";
import { ExampleMembership, ExampleTimes } from "@/components/home-examples";
import { HomeData } from "@/components/structured-data";
import { homeQuestions } from "@/lib/home-faq";
import { PLAN_TITLES, PUBLISHED_PRICE_CENTS as PRICE_CENTS, TRIAL_DAYS } from "@/lib/plan";
import { PLANS_ON_SALE } from "@/lib/opening";
import { feeWords } from "@/lib/fee-words";
import { INVITE_PROGRAM_OPEN, INVITE_SHARE_PERCENT } from "@/lib/creator-invite-rules";
import { DEMO_CALL, DEMO_PRODUCT } from "@/lib/demo-seed";

/*
 * The home page, VS1 (queue item 571, the owner's approved mockup of
 * 30 October 2026, 19:32): Stan's order of sections, made simpler and more
 * colorful. One action in words, "Claim it", at the top and at the end.
 *
 * Every sentence is true of the code today (rule VR): prices and the trial
 * come from lib/plan.ts, the fee line from lib/fee-words.ts, the closed-sale
 * line from lib/opening.ts, and the phone shows the real demo store's
 * products (lib/demo-seed.ts). Examples are labeled as examples on screen.
 * What does not work today is not drawn: the invite band appears only while
 * INVITE_PROGRAM_OPEN is true, and the mockup's studio "Today" screen is left
 * out until the studio has one (queue item 484).
 */

const HOME_TITLE = "Marktmorgen — your link in bio, now a store";
const HOME_DESCRIPTION =
  "One store for creators who sell courses, downloads, memberships and paid calls from their link in bio. Buyers pay into your own Stripe account, and " + feeWords().takes + " Stripe's processing fee applies.";

export const metadata: Metadata = {
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  // Zoom's Marketplace checks that this domain is ours by reading this tag
  // from the home page, for the app that makes Zoom meetings (lib/meet-providers.ts).
  other: { "zoom-domain-verification": "ZOOM_verify_6f2160153a5d41208ff71fe77f6b7c01" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Marktmorgen",
    locale: "en_US",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: [SITE_OG_IMAGE],
  },
  twitter: { card: "summary_large_image", title: HOME_TITLE, description: HOME_DESCRIPTION, images: [SITE_OG_IMAGE.url] },
};

const PRICE = PRICE_CENTS / 100;

/* The trial line, true in both states: no plan can be started while
   PLANS_ON_SALE is false, so the free days are said to come with the plans. */
const OFFER_LINE = PLANS_ON_SALE
  ? `Free to set up. ${TRIAL_DAYS} days free, then $${PRICE} a month.`
  : `Free to set up. When plans open: ${TRIAL_DAYS} days free, then $${PRICE} a month.`;

/* The demo store's own products, as the studio seeds them. */
const PHONE_ITEMS = [
  { title: DEMO_PRODUCT.title, kind: "Download", price: `$${DEMO_PRODUCT.price}` },
  { title: DEMO_CALL.title, kind: `${DEMO_CALL.setup.minutes}-minute call`, price: `$${DEMO_CALL.price}` },
];

/* Generic kinds of tool a creator would otherwise put together; each is part
   of the Store plan (components/home-parts.tsx, INCLUDED). */
const APPS = ["Link-in-bio page", "Sales page builder", "Course platform", "Booking app", "File delivery tool"];

const CHECK = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
);

function Invite() {
  // Shown only while new invitations are open (lib/creator-invite-rules.ts).
  const share = INVITE_SHARE_PERCENT === 50 ? "half" : `${INVITE_SHARE_PERCENT}%`;
  const needed = Math.ceil(100 / INVITE_SHARE_PERCENT);
  return (
    <section aria-labelledby="hm-invite-title" className="hm-band">
      <div className="hm-card-band hm-band-rose">
        <div className="hm-grow">
          <h2 id="hm-invite-title" className="hm-h2">{`Bring a creator. Get ${share} of what they pay.`}</h2>
          <p className="hm-lead">As credit on your own plan, for as long as they pay. They get their first month back after their first payment.</p>
        </div>
        <div className="hm-invite-card">
          <p className="hm-example-label">Example</p>
          <p>{`${needed} creators you bring stay on ${PLAN_TITLES.creator}`}</p>
          <p className="hm-invite-figure">Your plan is paid for</p>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const questions = homeQuestions();
  return (
    <div className={`${MORNING_FONTS} hm`}>
      <MorningHeader />

      <main id="content" data-static-reading data-home-page className="hm-body">
        <section aria-labelledby="home-hero-heading" className="hm-hero" data-home-hero>
          <div aria-hidden="true" className="hm-sky-layer">
            <div className="hm-blob hm-sun-glow" />
            <div className="hm-blob hm-sun" />
          </div>
          <div className="hm-wrap hm-rel">
            <HeroClaim offer={OFFER_LINE} items={PHONE_ITEMS} />
          </div>
        </section>

        <section aria-labelledby="hm-sell-title" className="hm-section">
          <div className="hm-wrap">
            <h2 id="hm-sell-title" className="hm-h2">What you can sell.</h2>
            <p className="hm-lead hm-lead-gap">Each one gets its own page, its own checkout and its own delivery.</p>
            <ul className="hm-bento">
              <li className="hm-tile hm-bg-gold">
                <div>
                  <h3 className="hm-h3">Courses</h3>
                  <p>Video lessons in order. Each student&apos;s finished lessons are saved.</p>
                </div>
                <div className="hm-tile-panel">
                  <p className="hm-example-label">Example lessons</p>
                  <ol className="hm-lessons">
                    <li><span aria-hidden="true" className="hm-dot hm-dot-done">{CHECK}</span>Plan your week<span className="hm-sr"> (done)</span></li>
                    <li><span aria-hidden="true" className="hm-dot hm-dot-done">{CHECK}</span>Shop once<span className="hm-sr"> (done)</span></li>
                    <li><span aria-hidden="true" className="hm-dot" />Cook for five days<span className="hm-sr"> (not done yet)</span></li>
                  </ol>
                </div>
              </li>
              <li className="hm-tile hm-bg-sky">
                <div>
                  <h3 className="hm-h3">Calls</h3>
                  <p>Buyers pick a time in their own time zone and pay first. Then they and you each get an email.</p>
                </div>
                <ExampleTimes />
              </li>
              <li className="hm-tile hm-bg-rose">
                <div>
                  <h3 className="hm-h3">Memberships</h3>
                  <p>Monthly or yearly access, with a members&apos; area you can open to them.</p>
                </div>
                <ExampleMembership />
              </li>
              <li className="hm-tile hm-bg-green">
                <div>
                  <h3 className="hm-h3">Downloads</h3>
                  <p>Guides, templates and presets, on the buyer&apos;s screen once the payment clears.</p>
                </div>
                <div className="hm-tile-panel hm-file">
                  <span aria-hidden="true" className="hm-file-art" />
                  <span className="hm-grow">
                    <span className="hm-example-label">Example file</span>
                    <span className="hm-file-name">Meal Planner.pdf</span>
                  </span>
                  <span aria-hidden="true" className="hm-file-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" /></svg>
                  </span>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section aria-labelledby="hm-apps-title" className="hm-band">
          <div className="hm-card-band hm-band-sky">
            <div className="hm-grow">
              <h2 id="hm-apps-title" className="hm-h2">One store instead of five apps.</h2>
              <p className="hm-lead">Your page, sales pages, courses, calls, downloads and email sign-ups in one place, with one login.</p>
            </div>
            <ul aria-label="What it replaces" className="hm-pills">
              {APPS.map((app) => (
                <li key={app} className="hm-pill-old">{app}</li>
              ))}
              <li className="hm-pill-new">All in Marktmorgen</li>
            </ul>
          </div>
        </section>

        {INVITE_PROGRAM_OPEN ? <Invite /> : null}

        <section id="pricing" aria-labelledby="hm-price-title" className="hm-section hm-section-top0 hm-scroll">
          <div className="hm-wrap hm-price">
            <div className="hm-grow">
              <h2 id="hm-price-title" className="hm-h2">One plan to start.</h2>
              <p className="hm-lead" data-home-fee>
                {feeWords().homeFee}
                {PLANS_ON_SALE ? "" : " Not on sale yet."}
              </p>
              <a href="/pricing#plans" className="hm-text-link">{`Compare ${PLAN_TITLES.creator}, ${PLAN_TITLES.pro} and ${PLAN_TITLES.scale}`}</a>
            </div>
            <div className="hm-plan" data-home-plan>
              <h3 className="hm-plan-name">{PLAN_TITLES.creator}</h3>
              <p className="hm-plan-price">{`$${PRICE}`}<span> a month</span></p>
              <p className="hm-plan-trial" data-home-price-line>
                {PLANS_ON_SALE
                  ? `The first ${TRIAL_DAYS} days free on your first store.`
                  : `When plans open, the first ${TRIAL_DAYS} days are free on your first store.`}
              </p>
              <ul className="hm-plan-list">
                <li>{CHECK}Your store and its checkout</li>
                <li>{CHECK}Courses, downloads, memberships and calls</li>
                <li>{CHECK}Money goes to your own Stripe account</li>
              </ul>
              <a href="/signin" className="hm-plan-button">Start free</a>
            </div>
          </div>
        </section>

        <section id="faq" aria-labelledby="hm-faq-title" className="hm-section hm-section-top0 hm-scroll">
          <div className="hm-wrap hm-faq">
            <div>
              <h2 id="hm-faq-title" className="hm-h2">Questions.</h2>
              <p className="hm-lead">Short answers to what creators ask first.</p>
            </div>
            <div className="hm-grow">
              <div className="hm-faq-list">
                <Faq questions={questions} />
              </div>
              <a href="/help" className="hm-text-link">More answers in the help center</a>
            </div>
          </div>
        </section>

        <section aria-labelledby="hm-end-title" className="hm-end">
          <div aria-hidden="true" className="hm-sky-layer">
            <div className="hm-blob hm-sun-end" />
          </div>
          <div className="hm-end-inner">
            <h2 id="hm-end-title" className="hm-h2">Pick your name today.</h2>
            <p className="hm-end-lead" id="hm-end-hint">
              {PLANS_ON_SALE
                ? `Set up your store today. ${TRIAL_DAYS} days free, then $${PRICE} a month.`
                : "Set up your store today. Selling opens when the plans do."}
            </p>
            <ClaimForm id="hm-handle-end" hintId="hm-end-hint" />
          </div>
        </section>
      </main>

      <div className="hm-foot"><Suspense fallback={null}><SiteFooter morning variant="home" /></Suspense></div>
      <HomeData questions={questions} />
    </div>
  );
}
