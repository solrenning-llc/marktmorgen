/**
 * Claude 5 iacVn3r's LOW on #4514 @5d19d66824 (7029120876, still open under rule ZA): a lost plan dispute whose clawback
 * never succeeds (its credit's send is never found in the balance history, or its invoice never reads) stays open for
 * good and took one of the run's CLAWBACKS_PER_RUN places every day, so ten of them starved every later lost dispute,
 * whose unused invite credit was then never taken back. The reviewer's second suggestion, which keeps the owner's rule
 * of 19 November 2026 (7026959234: a lost dispute never earns): a lost dispute whose clawback already failed is
 * remembered as `lost:<store id>`, and those retries take at most CLAWBACK_RETRIES_PER_RUN of the run's places, so a
 * lost dispute met for the first time always finds one. The run's total stays CLAWBACKS_PER_RUN, so its cost does not
 * move. Synthetic: Stripe's stand-in, the in-memory Redis.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimHandle, setSubscription } from "@/lib/store";
import { creditKey } from "@/lib/creator-invites";
import { CLAWBACKS_PER_RUN } from "@/lib/creator-invite-clawback";
import { SEEN_KEY, syncPlanDisputes } from "@/lib/plan-disputes";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER_CUSTOMER = "cus_RetrySlotOwner1";
const SUBSCRIPTION = "sub_RetrySlotInvit1";
const NOW = 1_800_000_000;
const STUCK = 12;
const pad = (n: number) => String(n).padStart(4, "0");
const stuckInvoice = (n: number) => `in_RetrySlotStuck${pad(n)}`;
const stuckDispute = (n: number) => `du_RetrySlotStuck${pad(n)}`;
const FRESH_INVOICE = "in_RetrySlotFresh001";
const FRESH_DISPUTE = "du_RetrySlotFresh001";

test("lost disputes whose clawback keeps failing never take every place from a new lost dispute", async () => {
  redis.clear();
  const owner = await claimHandle("retry-owner@example.test", "retryowner", "Owner", "");
  const invited = await claimHandle("retry-invited@example.test", "retryinvited", "Invited", "");
  assert.ok(owner.ok && invited.ok);
  if (!owner.ok || !invited.ok) throw new Error("fixture stores missing");
  await setSubscription("retry-owner@example.test", { customerId: OWNER_CUSTOMER, subscriptionId: "sub_RetrySlotOwner1", active: true, period: paidPeriod() });
  await setSubscription("retry-invited@example.test", { customerId: "cus_RetrySlotInvit1", subscriptionId: SUBSCRIPTION, active: true, period: paidPeriod() });
  const credit = (invoice: string, txn: string) => JSON.stringify({ id: invoice, kind: "share", to: owner.store.sid,
    from: invited.store.sid, cents: 1000, cur: "usd", at: NOW - 30 * 86400, state: "done", txn, doneAt: NOW - 20 * 86400 });
  // The stuck ones' sends are never in the balance history read, so their clawback throws every run.
  for (let n = 0; n < STUCK; n += 1) redis.run(["SET", creditKey(stuckInvoice(n)), credit(stuckInvoice(n), `cbtxn_RetrySlotMissing${pad(n)}`)]);
  redis.run(["SET", creditKey(FRESH_INVOICE), credit(FRESH_INVOICE, "cbtxn_RetrySlotFresh1")]);

  let fresh = false;
  let balance = -13_000;
  let writes = 0;
  const dispute = (id: string, invoice: string, created: number) => ({ id, object: "dispute", status: "lost", amount: 2000, currency: "usd",
    created, charge: { id: `ch_${id.slice(3)}`, invoice: { id: invoice, subscription: SUBSCRIPTION, lines: { data: [] } } } });
  const listed = () => [
    // The stuck ones are the newest, so the list reaches them first.
    ...Array.from({ length: STUCK }, (_, n) => dispute(stuckDispute(n), stuckInvoice(n), NOW - 10 * 86400 + STUCK - n)),
    // The new lost dispute is older: created before them, lost only now.
    ...(fresh ? [dispute(FRESH_DISPUTE, FRESH_INVOICE, NOW - 40 * 86400)] : []),
  ];
  const oldFetch = globalThis.fetch;
  const oldError = console.error;
  const oldKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_retry_slots_fixture_only";
  console.error = () => {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
    const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (init?.method === "GET" && path === "/disputes") return answer({ object: "list", data: listed(), has_more: false });
    if (init?.method === "GET" && path === `/subscriptions/${SUBSCRIPTION}`) {
      return answer({ id: SUBSCRIPTION, object: "subscription", customer: "cus_RetrySlotInvit1", metadata: { store: "retryinvited" } });
    }
    if (init?.method === "GET" && path === `/customers/${OWNER_CUSTOMER}`) return answer({ id: OWNER_CUSTOMER, object: "customer", balance, currency: "usd" });
    if (init?.method === "GET" && path === `/customers/${OWNER_CUSTOMER}/balance_transactions`) return answer({ object: "list", data: [
      { id: "cbtxn_RetrySlotFresh1", object: "customer_balance_transaction", amount: -1000, currency: "usd", metadata: { nimbus_invite_credit: FRESH_INVOICE } },
    ], has_more: false });
    if (init?.method === "POST" && path === `/customers/${OWNER_CUSTOMER}/balance_transactions`) {
      const amount = Number(new URLSearchParams(String(init.body)).get("amount"));
      writes += 1;
      balance += amount;
      return answer({ id: `cbtxn_RetrySlotClaw${writes}`, object: "customer_balance_transaction", amount, currency: "usd" });
    }
    throw new Error(`unmocked request: ${init?.method} ${path}`);
  }) as typeof fetch;
  try {
    assert.ok(STUCK > CLAWBACKS_PER_RUN, "(setup) more stuck disputes than a run's places");
    // Day 1: only the stuck ones, all lost; none is taken back, and all stay to be tried again.
    await syncPlanDisputes(Date.now() + 60_000, NOW);
    assert.equal(writes, 0, "day 1: no clawback goes through");
    const marks = Array.from({ length: STUCK }, (_, n) => String(redis.run(["HGET", SEEN_KEY, stuckDispute(n)])));
    assert.ok(marks.every((mark) => mark !== "final"), "day 1: no stuck dispute is taken as final");
    // Day 2: a new lost dispute, older than all of them, is listed after them.
    fresh = true;
    await syncPlanDisputes(Date.now() + 60_000, NOW + 86400);
    const raw = redis.run(["GET", creditKey(FRESH_INVOICE)]);
    const saved = typeof raw === "string" ? JSON.parse(raw) as { clawed?: number } : {};
    assert.deepEqual({ clawed: saved.clawed, mark: redis.run(["HGET", SEEN_KEY, FRESH_DISPUTE]), writes, balance },
      { clawed: 1000, mark: "final", writes: 1, balance: -12_000 }, "day 2: the new lost dispute's credit is taken back");
    assert.ok(Array.from({ length: STUCK }, (_, n) => String(redis.run(["HGET", SEEN_KEY, stuckDispute(n)]))).every((mark) => mark !== "final"),
      "day 2: the stuck ones are still kept to try again, never dropped");
  } finally {
    console.error = oldError;
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = oldKey;
  }
});
