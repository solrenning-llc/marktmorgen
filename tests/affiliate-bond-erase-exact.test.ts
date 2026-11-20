/**
 * Erasing a person's affiliate bond reads the delete reply in its exact shape
 * (unknown is never zero). forgetBondPerson is one of the person erasers
 * (lib/person-erasure.ts, ERASERS): a reply that is missing, of another type
 * or not a whole count must throw UnknownReplyError, so the erasure reports
 * this part as not done and can be pressed again, never "nothing to delete"
 * while the buyer's bond may still be kept. Synthetic data only.
 */
import { forgetBondPerson } from "@/lib/affiliate-bond";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const original = redis.pipeline.bind(redis) as Pipeline;
const statsId = "bonderaseexact0000000000000001";

async function run(swap?: (real: unknown[]) => unknown): Promise<unknown> {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const real = await original(commands);
    return (swap ? swap(real) : real) as unknown[];
  };
  try {
    return await forgetBondPerson(statsId, "Buyer@Example.test");
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other error: ${String(error)}`;
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Healthy erasure is unchanged");
  redis.clear();
  is("no bond kept: an exact 0", await run(), 0);
  is("a kept bond: an exact 1", await run(() => [1]), 1);

  part("A delete reply in another shape is unknown, never nothing deleted");
  const replies: [string, (real: unknown[]) => unknown][] = [
    ["an empty envelope", () => []],
    ["a missing reply", () => [undefined]],
    ["a null reply", () => [null]],
    ["a text reply", () => ["x"]],
    ["a list reply", () => [[1]]],
    ["a negative count", () => [-1]],
    ["a fraction", () => [0.5]],
    ["a long envelope", () => [1, 1]],
    ["an envelope that is not a list", () => "OK"],
  ];
  for (const [what, swap] of replies) is(`${what} throws UnknownReplyError`, await run(swap), "unknown");
  done();
}

void main();
