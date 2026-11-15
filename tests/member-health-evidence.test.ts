import { readFileSync } from "node:fs";
import { memberHealth, runningMembers } from "@/lib/member-health";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const store = {
  handle: "health-evidence", previousHandles: [], releasedHandles: [],
  stripeAccountId: "acct_test_health_evidence", statsId: "e".repeat(32),
  currency: "usd", community: { on: false }, catalog: { items: [] },
} as unknown as Store;
const member = (id: string, extra: Record<string, unknown> = {}) => ({
  id, status: "active", metadata: { store: store.handle }, ...extra,
});
const scoredMember = (extra: Record<string, unknown> = {}) => ({
  id: "sub_scored", status: "past_due", currency: "usd", start_date: 1_700_000_000, cancel_at_period_end: true,
  customer: { id: "cus_scored", email: "member@example.com" },
  metadata: { store: store.handle, product: "synthetic-product" },
  items: { data: [{ quantity: 1, current_period_end: 1_900_000_000, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  ...extra,
});
const page = (data: unknown, has_more: unknown = false) => ({ object: "list", data, has_more });
let replies: unknown[] = [];
let paths: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if ((init?.method ?? "GET") !== "GET" || url.pathname !== "/v1/subscriptions") throw new Error("Unexpected provider operation");
  paths.push(url.pathname + url.search);
  return new Response(JSON.stringify(replies[Math.min(paths.length - 1, replies.length - 1)]), { status: 200 });
}) as typeof fetch;
const reset = (values: unknown[]) => { redis.clear(); replies = values; paths = []; };

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_member_health_evidence_only";
  part("Unknown membership lists never become complete zero-member reports");
  const invalid: [string, unknown][] = [
    ["missing envelope", {}], ["null envelope", null], ["array envelope", []],
    ["missing list kind", { data: [], has_more: false }],
    ["wrong list kind", { object: "subscription", data: [], has_more: false }],
    ["missing rows", { object: "list", has_more: false }], ["null rows", page(null)],
    ["missing completion", { object: "list", data: [] }],
    ["null completion", page([], null)], ["numeric completion", page([], 0)],
    ["empty page that claims more", page([], true)],
    ["missing row identity", page([{}])], ["null row", page([null])],
    ["bad row identity", page([member("not-a-subscription")])],
    ["missing row status", page([member("sub_status", { status: undefined })])],
    ["unknown row status", page([member("sub_status", { status: "unknown" })])],
    ["missing ownership metadata", page([member("sub_meta", { metadata: undefined })])],
    ["malformed ownership metadata", page([member("sub_meta", { metadata: [] })])],
    ["malformed ownership value", page([member("sub_meta", { metadata: { store: 1 } })])],
    ["duplicate rows", page([member("sub_same"), member("sub_same")])],
    ["overfull page", page(Array.from({ length: 101 }, (_, n) => member("sub_" + n)))],
    ["partly valid page", page([member("sub_valid"), {}])],
  ];
  for (const [name, reply] of invalid) {
    reset([reply]);
    let refused = false;
    try { await memberHealth(store, true); } catch { refused = true; }
    is(name + ": no report certified", refused, true);
    is(name + ": no successful cache", await redis.pipeline([["GET", `nl:health:${store.statsId}`]]), [null]);
    is(name + ": no extra provider read", paths.length, 1);
  }
  part("Incomplete owned rows are left out and disclosed as partial");
  for (const [name, row] of [
    ["missing expanded customer", scoredMember({ customer: undefined })],
    ["missing unit amount", scoredMember({ items: { data: [{ quantity: 1, current_period_end: 1_900_000_000, price: { recurring: { interval: "month", interval_count: 1 } } }] } })],
    ["missing subscription currency", scoredMember({ currency: undefined })],
    ["missing item quantity", scoredMember({ items: { data: [{ current_period_end: 1_900_000_000, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] } })],
    ["null item quantity", scoredMember({ items: { data: [{ quantity: null, current_period_end: 1_900_000_000, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] } })],
  ] as [string, unknown][]) {
    reset([page([row])]);
    let refused = false;
    let health = null;
    try { health = await memberHealth(store, true, 1_800_000_000_000); } catch { refused = true; }
    is(name + ": one bad row does not hide every evidenced member", refused, false);
    is(name + ": the bad row is omitted and counted explicitly", health && [health.members.length, health.unscored, health.complete, health.counts, health.atRisk], [0, 1, true, { well: 0, slipping: 0, risk: 0 }, 0]);
  }
  reset([page([scoredMember(), scoredMember({ id: "sub_partial", customer: null })])]);
  const partial = await memberHealth(store, true, 1_800_000_000_000);
  is("good evidence stays usable beside one incomplete row", partial && [partial.members.length, partial.members[0]?.email, partial.unscored], [1, "member@example.com", 1]);
  const pageSource = readFileSync("app/studio/memberships/page.tsx", "utf8");
  is("the creator is told in plain language that omitted memberships make the numbers partial", /not counted here because Stripe did not send all their details\. The numbers above leave them out and are partial\./.test(pageSource), true);
  reset([page([scoredMember()])]);
  const scored = await memberHealth(store, true, 1_800_000_000_000);
  is("fully evidenced owned row stays complete", [scored?.complete, scored?.unscored, scored?.members.length, scored?.members[0]?.monthly, scored?.atRisk], [true, 0, 1, 2000, 2000]);
  reset([page([scoredMember({ items: { data: [{ quantity: 3, current_period_end: 1_900_000_000, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] } })])]);
  const quantity = await memberHealth(store, true, 1_800_000_000_000);
  is("confirmed item quantity remains exact", [quantity?.members[0]?.monthly, quantity?.atRisk], [6000, 6000]);
  part("Copies from before partial evidence was counted are refreshed");
  reset([page([scoredMember({ customer: null })])]);
  await redis.pipeline([["SET", `nl:health:${store.statsId}`, JSON.stringify({
    at: 1_799_999_999, currency: "usd", members: [], counts: { well: 0, slipping: 0, risk: 0 }, atRisk: 0, complete: true,
  }), "EX", 600]]);
  const refreshed = await memberHealth(store, false, 1_800_000_000_000);
  is("an old copy without the omitted-row count cannot hide a partial report", [paths.length, refreshed?.unscored], [1, 1]);
  part("Confirmed empty, filtered and paginated controls");
  reset([page([])]);
  is("explicit empty list confirms absence", await runningMembers(store), { rows: [], complete: true });
  reset([page([member("sub_foreign", { metadata: { store: "another-store" } }), member("sub_untagged", { metadata: {} }), member("sub_canceled", { status: "canceled" }), member("sub_plan", { metadata: { store: store.handle, kind: "plan" } })])]);
  is("confirmed unrelated and inactive records are excluded", await runningMembers(store), { rows: [], complete: true });
  reset([page([member("sub_first")], true), page([member("sub_second", { status: "past_due" })])]);
  const complete = await runningMembers(store);
  is("two complete pages counted once", [complete.rows.map(r => r.id), complete.complete], [["sub_first", "sub_second"], true]);
  is("cursor follows the confirmed last record", new URL("https://example.com" + paths[1]).searchParams.get("starting_after"), "sub_first");
  for (const reply of [page([member("sub_first")]), {}, page([member("sub_new"), member("sub_first")], true)]) {
    reset([page([member("sub_first")], true), reply]);
    let refused = false;
    try { await memberHealth(store, true); } catch { refused = true; }
    is("repeated or unknown next page refuses the whole report", refused, true);
    is("failure never caches earlier rows as complete", await redis.pipeline([["GET", `nl:health:${store.statsId}`]]), [null]);
    is("no repeated-cursor reads", paths.length, 2);
  }
  reset(Array.from({ length: 10 }, (_, n) => page([member("sub_page" + n)], true)));
  const capped = await runningMembers(store);
  is("existing cap remains explicitly partial", [capped.rows.length, capped.complete, paths.length], [10, false, 10]);
  is("existing page size unchanged", paths.every(p => new URL("https://example.com" + p).searchParams.get("limit") === "100"), true);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
