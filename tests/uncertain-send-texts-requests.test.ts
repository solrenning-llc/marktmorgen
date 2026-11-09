/**
 * A payment request's or an agreement's email whose send is not known
 * (rule 30, a sibling of 283 [HG2] unit 1's sendEmailOutcome):
 * lib/payment-requests.ts sendRequestEmail and remindNow, lib/agreements.ts
 * sendAgreementEmail, sendSignedCopies and resendSignedCopy, their routes,
 * the readers of their answers and the studio's words.
 *
 * Found 9 November 2026: a sender's answer that was not known (a 5xx, a
 * network error after the request may have reached it) was written down as
 * "Not sent: ... You can send it again from here." The email may have
 * arrived. The record's count did not move, so the next email used the same
 * idempotency key, kept by the sender for 24 hours only: a send pressed a day
 * later was a second copy. Checked:
 *
 *   - payment request, the sender answers 500: counted as one of its emails
 *     (so its 24 hours before another, its count and the next email's own key
 *     all move on), said in its row as not confirmed, never "Not sent"; the
 *     route answers ok with `sent: false, uncertain: true`; another send
 *     within the day is refused by the existing rule, and nothing posts;
 *   - the same for a network error, and for a reminder by hand;
 *   - a 422 (a certain refusal): "Not sent", not counted, as before (control);
 *   - agreement, create, resend and the signed copy: the same;
 *   - the readers of the routes' answers keep `uncertain` only when own and true;
 *   - the studio's words for each answer.
 *
 * Synthetic stores and sessions; the sender is a stand-in for `fetch`, so no
 * real email is sent.
 */
import { NextRequest } from "next/server";
import { POST as requestsRoute } from "@/app/api/store/payment-requests/route";
import { POST as agreementsRoute } from "@/app/api/store/agreements/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readRequest } from "@/lib/payment-request-store";
import { remindNow, sendRequestEmail } from "@/lib/payment-requests";
import { paymentRequestReply } from "@/lib/payment-request-reply";
import { agreementReply } from "@/lib/agreement-reply";
import { readAgreement, signAgreement } from "@/lib/agreement-store";
import { resendSignedCopy, sendAgain, sendSignedCopies } from "@/lib/agreements";
import * as requestsStudio from "@/components/payment-requests-studio";
import * as agreementsStudio from "@/components/agreements-studio";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
process.env.STRIPE_SECRET_KEY = "sk_test_uncertain_requests_only_a_stand_in";

