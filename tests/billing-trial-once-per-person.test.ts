/**
 * R26 finding 1 (Claude 6 audit, synthetic only): the free trial is for an
 * account's first store (app/terms/page.tsx, lib/help-content.ts, and
 * app/signin/page.tsx: "returning and additional stores may not qualify").
 * trialOffered reads only the store record, and when the account's first
 * store closes (lib/closed-store-data.ts prepareStore -> closeStoreRecord)
 * the record goes, so the next store the same person makes looked like a
 * fresh first store and its checkout opened with another 14-day trial, as a
 * new Stripe customer.
 *
 * Once per person, as the money-back guarantee already is (lib/plan-refund.ts):
 * the checkout reads, from our own Stripe account, every customer with the
 * store's sign-in address and the customer it opens for, and their
 * subscriptions. A plan of ours or any trial there ends the offer. Read in its
 * exact shape (CX-123 rule 24): a failed request, another shape, an unreadable
 * row, a longer list or too many customers mean no trial, never a trial. The
 * checkout still opens, from today.
 */
import { readFileSync } from "node:fs";
import { createBillingCheckout, trialOffered } from "@/lib/billing";
import { prepareStore } from "@/lib/closed-store-data";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { TRIAL_DAYS } from "@/lib/plan";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_trial_once_per_person_only_a_stand_in";

type Mode =
  | "healthy"
  | "search_error"
  | "search_garbled"
  | "search_not_search"
  | "search_more"
  | "search_bad_row"
  | "subs_error"
  | "subs_garbled"
  | "subs_more"
  | "subs_bad_row";

/** What our synthetic Stripe account holds: customers by id (with their address) and their subscriptions. */
const customers = new Map<string, string>();
const subscriptions = new Map<string, Record<string, unknown>[]>();
let mode: Mode = "healthy";
const sessions: URLSearchParams[] = [];
const reads: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    sessions.push(body);
    const customer = body.get("customer");
    if (customer && !customers.has(customer)) return Response.json({ error: { message: `No such customer: '${customer}'` } }, { status: 400 });
    return Response.json({ url: "https://checkout.stripe.example.test/once-per-person" });
  }
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/prices") return Response.json({ error: { message: "synthetic" } }, { status: 404 });
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/customers/search" && method === "GET") {
    reads.push("search");
    if (mode === "search_error") return Response.json({ error: { message: "synthetic outage" } }, { status: 500 });
    const email = /^email:"(.*)"$/.exec(url.searchParams.get("query") ?? "")?.[1] ?? "";
    const data: unknown[] = [...customers].filter(([, address]) => address === email).map(([id, address]) => ({ id, object: "customer", email: address }));
    if (mode === "search_garbled") return Response.json({ object: "search_result", data: "none", has_more: false });
    if (mode === "search_not_search") return Response.json({ object: "customer", id: "cus_NotASearch01", data, has_more: false });
    if (mode === "search_more") return Response.json({ object: "search_result", data, has_more: true, next_page: "page_2" });
    if (mode === "search_bad_row") data.push({ id: "not-a-customer", email });
    return Response.json({ object: "search_result", data, has_more: false, next_page: null });
  }
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions" && method === "GET") {
    const customer = url.searchParams.get("customer") ?? "";
    reads.push(`subscriptions:${customer}`);
    if (mode === "subs_error") return Response.json({ error: { message: "synthetic outage" } }, { status: 500 });
    if (!customers.has(customer)) return Response.json({ error: { message: `No such customer: '${customer}'` } }, { status: 400 });
    const data: unknown[] = [...(subscriptions.get(customer) ?? [])];
    if (mode === "subs_garbled") return Response.json({ object: "list", data: null, has_more: false });
    if (mode === "subs_more") return Response.json({ object: "list", data, has_more: true });
    if (mode === "subs_bad_row") data.push({ id: "sub_UnreadableRow01", object: "subscription", customer, trial_start: "yesterday", metadata: {} });
    return Response.json({ object: "list", data, has_more: false });
  }
  // Blob listings and anything else the closing touches: empty.
  return Response.json({ object: "list", data: [], blobs: [], has_more: false, hasMore: false });
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.example.test";
const OWNER = "trial-once-owner@example.com";
const NOW = Math.floor(Date.now() / 1000);

