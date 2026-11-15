/**
 * The second independent review of PR #2827 (Claude 5, head d4c2af0c), its
 * three MEDIUM findings and LEVE 4, against the real route, page, rules and
 * lib/withdrawal.ts, an in-memory Redis and a stand-in email service; nothing
 * real is reached.
 *
 * Checked:
 *
 *   - 1: when neither the creator's note nor the acknowledgement went, the
 *     buyer is never told the withdrawal "was sent": the outcome and the page
 *     say it is recorded with its time, that neither the store nor their email
 *     got it yet, and to send it again; every language has those words; an
 *     unknown state never reads as sent;
 *   - 2: the day the page promises is the day the function is still open at
 *     its end: 14 calendar days after the day of payment (see D), a Saturday or a
 *     Sunday moved to the Monday, open to the end of that day anywhere on Earth
 *     (11:59:59 UTC the next day), then closed;
 *   - 3: the art. 16(m) yes closes the function as "supplied" only when the
 *     order's confirmation (lib/purchase-email.ts, nl:confirm:<session>) is
 *     read exactly as "sent"; no mark, or any other value, keeps it open;
 *   - LEVE 4: the creator's note says to refund from the PayPal account for a
 *     PayPal order, and from the Stripe account otherwise.
 *
 * Claude 5's focal return on 2a23961f, two more MEDIUM findings:
 *
 *   - D: the day of payment is the latest calendar day anywhere on Earth at
 *     that moment (UTC+14), so a buyer east of UTC who paid late in the UTC
 *     day keeps all 14 of their own days, and the weekend move reads that day;
 *   - E: a pre-order handed over (it comes back on the list as brought over,
 *     job "pre:") is a contract made here: the function stays offered for 14
 *     days from its payment, and its confirmation is never taken as known
 *     (the hand-over email carries no art. 8(7) lines), so the yes does not
 *     close it either.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { afterTasks } from "./next-server-after-world";
import { OrdersMeter, ordersLinkFor, purchasesFor, type Purchase } from "@/lib/buyer-orders";
import { readListing } from "@/lib/catalog";
import { confirmPreorder, handOverPreorder } from "@/lib/preorders";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { windowOf, withConfirmations, withdraw, withdrawalKey, withdrawalStanding } from "@/lib/withdrawal";
import { submittedInTime, withdrawalWindow, type WithdrawalFacts } from "@/lib/withdrawal-rules";
import { WITHDRAWAL_WORDS } from "@/lib/buyer-words/withdrawal";
import { importedKey } from "@/lib/imported-purchases";
import { openConversation, readInbox } from "@/lib/inbox";
import { withinLimit } from "@/lib/request-guard";
import { NEW_PER_DAY } from "@/lib/inbox-rules";
import { POST as withdrawRoute } from "@/app/api/store/withdraw/route";
import WithdrawPage from "@/app/[handle]/orders/withdraw/page";

const OWNER = "mara@example.com";
const BUYER = "ana@example.com";
const ORIGIN = "https://marktmorgen.com";
const DAY = 86_400;
const realNow = Date.now;

let sessions: Record<string, unknown>[] = [];
const mails: { to: string; subject: string; text: string }[] = [];
let refuseMail = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (refuseMail > 0) {
      refuseMail -= 1;
      return answer({ message: "unavailable" }, 500);
    }
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    mails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return answer({ id: "00000000-0000-4000-8000-000000000000" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions, has_more: false });
  const one = path.match(/^\/checkout\/sessions\/([A-Za-z0-9_]+)$/);
  if (one) {
    const found = sessions.find((row) => row.id === one[1]);
    return found ? answer(found) : answer({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

beforeEach(() => {
  Date.now = realNow;
  redis.clear();
  sessions = [];
  mails.length = 0;
  refuseMail = 0;
  afterTasks.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_withdrawal_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
});

async function shop(): Promise<{ store: Store; product: string; token: string }> {
  await claimHandle(OWNER, "mara", "Mara's Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMara00001", true);
  await setSubscription(OWNER, { customerId: "cus_mara00001", subscriptionId: "sub_mara00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "The Butter Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/butter");
  const store = (await storeForEmail(OWNER)) as Store;
  const link = (await ordersLinkFor(store, BUYER, `${ORIGIN}/@mara`))!;
  return { store, product: made.product.id, token: new URL(link).searchParams.get("token")! };
}

const paid = (id: string, product: string, created: number, metadata: Record<string, string> = {}) => ({
  id: `cs_test_${id.padEnd(24, "0")}`,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created,
  metadata: { store: "mara", product, ...metadata },
  customer_details: { email: BUYER },
  payment_intent: { id: `pi_test${id.padEnd(10, "0")}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
});

const post = (fields: Record<string, string>) =>
  withdrawRoute(new NextRequest(`${ORIGIN}/api/store/withdraw`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
const stateOf = (answer: Response) => new URL(answer.headers.get("location") ?? "https://x").searchParams.get("w");
const render = async (query: Record<string, string>) => renderToStaticMarkup(await WithdrawPage({ params: Promise.resolve({ handle: "@mara" }), searchParams: Promise.resolve(query) }));
const fillInbox = async (store: Store) => {
  for (let i = 0; i < NEW_PER_DAY + 1; i++) await withinLimit("inbox-new", store.statsId!, NEW_PER_DAY, 86_400);
};
const LANGUAGES = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;

test("MEDIUM 1: neither the store nor the email reached: recorded, never said as sent, offered again", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("nowhere", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  await fillInbox(store);
  refuseMail = 1;
  const answer = await post({ handle: "mara", token, ref, name: "Ana Souza", email: BUYER });
  assert.equal(stateOf(answer), "unreached", "a state of its own, never 'unsent' (which says the store got it)");
  assert.equal((await readInbox(store.statsId!)).length, 0, "precondition: the store got nothing");
  assert.equal(mails.length, 0, "precondition: no acknowledgement went");
  assert.equal((await withdrawalStanding(store, ref)).owed, "unreached", "the page's standing says the same");

  const said = await render({ token, ref, w: "unreached" });
  assert.ok(!/was sent/i.test(said), "the page never says it was sent");
  assert.ok(said.includes(WITHDRAWAL_WORDS.en.notices.unreached?.title ?? "\u0000"), "the page shows the state's own notice");
  assert.ok(said.includes("Confirm withdrawal"), "and offers the form again, to send it once more");
  const reopened = await render({ token, ref });
  assert.ok(!/was sent/i.test(reopened) && reopened.includes(WITHDRAWAL_WORDS.en.notices.unreached?.title ?? "\u0000"), "reopened, it says the same");
});

test("MEDIUM 1: the words of the state, in every language, never say sent", () => {
  for (const code of LANGUAGES) {
    const n = WITHDRAWAL_WORDS[code].notices;
    assert.ok(n.unreached, `${code}: a notice for the state`);
    assert.notEqual(n.unreached.title, n.done.title, `${code}: not the 'sent' title`);
    assert.notEqual(n.unreached.title, n.unsent.title, `${code}: not the 'unsent' title`);
  }
  const en = WITHDRAWAL_WORDS.en.notices.unreached;
  assert.ok(en && !/\bsent\b/i.test(`${en.title} ${en.body}`), `English never says sent: ${en?.title} ${en?.body}`);
  assert.ok(en && /recorded/i.test(en.body) && /date and time/i.test(en.body) && /store/i.test(en.body) && /email/i.test(en.body) && /again/i.test(en.body), "it says recorded with its time, store and email not reached, send again");
});

test("MEDIUM 1: a record whose acknowledgement is owed and whose creator was never told, with no tells left, is still 'unreached'", async () => {
  const { store } = await shop();
  const ref = "cs_test_exhausted0000000000000000";
  await redis.pipeline([["HSET", withdrawalKey(store.sid!, ref), "at", String(Date.now()), "tries", "1", "tells", "3"]]);
  assert.equal((await withdrawalStanding(store, ref)).owed, "unreached", "never claimed to have reached the store");
});

test("MEDIUM 1: an unknown state never reads as sent", async () => {
  const { product, token } = await shop();
  sessions = [paid("unknownw", product, Math.floor(Date.now() / 1000) - DAY)];
  const html = await render({ token, ref: sessions[0].id as string, w: "bogus" });
  assert.ok(!/was sent/i.test(html), "an unknown state shows no 'sent' notice");
});

// The 2026 calendar: November 1 and 15 are Sundays, November 14 a Saturday, October 28 and November 11 Wednesdays.
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) => Date.UTC(y, m - 1, d, h, min, s) / 1000;
const sale = (paidAt: number): WithdrawalFacts => ({ kind: "sale", paidAt, member: false, givenByStore: false, consent: null });

test("MEDIUM 2: rules: to the end of the last day anywhere on Earth, Saturdays and Sundays moved to the Monday", () => {
  // Paid Sunday November 1 at 00:30 UTC: day 14 is Sunday November 15, moved to Monday November 16.
  const p = at(2026, 11, 1, 0, 30);
  const end = at(2026, 11, 17, 11, 59, 59);
  assert.deepEqual(withdrawalWindow(sale(p), at(2026, 11, 15, 12)), { open: true, until: end }, "still open at noon on day 14 (the reviewer's case)");
  assert.equal(withdrawalWindow(sale(p), at(2026, 11, 16, 12)).open, true, "open at noon UTC on the day shown");
  assert.equal(withdrawalWindow(sale(p), at(2026, 11, 16, 23)).open, true, "open at 23:00 UTC on the day shown");
  assert.equal(withdrawalWindow(sale(p), end).open, true, "open at the end instant");
  assert.deepEqual(withdrawalWindow(sale(p), end + 1), { open: false, why: "ended" }, "closed after it");
  assert.equal(submittedInTime(withdrawalWindow(sale(p), end), end), true);
  // A weekday: paid Wednesday October 28 at 23:50 UTC, already Thursday October 29 at UTC+14 (the latest calendar day
  // anywhere, D on the focal return), so the last day is Thursday November 12.
  const w = at(2026, 10, 28, 23, 50);
  assert.deepEqual(withdrawalWindow(sale(w), at(2026, 11, 11, 23, 59)), { open: true, until: at(2026, 11, 13, 11, 59, 59) });
  assert.deepEqual(withdrawalWindow(sale(w), at(2026, 11, 12, 12)), { open: true, until: at(2026, 11, 13, 11, 59, 59) });
  assert.deepEqual(withdrawalWindow(sale(w), at(2026, 11, 13, 12)), { open: false, why: "ended" });
  // A Saturday: paid Saturday October 31, day 14 is Saturday November 14, moved to Monday November 16.
  const s = at(2026, 10, 31, 9);
  assert.deepEqual(withdrawalWindow(sale(s), at(2026, 11, 15, 20)), { open: true, until: at(2026, 11, 17, 11, 59, 59) });
});

test("MEDIUM 2: the page shows the last day the function is still open on", async () => {
  // Every clock of this test at a fixed time: paid Sunday November 1, 2026 at 00:30 UTC, the page opened on November 14.
  Date.now = () => at(2026, 11, 14, 12) * 1000;
  try {
    const { store, product, token } = await shop();
    sessions = [paid("deadline", product, at(2026, 11, 1, 0, 30))];
    const html = await render({ token, ref: sessions[0].id as string });
    assert.ok(html.includes("You can withdraw until November 16, 2026."), `the Monday after the Sunday: ${html.match(/You can withdraw until[^<]*/)?.[0]}`);
    // A link lasts ORDERS_LINK_SECONDS (a day): the buyer asks for a new one on the day shown.
    Date.now = () => at(2026, 11, 16, 23) * 1000;
    const later = new URL((await ordersLinkFor(store, BUYER, `${ORIGIN}/@mara`))!).searchParams.get("token")!;
    assert.ok((await render({ token: later, ref: sessions[0].id as string })).includes("Confirm withdrawal"), "still offered late on the day shown");
    Date.now = () => (at(2026, 11, 17, 11, 59, 59) + 1) * 1000;
    const after = new URL((await ordersLinkFor(store, BUYER, `${ORIGIN}/@mara`))!).searchParams.get("token")!;
    assert.ok(!(await render({ token: after, ref: sessions[0].id as string })).includes("Confirm withdrawal"), "and no longer once its end has passed");
  } finally {
    Date.now = realNow;
  }
});

test("MEDIUM 3: rules: the yes closes the function only with the confirmation known sent", () => {
  const p = at(2026, 11, 1, 12);
  const yes = { ...sale(p), consent: { version: "2026-10-30.2", at: p, kind: "digital" as const } };
  assert.equal(withdrawalWindow(yes, p + 60).open, true, "the yes alone: open");
  assert.equal(withdrawalWindow({ ...yes, confirmed: false } as WithdrawalFacts, p + 60).open, true, "confirmation not known sent: open");
  assert.deepEqual(withdrawalWindow({ ...yes, confirmed: true } as WithdrawalFacts, p + 60), { open: false, why: "supplied" }, "confirmation sent: supplied");
});

test("MEDIUM 3: the list, the page and the route read the order's confirmation mark exactly", async () => {
  const { store, product, token } = await shop();
  const now = Math.floor(Date.now() / 1000);
  const dc = { dc: `yes:2026-10-30.2:d:${now - 2 * DAY}` };
  sessions = [paid("nomark", product, now - 2 * DAY, dc), paid("sentmark", product, now - 2 * DAY, dc), paid("sending", product, now - 2 * DAY, dc), paid("oldone", product, now - 2 * DAY, dc)];
  const [nomark, sentmark, sending, oldone] = sessions.map((s) => s.id as string);
  await redis.pipeline([["SET", `nl:confirm:${sentmark}`, "sent"], ["SET", `nl:confirm:${sending}`, "sending"], ["SET", `nl:confirm:${oldone}`, "1"]]);

  const list = await render({ token });
  assert.ok(list.includes(`ref=${nomark}`), "no mark: the function stays offered");
  assert.ok(list.includes(`ref=${sending}`), "a send in progress is not 'sent': offered");
  assert.ok(list.includes(`ref=${oldone}`), "any other value is not 'sent': offered");
  assert.ok(!list.includes(`ref=${sentmark}`), "confirmation sent: supplied, not offered");

  assert.equal(stateOf(await post({ handle: "mara", token, ref: sentmark, name: "Ana", email: BUYER })), "closed", "the route closes it only when sent");
  assert.equal(stateOf(await post({ handle: "mara", token, ref: nomark, name: "Ana", email: BUYER })), "done", "without the mark the route takes the withdrawal");
  void store;
});

test("LEVE 4: the creator's note names the account the order was paid into", async () => {
  const { store } = await shop();
  const purchase = (reference: string, paypal: boolean): Purchase => ({
    reference, kind: paypal ? "imported" : "sale", title: "The Butter Course", option: null, paidAt: Math.floor(Date.now() / 1000) - DAY,
    member: false, ended: false, productId: "p1", courseProduct: null, main: null, items: null, added: [], consent: null,
    ...(paypal ? { paidWith: "paypal" as const } : {}),
  });
  const viaPaypal = "imp_paypal0000000001";
  const viaStripe = "cs_test_stripe0000000000000000";
  assert.equal(await withdraw(store, purchase(viaPaypal, true), { name: "Ana", reference: viaPaypal, email: BUYER }), "done");
  assert.equal(await withdraw(store, purchase(viaStripe, false), { name: "Ana", reference: viaStripe, email: BUYER }), "done");
  const threads = JSON.stringify(await Promise.all((await readInbox(store.statsId!)).map((c) => openConversation(store.statsId!, c.id))));
  const note = (ref: string) => threads.match(new RegExp(`order ${ref}[^"]*`))?.[0] ?? "";
  assert.ok(note(viaPaypal).includes("from your PayPal account") && !note(viaPaypal).includes("Stripe"), `PayPal: ${note(viaPaypal)}`);
  assert.ok(note(viaStripe).includes("from your Stripe account"), `Stripe: ${note(viaStripe)}`);
  for (const code of LANGUAGES) {
    const words = WITHDRAWAL_WORDS[code].creatorNote as (...args: unknown[]) => string;
    assert.ok(words("P", "o", "w", "PayPal").includes("PayPal") && !words("P", "o", "w", "PayPal").includes("Stripe"), `${code}: PayPal named`);
  }
});

