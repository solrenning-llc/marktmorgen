/**
 * Audit R39, finding 1: a store's closing reaches every Stripe account the
 * store sold through, not only the one connected now.
 *
 * "Disconnect it here" (app/api/stripe/disconnect, clearStripeAccount) lets
 * go of the connection on our side only: Marktmorgen stays connected to that
 * account at Stripe, and what the store sold there (memberships, payment
 * plans) stays on it. The store record now keeps the accounts it was
 * disconnected from (formerStripeAccounts, oldest first, bounded), and the
 * closing steps (holdCharges, retryHolds, releaseHolds, giveBackUnused,
 * tellBuyers, and the closing day's stopRenewals) run on each of them as well as on the one
 * connected now. A payment row whose account is not known is never settled,
 * and the closing day does not treat refunds it could not reach as settled.
 *
 * Controls: a store that never disconnected reads and writes exactly as
 * before (one account, no new field on its record, rows with no account),
 * and a store that never connected closes with no call to Stripe.
 *
 * No provider is reached: fetch is a stand-in for Stripe and the email
 * sender that records each call and the Stripe-Account header it was made
 * on; each account sees only its own objects.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import * as storeLib from "@/lib/store";
import { claimHandle, clearStripeAccount, setStripeAccount, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { FINAL_INDEX, heldPaymentsOf, holdCharges, paidKey, releaseHolds, retryHolds, workKey } from "@/lib/closing-holds";
import { stopRenewals } from "@/lib/closed-store-data";
import { giveBackUnused } from "@/lib/closing-refunds";
import { tellBuyers } from "@/lib/closing-buyers";
import { startClosingCredit } from "@/lib/closing-credit";
import { closeOne, type Hands } from "@/lib/plan-closing";

const OLD = "acct_1R39OldAccount";
const NEW = "acct_1R39NewAccount";
const STRAY = "acct_1R39NotThisStore";
const ENDED_AT = Date.UTC(2026, 9, 1, 12);
const DAY = ENDED_AT + 30 * 86_400_000;
const DAY_SECONDS = Math.floor(DAY / 1000);

/** What each account holds: its members (by handle) and its buyers' payments. */
type World = { members: Record<string, unknown>[]; payments: Record<string, unknown>[] };
const world = new Map<string, World>();
const calls: string[] = [];
const sent: string[] = [];
/** Refunds made, as "<payment> @<account>". */
const refunds: string[] = [];
/** Subscription writes that fail once, by "<sub> @<account>". */
const failOnce = new Set<string>();

