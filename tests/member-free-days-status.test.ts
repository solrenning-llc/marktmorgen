/**
 * 641 [WG1], Codex S corrective focal of #2912 (review 5821881829, MEDIUM M2
 * residual): a subscription status Stripe does not have is unknown, never "not
 * a running membership". A status of " " or "unknown_status" used to pass the
 * row check (any non-empty string), was then left out as not live, and the
 * page read as a confirmed empty list: the studio said "has no running
 * membership" and giving free days answered not_member (409) instead of
 * "Stripe could not be read" (502). The first nine checks are Codex S's
 * boundary probes (proofs/s/2912-focal/status.proof.ts on
 * codex/s-2912-corrective-focal, ba67adaadb), copied unchanged; the rest
 * cover the sibling reader of the same rows (memberSubs, applyMemberDiscount)
 * and every status Stripe documents for the pinned API version, so a
 * legitimate ended membership is still left out.
 *
 * Synthetic transport only; no request leaves the process.
 */
import { claimHandle, ensureStoreId, setStripeAccount, storeForEmail } from "@/lib/store";
import { freeDaysSubs, giveFreeDays } from "@/lib/member-free-days";
import { applyMemberDiscount, memberSubs } from "@/lib/member-discount";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_free_days_only";
const now = 1_794_200_000;
const next = now + 86_400;
let mode = "healthy";
let status = "active";
let posts = 0;
const sub = { id: "sub_sreview0001", object: "subscription", status: "active", metadata: { store: "sfreedays", product: "prod_sreview" }, items: { data: [{ current_period_end: next, price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] } };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === "POST") { posts++; throw new Error("No provider write allowed"); }
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("No external service");
  const list = (data: unknown[]) => Response.json({ object: "list", data, has_more: false });
  if (url.pathname === "/v1/customers") {
    if (mode === "no customer") return list([]);
    // The row holds its own address, the one asked for, as Stripe's exact filter gives it (rule 23: fixture only).
    return list([{ id: "cus_sreview0001", object: "customer", email: url.searchParams.get("email") }]);
  }
  if (url.pathname === "/v1/subscriptions") {
    if (mode === "status whitespace") return list([{ ...sub, status: " " }]);
    if (mode === "status unknown") return list([{ ...sub, status: "unknown_status" }]);
    if (mode === "status") return list([{ ...sub, status }]);
    if (mode === "canceled") return list([{ ...sub, status: "canceled" }]);
    if (mode === "no page") return Response.json({ object: "list" });
    return list([sub]);
  }
  throw new Error("Unexpected synthetic read");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "s-free-days@example.com";
  await claimHandle(owner, "sfreedays", "S Free Days", "");
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_SyntheticDays01", true);
  const store = (await storeForEmail(owner))!;
  const by = { who: owner, role: "owner" as const };

  // Codex S's nine probes, unchanged.
  is("healthy member exists before injected response corruption", (await freeDaysSubs(store, "member@example.com", now))?.map((x) => x.id), [sub.id]);
  for (mode of ["status whitespace", "status unknown"]) {
    const found = await freeDaysSubs(store, "member@example.com", now);
    const given = await giveFreeDays(store, "member@example.com", sub.id, 7, next, by, now);
    is(`${mode}: lookup remains unknown, never an empty membership list`, found, null);
    is(`${mode}: give reports unreadable Stripe, never confirmed not_member`, given, { ok: false, reason: "stripe" });
  }
  mode = "no customer";
  is("confirmed empty complete customer page stays empty", await freeDaysSubs(store, "member@example.com", now), []);
  mode = "canceled";
  is("confirmed canceled subscription stays excluded", await freeDaysSubs(store, "member@example.com", now), []);
  mode = "no page";
  is("missing page data is unknown as already fixed", await freeDaysSubs(store, "member@example.com", now), null);
  is("no subscription write or email was attempted", posts, 0);

  // The sibling reader of the same rows: the discount's find and apply.
  mode = "status";
  for (status of [" ", "unknown_status", "Active", "active ", "cancelled", "ended"]) {
    is(`${JSON.stringify(status)}: the discount's member list is unknown, not empty`, await memberSubs(store, "member@example.com"), null);
    is(`${JSON.stringify(status)}: putting a code on it says Stripe could not be read`, await applyMemberDiscount(store, "member@example.com", sub.id, "promo_sreview0001"), { ok: false, reason: "stripe" });
    is(`${JSON.stringify(status)}: free days lookup is unknown`, await freeDaysSubs(store, "member@example.com", now), null);
  }
  // Every status Stripe documents for subscriptions (API 2025-09-30.clover) still reads: the running ones are found, the ended ones left out.
  for (status of ["active", "trialing", "past_due", "unpaid", "paused"]) {
    is(`${status}: a running membership is still found`, (await memberSubs(store, "member@example.com"))?.map((x) => x.id), [sub.id]);
  }
  for (status of ["canceled", "incomplete", "incomplete_expired"]) {
    is(`${status}: an ended or never-started membership is still left out, as confirmed`, await memberSubs(store, "member@example.com"), []);
    is(`${status}: giving free days to it is still not_member`, await giveFreeDays(store, "member@example.com", sub.id, 7, next, by, now), { ok: false, reason: "not_member" });
  }
  is("still no subscription write or email was attempted", posts, 0);
  done();
}
void main();
