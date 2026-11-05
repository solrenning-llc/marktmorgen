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
import { index } from "@/lib/community-search";
import { searchedConversations } from "@/lib/community-dm";
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

  // Codex I (#2316), the walk measured step by step against what each step paid; `inject` runs once, unmeasured, after the first read of an event's own words.
  const eventIndex = new RegExp(`^nl:cm:${communityId}:wie:(.+)$`);
  const many = Array.from({ length: 600 }, (_, i) => `loaf${i}x`);
  const measured = async (reply: (commands: (string | number)[][], replies: unknown[]) => unknown[], inject: ((thing: string) => Promise<void>) | null) => {
    await redis.pipeline([["DEL", `nl:cm:${communityId}:sv`]]);
    let stepSent = 0;
    let stepAllowed = 3;
    let worst = 0;
    let removed = 0;
    let measuring = true;
    let pending = inject;
    redis.pipeline = async (commands) => {
      if (!measuring) return original.call(redis, commands);
      stepSent += commands.length;
      removed += commands.filter((c) => c[0] === "ZREM").length;
      if (stepSent > stepAllowed) worst = Math.max(worst, stepSent - stepAllowed);
      const replies = reply(commands, await original.call(redis, commands));
      const read = commands.find((c) => (c[0] === "SCARD" || c[0] === "SMEMBERS") && eventIndex.test(String(c[1])));
      if (read && pending) {
        const run = pending;
        pending = null;
        measuring = false;
        await run(eventIndex.exec(String(read[1]))![1]);
        measuring = true;
      }
      return replies;
    };
    const finished = await walkCommunity(club, async (units) => {
      stepSent = 0;
      stepAllowed = units * WALK_COMMANDS_PER_UNIT + 2;
      return true;
    }).catch(() => "threw");
    redis.pipeline = original;
    return { finished, worst, removed, still: await needsWalk(communityId) };
  };

  part("Codex I (#2316) 1: a reply that cannot be read stops the walk; it is never read as nothing");
  const blank = await measured((commands, replies) => replies.map((r, i) => (commands[i][0] === "SMEMBERS" && eventIndex.test(String(commands[i][1])) ? null : r)), null);
  is("an odd reply for an event's words: stopped, nothing removed, still to be done", [blank.finished, blank.removed, blank.still, blank.worst], [false, 0, true, 0]);
  const short = await measured((commands, replies) => (commands.some((c) => c[0] === "SMEMBERS" && eventIndex.test(String(c[1]))) ? replies.slice(0, 1) : replies), null);
  is("a partial reply: stopped, nothing removed, still to be done", [short.finished, short.removed, short.still, short.worst], [false, 0, true, 0]);

  part("Codex I (#2316) 2: a write to the index while the walk counts never makes it send more than it paid");
  const raced = await measured((_, replies) => replies, async (thing) => {
    // Right after the walk read (or counted) the words it is found by, the real index writes six hundred others for it.
    await index(communityId, "event", thing, 1, many);
  });
  is("the walk finishes, no step over what it paid", [raced.finished, raced.worst, raced.still], [true, 0, false]);

  part("Codex I (#2316) 1: a count of a person's conversations that comes back empty is unknown, not none");
  const zcard = redis.pipeline;
  redis.pipeline = async (commands) => (commands[0]?.[0] === "ZCARD" ? [null] : zcard.call(redis, commands));
  const unknownCount = await searchedConversations(communityId, "someone");
  redis.pipeline = zcard;
  is("ZCARD answering null gives null", unknownCount, null);
  is("and a real empty inbox is none", await searchedConversations(communityId, "someone"), 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
