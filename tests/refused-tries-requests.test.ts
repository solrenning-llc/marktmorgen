/**
 * A payment request's or an agreement's email that the sender refuses for
 * certain every time (rule 30; Claude 5's MEDIUM on the -v3 branches, 9
 * November 2026): lib/payment-requests.ts (the daily reminders and
 * remindNow) and lib/agreements.ts (sendAgain, resendSignedCopy).
 *
 * A certain refusal is not counted as one of the request's or agreement's
 * emails, so neither the daily job nor the 24 hours between presses held the
 * next try back; and a refusal can come after the store's figure was taken
 * (a stop before the request since #3377, a 4xx after it: a 422 here). Each
 * daily run, and each press, took one more of the store's emails. Each
 * refusal is now counted (lib/refused-tries.ts): the reminders by themselves
 * stop at REFUSED_TRIES and say so; a press past it a day takes nothing and
 * says when to try again. Synthetic stores; the sender is a stand-in for
 * `fetch`, so no real email is sent.
 */
import { NextRequest } from "next/server";
import { POST as requestsRoute } from "@/app/api/store/payment-requests/route";
import { POST as agreementsRoute } from "@/app/api/store/agreements/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readRequest } from "@/lib/payment-request-store";
import { remindNow, sendDueReminders } from "@/lib/payment-requests";
import { nextReminderAt } from "@/lib/payment-request-rules";
import { allowanceUsed } from "@/lib/store-allowance";
import { readAgreement, signAgreement } from "@/lib/agreement-store";
import { resendSignedCopy, sendAgain } from "@/lib/agreements";
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

const REFUSED = () => new Response(JSON.stringify({ message: "not a valid address" }), { status: 422 });
const DAY = 86_400_000;

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Mara's Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1Ref${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "owner-refused-requests@example.com";
  const store = await paidStore(OWNER, "refusedreq");
  const session = await openSession(OWNER, "passkey", "pk-owner-refused-req");
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
  const requestBody = (email: string, autoReminders: number) => ({ action: "create", email, name: "Dana", lines: [{ text: "Coaching, October", quantity: 1, amount: "480" }], note: "", dueDate: "", autoReminders, consent: true });
  const agreementBody = (email: string) => ({ action: "create", kind: "agreement", email, name: "Dana Reyes", title: "Coaching", body: "Twelve weekly calls.", lines: [], consent: true });
  const used = () => allowanceUsed(store, "email");

  part("Payment request: its reminders by themselves, refused for certain every day");
  const auto = await post(requestsRoute, "payment-requests", requestBody("ana-auto@example.com", 3), null);
  const autoId = String(auto.body.id);
  let before = posts;
  let taken = await used();
  const due = Date.now() + 7 * DAY + 3_600_000;
  senderAnswer = REFUSED;
  for (let day = 0; day < 6; day += 1) await sendDueReminders(Date.now() + 20_000, due + day * DAY);
  senderAnswer = null;
  const stopped = (await readRequest(autoId))!;
  is("six daily runs ask the sender at most REFUSED_TRIES (3) times", posts - before, 3);
  is("and take the store's figure at most 3 times", (await used()) - taken, 3);
  is("the reminders by themselves stop: no next reminder is shown", nextReminderAt(stopped, due + 6 * DAY), null);
  is("its row says they stopped, and that it can still be sent by hand", [/stopped/.test(stopped.failed), /send it/i.test(stopped.failed)], [true, true]);

  part("Payment request: a reminder by hand, refused for certain on every press");
  const hand = await post(requestsRoute, "payment-requests", requestBody("ben-hand@example.com", 0), null);
  const handId = String(hand.body.id);
  before = posts;
  taken = await used();
  const answers: Awaited<ReturnType<typeof remindNow>>[] = [];
  senderAnswer = REFUSED;
  for (let press = 0; press < 6; press += 1) answers.push(await remindNow(store, handId, Date.now() + 2 * DAY));
  senderAnswer = null;
  is("six presses ask the sender at most 3 times", posts - before, 3);
  is("and take the store's figure at most 3 times", (await used()) - taken, 3);
  const fourth = answers[3];
  is("a press past them is refused, saying when to try again", [fourth.ok, !fourth.ok && /tomorrow/.test(fourth.why)], [false, true]);

  part("Agreement: sent again by hand, refused for certain on every press");
  const made = await post(agreementsRoute, "agreements", agreementBody("cal-agree@example.com"), null);
  const agreementId = String(made.body.id);
  before = posts;
  taken = await used();
  const again: Awaited<ReturnType<typeof sendAgain>>[] = [];
  senderAnswer = REFUSED;
  for (let press = 0; press < 6; press += 1) again.push(await sendAgain(store, agreementId, Date.now() + 2 * DAY));
  senderAnswer = null;
  is("six presses ask the sender at most 3 times", posts - before, 3);
  is("and take the store's figure at most 3 times", (await used()) - taken, 3);
  is("a press past them is refused, saying when to try again", [again[3].ok, !again[3].ok && /tomorrow/.test(again[3].why)], [false, true]);

  part("Agreement: the signed copy again by hand, refused for certain on every press");
  const toSign = await post(agreementsRoute, "agreements", agreementBody("dee-sign@example.com"), null);
  const open = (await readAgreement(String(toSign.body.id)))!;
  const signed = await signAgreement(store, open.id, { n: 1, sha256: open.versions[0].sha256, name: "Dee Lane", email: "dee-sign@example.com", consent: true, ip: "198.51.100.4" }, "Dee Lane", Date.now());
  if (!signed.ok) throw new Error(`Synthetic signature was refused: ${signed.reason}`);
  before = posts;
  taken = await used();
  const copies: Awaited<ReturnType<typeof resendSignedCopy>>[] = [];
  senderAnswer = REFUSED;
  for (let press = 0; press < 6; press += 1) copies.push(await resendSignedCopy(store, open.id, Date.now() + 2 * DAY));
  senderAnswer = null;
  is("six presses ask the sender at most 3 times", posts - before, 3);
  is("and take the store's figure at most 3 times", (await used()) - taken, 3);
  is("a press past them is refused, saying when to try again", [copies[3].ok, !copies[3].ok && /tomorrow/.test(copies[3].why)], [false, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
