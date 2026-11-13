/**
 * Creators inviting creators: who counts as invited, and the credit it earns.
 *
 * Stripe is played by a stand-in for `fetch` that keeps a customer's balance
 * the way Stripe does, so what is checked is what would land on a real plan:
 *
 *   - a creator never counts as their own invite, and the first invite
 *     accepted is the one that stays;
 *   - nothing is credited on a payment still inside its refund window, and
 *     nothing on money given back;
 *   - an account that had paid us before it was invited earns nobody
 *     anything;
 *   - a credit reaches Stripe once, even when the note that it did is lost;
 *   - a creator not paying us yet keeps what they earned until they start.
 */
import { claimHandle, createStore, setSubscription, storeForEmail } from "@/lib/store";
import { inviteCode, inviteView, inviterFor, recordInvite, creditKey, OWED_KEY, byKey, parseBy } from "@/lib/creator-invites";
import { INVITE_STRIPE_VERSION, paidOn, settleInvites } from "@/lib/creator-invite-credit";
import { INVITE_BONUS_CENTS, INVITE_CODE_PATTERN, INVITE_COOKIE, INVITE_HOLD_DAYS, INVITE_PROGRAM_OPEN, LEGACY_INVITE_RECORDING_UNTIL, mayRecordAcceptedInvite, inviteShare, currentInviteTerms, readInviteTerms } from "@/lib/creator-invite-rules";
import { GET as accept } from "@/app/invite/[code]/accept/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;

/*
  Every age in this file is written against INVITE_HOLD_DAYS rather than as a
  number of its own. The hold is the refund window plus a week, so when the
  refund window went from 14 days to 30 the hold went from 21 to 37 — and
  fixtures written as "35 days ago" and "invited 60 days ago" quietly swapped
  which side of the hold they were on, and which side of the invite. Said this
  way, each payment keeps the position in the story it was written to have.
*/
/** Paid, but still inside the hold: earns nothing yet. */
const INSIDE = INVITE_HOLD_DAYS - 11;
/** Paid and out of the hold. */
const PAST = INVITE_HOLD_DAYS + 4;
/** The first payment of all, also out of the hold. */
const LONG_PAST = INVITE_HOLD_DAYS + 8;
/** When the invites were accepted: before every payment above. */
const INVITED = LONG_PAST + 15;
const NOW = Date.UTC(2026, 9, 16, 12);
const nowS = Math.floor(NOW / 1000);