test("D: the day of payment is the latest calendar day anywhere on Earth", () => {
  // Paid Tuesday November 3 at 23:30 UTC: already Wednesday November 4 in Helsinki (UTC+2) and anywhere up to UTC+14.
  // Day 14 after Wednesday November 4 is Wednesday November 18; open to its end anywhere on Earth, 11:59:59 UTC on November 19.
  const p = at(2026, 11, 3, 23, 30);
  const end = at(2026, 11, 19, 11, 59, 59);
  assert.equal(withdrawalWindow(sale(p), at(2026, 11, 18, 15)).open, true, "open at 15:00 UTC on November 18 (17:00 in Helsinki, still its 14th day)");
  assert.equal(withdrawalWindow(sale(p), at(2026, 11, 18, 23, 59, 59)).open, true, "open at the end of the last day, in UTC");
  assert.deepEqual(withdrawalWindow(sale(p), end), { open: true, until: end }, "open at the end instant");
  assert.deepEqual(withdrawalWindow(sale(p), end + 1), { open: false, why: "ended" }, "closed one second after it");
  // Paid Friday November 6 at 22:00 UTC: already Saturday November 7 east of UTC+2. Day 14 is Saturday November 21, moved
  // to Monday November 23 (counted from the UTC day, it would be Friday November 20 and end on November 21).
  const f = at(2026, 11, 6, 22);
  assert.deepEqual(withdrawalWindow(sale(f), at(2026, 11, 23, 12)), { open: true, until: at(2026, 11, 24, 11, 59, 59) }, "the weekend move reads the latest day");
  assert.deepEqual(withdrawalWindow(sale(f), at(2026, 11, 24, 12)), { open: false, why: "ended" });
});

