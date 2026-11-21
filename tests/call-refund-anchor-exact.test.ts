/**
 * Rule 24 in the refund walk that ends refunded calls' meetings (lib/call-meetings.ts, refundsOf via syncMeetings):
 *
 *   - the walk's place (the anchor, GET) read in another shape stops the store's walk with the place as it was, never
 *     "first run" (a one-day window) written over the real, older place, which skipped the refunds in between;
 *   - the checkout a refunded payment belongs to, listed by Stripe in another shape, leaves the refund unread (not
 *     added to the seen set), never read as "no call", so the next run ends the refunded call's meeting;
 *   - a refunds page whose `has_more` is not exactly true or false ("true", 1, null, missing) holds the place, never
 *     read as the last page (Claude 2 nuvem I and Codex X5 on #3866 @fb72a68a6e);
 *   - a store with no place yet has its first anchor's `SET … NX` answer read exactly before Stripe is asked anything:
 *     "OK" goes on, null reads the anchor another run wrote first and walks from it, and any other answer (none, 7, "?")
 *     stops the store's walk before Stripe (Codex X4 on #3462, 6907710904; Claude 6, 6907877778).
 *
 * Synthetic only: a minimal stand-in for the creator's Stripe account.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_call_refund_anchor_only";
const NOW = Math.floor(Date.now() / 1000);
const CALLS = "e".repeat(16);
const anchorKey = `nl:meet:rf:${CALLS}:since`;
const seenKey = `nl:meet:rf:${CALLS}:seen`;
// A refund with no payment has payment_intent null, as Stripe gives it (an empty id is a row in another shape for
// lib/refunds.ts refundRowKnown, which holds the place: a fixture with one would keep the place for that reason alone).
let refunds: Record<string, unknown>[] = [];
let sessionsData: unknown = [];
/** The refunds' second page, when set: the first page then says it has more. */
let secondPage: unknown = undefined;
/** The first refunds page's `has_more`, when set: given as is (a missing field is "absent"), in place of the computed one. */
let firstHasMore: unknown = undefined;
/** Every `created[gte]` the walk asked Stripe's refunds list for, in order. */
const refundAsks: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/refunds") {
    refundAsks.push(url.searchParams.get("created[gte]") ?? "");
    if (url.searchParams.get("starting_after")) return answer({ object: "list", data: secondPage, has_more: false });
    if (firstHasMore === "absent") return answer({ object: "list", data: refunds });
    return answer({ object: "list", data: refunds, has_more: firstHasMore !== undefined ? firstHasMore : secondPage !== undefined });
  }
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessionsData, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const store = { handle: "callshop", statsId: "0123456789abcdef0123456789abcd06", callsId: CALLS, stripeAccountId: "acct_1CallRefund01", previousHandles: [], releasedHandles: [] } as unknown as Store;
const find = async (handle: string) => (handle === "callshop" ? store : null);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

async function seed(): Promise<void> {
  redis.clear();
  await pipeline([["ZADD", MEET_STORES, String(Date.now() + 86_400_000), `${CALLS}|callshop`]]);
}

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["text that is not a time", ["soon"]]] as [string, unknown[]][]) {
  test(`the walk's place read as ${label}: the older place is kept`, async () => {
    await seed();
    refunds = [];
    const older = String(NOW - 20 * 86_400);
    await pipeline([["SET", anchorKey, older, "EX", 86_400 * 60]]);
    // The place's GET answered as `reply`, alone or first in the batch that reads it (a walk that reads its pass with it):
    // no reply at all answers nothing for the batch.
    redis.pipeline = (async (b: Batch) =>
      b[0]?.[0] === "GET" && b[0][1] === anchorKey ? (reply.length ? [...reply, ...(b.length > 1 ? await pipeline(b.slice(1)) : [])] : reply) : pipeline(b)) as typeof redis.pipeline;
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      redis.pipeline = pipeline;
    }
    assert.deepEqual(await pipeline([["GET", anchorKey]]), [older]);
  });
}

for (const [label, data] of [["a number", 7], ["an object", {}], ["text", "x"]] as [string, unknown][]) {
  test(`the refunded payment's checkouts listed as ${label}: the refund is not taken as read`, async () => {
    await seed();
    refunds = [{ id: "re_CallRefund0001", object: "refund", created: NOW - 60, status: "succeeded", payment_intent: "pi_CallRefund0001", charge: { object: "charge", amount: 5000, amount_refunded: 5000, refunded: true } }];
    sessionsData = data;
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      sessionsData = [];
    }
    assert.deepEqual(await pipeline([["SISMEMBER", seenKey, "re_CallRefund0001"]]), [0]);
  });
}

