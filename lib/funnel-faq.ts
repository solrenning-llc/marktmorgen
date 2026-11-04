/**
 * The questions someone starting out asks about funnels (534 [FQ1], added
 * 1 November 2026), answered only by what the code does today, read from
 * its own sources: the kinds of funnel (lib/funnel-types.ts), the studio's
 * own buttons (components/funnel-type-picker.tsx), what a step counts
 * (lib/funnel-metrics.ts), whether paid plans are on sale (lib/opening.ts)
 * and the trial's length (lib/plan.ts).
 *
 * No number of customers or sales, no time promise, no "proven". Shown on
 * the funnels page in its "Questions" block, so the page and its FAQPage
 * data are one text (components/topic-page.tsx).
 */
import { FUNNEL_TYPES } from "@/lib/funnel-types";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { funnelStepMetrics } from "@/lib/funnel-metrics";
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";

/** The studio's own buttons, in the order a funnel is made (components/funnel-type-picker.tsx). */
export const FUNNEL_STUDIO_BUTTONS = ["Choose a kind", "Use this", "Name, for you", "Review funnel", "Create disabled funnel"] as const;
/** Where a funnel is switched on, in its own settings (components/page-funnel-editor.tsx). */
export const FUNNEL_ON_WORDS = "On: its address leads through the steps";

/** One step's line as the studio writes it, for an example the answer says is one. */
const EXAMPLE_STEP = funnelStepMetrics({ seen: 40, done: 6, product: true, free: false });

export function funnelBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const [choose, use, name, review, create] = FUNNEL_STUDIO_BUTTONS;
  return [
    {
      q: "What is a funnel?",
      a: "A few pages a visitor walks through in order, from one address: your own pages and your products' pages. After someone pays by card, Apple Pay or Google Pay, it can show them up to five offers of your other one-off products, each taken with one click on the card they just used.",
    },
    {
      q: "Which kind of funnel should I use?",
      a: `There are ${FUNNEL_TYPES.length} kinds to start from, each one a shape of empty pages for your own words: ${FUNNEL_TYPES.map((type) => type.label).join(", ")}. Each one says in the studio what it is made of; pick the one closest to what you sell. There are also ${FUNNEL_STARTERS.length} ready starters with first words already written, chosen by what you want to do, in the studio under Funnels.`,
    },
    {
      q: "How long does it take to build a funnel?",
      a: `It depends on how much you write, so no time is promised. In your studio, under Funnels: press “${choose}”, then “${use}” on the kind you want, give it a name under “${name}”, choose your products for the steps that ask for one, press “${review}”, then “${create}”. Its new pages stay hidden and the funnel stays off. When they are ready, show the pages under Pages and switch the funnel on in its settings (“${FUNNEL_ON_WORDS}”).`,
    },
    {
      q: "Can I try funnels before paying?",
      a: onSale
        ? `Yes. An eligible first store can start a ${trialDays}-day trial when it picks a plan: your card is taken when the trial starts and first charged when it ends, and canceling inside it means it is never charged. Funnels can be built during the trial, within the trial's own allowances, which are smaller than the plan's and leave out paid AI writing.`
        : "Yes. Paid plans are not on sale yet, so there is nothing to pay for now, and you can build a funnel in your own store's studio with no card. To see a store working, open the live demo store from the link at the end of this page: a made-up store, marked as a demo.",
    },
    {
      q: "Does it count opens and clicks?",
      a: "It does not count email opens, on purpose: there is no tracking pixel and no open rate. On plans that send email to your list, links to your store in an email carry that email's tag, so the visits it brought and the sales made on the page a link opened are counted for it. On a funnel, each step shows how many people opened it and how many paid or signed up.",
    },
    {
      q: "Do funnels work?",
      a: `We publish no number of customers or sales, because we do not have a real, checked count to show. Your own funnel tells you whether it works for you: each step shows a line such as “${EXAMPLE_STEP}” (an example), and if the counts cannot be read it says “${funnelStepMetrics({ seen: null, done: null, product: true, free: false })}” rather than showing a zero.`,
    },
  ];
}
