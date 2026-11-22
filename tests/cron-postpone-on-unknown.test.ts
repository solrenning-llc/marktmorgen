/**
 * CX-123 rule 24, the five-minute job's review requests (lib/review-requests.ts) and meeting retries
 * (lib/call-meetings.ts): a store read that threw is not known, so it is never "the store is gone". Only a
 * confirmed nil (no store at that address) takes the job off its queue; a read that failed leaves it queued, and a
 * later run does it. A failed read is not remembered for the run either, so it never drops that store's other jobs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sendReviewRequests } from "@/lib/review-requests";
import { syncMeetings } from "@/lib/call-meetings";
import { ASK_DUE_KEY, askMember, scheduleReviewAsk } from "@/lib/review-ask";
import { MEET_QUEUE, type MeetRecord, callScope, writeRecord } from "@/lib/meet-records";
import {
  type Store,
  addProduct,
  claimHandle,
  ensureListId,
  ensureStatsId,
  setMailSettings,
  setProductLink,
  setReviewAsk,
  setStripeAccount,
  setSubscription,
  storeForEmail,
  storeForHandle,
  storeHandleKey,
} from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const person = "postpone-person@example.test";
const references = ["cs_test_PostponeProof001", "cs_test_PostponeProof002"];
const unreadable = async (): Promise<Store | null> => {
  throw new Error("synthetic: the store read timed out");
};

async function reviewSetup(orders: number) {
  redis.clear();
  const owner = "postpone-owner@example.test";
  const batches: { to: string | string[] }[][] = [];
  let productId = "";
  const now = Math.floor(Date.now() / 1000);
  const paidAt = now - 8 * 86400;
  process.env.STRIPE_SECRET_KEY = "sk_test_postpone_only_a_stand_in";
  // Existing allowlisted synthetic provider credential; never a live account.
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body));
      batches.push(batch);
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const reference = references.find((ref) => url.pathname === `/v1/checkout/sessions/${ref}`);
    if (reference) {
      const n = reference.slice(-3);
      return Response.json({
        id: reference, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
        created: paidAt, amount_total: 2700, currency: "usd", customer_details: { email: person },
        metadata: { store: "postponeproof", product: productId },
        payment_intent: { id: `pi_PostponeProof${n}`, status: "succeeded", latest_charge: { id: `ch_PostponeProof${n}`, amount: 2700, amount_refunded: 0, disputed: false, refunded: false } },
      });
    }
    return Response.json({ object: "list", data: [], has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "postponeproof", "Postpone Proof", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_PostponeProof", subscriptionId: "sub_PostponeProof", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Postpone Proof", address: "1 Example St, Example City" });
  await setReviewAsk(owner, { days: 7 });
  const made = await addProduct(owner, "Postpone evidence", "", "27", null);
  assert.ok(made.ok);
  productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/review");
  const shop = (await storeForEmail(owner))!;
  const members: string[] = [];
  for (const reference of references.slice(0, orders)) {
    assert.equal(await scheduleReviewAsk(shop, reference, paidAt), true);
    members.push(askMember({ statsId: shop.statsId!, handle: shop.handle, reference, paidAt }));
  }
  const base = redis.pipeline.bind(redis);
  // MemoryRedis lacks ZADD XX. Match native Redis's existing-member update here, as tests/l9-review-request-exact.test.ts does.
  redis.pipeline = async (commands) => {
    if (!commands.some((c) => c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX")) return base(commands);
    const replies: unknown[] = [];
    for (const c of commands) {
      if (c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX" && c.length === 5) {
        if (redis.run(["ZSCORE", ASK_DUE_KEY, c[4]]) !== null) redis.run(["ZADD", ASK_DUE_KEY, c[3], c[4]]);
        replies.push(0);
      } else replies.push(...(await base([c])));
    }
    return replies;
  };
  return { now, members, batches, base };
}

const queued = (key: string, member: string) => redis.run(["ZSCORE", key, member]) !== null;

test("review requests: a store read that threw drops nothing, and a later run sends the email once", async () => {
  const oldFetch = globalThis.fetch;
  const r = await reviewSetup(1);
  try {
    const first = await sendReviewRequests(unreadable, Date.now() + 20000, r.now);
    assert.equal(first.dropped, 0, "an unreadable store is not a gone store");
    assert.equal(queued(ASK_DUE_KEY, r.members[0]), true, "the order is still on the list");
    assert.equal(r.batches.flat().length, 0, "nothing is sent without the store");
    assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now + 3601), { sent: 1, dropped: 0, waiting: 0 });
    assert.equal(r.batches.flat().length, 1);
  } finally {
    redis.pipeline = r.base;
    globalThis.fetch = oldFetch;
  }
});

test("review requests: one failed store read is not remembered as 'no store' for that store's other orders", async () => {
  const oldFetch = globalThis.fetch;
  const r = await reviewSetup(2);
  let calls = 0;
  const onceUnreadable = async (handle: string) => {
    calls += 1;
    if (calls === 1) throw new Error("synthetic: the store read timed out");
    return storeForHandle(handle);
  };
  try {
    const first = await sendReviewRequests(onceUnreadable, Date.now() + 20000, r.now);
    assert.equal(first.dropped, 0, "neither order is dropped");
    await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now + 3601);
    assert.equal(r.batches.flat().length, 2, "both orders are asked, each once");
  } finally {
    redis.pipeline = r.base;
    globalThis.fetch = oldFetch;
  }
});

/** Every GET of a store's address answers `reply()`; everything else goes on to what was there. */
function handleReadAnswers(reply: () => unknown[]): () => void {
  const before = redis.pipeline;
  redis.pipeline = async (commands) =>
    commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:store:handle:") ? reply() : before(commands);
  return () => {
    redis.pipeline = before;
  };
}

