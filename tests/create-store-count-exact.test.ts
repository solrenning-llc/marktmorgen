/**
 * An account may make at most MAX_STORES_PER_ACCOUNT stores
 * (lib/store.ts, createStore): each store brings its own free allowances,
 * paid for by the company, so the ceiling is a cost ceiling. The count is
 * taken after the new id is added. Before, a count Redis answered in another
 * shape read as NaN, the comparison was false and the store was made past the
 * ceiling. It is now read exactly: anything else takes the new id back out
 * and throws, so no store is made on an unknown count. Synthetic data only.
 */
import { MAX_STORES_PER_ACCOUNT, claimHandle, createStore, storeForEmail } from "@/lib/store";
import { createHash } from "node:crypto";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const original = redis.pipeline.bind(redis) as Pipeline;
let swap: ((real: unknown[]) => unknown) | null = null;
(redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
  const real = await original(commands);
  return (swap && commands.some(([name]) => name === "SCARD") && commands.some(([name]) => name === "SADD") ? swap(real) : real) as unknown[];
};

async function make(owner: string, handle: string, shape?: (real: unknown[]) => unknown): Promise<unknown> {
  swap = shape ?? null;
  try {
    const made = await createStore(owner, handle, "Another", "");
    return made.ok ? "made" : made.reason;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other error: ${String(error)}`;
  } finally {
    swap = null;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "storecount@example.com";
  await claimHandle(owner, "storecountmain", "Main", "");
  if (!(await storeForEmail(owner))) throw new Error("setup");

  part("A count in its shape decides as before");
  is("a second store is made", await make(owner, "storecounttwo"), "made");

  part("A count in another shape is unknown: no store is made");
  const shapes: [string, (real: unknown[]) => unknown][] = [
    ["a text count", (real) => [real[0], "2"]],
    ["a missing count", (real) => [real[0]]],
    ["a negative count", (real) => [real[0], -1]],
    ["a list count", (real) => [real[0], [2]]],
    ["an envelope that is not a list", () => "OK"],
  ];
  const account = `nl:account:stores:${createHash("sha256").update(`nimbus-account-stores:${owner}`).digest("hex").slice(0, 40)}`;
  const counted = async () => (await original([["SCARD", account]]))[0];
  const before = await counted();
  for (const [what, shape] of shapes) {
    is(`${what}: unknown, no store`, await make(owner, `storecount${what.replace(/\W/g, "").slice(0, 12)}`, shape), "unknown");
  }

  is("the account counts no store more than before", await counted(), before);

  part("The ceiling still holds");
  let last: unknown = "made";
  for (let i = 0; i < MAX_STORES_PER_ACCOUNT + 2 && last === "made"; i += 1) last = await make(owner, `storecountmore${i}`);
  is("past the ceiling: too many", last, "too_many");
  done();
}

void main();
