/**
 * A refund Stripe has not finished keeps the anchor at its time (rule 30; review of #3188, Claude 5), in the three jobs
 * that take a paid thing back on a full refund: the call meetings (lib/call-meetings.ts), the license keys
 * (lib/licence-keys.ts) and the reviews (lib/review-proof.ts). Stripe lists refunds newest first and each run reads
 * from a little before its anchor. A refund still in requires_action (or pending on a charge not yet marked refunded)
 * does not give anything back yet, so the job passes it; a later full refund on the same page then moved the anchor past
 * it, and once it went through it was older than every later run's window: the paid call's meeting never ended, the
 * key was never revoked, the review never marked. As gifts and pre-orders do since #3188 (`waiting`), the anchor now
 * waits at the oldest such refund, and it is read again and handled once it goes through. Synthetic Stripe only.
 *
 * What fails here:
 *   - an anchor written past a refund in requires_action or pending that has not given everything back;
 *   - that refund not read again, once it succeeds, by the next run;
 *   - an anchor held by a refund that failed, or by one that already gave everything back (the hold must stay narrow).
 */
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import { revokeRefunded } from "@/lib/licence-keys";
import { markRefundedReviews } from "@/lib/review-proof";
import { KIND } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_refund_anchor_unfinished_only";
const ACCOUNT = "acct_1TestUnfinished01";
const NOW = Math.floor(Date.now() / 1000);
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

type Row = Record<string, unknown>;
let refunds: Row[] = [];
const lookedUp: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  if (url.pathname === "/v1/checkout/sessions") {
    lookedUp.push(String(url.searchParams.get("payment_intent")));
    return list([]);
  }
  if (url.pathname === "/v1/refunds") {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    return list(refunds.filter((r) => Number(r.created) >= gte).sort((a, b) => Number(b.created) - Number(a.created)));
  }
  if (url.pathname.startsWith("/v1/payment_intents/")) return new Response(JSON.stringify({ id: url.pathname.split("/").pop(), object: "payment_intent", metadata: {} }));
  if (url.pathname === "/v1/invoices") return list([]);
  return list([]);
}) as typeof fetch;

/** A refund on the creator's account, `ago` seconds old, on a charge of 1,000 cents. */
function refund(id: string, ago: number, status: string, refundedInFull: boolean): Row {
  return {
    id: `re_${id}`,
    object: "refund",
    status,
    created: NOW - ago,
    payment_intent: `pi_${id}`,
    charge: { id: `ch_${id}`, object: "charge", refunded: refundedInFull, amount: 1_000, amount_refunded: refundedInFull ? 1_000 : 0 },
  };
}

const anchorOf = async (key: string) => Number((await redis.pipeline([["GET", key]]))[0]);

/** Two runs of one job: the first with the unfinished refund, the next after it went through. */
async function scenario(
  name: string,
  run: () => Promise<unknown>,
  anchorKey: string,
  unfinished: { status: string; refundedInFull: boolean },
): Promise<void> {
  part(`${name}: a refund in ${unfinished.status}, then a later one`);
  // Ids of letters and digits only, as Stripe gives them (a payment id with "_" in its body is not one).
  const tag = `${name}${unfinished.status}`.replace(/[^A-Za-z0-9]/g, "");
  const held = refund(`${tag}Held01`, 3_000, unfinished.status, unfinished.refundedInFull);
  const later = refund(`${tag}Later1`, 100, "succeeded", true);
  refunds = [held, later];
  // Each scenario from a job with no place yet, so an earlier scenario's anchor does not hide this one's refunds.
  await redis.pipeline([["DEL", anchorKey]]);
  lookedUp.length = 0;
  await run();
  const anchor = await anchorOf(anchorKey);
  is("the anchor stays at or before the unfinished refund", anchor > 0 && anchor <= NOW - 3_000, true);
  // It goes through; five minutes later, the next run.
  held.status = "succeeded";
  held.charge = { ...(held.charge as Row), refunded: true, amount_refunded: 1_000 };
  shift += 5 * 60_000;
  lookedUp.length = 0;
  await run();
  is("the next run reads it again and looks its payment up", lookedUp.includes(String(held.payment_intent)), true);
}

