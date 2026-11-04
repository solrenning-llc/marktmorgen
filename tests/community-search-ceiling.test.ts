/**
 * A community search and the walk of its archive, paid for before they read
 * (4 November 2026, lib/community-read-rules.ts; the inventory of reads with
 * no ceiling, item 14), against the in-memory Redis double and synthetic
 * stores only:
 *
 *   - a search takes its requests (the room, each conversation) before it
 *     searches, and each access check of a page of lessons or events before
 *     it is made;
 *   - the one walk of a community's archive into its index pays each step
 *     before it reads or writes, never sends more than a step paid for, and
 *     refused reads and writes nothing more and stays to be done.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, setCommunity, setSubscription } from "@/lib/store";
import { createEvent } from "@/lib/community-events";
import { needsWalk, walkCommunity } from "@/lib/community-walk";
import { WALK_BYTES_PER_UNIT, WALK_COMMANDS_PER_UNIT } from "@/lib/community-read-rules";
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

const between = (source: string, first: string, then: string) => {
  const a = source.indexOf(first);
  const b = source.indexOf(then);
  return a > 0 && b > a;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

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