const refunded = (n: string) => ({ id: `re_CallRefund${n}`, object: "refund", created: NOW - 60, status: "succeeded", payment_intent: `pi_CallRefund${n}`, charge: { object: "charge", amount: 5000, amount_refunded: 5000, refunded: true } });

for (const [label, data] of [["a list holding a number", [7]], ["a list holding null", [null]], ["a list holding a checkout with no id", [{ metadata: { kind: "call" } }]]] as [string, unknown][]) {
  test(`the refunded payment's checkouts listed as ${label}: the refund is not taken as read`, async () => {
    await seed();
    refunds = [refunded("0001")];
    sessionsData = data;
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      sessionsData = [];
    }
    assert.deepEqual(await pipeline([["SISMEMBER", seenKey, "re_CallRefund0001"]]), [0]);
  });
}

test("an empty list of checkouts is no call: the refund is read", async () => {
  await seed();
  refunds = [refunded("0001")];
  sessionsData = [];
  await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
  assert.deepEqual(await pipeline([["SISMEMBER", seenKey, "re_CallRefund0001"]]), [1]);
});

for (const [label, page] of [["a number", 7], ["an object", {}], ["a list holding a number", [7]], ["a list holding null", [null]]] as [string, unknown][]) {
  test(`a second refunds page read as ${label}: the older place is kept`, async () => {
    await seed();
    const older = String(NOW - 20 * 86_400);
    await pipeline([["SET", anchorKey, older, "EX", 86_400 * 60]]);
    refunds = [{ id: "re_CallRefund0002", object: "refund", created: NOW - 60, status: "succeeded", payment_intent: null, charge: { object: "charge", amount: 5000, amount_refunded: 5000, refunded: true } }];
    secondPage = page;
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      secondPage = undefined;
    }
    assert.deepEqual(await pipeline([["GET", anchorKey]]), [older]);
  });
}

for (const [label, rows] of [["a number", [7]], ["null", [null]], ["a refund with no id", [{ object: "refund", created: NOW - 60 }]]] as [string, unknown[]][]) {
  test(`a refunds page holding ${label}: the older place is kept`, async () => {
    await seed();
    const older = String(NOW - 20 * 86_400);
    await pipeline([["SET", anchorKey, older, "EX", 86_400 * 60]]);
    // Beside a healthy, newer refund the walk reads: the place must not move past the row it could not read.
    refunds = [...rows, { id: "re_CallRefund0004", object: "refund", created: NOW - 60, status: "succeeded", payment_intent: null, charge: { object: "charge", amount: 5000, amount_refunded: 5000, refunded: true } }] as Record<string, unknown>[];
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      refunds = [];
    }
    assert.deepEqual(await pipeline([["GET", anchorKey]]), [older]);
  });
}

test("a healthy page read to its end moves the place", async () => {
  await seed();
  const older = String(NOW - 20 * 86_400);
  await pipeline([["SET", anchorKey, older, "EX", 86_400 * 60]]);
  refunds = [{ id: "re_CallRefund0003", object: "refund", created: NOW - 60, status: "succeeded", payment_intent: null, charge: { object: "charge", amount: 5000, amount_refunded: 5000, refunded: true } }];
  await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
  const [place] = await pipeline([["GET", anchorKey]]);
  assert.notEqual(place, older);
});

for (const [label, more] of [["the text \"true\"", "true"], ["the number 1", 1], ["null", null], ["missing", "absent"]] as [string, unknown][]) {
  test(`a refunds page whose has_more is ${label}: the older place is kept and nothing past it is taken as read`, async () => {
    await seed();
    const older = String(NOW - 20 * 86_400);
    await pipeline([["SET", anchorKey, older, "EX", 86_400 * 60]]);
    // Page one gives nothing back; page two holds a full refund that would be left behind for good.
    refunds = [{ id: "re_CallRefund0005", object: "refund", created: NOW - 60, status: "succeeded", payment_intent: null, charge: { object: "charge", amount: 5000, amount_refunded: 0, refunded: false } }];
    secondPage = [refunded("0006")];
    firstHasMore = more;
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      secondPage = undefined;
      firstHasMore = undefined;
    }
    assert.deepEqual(await pipeline([["GET", anchorKey]]), [older]);
  });
}

