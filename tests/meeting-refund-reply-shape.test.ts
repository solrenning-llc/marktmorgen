/**
 * The meetings job reads Stripe's lists in their exact shape (unknown is never
 * zero). A refunded call gives the buyer's meeting link up and the hosts'
 * time back (lib/call-meetings.ts, callRefunded, releaseClaim). Before, a
 * 200 answer to the payment's checkout session lookup without its `data` list
 * read as "no booking", and the refund was marked read for good: the job
 * never looked again, the meeting stayed and the hosts' time was never given
 * back. A 200 answer to the refunds list without its list read as "no
 * refunds", the end of the list. Each now throws, so nothing is marked read
 * and the place does not move: the next run reads the same window again.
 * Synthetic data only.
 */
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_meeting_refund_shape_only";
const ACCOUNT = "acct_1TestMeetShape1";
const NOW = Math.floor(Date.now() / 1000);
const refund = { id: "re_MeetShape0001", object: "refund", status: "succeeded", created: NOW - 60, payment_intent: "pi_MeetShape0001", charge: { object: "charge", refunded: true, amount: 5_000, amount_refunded: 5_000 } };

let sessionsAnswer: unknown = { object: "list", data: [], has_more: false };
let refundsAnswer: unknown = { object: "list", data: [refund], has_more: false };
let lookups = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === "/v1/refunds") return new Response(JSON.stringify(refundsAnswer));
  if (url.pathname === "/v1/checkout/sessions") {
    lookups += 1;
    return new Response(JSON.stringify(sessionsAnswer));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const callsId = "e".repeat(16);
const shop = { statsId: "f".repeat(32), callsId, stripeAccountId: ACCOUNT, handle: "meet-shape", previousHandles: [] } as unknown as Store;
const seenKey = `nl:meet:rf:${callsId}:seen`;
const anchorKey = `nl:meet:rf:${callsId}:since`;

async function run(): Promise<{ seen: boolean; anchor: unknown }> {
  await syncMeetings(async (handle) => (handle === "meet-shape" ? shop : null), Date.now() + 60_000, "https://marktmorgen.com");
  const [seen, anchor] = await redis.pipeline([["SISMEMBER", seenKey, refund.id], ["GET", anchorKey]]);
  return { seen: seen === 1, anchor };
}

function fresh(): void {
  redis.clear();
  void redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|meet-shape`]]);
}

async function main(): Promise<void> {
  part("A session lookup Stripe answers in its shape is read as it always was");
  fresh();
  sessionsAnswer = { object: "list", data: [], has_more: false };
  is("an exact empty list: no booking, the refund is read", (await run()).seen, true);

  part("A session lookup answered without its list is unknown, never no booking");
  for (const [what, answer] of [["no data", { object: "list" }], ["data that is not a list", { object: "list", data: {} }], ["an empty object", {}]] as const) {
    fresh();
    sessionsAnswer = answer;
    lookups = 0;
    const got = await run();
    is(`${what}: the payment was looked up`, lookups, 1);
    is(`${what}: the refund is not marked read, so the next run looks again`, got.seen, false);
  }

  part("A refunds list answered without its list is unknown, never the end of the list");
  sessionsAnswer = { object: "list", data: [], has_more: false };
  for (const [what, answer] of [["no data", { object: "list", has_more: false }], ["data that is not a list", { object: "list", data: "x", has_more: false }]] as const) {
    fresh();
    await redis.pipeline([["SET", anchorKey, String(NOW - 600)]]);
    refundsAnswer = answer;
    is(`${what}: the place does not move`, (await run()).anchor, String(NOW - 600));
  }
  done();
}

void main();
