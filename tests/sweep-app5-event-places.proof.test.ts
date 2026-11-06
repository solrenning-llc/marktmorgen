/**
 * Sweep app5 proof (CX-123 rules 24 and 30), synthetic only: the in-memory Redis double, no network.
 *
 * app/[handle]/community/events/[event]/page.tsx:75-96 (and the list, app/[handle]/community/events/page.tsx:71)
 * draw an event from `rsvpNumbers` (lib/community-events.ts:684-692), which reads its HLEN with `Number(x) || 0` and its
 * HEXISTS with `Number(x) === 1`. An answer in an unknown shape is "nobody is coming" and "you are not coming":
 *
 * - a capped event whose places are all taken is shown as "0 going · 2 of 2 places left" with "Take a place"
 *   instead of "full";
 * - the member who holds a place is told nothing about it and, once the doors are open, `wayInFor` (line 87) withholds
 *   the way in from them: a paying member with a place is shut out of the live event.
 *
 * The page's own lines 83-96 are reproduced here with the real functions it calls (the page itself needs a signed-in
 * community session; rendering it is left to the fix's regression test). Healthy control first; the checks named DEFECT
 * pass while the defect is present.
 */
import { claimHandle, storeForEmail } from "@/lib/store";
import { type CommunityEvent, joinWindow, rsvpNumbers, wayInFor } from "@/lib/community-events";
import { placesWords } from "@/components/community-events";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("sweepapp5event@example.com", "sweepappevent", "Sweep App Event", "");
  const store = (await storeForEmail("sweepapp5event@example.com"))!;
  const community = "c".repeat(12);
  const now = Date.now();
  // Doors open: it started five minutes ago and lasts an hour.
  const event: CommunityEvent = {
    id: "e".repeat(12), title: "Live bake-along", about: "", start: now - 5 * 60_000, minutes: 60, tz: "UTC", cap: 2,
    where: "room", meet: null, room: "https://rooms.example.test/sweep-room", link: "", only: [], replay: null,
    cancelled: false, post: "", at: Math.floor(now / 1000) - 3600, moves: 0, v: 1,
  };
  const key = `nl:cm:${community}:ev:${event.id}:r`;
  await real([["HSET", key, "member-ana", "1", "member-ben", "1"]]);

  // The page's lines 83-96, for a member (not the owner) who may attend.
  const page = async (member: string) => {
    const numbers = await rsvpNumbers(community, [event], member);
    const going = numbers.get(event.id)?.going ?? 0;
    const mine = numbers.get(event.id)?.mine ?? false;
    const way = wayInFor(event, { owner: false, mayAttend: true, going: mine }, now, null);
    const full = event.cap > 0 && going >= event.cap;
    return { line: placesWords(store, event, going), youAreGoing: mine, full, wayIn: way };
  };
  const unknownReplies = () => {
    redis.pipeline = (async (commands: Command[]) => {
      const replies = await real(commands);
      return commands.map((c, i) => (c[1] === key && (c[0] === "HLEN" || c[0] === "HEXISTS") ? { unexpected: true } : replies[i]));
    }) as typeof redis.pipeline;
  };

  part("Healthy control: both places taken, ana is one of them, doors open");
  is("doors are open", joinWindow(event, now).open, true);
  const healthy = await page("member-ana");
  is("ana is told she is going, the event is full, and she gets the way in", [healthy.youAreGoing, healthy.full, healthy.wayIn], [true, true, event.room]);
  is("the line says full", healthy.line.includes("2 going"), true);

  part("DEFECT: HLEN and HEXISTS answer in an unknown shape");
  unknownReplies();
  const broken = await page("member-ana");
  redis.pipeline = real;
  is("DEFECT: nobody is going, every place is open", [broken.full, broken.line.includes("0 going")], [false, true]);
  is("DEFECT: ana, who holds a place, is not told so", broken.youAreGoing, false);
  is("DEFECT: and the way in is withheld from her while the event is live", broken.wayIn, null);

  part("Control again");
  is("ana gets the way in again", (await page("member-ana")).wayIn, event.room);
  done();
}

void main();