const HANDLE_MALFORMED: [string, () => unknown[]][] = [
  ["no reply at all", () => []],
  ["a number in its slot", () => [7]],
  ["an object in its slot", () => [{}]],
  ["two replies for one command", () => [null, null]],
];

for (const [label, reply] of HANDLE_MALFORMED) {
  test(`review requests: a store address read answering ${label} drops nothing (Claude 2 on #3211)`, async () => {
    const oldFetch = globalThis.fetch;
    const r = await reviewSetup(1);
    const restore = handleReadAnswers(reply);
    try {
      const first = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
      assert.equal(first.dropped, 0, "an odd answer is not a gone store");
      assert.equal(queued(ASK_DUE_KEY, r.members[0]), true, "the order is still on the list");
      assert.equal(r.batches.flat().length, 0, "nothing is sent without the store");
      restore();
      assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now + 3601), { sent: 1, dropped: 0, waiting: 0 });
      assert.equal(r.batches.flat().length, 1);
    } finally {
      restore();
      redis.pipeline = r.base;
      globalThis.fetch = oldFetch;
    }
  });
}

test("review requests: a store record that cannot be read, behind an address that still leads to it, drops nothing", async () => {
  const oldFetch = globalThis.fetch;
  const r = await reviewSetup(1);
  const owner = redis.run(["GET", storeHandleKey("postponeproof")]);
  assert.equal(typeof owner, "string");
  const before = redis.pipeline;
  // The address answers its owner; the owner's record answers something that is not a store.
  redis.pipeline = async (commands) =>
    commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:store:") && !String(commands[0][1]).startsWith("nl:store:handle:")
      ? ["{not a store"]
      : before(commands);
  try {
    const first = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
    assert.equal(first.dropped, 0, "an unreadable record is not a gone store");
    assert.equal(queued(ASK_DUE_KEY, r.members[0]), true);
  } finally {
    redis.pipeline = r.base;
    globalThis.fetch = oldFetch;
  }
});

test("review requests: a loader's null while the address still leads to a store is not 'gone'", async () => {
  const oldFetch = globalThis.fetch;
  const r = await reviewSetup(1);
  try {
    const counts = await sendReviewRequests(async () => null, Date.now() + 20000, r.now);
    assert.equal(counts.dropped, 0);
    assert.equal(queued(ASK_DUE_KEY, r.members[0]), true);
  } finally {
    redis.pipeline = r.base;
    globalThis.fetch = oldFetch;
  }
});

