/**
 * A review link read in an unknown shape (rule 24): never "this link has
 * expired". The buyer was told their link ran out and to ask again, while
 * the link was only not readable just now. Unknown now answers "error":
 * the review page says something went wrong and nothing changed.
 * Synthetic only: the Redis stub.
 */
import { openDoor } from "@/lib/review-proof";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const store = { statsId: "0123456789abcdef0123456789abcdef", handle: "reviewlink", name: "Review Link" } as unknown as Store;
const token = "a".repeat(48);
const real = redis.pipeline.bind(redis);

async function outcome(reply: unknown[]): Promise<string> {
  redis.pipeline = (async (c: (string | number)[][]) => (c.length === 1 && c[0][0] === "GET" && String(c[0][1]).startsWith("nl:rev:link:") ? [...reply] : real(c))) as typeof redis.pipeline;
  try {
    return (await openDoor(store, { via: "ask", token })).state;
  } catch {
    return "rejected";
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  part("Unknown answers are never 'expired'");
  for (const [label, reply] of [["no reply", []], ["undefined", [undefined]], ["a number", [4]], ["an object", [{}]], ["two replies", [null, null]]] as const) {
    is(label, await outcome([...reply]), "error");
  }
  part("Control: a link Redis no longer holds has expired");
  is("null", (await openDoor(store, { via: "ask", token })).state, "expired");
  done();
}

void main();
