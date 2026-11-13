/**
 * An event's places (lib/community-events.ts, rsvp) never go past its cap on
 * a reply that cannot be read (CX-123 rule 24). The member is written down
 * and the list's length read in the same trip; a length that is not a whole
 * number used to read as NaN, "not more than the cap", so the member was
 * kept on an event already full. Now an unknown length takes the member back
 * out, gives the room back and throws UnknownReplyError (the route answers
 * "error", to try again).
 *
 * Real rsvp and data room against tests/redis-stub.ts. Synthetic data only.
 */
import { rsvp, rsvpList, type CommunityEvent } from "@/lib/community-events";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COMMUNITY = "a".repeat(32);
const FIRST = "1".repeat(32);
const SECOND = "2".repeat(32);

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.clear();
  const original = redis.pipeline;
  const event = { id: "evt0000001", title: "Live Q&A", cancelled: false, start: Date.now() + 86_400_000, minutes: 60, cap: 1 } as unknown as CommunityEvent;
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;

  part("The only place is taken");
  is("the first member is added", await rsvp(COMMUNITY, event, FIRST, ROOM), "added");
  const withOne = await used();

  for (const [label, reply] of [["null", null], ["a word", "two"], ["a list", [2]]] as const) {
    part(`The list's length comes back as ${label}`);
    redis.pipeline = async (commands) => {
      const replies = (await original.call(redis, commands)) as unknown[];
      return commands.map((c, i) => (c[0] === "HLEN" ? reply : replies[i]));
    };
    let outcome: string;
    try {
      outcome = await rsvp(COMMUNITY, event, SECOND, ROOM);
    } catch (error) {
      outcome = error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
    } finally {
      redis.pipeline = original;
    }
    is("unknown, never added", outcome, "unknown");
    is("the event still holds only its one place", (await rsvpList(COMMUNITY, event.id)).map((r) => r.key), [FIRST]);
    is("the room taken for it is given back", await used(), withOne);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
