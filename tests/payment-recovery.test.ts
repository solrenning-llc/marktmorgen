/**
 * Telling members about a payment, more than once if the creator chooses, and
 * before their card stops working (lib/dunning-rules.ts, lib/payment-recovery.ts,
 * lib/card-update.ts, lib/payment-recovery-report.ts; added 12 October 2026).
 * Checked:
 *
 *   - the setting reads only what is offered, and is one email and the card
 *     notice for a store that never chose;
 *   - a second and third email go 3 and 7 days after the first, one at a
 *     time, only when chosen and only while the payment is still unpaid, and
 *     say they are a reminder;
 *   - a first email from before reminders existed gets none;
 *   - a card good to the end of its month is not "expiring" for a payment in
 *     that month; one that ends before the next payment, within ten days, is
 *     told once per card, with a link to a page that saves a new card;
 *   - that page's Stripe page saves a card and charges nothing; coming back
 *     puts the card on that membership, and pays a payment already failed;
 *   - a link names one membership of one customer of one store;
 *   - what came back is counted: renewals paid after failing, and those
 *     paid after an email.
 */
import { cardLapsesBefore, cardNoticeDue, parseDunning, reminderDue } from "@/lib/dunning-rules";
import { cardNoticeEmail, failedPaymentEmail, recoverFailedPayments } from "@/lib/payment-recovery";
import { cardGrant, cardView, finishCardUpdate, openCardUpdate } from "@/lib/card-update";
import { membershipWords } from "@/lib/buyer-words/membership";
import { recoveredFrom, recoveryReport } from "@/lib/payment-recovery-report";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400_000;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

type Mail = { to: string[] | string; subject: string; text: string };
const mails: Mail[] = [];
const posts: { path: string; body: URLSearchParams }[] = [];