/** A paid checkout of a pre-order, as Stripe gives it to lib/preorders.ts (confirmPreorder). */
const preorderSession = (id: string, product: string, created: number, metadata: Record<string, string> = {}) => ({
  ...paid(id, product, created, { preorder: "yes", ...metadata }),
  payment_intent: `pi_test${id.padEnd(16, "0")}`,
});
const deps = { base: `${ORIGIN}/@mara`, from: "Mara <orders@example.com>", ordersLink: async () => null, recordStart: async () => {} };

test("E: a pre-order handed over (bought after its release) keeps the function for 14 days from its payment", async () => {
  // Every clock at a fixed time: paid Monday November 9, 2026 at 08:00 UTC (the latest day anywhere is still November 9),
  // read a day later. Day 14 is Monday November 23; open to 11:59:59 UTC on November 24.
  Date.now = () => at(2026, 11, 10, 8) * 1000;
  try {
    const { product, token } = await shop();
    const session = preorderSession("preout", product, at(2026, 11, 9, 8));
    sessions = [session];
    let store = (await storeForEmail(OWNER)) as Store;
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "given", "precondition: already released, handed over at payment");
    store = (await storeForEmail(OWNER)) as Store;
    const meter = new OrdersMeter(store);
    const listed = await withConfirmations(await purchasesFor(store, BUYER, meter), meter);
    const pre = listed.find((p) => p.preorder?.given);
    assert.ok(pre, `precondition: on the list as handed over: ${JSON.stringify(listed.map((p) => [p.kind, p.preorder]))}`);
    assert.deepEqual(windowOf(pre!), { open: true, until: at(2026, 11, 24, 11, 59, 59) }, "a contract made here: 14 days from its payment");
    assert.ok((await render({ token })).includes(`ref=${pre!.reference}`), "and the page offers it");
  } finally {
    Date.now = realNow;
  }
});

