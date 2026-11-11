/**
 * A store's bookings calendar (app/api/store/calendar/[token]/route.ts; lib/calendar-sync.ts, storeIdForToken) reads
 * its private address exactly (rule 24). A GET answered nil is an address that is not one (404); a reply lost or in
 * another shape is unknown. Before, storeIdForToken took any reply that was not text for "no such address", and the
 * route's .catch did the same with a failure, so a calendar app asking during a Redis blip got 404 "Not found", and many
 * apps drop a subscription on 404. Now the route answers 503 with Retry-After, and the app keeps what it had.
 * Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { storeIdForToken } from "@/lib/calendar-sync";
import { UnknownReplyError } from "@/lib/redis-reply";
import { GET } from "@/app/api/store/calendar/[token]/route";

const TOKEN = "b".repeat(48);
const real = redis.pipeline.bind(redis);
let odd: { prefix: string; reply: unknown } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (odd && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith(odd.prefix)) {
    return odd.reply === "LOST" ? [] : [odd.reply];
  }
  return real(commands);
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  odd = null;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
});

const ask = () => GET(new Request(`https://marktmorgen.com/api/store/calendar/${TOKEN}.ics`), { params: Promise.resolve({ token: `${TOKEN}.ics` }) });

for (const reply of [1, {}, ["s"], true, "LOST"]) {
  test(`an address whose token reads ${JSON.stringify(reply)} is unknown: 503 with Retry-After, never 404`, async () => {
    odd = { prefix: "nl:cal:tok:", reply };
    await assert.rejects(storeIdForToken(TOKEN), UnknownReplyError);
    const answer = await ask();
    assert.equal(answer.status, 503);
    assert.ok(Number(answer.headers.get("retry-after")) > 0);
  });

  test(`an address whose store's settings read ${JSON.stringify(reply)} is unknown: 503, never 404`, async () => {
    await real([["SET", `nl:cal:tok:${(await import("node:crypto")).createHash("sha256").update(`nimbus-cal:${TOKEN}`).digest("hex").slice(0, 40)}`, "s".repeat(32)]]);
    odd = { prefix: "nl:cal:cfg:", reply };
    await assert.rejects(storeIdForToken(TOKEN), UnknownReplyError);
    assert.equal((await ask()).status, 503);
  });
}

test("an address that is not one (GET nil) is still 404", async () => {
  assert.equal(await storeIdForToken(TOKEN), null);
  assert.equal((await ask()).status, 404);
});
