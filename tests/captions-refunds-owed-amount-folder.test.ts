/**
 * The owed AI-caption refunds of one store (autoRefundsOwed): an owed record whose amount cannot be right, or that is
 * listed under this store's folder but names another folder (or a path that does not read), is unknown, never "a
 * refund of $0.00" and never "nothing owed" (Codex g and Codex T MEDIUMs on #3881, re-proved by Claude 2 cloud H and
 * Claude 7 @1474dcddbf). A refund already given back (owed.cents 0) stays out, as on main.
 */
import { autoRefundsOwed } from "@/lib/auto-captions";
import { UnknownReplyError } from "@/lib/redis-reply";
import { streamPath } from "@/lib/stream-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "d".repeat(32);
const OTHER = "e".repeat(32);
const ID = "4b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const record = (cents: number, owedCents: number | null, folder = FOLDER, path?: string) =>
  JSON.stringify({ langs: ["en"], got: [], at: 1_000, cents, pi: "pi_Captions000010", path: path ?? streamPath(folder, "lesson000010", ID), owed: { cents: owedCents, key: `k-${ID}`, since: 1, looks: 0 } });
const put = (value: string) => {
  redis.clear();
  redis.run(["SADD", `nl:stream:autoowed:${FOLDER}`, ID]);
  redis.run(["SET", `nl:stream:auto:${ID}`, value, "EX", 3600]);
};
const read = async () => {
  try {
    return await autoRefundsOwed(FOLDER);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "other";
  }
};

async function main(): Promise<void> {
  part("the amount of an owed full refund");
  put(record(3500, null));
  is("control: a whole payment of $35.00 is owed as $35.00", await read(), [{ id: ID, cents: 3500, stuck: false }]);
  put(record(1200, 500));
  is("control: a part refund owes its own amount", await read(), [{ id: ID, cents: 500, stuck: false }]);
  put(record(3500, 0));
  is("control: a refund already given back (owed 0) is not owed", await read(), []);
  put(record(0, null));
  is("a full refund of a $0 payment is unknown, never \"a refund of $0.00\"", await read(), "unknown");
  put(record(-100, null));
  is("nor of a negative payment", await read(), "unknown");
  put(record(12.5, null));
  is("nor of a fractional one", await read(), "unknown");
  put(record(3500, -1));
  is("control: an owed part that does not read is a stuck full refund, as parsePending has it", await read(), [{ id: ID, cents: 3500, stuck: true }]);

  part("the folder the owed record belongs to");
  put(record(3500, null, OTHER));
  is("a record listed under this folder that names another one is unknown, never \"nothing owed\"", await read(), "unknown");
  put(record(3500, null, FOLDER, "not-a-stream-path"));
  is("nor one whose path does not read", await read(), "unknown");
  part("the refund must belong to the video the index names");
  const otherId = "6b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
  put(record(3500, null, FOLDER, streamPath(FOLDER, "lesson000010", otherId)));
  is("a record for another video in the same folder leaves the total unknown", await read(), "unknown");

  put(record(3500, null));
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === `nl:stream:autoowed:${FOLDER}`) return [[ID, ID]];
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    is("a duplicate member is unknown instead of counting the same debt twice", await read(), "unknown");
  } finally {
    redis.pipeline = real;
  }
  done();
}

void main();
