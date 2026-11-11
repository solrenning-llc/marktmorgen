/**
 * What customers are saying, with the waitlists of products coming soon as a
 * sign of demand (95 [D2-DEMAND-RADAR], unit 2: waitlistSizes in
 * lib/waitlist.ts, gatherVoice in lib/customer-voice.ts).
 *
 * What fails here:
 *   - a product people wait for left out, or counted other than exactly;
 *   - anything about who joined reaching the texts;
 *   - a count or a list that cannot be read taken as nobody waiting (rule
 *     24): the list is named as unread instead;
 *   - more products coming soon than are read, taken as all of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherVoice, voicePrompt } from "@/lib/customer-voice";
import { WAITLIST_VOICE_PRODUCTS, waitlistSizes } from "@/lib/waitlist";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import * as voiceScreen from "@/components/customer-voice";
import { store as redis } from "./redis-stub";

redis.clear();

async function soonStore(owner: string, handle: string, waiting: Record<string, number>) {
  assert.equal((await claimHandle(owner, handle, "Shop", "")).ok, true);
  await ensureStatsId(owner);
  const ids: Record<string, string> = {};
  for (const [title, people] of Object.entries(waiting)) {
    const made = await addProduct(owner, title, "", "30", null);
    if (!made.ok) throw new Error("no product");
    ids[title] = made.product.id;
  }
  const store = (await storeForEmail(owner))!;
  for (const [title, people] of Object.entries(waiting)) {
    await redis.pipeline([["SADD", `nl:wl:${store.statsId}:soon`, ids[title]]]);
    for (let i = 0; i < people; i += 1) await redis.pipeline([["HSET", `nl:wl:${store.statsId}:${ids[title]}`, `p${i}@example.com`, JSON.stringify({ at: 1, ok: i % 2 })]]);
  }
  return { store, ids };
}

async function withReply<T>(match: (c: unknown[]) => boolean, answer: (reply: unknown) => unknown, body: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: unknown[][]) => {
    const replies = (await original.call(redis, commands as never)) as unknown[];
    return commands.map((c, i) => (match(c) ? answer(replies[i]) : replies[i]));
  }) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = original;
  }
}

test("each product coming soon with people waiting is a text: its name, how many joined, never who", async () => {
  const { store, ids } = await soonStore("voice.wait@example.com", "voice-wait", { "Pottery Course": 3, "Glaze Guide": 0 });
  assert.deepEqual(await waitlistSizes(store), [{ productId: ids["Pottery Course"], people: 3 }, { productId: ids["Glaze Guide"], people: 0 }].sort((a, b) => b.people - a.people));
  const { items, unread } = await gatherVoice(store, Date.now());
  assert.deepEqual(unread, []);
  const waiting = items.filter((i) => i.source === "waitlist");
  assert.deepEqual(waiting.map((i) => [i.text, i.n]), [["Pottery Course", 3]]);
  assert.ok(!JSON.stringify(items).includes("@example.com"), "nobody's address");
  assert.match(voicePrompt(waiting), /\(a product coming soon people joined the waitlist for, joined 3 times\) Pottery Course/);
});

test("a count or a list that cannot be read is named, never nobody waiting", async () => {
  const { store } = await soonStore("voice.waitbad@example.com", "voice-waitbad", { "Kiln Notes": 2 });
  for (const [what, match, answer] of [
    ["the soon list failed", (c: unknown[]) => c[0] === "SMEMBERS" && String(c[1]).endsWith(":soon"), () => null],
    ["a count that is not a number", (c: unknown[]) => c[0] === "HLEN", () => "lots"],
    ["a negative count", (c: unknown[]) => c[0] === "HLEN", () => -1],
  ] as [string, (c: unknown[]) => boolean, (r: unknown) => unknown][]) {
    const result = await withReply(match, answer, () => gatherVoice(store, Date.now()));
    assert.deepEqual(result.unread, ["waitlist"], what);
    await assert.rejects(() => withReply(match, answer, () => waitlistSizes(store)), what);
  }
});

test("more products coming soon than are read is unknown, never all of them", async () => {
  const { store } = await soonStore("voice.waitmany@example.com", "voice-waitmany", {});
  for (let i = 0; i <= WAITLIST_VOICE_PRODUCTS; i += 1) await redis.pipeline([["SADD", `nl:wl:${store.statsId}:soon`, `p${String(i).padStart(10, "0")}`]]);
  await assert.rejects(() => waitlistSizes(store));
  assert.deepEqual((await gatherVoice(store, Date.now())).unread, ["waitlist"]);
});

test("the screen names the list", () => {
  assert.equal(voiceScreen.unreadWords(["waitlist"]), "Waitlists of products coming soon");
});

test("names that cannot be read leave the waitlists unread, never left out", async () => {
  const { store } = await soonStore("voice.waitnames@example.com", "voice-waitnames", { "Studio Lamp": 2 });
  const result = await withReply((c) => c[0] === "HGETALL" || c[0] === "HMGET" || (c[0] === "GET" && String(c[1]).includes(":titles")), () => { throw new Error("synthetic"); }, () => gatherVoice(store, Date.now()));
  assert.ok(result.unread.includes("waitlist"));
});
