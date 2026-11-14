/**
 * The pricing cards on opening day (PLANS_ON_SALE true, tests/pricing-plans-open-world.ts): every word of the
 * buttons, the terms for every plan and the one-trial line is the same as before the closed-sales wording was
 * added (VR rule, item 2), so turning sales on changes nothing a reader sees on /pricing.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pricing } from "@/components/home-parts";
import { PLANS_ON_SALE } from "@/lib/opening";
import { REFUND_DAYS, TRIAL_DAYS } from "@/lib/plan";
import { done, is, part } from "./check";

const html = renderToStaticMarkup(createElement(Pricing));

part("plans on sale: the cards say what they said before");
is("this world has plans on sale", PLANS_ON_SALE, true);
for (const cta of ["Start on Store", "Start on Studio", "Start on Scale"]) is(`the button "${cta}"`, html.includes(`>${cta}</a>`), true);
for (const words of [
  `${TRIAL_DAYS} days. Your card is taken when it starts, so you can sell before you decide.`,
  "on the day the trial ends. We email you a week before.",
  `Ask within ${REFUND_DAYS} days of your first payment and it comes back in full, for any reason or none.`,
  "Two clicks in your studio, any time. Inside the trial, the card is never charged.",
  "One trial per account.",
  ` The free ${TRIAL_DAYS} days are for your first store; a second store is paid from its first day.`,
]) is(`the terms say "${words}"`, html.includes(words), true);
is("nothing is put off to when plans open", html.includes("When plans open"), false);

done();