let posts = 0;
let senderAnswer: (() => Response) | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    posts += 1;
    if (senderAnswer) return senderAnswer();
    return new Response(JSON.stringify({ id: `email_${posts}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const SERVER_ERROR = () => new Response("{}", { status: 500 });
const REFUSED = () => new Response(JSON.stringify({ message: "not a valid address" }), { status: 422 });
const THROWN = () => { throw new TypeError("network error"); };
const UNCONFIRMED = "We could not confirm it was sent. It may still arrive; check before sending again.";
const NOT_SENT = "Not sent: your store's emails for this month may be used, or email could not be sent just now. You can send it again from here.";
const DAY = 86_400_000;

// Read off the modules, so this file still runs (and fails) before the studio's words exist.
const said = (mod: Record<string, unknown>, name: string, ...args: unknown[]): string => {
  const words = mod[name];
  return typeof words === "function" ? String(words(...args)) : `(no ${name})`;
};

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Mara's Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1Unc${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "owner-uncertain-requests@example.com";
  const store = await paidStore(OWNER, "unsurereq");
  const session = await openSession(OWNER, "passkey", "pk-owner-unsure-req");
  const post = async (route: typeof requestsRoute, path: string, body: Record<string, unknown>, answer: (() => Response) | null) => {
    senderAnswer = answer;
    const response = await route(
      new NextRequest(`https://marktmorgen.com/api/store/${path}?store=${store.sid}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" },
        body: JSON.stringify(body),
      }),
    );
    senderAnswer = null;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const requestBody = (email: string) => ({ action: "create", email, name: "Dana", lines: [{ text: "Coaching, October", quantity: 1, amount: "480" }], note: "", dueDate: "", autoReminders: 2, consent: true });
  const agreementBody = (email: string) => ({ action: "create", kind: "agreement", email, name: "Dana Reyes", title: "Coaching", body: "Twelve weekly calls.", lines: [], consent: true });

  part("Payment request: the sender's answer not known");
  let before = posts;
  const unsure = await post(requestsRoute, "payment-requests", requestBody("ana-unsure@example.com"), SERVER_ERROR);
  is("a 500: ok, not sent, said to be not confirmed", [unsure.status, unsure.body.ok, unsure.body.sent, unsure.body.uncertain], [200, true, false, true]);
  const kept = (await readRequest(String(unsure.body.id)))!;
  is("counted as one of its emails, its row says it is not confirmed", [kept.sent.length, kept.failed], [1, UNCONFIRMED]);
  const soon = await remindNow(store, kept.id, Date.now() + 3_600_000);
  is("another send within the day is refused by the existing rule", soon.ok, false);
  is("and only the one request reached the sender", posts - before, 1);

  senderAnswer = THROWN;
  const thrownMade = await post(requestsRoute, "payment-requests", requestBody("ben-unsure@example.com"), THROWN);
  is("a thrown request: the same", [thrownMade.body.ok, thrownMade.body.sent, thrownMade.body.uncertain, (await readRequest(String(thrownMade.body.id)))?.failed], [true, false, true, UNCONFIRMED]);

  part("Payment request: a reminder by hand whose send is not known");
  const plain = await post(requestsRoute, "payment-requests", requestBody("cal-plain@example.com"), null);
  is("a plain yes first (control)", [plain.body.ok, plain.body.sent, "uncertain" in plain.body, (await readRequest(String(plain.body.id)))?.sent.length], [true, true, false, 1]);
  const later = Date.now() + 2 * DAY;
  senderAnswer = SERVER_ERROR;
  const reminded = await remindNow(store, String(plain.body.id), later);
  senderAnswer = null;
  is("a reminder answered 500: not sent, said to be not confirmed", reminded.ok ? [reminded.sent, (reminded as Record<string, unknown>).uncertain] : reminded, [false, true]);
  is("and counted, with its row's words", [(await readRequest(String(plain.body.id)))?.sent.length, (await readRequest(String(plain.body.id)))?.failed], [2, UNCONFIRMED]);

  part("Payment request: a certain refusal is said as before (control)");
  const refused = await post(requestsRoute, "payment-requests", requestBody("dot-refused@example.com"), REFUSED);
  const refusedRow = (await readRequest(String(refused.body.id)))!;
  is("a 422: ok, not sent, no uncertain", [refused.body.ok, refused.body.sent, "uncertain" in refused.body], [true, false, false]);
  is("not counted, and the row says Not sent", [refusedRow.sent.length, refusedRow.failed], [0, NOT_SENT]);
  const direct = await sendRequestEmail(store, refusedRow);
  is("a later yes clears it (control)", [direct.sent, (await readRequest(refusedRow.id))?.failed, (await readRequest(refusedRow.id))?.sent.length], [true, "", 1]);

  part("Agreement: the sender's answer not known");
  before = posts;
  const agreed = await post(agreementsRoute, "agreements", agreementBody("eve-unsure@example.com"), SERVER_ERROR);
  is("a 500: ok, not sent, said to be not confirmed", [agreed.status, agreed.body.ok, agreed.body.sent, agreed.body.uncertain], [200, true, false, true]);
  const kept2 = (await readAgreement(String(agreed.body.id)))!;
  is("counted as one of its emails, its row says it is not confirmed", [kept2.sent.length, kept2.failed], [1, UNCONFIRMED]);
  const again = await sendAgain(store, kept2.id, Date.now() + 3_600_000);
  is("another send within the day is refused by the existing rule", [again.ok, posts - before], [false, 1]);
  const resent = await post(agreementsRoute, "agreements", { action: "resend", id: kept2.id }, SERVER_ERROR);
  is("resend from the route at once: refused, nothing posted", [resent.body.ok, posts - before], [false, 1]);
  senderAnswer = SERVER_ERROR;
  const resentLater = await sendAgain(store, kept2.id, Date.now() + 2 * DAY);
  senderAnswer = null;
  is("resend a day later, answered 500: not sent, said to be not confirmed", resentLater.ok ? [resentLater.sent, (resentLater as Record<string, unknown>).uncertain] : resentLater, [false, true]);
  is("and counted", (await readAgreement(kept2.id))?.sent.length, 2);

  part("Agreement: a certain refusal is said as before (control)");
  const agreedRefused = await post(agreementsRoute, "agreements", agreementBody("fay-refused@example.com"), REFUSED);
  const refusedAgreement = (await readAgreement(String(agreedRefused.body.id)))!;
  is("a 422: ok, not sent, no uncertain", [agreedRefused.body.ok, agreedRefused.body.sent, "uncertain" in agreedRefused.body], [true, false, false]);
  is("not counted, the row says Not sent", [refusedAgreement.sent.length, refusedAgreement.failed], [0, NOT_SENT]);

  part("Agreement: the signed copy whose send is not known");
  const toSign = await post(agreementsRoute, "agreements", agreementBody("gus-sign@example.com"), null);
  const open = (await readAgreement(String(toSign.body.id)))!;
  const signed = await signAgreement(store, open.id, { n: 1, sha256: open.versions[0].sha256, name: "Gus Lane", email: "gus-sign@example.com", consent: true, ip: "198.51.100.4" }, "Gus Lane", Date.now());
  if (!signed.ok) throw new Error(`Synthetic signature was refused: ${signed.reason}`);
  senderAnswer = SERVER_ERROR;
  const copies = await sendSignedCopies(store, signed.agreement, signed.version, signed.signature);
  senderAnswer = null;
  const afterCopies = (await readAgreement(open.id))!;
  is("signed copies answered 500: none counted as sent", [copies.signer, afterCopies.copies], [false, 0]);
  is("its row says it is not confirmed, never Not sent", afterCopies.failed, UNCONFIRMED);
  senderAnswer = SERVER_ERROR;
  const copyAgain = await resendSignedCopy(store, open.id, Date.now() + 2 * DAY);
  senderAnswer = null;
  is("the signed copy again, answered 500: not sent, said to be not confirmed", copyAgain.ok ? [copyAgain.sent, (copyAgain as Record<string, unknown>).uncertain] : copyAgain, [false, true]);
  is("counted as one of its emails, with its row's words", [(await readAgreement(open.id))?.sent.length, (await readAgreement(open.id))?.failed], [2, UNCONFIRMED]);
  senderAnswer = REFUSED;
  const copyRefused = await resendSignedCopy(store, open.id, Date.now() + 4 * DAY);
  senderAnswer = null;
  is("a 422 on the signed copy: not sent, Not sent (control)", [copyRefused.ok && copyRefused.sent, copyRefused.ok && "uncertain" in copyRefused, (await readAgreement(open.id))?.failed, (await readAgreement(open.id))?.sent.length], [false, false, NOT_SENT, 2]);

  part("The readers of the routes' answers");
  const id = "a".repeat(32);
  is("payment request: own true uncertain is kept", paymentRequestReply(true, { ok: true, id, sent: false, uncertain: true }, "create"), { ok: true, sent: false, uncertain: true });
  is("payment request: remind too", paymentRequestReply(true, { ok: true, sent: false, uncertain: true }, "remind"), { ok: true, sent: false, uncertain: true });
  is("payment request: not true, or inherited, is not", [
    paymentRequestReply(true, { ok: true, id, sent: false, uncertain: "yes" }, "create"),
    paymentRequestReply(true, Object.assign(Object.create({ uncertain: true }), { ok: true, id, sent: false }), "create"),
  ], [{ ok: true, sent: false }, { ok: true, sent: false }]);
  is("agreement: uncertain read only when own and true", [
    agreementReply(true, { ok: true, id, sent: false, uncertain: true }, "create").uncertain,
    agreementReply(true, { ok: true, sent: false, uncertain: "yes" }, "resend").uncertain,
  ], [true, undefined]);

  part("The studio's words");
  const rq = requestsStudio as unknown as Record<string, unknown>;
  const ag = agreementsStudio as unknown as Record<string, unknown>;
  is("request made, sent", said(rq, "requestSentWords", "create", { sent: true }), "Request sent.");
  is("request made, not confirmed", said(rq, "requestSentWords", "create", { sent: false, uncertain: true }), "Request saved, but we could not confirm its email was sent. It may still arrive; check before sending again.");
  is("request made, refused (as before)", said(rq, "requestSentWords", "create", { sent: false }), "Request saved, but its email did not go. Send it again from the list.");
  is("reminder, sent", said(rq, "requestSentWords", "remind", { sent: true }), "Reminder sent.");
  is("reminder, not confirmed", said(rq, "requestSentWords", "remind", { sent: false, uncertain: true }), "We could not confirm the reminder was sent. It may still arrive; check before sending again.");
  is("reminder, refused (as before)", said(rq, "requestSentWords", "remind", { sent: false }), "The reminder did not go. Your store's emails for this month may be used.");
  is("agreement made / revised, sent (as before)", [said(ag, "agreementSentWords", "create", { sent: true }), said(ag, "agreementSentWords", "revise", { sent: true })], ["Sent for signature.", "New version sent. It needs a new signature."]);
  is("agreement made / revised, not confirmed", [said(ag, "agreementSentWords", "create", { sent: false, uncertain: true }), said(ag, "agreementSentWords", "revise", { sent: false, uncertain: true })], Array(2).fill("Saved, but we could not confirm its email was sent. It may still arrive; check before sending again."));
  is("agreement made, refused (as before)", said(ag, "agreementSentWords", "create", { sent: false }), "Saved, but its email did not go. Send it again from the list.");
  is("resend and copy, sent (as before)", [said(ag, "agreementSentWords", "resend", { sent: true }), said(ag, "agreementSentWords", "copy", { sent: true })], ["Sent again.", "Signed copy sent again."]);
  is("resend and copy, not confirmed", [said(ag, "agreementSentWords", "resend", { sent: false, uncertain: true }), said(ag, "agreementSentWords", "copy", { sent: false, uncertain: true })], Array(2).fill("We could not confirm the email was sent. It may still arrive; check before sending again."));
  is("resend, refused (as before)", said(ag, "agreementSentWords", "resend", { sent: false }), "The email did not go. Your store's emails for this month may be used.");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
