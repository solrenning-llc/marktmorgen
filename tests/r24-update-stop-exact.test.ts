/**
 * A one-click stop of a product's update emails is never lost on a reply that is not known (lib/product-updates.ts,
 * stopUpdates; app/api/mail/unsubscribe; CX-123 rule 24).
 *
 * Before: the stop link's GET answered cut short or of another shape, or a write of the stop that was not confirmed,
 * made stopUpdates answer false, which the route turned into 404 "Not found.": the buyer was told the link did not
 * exist and kept getting the emails. Now only an exact nil is "no such link" (false); anything else throws, and the
 * route answers 503 to try again, as it does for the other stops.
 *
 * Synthetic token and address only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { stopUpdates } from "@/lib/product-updates";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { store as redis } from "./redis-stub";

const TOKEN = "a".repeat(40);
const GRANT = JSON.stringify({ s: "b".repeat(32), e: "buyer@example.com", h: "", n: "Shop" });
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["two replies", [GRANT, GRANT]]] as [string, unknown[]][]) {
  test(`the stop link read as ${label}: not "no such link"`, async () => {
    redis.clear();
    await pipeline([["SET", `nl:upd:stop:${TOKEN}`, GRANT]]);
    redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "GET" && String(b[0][1]).startsWith("nl:upd:stop:") ? reply : pipeline(b))) as typeof redis.pipeline;
    try {
      const outcome = await stopUpdates(TOKEN).then((done) => String(done), () => "threw");
      assert.equal(outcome, "threw");
    } finally {
      redis.pipeline = pipeline;
    }
  });
}

test("the stop's write not confirmed: not \"no such link\"", async () => {
  redis.clear();
  await pipeline([["SET", `nl:upd:stop:${TOKEN}`, GRANT]]);
  redis.pipeline = (async (b: Batch) => (b.some((c) => c.some((part) => String(part).startsWith("nl:upd:off:"))) ? b.map(() => null) : pipeline(b))) as typeof redis.pipeline;
  try {
    const outcome = await stopUpdates(TOKEN).then((done) => String(done), () => "threw");
    assert.equal(outcome, "threw");
  } finally {
    redis.pipeline = pipeline;
  }
});

test("read exactly: no link is false, a link is stopped", async () => {
  redis.clear();
  assert.equal(await stopUpdates(TOKEN), false);
  await pipeline([["SET", `nl:upd:stop:${TOKEN}`, GRANT]]);
  assert.equal(await stopUpdates(TOKEN), true);
});

test("the route answers 503 for a stop it could not save, never 404", async () => {
  redis.clear();
  await pipeline([["SET", `nl:upd:stop:${TOKEN}`, GRANT]]);
  redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "GET" && String(b[0][1]).startsWith("nl:upd:stop:") ? [] : pipeline(b))) as typeof redis.pipeline;
  try {
    const response = await unsubscribePost(new NextRequest(`https://marktmorgen.com/api/mail/unsubscribe?u=${TOKEN}`, { method: "POST", body: new FormData() }));
    assert.equal(response.status, 503);
  } finally {
    redis.pipeline = pipeline;
  }
});
