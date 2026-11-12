/**
 * Every area of the studio and the help center's answer for its main task
 * (564 [HC1], unit 1; added 12 November 2026). The list the help center's
 * "Help for each part of your studio" links are drawn from (app/help/page.tsx;
 * an area whose answer is gone is left out there, and the test below fails),
 * kept beside the studio's own screens so a
 * new screen cannot go without help unnoticed: tests/help-areas.test.ts
 * fails when a folder of app/studio is in none of the three lists below,
 * when an answer named here is gone, or when it no longer speaks of its area.
 *
 *   - HELP_AREAS: the area, its studio address, the answer that explains its
 *     main task (an answerId of lib/help-content.ts) and a word that answer
 *     must contain, so a moved or rewritten answer cannot quietly stop
 *     covering the area.
 *   - AREAS_WITHOUT_HELP: areas the help center has no answer for yet, said
 *     honestly, each to get its answer in a later unit of HC1.
 *   - NOT_AREAS: studio screens that are not an area of their own (a state
 *     of the studio, or a screen that is itself help).
 */

import type { IconName } from "@/components/icons";

/**
 * `icon` is drawn beside the area's name on /help, decorative (the name says
 * it all) and never the same for two areas.
 * `feature` is the slug of the area's page under /platform, where there is one
 * that is about it (the test checks the page exists and speaks of the area).
 * `noScreen` marks an area with no screen of its own at /studio/<folder>: its
 * screens open from one product (a course, a podcast), so the help links to
 * no studio address for it.
 */
export type HelpArea = { folder: string; name: string; icon: IconName; answer: string; mentions: string; feature?: string; noScreen?: true };