function fresh(email: string, extra: Partial<Store> = {}): Store {
  return { handle: "trialonce", email, sid: "", stripeCustomerId: null, subscriptionId: null, extra: false, ...extra } as unknown as Store;
}

/** Opens one checkout and answers whether it carries the trial, and how many sessions it took. */
async function checkout(store: Store, customerId: string | null = store.stripeCustomerId): Promise<{ trial: string | null; missing: string | null; sessions: number; opened: boolean }> {
  sessions.length = 0;
  let opened = true;
  try {
    await createBillingCheckout(store, ORIGIN, { tier: "creator", cycle: "month" }, customerId);
  } catch {
    opened = false;
  }
  const last = sessions[sessions.length - 1];
  return {
    trial: last?.get("subscription_data[trial_period_days]") ?? null,
    missing: last?.get("subscription_data[trial_settings][end_behavior][missing_payment_method]") ?? null,
    sessions: sessions.length,
    opened,
  };
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("A person's first store takes the trial, cancels and closes; the same person makes a store again");
  customers.clear();
  subscriptions.clear();
  mode = "healthy";
  is("(setup) first store made", (await claimHandle(OWNER, "trialoncefirst", "Trial Once First", "")).ok, true);
  await ensureStatsId(OWNER);
  let first = (await storeForEmail(OWNER))!;
  is("(control) the first store's checkout opens with the trial", await checkout(first), { trial: String(TRIAL_DAYS), missing: "cancel", sessions: 1, opened: true });
  // What Stripe keeps after that checkout: the customer, with the address it was opened for, and the trial's subscription.
  customers.set("cus_TrialOnce0001", OWNER);
  subscriptions.set("cus_TrialOnce0001", [{ id: "sub_TrialOnce0001", object: "subscription", customer: "cus_TrialOnce0001", status: "trialing", trial_start: NOW, trial_end: NOW + TRIAL_DAYS * 86_400, metadata: { store: "trialoncefirst", tier: "creator" } }]);
  await setSubscription(OWNER, { customerId: "cus_TrialOnce0001", subscriptionId: "sub_TrialOnce0001", active: true, tier: "creator", cycle: "month", trialEnds: NOW + TRIAL_DAYS * 86_400, period: null });
  first = (await storeForEmail(OWNER))!;
  is("(control) inside its trial, no second trial", trialOffered(first), false);
  subscriptions.set("cus_TrialOnce0001", [{ ...subscriptions.get("cus_TrialOnce0001")![0], status: "canceled" }]);
  await setSubscription(OWNER, { active: false });
  first = (await storeForEmail(OWNER))!;
  await prepareStore(first);
  is("(setup) the closing day removed the store record; the account stays", await storeForEmail(OWNER), null);
  is("(setup) a new store for the same address is allowed", (await claimHandle(OWNER, "trialonceagain", "Trial Once Again", "")).ok, true);
  const again = (await storeForEmail(OWNER))!;
  is("(setup) the same sign-in address, no record of the first store", [again.email, again.stripeCustomerId ?? null, again.subscriptionId ?? null, again.extra], [OWNER, null, null, false]);
  is("the second store's checkout opens without a second trial", await checkout(again), { trial: null, missing: null, sessions: 1, opened: true });
  is("Stripe was asked for the same address's customers and their subscriptions", [reads.includes("search"), reads.includes("subscriptions:cus_TrialOnce0001")], [true, true]);

  part("A plan of ours under the same address, trial or not, also ends the offer");
  const paid = "paid-before@example.com";
  customers.set("cus_PaidBefore0001", paid);
  subscriptions.set("cus_PaidBefore0001", [{ id: "sub_PaidBefore0001", object: "subscription", customer: "cus_PaidBefore0001", status: "canceled", trial_start: null, metadata: { store: "paidbefore", tier: "creator" } }]);
  is("a person who already had a plan, without a trial, pays from today", (await checkout(fresh(paid))).trial, null);

  part("Controls: a person new to us still gets the trial, unchanged");
  const brandNew = "brand-new@example.com";
  reads.length = 0;
  is("confirmed empty search: the trial, as before", await checkout(fresh(brandNew)), { trial: String(TRIAL_DAYS), missing: "cancel", sessions: 1, opened: true });
  is("(control) as a new customer, from the address", [sessions[0]?.get("customer") ?? null, sessions[0]?.get("customer_email") ?? null], [null, brandNew]);
  const quiet = "no-subscription@example.com";
  customers.set("cus_NoSubscription1", quiet);
  is("a customer with no subscription at all: the trial", (await checkout(fresh(quiet))).trial, String(TRIAL_DAYS));
  const other = "other-product@example.com";
  customers.set("cus_OtherProduct01", other);
  subscriptions.set("cus_OtherProduct01", [{ id: "sub_OtherProduct01", object: "subscription", customer: "cus_OtherProduct01", status: "active", trial_start: null, metadata: {} }]);
  is("a subscription that is no plan of ours and never had a trial: the trial", (await checkout(fresh(other))).trial, String(TRIAL_DAYS));
  reads.length = 0;
  is("(control) an additional store: no trial, and Stripe is not asked", [(await checkout(fresh(brandNew, { extra: true }))).trial, reads.length], [null, 0]);
  is("(control) a store that already had a customer: no trial", (await checkout(fresh(brandNew, { stripeCustomerId: "cus_TrialOnce0001" }))).trial, null);

  part("Unknown is never a trial (rule 24): the checkout opens from today");
  for (const unknown of ["search_error", "search_garbled", "search_not_search", "search_more", "search_bad_row"] as Mode[]) {
    mode = unknown;
    is(`customer search ${unknown}: no trial`, await checkout(fresh(brandNew)), { trial: null, missing: null, sessions: 1, opened: true });
  }
  for (const unknown of ["subs_error", "subs_garbled", "subs_more", "subs_bad_row"] as Mode[]) {
    mode = unknown;
    is(`subscriptions ${unknown}: no trial`, await checkout(fresh(quiet)), { trial: null, missing: null, sessions: 1, opened: true });
  }
  mode = "healthy";
  const crowded = "crowded@example.com";
  for (let i = 1; i <= 6; i += 1) customers.set(`cus_Crowded00000${i}`, crowded);
  is("more same-address customers than are read: no trial", (await checkout(fresh(crowded))).trial, null);
  is("a customer the checkout opens for that Stripe no longer has: no trial, from the address", await checkout(fresh(brandNew), "cus_GoneFromStripe1"), { trial: null, missing: null, sessions: 2, opened: true });
  is("(control) after the unknowns, a new person still gets the trial", (await checkout(fresh(brandNew))).trial, String(TRIAL_DAYS));

  part("The studio's buttons read the same answer the checkout opens with");
  const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");
  const studio = flat("app/studio/page.tsx");
  const email = flat("app/studio/email/page.tsx");
  is("the studio asks the person's history while plans are on sale", [studio.includes("trialTo: PLANS_ON_SALE && store && trialOffered(store) ? early(trialOfferedTo(store, null)) : null,"), studio.includes("const withTrial = store ? (planReads.trialTo ? await planReads.trialTo : trialOffered(store)) : true;")], [true, true]);
  is("the email page too, for both of its trial sentences", [email.includes("const withTrial = PLANS_ON_SALE && trialOffered(store) ? await trialOfferedTo(store, null) : trialOffered(store);"), email.includes("{withTrial ? `Start the ${TRIAL_DAYS}-day trial on Pro"), email.includes("{trialOffered(store)"), email.includes("&& trialOffered(store) ? (")], [true, true, false, false]);
  done();
}
main().catch((error) => { console.error = globalThis.console.log; console.log(error); process.exitCode = 1; });
