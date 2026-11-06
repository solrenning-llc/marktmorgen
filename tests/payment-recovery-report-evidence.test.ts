import { recoveredFrom, recoveryReport } from "@/lib/payment-recovery-report";
import { countKey, monthOf, sentKey } from "@/lib/dunning-keys";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const now = Date.UTC(2026, 10, 5, 1);
const store = { handle: "recovery-evidence", previousHandles: [], releasedHandles: [], stripeAccountId: "acct_test_recovery_evidence", statsId: "f".repeat(32), currency: "usd" } as unknown as Store;
const cache = `nl:dun:report:${store.statsId}:v2`;
const invoice = (id = "in_confirmed", extra: Record<string, unknown> = {}) => ({ id, currency: "usd", amount_paid: 1234, attempt_count: 2, paid_out_of_band: false, billing_reason: "subscription_cycle", status_transitions: { paid_at: now / 1000 - 60 }, parent: { subscription_details: { metadata: { store: store.handle } } }, ...extra });
const page = (data: unknown, has_more: unknown = false) => ({ object: "list", data, has_more });
const original = redis.pipeline;
let replies: unknown[] = [];
let reads = 0;
let writes = 0;
let fault: { command: string; reply: unknown[] } | null = null;
redis.pipeline = async commands => {
  if (commands.some(c => c[0] === "SET" && c[1] === cache)) writes += 1;
  if (fault && commands[0]?.[0] === fault.command) return fault.reply;
  return original(commands);
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if ((init?.method ?? "GET") !== "GET" || url.pathname !== "/v1/invoices") throw new Error("Unexpected provider operation");
  const body = replies[Math.min(reads, replies.length - 1)];
  reads += 1;
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;
const reset = (pages: unknown[] = [page([invoice()])]) => { redis.clear(); replies = pages; reads = 0; writes = 0; fault = null; };
async function refuses(name: string, fresh = true) {
  let refused = false;
  try { await recoveryReport(store, fresh, now); } catch { refused = true; }
  is(name + ": unconfirmed report refused", refused, true);
  is(name + ": no successful cache write", writes, 0);
  is(name + ": no successful cached result", await original([["GET", cache]]), [null]);
}
async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_recovery_evidence_only";
  part("An incomplete invoice page is not a complete zero result");
  for (const [name, reply] of [
    ["missing envelope", {}], ["null envelope", null], ["array envelope", []],
    ["missing list kind", { data: [], has_more: false }], ["missing rows", { object: "list", has_more: false }],
    ["null rows", page(null)], ["missing completion", { object: "list", data: [] }], ["null completion", page([], null)],
    ["empty partial page", page([], true)], ["missing identity", page([{}])], ["null row", page([null])],
    ["invalid identity", page([invoice("not-an-invoice")])], ["duplicate identities", page([invoice(), invoice()])],
    ["overfull page", page(Array.from({ length: 101 }, (_, n) => invoice("in_" + n)))],
    ["missing amount", page([invoice("in_amount", { amount_paid: undefined })])],
    ["numeric-text amount", page([invoice("in_amount", { amount_paid: "1234" })])],
    ["missing currency", page([invoice("in_currency", { currency: undefined })])],
    ["unknown attempt count", page([invoice("in_attempt", { attempt_count: null })])],
    ["missing payment time", page([invoice("in_time", { status_transitions: {} })])],
    ["future payment time", page([invoice("in_time", { status_transitions: { paid_at: now / 1000 + 1 } })])],
    ["unknown billing reason", page([invoice("in_reason", { billing_reason: "not_a_stripe_reason" })])],
    ["prototype-shaped billing reason", page([invoice("in_reason", { billing_reason: "__proto__" })])],
  ] as [string, unknown][]) {
    reset([reply]); await refuses(name); is(name + ": no extra provider read", reads, 1);
  }
  part("Redis evidence needs the exact envelope and values");
  for (const reply of [[], [null], [[]], [["1"]], [["1", "2", "3"]], [[null, {}]], [["bad", "2"]], [["-1", "0"]], [["9007199254740992", "0"]], [["1", 2]]] as unknown[][]) {
    reset(); fault = { command: "HMGET", reply }; await refuses("Unknown monthly counts " + JSON.stringify(reply));
  }
  reset([page([])]);
  await original([["HSET", countKey(store.statsId!, monthOf(now)), "failed", String(Number.MAX_SAFE_INTEGER), "cards", "2"]]);
  await refuses("Monthly counter total outside the exact integer range");
  reset([page([])]);
  await original([["SET", cache, JSON.stringify({ at: Math.floor(now / 1000), currency: "usd", recovered: 0, cents: 0, afterEmail: 0, afterEmailCents: 0, elsewhere: 0, month: { failed: Number.MAX_SAFE_INTEGER, cards: 2 }, complete: true })]]);
  let unsafeCacheRefused = false;
  try { await recoveryReport(store, false, now); } catch { unsafeCacheRefused = true; }
  is("cached monthly counter total outside the exact integer range is refused", unsafeCacheRefused, true);
  is("unsafe cached monthly total starts no provider work or replacement write", [reads, writes], [0, 0]);
  for (const reply of [[], [undefined], [null], ["1"], [2], [true], [1, 0]] as unknown[][]) {
    reset(); fault = { command: "EXISTS", reply }; await refuses("Unknown email receipt " + JSON.stringify(reply));
  }
  for (const reply of [[], [undefined], [0], [{}], ["{}"], ["broken JSON"], ["[]"]] as unknown[][]) {
    reset(); fault = { command: "GET", reply }; await refuses("Unknown cached reading " + JSON.stringify(reply), false); is("unknown cached response starts no provider work", reads, 0);
  }
  part("Confirmed zero, amounts, receipts and page cap retain their meaning");
  reset([page([])]);
  const zero = await recoveryReport(store, true, now);
  is("confirmed empty invoice list and absent counters mean zero", [zero?.recovered, zero?.cents, zero?.month, zero?.complete], [0, 0, { failed: 0, cards: 0 }, true]);
  reset(); await original([["SET", sentKey(store.stripeAccountId!, "in_confirmed"), "1"], ["HSET", countKey(store.statsId!, monthOf(now)), "failed", "3", "cards", "2"]]);
  const known = await recoveryReport(store, true, now);
  is("confirmed amount, attribution and monthly counts", [known?.recovered, known?.cents, known?.afterEmail, known?.afterEmailCents, known?.month], [1, 1234, 1, 1234, { failed: 3, cards: 2 }]);
  const before = reads;
  is("confirmed cache retains the report", await recoveryReport(store, false, now), known);
  is("confirmed cache makes no provider call", reads, before);
  reset([page([invoice("in_manual", { billing_reason: "manual" })])]);
  const manual = await recoveryReport(store, true, now);
  is("recognized non-renewal invoice is not reported as recovered", [manual?.recovered, manual?.cents, manual?.complete], [0, 0, true]);
  reset([page([])]);
  await original([["HSET", countKey(store.statsId!, monthOf(now)), "failed", String(Number.MAX_SAFE_INTEGER - 2), "cards", "2"]]);
  const edge = await recoveryReport(store, true, now);
  is("largest exact monthly counter total remains known", edge?.month, { failed: Number.MAX_SAFE_INTEGER - 2, cards: 2 });
  reset([page([invoice("in_first")], true), page([invoice("in_first")])]);
  await refuses("repeated next-page identity"); is("duplicate page stops before another request", reads, 2);
  reset(Array.from({ length: 10 }, (_, n) => page([invoice("in_page" + n)], true)));
  const capped = await recoveryReport(store, true, now);
  is("existing ten-page cap is still explicitly partial", [reads, capped?.recovered, capped?.complete], [10, 10, false]);
  for (const amount of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let refused = false;
    try { recoveredFrom([invoice("in_amount", { amount_paid: amount })], new Set([store.handle]), "usd", new Set(), now); } catch { refused = true; }
    is("pure recovered amount remains unknown " + String(amount), refused, true);
  }
  let overflow = false;
  try { recoveredFrom([invoice("in_large", { amount_paid: Number.MAX_SAFE_INTEGER }), invoice("in_next")], new Set([store.handle]), "usd", new Set(), now); } catch { overflow = true; }
  is("an unrepresentable total is not rounded into a known amount", overflow, true);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
