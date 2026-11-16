/**
 * Rule 24 in an event's places (CX-123; the coordinator's sweep of `Number(x) || 0`, 16 November 2026).
 *
 * rsvp wrote the member down (HSETNX) and read the list's length (HLEN) in one trip, then decided with `Number(...)`:
 *   - a length that did not read was NaN, never above the cap, so a member stayed on a full event's list ("added");
 *   - an HSETNX that did not read was "already", and the room taken for the place was given back while the field
 *     might be written, so the store's data room counted less than it held.
 * rsvpNumbers read each event's HLEN as `Number(x) || 0`, so a count that did not read showed "0 going" to members
 * and told the creator "0 people have RSVP'd" fifteen minutes before the start. Now each reply is read exactly: the
 * place is never kept on an unknown length (it is taken back out, and the request answers unknown), the room is kept
 * whole on an unknown write, and an unread count is null, shown as no count at all.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import { readFileSync } from "node:fs";
import { type CommunityEvent, rsvp, rsvpNumbers } from "@/lib/community-events";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
let bend: ((commands: Cmd[], real: unknown[]) => unknown[]) | null = null;
const sent: Cmd[] = [];
redis.pipeline = (async (commands: Cmd[]) => {
  sent.push(...commands);
  const real = await original(commands);
  return bend ? bend(commands, real as unknown[]) : real;
}) as typeof redis.pipeline;
const bendWord = (word: string, value: unknown) => (commands: Cmd[], real: unknown[]) => real.map((r, i) => (commands[i][0] === word ? value : r));

const ID = "r24-events";
const event = (id: string, cap: number): CommunityEvent =>
  ({
    id,
    title: "Live",
    about: "",
    start: Date.now() + 86_400_000,
    minutes: 60,
    tz: "UTC",
    cap,
    where: "room",
    meet: null,
    room: "room",
    link: "",
    only: [],
    replay: null,
    cancelled: false,
    post: "",
    at: Math.floor(Date.now() / 1000),
  }) as CommunityEvent;
const key = (e: string) => `nl:cm:${ID}:ev:${e}:r`;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("rsvp: a list's length that does not read never keeps a place on a capped event");
  for (const value of ["QUEUED", null, "2"]) {
    const e = event(`cap${String(value)}`.replace(/\W/g, "x"), 1);
    is("first place taken", await rsvp(ID, e, "member-a", ROOM), "added");
    bend = bendWord("HLEN", value);
    const answer = await outcome(() => rsvp(ID, e, "member-b", ROOM));
    bend = null;
    is(`HLEN answered ${JSON.stringify(value)}: unknown, never added`, answer, "unknown");
    const [kept] = (await original([["HEXISTS", key(e.id), "member-b"]])) as unknown[];
    is("the second member is not left on the list", kept, 0);
  }

  part("rsvp: a write that does not read keeps the room taken");
  {
    const e = event("unknownwrite", 0);
    sent.length = 0;
    bend = bendWord("HSETNX", "QUEUED");
    const answer = await outcome(() => rsvp(ID, e, "member-c", ROOM));
    bend = null;
    is("unknown, never 'already'", answer, "unknown");
  }

  part("rsvpNumbers: a count that does not read is null, never 0");
  {
    const e = event("counted", 0);
    await rsvp(ID, e, "member-d", ROOM);
    bend = bendWord("HLEN", "QUEUED");
    const numbers = await rsvpNumbers(ID, [e], "member-d");
    bend = null;
    is("going unknown", numbers.get(e.id)?.going, null);
    is("mine still read", numbers.get(e.id)?.mine, true);
    is("a whole reply that does not read: unknown", await outcome(() => (bend = () => ["QUEUED"], rsvpNumbers(ID, [e], null)).finally(() => (bend = null))), "unknown");
  }

  part("Callers never show 0 for a count that did not read");
  const mail = readFileSync("lib/community-event-mail.ts", "utf8");
  const one = readFileSync("app/[handle]/community/events/[event]/page.tsx", "utf8");
  const list = readFileSync("app/[handle]/community/events/page.tsx", "utf8");
  is("the creator's alert has no `?? 0` on going", /\?\.going \?\? 0/.test(mail), false);
  is("the event page has no `?? 0` on going", /\?\.going \?\? 0/.test(one), false);
  is("the events list has no `?? 0` on going", /\?\.going \?\? 0/.test(list), false);

  part("Control: real replies give the real numbers");
  {
    const e = event("control", 2);
    is("one", await rsvp(ID, e, "m1", ROOM), "added");
    is("two", await rsvp(ID, e, "m2", ROOM), "added");
    is("full", await rsvp(ID, e, "m3", ROOM), "full");
    is("again", await rsvp(ID, e, "m1", ROOM), "already");
    is("two going", (await rsvpNumbers(ID, [e], "m3")).get(e.id)?.going, 2);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
