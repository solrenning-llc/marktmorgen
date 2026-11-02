/**
 * The questions someone starting out asks about email to their list (534
 * [FQ1], unit 30, lib/email-faq.ts; added 2 November 2026). Checked: the
 * studio's own words, read from its files, in the order the answer gives
 * them; email only on an active Studio or Scale plan; the sender saved
 * first, by whoever may change settings, and sending by whoever may send; the
 * check before it goes out; no button that starts a plan while none is on
 * sale; each answer in both states; no sentence said twice on the page; no
 * figure; first in the page's own Questions block.
 */
import { readFileSync } from "node:fs";
import { EMAIL_WORDS, emailBeginnerQuestions } from "@/lib/email-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { PLAN_TITLES, PRO_ON_SALE, TRIAL_DAYS, canUse } from "@/lib/plan";
import { can } from "@/lib/team-roles";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = EMAIL_WORDS;

part("The studio's own words and rules");
const studio = flat(read("app/studio/page.tsx"));
const page = flat(read("app/studio/email/page.tsx"));
const panel = flat(read("components/email-studio.tsx"));
is("the tool, labeled Pro", studio.includes(`href: studioPath(store, "", "email"), title: "${w.tool}", text: "One-off emails and sequences to your list.", icon: "mail" as const, tag: "${w.studioPlan}"`), true);
is("email offered, only on a paid-up Studio or Scale plan", [PRO_ON_SALE, canUse({ subscriptionActive: true, tier: "pro" }, "email"), canUse({ subscriptionActive: true, tier: "scale" }, "email"), canUse({ subscriptionActive: true, tier: "creator" }, "email"), canUse({ subscriptionActive: false, tier: "pro" }, "email"), canUse({ subscriptionActive: true, tier: "pro", renewalUnpaidSince: 1 }, "email")], [true, true, true, false, false, false]);
is("a paid-up-no-more Studio store is told why, not offered Pro", [page.includes("allowance === 0 && store.subscriptionActive && hasPro(store.tier) ? ("), page.includes("Email to your list is stopped: your plan's last renewal is not paid."), page.indexOf("allowance === 0 && store.subscriptionActive && hasPro(store.tier)") < page.indexOf("Part of Pro")], [true, true, true]);
is("the sender's fields and their save, first, as the studio says them", [panel.includes(`>${w.from}</span>`), panel.includes(`>${w.postal}</span>`), panel.includes("Save the name and postal address your emails carry first, at the top of this page.")], [true, true, true]);
is("the compose words, the draft, when, the check and the confirms, as the studio says them", [panel.includes(`{draftId ? "Draft" : "${w.compose}"}`), panel.includes(`>${w.to}</span>`), panel.includes(`{later ? "${w.schedule}" : "${w.send}"}`), panel.includes(`"${w.draft}"`), panel.includes(`>${w.when}</legend>`), panel.includes(`/> ${w.later} </label>`), panel.includes(`>${w.check}</h3>`), panel.includes(`\`${w.yes} \${n(reach)}\``), panel.includes(`\`${w.yesLater} \${n(reach)}\``), panel.includes("useState(mail?.fromName ?? name)"), panel.includes("{props.canSend ? ( <fieldset> <legend className=\"field-label\">When</legend>")], [true, true, true, true, true, true, true, true, true, true, true]);
is("sending for the owner or an Admin, writing drafts for an Editor too", [can("owner", "send"), can("admin", "send"), can("editor", "send"), can("editor", "draft")], [true, true, false, true]);
const billingForms = [...page.matchAll(/action=\{`\/api\/billing\/(checkout|switch)/g)].map((m) => m.index ?? 0);
is("no button starts or changes a plan while none is on sale, as the checkout and the switch refuse", [page.includes("!PLANS_ON_SALE || !isBillingConfigured() ? ("), page.includes("Paid plans are not on sale yet, so this store cannot move to Pro for now."), billingForms.length >= 2 && billingForms.every((at) => page.indexOf("!PLANS_ON_SALE || !isBillingConfigured() ? (") < at), page.includes("moveUp={ PLANS_ON_SALE && isBillingConfigured() &&"), read("app/api/billing/checkout/route.ts").includes('if (!PLANS_ON_SALE) return away(origin, studio("billing=not-open"));'), read("app/api/billing/switch/route.ts").includes("PLANS_ON_SALE")], [true, true, true, true, true, true]);
is("the trial's emails only said while a trial can start", page.includes("{PLANS_ON_SALE && trialOffered(store) ? ( <p className=\"mt-3 text-sm text-ink-soft\"> {`During the free trial"), true);

part("The answers, in both states");
const now = emailBeginnerQuestions(false, TRIAL_DAYS);
const later = emailBeginnerQuestions(true, TRIAL_DAYS);
is("two questions", now.map((x) => x.q), ["How do I send my first email?", "Can I try it before paying?"]);
const how = answer(now, "How do I send my first email?");
is("sending: both plans, paid up, the studio's label, who presses what, the studio's words in order", [how.startsWith(`Email is part of the ${PLAN_TITLES.pro} and ${PLAN_TITLES.scale} plans`), how.includes(`the ${PLAN_TITLES.pro} plan is labeled “${w.studioPlan}”`), how.includes("While one of them is paid up"), how.includes("an Editor presses"), how.includes("stays off while that group counts no one"), (() => { const at = [w.tool, w.from, w.postal, w.save, w.compose, w.to, w.send, w.draft, w.check, `${w.yes} …`, w.later, w.when, w.schedule, `${w.yesLater} …`].map((x) => how.indexOf(`“${x}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })()], [true, true, true, true, true, true]);
is("try before paying: not yet today; the shared answer on Studio or Scale later, not on a Store trial", [answer(now, "Can I try it before paying?").startsWith(`Not yet. Email to your list needs the ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale} plan`), answer(later, "Can I try it before paying?").startsWith(tryBeforePaying(`Email to your list, on ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale},`, "", true, TRIAL_DAYS)), answer(later, "Can I try it before paying?").endsWith(`On a trial of the ${PLAN_TITLES.creator} plan, email is not included.`)], [true, true, true]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the trial's days, no percent, no result promised", [/\d/.test(all.split(`${TRIAL_DAYS}-day`).join("")), /%|guarantee|open rate|inbox placement|proven/i.test(all)], [false, false]);

part("On the email page");
const topic = findPage("platform", "email");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 2).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const shared = tryBeforePaying(`Email to your list, on ${PLAN_TITLES.pro} or ${PLAN_TITLES.scale},`, "", true, TRIAL_DAYS);
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x) && !x.startsWith("To see a store working"));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(2) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
