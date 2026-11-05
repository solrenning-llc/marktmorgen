import assert from "node:assert/strict";
import { test } from "node:test";
import { normaliseEmail } from "@/lib/auth";
import { storeForEmail, setStripeAccount } from "@/lib/store";
import { keptMembers } from "@/lib/store-readings";
import { erasePerson } from "@/lib/person-erasure";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { store as redis } from "./redis-stub";

test("a cleared membership reading cannot restore a deleted person's freeform text", async () => {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_readings_erasure_only";
  const world = await makeWorld("readings-erasure");
  const person = normaliseEmail("rhea.reader@example.com");
  await seedPerson(world, person, null);
  await setStripeAccount(OWNER, "acct_test_readings_feed", true);
  const store = (await storeForEmail(OWNER))!;
  const now = Date.now(), seconds = Math.floor(now / 1000);
  globalThis.fetch = (async input => new Response(JSON.stringify({ object: "list", has_more: false,
    data: String(input).includes("/subscriptions?") ? [{
      id: "sub_test_member_erasure", status: "canceled", currency: "usd", customer: "cus_test_member_erasure",
      metadata: { store: store.handle, product: "membership" }, start_date: seconds - 100_000,
      ended_at: seconds - 1000, canceled_at: seconds - 1000,
      cancellation_details: { reason: "cancellation_requested", feedback: "too_expensive", comment: `${person} wrote this synthetic private note` },
      items: { data: [{ quantity: 1, price: { unit_amount: 1000, recurring: { interval: "month", interval_count: 1 } } }] },
    }] : [],
  }), { status: 200 })) as typeof fetch;
  const key = `nl:reading:members:${store.statsId}`;
  const first = await keptMembers(store, now);
  assert.equal(JSON.stringify(first).includes(person), true, "control: real membership reader contains the supplied note");
  assert.equal(String(redis.run(["GET", key])).includes(person), true);
  await erasePerson(store, person, { kind: "person" });
  assert.equal(redis.run(["GET", key]), null, "the real eraser removes the new copy");
  const second = await keptMembers(store, now + 1);
  console.log("SYNTHETIC_MEMBER_READING", JSON.stringify({
    returnedPersonalText: JSON.stringify(second).includes(person),
    keptPersonalText: String(redis.run(["GET", key])).includes(person),
  }));
  assert.equal(String(redis.run(["GET", key])).includes(person), false, "the new retained copy must not recreate the removed personal note");
});
