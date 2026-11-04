/**
 * Questions from someone starting out, on the funnels page (534 [FQ1], unit
 * 1, lib/funnel-faq.ts; added 1 November 2026). Checked, as the item asks:
 *
 *   - the six questions are in the page's existing "Questions" block, and its
 *     FAQPage data is built from the same items (components/topic-page.tsx);
 *   - every kind of funnel is named with its own hint, from the code;
 *   - the steps are the studio's own buttons, and no time is promised;
 *   - "Can I try funnels": while plans are not on sale it says so and points to
 *     the demo, marked as one; once on sale the trial's days come from the
 *     code; it never starts with "free";
 *   - opens: none counted, said in the words the email page already uses;
 *   - "Do funnels work?": no number of customers or sales; the example line
 *     is the studio's own, from lib/funnel-metrics.ts;
 *   - no forbidden word, no http:// link, no other number but the code's.
 */
import { readFileSync } from "node:fs";
import { FUNNEL_TYPES } from "@/lib/funnel-types";
import { funnelStepMetrics } from "@/lib/funnel-metrics";
import { FUNNEL_ON_WORDS, FUNNEL_STUDIO_BUTTONS, funnelBeginnerQuestions } from "@/lib/funnel-faq";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { findPage } from "@/lib/site-pages";
import { TRIAL_DAYS } from "@/lib/plan";
import { done, is, part } from "./check";

const ask = (items: { q: string; a: string }[], q: string) => items.find((item) => item.q === q)?.a ?? "";

function main(): void {
  const page = findPage("platform", "funnels");
  const block = page?.blocks.find((b) => b.kind === "faq");
  const items = block && block.kind === "faq" ? block.items : [];
  const closed = funnelBeginnerQuestions(false, 14);
  const open = funnelBeginnerQuestions(true, 14);

  part("In the page's own Questions block");
  is("the six questions, first, in the existing block", items.slice(0, 6).map((i) => i.q), ["What is a funnel?", "Which kind of funnel should I use?", "How long does it take to build a funnel?", "Can I try funnels before paying?", "Does it count opens and clicks?", "Do funnels work?"]);
  is("the earlier questions are still there", items.some((i) => i.q === "Can a buyer be charged without meaning to?"), true);
  const faqData = /function FaqData[\s\S]*?\n\}/.exec(readFileSync("components/topic-page.tsx", "utf8"))?.[0] ?? "";
  is("the FAQPage data is built from the same items: every faq block's q and a, as they are", [faqData.includes('blocks.flatMap((b) => (b.kind === "faq" ? b.items : []))'), faqData.includes("name: item.q"), faqData.includes('acceptedAnswer: { "@type": "Answer", text: item.a }')], [true, true, true]);

  part("Answered from the code");
  const kinds = ask(closed, "Which kind of funnel should I use?");
  is("every kind of funnel by name, with how many there are", FUNNEL_TYPES.every((t) => kinds.includes(t.label)) && kinds.includes(`There are ${FUNNEL_TYPES.length} kinds`), true);
  is("and the ready starters, counted from their list", kinds.includes(`${FUNNEL_STARTERS.length} ready starters with first words already written`), true);
  is("what a funnel is, as the page itself says: up to five offers, card, Apple Pay or Google Pay, one click", ask(closed, "What is a funnel?").includes("up to five offers of your other one-off products, each taken with one click"), true);
  const how = ask(closed, "How long does it take to build a funnel?");
  const picker = readFileSync("components/funnel-type-picker.tsx", "utf8");
  is("the steps are the studio's own buttons", FUNNEL_STUDIO_BUTTONS.every((label) => how.includes(`“${label}”`) && picker.includes(label)), true);
  is("no time promised", /\b(minute|minutes|hour|hours|seconds|quick|fast|instantly|in no time)\b/i.test(how), false);
  is("plans closed: it says so, that a funnel can be built with no card, and points to the demo, marked as one", [ask(closed, "Can I try funnels before paying?").startsWith("Yes. Paid plans are not on sale yet"), ask(closed, "Can I try funnels before paying?").includes("build a funnel in your own store's studio with no card"), ask(closed, "Can I try funnels before paying?").includes("a made-up store, marked as a demo")], [true, true, true]);
  is("plans open: the trial's days from the code", ask(open, "Can I try funnels before paying?").includes("14-day trial") && ask(funnelBeginnerQuestions(true), "Can I try funnels before paying?").includes(`${TRIAL_DAYS}-day trial`), true);
  is("plans open: the trial sentence lib/plan.ts requires, and the trial's own allowances", [ask(open, "Can I try funnels before paying?").includes("your card is taken when the trial starts and first charged when it ends, and canceling inside it means it is never charged"), ask(open, "Can I try funnels before paying?").includes("leave out paid AI writing")], [true, true]);
  is("the switch-on words are the funnel settings' own", readFileSync("components/page-funnel-editor.tsx", "utf8").includes(FUNNEL_ON_WORDS) && how.includes(FUNNEL_ON_WORDS), true);
  is("never starts with “free”", [...closed, ...open].every((i) => !/^free\b/i.test(i.a)), true);
  const opens = ask(closed, "Does it count opens and clicks?");
  is("no email opens counted, in the email page's own words", opens.includes("no tracking pixel and no open rate") && readFileSync("lib/feature-pages.ts", "utf8").includes("no tracking pixel and no open rate"), true);
  const works = ask(closed, "Do funnels work?");
  is("no number of customers or sales; the studio's own lines as the examples", [works.includes("We publish no number of customers or sales"), works.includes(funnelStepMetrics({ seen: 40, done: 6, product: true, free: false })), works.includes(funnelStepMetrics({ seen: null, done: null, product: true, free: false }))], [true, true, true]);

  part("Nothing it may not say");
  const all = [...closed, ...open].map((i) => `${i.q} ${i.a}`).join(" ");
  is("no forbidden word", /proven|guaranteed|24\/7|\bboom\b|in minutes|support team|round the clock/i.test(all), false);
  is("no http:// link", all.includes("http://"), false);
  const numbers = closed.flatMap((i) => i.a.match(/\d[\d,.%]*/g) ?? []);
  is("its only numbers come from the code: the kinds, the starters, the example line", numbers, [String(FUNNEL_TYPES.length), String(FUNNEL_STARTERS.length), "40", "6", "15%"]);
  is("no address written out (the demo is the page's own link)", /https?:\/\//.test(all), false);
}

main();
done();
