import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addOption, addProduct, claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { membershipCacheKey, numbersFrom, type Sub } from "@/lib/membership-numbers";
import { membersOn, readOptionMembers } from "@/lib/option-members";
import { POST } from "@/app/api/store/option/route";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.STRIPE_SECRET_KEY = "sk_test_review_t2690_only";

test("the real option-count route never turns malformed kept evidence into a displayed member count", async t => {
  let stripeCalls = 0;
  globalThis.fetch = (async input => {
    if (String(input).includes("stripe.com")) stripeCalls++;
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  redis.clear();
  const owner = "t2690-count@example.test";
  await claimHandle(owner, "t2690count", "Synthetic review store", "");
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Synthetic membership", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  assert.ok(made.ok);
  assert.equal((await addOption(owner, made.product.id, "Basic", "10")).ok, true);
  await setStripeAccount(owner, "acct_TestT2690", true);
  const store = (await storeForEmail(owner))!;
  const product = (await readProduct(store, made.product.id))!;
  const option = product.options[0].id;
  const sub: Sub = { id: "sub_reviewT2690", status: "active", product: product.id, option, amount: 1000, currency: "usd", interval: "month", count: 1, start: 1, ended: 0, trialEnd: 0, channel: "direct", canceledAt: 0, cancelCause: "", feedback: "", comment: "" };
  const counted = numbersFrom([sub], "usd", Date.now(), true);
  const session = await openSession(owner);
  const row = counted.byProduct[0];
  const cases: [string, unknown, number | null][] = [
    ["honest complete evidence", counted, 1],
    ["honest incomplete evidence", { ...counted, complete: false }, null],
    ["legacy evidence without the marker", { ...counted, optionsCounted: undefined }, null],
    ["text false is not complete evidence", { ...counted, complete: "false" }, null],
    ["numeric one is not complete evidence", { ...counted, complete: 1 }, null],
    ["a null count is unknown, not zero", { ...counted, byProduct: [{ ...row, byOption: { [option]: null } }] }, null],
    ["a numeric table is unknown, not zero", { ...counted, byProduct: [{ ...row, byOption: 7 }] }, null],
  ];
  for (const [name, evidence, expected] of cases) {
    await t.test(name, async () => {
      redis.run(["SET", membershipCacheKey(store.statsId!), JSON.stringify(evidence)]);
      const response = await POST(new NextRequest("https://marktmorgen.com/api/store/option", {
        method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ action: "count", id: product.id }),
      }));
      assert.equal(response.status, 200);
      const displayed = membersOn(readOptionMembers(await response.json()), option);
      assert.equal(displayed, expected, "the unchanged strict client must receive unknown for invalid cached evidence");
    });
  }
  assert.equal(stripeCalls, 0, "the real route never asks Stripe to repair unknown evidence");
});
