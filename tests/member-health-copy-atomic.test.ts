/** Independent #4863 review: an erasure that completed before the cache write must never be undone, even briefly. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memberHealth, forgetHealthCopy } from "@/lib/member-health";
import { suppressCommand } from "@/lib/suppression";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
const EMAIL = "erased@example.test";
let subs: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "api.stripe.com", "synthetic Stripe requests only");
  return new Response(JSON.stringify({ object: "list", data: url.pathname === "/v1/subscriptions" ? subs : [], has_more: false }));
}) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_atomic_health_only";

async function seed() {
  redis.clear();
  const owner = "owner@example.test";
  assert.equal((await claimHandle(owner, "synthetic", "Synthetic", "")).ok, true);
  await ensureStatsId(owner); await ensureListId(owner); await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  const made = await addProduct(owner, "Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  assert.equal(made.ok, true); if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const now = Math.floor(Date.now() / 1000);
  subs = [EMAIL, "remaining@example.test"].map((email, i) => ({
    id: `sub_Atomic00000${i}`, status: "active", currency: "usd", start_date: now - 90 * 86400,
    customer: { id: `cus_Atomic00000${i}`, email }, metadata: { store: store.handle, product: made.product.id },
    items: { data: [{ quantity: 1, current_period_end: now + 86400, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  }));
  return store;
}

for (const mode of ["observable-window", "cleanup-zero", "cleanup-throws"] as const) {
  test(`completed erasure before cache commit: ${mode}`, async () => {
    const store = await seed(); const key = `nl:health:${store.statsId}`;
    const original = redis.pipeline.bind(redis);
    let raced = false; let committed = false; let observed: unknown = null;
    redis.pipeline = (async (commands: Command[]) => {
      const write = commands.some((c) => (c[0] === "SET" && c[1] === key) ||
        (c[0] === "EVAL" && String(c[1]).includes("marktmorgen:reading-copy:v1") && c[3] === key));
      if (write && !raced) {
        raced = true;
        // The erasure writes its print, confirms DEL, and finishes before the refresh's cache commit.
        await original([suppressCommand(store.listId!, EMAIL)]);
        redis.pipeline = original; await forgetHealthCopy(store); redis.pipeline = wrapped;
        assert.equal(redis.run(["GET", key]), null, "erasure completed with the copy absent");
      }
      if (committed && commands.some((c) => c[0] === "DEL" && c[1] === key) && mode !== "observable-window") {
        if (mode === "cleanup-throws") throw new Error("synthetic cleanup unavailable; nothing applied");
        return [0]; // A reply that confirms no key deleted; no deletion applied.
      }
      const answer = await original(commands);
      if (write) { committed = true; observed = redis.run(["GET", key]); }
      return answer;
    }) as typeof redis.pipeline;
    const wrapped = redis.pipeline;
    try { await memberHealth(store, true); } finally { redis.pipeline = original; }
    assert.equal(raced, true, "the erasure ran before the real commit");
    const raw = mode === "observable-window" ? observed : redis.run(["GET", key]);
    assert.equal(typeof raw === "string" && raw.includes(EMAIL), false,
      mode === "observable-window" ? "no concurrent GET may observe the erased address before cleanup" : "failed cleanup must not leave the erased row cached");
  });
}

test("control: the ordinary copy still contains the two active members", async () => {
  const store = await seed(); await memberHealth(store, true);
  const raw = redis.run(["GET", `nl:health:${store.statsId}`]);
  assert.equal(typeof raw, "string"); assert.equal(JSON.parse(String(raw)).members.length, 2);
});