test("review requests (control): a released address is a gone store, and the order is dropped", async () => {
  const oldFetch = globalThis.fetch;
  const r = await reviewSetup(1);
  redis.run(["SET", storeHandleKey("postponeproof"), "released:synthetic"]);
  try {
    assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now), { sent: 0, dropped: 1, waiting: 0 });
    assert.equal(queued(ASK_DUE_KEY, r.members[0]), false);
  } finally {
    redis.pipeline = r.base;
    globalThis.fetch = oldFetch;
  }
});

test("review requests (control): a confirmed nil store drops the order", async () => {
  const oldFetch = globalThis.fetch;
  const r = await reviewSetup(1);
  // Nothing at the store's address at all: a confirmed nil.
  redis.run(["DEL", storeHandleKey("postponeproof")]);
  try {
    const counts = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
    assert.deepEqual(counts, { sent: 0, dropped: 1, waiting: 0 });
    assert.equal(queued(ASK_DUE_KEY, r.members[0]), false);
  } finally {
    redis.pipeline = r.base;
    globalThis.fetch = oldFetch;
  }
});

// ---- Meetings ------------------------------------------------------------------------

const callsId = "c".repeat(16);
const callStore = { statsId: "m".repeat(32), callsId, handle: "postponecalls", stripeAccountId: null, previousHandles: [] } as unknown as Store;

/** A refunded booking's meeting still to be taken down: its retry needs no provider (the record is gone), only the store. */
async function meetingDue(session: string, handle = callStore.handle, dueAgo = 1000): Promise<string> {
  const scope = callScope(callsId, { group: false, session, product: "p".repeat(12), start: Date.now() + 86_400_000 });
  const record: MeetRecord = {
    provider: "google", scope, statsId: callStore.statsId!, handle, callsId, product: "p".repeat(12), session,
    group: false, id: "", account: "", link: "", made: false, start: Date.now() + 86_400_000, end: Date.now() + 90_000_000, tz: "UTC",
    title: "Synthetic call", guests: [], added: [], todo: "create", tries: 1, next: Date.now() - dueAgo, error: "", updates: 0, gone: true,
    host: "", calendar: "",
  };
  await writeRecord(record);
  assert.equal(queued(MEET_QUEUE, scope), true);
  return scope;
}

/** MemoryRedis lacks ZADD XX: match native Redis's existing-member update for the meetings queue, as reviewSetup does. */
function meetQueueXX(): () => void {
  const before = redis.pipeline;
  redis.pipeline = async (commands) => {
    if (!commands.some((c) => c[0] === "ZADD" && c[1] === MEET_QUEUE && c[2] === "XX")) return before(commands);
    const replies: unknown[] = [];
    for (const c of commands) {
      if (c[0] === "ZADD" && c[1] === MEET_QUEUE && c[2] === "XX" && c.length === 5) {
        if (redis.run(["ZSCORE", MEET_QUEUE, c[4]]) !== null) redis.run(["ZADD", MEET_QUEUE, c[3], c[4]]);
        replies.push(0);
      } else replies.push(...(await before([c])));
    }
    return replies;
  };
  return () => {
    redis.pipeline = before;
  };
}

test("meetings: a store read that threw keeps the meeting's retry queued", async () => {
  redis.clear();
  const restore = meetQueueXX();
  const scope = await meetingDue("cs_test_PostponeMeet001");
  const run = await syncMeetings(unreadable, Date.now() + 10_000, "https://marktmorgen.com");
  restore();
  assert.equal(queued(MEET_QUEUE, scope), true, "an unreadable store is not a gone store");
  assert.equal(run.done, 0);
  // Moved back a few minutes (Claude 2 on #3211), not left at the head of the queue; once that time comes, a run does it.
  const at = Number(redis.run(["ZSCORE", MEET_QUEUE, scope]));
  assert.ok(at > Date.now() + 60_000 && at <= Date.now() + 5 * 60_000 + 1000, `postponed to ${at - Date.now()} ms from now`);
  redis.run(["ZADD", MEET_QUEUE, Date.now() - 1, scope]);
  const again = await syncMeetings(async () => callStore, Date.now() + 10_000, "https://marktmorgen.com");
  assert.equal(again.done, 1, "a later run does it");
  assert.equal(queued(MEET_QUEUE, scope), false);
});

