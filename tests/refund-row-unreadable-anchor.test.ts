/**
 * A refund row that does not read is unknown, never "gives nothing back" (rule 24; rule 30, the sibling of Codex P on
 * #2774; Claude 5's pre-review of claude5/plan-refund-own-dispute). The reviews' refund pass (lib/review-proof.ts) reads
 * each listed refund by the refunds' own rule (refundRowKnown, lib/refunds.ts) and keeps its anchor on a row it cannot
 * read. The call meetings (lib/call-meetings.ts) and the license keys (lib/licence-keys.ts) took every row as it came:
 * a row whose status is not one of Stripe's, or whose charge came back as a bare id (not expanded), read as "not given
 * back", was neither handled nor kept for a later look (lib/held-refunds.ts keeps only a row it can tell is unfinished),
 * and the anchor moved past it (by its own time for the meetings, by a later refund's for both). If it was a refund
 * still going through, the paid call's meeting was never ended, the key never revoked. Synthetic Stripe only.
 *
 * What fails here: in either job, an anchor moved past a refund row that does not read.
 */
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import { revokeRefunded } from "@/lib/licence-keys";
import { markRefundedReviews } from "@/lib/review-proof";
import { KIND } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_refund_row_unreadable_only";
const ACCOUNT = "acct_1TestUnreadRow01";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
let refunds: Row[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  if (url.pathname === "/v1/refunds") {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    return list(refunds.filter((r) => Number(r.created) >= gte).sort((a, b) => Number(b.created) - Number(a.created)));
  }
  if (url.pathname.startsWith("/v1/payment_intents/")) return new Response(JSON.stringify({ id: url.pathname.split("/").pop(), object: "payment_intent", metadata: {} }));
  return list([]);
}) as typeof fetch;

function refund(id: string, ago: number, status: string, full: boolean): Row {
  return { id: `re_${id}`, object: "refund", status, created: NOW - ago, payment_intent: `pi_${id}`, charge: { id: `ch_${id}`, object: "charge", refunded: full, amount: 1_000, amount_refunded: full ? 1_000 : 0 } };
}

const anchorOf = async (key: string) => Number((await redis.pipeline([["GET", key]]))[0]);

/** Rows that do not read: a charge not expanded (a bare id), and a status Stripe does not give a refund. */
const UNREADABLE: [string, (row: Row) => Row][] = [
  ["its charge a bare id", (row) => ({ ...row, status: "requires_action", charge: `ch_${String(row.id).slice(3)}` })],
  ["a status that is not Stripe's", (row) => ({ ...row, status: "processing" })],
];

async function main(): Promise<void> {
  const callsId = "r".repeat(16);
  const callStore = { statsId: "s".repeat(32), callsId, stripeAccountId: ACCOUNT, handle: "unread-calls", previousHandles: [] } as unknown as Store;
  const keysStore = { statsId: "t".repeat(32), stripeAccountId: ACCOUNT, handle: "unread-keys", previousHandles: [], catalog: { items: [{ id: "keyproduct", kind: KIND.paid | KIND.keys }] } } as unknown as Store;
  const reviewStore = { statsId: "y".repeat(32), stripeAccountId: ACCOUNT, handle: "unread-reviews" } as unknown as Store;
  const jobs: { name: string; anchor: string; run: () => Promise<unknown> }[] = [
    {
      name: "Call meetings",
      anchor: `nl:meet:rf:${callsId}:since`,
      run: async () => {
        await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|unread-calls`]]);
        return syncMeetings(async (handle) => (handle === "unread-calls" ? callStore : null), Date.now() + 60_000, "https://marktmorgen.com");
      },
    },
    { name: "License keys", anchor: `nl:keys:${keysStore.statsId}:refunds:since`, run: () => revokeRefunded(keysStore, Date.now() + 60_000) },
    // The reviews already read each row by refundRowKnown: the same proof, held for all three.
    { name: "Reviews", anchor: `nl:rev:refunds:since:${reviewStore.statsId}`, run: () => markRefundedReviews(reviewStore, Date.now() + 60_000) },
  ];
  for (const job of jobs) {
    for (const [what, unreadable] of UNREADABLE) {
      part(`${job.name}: a refund row with ${what}, then a later full refund`);
      redis.clear();
      const tag = `${job.name}${what}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
      const odd = unreadable(refund(`${tag}Odd01`, 3_000, "pending", false));
      refunds = [odd, refund(`${tag}Later1`, 100, "succeeded", true)];
      await job.run();
      is("the anchor stays at or before the row it could not read", (await anchorOf(job.anchor)) <= NOW - 3_000, true);
    }
  }
  done();
}

void main();