const member = (id: string, handle: string, email: string, extra: Record<string, unknown> = {}) => ({ id, object: "subscription", status: "active", metadata: { store: handle }, customer: { id: `cus_${id.slice(4)}`, email }, ...extra });
const payment = (id: string, handle: string, email: string) => ({ id, object: "payment_intent", status: "succeeded", receipt_email: email, metadata: { store: handle }, latest_charge: null });
const searchPage = (rows: unknown[]) => ({ object: "search_result", data: rows, has_more: false, next_page: null });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    type One = { to: string | string[] };
    const body = JSON.parse(String(init?.body)) as One | One[];
    const all = Array.isArray(body) ? body : [body];
    for (const m of all) sent.push([m.to].flat()[0]);
    return json(Array.isArray(body) ? { data: all.map((_, i) => ({ id: `email_${sent.length}_${i}` })) } : { id: `email_${sent.length}` });
  }
  if (url.hostname !== "api.stripe.com") throw new Error(`Unexpected provider: ${url.hostname}`);
  const account = new Headers(init?.headers).get("Stripe-Account") ?? "";
  const path = url.pathname.replace(/^\/v1/, "");
  calls.push(`${method} ${path} @${account}`);
  // The platform's own account: no plan for any test store.
  if (!account) return json(path.endsWith("/search") ? searchPage([]) : { object: "list", data: [], has_more: false });
  const own = world.get(account);
  if (!own) return json({ error: { message: "No such account" } }, 404);
  const handle = (url.searchParams.get("query") ?? "").match(/metadata\['store'\]:'([^']+)'/)?.[1] ?? "";
  if (path === "/subscriptions/search") return json(searchPage(own.members.filter((m) => (m.metadata as { store: string }).store === handle)));
  if (path === "/payment_intents/search") return json(searchPage(own.payments.filter((p) => (p.metadata as { store: string }).store === handle)));
  const sub = path.match(/^\/subscriptions\/(sub_[A-Za-z0-9]+)$/)?.[1];
  if (sub) {
    const row = own.members.find((m) => m.id === sub);
    if (!row) return json({ error: { message: "No such subscription" } }, 404);
    if (method === "POST" && failOnce.delete(`${sub} @${account}`)) return json({ error: { message: "synthetic failure" } }, 500);
    if (method === "DELETE") row.status = "canceled";
    if (method === "POST") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const hold = body.get("metadata[store_hold]");
      if (hold !== null) row.metadata = { ...(row.metadata as object), store_hold: hold };
      if (body.has("pause_collection[behavior]")) row.pause_collection = { behavior: body.get("pause_collection[behavior]") };
      else if (body.get("pause_collection") === "") row.pause_collection = null;
    }
    return json(row);
  }
  if (path === "/invoices") return json({ object: "list", data: [], has_more: false });
  if (path === "/balance") return json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  const intent = path.match(/^\/payment_intents\/(pi_[A-Za-z0-9]+)$/)?.[1];
  if (intent) {
    if (!own.payments.some((p) => p.id === intent)) return json({ error: { message: "No such payment_intent" } }, 404);
    return json({ id: intent, object: "payment_intent", latest_charge: { id: `ch_${intent.slice(3)}`, amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null } });
  }
  if (path === "/refunds" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const pi = body.get("payment_intent") ?? "";
    if (!own.payments.some((p) => p.id === pi)) return json({ error: { message: "No such payment_intent" } }, 404);
    refunds.push(`${pi} @${account}`);
    return json({ id: `re_${pi.slice(3)}`, object: "refund", amount: Number(body.get("amount")), currency: "usd", payment_intent: pi, status: "succeeded" });
  }
  if (path === "/refunds") return json({ object: "list", data: [], has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

let made = 0;
/** A store connected to `first`, then disconnected and connected again as `steps` say. */
async function storeWith(steps: ("disconnect" | string)[], first: string | null = OLD): Promise<{ store: Store; email: string; folder: string; handle: string }> {
  made += 1;
  const handle = `r39former${made}`;
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `R39 Former ${made}`, "");
  if (first) await setStripeAccount(email, first, true);
  for (const step of steps) {
    if (step === "disconnect") await clearStripeAccount(email);
    else await setStripeAccount(email, step, true);
  }
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  await redis.pipeline([["HSET", workKey(folder), "calls", 1000]]);
  return { store, email, folder, handle };
}

function freshWorld(handle: string) {
  world.clear();
  world.set(OLD, { members: [member("sub_R39OldMember01", handle, "old-member@example.com")], payments: [payment("pi_R39OldPaid0001", handle, "old-buyer@example.com")] });
  world.set(NEW, { members: [member("sub_R39NewMember01", handle, "new-member@example.com")], payments: [payment("pi_R39NewPaid0001", handle, "new-buyer@example.com")] });
  calls.length = 0;
  sent.length = 0;
  refunds.length = 0;
  failOnce.clear();
}

const paidRow = (pi: string, email: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ inv: `in_${pi.slice(3)}`, pi, amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: email, ...extra });
const wrote = (sub: string, account: string) => calls.some((c) => c === `POST /subscriptions/${sub} @${account}`);
const refunded = (pi: string, account: string) => refunds.includes(`${pi} @${account}`);
const until = () => Date.now() + 30_000;
// Read through the module so this file also runs (and fails) on a build from before the fix.
const shared = storeLib as unknown as { salesAccounts?: (store: Store) => string[]; MAX_FORMER_STRIPE_ACCOUNTS?: number };
const salesAccounts = (store: Store): string[] | string => shared.salesAccounts?.(store) ?? "missing";
const MAX_FORMER_STRIPE_ACCOUNTS = shared.MAX_FORMER_STRIPE_ACCOUNTS ?? 10;
const noFiles: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };
const stateKeyOf = (store: Store) => `nl:plan:closing:${createHash("sha256").update(storeRef(store)).digest("hex").slice(0, 40)}`;
/** The store's closing day, as the daily job runs it (lib/plan-closing.ts, closeOne): its state and what it answered. */
async function closingDay(store: Store, state: Record<string, unknown>) {
  await redis.pipeline([["ZADD", FINAL_INDEX, ENDED_AT, storeRef(store)], ["SET", stateKeyOf(store), JSON.stringify({ of: ENDED_AT, day: DAY, ...state })]]);
  const closed = await closeOne(storeRef(store), DAY + 60_000, noFiles, Number.POSITIVE_INFINITY);
  const [raw] = await redis.pipeline([["GET", stateKeyOf(store)]]);
  return { closed, state: JSON.parse(String(raw)) as { renewals?: number; refunds?: number } };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r39_former_account_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  console.error = () => {};
  redis.clear();

  part("Control: a store that never disconnected keeps one account and no new field on its record");
  {
    const { store, folder, handle } = await storeWith([]);
    freshWorld(handle);
    is("its accounts are the one connected", salesAccounts(store), [OLD]);
    is("its record carries no list of former accounts", Object.hasOwn(store, "formerStripeAccounts"), false);
    failOnce.add(`sub_R39OldMember01 @${OLD}`);
    const hold = await holdCharges(store, ENDED_AT, until());
    is("holdCharges reads its account only, and marks a member it could not pause", [hold.done, hold.failed, calls.filter((c) => !c.endsWith(`@${OLD}`)).length], [true, 1, 0]);
    const [mark] = await redis.pipeline([["HGET", workKey(folder), "f:sub_R39OldMember01"]]);
    is("the mark is written as before (\"1\")", mark, "1");
    calls.length = 0;
    const retried = await retryHolds(store, ENDED_AT, until());
    is("retryHolds reads and pauses it on its account", [calls.some((c) => c.startsWith(`GET /subscriptions/sub_R39OldMember01 @${OLD}`)), wrote("sub_R39OldMember01", OLD), retried.failed], [true, true, 0]);
    await redis.pipeline([["HSET", paidKey(folder), "sub_R39OldMember01", paidRow("pi_R39OldPaid0001", "old-member@example.com")], ["HSET", workKey(folder), "rcalls", 10]]);
    const settled = await giveBackUnused(store, DAY, { until: until(), final: true });
    is("its member is refunded on its account", [typeof settled === "object" ? [settled.done.length, settled.failed] : settled, refunded("pi_R39OldPaid0001", OLD)], [[1, 0], true]);
    const stopped = await stopRenewals(store, until());
    is("stopRenewals ends its member", [stopped.done, stopped.stopped, calls.includes(`DELETE /subscriptions/sub_R39OldMember01 @${OLD}`)], [true, 1, true]);
  }

  part("Control: a store that never connected Stripe closes with no call to Stripe");
  {
    const { store, handle } = await storeWith([], null);
    freshWorld(handle);
    is("no account", salesAccounts(store), []);
    const hold = await holdCharges(store, ENDED_AT, until());
    const stopped = await stopRenewals(store, until());
    const settled = await giveBackUnused(store, DAY, { until: until(), final: true });
    is("each step is done with nothing to do, and Stripe is not asked", [hold.done, stopped.done, stopped.stopped, settled, calls.length], [true, true, 0, "unavailable", 0]);
  }

  part("\"Disconnect it here\", then the plan ends: the member on the former account is paused, ended and refunded");
  {
    const { store, folder, handle } = await storeWith(["disconnect"]);
    freshWorld(handle);
    is("selling reads no account (unchanged)", store.stripeAccountId, null);
    is("the record keeps the account it was disconnected from", store.formerStripeAccounts, [OLD]);
    is("its accounts for the closing are that one", salesAccounts(store), [OLD]);
    const hold = await holdCharges(store, ENDED_AT, until());
    is("holdCharges pauses the member on the former account", [hold.done, wrote("sub_R39OldMember01", OLD)], [true, true]);
    await redis.pipeline([["HSET", paidKey(folder), "sub_R39OldMember01", paidRow("pi_R39OldPaid0001", "old-member@example.com")], ["HSET", workKey(folder), "rcalls", 10]]);
    const settled = await giveBackUnused(store, DAY, { until: until(), final: true });
    is("giveBackUnused refunds the member's unused time on the former account", [typeof settled === "object" ? [settled.done.length, settled.failed] : settled, refunded("pi_R39OldPaid0001", OLD)], [[1, 0], true]);
    await startClosingCredit(folder, 100);
    const told = await tellBuyers(store, ENDED_AT, DAY, "", until());
    is("tellBuyers reads the former account's buyers and tells them", [told.done, calls.some((c) => c.startsWith(`GET /payment_intents/search @${OLD}`)), sent.includes("old-buyer@example.com")], [true, true, true]);
    calls.length = 0;
    const day = await closingDay(store, {});
    is("the closing day ends the membership on the former account, and only then closes the store", [Boolean(day.state.renewals), calls.includes(`DELETE /subscriptions/sub_R39OldMember01 @${OLD}`), day.closed.state], [true, true, "removed"]);
  }

  part("Disconnected, then connected to a new account: the closing reaches both");
  {
    const { store, folder, handle } = await storeWith(["disconnect", NEW]);
    freshWorld(handle);
    is("selling reads the new account (unchanged)", store.stripeAccountId, NEW);
    is("its accounts for the closing: the former one first, then the one connected now", salesAccounts(store), [OLD, NEW]);
    failOnce.add(`sub_R39NewMember01 @${NEW}`);
    const hold = await holdCharges(store, ENDED_AT, until());
    is("holdCharges pauses the former account's member, and marks the new account's to try again", [hold.done, wrote("sub_R39OldMember01", OLD), hold.failed], [true, true, 1]);
    const [mark] = await redis.pipeline([["HGET", workKey(folder), "f:sub_R39NewMember01"]]);
    is("the mark names the account it belongs to", mark, NEW);
    calls.length = 0;
    const retried = await retryHolds(store, ENDED_AT, until());
    is("retryHolds reads and pauses it on that account", [calls.some((c) => c.startsWith(`GET /subscriptions/sub_R39NewMember01 @${NEW}`)), wrote("sub_R39NewMember01", NEW), retried.failed], [true, true, 0]);
    calls.length = 0;
    const released = await releaseHolds(store, until());
    is("releaseHolds lets both go again, each on its own account", [released.done, released.released, wrote("sub_R39OldMember01", OLD), wrote("sub_R39NewMember01", NEW)], [true, 2, true, true]);
    await holdCharges(store, ENDED_AT, until());
    await redis.pipeline([
      ["HSET", paidKey(folder), "sub_R39OldMember01", paidRow("pi_R39OldPaid0001", "old-member@example.com")],
      ["HSET", paidKey(folder), "sub_R39NewMember01", paidRow("pi_R39NewPaid0001", "new-member@example.com", { a: NEW })],
      ["HSET", workKey(folder), "rcalls", 20],
    ]);
    const copy = await heldPaymentsOf(store, "new-member@example.com");
    is("a person's copy of their payment leaves out the creator's account it names", [copy.length, copy.some((row) => Object.hasOwn(row, "a"))], [1, false]);
    calls.length = 0;
    const settled = await giveBackUnused(store, DAY, { until: until(), final: true });
    is("each member is refunded on the account it paid on", [typeof settled === "object" ? [settled.done.length, settled.failed] : settled, refunded("pi_R39OldPaid0001", OLD), refunded("pi_R39NewPaid0001", NEW)], [[2, 0], true, true]);
    await startClosingCredit(folder, 100);
    const told = await tellBuyers(store, ENDED_AT, DAY, "", until());
    is("tellBuyers reads both accounts' buyers, in order, and tells each once", [told.done, told.after, told.pages, ["old-buyer@example.com", "new-buyer@example.com"].map((e) => sent.filter((to) => to === e).length)], [true, "2|", 2, [1, 1]]);
    calls.length = 0;
    const day = await closingDay(store, {});
    is("the closing day ends both, each on its own account", [Boolean(day.state.renewals), calls.includes(`DELETE /subscriptions/sub_R39OldMember01 @${OLD}`), calls.includes(`DELETE /subscriptions/sub_R39NewMember01 @${NEW}`)], [true, true, true]);
  }

  part("The marks of members to try again, read in an unknown shape: nothing is read or held on a guess, and they stay marked");
  {
    const { store, folder, handle } = await storeWith(["disconnect", NEW]);
    const real = redis.pipeline.bind(redis);
    for (const [label, reply] of [["not a list", "acct_1R39NewAccount"], ["one too few", []], ["an entry that is not text", [7]], ["an absent entry", [null]]] as const) {
      freshWorld(handle);
      failOnce.add(`sub_R39NewMember01 @${NEW}`);
      await holdCharges(store, ENDED_AT, until());
      calls.length = 0;
      redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "HMGET" ? [reply] : real(commands))) as typeof redis.pipeline;
      const outcome = await retryHolds(store, ENDED_AT, until()).then(() => "answered", () => "refused");
      redis.pipeline = real;
      const [mark] = await redis.pipeline([["HGET", workKey(folder), "f:sub_R39NewMember01"]]);
      is(`${label}: refused, no call to Stripe, the member still marked`, [outcome, calls.length, mark], ["refused", 0, NEW]);
    }
  }

  part("A payment row naming an account the store does not have is never settled");
  {
    const { store, folder, handle } = await storeWith(["disconnect"]);
    freshWorld(handle);
    await redis.pipeline([["HSET", paidKey(folder), "sub_R39StrayMember1", paidRow("pi_R39StrayPaid01", "stray@example.com", { a: STRAY })], ["HSET", workKey(folder), "rcalls", 10]]);
    const settled = await giveBackUnused(store, DAY, { until: until(), final: true });
    const [raw] = await redis.pipeline([["HGET", paidKey(folder), "sub_R39StrayMember1"]]);
    is("counted failed and tried again, nothing sent, nothing written", [typeof settled === "object" ? [settled.failed, settled.done.length, settled.unmade.length] : settled, refunds.length, (JSON.parse(String(raw)) as { r?: string }).r ?? null], [[1, 0, 0], 0, null]);
  }

  part("The closing day does not take refunds it could not reach as settled");
  {
    const { store, folder, handle } = await storeWith([], null);
    freshWorld(handle);
    // A member's payment kept for a store with no account left to refund it on.
    await redis.pipeline([["HSET", paidKey(folder), "sub_R39LostMember1", paidRow("pi_R39LostPaid001", "lost@example.com")]]);
    const day = await closingDay(store, { renewals: DAY });
    is("held, its refunds not written down as settled, the store not removed", [day.closed.state, Boolean(day.state.refunds)], ["held", false]);
  }

  part("The list of former accounts is bounded: past it, the disconnect is refused and nothing changes");
  {
    const { email } = await storeWith([]);
    for (let i = 1; i < MAX_FORMER_STRIPE_ACCOUNTS; i += 1) {
      await clearStripeAccount(email);
      await setStripeAccount(email, `acct_1R39Cycle${String(i).padStart(4, "0")}`, true);
    }
    await clearStripeAccount(email);
    await setStripeAccount(email, "acct_1R39LastOne0001", true);
    const before = (await storeForEmail(email))!;
    is("it keeps exactly the most it may", before.formerStripeAccounts?.length, MAX_FORMER_STRIPE_ACCOUNTS);
    const result = await clearStripeAccount(email);
    const after = (await storeForEmail(email))!;
    is("refused, saying why", result !== null && "full" in result && result.full, true);
    is("the account connected now and the list are unchanged", [after.stripeAccountId, after.formerStripeAccounts], [before.stripeAccountId, before.formerStripeAccounts]);
  }
  done();
}

void main();
