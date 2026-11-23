/**
 * Board #5285, row #3734 (Codex's two findings on #3734, still on main), community search (lib/community-found.ts):
 * 1. A read that failed is not "nothing found" (CX-123 rule 24): events that could not be read are counted as
 *    not checked, never as no match, and members that could not be read are said to be unread (null), never [].
 * 2. The logs of those failures carry the error's kind only, never the raw error, whose message or cause may hold a
 *    member's address or another personal detail.
 * Synthetic: the in-memory Redis made to fail.
 */
import { eventsFound, membersFound } from "@/lib/community-found";
import type { Store } from "@/lib/store";
import type { CommunityConfig } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.UPSTASH_REDIS_REST_TOKEN ??= "synthetic";

async function main(): Promise<void> {
  const actual = redis.pipeline.bind(redis);
  const store = { community: { id: "0123456789abcdef0123456789abcdef" } } as Store;
  const config = {} as CommunityConfig;
  const viewer = { owner: false, email: "member@example.com", key: "synthetic" };
  const logged: unknown[][] = [];
  const previous = console.error;
  // A failure whose message names a member, as a provider's or a parser's message can.
  redis.pipeline = (async () => {
    throw new Error("read failed for member@example.com");
  }) as typeof redis.pipeline;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  let events: Awaited<ReturnType<typeof eventsFound>>;
  let members: Awaited<ReturnType<typeof membersFound>>;
  try {
    events = await eventsFound(store, config, ["0123456789ab", "0123456789ac"], viewer);
    members = await membersFound(store.community!.id, ["member@example.com"]);
  } finally {
    redis.pipeline = actual;
    console.error = previous;
  }

  part("A failed read is not \"nothing found\" (rule 24)");
  is("events not read are counted as not checked, one for each match, and none is shown", [events.found, events.unchecked], [[], 2]);
  is("members not read are said to be unread, never an empty list", members, null);

  part("The failures are logged by their kind, never with the raw error");
  is("each failure is logged once, under its own words", logged.map(([message]) => message), ["reading events for community search failed", "reading members for community search failed"]);
  is("no log line carries an Error object", logged.some((args) => args.some((arg) => arg instanceof Error)), false);
  is("no log line carries the error's message", logged.some((args) => args.some((arg) => String(arg).includes("member@example.com"))), false);
  is("the kind is logged", logged.map((args) => args[1]), ["Error", "Error"]);

  part("Control: reads that answer are unchanged");
  redis.clear();
  is("no events, no matches, nothing unchecked", await eventsFound(store, config, ["0123456789ab"], viewer), { found: [], unchecked: 0, lasting: false });
  is("no members listed: an empty list", await membersFound(store.community!.id, ["member@example.com"]), []);
  done();
}

void main();
