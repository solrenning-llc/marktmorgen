/**
 * More lost disputes in a job's window than one run may read (review of
 * #2129, inbox C4-15 (3)(c)). Stripe lists the closing events newest first:
 * without a place kept across runs, every run read the same newest pages,
 * `complete` stayed false and the jobs' place never moved. With the cursor
 * (lib/refunds.ts, lostCursorKey), the next run reads on from where the last
 * stopped, and the run that reaches the end hands back the newest closing of
 * the whole sweep, so the job's place moves past every page read.
 */
import { LOST_DISPUTE_PAGES, lostCursorKey, lostDisputesSince } from "@/lib/refunds";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_lost_dispute_cursor_only";
const ACCOUNT = "acct_1TestCursor0001";
const NOW = Math.floor(Date.now() / 1000);
const TOTAL = 100 * LOST_DISPUTE_PAGES + 200;
// Newest first, as Stripe lists them.
const events = Array.from({ length: TOTAL }, (_, i) => ({
  id: `evt_Cursor${String(i).padStart(6, "0")}`,
  object: "event",
  type: "charge.dispute.closed",
  created: NOW - i,
  data: { object: { id: `du_${i}`, object: "dispute", status: "lost", charge: `ch_Cursor${String(i).padStart(6, "0")}`, payment_intent: `pi_Cursor${String(i).padStart(6, "0")}` } },
}));
let reads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname !== "/v1/events") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  reads += 1;
  const after = url.searchParams.get("starting_after");
  const from = after ? events.findIndex((e) => e.id === after) + 1 : 0;
  const limit = Number(url.searchParams.get("limit") ?? 10);
  const data = events.slice(from, from + limit);
  return new Response(JSON.stringify({ object: "list", data, has_more: from + limit < events.length }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const since = NOW - 86_400;
  const key = lostCursorKey("keys", "s".repeat(32));
  const seen = new Set<string>();

  part("Without a place kept, the same newest pages every run");
  const first = await lostDisputesSince(ACCOUNT, since);
  const again = await lostDisputesSince(ACCOUNT, since);
  is("each run reads the newest pages and is never complete", [first.complete, again.complete, first.rows[0].id === again.rows[0].id], [false, false, true]);

  part("With the job's place kept");
  reads = 0;
  const one = await lostDisputesSince(ACCOUNT, since, Number.POSITIVE_INFINITY, LOST_DISPUTE_PAGES, key);
  for (const row of one.rows) seen.add(String(row.id));
  is("the first run reads as many pages as it may, not complete, and keeps where it stopped", [one.complete, one.rows.length, reads, typeof (await redis.pipeline([["GET", key]]))[0]], [false, 100 * LOST_DISPUTE_PAGES, LOST_DISPUTE_PAGES, "string"]);
  const two = await lostDisputesSince(ACCOUNT, since, Number.POSITIVE_INFINITY, LOST_DISPUTE_PAGES, key);
  for (const row of two.rows) seen.add(String(row.id));
  is("the next run reads on from there and reaches the end", [two.complete, two.rows.length, two.rows.some((r) => one.rows.some((o) => o.id === r.id))], [true, 200, false]);
  is("every lost dispute read once, across the two runs", seen.size, TOTAL);
  is("the end hands back the newest closing of the whole sweep, so the job's place moves past every page", two.newest, NOW);
  is("and the place is let go", (await redis.pipeline([["GET", key]]))[0], null);

  part("A place of another window is never followed");
  await lostDisputesSince(ACCOUNT, since, Number.POSITIVE_INFINITY, LOST_DISPUTE_PAGES, key);
  const other = await lostDisputesSince(ACCOUNT, since - 60, Number.POSITIVE_INFINITY, LOST_DISPUTE_PAGES, key);
  is("a run with another window starts from the newest", other.rows[0].id, events[0].id);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
