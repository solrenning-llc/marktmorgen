/**
 * The test meeting each connected account has (lib/meet-test.ts) is read only
 * in its exact shape (CX-123 rule 24; Codex G's review of #3050).
 *
 * "None there" is said only for a confirmed none: the slot answered null.
 * Any other reply (missing, of another type, text that is not the record, a
 * record without its id, link or times) is unknown. Then:
 *   - readTests throws, so the Video calls page says it could not read the
 *     test meeting, and offers no "Make a test meeting" over one that is there;
 *   - makeTest makes no second real meeting on the creator's account;
 *   - moveTest and removeTest do not answer "there was none".
 * Each of them throws TestMeetingUnavailable, which the route already answers
 * as 503, "try again in a moment", without logging a provider problem.
 *
 * Synthetic store and Redis (tests/redis-stub.ts); every outbound request
 * throws, so no provider is reached.
 */
import { makeTest, moveTest, readTests, removeTest, TestMeetingUnavailable } from "@/lib/meet-test";
import { testKey } from "@/lib/meet-connect";
import { redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let outbound = 0;
globalThis.fetch = (async () => {
  outbound++;
  throw Error("Unexpected external request in a synthetic test");
}) as typeof fetch;

type Commands = (string | number)[][];
const SID = "s0000000000000000-meettest";
const KEY = testKey(SID, "google");
const HEALTHY = { id: "evt_synthetic", link: "https://meet.example.test/abc", start: 1_800_000_000_000, end: 1_800_001_800_000, madeAt: 1_799_996_400_000 };
const store = { statsId: SID } as unknown as Store;

const pipe = redis.pipeline.bind(redis);
/** The real store's replies, with the GET of the test meeting's key answered as given. */
const answering = (reply: unknown) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => (commands[i][0] === "GET" && commands[i][1] === KEY ? reply : r));
  }) as typeof redis.pipeline;
};
/** The pipeline's whole answer replaced as given. */
const answeringAll = (replies: unknown) => {
  redis.pipeline = (async () => replies) as unknown as typeof redis.pipeline;
};
const restore = () => {
  redis.pipeline = pipe as typeof redis.pipeline;
};
const outcome = async <T,>(run: () => Promise<T>): Promise<string> => {
  try {
    return JSON.stringify(await run());
  } catch (error) {
    return error instanceof TestMeetingUnavailable ? "unavailable" : `other: ${(error as Error).message}`;
  }
};
const kept = async () => (await redisPipeline([["GET", KEY]]))[0];

async function main(): Promise<void> {
  part("Controls: a kept test meeting, and a confirmed none, read as before");
  redis.clear();
  await redisPipeline([["SET", KEY, JSON.stringify(HEALTHY)]]);
  is("healthy: the kept test meeting is read", await outcome(() => readTests(SID, ["google"])), JSON.stringify({ google: HEALTHY }));
  is("healthy: making one gives back the one already there, no request out", [await outcome(() => makeTest(store, "google")), outbound], [JSON.stringify(HEALTHY), 0]);
  redis.clear();
  is("confirmed none (null): read as none", await outcome(() => readTests(SID, ["google"])), "{}");
  is("confirmed none (null): moving says there is none", await outcome(() => moveTest(store, "google")), "null");
  is("confirmed none (null): removing says there was none", await outcome(() => removeTest(SID, "google")), "false");

  const odd: [string, unknown][] = [
    ["a missing slot (undefined)", undefined],
    ["a number", 42],
    ["true", true],
    ["a list", [JSON.stringify(HEALTHY)]],
    ["an object, not text", { ...HEALTHY }],
    ["empty text", ""],
    ["text cut short", "{cut"],
    ["an empty record", "{}"],
    ["a record without its id", JSON.stringify({ ...HEALTHY, id: undefined })],
    ["a record whose link is not https", JSON.stringify({ ...HEALTHY, link: "http://meet.example.test/abc" })],
    ["a record whose start is not a number", JSON.stringify({ ...HEALTHY, start: "soon" })],
    ["a record without its end", JSON.stringify({ ...HEALTHY, end: undefined })],
    ["a record whose made-at is not a number", JSON.stringify({ ...HEALTHY, madeAt: null })],
    ["JSON that is a list", JSON.stringify([HEALTHY])],
    ["JSON null", "null"],
  ];
  for (const [label, reply] of odd) {
    part(`The test meeting's GET answers ${label}`);
    redis.clear();
    await redisPipeline([["SET", KEY, JSON.stringify(HEALTHY)]]);
    const before = outbound;
    answering(reply);
    const read = await outcome(() => readTests(SID, ["google"]));
    const made = await outcome(() => makeTest(store, "google"));
    const moved = await outcome(() => moveTest(store, "google"));
    const removed = await outcome(() => removeTest(SID, "google"));
    restore();
    is("read: unknown, never none", read, "unavailable");
    is("make: no second meeting is made over the one there", [made, outbound - before], ["unavailable", 0]);
    is("move: never 'there is none'", moved, "unavailable");
    is("remove: never 'there was none'", removed, "unavailable");
    is("the kept record is left as it was", await kept(), JSON.stringify(HEALTHY));
  }

  part("The pipeline's whole answer is not one reply per command");
  for (const [label, replies] of [["empty", []], ["two replies for one GET", [JSON.stringify(HEALTHY), null]], ["not a list", "OK"]] as const) {
    redis.clear();
    answeringAll(replies);
    const read = await outcome(() => readTests(SID, ["google"]));
    restore();
    is(`${label}: unknown, never none`, read, "unavailable");
  }

  is("no request left for a provider in any case", outbound, 0);
  done();
}

void main();
