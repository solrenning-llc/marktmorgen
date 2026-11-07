/**
 * The store's Path read in an unknown shape (rule 24): never read as "not
 * started". Read as none, the owner's Path data file was answered as
 * {path: null} (no data), the reminder said "not-started" and joining the
 * board "not_started". Unknown now throws; every caller already answers a
 * throw honestly (the data file and board routes 503, the studio pages'
 * "could not be read" state, the reminder "unavailable").
 * Synthetic only: the Redis stub.
 */
import { readPath } from "@/lib/path";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const store = { sid: "0123456789abcdef0123456789abcdef" };
const real = redis.pipeline.bind(redis);

async function outcome(reply: unknown[]): Promise<unknown> {
  redis.pipeline = (async () => [...reply]) as typeof redis.pipeline;
  try {
    return await readPath(store);
  } catch {
    return "rejected";
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  part("Unknown answers are never 'not started'");
  for (const [label, reply] of [["no reply", []], ["undefined", [undefined]], ["a number", [4]], ["an object", [{}]], ["two replies", [null, null]]] as const) {
    is(label, await outcome([...reply]), "rejected");
  }
  part("Control: no record at all is 'not started'");
  is("null", await readPath(store), null);
  done();
}

void main();
