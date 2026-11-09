/**
 * A pre-order paid for a product still coming soon is kept for its release, never handed over on a coming-soon
 * answer that does not read (CX-123 rule 24; Claude 4's Stripe hand-over audit, proof
 * proofs/c4-sweeps/stripehand/p4-preorder-early.proof.ts on claude4/sweep-proofs). soonOne reads SISMEMBER
 * exactly (Codex C2's knownSoonMember, #2846): 0 or 1, anything else throws, and confirmPreorder hands nothing over,
 * so the order stays unconfirmed and is tried again.
 *
 * Money: a paid pre-order. Real MemoryRedis; one reply replaced after it ran.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { confirmPreorder } from "@/lib/preorders";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";

const SID = "pre0stats0002";
const store = { statsId: SID, sid: "presid0002", handle: "harbor", stripeAccountId: "acct_1Proof00000002", pastBuyers: true, name: "Harbor", language: "en", email: "owner@example.com", previousHandles: [], releasedHandles: [] } as unknown as Store;
const product = { id: "prod00000003", title: "Unreleased Album", course: null } as unknown as Listing;
const deps = { base: "https://example.com/@harbor", from: "Harbor <x@example.com>", ordersLink: async () => null, recordStart: async () => {} };
const session = (id: string, email: string) => ({ id, status: "complete", payment_status: "paid", created: 1_700_000_000, customer_details: { email }, metadata: { preorder: "yes", store: "harbor", product: product.id } });

async function confirm(id: string, email: string, alter?: (reply: unknown) => unknown): Promise<{ outcome: string; handed: boolean }> {
  const real = redis.pipeline.bind(redis);
  if (alter) {
    redis.pipeline = (async (c: (string | number)[][]) => {
      const a = await real(c);
      return c[0]?.[0] === "SISMEMBER" ? [alter(a[0]), ...a.slice(1)] : a;
    }) as typeof redis.pipeline;
  }
  try {
    const outcome = await confirmPreorder(store, session(id, email) as Parameters<typeof confirmPreorder>[1], product, deps).catch((e: Error) => `threw ${e.name}`);
    return { outcome, handed: (await importedFor(store, email)).length > 0 };
  } finally {
    redis.pipeline = real;
  }
}

test("control: a product read exactly as coming soon keeps the pre-order for its release", async () => {
  redis.clear();
  redis.run(["SADD", `nl:wl:${SID}:soon`, product.id]);
  assert.equal((await confirm("cs_test_preearly0000000001", "ann@example.com")).handed, false);
});

for (const [label, alter] of [
  ["no result", () => undefined],
  ["true", () => true],
  ["text that is not 0 or 1", () => "yes"],
] as [string, (r: unknown) => unknown][]) {
  test(`a coming-soon answer of ${label} hands nothing over, and the order is tried again`, async () => {
    redis.clear();
    redis.run(["SADD", `nl:wl:${SID}:soon`, product.id]);
    const got = await confirm(`cs_test_preearly000000000${label.length % 10}`, "bob@example.com", alter);
    assert.equal(got.handed, false, `not handed over early (outcome ${got.outcome})`);
    assert.equal(got.outcome, "threw UnknownReplyError");
  });
}
