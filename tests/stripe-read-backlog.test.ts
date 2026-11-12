/**
 * Issue #4285 (Codex P, hidden #3999, transcribed by Claude 1): a store read without an anchor (its first run, or an anchor Stripe no longer knows)
 * reads at most FIRST_RUN_PAGES = 10 pages newest-first, sets the anchor to the newest event, and nothing ever
 * asks Stripe for page eleven: the older matching events are skipped for good. Synthetic only (stubbed Stripe).
 */
import { addEndpoint, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_webhook_first_read_gap_only";
const account = "acct_FirstReadGap3999";
// 1,100 matching events, newest first, in eleven pages of 100.
const ids = Array.from({ length: 1100 }, (_, i) => `evt_Gap${String(1100 - i).padStart(5, "0")}`);
const row = (id: string) => ({ id, type: "payment_intent.succeeded", data: { object: {} } });
const requests: URL[] = [];
let lostAnchor = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== "/v1/events" || init?.method !== "GET" ||
      new Headers(init.headers).get("Stripe-Account") !== account) throw new Error("unexpected synthetic operation");
  requests.push(url);
  const before = url.searchParams.get("ending_before");
  if (before && before === lostAnchor) return Response.json({ error: { message: "No such event" } }, { status: 404 });
  if (before) {
    const at = ids.indexOf(before);
    const newer = at <= 0 ? [] : ids.slice(Math.max(0, at - 100), at);
    return Response.json({ data: newer.map(row), has_more: at - 100 > 0 });
  }
  const after = url.searchParams.get("starting_after");
  const from = after ? ids.indexOf(after) + 1 : 0;
  const page = ids.slice(from, from + 100);
  return Response.json({ data: page.map(row), has_more: from + 100 < ids.length });
}) as typeof fetch;

async function setup(anchor: string | null) {
  redis.clear();
  await claimHandle("gap3999@example.com", "gap-shop-3999", "Gap Shop", "");
  await ensureStatsId("gap3999@example.com");
  is("synthetic connected account is saved", (await setStripeAccount("gap3999@example.com", account)).ok, true);
  const store = (await storeForEmail("gap3999@example.com"))!;
  is("endpoint listening to sale.completed", (await addEndpoint(store, "https://hooks.example.net/sales", ["sale.completed"])).ok, true);
  const key = `nl:hooks:anchor:${store.statsId}`;
  if (anchor) await redis.pipeline([["SET", key, anchor]]);
  requests.length = 0;
  return key;
}

async function main() {
  const page10Last = ids[999];
  const page11 = ids.slice(1000);
  const asked = () => requests.filter((u) => u.searchParams.get("starting_after") === page10Last).length;
  const log = console.error;
  console.error = () => {};

  part("A: no anchor, eleven full pages since the configured start");
  let key = await setup(null);
  const first = await watchStripe(Date.now() + 60_000);
  const second = await watchStripe(Date.now() + 60_000);
  const third = await watchStripe(Date.now() + 60_000);
  console.error = log;
  is("first run handles the newest 1,000 (diagnostic)", first.events, 1000);
  is("the anchor is set to the newest event (diagnostic)", await redis.pipeline([["GET", key]]), [ids[0]]);
  is("over three runs, Stripe is asked for page eleven at least once", asked() > 0, true);
  is("over three runs, all 1,100 events are handled", first.events + second.events + third.events, 1100);

  part("B: an anchor Stripe no longer knows (a pause longer than Stripe keeps it), re-read from 29 days back");
  console.error = () => {};
  lostAnchor = "evt_GoneLongAgo01";
  key = await setup(lostAnchor);
  const resumed = await watchStripe(Date.now() + 60_000);
  const next = await watchStripe(Date.now() + 60_000);
  console.error = log;
  is("the lost anchor answered 404 and the store was read again from 29 days back (diagnostic)", requests[0].searchParams.get("ending_before"), lostAnchor);
  is("after the re-read, Stripe is asked for page eleven at least once", asked() > 0, true);
  is("after the re-read, all 1,100 events still inside Stripe's 30 days are handled", resumed.events + next.events, 1100);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
