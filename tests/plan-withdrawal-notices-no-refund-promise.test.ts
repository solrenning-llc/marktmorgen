/**
 * Claude 5's LEVE B on #2849 (6704329663), #5285 row #2849: after a creator's
 * withdrawal from their plan is recorded but the refund was not made at once,
 * the page's notices ("handled", "pending", "unreached") and the two lines
 * about the note to support assumed a refund is owed ("our support team
 * handles your refund", "email ... to get your refund"). They show in every
 * case that reaches support, among them a payment Stripe could not read, where
 * the plan may be 200 days old and nothing is owed. Held here: none of them
 * promises a refund; each says, as the receipt does, that support checks the
 * payment and any refund owed. The notices that follow a refund actually made
 * ("refunded", "ending") keep saying so.
 */
import { PLAN_ACK_WORDS, PLAN_WITHDRAW_WORDS as W } from "@/lib/plan-withdrawal-words";
import { done, is, part } from "./check";

const PROMISE = /\b(handles your refund|get your refund|pass (on )?your refund|your refund is not)\b/i;
const CHECKED = "any refund owed to you";

part("After the statement, the notices that reach support promise no refund");
for (const state of ["handled", "pending", "unreached"] as const) {
  const notice = W.notices[state];
  is(`${state}: a notice exists`, Boolean(notice), true);
  is(`${state}: no refund promised in its title or body`, PROMISE.test(`${notice.title} ${notice.body}`), false);
}
is("handled: says support checks the payment and any refund owed", W.notices.handled.body.includes(CHECKED), true);
is("unreached: says the email lets support check the payment and any refund owed", W.notices.unreached.body.includes(CHECKED), true);

part("The two lines about the note to support promise no refund either");
is("supportUnsent: no refund promised", PROMISE.test(W.supportUnsent), false);
is("supportGiveUp: no refund promised", PROMISE.test(W.supportGiveUp("sub_123")), false);
is("supportGiveUp: still names the subscription and the support address", [W.supportGiveUp("sub_123").includes("sub_123"), W.supportGiveUp("sub_123").includes("support@marktmorgen.com")], [true, true]);
is("supportGiveUp: says support checks the payment and any refund owed", W.supportGiveUp("sub_123").includes(CHECKED), true);

part("Control: a refund actually made is still said as made, and the receipt stays neutral");
is("refunded: says the payment was refunded", W.notices.refunded.title.includes("refunded"), true);
is("the receipt's next step promises no amount", /in full|\$\d/.test(PLAN_ACK_WORDS.ackNext("x")), false);

done();
