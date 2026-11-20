/**
 * #4749 (Codex L; ready fix Codex T-20261119-0650): keepCopy already kept a deleted person out of the ten-minute copy,
 * but memberHealth answered the fresh refresh with the unfiltered object, so the studio got the erased address back,
 * even when the erasure won the race to the copy's atomic commit. The fresh answer is now the certified copy itself.
 * Synthetic Stripe and Redis only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memberHealth } from "@/lib/member-health";
import { suppressCommand } from "@/lib/suppression";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
const ERASED = "erased@example.test";
const OTHER = "remaining@example.test";
let subs: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "api.stripe.com", "synthetic Stripe requests only");
  return new Response(JSON.stringify({ object: "list", data: url.pathname === "/v1/subscriptions" ? subs : [], has_more: false }));
}) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_health_response_only";

async function seed() {
  redis.clear();
  const owner = "owner@example.test";
  assert.equal((await claimHandle(owner, "synthetic", "Synthetic", "")).ok, true);
  await ensureStatsId(owner); await ensureListId(owner); await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  const made = await addProduct(owner, "Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  assert.equal(made.ok, true); if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const now = Math.floor(Date.now() / 1000);
  subs = [ERASED, OTHER].map((email, i) => ({
    id: `sub_Response0000${i}`, status: "active", currency: "usd", start_date: now - 90 * 86400,
    customer: { id: `cus_Response0000${i}`, email }, metadata: { store: store.handle, product: made.product.id },
    items: { data: [{ quantity: 1, current_period_end: now + 86400, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  }));
  return store;
}
const emails = (health: { members: { email: string }[] } | null) => (health ? health.members.map((m) => m.email).sort() : null);
const cachedEmails = (statsId: string) => {
  const raw = redis.run(["GET", `nl:health:${statsId}`]);
  return typeof raw === "string" ? (JSON.parse(raw) as { members: { email: string }[] }).members.map((m) => m.email).sort() : null;
};

test("an erasure finished before the refresh: the fresh answer and the copy name only the other member", async () => {
  const store = await seed();
  await redis.pipeline([suppressCommand(store.listId!, ERASED)]);
  assert.deepEqual(emails(await memberHealth(store, true)), [OTHER]);
  assert.deepEqual(cachedEmails(store.statsId!), [OTHER]);
});

test("an erasure that lands just before the atomic commit: the fresh answer, the copy and the next hit leave it out", async () => {
  const store = await seed();
  const real = redis.pipeline.bind(redis);
  let fired = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!fired && commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("marktmorgen:reading-copy:v1"))) {
      fired = true;
      await real([suppressCommand(store.listId!, ERASED)]);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let raced;
  try { raced = await memberHealth(store, true); } finally { redis.pipeline = real; }
  assert.equal(fired, true, "the race ran");
  assert.deepEqual(emails(raced), [OTHER]);
  assert.deepEqual(cachedEmails(store.statsId!), [OTHER]);
  assert.deepEqual(emails(await memberHealth(store)), [OTHER]);
});

test("control: with nobody erased, both members are answered and kept", async () => {
  const store = await seed();
  assert.deepEqual(emails(await memberHealth(store, true)), [ERASED, OTHER].sort());
  assert.deepEqual(cachedEmails(store.statsId!), [ERASED, OTHER].sort());
});