test("E: a pre-order handed over with the yes stays offered: its confirmation is never taken as known", async () => {
  Date.now = () => at(2026, 11, 10, 8) * 1000;
  try {
    const { product } = await shop();
    const session = preorderSession("preyes", product, at(2026, 11, 9, 8), { dc: `yes:2026-10-30.2:d:${at(2026, 11, 9, 8)}` });
    sessions = [session];
    let store = (await storeForEmail(OWNER)) as Store;
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "given");
    // What confirmPreorderOnce writes for a hand-over, whether or not its email went (lib/purchase-email.ts): proves no art. 8(7) confirmation.
    await redis.pipeline([["SET", `nl:confirm:${session.id}`, "sent"]]);
    store = (await storeForEmail(OWNER)) as Store;
    const meter = new OrdersMeter(store);
    const pre = (await withConfirmations(await purchasesFor(store, BUYER, meter), meter)).find((p) => p.preorder?.given);
    assert.ok(pre && pre.confirmed !== true, "never confirmed for a pre-order");
    assert.deepEqual(windowOf(pre!), { open: true, until: at(2026, 11, 24, 11, 59, 59) }, "the 14 days stay");
  } finally {
    Date.now = realNow;
  }
});

// Claude 5's second focal return on df856250, two more MEDIUM findings:
//
//   - F: a pre-order withdrawn from before it was handed over keeps that withdrawal once handed over: the record is
//     read under the checkout (cs_), whatever reference the list gives it, so the function is not offered again, no
//     second note or acknowledgement goes, and the creator's note names the checkout, which Stripe knows;
//   - G: a shipped pre-order stays shipped once handed over: its withdrawal period still runs from a receipt not
//     known here, so the function stays open with no end.

