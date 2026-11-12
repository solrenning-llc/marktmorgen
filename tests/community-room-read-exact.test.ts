// The community room is read exactly (rule 24): a lost or off-shape Redis
// reply is not "an empty room". room() and lastSaid() throw on one, so the
// room page fails and the polling routes answer 503 ("could not confirm"),
// instead of showing a room with nothing said in it, or a pace for a room
// nobody spoke in. Only an exact empty list means an empty room.
// Synthetic Redis only (tests/redis-stub.ts).
import { lastSaid, room } from "@/lib/community-chat";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const ROOM = `nl:cm:${COMMUNITY}:ch`;
const line = (i: number, text: string, at: number) => JSON.stringify({ i, a: MEMBER, text, at });

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

/** Answers the next pipeline call on the room with `reply`; everything else reaches the stand-in. */
function answer(reply: unknown): void {
  let hit = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!hit && batch[0]?.[1] === ROOM) {
      hit = true;
      return reply as unknown[];
    }
    return original(batch);
  }) as typeof redis.pipeline;
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch {
    return "threw";
  } finally {
    redis.pipeline = original;
  }
}

function seed(): void {
  redis.clear();
  redis.run(["ZADD", ROOM, 100, line(1, "Fresh bread today", 100)]);
  redis.run(["ZADD", ROOM, 101, line(2, "Rye is best", 101)]);
}

const UNKNOWN: [string, unknown][] = [
  ["no reply at all", []],
  ["a null reply", [null]],
  ["an error reply", [{ error: "ERR unknown" }]],
  ["a number for a list", [7]],
  ["a list with a number in it", [[line(1, "x", 100), 3]]],
  ["a reply that is not a list", [{}]],
];

async function main() {
  part("room(): a room read in an unknown shape is never an empty room");
  for (const [name, reply] of UNKNOWN) {
    seed();
    answer(reply);
    is(`opening the room, ${name}`, await outcome(() => room(COMMUNITY)), "threw");
    seed();
    answer(reply);
    is(`looking again since 100, ${name}`, await outcome(() => room(COMMUNITY, 100)), "threw");
  }

  part("room(): exact replies still read as they are");
  seed();
  const opened = (await room(COMMUNITY)) as { messages: { i: number }[]; cursor: number };
  is("opening reads both messages, oldest first", opened.messages.map((m) => m.i), [1, 2]);
  is("the cursor is the newest", opened.cursor, 2);
  const since = (await room(COMMUNITY, 100)) as { messages: { i: number }[]; cursor: number };
  is("since 100 reads only the newer one", since.messages.map((m) => m.i), [2]);
  redis.clear();
  const empty = (await room(COMMUNITY)) as { messages: unknown[]; cursor: number };
  is("an exact empty room is empty", empty.messages.length, 0);
  is("an empty room's cursor is where it was", (await room(COMMUNITY, 55)).cursor, 55);

  part("lastSaid(): an unknown reply is never 'nobody spoke'");
  for (const [name, reply] of UNKNOWN) {
    seed();
    answer(reply);
    is(`last said, ${name}`, await outcome(() => lastSaid(COMMUNITY)), "threw");
  }
  seed();
  is("last said in a room with messages", await lastSaid(COMMUNITY), 101);
  redis.clear();
  is("last said in an exact empty room is 0", await lastSaid(COMMUNITY), 0);
  done();
}

void main();
