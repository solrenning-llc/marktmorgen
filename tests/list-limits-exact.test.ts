/**
 * Sweep A6, F7 (CX-123 rules 24/30): a list cap and an id choice never
 * proceed on an unknown read.
 *
 *   - lib/short-links.ts addLink reads the store's links (HVALS) to enforce
 *     MAX_LINKS and one link to a name: a reply missing its slot, of another
 *     shape or with a member that is not a string is unknown, and the link is
 *     refused as "unavailable" (the route answers 503, the studio says so in
 *     words) instead of writing link 101 or a second "Post 0". A SET NX reply
 *     other than "OK" or null is unknown too: nothing more is written.
 *   - lib/segments.ts saveSegment reads the saved groups (HVALS) to choose
 *     the id (the same name again replaces) and enforce MAX_SEGMENTS: an
 *     unknown reply refuses as "unavailable" (the route answers 503 with
 *     segment_unavailable, the studio says so in words), never group 21 nor a
 *     second "Group 0".
 *   - lib/segments.ts buyerLedger (LOW): imported buyers that cannot be read
 *     make the reading partial and no ten-minute copy is kept without them.
 *
 * Healthy controls: link 100 is accepted and 101 refused on a good read; a
 * new group gets a fresh id, the same name keeps its id, group 20 is accepted
 * and 21 refused. Synthetic records and the in-memory Redis only.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { addLink, readLinks } from "@/lib/short-links";
import { MAX_LINKS } from "@/lib/short-link-rules";
import { MAX_SEGMENTS, buyerLedger, listSegments, saveSegment } from "@/lib/segments";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as shortLinksRoute } from "@/app/api/store/short-links/route";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

redis.clear();
const mine = { sid: "list-limits-sid", statsId: "listlimitsstats" };
const isProduct = () => false;
const shop = { listId: "listlimitslist" } as unknown as Store;
const linksKey = `nl:slink:store:${mine.statsId}`;
const groupsKey = `nl:mail:segs:${shop.listId}`;

type Pipeline = typeof redis.pipeline;
/** Runs `run` while a one-command pipeline whose command and key match answers `reply` in place of Redis's own. */
async function withReply<T>(command: string, key: string | ((key: string) => boolean), reply: unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  const matches = (k: unknown) => (typeof key === "string" ? k === key : typeof k === "string" && key(k));
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0][0] === command && matches(commands[0][1]) ? reply : original.call(redis, commands)) as Pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}
const hlen = async (key: string) => Number((await redis.pipeline([["HLEN", key]]))[0]);
const hvals = async (key: string) => ((await redis.pipeline([["HVALS", key]]))[0] as string[]).map((raw) => JSON.parse(raw) as { name: string; id?: string; code?: string });

// ------------------------------------------------------------ short links

const links = (async () => {
  for (let i = 0; i < MAX_LINKS - 1; i += 1) assert.equal((await addLink(mine, { name: `Post ${i}`, place: "instagram", target: { kind: "store" } }, isProduct, 1_000 + i)).ok, true);
})();

test("control: link 100 is accepted and link 101 refused when HVALS answers", async () => {
  await links;
  const hundredth = await addLink(mine, { name: `Post ${MAX_LINKS - 1}`, place: "x", target: { kind: "store" } }, isProduct, 5_000);
  assert.equal(hundredth.ok, true);
  assert.equal(await hlen(linksKey), MAX_LINKS);
  assert.deepEqual(await addLink(mine, { name: "One more", place: "x", target: { kind: "store" } }, isProduct), { ok: false, reason: "full" });
  assert.equal(await hlen(linksKey), MAX_LINKS);
});

for (const [what, reply] of [
  ["a reply missing its slot", []],
  ["a reply that is not a list", [{ nope: 1 }]],
  ["a list with a member that is not a string", [[JSON.stringify({}), 7]]],
  ["a list with a hole", [[, "x"]]],
] as const) {
  test(`fails closed: ${what} to HVALS never lets link 101 or a second "Post 0" be written`, async () => {
    await links;
    const before = await hlen(linksKey);
    const added = await withReply("HVALS", linksKey, reply, () => addLink(mine, { name: "Post 0", place: "x", target: { kind: "store" } }, isProduct));
    assert.deepEqual(added, { ok: false, reason: "unavailable" }, `got ${JSON.stringify(added)}: the store now holds ${await hlen(linksKey)} links (MAX_LINKS ${MAX_LINKS})`);
    assert.equal(await hlen(linksKey), before);
    assert.equal((await hvals(linksKey)).filter((l) => l.name === "post-0").length, 1);
  });
}

test("fails closed: an unknown SET NX reply writes nothing to the store's links", async () => {
  const other = { sid: "list-limits-sid-2", statsId: "listlimitsother" };
  const added = await withReply("SET", (k) => k.startsWith("nl:slink:") && !k.startsWith("nl:slink:store:"), [], () => addLink(other, { name: "Fresh", place: "x", target: { kind: "store" } }, isProduct));
  assert.deepEqual(added, { ok: false, reason: "unavailable" });
  assert.equal(await hlen(`nl:slink:store:${other.statsId}`), 0);
});

// ------------------------------------------------------------ saved groups

