/**
 * The copy of a person's data never leaves out a license key or a pre-order it could not read (nuvem I privacy
 * audit of main @3cdc624a7d, 13 November 2026; CX-123 rule 24).
 *
 * lib/person-copy.ts says a record that cannot be read fails the copy, never goes missing from it. keysOf
 * (lib/licence-keys.ts) and preordersOf (lib/preorders.ts) read a reply that is not a list as no records at all,
 * and passed over an entry they could not parse, which may be the person's own: the copy then said it was whole
 * with their key or pre-order left out. Now each reply is read exactly and an entry that cannot be read throws.
 */
import { keysOf } from "@/lib/licence-keys";
import { preordersOf } from "@/lib/preorders";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sid = "0123456789abcdef0123456789abcdef";
const shop = { statsId: sid } as Store;
const person = "copy-person@example.test";
const other = "copy-other@example.test";
const keysKey = `nl:keys:${sid}:prod000001:info`;
const preKey = `nl:pre:${sid}:prod000001`;

async function threw(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "no";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}

async function garbled<T>(key: string, run: () => Promise<T>): Promise<string> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "HGETALL" && c[1] === key) ? commands.map(() => ({ shape: "unknown" })) : original(commands));
  try { return await threw(run); } finally { redis.pipeline = original; }
}

async function main(): Promise<void> {
  part("License keys in the copy: read exactly");
  redis.clear();
  redis.run(["HSET", keysKey, "KEY-MINE", JSON.stringify({ r: "cs_test_mine", e: person, at: 1 }), "KEY-THEIRS", JSON.stringify({ r: "cs_test_theirs", e: other, at: 2 })]);
  const mine = await keysOf(shop, ["prod000001"], person);
  is("the person's key only, never another buyer's", mine.map((k) => k.key), ["KEY-MINE"]);
  is("a reply that is not a list is unknown, never no keys", await garbled(keysKey, () => keysOf(shop, ["prod000001"], person)), "unknown");
  redis.run(["HSET", keysKey, "KEY-BROKEN", "{not json"]);
  is("an entry that cannot be read fails the copy, never goes missing from it", await threw(() => keysOf(shop, ["prod000001"], person)), "unknown");

  part("Pre-orders in the copy: read exactly");
  redis.clear();
  redis.run(["HSET", preKey, "cs_test_mine", JSON.stringify({ to: person, at: 1, pi: "pi_mine" }), "cs_test_theirs", JSON.stringify({ to: other, at: 2, pi: "pi_theirs" })]);
  const pre = await preordersOf(shop, ["prod000001"], person);
  is("the person's pre-order only", pre.map((p) => p.checkout), ["cs_test_mine"]);
  is("a reply that is not a list is unknown, never no pre-orders", await garbled(preKey, () => preordersOf(shop, ["prod000001"], person)), "unknown");
  redis.run(["HSET", preKey, "cs_test_broken", "{not json"]);
  is("an entry that cannot be read fails the copy, never goes missing from it", await threw(() => preordersOf(shop, ["prod000001"], person)), "unknown");
  done();
}

void main();
