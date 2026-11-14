/**
 * The pricing cards while paid plans are not on sale (PLANS_ON_SALE false, as today): nothing a reader sees says,
 * as if it worked today, what cannot happen yet (VR rule, item 2). No plan or trial can start and no card is taken,
 * so the buttons say what the link does today (lib/opening.ts startWords, as the home page and /platform say it),
 * each still naming its plan, and the plan terms and the one-trial line are said of when plans open. Prices, the
 * trial's length, the money-back days and the fees are the same figures as on opening day.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pricing } from "@/components/home-parts";
import { PLANS_ON_SALE, startWords } from "@/lib/opening";
import { PLAN_TITLES, REFUND_DAYS, TIERS, TRIAL_DAYS } from "@/lib/plan";
import { done, is, part } from "./check";

const html = renderToStaticMarkup(createElement(Pricing));
const buttons = [...html.matchAll(/<a data-cycle-link[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);

part("plans not on sale: the buttons say what the link does today");
is("plans are not on sale", PLANS_ON_SALE, false);
is("one button a plan", buttons.length, TIERS.length);
for (const tier of TIERS) {
  is(`${tier}: no "Start on ${PLAN_TITLES[tier]}"`, html.includes(`>Start on ${PLAN_TITLES[tier]}</a>`), false);
  is(`${tier}: the button starts the store and names its plan`, buttons.some((b) => b.startsWith(startWords(TRIAL_DAYS)) && b.includes(PLAN_TITLES[tier])), true);
}
is("each button's words are its own", new Set(buttons).size, buttons.length);

part("plans not on sale: the terms are said of when plans open, with the same figures");
for (const words of [
  `When plans open: ${TRIAL_DAYS} days. Your card is taken when it starts, so you can sell before you decide.`,
  "on the day the trial ends. We email you a week before.",
  `When plans open: Ask within ${REFUND_DAYS} days of your first payment and it comes back in full, for any reason or none.`,
  "When plans open: Two clicks in your studio, any time. Inside the trial, the card is never charged.",
  `When plans open, the free ${TRIAL_DAYS} days are for your first store; a second store is paid from its first day.`,
]) is(`the terms say "${words}"`, html.includes(words), true);
is("no plan's first charge is said as if it could happen today", /First charge<\/dt><dd[^>]*>(?!When plans open)/.test(html), false);
is("no trial is said as if it could start today", html.includes(`>${TRIAL_DAYS} days. Your card is taken when it starts`), false);

done();
