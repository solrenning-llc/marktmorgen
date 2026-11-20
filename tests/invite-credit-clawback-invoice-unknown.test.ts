import assert from "node:assert/strict";
import { test } from "node:test";
import { claimHandle, setSubscription } from "@/lib/store";
import { creditKey } from "@/lib/creator-invites";
import { SEEN_KEY, syncPlanDisputes } from "@/lib/plan-disputes";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const INVOICE = "in_UnknownClaw01";
const CUSTOMER = "cus_UnknownClaw01";
const SUBSCRIPTION = "sub_UnknownClaw01";
const DISPUTE = "du_UnknownClaw01";
const NOW = 1_800_000_000;
const completeInvoice = { id: INVOICE, subscription: SUBSCRIPTION, lines: { data: [] } };
const shapes: [string, unknown][] = [
  ["missing", undefined], ["null", null],
  ["missing id", { subscription: SUBSCRIPTION }], ["empty id", { id: "", subscription: SUBSCRIPTION }],
  ["invalid id", { id: "in_bad", subscription: SUBSCRIPTION }],
];

for (const source of ["listed", "reread"] as const) for (const [label, unknownInvoice] of shapes) {
  test(`a ${source} lost dispute with ${label} invoice stays retriable until its credit is handled`, async () => {
    redis.clear();
    const owner = await claimHandle("claw-owner@example.test", "clawowner", "Owner", "");
    const invited = await claimHandle("claw-invited@example.test", "clawinvited", "Invited", "");
    assert.ok(owner.ok && invited.ok);
    if (!owner.ok || !invited.ok) throw new Error("fixture stores missing");
    await setSubscription("claw-owner@example.test", { customerId: CUSTOMER, subscriptionId: "sub_UnknownOwner01", active: true, period: paidPeriod() });
    await setSubscription("claw-invited@example.test", { customerId: "cus_UnknownInvited01", subscriptionId: SUBSCRIPTION, active: true, period: paidPeriod() });
    redis.run(["SET", creditKey(INVOICE), JSON.stringify({ id: INVOICE, kind: "share", to: owner.store.sid,
      from: invited.store.sid, cents: 1000, cur: "usd", at: NOW - 200 * 86400, state: "done", txn: "cbtxn_credit", doneAt: NOW - 86400 })]);
    // An earlier daily pass already associated this dispute with the invited store.
    redis.run(["HSET", SEEN_KEY, DISPUTE, `open:${invited.store.sid}`]);
    let invoice: unknown = unknownInvoice;
    let listed = source === "listed";
    let balance = -1000;
    let writes = 0;
    let rereads = 0;
    const dispute = () => ({ id: DISPUTE, object: "dispute", status: "lost", amount: 2000, currency: "usd",
      created: NOW - 121 * 86400, charge: { id: "ch_UnknownClaw01", invoice } });
    const oldFetch = globalThis.fetch;
    const oldError = console.error;
    const oldKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_unknown_clawback_invoice_fixture_only";
    console.error = () => {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (init?.method === "GET" && path === "/disputes") return answer({ object: "list", data: listed ? [dispute()] : [], has_more: false });
      if (init?.method === "GET" && path === `/disputes/${DISPUTE}`) { rereads++; return answer(dispute()); }
      if (init?.method === "GET" && path === `/customers/${CUSTOMER}`) return answer({ id: CUSTOMER, object: "customer", balance, currency: "usd" });
      if (init?.method === "GET" && path === `/customers/${CUSTOMER}/balance_transactions`) return answer({ object: "list", data: [], has_more: false });
      if (init?.method === "POST" && path === `/customers/${CUSTOMER}/balance_transactions`) {
        const amount = Number(new URLSearchParams(String(init.body)).get("amount"));
        writes++;
        balance += amount;
        return answer({ id: "cbtxn_unknownClawFixture", object: "customer_balance_transaction", amount, currency: "usd" });
      }
      throw new Error(`unmocked request: ${init?.method} ${path}`);
    }) as typeof fetch;
    try {
      const failed = await syncPlanDisputes(Date.now() + 60_000, NOW);
      const before = { failed: failed.failed, seen: redis.run(["HGET", SEEN_KEY, DISPUTE]), writes, balance };
      // On the next day the dispute is older than the listing window. Only its open marker reaches it.
      invoice = completeInvoice;
      listed = false;
      const recovered = await syncPlanDisputes(Date.now() + 60_000, NOW + 86400);
      const raw = redis.run(["GET", creditKey(INVOICE)]);
      const saved = typeof raw === "string" ? JSON.parse(raw) as { clawed?: number } : {};
      assert.deepEqual({ before, after: { failed: recovered.failed, seen: redis.run(["HGET", SEEN_KEY, DISPUTE]),
        writes, balance, clawed: saved.clawed, rereads } }, {
        before: { failed: 1, seen: `open:${invited.store.sid}`, writes: 0, balance: -1000 },
        after: { failed: 0, seen: "final", writes: 1, balance: 0, clawed: 1000, rereads: source === "reread" ? 2 : 1 },
      });
    } finally {
      console.error = oldError;
      globalThis.fetch = oldFetch;
      if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = oldKey;
    }
  });
}
