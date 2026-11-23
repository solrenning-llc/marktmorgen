/**
 * #5285, row of #3866 (Codex X6's LOW, comment 6867548619; before it Claude 3 nuvem N's LEVE and Claude 1's LOW): the
 * meetings job reads whether a refund was already read, and whether it is a known call's, with one SMISMEMBER
 * (lib/call-meetings.ts). #3462 made the reply's outer shape exact (two flags); each flag was still read loosely
 * (`Number(flag) === 1`), so a reply of [null, 0] or ["x", 0] read as "not read yet" and a refund with no payment to
 * look up was marked read on a reply that proved nothing. Each flag must now be exactly 0 or 1; anything else is
 * unknown: nothing is marked read and the place does not move, so the next run reads it again. Synthetic data only.
 */
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_meeting_refund_flags_only";
const ACCOUNT = "acct_1TestMeetFlags1";
const NOW = Math.floor(Date.now() / 1000);
// A full refund with no payment_intent: the job cannot look a booking up, so it only marks the refund read.
const refund = { id: "re_MeetFlags00001", object: "refund", status: "succeeded", created: NOW - 60, payment_intent: null, charge: { object: "charge", refunded: true, amount: 5_000, amount_refunded: 5_000 } };

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === "/v1/refunds") return new Response(JSON.stringify({ object: "list", data: [refund], has_more: false }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const callsId = "c".repeat(16);
const shop = { statsId: "d".repeat(32), callsId, stripeAccountId: ACCOUNT, handle: "meet-flags", previousHandles: [] } as unknown as Store;
const seenKey = `nl:meet:rf:${callsId}:seen`;
const anchorKey = `nl:meet:rf:${callsId}:since`;
type Batch = (string | number)[][];

async function run(flags: unknown): Promise<{ seen: boolean; anchor: unknown }> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) =>
    flags !== undefined && batch.length === 1 && batch[0][0] === "SMISMEMBER" && batch[0][1] === seenKey ? [flags] : original(batch)) as typeof redis.pipeline;
  try {
    await syncMeetings(async (handle) => (handle === "meet-flags" ? shop : null), Date.now() + 60_000, "https://marktmorgen.com");
  } finally {
    redis.pipeline = original;
  }
  const [seen, anchor] = await redis.pipeline([["SISMEMBER", seenKey, refund.id], ["GET", anchorKey]]);
  return { seen: seen === 1, anchor };
}

async function fresh(): Promise<void> {
  redis.clear();
  await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|meet-flags`], ["SET", anchorKey, String(NOW - 600)]]);
}

async function main(): Promise<void> {
  part("Flags read exactly: the refund with no payment to look up is marked read, as before");
  await fresh();
  is("the real reply ([0, 0]): marked read", (await run(undefined)).seen, true);

  part("A flag that is not exactly 0 or 1 is unknown: nothing marked read, the place does not move");
  for (const [what, flags] of [["[null, 0]", [null, 0]], ['["x", 0]', ["x", 0]], ["[0, null]", [0, null]], ["[2, 0]", [2, 0]]] as [string, unknown][]) {
    await fresh();
    const got = await run(flags);
    is(`${what}: the refund is not marked read`, got.seen, false);
    is(`${what}: the place does not move`, got.anchor, String(NOW - 600));
  }
  done();
}

void main();
