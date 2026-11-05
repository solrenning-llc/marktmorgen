import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyCourse, readCourseWithin, READ_COURSE_WITHIN } from "@/lib/course";
import { store as redis } from "./redis-stub";
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { addDraftProducts, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_LINK_LENGTH } from "@/lib/product-link";
import { paidPeriod } from "./billing-period-fixture";

test("bounded course reads distinguish confirmed absence from incomplete replies", async t => {
  redis.clear();
  const id = "c".repeat(32), key = `nl:course:${id}`;
  await redis.pipeline([["SET", key, JSON.stringify(emptyCourse(id))]]);
  assert.equal((await readCourseWithin(id))?.id, id);
  const original = redis.pipeline;
  for (const { label, reply } of [
    { label: "truncated tuple", reply: [[1]] },
    { label: "missing value", reply: [[1, undefined]] },
    { label: "false instead of a GET value", reply: [[1, false]] },
  ]) {
    await t.test(label, async () => {
      let intercepted = false;
      redis.pipeline = async commands => {
        if (commands.some(c => c[0] === "EVAL" && c[1] === READ_COURSE_WITHIN)) {
          intercepted = true;
          return reply;
        }
        return original.call(redis, commands);
      };
      try {
        await assert.rejects(readCourseWithin(id), "unknown reply cannot confirm that the stored course is absent");
        assert.equal(intercepted, true);
      } finally { redis.pipeline = original; }
    });
  }
  redis.pipeline = async () => [[1, null]];
  try { assert.equal(await readCourseWithin(id), null, "an exact confirmed Redis miss remains absent"); }
  finally { redis.pipeline = original; }
});

test("the actual bundle page fits the registry's paid 20000-byte API envelope before its reads", async () => {
  redis.clear();
  const email = "review-a3-meter@example.test";
  await claimHandle(email, "review-a3-meter", "Synthetic meter review", "");
  await ensureStatsId(email);
  await setSubscription(email, { customerId: "cus_A3MeterReview", subscriptionId: "sub_A3MeterReview",
    active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const link = "https://example.test/".padEnd(MAX_LINK_LENGTH, "x");
  assert.equal(new URL(link).protocol, "https:");
  const made = await addDraftProducts(email, Array.from({ length: 150 }, (_, i) => ({
    title: `Guide ${i} ${"€".repeat(70)}`, summary: "€".repeat(300), priceCents: 1900, link,
  })));
  assert.ok(made.ok);
  const store = (await storeForEmail(email))!;
  const key = await makeKey(store.sid, "Synthetic review");
  assert.ok(key.ok);
  const original = redis.pipeline, originalFetch = globalThis.fetch;
  let firstRead = -1, step = 0, bytes = 0, listings = 0, cards = 0;
  const debits: { at: number; units: number }[] = [];
  redis.pipeline = async commands => {
    const answers = await original.call(redis, commands);
    commands.forEach((c, i) => {
      step++;
      if ((c[0] === "INCRBY" || c[0] === "DECRBY") && String(c[1]).includes(":api:")) {
        debits.push({ at: step, units: Number(c[2]) * (c[0] === "DECRBY" ? -1 : 1) });
      }
      if (c[0] === "HMGET" && /^nl:catalog:.*:t$/.test(String(c[1]))) {
        if (firstRead < 0) firstRead = step;
        const values = answers[i];
        assert.ok(Array.isArray(values));
        cards += values.length;
        bytes += values.reduce((n: number, value: unknown) => n + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0);
      }
      if (c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1]))) {
        if (firstRead < 0) firstRead = step;
        listings++;
        bytes += Buffer.byteLength(String(answers[i]));
      }
    });
    return answers;
  };
  globalThis.fetch = async () => { throw Error("No external requests in review"); };
  try {
    const response = await POST(new Request("https://example.test/api/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_bundle_choices", arguments: { cursor: "20", search: "Guide" } } }),
    }));
    const body = await response.json();
    assert.equal(body.result?.isError, false);
    assert.equal(JSON.parse(body.result.content[0].text).products.length, 19);
    assert.equal(listings, 19);
    assert.equal(cards, 100);
    const prepaid = debits.filter(d => d.at < firstRead && d.units > 0).reduce((n, d) => n + d.units, 0);
    console.log(JSON.stringify({ bytes, listings, cards, prepaid, debits, registryBytesPerRequest: 20_000 }));
    assert.ok(prepaid > 0);
    assert.ok(bytes <= prepaid * 20_000, "even raw card and listing bytes must fit the requests paid before the first data read");
  } finally { redis.pipeline = original; globalThis.fetch = originalFetch; }
});