const groups = (async () => {
  for (let i = 0; i < MAX_SEGMENTS - 1; i += 1) assert.equal((await saveSegment(shop, { name: `Group ${i}`, narrow: { minSpent: 100 + i } })).ok, true);
})();

test("control: a new group gets a fresh id; the same name keeps its id; group 20 accepted, group 21 refused", async () => {
  await groups;
  const ids = new Set((await listSegments(shop.listId)).map((s) => s.id));
  assert.equal(ids.size, MAX_SEGMENTS - 1);
  const twentieth = await saveSegment(shop, { name: `Group ${MAX_SEGMENTS - 1}`, narrow: { minSpent: 500 } });
  assert.equal(twentieth.ok, true);
  const fresh = (await listSegments(shop.listId)).find((s) => s.name === `Group ${MAX_SEGMENTS - 1}`)!;
  assert.equal(ids.has(fresh.id), false);
  assert.equal(await hlen(groupsKey), MAX_SEGMENTS);
  const before = (await listSegments(shop.listId)).find((s) => s.name === "Group 0")!.id;
  assert.equal((await saveSegment(shop, { name: "group 0", narrow: { minSpent: 777 } })).ok, true);
  const again = (await listSegments(shop.listId)).filter((s) => s.name.toLowerCase() === "group 0");
  assert.deepEqual(again.map((s) => [s.id, s.minSpent]), [[before, 777]]);
  assert.equal(await hlen(groupsKey), MAX_SEGMENTS);
  assert.deepEqual(await saveSegment(shop, { name: "One more", narrow: { minSpent: 100 } }), { ok: false, reason: "full" });
  assert.equal(await hlen(groupsKey), MAX_SEGMENTS);
});

for (const [what, reply] of [
  ["a reply missing its slot", []],
  ["a reply that is not a list", ["OK"]],
  ["a list with a member that is not a string", [[null]]],
] as const) {
  test(`fails closed: ${what} to HVALS never lets group 21 or a second "Group 0" be written`, async () => {
    await groups;
    const before = await hlen(groupsKey);
    const saved = await withReply("HVALS", groupsKey, reply, () => saveSegment(shop, { name: "Group 0", narrow: { minSpent: 999 } }));
    assert.deepEqual(saved, { ok: false, reason: "unavailable" }, `got ${JSON.stringify(saved).slice(0, 80)}: the list now holds ${await hlen(groupsKey)} groups (MAX_SEGMENTS ${MAX_SEGMENTS})`);
    assert.equal(await hlen(groupsKey), before);
    assert.equal((await hvals(groupsKey)).filter((g) => g.name.toLowerCase() === "group 0").length, 1);
  });
}

// ------------------------------------------------------------ the routes and the studio

test("the routes answer an unknown read with an honest 503, and the studio says it in words", async () => {
  const owner = "list-limits@example.com";
  await claimHandle(owner, "listlimits", "List Limits", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_listlimits", subscriptionId: "sub_listlimits", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const session = await openSession(owner);
  const post = async (route: (r: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const link = await withReply("HVALS", `nl:slink:store:${store.statsId}`, [], () => post(shortLinksRoute, "/api/store/short-links", { action: "add", name: "Reel", place: "x", target: { kind: "store" } }));
  assert.deepEqual(link, { status: 503, body: { ok: false, error: "unavailable" } });
  assert.equal(await hlen(`nl:slink:store:${store.statsId}`), 0);
  const healthy = await post(shortLinksRoute, "/api/store/short-links", { action: "add", name: "Reel", place: "x", target: { kind: "store" } });
  assert.equal(healthy.status, 200);
  const group = await withReply("HVALS", `nl:mail:segs:${store.listId}`, [], () => post(mailRoute, "/api/store/mail", { action: "segment-save", name: "Best", narrow: { minSpent: 100 } }));
  assert.deepEqual(group, { status: 503, body: { ok: false, error: "segment_unavailable" } });
  assert.equal(await hlen(`nl:mail:segs:${store.listId}`), 0);
  const shortLinks = readFileSync("components/short-links.tsx", "utf8");
  assert.match(shortLinks, /\bunavailable: "[^"]+"/, "the short links panel names the unavailable refusal in words");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  assert.match(studio, /\bsegment_unavailable: "[^"]+"/, "the email studio names the segment_unavailable refusal in words");
  assert.equal((await readLinks(store.statsId)).length, 1);
});

// ------------------------------------------------------------ the ten-minute copy (LOW)

test("imported buyers that cannot be read make the reading partial, and no ten-minute copy is kept without them", async () => {
  const statsId = "listlimitsledger";
  await redis.pipeline([["HSET", `nl:imp:who:${statsId}`, "old@example.com", "1"]]);
  const pastBuyers = { listId: "listlimitsledgerlist", statsId, currency: "usd", pastBuyers: true } as unknown as Store;
  const ledger = await withReply("HGETALL", (k) => k.includes(statsId), [], () => buyerLedger(pastBuyers));
  assert.equal(ledger.partial, true);
  assert.equal(Number((await redis.pipeline([["EXISTS", `nl:stats:${statsId}:ledger`]]))[0]), 0);
  const healthy = await buyerLedger(pastBuyers);
  assert.deepEqual([healthy.partial, [...healthy.buyers.keys()]], [false, ["old@example.com"]]);
});