async function main(): Promise<void> {
  redis.clear();

  const callsId = "u".repeat(16);
  const callStore = { statsId: "v".repeat(32), callsId, stripeAccountId: ACCOUNT, handle: "unfinished-calls", previousHandles: [] } as unknown as Store;
  const callRun = async () => {
    await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|unfinished-calls`]]);
    return syncMeetings(async (handle) => (handle === "unfinished-calls" ? callStore : null), Date.now() + 60_000, "https://marktmorgen.com");
  };
  const callAnchor = `nl:meet:rf:${callsId}:since`;

  const keysStore = { statsId: "w".repeat(32), stripeAccountId: ACCOUNT, handle: "unfinished-keys", previousHandles: [], catalog: { items: [{ id: "keyproduct", kind: KIND.paid | KIND.keys }] } } as unknown as Store;
  const keysRun = () => revokeRefunded(keysStore, Date.now() + 60_000);
  const keysAnchor = `nl:keys:${keysStore.statsId}:refunds:since`;

  const reviewStore = { statsId: "x".repeat(32), stripeAccountId: ACCOUNT, handle: "unfinished-reviews" } as unknown as Store;
  const reviewRun = () => markRefundedReviews(reviewStore, Date.now() + 60_000);
  const reviewAnchor = `nl:rev:refunds:since:${reviewStore.statsId}`;

  for (const unfinished of [
    { status: "requires_action", refundedInFull: false },
    { status: "pending", refundedInFull: false },
  ]) {
    await scenario("Call meetings", callRun, callAnchor, unfinished);
    await scenario("License keys", keysRun, keysAnchor, unfinished);
    // The review job looks nothing up (it marks by the payment): its proof is the anchor alone, and the refund read
    // again is shown by the anchor moving on once it went through.
    part(`Reviews: a refund in ${unfinished.status}, then a later one`);
    const held = refund(`Rev${unfinished.status.replace(/[^A-Za-z0-9]/g, "")}Held01`, 3_000, unfinished.status, false);
    refunds = [held, refund(`Rev${unfinished.status.replace(/[^A-Za-z0-9]/g, "")}Later1`, 100, "succeeded", true)];
    await redis.pipeline([["DEL", reviewAnchor]]);
    await reviewRun();
    const anchor = await anchorOf(reviewAnchor);
    is("the anchor stays at or before the unfinished refund", anchor > 0 && anchor <= NOW - 3_000, true);
    held.status = "succeeded";
    held.charge = { ...(held.charge as Row), refunded: true, amount_refunded: 1_000 };
    shift += 5 * 60_000;
    await reviewRun();
    is("once it went through, it is read and the anchor moves on past it", (await anchorOf(reviewAnchor)) >= NOW - 100, true);
    is("and it is taken as read", (await redis.pipeline([["SISMEMBER", `nl:rev:refunds:seen:${reviewStore.statsId}`, String(held.id)]]))[0], 1);
  }

  part("The hold stays narrow");
  for (const [name, run, key] of [
    ["Call meetings", callRun, callAnchor],
    ["License keys", keysRun, keysAnchor],
    ["Reviews", reviewRun, reviewAnchor],
  ] as const) {
    refunds = [refund(`Narrow${name.replace(/\W/g, "")}Failed`, 3_000, "failed", false), refund(`Narrow${name.replace(/\W/g, "")}PendFull`, 2_000, "pending", true), refund(`Narrow${name.replace(/\W/g, "")}Later`, 100, "succeeded", true)];
    shift += 5 * 60_000;
    await run();
    is(`${name}: a failed refund and a pending one that gave everything back hold nothing (unchanged)`, (await anchorOf(key)) >= NOW - 100, true);
  }

  done();
}

void main();