test("meetings: one failed store read is not remembered as 'no store' for that store's other meetings", async () => {
  redis.clear();
  const first = await meetingDue("cs_test_PostponeMeet001");
  const second = await meetingDue("cs_test_PostponeMeet002");
  let calls = 0;
  const onceUnreadable = async () => {
    calls += 1;
    if (calls === 1) throw new Error("synthetic: the store read timed out");
    return callStore;
  };
  const run = await syncMeetings(onceUnreadable, Date.now() + 10_000, "https://marktmorgen.com");
  assert.equal(run.done, 1, "the other meeting is done in the same run");
  const left = [first, second].filter((scope) => queued(MEET_QUEUE, scope));
  assert.equal(left.length, 1, "the one whose store read failed stays queued");
});

test("meetings (control): a confirmed nil store drops the retry, a found one does it", async () => {
  redis.clear();
  const scope = await meetingDue("cs_test_PostponeMeet001");
  const run = await syncMeetings(async () => null, Date.now() + 10_000, "https://marktmorgen.com");
  assert.equal(run.done, 0);
  assert.equal(queued(MEET_QUEUE, scope), false);
  const found = await meetingDue("cs_test_PostponeMeet002");
  assert.equal((await syncMeetings(async () => callStore, Date.now() + 10_000, "https://marktmorgen.com")).done, 1);
  assert.equal(queued(MEET_QUEUE, found), false);
});

test("meetings: a loader's null while the store's address still leads to a store keeps the retry queued", async () => {
  redis.clear();
  redis.run(["SET", storeHandleKey(callStore.handle), "postpone-owner@example.test"]);
  const scope = await meetingDue("cs_test_PostponeMeet001");
  await syncMeetings(async () => null, Date.now() + 10_000, "https://marktmorgen.com");
  assert.equal(queued(MEET_QUEUE, scope), true, "not known to be gone");
  for (const [, reply] of HANDLE_MALFORMED) {
    redis.run(["DEL", storeHandleKey(callStore.handle)]);
    const restore = handleReadAnswers(reply);
    try {
      await syncMeetings(async () => null, Date.now() + 10_000, "https://marktmorgen.com");
    } finally {
      restore();
    }
    assert.equal(queued(MEET_QUEUE, scope), true, "an odd answer for the address is not a gone store");
  }
});

test("meetings: records whose store read keeps throwing move back in the queue and never starve a healthy one", async () => {
  redis.clear();
  const broken = { ...callStore, handle: "postponebroken" } as Store;
  const stuck: string[] = [];
  // Forty records due first, under a store whose read keeps throwing; one healthy record due after them.
  for (let i = 0; i < 40; i += 1) stuck.push(await meetingDue(`cs_test_PostponeStuck${String(i).padStart(3, "0")}`, broken.handle, 60_000));
  const healthy = await meetingDue("cs_test_PostponeHealthy001", callStore.handle, 1000);
  const load = async (handle: string) => {
    if (handle === broken.handle) throw new Error("synthetic: this store's read keeps failing");
    return callStore;
  };
  const scoreOf = (scope: string) => Number(redis.run(["ZSCORE", MEET_QUEUE, scope]));
  const before = scoreOf(stuck[0]);
  let done = 0;
  const restore = meetQueueXX();
  try {
    for (let run = 0; run < 3; run += 1) done += (await syncMeetings(load, Date.now() + 10_000, "https://marktmorgen.com")).done;
  } finally {
    restore();
  }
  assert.equal(queued(MEET_QUEUE, healthy), false, "the healthy record was reached and done");
  assert.ok(done >= 1);
  assert.ok(stuck.every((scope) => queued(MEET_QUEUE, scope)), "the stuck ones stay queued");
  assert.ok(scoreOf(stuck[0]) > Date.now(), `moved back in the queue: ${before} -> ${scoreOf(stuck[0])}`);
});