test("F: a pre-order withdrawn from before its hand-over is not offered again after it, and nothing goes twice", async () => {
  Date.now = () => at(2026, 11, 10, 8) * 1000;
  try {
    const { product, token } = await shop();
    let store = (await storeForEmail(OWNER)) as Store;
    await redis.pipeline([["SADD", `nl:wl:${store.statsId}:soon`, product]]);
    const session = preorderSession("prewithdrawn", product, at(2026, 11, 9, 8));
    sessions = [session];
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "sent", "precondition: coming soon, a receipt");
    const first = await post({ handle: "mara", token, ref: session.id, name: "Ana Souza", email: BUYER });
    assert.equal(stateOf(first), "done", "precondition: withdrawn from before the hand-over");
    const notes = (await readInbox(store.statsId!)).length;

    // Released: handed over, it comes back on the list as brought over (and its own email goes to the buyer).
    await redis.pipeline([["SREM", `nl:wl:${store.statsId}:soon`, product]]);
    store = (await storeForEmail(OWNER)) as Store;
    assert.equal(await handOverPreorder(store, (await readListing(store, product))!, session.id, deps), "given", "precondition: handed over");
    const acks = mails.filter((m) => m.to === BUYER).length;
    store = (await storeForEmail(OWNER)) as Store;
    const meter = new OrdersMeter(store);
    const pre = (await purchasesFor(store, BUYER, meter)).find((p) => p.preorder?.given);
    assert.ok(pre, "precondition: on the list as handed over");

    const page = await render({ token, ref: pre!.reference });
    assert.ok(!page.includes('name="ref"'), "the function is not offered again for a contract already withdrawn from");
    const second = await post({ handle: "mara", token, ref: pre!.reference, name: "Ana Souza", email: BUYER });
    assert.equal(stateOf(second), "already", "the first statement stands");
    assert.equal((await readInbox(store.statsId!)).length, notes, "no second note to the creator");
    assert.equal(mails.filter((m) => m.to === BUYER).length, acks, "no second acknowledgement");
  } finally {
    Date.now = realNow;
  }
});

