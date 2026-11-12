/**
 * Every studio area has its place in the help center's plan (lib/help-areas.ts,
 * 564 [HC1] unit 1; added 12 November 2026). Checked against the real folders
 * of app/studio and the real answers of lib/help-content.ts:
 *
 *   - every folder of app/studio is an area with an answer, an area still
 *     without one (said, with what it is to explain) or a screen that is not
 *     an area, and in exactly one of the three;
 *   - every answer named exists and still speaks of its area;
 *   - no answer the help center has today is lost: each answerId below stays,
 *     so no link to /help#<id> breaks (HC1 asks that old ids keep working).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AREAS_WITHOUT_HELP, HELP_AREAS, NOT_AREAS } from "@/lib/help-areas";
import { HELP_SECTIONS, answerId } from "@/lib/help-content";
import { done, is, part } from "./check";

const folders = readdirSync("app/studio").filter((f) => statSync(join("app/studio", f)).isDirectory()).sort();
const answers = new Map(HELP_SECTIONS.flatMap((s) => s.items.map((i) => [answerId(i.q), `${i.q} ${i.a.join(" ")}`] as const)));

part("Every studio area is accounted for");
{
  const placed = [...HELP_AREAS.map((a) => a.folder), ...Object.keys(AREAS_WITHOUT_HELP), ...Object.keys(NOT_AREAS)];
  is("no folder of app/studio is missing (put a new one in HELP_AREAS or AREAS_WITHOUT_HELP, lib/help-areas.ts)", folders.filter((f) => !placed.includes(f)), []);
  is("no area names a folder that is not there", placed.filter((f) => !folders.includes(f)), []);
  is("each folder is in exactly one list", placed.filter((f, i) => placed.indexOf(f) !== i), []);
  is("each area without help says what its answer is to explain", Object.values({ ...AREAS_WITHOUT_HELP, ...NOT_AREAS }).every((why) => why.length > 20), true);
}

part("Every answer named exists and speaks of its area");
{
  is("every answer exists", HELP_AREAS.filter((a) => !answers.has(a.answer)).map((a) => a.folder), []);
  is("every answer still mentions its area", HELP_AREAS.filter((a) => !(answers.get(a.answer) ?? "").toLowerCase().includes(a.mentions.toLowerCase())).map((a) => `${a.folder}: ${a.mentions}`), []);
}

part("No answer of today is lost");
{
  // The 111 answers of 12 November 2026. Adding answers is fine; renaming a question changes its id and breaks /help#<id>.
  const KEPT = [
    "what-is-marktmorgen-today", "can-i-put-my-own-products-on-my-store", "what-file-can-i-sell-and-how-big", "what-does-it-cost-to-start", "what-will-it-cost",
    "can-i-switch-between-monthly-and-yearly-or-between-the-plans", "can-i-run-more-than-one-store-or-have-someone-help-me", "can-i-move-my-store-from-stan-gumroad-or-another-platform",
    "how-does-marktmorgen-compare-with-stan", "can-i-move-from-clickfunnels", "is-it-open-or-is-this-a-waiting-list", "how-do-i-try-it", "is-the-file-real", "can-i-put-my-own-file-in-it",
    "whose-account-is-the-buyer-charged-on", "what-does-marktmorgen-take-from-a-sale", "how-do-i-send-a-proposal-or-an-agreement-to-sign", "how-do-i-ask-one-person-to-pay-me-a-custom-amount",
    "when-am-i-paid", "can-i-see-everything-one-buyer-has-bought-from-me", "can-i-give-a-countdown-offer-to-people-who-download-my-freebie", "how-do-i-know-if-my-numbers-are-good",
    "can-i-make-a-short-link-for-a-post", "can-my-numbers-read-what-i-spent-on-meta-ads", "can-i-give-someone-a-discount-code", "can-my-buyers-pay-with-paypal",
    "which-currencies-and-ways-to-pay-can-i-offer", "who-handles-refunds-and-disputes", "why-does-my-checkout-ask-buyers-to-check-a-box-about-access",
    "what-about-refunds-on-the-marktmorgen-subscription-itself", "can-i-take-a-break-instead-of-canceling", "are-creator-invitations-available",
    "is-there-a-limit-on-how-much-my-buyers-download", "how-many-visits-does-my-plan-cover", "what-if-i-sell-a-very-large-number-of-things", "when-do-my-plans-monthly-figures-start-again",
    "what-else-does-my-plan-cover-each-month", "how-much-can-my-store-hold", "what-happens-when-my-plan-ends", "what-can-i-sell", "can-i-sell-content-with-resale-or-private-label-rights",
    "can-i-give-something-away-for-an-email-address", "can-it-write-my-descriptions-outlines-and-emails", "can-i-sell-a-private-podcast", "can-i-run-a-sale-like-black-friday",
    "can-my-buyers-give-something-as-a-gift", "can-buyers-in-poorer-countries-pay-less", "can-my-store-have-a-blog", "can-my-store-speak-another-language-to-my-buyers",
    "can-i-sell-a-product-from-my-own-website-or-blog", "can-a-company-buy-one-of-my-products-for-its-whole-team", "can-i-take-a-waitlist-before-something-goes-on-sale",
    "can-i-sell-something-before-it-is-ready-as-a-pre-order", "can-i-sell-a-physical-product-like-a-printed-book-or-merch", "can-i-sell-a-membership", "can-i-sell-paid-calls",
    "can-i-sell-a-package-of-sessions-like-5-calls-booked-one-at-a-time", "can-i-offer-something-extra-before-or-after-they-pay-or-sell-a-limited-number",
    "can-buyers-put-several-products-in-a-cart", "can-i-group-products-into-collections-or-suggest-what-goes-with-a-product", "can-i-sell-a-bundle-of-products",
    "can-buyers-pay-in-installments", "can-the-buyer-choose-the-price", "can-i-ask-buyers-something-before-they-pay", "does-a-buyer-who-leaves-the-checkout-get-a-reminder",
    "is-sales-tax-or-vat-added", "can-i-see-how-my-store-is-doing", "can-i-add-my-meta-google-tiktok-or-pinterest-pixel", "can-sales-be-sent-to-my-ad-platforms-from-the-server",
    "can-i-sell-a-course", "i-bought-from-several-creators-here-is-there-one-place-with-all-of-it", "can-my-store-have-pages-besides-its-products-like-an-about-page",
    "can-i-bring-my-email-sequences-from-another-service", "can-i-email-the-people-on-my-list", "can-i-publish-an-email-i-sent-on-my-store",
    "can-i-send-my-list-to-mailchimp-kit-beehiiv-or-mailerlite", "can-buyers-leave-reviews", "can-i-build-a-sales-page-or-a-landing-page", "can-i-run-a-community-or-a-webinar",
    "how-do-live-events-in-the-community-work", "can-i-run-an-affiliate-program", "can-i-connect-zapier-make-or-my-own-server", "can-i-sell-software-with-license-keys",
    "can-i-put-the-buyers-email-on-a-pdf", "does-it-work-on-a-phone", "can-my-store-show-that-people-are-buying", "can-i-copy-a-funnel-or-share-one-with-another-creator",
    "can-i-copy-a-whole-store-into-another-of-my-stores", "can-i-reuse-a-section-on-several-pages", "can-i-add-a-form-a-survey-or-a-quiz", "can-visitors-chat-with-me-and-where-do-i-answer-them",
    "can-an-ai-answer-my-buyers-questions-at-any-hour", "can-the-store-assistant-suggest-one-next-product-after-a-purchase", "can-the-store-assistant-send-one-reminder-after-a-checkout-left-unpaid",
    "what-if-i-can-no-longer-open-the-email-i-log-in-with", "can-i-keep-my-own-details-about-people-and-track-deals", "will-search-engines-find-my-store", "can-i-use-my-own-domain",
    "can-i-change-my-store-address-later", "how-does-the-buyer-get-the-file", "does-the-download-link-expire", "a-buyer-says-the-file-never-arrived-what-now",
    "can-my-store-help-me-find-sponsors-and-partners", "who-can-i-write-to-and-what-are-the-rules", "i-run-a-website-and-saw-marktmorgenoutreach-in-my-logs-what-is-it",
    "what-happens-to-my-payments-and-customer-data-if-i-leave", "what-do-you-store-about-me", "how-are-my-store-and-my-buyers-protected", "can-i-have-it-deleted",
    "someone-asked-me-to-delete-their-data-what-do-i-do", "do-you-sell-or-share-it",
  ];
  is("the list is the 111 of today", KEPT.length, 111);
  is("every one is still there", KEPT.filter((id) => !answers.has(id)), []);
  is("no two answers share an id", answers.size, HELP_SECTIONS.reduce((n, s) => n + s.items.length, 0));
}

done();