test("control: a refunds page whose has_more is exactly true reads the next page before the place moves", async () => {
  await seed();
  const older = String(NOW - 20 * 86_400);
  await pipeline([["SET", anchorKey, older, "EX", 86_400 * 60]]);
  refunds = [{ id: "re_CallRefund0007", object: "refund", created: NOW - 60, status: "succeeded", payment_intent: null, charge: { object: "charge", amount: 5000, amount_refunded: 0, refunded: false } }];
  secondPage = [{ id: "re_CallRefund0008", object: "refund", created: NOW - 50, status: "succeeded", payment_intent: null, charge: { object: "charge", amount: 5000, amount_refunded: 0, refunded: false } }];
  firstHasMore = true;
  try {
    await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
  } finally {
    secondPage = undefined;
    firstHasMore = undefined;
  }
  // Page two said it was the last (has_more false): the walk read both pages, so the place moves.
  const [place] = await pipeline([["GET", anchorKey]]);
  assert.notEqual(place, older);
});

/** The first anchor's own `SET … NX` (one command alone in its batch), answered by `answer` instead of Redis. */
const firstAnchorAnswered = (answer: (b: Batch) => Promise<unknown[]>) =>
  (async (b: Batch) => (b.length === 1 && b[0][0] === "SET" && b[0][1] === anchorKey && b[0].includes("NX") ? answer(b) : pipeline(b))) as typeof redis.pipeline;

for (const [label, reply] of [["no reply", []], ["the number 7", [7]], ["the text \"?\"", ["?"]]] as [string, unknown[]][]) {
  test(`the first anchor's SET NX answered with ${label}: Stripe is not asked and the refund is not taken as read`, async () => {
    await seed();
    refunds = [refunded("0009")];
    refundAsks.length = 0;
    redis.pipeline = firstAnchorAnswered(async () => reply);
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      redis.pipeline = pipeline;
    }
    assert.deepEqual(refundAsks, []);
    assert.deepEqual(await pipeline([["SISMEMBER", seenKey, "re_CallRefund0009"]]), [0]);
  });
}

test("control: the first anchor's SET NX answered OK: Stripe is asked from a day back", async () => {
  await seed();
  refunds = [];
  refundAsks.length = 0;
  await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
  assert.equal(refundAsks.length > 0, true);
  assert.equal(Math.abs(Number(refundAsks[0]) - (NOW - 86_400 - 300)) <= 5, true);
});

test("the first anchor's SET NX answered null: the anchor another run wrote first is read again and walked from", async () => {
  await seed();
  refunds = [];
  refundAsks.length = 0;
  const winner = NOW - 20 * 86_400;
  // Another run wrote its anchor between this run's read of the place and its SET NX.
  redis.pipeline = firstAnchorAnswered(async (b) => {
    await pipeline([["SET", anchorKey, String(winner), "EX", 86_400 * 60]]);
    return pipeline(b);
  });
  try {
    await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
  } finally {
    redis.pipeline = pipeline;
  }
  assert.deepEqual(refundAsks.slice(0, 1), [String(winner - 300)]);
});

for (const [label, again] of [["nothing", [null]], ["the number 7", [7]], ["no reply", []]] as [string, unknown[]][]) {
  test(`the first anchor's SET NX answered null and the anchor read again as ${label}: Stripe is not asked`, async () => {
    await seed();
    refunds = [refunded("0010")];
    refundAsks.length = 0;
    let lost = false;
    redis.pipeline = (async (b: Batch) => {
      if (b.length === 1 && b[0][0] === "SET" && b[0][1] === anchorKey && b[0].includes("NX")) {
        lost = true;
        return [null];
      }
      if (lost && b.length === 1 && b[0][0] === "GET" && b[0][1] === anchorKey) return again;
      return pipeline(b);
    }) as typeof redis.pipeline;
    try {
      await syncMeetings(find, Date.now() + 10_000, "https://marktmorgen.com").catch(() => null);
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(lost, true);
    assert.deepEqual(refundAsks, []);
    assert.deepEqual(await pipeline([["SISMEMBER", seenKey, "re_CallRefund0010"]]), [0]);
  });
}
