/**
 * The studio's "What you pay us" card never shows a price Stripe did not
 * confirm (VR item 2), and a creator whose trial ends or whose yearly plan
 * renews within seven days is told so at the top of the studio, from what
 * was already read on this load.
 *
 * Before: when readSubscription could not reach Stripe ("unknown"), the date
 * disappeared but the amount fell back to the price list ("Subscribed at $69
 * a month."), a figure nobody had checked, with no word that it was not
 * checked. Now an unconfirmed read says so, with no amount and no date, and
 * the studio's code has no price-list fallback for the plan the creator is on.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as notices from "@/components/renewal-unpaid-notice";
import { done, is, part } from "./check";

const page = readFileSync("app/studio/page.tsx", "utf8");
const parts = notices as unknown as Record<string, unknown>;
type Live = Record<string, unknown> | null;
type Due = { kind: "trial" | "renewal"; at: number; amountCents: number; cycle: "month" | "year" } | null;
const planDueSoon = typeof parts.planDueSoon === "function" ? (parts.planDueSoon as (live: Live, now: number) => Due) : null;
const planAmountWords = typeof parts.planAmountWords === "function" ? (parts.planAmountWords as (cents: number, cycle: "month" | "year") => string) : null;
const PlanDueSoonNotice = typeof parts.PlanDueSoonNotice === "function" ? (parts.PlanDueSoonNotice as (props: { due: NonNullable<Due> }) => null) : null;
const PlanUnconfirmedNotice = typeof parts.PlanUnconfirmedNotice === "function" ? (parts.PlanUnconfirmedNotice as () => null) : null;

function render(element: ReturnType<typeof createElement> | null): string {
  if (!element) return "";
  try {
    return renderToStaticMarkup(element);
  } catch (error) {
    return `render failed: ${(error as Error).message}`;
  }
}

const DAY = 86_400;
const NOW = Date.UTC(2027, 2, 1) / 1000; // March 1, 2027, 00:00 UTC
const active = (over: Record<string, unknown>): Record<string, unknown> => ({
  state: "active", trialing: false, until: NOW + 3 * DAY, cancelsAtEnd: false, tier: "creator", cycle: "year",
  amountCents: 69_000, shared: false, changePending: false, renewalUnpaid: false, period: null, ...over,
});

part("the card's amount is only ever the one Stripe confirmed");
is("no price-list fallback for the plan the creator is on", page.includes('priceWords(tier, billedYearly ? "year" : "month")'), false);
is("the amount comes from the read, or is unknown", page.includes('live?.state === "active" && live.amountCents > 0 ? planAmountWords(live.amountCents, live.cycle) : null'), true);
is(
  "without it the card says it could not check, in place of the amount and the date",
  page.includes("{billedNow === null ? (\n                      <PlanUnconfirmedNotice />\n                    ) : ("),
  true,
);
is("the sentences with an amount are still the card's own", [page.includes("After it: ${billedNow}"), page.includes("`Subscribed at ${billedNow}.")], [true, true]);

part("how an amount is written");
is("whole dollars", planAmountWords?.(6_900, "month") ?? null, "$69 a month");
is("thousands as they are said", planAmountWords?.(449_000, "year") ?? null, "$4,490 a year");
is("cents when there are cents", planAmountWords?.(6_950, "month") ?? null, "$69.50 a month");

part("the notice only when a charge is seven days away or less, from the read already made");
const due = (live: Live) => (planDueSoon ? planDueSoon(live, NOW) : "missing");
is("a yearly renewal in three days", due(active({})), { kind: "renewal", at: NOW + 3 * DAY, amountCents: 69_000, cycle: "year" });
is("a yearly renewal exactly seven days away", (due(active({ until: NOW + 7 * DAY })) as Due)?.kind ?? null, "renewal");
is("not eight days away", due(active({ until: NOW + 7 * DAY + 1 })), null);
is("a trial ending in two days, monthly after", due(active({ trialing: true, cycle: "month", amountCents: 6_900, until: NOW + 2 * DAY })), { kind: "trial", at: NOW + 2 * DAY, amountCents: 6_900, cycle: "month" });
is("a trial ending in two days, yearly after", (due(active({ trialing: true, until: NOW + 2 * DAY })) as Due)?.kind ?? null, "trial");
is("not a monthly renewal", due(active({ cycle: "month", amountCents: 6_900 })), null);
is("not when it is set to stop", due(active({ cancelsAtEnd: true })), null);
is("not a trial set to stop", due(active({ trialing: true, cancelsAtEnd: true })), null);
is("not while a change of billing waits on the bank", due(active({ changePending: true })), null);
is("not while the renewal is unpaid (that notice is its own)", due(active({ renewalUnpaid: true })), null);
is("not without an amount from Stripe", due(active({ amountCents: 0 })), null);
is("not without a date from Stripe", due(active({ until: 0 })), null);
is("not a date already past", due(active({ until: NOW - 1 })), null);
is("not when Stripe could not be asked", due({ state: "unknown" }), null);
is("not when it does not pay", due({ state: "inactive", reason: "canceled" }), null);
is("not without a subscription", due(null), null);

part("the notice says the date and the amount, the card's way, and links to the card");
const renewal = render(PlanDueSoonNotice ? createElement(PlanDueSoonNotice, { due: { kind: "renewal", at: Date.UTC(2027, 2, 3) / 1000, amountCents: 69_000, cycle: "year" } }) : null);
const trial = render(PlanDueSoonNotice ? createElement(PlanDueSoonNotice, { due: { kind: "trial", at: Date.UTC(2027, 2, 3) / 1000, amountCents: 6_900, cycle: "month" } }) : null);
is("renewal: date and amount", renewal.includes("Your plan renews on March 3, 2027 at $690 a year."), true);
is("trial: date and amount", trial.includes("Your trial ends on March 3, 2027; then $69 a month."), true);
is("a status region with its own heading", [renewal, trial].map((html) => /<section id="plan-due-soon" role="status" aria-labelledby="plan-due-soon-title"/.test(html) && /<h2 id="plan-due-soon-title"/.test(html)), [true, true]);
is(
  "a 44-pixel link to the card whose words say where it goes",
  [renewal, trial].map((html) => /<a href="#billing" class="[^"]*inline-flex[^"]*min-h-11[^"]*">See or cancel your plan<\/a>/.test(html)),
  [true, true],
);
is("never promises the exact amount charged", [renewal, trial].map((html) => /will be charged|exactly|guarantee/i.test(html)), [false, false]);
is("the meaning is in the words, not the color", [renewal.includes("renews on"), trial.includes("ends on")], [true, true]);

part("the unconfirmed card says so, with no figure and no date");
const unconfirmed = render(PlanUnconfirmedNotice ? createElement(PlanUnconfirmedNotice) : null);
is("a status region that says it could not confirm", /role="status"/.test(unconfirmed) && unconfirmed.includes("We could not confirm your plan with Stripe just now"), true);
is("no amount and no date", [unconfirmed.includes("$"), /January|February|March|April|May|June|July|August|September|October|November|December/.test(unconfirmed)], [false, false]);
is("a way to a person, 44 pixels high", /<a href="mailto:[^"]+" class="[^"]*min-h-11[^"]*">/.test(unconfirmed), true);

part("the studio draws the notice from the read it already made, only for billing");
is("drawn under the unpaid-renewal notice, for billing only", page.includes("{current && unpaidSince > 0 ? <RenewalUnpaidNotice payUrl={renewalPage} canPay={may(\"billing\")} /> : null}\n        {billingReady && may(\"billing\") && planDue ? <PlanDueSoonNotice due={planDue} /> : null}"), true);
is("from the subscription already read on this load", page.includes("const planDue = planDueSoon(live, nowSeconds());"), true);
is("Stripe is still asked once per load", page.split("readSubscription(").length - 1, 1);

done();