/** What Stripe holds, changed as the test goes. */
const state = {
  pastDue: [] as Record<string, unknown>[],
  active: [] as Record<string, unknown>[],
  sessions: new Map<string, Record<string, unknown>>(),
  subs: new Map<string, Record<string, unknown>>(),
  invoices: [] as Record<string, unknown>[],
  payDeclines: false,
  /** When set, what Stripe answers the POST that sets the card (else the membership with the card asked for). */
  setReply: undefined as unknown,
  /** The HTTP status of the POST that sets the card (with `setReply`); 200 unless a test asks otherwise. */
  setStatus: 200,
  /** When set, what Stripe answers the invoice's pay (else the invoice paid); `payStatus` its HTTP status. */
  payReply: undefined as unknown,
  payStatus: 200,
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)) as Mail);
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (method === "POST") posts.push({ path, body: new URLSearchParams(String(init?.body ?? "")) });
  if (path === "/subscriptions" && method === "GET") {
    const status = url.searchParams.get("status");
    return answer({ object: "list", data: status === "past_due" ? state.pastDue : status === "active" ? state.active : [], has_more: false });
  }
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "GET") return state.subs.has(sub[1]) ? answer(state.subs.get(sub[1])) : answer({ error: { message: "no such" } }, 404);
  if (sub && method === "POST") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    return state.setReply !== undefined ? answer(state.setReply, state.setStatus) : answer({ id: sub[1], default_payment_method: body.get("default_payment_method") });
  }
  if (path === "/checkout/sessions" && method === "POST") {
    const id = `cs_test_${"c".repeat(20)}${state.sessions.size}`;
    state.sessions.set(id, { id, mode: "setup", status: "open", customer: "cus_Member000001", metadata: Object.fromEntries([...new URLSearchParams(String(init?.body))].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) });
    return answer({ id, url: `https://checkout.stripe.com/c/setup/${id}` });
  }
  const session = path.match(/^\/checkout\/sessions\/(cs_test_\w+)$/);
  if (session) return answer(state.sessions.has(session[1]) ? state.sessions.get(session[1]) : {});
  const pay = path.match(/^\/invoices\/(in_\w+)\/pay$/);
  if (pay) return state.payDeclines ? answer({ error: { code: "card_declined", message: "Your card was declined." } }, 402) : state.payReply !== undefined ? answer(state.payReply, state.payStatus) : answer({ id: pay[1], status: "paid" });
  if (path === "/invoices" && method === "GET") return answer({ object: "list", data: state.invoices, has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const subjects = () => mails.map((m) => m.subject);
const run = () => recoverFailedPayments(Date.now() + 20_000);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recovery_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
  redis.clear();

  part("The setting");
  is("a store that never chose: one email, and the card notice", parseDunning(undefined), { reminders: 1, cardNotice: true });
  is("only what is offered", [parseDunning({ reminders: 3, cardNotice: false }), parseDunning({ reminders: 5, cardNotice: "yes" })], [{ reminders: 3, cardNotice: false }, { reminders: 1, cardNotice: true }]);

  part("When each email is due");
  const first = Date.UTC(2026, 9, 1, 9);
  is("one chosen: never a second", reminderDue(1, first, 1, first + 30 * DAY), 0);
  is("three chosen: the second from day 3, the third from day 7", [
    reminderDue(3, first, 1, first + 2 * DAY),
    reminderDue(3, first, 1, first + 3 * DAY),
    reminderDue(3, first, 2, first + 6 * DAY),
    reminderDue(3, first, 2, first + 7 * DAY),
    reminderDue(3, first, 3, first + 30 * DAY),
  ], [0, 2, 0, 3, 0]);
  is("a missed day sends the next one, never two", reminderDue(3, first, 1, first + 9 * DAY), 2);

  part("When a card stops working");
  const oct31 = Date.UTC(2026, 9, 31, 12) / 1000;
  const nov1 = Date.UTC(2026, 10, 1, 12) / 1000;
  is("10/2026 still pays on October 31, not on November 1", [cardLapsesBefore(10, 2026, oct31), cardLapsesBefore(10, 2026, nov1)], [false, true]);
  is("told only inside the ten days", [
    cardNoticeDue({ expMonth: 10, expYear: 2026 }, nov1, nov1 * 1000 - 9 * DAY),
    cardNoticeDue({ expMonth: 10, expYear: 2026 }, nov1, nov1 * 1000 - 11 * DAY),
  ], [true, false]);

  part("What the emails say");
  const reminder = failedPaymentEmail({ storeName: "Harbor Kitchen", title: "The Inner Circle", amount: "$29.00", payUrl: "https://invoice.stripe.com/i/x", manageUrl: "https://x/manage", isPlan: false, nextTry: "October 15", reminder: true });
  is("a reminder says so, first", [reminder.subject, reminder.text.split("\n")[2]], ["Reminder: your payment to Harbor Kitchen still hasn't gone through", "A short reminder, in case the first email was missed."]);
  const notice = cardNoticeEmail({ storeName: "Harbor Kitchen", title: "The Inner Circle", card: "Visa ending in 4242", date: "November 1", cardUrl: "https://x/manage/card?t=abc", manageUrl: "https://x/manage", isPlan: false });
  is("the card notice names the card and the day", [notice.subject, notice.text.includes("The card you pay for The Inner Circle with, Visa ending in 4242, expires before your next payment, on November 1.")], ["Your card for Harbor Kitchen expires before your next payment", true]);
  is("in the store's language", cardNoticeEmail({ storeName: "Harbor", title: null, card: "Visa terminada en 4242", date: "1 de noviembre", cardUrl: "u", manageUrl: "m", isPlan: false, language: "es" }).subject, "Tu tarjeta para Harbor caduca antes de tu próximo pago");

  part("A store with a membership");
  const OWNER = "owner@example.com";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  let store = (await storeForEmail(OWNER))!;
  is("one email and the card notice, unless chosen", store.dunning, { reminders: 1, cardNotice: true });
  is("a setting not offered is refused", (await setDunning(OWNER, { reminders: 4, cardNotice: true })).ok, false);

  const meta = { store: "harbor", product: club.product.id };
  const failing = {
    id: "sub_Failing000001",
    status: "past_due",
    metadata: meta,
    customer: { id: "cus_Failing00001", email: "ana@example.com" },
    latest_invoice: { id: "in_Failing000001", status: "open", amount_due: 2900, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/failing", next_payment_attempt: 0 },
  };
  state.pastDue = [failing];

  part("A failed payment, with one email chosen");
  await run();
  is("the first email", subjects(), ["Your payment to Harbor Kitchen didn't go through"]);
  shift += 3 * DAY;
  await run();
  is("and no second", mails.length, 1);

  part("With three chosen");
  is("saved", (await setDunning(OWNER, { reminders: 3, cardNotice: true })).ok, true);
  store = (await storeForEmail(OWNER))!;
  await run();
  is("the second, three days on", subjects().slice(1), ["Reminder: your payment to Harbor Kitchen still hasn't gone through"]);
  await run();
  is("not twice the same day", mails.length, 2);
  shift += 4 * DAY;
  await run();
  shift += 10 * DAY;
  await run();
  is("the third, seven days on, and then no more", mails.length, 3);

  part("Paid, it stops");
  state.pastDue = [{ ...failing, id: "sub_Second0000001", customer: { id: "cus_Second000001", email: "ben@example.com" }, latest_invoice: { ...failing.latest_invoice, id: "in_Second0000001" } }];
  await run();
  is("the first about another payment", [mails.at(-1)?.to].flat(), ["ben@example.com"]);
  state.pastDue = [];
  shift += 3 * DAY;
  await run();
  is("paid: no reminder", mails.length, 4);

  part("An email from before reminders existed");
  await redis.pipeline([["SET", "nl:dun:acct_1TestHarbor0001:in_Legacy00000001", "1"]]);
  state.pastDue = [{ ...failing, id: "sub_Legacy0000001", latest_invoice: { ...failing.latest_invoice, id: "in_Legacy00000001" } }];
  shift += 8 * DAY;
  await run();
  is("gets no reminder", mails.length, 4);
  state.pastDue = [];

  part("A card that stops working before the next payment");
  const payAt = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const payDay = new Date(payAt * 1000);
  // A card printed with last month: it stops working before payAt.
  const lastMonth = new Date(Date.UTC(payDay.getUTCFullYear(), payDay.getUTCMonth() - 1, 1));
  const running = {
    id: "sub_Running000001",
    status: "active",
    metadata: meta,
    customer: { id: "cus_Member000001", email: "cy@example.com", invoice_settings: { default_payment_method: null } },
    items: { data: [{ current_period_end: payAt }] },
    default_payment_method: { id: "pm_OldCard0000001", type: "card", card: { brand: "visa", last4: "4242", exp_month: lastMonth.getUTCMonth() + 1, exp_year: lastMonth.getUTCFullYear() } },
  };
  const later = { ...running, id: "sub_Later00000001", items: { data: [{ current_period_end: payAt + 30 * 86_400 }] } };
  const good = { ...running, id: "sub_Good000000001", default_payment_method: { ...running.default_payment_method, id: "pm_GoodCard000001", card: { ...running.default_payment_method.card, exp_year: 2099 } } };
  const ending = { ...running, id: "sub_Ending0000001", cancel_at_period_end: true };
  state.active = [running, later, good, ending];
  await run();
  const card = mails.at(-1)!;
  is("told once: only the one whose card ends before a payment within ten days", [mails.length, card.subject, [card.to].flat()], [5, "Your card for Harbor Kitchen expires before your next payment", ["cy@example.com"]]);
  is("names the card", card.text.includes("Visa ending in 4242"), true);
  await run();
  is("not told twice about the same card", mails.length, 5);
  const token = card.text.match(/manage\/card\?t=([0-9a-f]{64})/)?.[1] ?? "";
  is("with a link to the card page", token.length, 64);

  part("The card page");
  state.subs.set("sub_Running000001", { ...running, customer: "cus_Member000001", latest_invoice: null });
  const grant = await cardGrant(store, token);
  is("the link names that membership", grant, { a: "acct_1TestHarbor0001", c: "cus_Member000001", s: "sub_Running000001" });
  is("and only on its own store", await cardGrant({ ...store, stripeAccountId: "acct_1SomebodyElse01" }, token), null);
  is("reading it changes nothing", [(await cardView(store, grant!))?.title, posts.filter((p) => p.path === "/checkout/sessions").length], ["The Inner Circle", 0]);
  const opened = await openCardUpdate(store, token, "https://marktmorgen.com");
  const setup = posts.find((p) => p.path === "/checkout/sessions")?.body;
  is("the button opens Stripe's page that saves a card and charges nothing", [opened.ok, setup?.get("mode"), setup?.get("customer"), setup?.get("setup_intent_data[metadata][subscription]")], [true, "setup", "cus_Member000001", "sub_Running000001"]);

  const sessionId = [...state.sessions.keys()][0];
  is("left before saving: nothing changes", await finishCardUpdate(store, sessionId), "canceled");
  state.sessions.set(sessionId, { ...state.sessions.get(sessionId), status: "complete", setup_intent: { status: "succeeded", payment_method: "pm_NewCard0000001", metadata: { subscription: "sub_Running000001" } } });
  is("saved: the card is set on that membership", await finishCardUpdate(store, sessionId), "updated");
  is("on the membership itself", posts.filter((p) => p.path === "/subscriptions/sub_Running000001").map((p) => p.body.get("default_payment_method")), ["pm_NewCard0000001"]);

  state.subs.set("sub_Running000001", { ...running, status: "past_due", customer: "cus_Member000001", latest_invoice: { id: "in_Owed00000000001", status: "open", amount_due: 2900 } });
  is("a payment already failed is paid with it", await finishCardUpdate(store, sessionId), "paid");
  state.payDeclines = true;
  is("declined: the card is still set, and it says so", await finishCardUpdate(store, sessionId), "declined");
  state.subs.set("sub_Running000001", { ...running, customer: "cus_Somebody00001", latest_invoice: null });
  is("a membership of another customer is not touched", await finishCardUpdate(store, sessionId), "error");

  part("Rule 30: a Stripe reply decides only when it is the object asked for");
  state.payDeclines = false;
  /** NULL_BODY: an HTTP 200 whose JSON body is `null` itself (Claude 6 on #3098). */
  const NULL_BODY = "null body";
  const withId = (row: Record<string, unknown>, id: string | null): Record<string, unknown> => {
    if (id === NULL_BODY) return null as unknown as Record<string, unknown>;
    const copy = { ...row };
    if (id === null) delete copy.id;
    else copy.id = id;
    return copy;
  };
  const touched = (mark: number) => posts.slice(mark).map((p) => p.path);
  const owedElsewhere = { ...running, status: "past_due", customer: "cus_Member000001", latest_invoice: { id: "in_OtherOwed00001", status: "open", amount_due: 4900 } };
  for (const [label, other] of [["another membership's id", "sub_Another0000001"], ["no id", null], ["a null body", NULL_BODY]] as const) {
    state.subs.set("sub_Running000001", withId(owedElsewhere, other));
    const mark = posts.length;
    is(`the membership read back with ${label}: no card is set and nothing is paid on it`, [await finishCardUpdate(store, sessionId), touched(mark)], ["error", []]);
    is(`…and the page does not show it as this membership`, await cardView(store, grant!), null);
  }
  state.subs.set("sub_Running000001", { ...running, customer: "cus_Member000001", latest_invoice: null });
  const saved = state.sessions.get(sessionId)!;
  for (const [label, other] of [["another page's id", `cs_test_${"d".repeat(20)}9`], ["no id", null], ["a null body", NULL_BODY]] as const) {
    state.sessions.set(sessionId, withId(saved, other));
    const mark = posts.length;
    is(`Stripe's page read back with ${label}: no card is set from it`, [await finishCardUpdate(store, sessionId), touched(mark)], ["error", []]);
  }
  state.sessions.set(sessionId, saved);
  const mark = posts.length;
  is("control: its own page and membership still set the card", [await finishCardUpdate(store, sessionId), touched(mark)], ["updated", ["/subscriptions/sub_Running000001"]]);

  part("Rule 24: a membership whose status Stripe has no name for is unknown, never \"not ended\"");
  for (const [label, status] of [["a status Stripe never named", "a_status_stripe_never_named"], ["a status that is a number", 7], ["no status", undefined]] as const) {
    const row: Record<string, unknown> = { ...running, customer: "cus_Member000001", latest_invoice: null, status };
    if (status === undefined) delete row.status;
    state.subs.set("sub_Running000001", row);
    const before = posts.length;
    is(`${label}: the page does not show it`, await cardView(store, grant!), null);
    is(`${label}: no card is set from it`, [await finishCardUpdate(store, sessionId), touched(before)], ["error", []]);
  }
  state.subs.set("sub_Running000001", { ...running, customer: "cus_Member000001", latest_invoice: null });

  part("Rules 24 and 30: what Stripe answers the card's setting and the payment decides only when it is read");
  // The card is set, but Stripe's answer to it is not its own membership with that card: the page never says it is
  // set, nothing is paid with it, and the page stays open for the daily job to finish it.
  const owedHere = { ...running, status: "past_due", customer: "cus_Member000001", latest_invoice: { id: "in_Owed00000000001", status: "open", amount_due: 2900 } };
  state.subs.set("sub_Running000001", owedHere);
  for (const [label, reply] of [
    ["another membership's id", { id: "sub_Another0000001", default_payment_method: "pm_NewCard0000001" }],
    ["no id", { default_payment_method: "pm_NewCard0000001" }],
    ["another card", { id: "sub_Running000001", default_payment_method: "pm_OldCard0000001" }],
    ["no card", { id: "sub_Running000001" }],
    ["a null body", null],
  ] as const) {
    state.setReply = reply;
    const before = posts.length;
    is(`the card's setting answered with ${label}: not said set, nothing paid`, [await finishCardUpdate(store, sessionId), touched(before)], ["unsure", ["/subscriptions/sub_Running000001"]]);
  }
  state.setReply = undefined;
  // The payment: "paid" only from the invoice's own reply saying paid.
  for (const [label, reply] of [
    ["another invoice's id", { id: "in_OtherOwed00001", status: "paid" }],
    ["no id", { status: "paid" }],
    ["still open", { id: "in_Owed00000000001", status: "open" }],
    ["no status", { id: "in_Owed00000000001" }],
    ["a null body", null],
  ] as const) {
    state.payReply = reply;
    is(`the payment answered with ${label}: the card is set, the payment is not said made`, await finishCardUpdate(store, sessionId), "updated");
  }
  // A request Stripe refuses (400: the invoice no longer payable, a bad request) is not the card declined.
  state.payReply = { error: { type: "invalid_request_error", message: "Invoice is already paid" } };
  state.payStatus = 400;
  is("a refused request is not told as a declined card", await finishCardUpdate(store, sessionId), "updated");
  state.payReply = undefined;
  state.payStatus = 200;
  is("control: its own invoice paid is paid", await finishCardUpdate(store, sessionId), "paid");
  state.subs.set("sub_Running000001", { ...running, customer: "cus_Member000001", latest_invoice: null });
  is("the page has words for it", typeof membershipWords("en").cardNotices.unsure?.title, "string");

  part("Claude 6 on #3644: a set or a pay that throws is told by what is known");
  // A set Stripe answers with a 5xx (or that times out) may have landed: unsure, as an unread 2xx, never "nothing changed".
  state.subs.set("sub_Running000001", owedHere);
  state.setReply = { error: { type: "api_error", message: "An unknown error occurred" } };
  state.setStatus = 500;
  let before = posts.length;
  is("a set answered 500: unsure, and nothing is paid", [await finishCardUpdate(store, sessionId), touched(before)], ["unsure", ["/subscriptions/sub_Running000001"]]);
  // A 4xx is Stripe refusing the set: nothing was changed, which the page may say.
  state.setReply = { error: { type: "invalid_request_error", message: "No such PaymentMethod" } };
  state.setStatus = 400;
  is("a set refused with a 400: nothing was changed", await finishCardUpdate(store, sessionId), "error");
  state.setReply = undefined;
  state.setStatus = 200;
  // The card confirmed set, then the pay throws (409, 5xx): the card is set, the payment not said made.
  for (const status of [409, 500]) {
    state.payReply = { error: { type: status === 409 ? "idempotency_error" : "api_error", message: "try later" } };
    state.payStatus = status;
    is(`a pay answered ${status} after the card was set: updated, never "nothing changed"`, await finishCardUpdate(store, sessionId), "updated");
  }
  state.payReply = undefined;
  state.payStatus = 200;
  state.subs.set("sub_Running000001", { ...running, customer: "cus_Member000001", latest_invoice: null });

  part("Unsure is never a notice on a guess: the daily job neither says the card is set nor asks for a new one");
  // Another expiring card on the same membership, so the daily job would tell about it if it took the page for done.
  const expiring = { ...running, default_payment_method: { ...running.default_payment_method, id: "pm_OldCard0000002" } };
  state.active = [expiring];
  state.subs.set("sub_Running000001", { ...expiring, customer: "cus_Member000001", latest_invoice: null });
  for (const [label, status] of [["an unread set reply", 200], ["a set answered 500", 500]] as const) {
    await redis.pipeline([["DEL", "nl:card:open:acct_1TestHarbor0001:sub_Running000001"]]);
    const reopened = await openCardUpdate(store, token, "https://marktmorgen.com");
    const pending = [...state.sessions.keys()].at(-1)!;
    state.sessions.set(pending, { ...state.sessions.get(pending), status: "complete", setup_intent: { status: "succeeded", payment_method: "pm_NewCard0000002", metadata: { subscription: "sub_Running000001" } } });
    state.setReply = status === 200 ? { id: "sub_Running000001" } : { error: { type: "api_error", message: "An unknown error occurred" } };
    state.setStatus = status;
    const sentBefore = mails.length;
    before = posts.length;
    await run();
    const open = await redis.pipeline([["GET", "nl:card:open:acct_1TestHarbor0001:sub_Running000001"]]);
    is(`${label} in the daily job: no notice, nothing paid, the page kept open`, [reopened.ok, mails.length - sentBefore, touched(before).filter((p) => p.includes("/pay")), open[0]], [true, 0, [], pending]);
  }
  state.setReply = undefined;
  state.setStatus = 200;
  state.active = [];
  state.subs.set("sub_Running000001", { ...running, customer: "cus_Member000001", latest_invoice: null });

  part("What came back");
  const nowS = Math.floor(Date.now() / 1000);
  const paid = (id: string, attempts: number, cents: number, extra: Record<string, unknown> = {}) => ({
    id,
    currency: "usd",
    amount_paid: cents,
    attempt_count: attempts,
    billing_reason: "subscription_cycle",
    status_transitions: { paid_at: nowS - 2 * 86_400 },
    parent: { subscription_details: { metadata: { store: "harbor" } } },
    ...extra,
  });
  const invoices = [
    paid("in_Retried0000001", 3, 2900),
    paid("in_Failing000001", 1, 2900),
    paid("in_FirstTry000001", 1, 2900),
    paid("in_Elsewhere00001", 3, 9900, { parent: { subscription_details: { metadata: { store: "somebody" } } } }),
    paid("in_Joined00000001", 2, 2900, { billing_reason: "subscription_create" }),
    // A membership sold before the store changed its currency renews in euros (22 [E5], unit 2e).
    paid("in_OldCurrency001", 3, 2500, { currency: "eur" }),
  ];
  is("paid after failing, and after an email; a renewal in another currency counted, never added", recoveredFrom(invoices, new Set(["harbor"]), "usd", new Set(["in_Failing000001"]), Date.now()), { recovered: 2, cents: 5800, afterEmail: 1, afterEmailCents: 2900, elsewhere: 1 });
  state.invoices = invoices;
  const report = await recoveryReport(store, true);
  is("read from Stripe, with the emails sent this month", [report?.recovered, report?.afterEmail, (report?.month.failed ?? 0) + (report?.month.cards ?? 0) > 0], [2, 1, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