test("F: the creator's note for a handed-over pre-order names its checkout, which Stripe knows", async () => {
  Date.now = () => at(2026, 11, 10, 8) * 1000;
  try {
    const { product, token } = await shop();
    let store = (await storeForEmail(OWNER)) as Store;
    const session = preorderSession("prenote", product, at(2026, 11, 9, 8));
    sessions = [session];
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "given", "precondition: handed over at payment");
    store = (await storeForEmail(OWNER)) as Store;
    const pre = (await purchasesFor(store, BUYER, new OrdersMeter(store))).find((p) => p.preorder?.given);
    assert.ok(pre, "precondition: on the list as handed over");
    assert.equal(stateOf(await post({ handle: "mara", token, ref: pre!.reference, name: "Ana Souza", email: BUYER })), "done");
    const inbox = JSON.stringify(await Promise.all((await readInbox(store.statsId!)).map((c) => openConversation(store.statsId!, c.id))));
    assert.ok(inbox.includes(`order ${session.id}`), `the note names the checkout ${session.id}`);
    assert.ok(!inbox.includes(`order ${pre!.reference}`) || pre!.reference === session.id, "never a reference Stripe does not know");
    assert.ok(redis.keys().includes(withdrawalKey(store.sid!, session.id)), "kept under the checkout");
  } finally {
    Date.now = realNow;
  }
});