export const HELP_AREAS: readonly HelpArea[] = [
  { folder: "add", name: "Products", icon: "tag", answer: "can-i-put-my-own-products-on-my-store", mentions: "product" },
  { folder: "affiliates", name: "Affiliates", icon: "handshake", answer: "can-i-run-an-affiliate-program", mentions: "affiliate", feature: "affiliates" },
  { folder: "agent", name: "What the AI proposes", icon: "sparkle", answer: "how-do-i-approve-changes-my-ai-assistant-prepared", mentions: "What the AI proposes" },
  { folder: "agreements", name: "Proposals and agreements", icon: "scroll", answer: "how-do-i-send-a-proposal-or-an-agreement-to-sign", mentions: "agreement" },
  { folder: "blog", name: "Blog", icon: "notebook", answer: "can-my-store-have-a-blog", mentions: "blog" },
  { folder: "bundles", name: "Bundles", icon: "basket", answer: "can-i-sell-a-bundle-of-products", mentions: "bundle", feature: "bundles" },
  { folder: "calendar", name: "Your calendar", icon: "calendar", answer: "how-do-i-keep-my-busy-times-out-of-the-team-calls-i-host", mentions: "calendar", feature: "calendar-sync" },
  { folder: "card", name: "Business card", icon: "card", answer: "how-do-i-make-a-business-card-to-share", mentions: "card" },
  { folder: "closing-refunds", name: "Refund unused time", icon: "undo", answer: "how-do-i-refund-members-for-unused-time-when-my-store-closes", mentions: "unused time" },
  { folder: "community", name: "Community", icon: "users", answer: "can-i-run-a-community-or-a-webinar", mentions: "community", feature: "community" },
  { folder: "companies", name: "Companies", icon: "bank", answer: "can-a-company-buy-one-of-my-products-for-its-whole-team", mentions: "company" },
  { folder: "copy", name: "Copy a store", icon: "copy", answer: "can-i-copy-a-whole-store-into-another-of-my-stores", mentions: "copy" },
  { folder: "course", name: "Courses", icon: "cap", answer: "can-i-sell-a-course", mentions: "course", feature: "courses", noScreen: true },
  { folder: "deals", name: "Deals and pipelines", icon: "target", answer: "can-i-keep-my-own-details-about-people-and-track-deals", mentions: "deal", feature: "crm" },
  { folder: "discord", name: "Discord", icon: "gamepad", answer: "can-my-buyers-get-into-my-discord-server", mentions: "Discord", feature: "discord-access" },
  { folder: "disputes", name: "Disputed purchases", icon: "alert", answer: "who-handles-refunds-and-disputes", mentions: "dispute" },
  { folder: "email", name: "Email", icon: "mail", answer: "can-i-email-the-people-on-my-list", mentions: "email", feature: "email" },
  { folder: "forms", name: "Forms, surveys and quizzes", icon: "list", answer: "can-i-add-a-form-a-survey-or-a-quiz", mentions: "form" },
  { folder: "funnels", name: "Funnels", icon: "ladder", answer: "how-do-i-build-a-funnel", mentions: "funnel", feature: "funnels" },
  { folder: "growth", name: "Growth", icon: "chart", answer: "how-do-i-choose-a-growth-goal-and-see-what-to-do-next", mentions: "goal" },
  { folder: "import", name: "Moving from another platform", icon: "download", answer: "can-i-move-my-store-from-stan-gumroad-or-another-platform", mentions: "Moving from another platform", feature: "switching-to-marktmorgen" },
  { folder: "inbox", name: "Inbox", icon: "chat", answer: "can-visitors-chat-with-me-and-where-do-i-answer-them", mentions: "inbox" },
  { folder: "integrations", name: "Email platforms", icon: "plug", answer: "can-i-send-my-list-to-mailchimp-kit-beehiiv-or-mailerlite", mentions: "Mailchimp", feature: "email-platforms" },
  { folder: "invite", name: "Invite creators", icon: "party", answer: "are-creator-invitations-available", mentions: "invit" },
  { folder: "invoices", name: "Your plan's invoices", icon: "receipt", answer: "where-do-i-find-my-plans-invoices", mentions: "invoices" },
  { folder: "labels", name: "Labels on contacts", icon: "pin", answer: "can-i-put-a-label-on-many-contacts-at-once", mentions: "label" },
  { folder: "meetings", name: "Video calls", icon: "video", answer: "can-i-sell-paid-calls", mentions: "Video calls", feature: "calls" },
  { folder: "memberships", name: "Memberships", icon: "repeat", answer: "can-i-sell-a-membership", mentions: "membership", feature: "memberships" },
  { folder: "new", name: "A new store", icon: "plus", answer: "can-i-run-more-than-one-store-or-have-someone-help-me", mentions: "store" },
  { folder: "outreach", name: "Outreach", icon: "globe", answer: "can-my-store-help-me-find-sponsors-and-partners", mentions: "Outreach", feature: "outreach" },
  { folder: "pages", name: "Sales pages", icon: "layout", answer: "can-i-build-a-sales-page-or-a-landing-page", mentions: "page", feature: "sales-pages" },
  { folder: "path", name: "Your Path", icon: "door", answer: "what-is-your-path-and-how-do-i-start-it", mentions: "Path" },
  { folder: "people", name: "Buyers", icon: "user", answer: "can-i-see-everything-one-buyer-has-bought-from-me", mentions: "buyer" },
  { folder: "phone", name: "Phone notifications", icon: "phone", answer: "does-it-work-on-a-phone", mentions: "notifications", feature: "phone-notifications" },
  { folder: "podcast", name: "Private podcasts", icon: "mic", answer: "can-i-sell-a-private-podcast", mentions: "podcast", noScreen: true },
  { folder: "refund", name: "Your plan's refund", icon: "refresh", answer: "what-about-refunds-on-the-marktmorgen-subscription-itself", mentions: "refund" },
  { folder: "requests", name: "Payment requests", icon: "link", answer: "how-do-i-ask-one-person-to-pay-me-a-custom-amount", mentions: "link" },
  { folder: "reviews", name: "Reviews", icon: "star", answer: "can-buyers-leave-reviews", mentions: "review", feature: "reviews" },
  { folder: "site", name: "Your pages", icon: "window", answer: "can-my-store-have-pages-besides-its-products-like-an-about-page", mentions: "page" },
  { folder: "tax", name: "Tax", icon: "percent", answer: "is-sales-tax-or-vat-added", mentions: "tax" },
  { folder: "team", name: "Team", icon: "key", answer: "can-i-run-more-than-one-store-or-have-someone-help-me", mentions: "team", feature: "teams-and-stores" },
  { folder: "totals", name: "All your stores", icon: "gauge", answer: "can-i-run-more-than-one-store-or-have-someone-help-me", mentions: "store" },
];

/** Studio areas the help center has no answer for yet, by folder, each with what that answer is to explain. */
export const AREAS_WITHOUT_HELP: Readonly<Record<string, string>> = {};

/** Studio screens that are not an area of their own. */
export const NOT_AREAS: Readonly<Record<string, string>> = {
  checkup: "It is itself a help screen: \"Something not working?\".",
  paused: "A state of the studio while it is paused, not a place a creator goes to work.",
};

export type HelpLink = { href: string; label: string };

/**
 * Where an answer's task is done and read about (564 [HC1], item 3): the
 * studio screen of each area it is the main answer for, then each area's page
 * under /platform, each address once. An answer that is no area's main answer
 * links nowhere new.
 */
export function answerLinks(answerId: string): { studio: HelpLink[]; features: HelpLink[] } {
  const areas = HELP_AREAS.filter((area) => area.answer === answerId);
  const once = (links: HelpLink[]) => links.filter((link, i) => links.findIndex((other) => other.href === link.href) === i);
  return {
    studio: once(areas.filter((area) => !area.noScreen).map((area) => ({ href: `/studio/${area.folder}`, label: `Open “${area.name}” in your studio` }))),
    features: once(areas.filter((area) => area.feature).map((area) => ({ href: `/platform/${area.feature}`, label: `Read the “${area.name}” feature page` }))),
  };
}
