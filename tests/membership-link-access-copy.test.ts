import { membershipBeginnerQuestions } from "@/lib/membership-faq";
import { isLiveSub, soldAMembership } from "@/lib/membership-access";
import type { Listing } from "@/lib/store";
import { done, is, part } from "./check";

part("Membership access words distinguish hosted content from an outside link");
for (const onSale of [false, true]) {
  const answer = membershipBeginnerQuestions(onSale, 14).find(row => row.q === "What is a membership here?")?.a ?? "";
  is("the creator is told where access to an outside file or page is managed", answer.includes("For a link to a file or page on another service, you manage access on that service."), true);
  is("self-service cancellation is still explained", answer.includes("The member cancels on their own") && answer.includes("Manage or cancel") && answer.includes("Stripe's own page"), true);
}
part("The hosted membership gate follows its real state");
for (const [status, open] of [["active", true], ["trialing", true], ["canceled", false], ["unpaid", false], ["paused", false]] as const) {
  is(status, isLiveSub({ status }), open);
}
// Past due opens only while Stripe has another attempt scheduled (tests/membership-past-due-retry.test.ts).
is("past_due while Stripe retries", isLiveSub({ status: "past_due", latest_invoice: { next_payment_attempt: Math.floor(Date.now() / 1000) + 86_400 } }), true);
is("past_due with no retry scheduled", isLiveSub({ status: "past_due", latest_invoice: { next_payment_attempt: null } }), false);
const product = { recurring: { interval: "month" } } as Listing;
is("an outside delivery link is still sold as a membership", soldAMembership(product, { mode: "subscription", metadata: { kind: "membership" } }), true);
is("a payment plan is still distinguished from membership access", soldAMembership(product, { mode: "subscription", metadata: { kind: "plan" } }), false);
done();
