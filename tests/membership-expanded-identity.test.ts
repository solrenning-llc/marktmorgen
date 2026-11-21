/**
 * Regression for Codex G's expanded-subscription identity finding on #2517.
 * Calls the real membershipStatus object path with synthetic records only.
 * No provider request is permitted. Test prepared through GitHub; execution
 * is reported separately, never inferred from storing this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { membershipStatus } from "@/lib/membership-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";

test("expanded membership needs its own subscription identity before access", async () => {
  const store = { stripeAccountId: "acct_1TestClub000001" } as Store;
  const id = "sub_Member000001";
  const active = { status: "active", pause_collection: null };
  const inherited = Object.assign(Object.create({ id }), active);
  let idReads = 0;
  const accessor = Object.defineProperty({ ...active }, "id", {
    get() { idReads += 1; return id; },
  });
  const array = Object.assign([], { ...active, id });
  const malformed: [string, unknown][] = [
    ["missing identity", active],
    ["null identity", { ...active, id: null }],
    ["empty identity", { ...active, id: "" }],
    ["malformed identity", { ...active, id: "not-a-subscription" }],
    ["numeric identity", { ...active, id: 7 }],
    ["inherited identity", inherited],
    ["accessor identity", accessor],
    ["array with identity and status", array],
  ];
  const savedFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error("Expanded evidence must not perform a provider lookup");
  }) as typeof fetch;
  try {
    for (const [label, value] of malformed) {
      await assert.rejects(() => membershipStatus(store, value), UnknownReplyError, label);
    }
    assert.equal(idReads, 0, "identity getters are not evaluated");
    for (const status of ["active", "trialing", "canceled", "paused"]) {
      assert.equal(await membershipStatus(store, { id, status, pause_collection: null }), status);
    }
    // Keep a retry explicitly present: current main's stricter past-due
    // policy must survive the subsequent conflict reconciliation.
    assert.equal(await membershipStatus(store, {
      id, status: "past_due", pause_collection: null,
      latest_invoice: { next_payment_attempt: Math.floor(Date.now() / 1000) + 3600 },
    }), "past_due");
    assert.equal(providerCalls, 0, "no hidden HTTP request for expanded evidence");
  } finally {
    globalThis.fetch = savedFetch;
  }
});
