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
 *     so no link to /help#<id> breaks (HC1 asks that old ids keep working);
 *   - in the answers written for HC1, every button or screen named in quotes
 *     is in the code of the screens it explains;
 *   - the help page lists every area, each link going to an answer that is on
 *     the page and saying the area and the question;
 *   - each answer links to the studio screen it explains and to the area's
 *     feature page (HC1 item 3), and both addresses are real.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AREAS_WITHOUT_HELP, HELP_AREAS, NOT_AREAS, answerLinks } from "@/lib/help-areas";
import { FEATURE_PAGES } from "@/lib/feature-pages";
import { webhookBeginnerQuestions } from "@/lib/webhook-faq";
import { workflowLimitWords } from "@/lib/flow-limits";
import { HELP_SECTIONS, answerId } from "@/lib/help-content";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HelpPage from "@/app/help/page";
import { done, is, part } from "./check";

const folders = readdirSync("app/studio").filter((f) => statSync(join("app/studio", f)).isDirectory()).sort();
const answers = new Map(HELP_SECTIONS.flatMap((s) => s.items.map((i) => [answerId(i.q), `${i.q} ${i.a.join(" ")}`] as const)));

part("Every studio area is accounted for");
{
  const placed = [...HELP_AREAS.map((a) => a.folder), ...Object.keys(AREAS_WITHOUT_HELP), ...Object.keys(NOT_AREAS)];
  is("no folder of app/studio is missing (put a new one in HELP_AREAS or AREAS_WITHOUT_HELP, lib/help-areas.ts)", folders.filter((f) => !placed.includes(f)), []);
  is("no area names a folder that is not there", placed.filter((f) => !folders.includes(f)), []);
  is("each folder is in exactly one list", placed.filter((f, i) => placed.indexOf(f) !== i), []);
  is("each area without help, and each screen that is not an area, says why", Object.values({ ...AREAS_WITHOUT_HELP, ...NOT_AREAS }).every((why) => why.length > 20), true);
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

part("The help page lists every area");
{
  const html = renderToStaticMarkup(createElement(HelpPage));
  const nav = html.slice(html.indexOf("data-help-areas"), html.indexOf("</nav>", html.indexOf("data-help-areas")));
  const links = [...nav.matchAll(/<a href="#([^"]+)"[^>]*>(<svg[\s\S]*?<\/svg>)<span[^>]*><span[^>]*>([^<]+)<\/span><span[^>]*>([^<]+)<\/span><\/span><\/a>/g)].map((m) => [m[0], m[1], m[3], m[4], m[2]]);
  is("one link per area", links.length, HELP_AREAS.length);
  is("every link goes to an answer on the page", links.filter((l) => !html.includes(`id="${l[1]}"`)).map((l) => l[1]), []);
  is("every link says its area and a question", links.every((l) => l[2].length > 2 && l[3].endsWith("?")), true);
  is("each icon is decorative, the name says it all", links.every((l) => /aria-hidden="true"/.test(l[4]) && !/<title/.test(l[4])), true);
  is("no two areas share an icon (HC1: no repeated image)", HELP_AREAS.map((a) => a.icon).filter((icon, i, all) => all.indexOf(icon) !== i), []);
  is("no two cards draw the same picture", links.map((l) => l[4].replace(/class="[^"]*"/, "")).filter((svg, i, all) => all.indexOf(svg) !== i).length, 0);
  is("the list has its own heading", /<h2 id="help-areas-title"[^>]*>Help for each part of your studio<\/h2>/.test(html), true);
}

part("Names quoted in the answers written for HC1 are on the screens");
{
  const SCREENS: Record<string, string[]> = {
    "where-do-i-find-my-plans-invoices": ["app/studio/page.tsx", "app/studio/invoices/page.tsx"],
    "can-i-put-a-label-on-many-contacts-at-once": ["app/studio/import/page.tsx", "components/bulk-labels.tsx"],
    "can-my-buyers-get-into-my-discord-server": ["app/studio/page.tsx", "components/discord-studio.tsx", "app/studio/discord/page.tsx"],
    "how-do-i-build-a-funnel": ["app/studio/page.tsx", "components/studio-tools.tsx", "app/studio/funnels/page.tsx", "components/funnel-type-picker.tsx", "components/page-funnel-editor.tsx", "components/funnel-editor.tsx"],
    "how-do-i-refund-members-for-unused-time-when-my-store-closes": ["app/studio/page.tsx", "app/studio/closing-refunds/page.tsx", "components/closing-refunds-confirm.tsx"],
    "how-do-i-make-a-business-card-to-share": ["app/studio/page.tsx", "app/studio/site/page.tsx", "app/studio/card/page.tsx", "components/creator-card-editor.tsx"],
    "what-is-your-path-and-how-do-i-start-it": ["components/studio-header.tsx", "components/path-studio-reminder.tsx", "app/studio/path/page.tsx", "components/path-onboarding.tsx", "lib/path-checkout.ts"],
    "how-do-i-choose-a-growth-goal-and-see-what-to-do-next": ["app/studio/page.tsx", "components/studio-tools.tsx", "app/studio/growth/page.tsx", "lib/growth-plan.ts", "components/template-library.tsx"],
    "how-do-i-approve-changes-my-ai-assistant-prepared": ["app/studio/agent/page.tsx", "components/agent-proposals.tsx", "app/developers/page.tsx"],
    "how-do-i-tell-zapier-make-or-my-own-server-when-something-happens-in-my-store": ["components/webhook-editor.tsx"],
    "how-do-i-make-an-email-sequence-and-switch-it-on": ["components/email-studio.tsx", "components/workflow-tools.tsx", "app/studio/page.tsx"],
    "how-do-i-keep-my-busy-times-out-of-the-team-calls-i-host": ["app/studio/page.tsx", "components/studio-tools.tsx", "components/team-event-editor.tsx", "app/studio/calendar/page.tsx", "components/host-calendar.tsx"],
  };
  const plain = (text: string) => text.replace(/&apos;|\u2019/g, "'");
  for (const [id, files] of Object.entries(SCREENS)) {
    const code = plain(files.map((f) => readFileSync(f, "utf8")).join("\n"));
    const quoted = [...(answers.get(id) ?? "").matchAll(/\u201c([^\u201d]+)\u201d/g)].map((m) => plain(m[1]));
    is(`${id}: names something`, quoted.length > 0, true);
    // A name counts only as a whole word run, never inside a longer identifier ("Path" in studioPath does not count).
    const escape = (q: string) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const onScreen = (q: string) => new RegExp(`(?<![A-Za-z0-9_])${escape(q)}(?![A-Za-z0-9_])`).test(code);
    is(`${id}: every quoted name is in its screens`, quoted.filter((q) => !onScreen(q)), []);
  }
}

part("Each area's answer links to its studio screen and its feature page");
{
  for (const area of HELP_AREAS) {
    const screen = existsSync(join("app/studio", area.folder, "page.tsx"));
    is(`${area.folder}: marked without a screen exactly when /studio/${area.folder} has no page`, area.noScreen === true, !screen);
    if (!area.feature) continue;
    const page = FEATURE_PAGES.find((p) => p.slug === area.feature);
    is(`${area.folder}: /platform/${area.feature} is a feature page`, Boolean(page), true);
    is(`${area.folder}: /platform/${area.feature} speaks of the area`, JSON.stringify(page ?? {}).toLowerCase().includes(area.mentions.toLowerCase()), true);
  }
  const several = answerLinks("can-i-run-more-than-one-store-or-have-someone-help-me");
  is("an answer for three areas links to each of their screens", several.studio.map((l) => l.href).sort(), ["/studio/new", "/studio/team", "/studio/totals"]);
  is("and to one feature page, once", several.features, [{ href: "/platform/teams-and-stores", label: "Read the \u201cTeam\u201d feature page" }]);
  is("the studio link says the area by name", several.studio.find((l) => l.href === "/studio/team")?.label, "Open \u201cTeam\u201d in your studio");
  const course = answerLinks("can-i-sell-a-course");
  is("an area with no screen of its own gets no studio link", course.studio, []);
  is("but keeps its feature page", course.features.map((l) => l.href), ["/platform/courses"]);
  const elsewhere = [...answers.keys()].find((id) => !HELP_AREAS.some((area) => area.answer === id)) ?? "";
  is("an answer that is no area's main one", answerLinks(elsewhere), { studio: [], features: [] });
  const everyLink = HELP_AREAS.flatMap((area) => { const l = answerLinks(area.answer); return [...l.studio, ...l.features]; });
  is("every studio link opens a real screen", everyLink.filter((l) => l.href.startsWith("/studio/") && !existsSync(join("app", l.href, "page.tsx"))), []);
}

part("The webhook answer says what the feature page says");
{
  const id = "how-do-i-tell-zapier-make-or-my-own-server-when-something-happens-in-my-store";
  const item = HELP_SECTIONS.flatMap((section) => section.items).find((i) => answerId(i.q) === id);
  const faq = webhookBeginnerQuestions().map((q) => q.a);
  is("it opens with what a webhook is, in the feature page's words", item?.a[0], `With a webhook: an${faq[0].slice(2)}`);
  is("then how to add one, word for word", item?.a[1], faq[1]);
  is("then Zapier, word for word after its first words", [item?.a[2].startsWith("Zapier works through "), item?.a[2].slice("Zapier works through ".length)], [true, faq[3].slice("Yes, through ".length)]);
  const kept = Number(/export const LOG_SIZE = (\d+);/.exec(readFileSync("lib/webhooks.ts", "utf8"))?.[1]);
  is("the deliveries it says the studio lists are the ones it keeps", item?.a[3].includes(`up to ${kept}, each kept for a week`), true);
  is("and the studio says a week too", readFileSync("components/webhook-editor.tsx", "utf8").includes("Deliveries are kept for a week, the last 50 at most."), kept === 50);
}

part("The sequence answer gives the limits in lib/flow-limits.ts's own sentence");
{
  const item = HELP_SECTIONS.flatMap((section) => section.items).find((i) => answerId(i.q) === "how-do-i-make-an-email-sequence-and-switch-it-on");
  is("the limits, word for word", item?.a.at(-1)?.includes(workflowLimitWords()), true);
  is("a new sequence starts as it says: named Welcome, started by a join, its first email at 0 hours", /name: "Welcome",\s*trigger: "joined",[\s\S]{0,200}steps: \[blankStep\("0", "hours", first\)\]/.test(readFileSync("components/email-studio.tsx", "utf8")), true);
  is("and it is saved paused", readFileSync("components/email-studio.tsx", "utf8").includes("active: draft.id ? draft.active : false"), true);
}

done();
