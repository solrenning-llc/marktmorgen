/**
 * Three more public reads paid for before they read (4 November 2026,
 * lib/page-read-rules.ts; the inventory of reads with no ceiling, items 12,
 * 14 and 17), against the in-memory Redis double and synthetic stores only:
 *
 *   - a license check takes its request before it reads the product or the
 *     key, and refused reads neither;
 *   - a collection page takes a request for each few of its products before
 *     it reads them;
 *   - a community search takes its requests (the room, each conversation)
 *     before it searches, and each access check of a page of lessons or
 *     events before it is made;
 *   - the one walk of a community's archive into its index pays each step
 *     before it reads or writes, never sends more than a step paid for, and
 *     refused reads and writes nothing more and stays to be done.
 */
import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { GET as licence } from "@/app/api/store/licence/route";
import { addProduct, claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { createEvent } from "@/lib/community-events";
import { needsWalk, walkCommunity } from "@/lib/community-walk";
import { WALK_BYTES_PER_UNIT, WALK_COMMANDS_PER_UNIT } from "@/lib/page-read-rules";
import { takePublicRequest } from "@/lib/traffic";
import { requestLimitFor } from "@/lib/traffic-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

/** Every command sent while `run` runs. */
async function watched<T>(run: () => Promise<T>): Promise<{ value: T; names: string[] }> {
  const original = redis.pipeline;
  const names: string[] = [];
  try {
    redis.pipeline = async (commands) => {
      for (const c of commands) names.push(String(c[0]));
      return original.call(redis, commands);
    };
    return { value: await run(), names };
  } finally {
    redis.pipeline = original;
  }
}

function asked(url: string): NextRequest {
  const at = new URL(url);
  return Object.assign(new Request(at, { headers: { "x-forwarded-for": "198.51.100.7" } }), { nextUrl: at }) as unknown as NextRequest;
}

const between = (source: string, first: string, then: string) => {
  const a = source.indexOf(first);
  const b = source.indexOf(then);
  return a > 0 && b > a;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("A license check pays before it reads");
  const OWNER = "keys@example.com";
  await claimHandle(OWNER, "keyshop", "Key Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_keys", subscriptionId: "sub_keys", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Plugin", "", "19", null);
  if (!made.ok) throw new Error("no product");
  const shop = (await storeForEmail(OWNER))!;
  const url = `https://marktmorgen.com/api/store/licence?store=keyshop&product=${made.product.id}&key=ABCD-EFGH-IJKL-MNOP`;
  const first = await licence(asked(url));
  is("with room: answered", first.status, 200);
  await takePublicRequest(shop, "buyer", Date.now(), requestLimitFor(shop));
  const refused = await watched(() => licence(asked(url)));
  is("refused once the window is used: 429", refused.value.status, 429);
  const route = readFileSync("app/api/store/licence/route.ts", "utf8");
  is("its request is taken before the product is read and before the key is checked", [between(route, 'takePublicRequest(store, "buyer")', "readListing(store, productId)"), between(route, 'takePublicRequest(store, "buyer")', "checkKey(store, product, key)")], [true, true]);

  part("A collection pays for its products before it reads them");
  const collection = readFileSync("app/[handle]/shop/[collection]/page.tsx", "utf8");
  is("its products' requests come before their listings, and refused it rests", [between(collection, "collectionUnits(ids.length)", "await readListings(store, ids)"), collection.includes('collectionUnits(ids.length)))) return <StoreResting store={store} />;')], [true, true]);

  part("A community search pays before it searches");
  const search = readFileSync("app/[handle]/community/search/page.tsx", "utf8");
  is("the search's requests before the walk and the searches", [between(search, "searchUnits({ room: config.chat.on, conversations })", "await walkCommunity("), between(search, "searchUnits({ room: config.chat.on, conversations })", "await searchEverything(")], [true, true]);
  is("each access check of a page of lessons or events before it is made", [between(search, "checkUnits(checks)", "await lessonsFound("), between(search, "checkUnits(checks)", "await eventsFound(")], [true, true]);

  part("The walk of a community's archive pays each step before it");
  const C = "club@example.com";
  await claimHandle(C, "club", "Club", "");
  await ensureStatsId(C);
  await setSubscription(C, { customerId: "cus_club", subscriptionId: "sub_club", active: true, tier: "pro", period: paidPeriod() });
  const club = (await setCommunity(C, true))!;
  const communityId = club.community!.id;
  for (let i = 0; i < 12; i += 1) {
    const event = await createEvent(club, { title: `Bread night ${i}`, about: "Sourdough, rye and spelt, with a long ferment and a hot oven. ".repeat(4), start: Date.now() + (i + 1) * 86_400_000, minutes: 60, tz: "UTC", cap: 0, where: "room", link: "", meet: null, only: [] });
    if (!event.ok) throw new Error("no event");
  }
  await redis.pipeline([["DEL", `nl:cm:${communityId}:sv`]]);

  const nothing = await watched(() => walkCommunity(club, async () => false));
  is("refused at its first step: no event or member read, nothing written, still to be done", [nothing.value, nothing.names.filter((n) => ["ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZADD", "SADD", "MGET", "HMGET"].includes(n)), await needsWalk(communityId)], [false, [], true]);

  // Every command between two payments is inside the one paid before it. Before the first, only the
  // walk's opening (its mark read, its lock taken, the events counted), inside the search's own requests;
  // after the last, its mark written and its lock let go.
  const original = redis.pipeline;
  let sent = 0;
  let allowed = 3;
  let over = 0;
  redis.pipeline = async (commands) => {
    sent += commands.length;
    if (sent > allowed) over = Math.max(over, sent - allowed);
    return original.call(redis, commands);
  };
  let paid = 0;
  const walked = await walkCommunity(club, async (units) => {
    paid += units;
    sent = 0;
    allowed = units * WALK_COMMANDS_PER_UNIT + 2;
    return true;
  });
  redis.pipeline = original;
  is("paid as it went, the walk is done and marked", [walked, await needsWalk(communityId)], [true, false]);
  is("no step sent more commands than it paid for", over, 0);
  console.log(`  a walk of twelve events and no members: ${paid} requests, at ${WALK_COMMANDS_PER_UNIT} commands or ${WALK_BYTES_PER_UNIT} bytes each`);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