type Txn = { id: string; amount: number; currency: string; metadata: Record<string, string> };
const invoices = new Map<string, Record<string, unknown>[]>();
const refunds = new Map<string, { amount: number; status: string }[]>();
const balance = new Map<string, Txn[]>();
const versions = new Set<string>();
const keys: string[] = [];
let posts = 0;

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  versions.add(headers.get("stripe-version") ?? "none");
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (process.env.DEBUG_FETCH) console.log("FETCH", method, url.pathname + url.search);
  if (method === "GET" && path === "/invoices") {
    const customer = url.searchParams.get("customer") ?? "";
    const expanded = url.searchParams.getAll("expand[]").includes("data.payments");
    const rows = (invoices.get(customer) ?? []).map((inv) => (expanded ? inv : { ...inv, payments: undefined }));
    return answer({ object: "list", data: rows, has_more: false });
  }
  if (method === "GET" && path === "/refunds") {
    const pi = url.searchParams.get("payment_intent") ?? url.searchParams.get("charge") ?? "";
    return answer({ object: "list", data: refunds.get(pi) ?? [], has_more: false });
  }
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") {
    return answer({ object: "list", data: [...(balance.get(txns[1]) ?? [])].reverse(), has_more: false });
  }
  if (txns && method === "POST") {
    posts += 1;
    keys.push(headers.get("idempotency-key") ?? "");
    const form = new URLSearchParams(String(init?.body ?? ""));
    const txn: Txn = {
      id: `cbtxn_${posts}abcdef`,
      amount: Number(form.get("amount")),
      currency: form.get("currency") ?? "",
      metadata: { nimbus_invite_credit: form.get("metadata[nimbus_invite_credit]") ?? "" },
    };
    balance.set(txns[1], [...(balance.get(txns[1]) ?? []), txn]);
    return answer(txn);
  }
  const customer = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/);
  if (customer && method === "GET") {
    const sum = (balance.get(customer[1]) ?? []).reduce((n, t) => n + t.amount, 0);
    return answer({ id: customer[1], object: "customer", balance: sum, currency: "usd" });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid subscription invoice, as Stripe returns it from 2025 on. */
function invoice(id: string, cents: number, createdDaysAgo: number, paidDaysAgo: number, pi: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    object: "invoice",
    status: "paid",
    amount_paid: cents,
    post_payment_credit_notes_amount: 0,
    currency: "usd",
    created: nowS - createdDaysAgo * DAY,
    status_transitions: { paid_at: nowS - paidDaysAgo * DAY },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: pi } }], has_more: false },
    ...extra,
  };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invites_only_a_stand_in";
  redis.clear();

  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana@example.com", "ana");
  const bea = await made("bea@example.com", "bea");
  const cal = await made("cal@example.com", "cal");
  const dan = await made("dan@example.com", "dan");
  const eve = await made("eve@example.com", "eve");

  part("The link");
  const code = await inviteCode(ana.sid);
  if (!code) throw new Error("no code");
  is("a code looks like one", INVITE_CODE_PATTERN.test(code), true);
  is("asked again, it is the same code", await inviteCode(ana.sid), code);
  is("it leads to its store", (await inviterFor(code))?.sid, ana.sid);
  is("a code nobody has leads nowhere", await inviterFor("zzzzzzzz"), null);

  part("Who counts as invited");
  is("a creator is never their own invite", await recordInvite(ana, code, NOW - INVITED * DAY * 1000), "own");
  // Ana's second store is still Ana.
  const second = await createStore("ana@example.com", "ana-two", "Ana Two", "");
  if (!second.ok) throw new Error("no second store");
  is("nor is one of their other stores", await recordInvite(second.store, code, NOW), "already");
  is("an unknown code counts for nobody", await recordInvite(bea, "zzzzzzzz", NOW), "no_code");
  is("Bea, invited by Ana", await recordInvite(bea, code, NOW - INVITED * DAY * 1000), "recorded");
  const danCode = await inviteCode(dan.sid);
  if (!danCode) throw new Error("no code");
  is("a second invite for Bea does not take her over", await recordInvite(bea, danCode, NOW), "already");
  is("Cal, invited by Ana", await recordInvite(cal, code, NOW - INVITED * DAY * 1000), "recorded");
  is("Eve, invited by Dan", await recordInvite(eve, danCode, NOW - INVITED * DAY * 1000), "recorded");

  part("Terms stay with the invitation");
  const beaRecord = JSON.parse(String(redis.run(["GET", byKey(bea.sid)])));
  is("new invites snapshot the terms on offer: while the program is paused, the original ones", beaRecord.terms, INVITE_PROGRAM_OPEN ? currentInviteTerms() : readInviteTerms(undefined));
  is("legacy records retain their original bonus", parseBy(JSON.stringify({ r: ana.sid, at: 1 }))?.terms?.bonusCents, 2900);
  is("unknown versions are not legacy offers", readInviteTerms({ version: 2, sharePercent: 50, bonusCents: 2900 }), null);
  is("invalid stored terms do not earn credit", parseBy(JSON.stringify({ r: ana.sid, at: 1, terms: null })), null);
  is("fractional bonuses are rejected", readInviteTerms({ version: 1, sharePercent: 10, bonusCents: 0.5 }), null);
  is("snapshot controls the share", inviteShare(9900, { version: 1, sharePercent: 25, bonusCents: 500 }), 2475);
  // Simulate an invitation recorded before snapshots, and a different future offer.
  delete beaRecord.terms;
  redis.run(["SET", byKey(bea.sid), JSON.stringify(beaRecord)]);
  const eveRecord = JSON.parse(String(redis.run(["GET", byKey(eve.sid)])));
  redis.run(["SET", byKey(eve.sid), JSON.stringify({ ...eveRecord, terms: { version: 1, sharePercent: 25, bonusCents: 500 } })]);

  part("Accepting an invite keeps it; a bad one keeps nothing");
  const req = { nextUrl: { protocol: "https:" } } as never;
  const yes = await accept(req, { params: Promise.resolve({ code }) });
  is("new acceptances are paused", INVITE_PROGRAM_OPEN, false);
  is("it explains the pause at sign-up", yes.headers.get("location"), "/signin?status=invite-paused");
  is("no new invite cookie is issued", (yes.headers.get("set-cookie") ?? "").includes(INVITE_COOKIE), false);
  is("existing cookies are not overwritten or cleared", yes.headers.get("set-cookie"), null);
  is("previous acceptances can finish before expiry", mayRecordAcceptedInvite(LEGACY_INVITE_RECORDING_UNTIL - 1), true);
  is("the grace cannot run forever", mayRecordAcceptedInvite(LEGACY_INVITE_RECORDING_UNTIL), false);
  is("invalid clocks cannot grant a referral", mayRecordAcceptedInvite(NaN), false);
  is("expired grace refuses a new record", await recordInvite({ sid: "f".repeat(32), email: "late@example.com", extra: false }, code, LEGACY_INVITE_RECORDING_UNTIL), "paused");
  const no = await accept(req, { params: Promise.resolve({ code: "zzzzzzzz" }) });
  is("a code nobody has sets nothing", no.headers.get("set-cookie"), null);

  part("What one payment earns");
  is("half of it, rounded down", inviteShare(2900), 1450);
  is("an odd cent is not rounded up", inviteShare(2901), 1450);
  is("nothing paid, nothing earned", inviteShare(0), 0);
  is("a refund comes off first", paidOn({ amount_paid: 2900, post_payment_credit_notes_amount: 0 }, 900), 2000);
  is("so does a credit note", paidOn({ amount_paid: 2900, post_payment_credit_notes_amount: 2900 }, 0), 0);

  // Everyone who has started paying has a customer.
  await setSubscription("ana@example.com", { customerId: "cus_Ana0001", subscriptionId: "sub_Ana0001", active: true, period: paidPeriod() });
  await setSubscription("bea@example.com", { customerId: "cus_Bea0001", subscriptionId: "sub_Bea0001", active: true, period: paidPeriod() });
  await setSubscription("cal@example.com", { customerId: "cus_Cal0001", subscriptionId: "sub_Cal0001", active: true, period: paidPeriod() });
  await setSubscription("eve@example.com", { customerId: "cus_Eve0001", subscriptionId: "sub_Eve0001", active: true, period: paidPeriod() });
  invoices.set("cus_Bea0001", [
    invoice("in_BeaRecent1", 2900, INSIDE, INSIDE, "pi_bea_recent"),
    invoice("in_BeaRefund1", 2900, PAST, PAST, "pi_bea_refunded"),
    invoice("in_BeaFirst01", 2900, LONG_PAST, LONG_PAST, "pi_bea_first"),
  ]);
  refunds.set("pi_bea_refunded", [{ amount: 2900, status: "succeeded" }]);
  // Cal paid us long before Ana's invite: she left and came back.
  invoices.set("cus_Cal0001", [
    invoice("in_CalNow001", 2900, PAST, PAST, "pi_cal_now"),
    invoice("in_CalOld001", 2900, 400, 400, "pi_cal_old"),
  ]);
  invoices.set("cus_Eve0001", [invoice("in_EveFirst01", 9900, PAST, PAST, "pi_eve_first")]);

  part("The daily run");
  const first = await settleInvites(Date.now() + 60_000, NOW);
  is("it finished", first.complete, true);
  is("it read Stripe at the pinned version, and only that", [...versions], [INVITE_STRIPE_VERSION]);
  const ana$ = balance.get("cus_Ana0001") ?? [];
  is("Ana: half of Bea's first payment, once", ana$.map((t) => t.amount), [-1450]);
  is("in dollars", ana$[0]?.currency, "usd");
  is("Bea: her own credit after her first payment", (balance.get("cus_Bea0001") ?? []).map((t) => t.amount), [-(INVITE_PROGRAM_OPEN ? INVITE_BONUS_CENTS : readInviteTerms(undefined)!.bonusCents)]);
  is("the refunded payment earned nothing", JSON.parse(String(redis.run(["GET", creditKey("in_BeaRefund1")]))).state, "none");
  is("the payment inside its refund window is not read yet", redis.run(["EXISTS", creditKey("in_BeaRecent1")]), 0);
  is("Cal had paid us before: nothing for anyone", (balance.get("cus_Cal0001") ?? []).length, 0);
  is("Dan is not paying us yet: his credit waits", balance.has("cus_Dan0001"), false);
  is("Eve still gets hers", (balance.get("cus_Eve0001") ?? []).map((t) => t.amount), [-500]);
  is("each request carried its credit's own key", keys.every((k) => k.startsWith("nimbus-invite-")), true);

  part("Nothing twice");
  const before = posts;
  await settleInvites(Date.now() + 60_000, NOW);
  is("a second run sends nothing", posts, before);
  // The note that the credit was sent is lost after Stripe took it.
  const note = JSON.parse(String(redis.run(["GET", creditKey("in_BeaFirst01")])));
  await redis.pipeline([
    ["SET", creditKey("in_BeaFirst01"), JSON.stringify({ ...note, state: "owed", txn: undefined })],
    ["SADD", OWED_KEY, "in_BeaFirst01"],
  ]);
  await settleInvites(Date.now() + 60_000, NOW);
  is("a credit whose note was lost is found at Stripe, not sent again", posts, before);
  is("and is written down as done again", JSON.parse(String(redis.run(["GET", creditKey("in_BeaFirst01")]))).state, "done");

  part("Later");
  await setSubscription("dan@example.com", { customerId: "cus_Dan0001", subscriptionId: "sub_Dan0001", active: true, period: paidPeriod() });
  await settleInvites(Date.now() + 60_000, NOW + 12 * DAY * 1000);
  is("Dan started paying: what he earned is on his plan", (balance.get("cus_Dan0001") ?? []).map((t) => t.amount), [-2475]);
  is("Bea's recent payment, out of its window, earned Ana her half", (balance.get("cus_Ana0001") ?? []).map((t) => t.amount), [-1450, -1450]);
  is("and Bea's own credit is not given twice", (balance.get("cus_Bea0001") ?? []).length, 1);

  part("What Ana sees");
  const anaNow = await storeForEmail("ana@example.com");
  if (!anaNow) throw new Error("no store");
  const view = await inviteView(anaNow, NOW);
  is("two creators", view?.total, 2);
  is("credit added", view?.added, 2900);
  is("nothing left on its way", view?.owed, 0);
  is(
    "each with where they stand",
    view?.invited.map((r) => [r.handle, r.state, r.added]).sort(),
    [["bea", "paying", 2900], ["cal", "returning", 0]],
  );

  done();
}

void main();