test("G: a shipped pre-order stays shipped once handed over: open, with no end", async () => {
  // Paid 20 days before it was read: a sale's 14 days would be over.
  Date.now = () => at(2026, 11, 29, 8) * 1000;
  try {
    const { product } = await shop();
    let store = (await storeForEmail(OWNER)) as Store;
    await redis.pipeline([["SADD", `nl:wl:${store.statsId}:soon`, product]]);
    const session = preorderSession("preship", product, at(2026, 11, 9, 8), { ship: "yes" });
    sessions = [session];
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "sent");
    const before = (await purchasesFor(store, BUYER, new OrdersMeter(store))).find((p) => p.reference === session.id);
    assert.deepEqual(before && windowOf(before), { open: true, until: null }, "precondition: shipped, open with no end before the hand-over");

    await redis.pipeline([["SREM", `nl:wl:${store.statsId}:soon`, product]]);
    store = (await storeForEmail(OWNER)) as Store;
    assert.equal(await handOverPreorder(store, (await readListing(store, product))!, session.id, deps), "given");
    store = (await storeForEmail(OWNER)) as Store;
    const after = (await purchasesFor(store, BUYER, new OrdersMeter(store))).find((p) => p.preorder?.given);
    assert.ok(after, "precondition: on the list as handed over");
    assert.equal(after!.shipped, true, "still shipped");
    assert.deepEqual(windowOf(after!), { open: true, until: null }, "its receipt is not known here: open with no end");
  } finally {
    Date.now = realNow;
  }
});

test("G: a handed-over pre-order whose shipping was never written down is taken as shipped (unknown never closes it)", async () => {
  Date.now = () => at(2026, 11, 29, 8) * 1000;
  try {
    const { product } = await shop();
    let store = (await storeForEmail(OWNER)) as Store;
    const session = preorderSession("preold", product, at(2026, 11, 9, 8));
    sessions = [session];
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "given");
    // An entry written before the shipping was kept with it: no "ship" field.
    const key = `nl:pre:${store.statsId}:${product}`;
    const [raw] = await redis.pipeline([["HGET", key, session.id]]);
    const entry = JSON.parse(String(raw)) as Record<string, unknown>;
    delete entry.ship;
    await redis.pipeline([["HSET", key, session.id, JSON.stringify(entry)]]);
    // And its grant made before the job said whether it ships (Claude 1's H on #2827): the job as it was, "pre:<checkout>".
    await asOldGrant(store, product, session.id);
    store = (await storeForEmail(OWNER)) as Store;
    const pre = (await purchasesFor(store, BUYER, new OrdersMeter(store))).find((p) => p.preorder?.given);
    assert.ok(pre, "precondition: on the list as handed over");
    assert.deepEqual(windowOf(pre!), { open: true, until: null }, "not known: kept open");
  } finally {
    Date.now = realNow;
  }
});

test("G: a digital pre-order handed over keeps its 14 days, not an open end", async () => {
  Date.now = () => at(2026, 11, 10, 8) * 1000;
  try {
    const { product } = await shop();
    let store = (await storeForEmail(OWNER)) as Store;
    const session = preorderSession("predigital", product, at(2026, 11, 9, 8));
    sessions = [session];
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "given");
    store = (await storeForEmail(OWNER)) as Store;
    const pre = (await purchasesFor(store, BUYER, new OrdersMeter(store))).find((p) => p.preorder?.given);
    assert.ok(pre && pre.shipped !== true, "not shipped");
    assert.deepEqual(windowOf(pre!), { open: true, until: at(2026, 11, 24, 11, 59, 59) });
  } finally {
    Date.now = realNow;
  }
});

/** Rewrites a handed-over pre-order's grant to the job it had before it said whether it ships: "pre:<checkout>". */
async function asOldGrant(store: Store, product: string, checkout: string): Promise<void> {
  const grantKey = importedKey(store.statsId!, BUYER);
  const [raw] = await redis.pipeline([["HGET", grantKey, product]]);
  const grant = JSON.parse(String(raw)) as Record<string, unknown>;
  grant.job = `pre:${checkout}`;
  await redis.pipeline([["HSET", grantKey, product, JSON.stringify(grant)]]);
}

// Claude 1's focal re-review of #2827 (H, MEDIUM): the pre-order's entry expires 400 days after its product's last
// change, while the grant that keeps the purchase on the buyer's list never does. Whether it ships is kept where the
// purchase is kept, so an entry gone never turns a known digital purchase into an unknown one.
test("H: a digital pre-order handed over stays digital once its entry is gone: its 14 days ended, never open again", async () => {
  // Read 401 days after paying: the store's plan is set up on the day of the read, so only the pre-order is old.
  Date.now = () => at(2027, 12, 15, 8) * 1000;
  try {
    const { product } = await shop();
    let store = (await storeForEmail(OWNER)) as Store;
    const session = preorderSession("predigone", product, at(2026, 11, 9, 8));
    sessions = [session];
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "given");
    // The entry expires (400 days after the product's last pre-order change).
    await redis.pipeline([["DEL", `nl:pre:${store.statsId}:${product}`]]);
    store = (await storeForEmail(OWNER)) as Store;
    const pre = (await purchasesFor(store, BUYER, new OrdersMeter(store))).find((p) => p.preorder?.given);
    assert.ok(pre, "precondition: still on the list (its grant does not expire)");
    assert.equal(pre!.shipped === true, false, "still digital");
    assert.deepEqual(windowOf(pre!), { open: false, why: "ended" }, "its 14 days ended long ago: not offered again");
  } finally {
    Date.now = realNow;
  }
});

test("H: a shipped pre-order handed over stays shipped once its entry is gone: open, with no end", async () => {
  Date.now = () => at(2026, 11, 29, 8) * 1000;
  try {
    const { product } = await shop();
    let store = (await storeForEmail(OWNER)) as Store;
    await redis.pipeline([["SADD", `nl:wl:${store.statsId}:soon`, product]]);
    const session = preorderSession("preshipgone", product, at(2026, 11, 9, 8), { ship: "yes" });
    sessions = [session];
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "sent");
    await redis.pipeline([["SREM", `nl:wl:${store.statsId}:soon`, product]]);
    store = (await storeForEmail(OWNER)) as Store;
    assert.equal(await handOverPreorder(store, (await readListing(store, product))!, session.id, deps), "given");
    await redis.pipeline([["DEL", `nl:pre:${store.statsId}:${product}`]]);
    store = (await storeForEmail(OWNER)) as Store;
    const pre = (await purchasesFor(store, BUYER, new OrdersMeter(store))).find((p) => p.preorder?.given);
    assert.ok(pre, "precondition: on the list");
    assert.equal(pre!.shipped, true, "still shipped");
    assert.deepEqual(windowOf(pre!), { open: true, until: null });
  } finally {
    Date.now = realNow;
  }
});

test("H: an old grant (no shipping in its job) whose entry is gone is not known: kept open, never closed on a guess", async () => {
  Date.now = () => at(2026, 11, 10, 8) * 1000;
  try {
    const { product } = await shop();
    let store = (await storeForEmail(OWNER)) as Store;
    const session = preorderSession("preoldgone", product, at(2026, 11, 9, 8));
    sessions = [session];
    assert.equal(await confirmPreorder(store, session, (await readListing(store, product))!, deps), "given");
    await asOldGrant(store, product, session.id);
    await redis.pipeline([["DEL", `nl:pre:${store.statsId}:${product}`]]);
    store = (await storeForEmail(OWNER)) as Store;
    const pre = (await purchasesFor(store, BUYER, new OrdersMeter(store))).find((p) => p.preorder?.given);
    assert.ok(pre, "precondition: on the list");
    assert.equal(pre!.checkout, session.id, "the old job still names its checkout");
    assert.deepEqual(windowOf(pre!), { open: true, until: null }, "not known: kept open");
  } finally {
    Date.now = realNow;
  }
});
