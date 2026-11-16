/**
 * Codex S's return review on #2672 (comment 6671401686): a Redis reply is
 * read only from its own data slots, and nothing of the reply is run to read
 * it. A Proxy is refused before any reflection, so none of its traps runs;
 * an inherited member or a getter is refused without running it. Plain and
 * frozen replies in the exact shape still pass.
 *
 * The cases are Codex S's proofs, kept with their assertions:
 * tests/s2672-orders-proxy.proof.ts (blob 260c6b68) and
 * tests/s2672-string-list-return.proof.ts (blob 6dd43857), on branch
 * codex/s-review-2672-orders-return at 7c71c6c25. Synthetic only: the Redis
 * stand-in answers the one grant GET, and fetch is refused.
 */
import { ordersGrant } from "@/lib/buyer-orders";
import { repliesFor, stringList } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** A Proxy that counts every trap it runs, over a valid target. */
function counted<T extends object>(target: T) {
  const runs = { get: 0, descriptors: 0, other: 0, then: 0 };
  const proxy = new Proxy(target, {
    get(t, field, receiver) {
      // An async transport resolving a Promise probes `then`; that is the
      // transport's probe, not the consumer reading the reply.
      if (field === "then") { runs.then += 1; return undefined; }
      runs.get += 1;
      return Reflect.get(t, field, receiver);
    },
    getOwnPropertyDescriptor(t, field) { runs.descriptors += 1; return Reflect.getOwnPropertyDescriptor(t, field); },
    has(t, field) { runs.other += 1; return Reflect.has(t, field); },
    ownKeys(t) { runs.other += 1; return Reflect.ownKeys(t); },
    getPrototypeOf(t) { runs.other += 1; return Reflect.getPrototypeOf(t); },
  });
  return { proxy, runs };
}

part("stringList reads only own data slots (S proof, blob 6dd43857)");
{
  is("confirmed plain strings", stringList(["a", "b"]), ["a", "b"]);
  is("confirmed empty list", stringList([]), []);
  is("confirmed frozen list", stringList(Object.freeze(["a"])), ["a"]);
  is("a plain hole is refused", stringList([, "b"]), null);

  const inherited = [, "b"];
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, "0", { value: "inherited" });
  Object.setPrototypeOf(inherited, prototype);
  is("a string inherited into a hole is not a confirmed member", stringList(inherited) === null, true);

  let reads = 0;
  const accessor = ["a"];
  Object.defineProperty(accessor, "0", { get() { reads += 1; return "a"; } });
  const result = stringList(accessor);
  is("an accessor is refused without executing it", [result === null, reads], [true, 0]);

  const { proxy, runs } = counted(["a", "b"]);
  is("a Proxy around valid strings is refused", stringList(proxy), null);
  is("stringList runs no trap of that Proxy", runs, { get: 0, descriptors: 0, other: 0, then: 0 });

  const revocable = Proxy.revocable(["a"], {});
  revocable.revoke();
  is("a revoked Proxy is refused, not thrown on", stringList(revocable.proxy), null);

  const source = ["a"];
  const copy = stringList(source);
  source[0] = "changed";
  is("the answer is a fresh list, not the reply itself", copy, ["a"]);
  is("a non-string member is still refused", stringList(["a", 1]), null);
}

part("repliesFor refuses a Proxy before any reflection");
{
  const { proxy, runs } = counted(["OK", 1]);
  is("a Proxy around a valid two-reply pipeline is refused", repliesFor(proxy, 2), null);
  is("repliesFor runs no trap of that Proxy", runs, { get: 0, descriptors: 0, other: 0, then: 0 });
  is("a plain pipeline reply still passes", repliesFor(["OK", 1], 2), ["OK", 1]);
  is("a frozen pipeline reply still passes", repliesFor(Object.freeze(["OK", 1]), 2), ["OK", 1]);
  is("a wrong count is still refused", repliesFor(["OK"], 2), null);
  is("a hole is still refused", repliesFor([, 1], 2), null);
}

part("ordersGrant does not run a Proxy reply (S proof, blob 260c6b68)");
const owner = { stripeAccountId: "acct_SProof" } as Store;
const token = "b".repeat(64);
const address = "buyer@example.com";
const raw = JSON.stringify({ a: owner.stripeAccountId, e: address });
let reply: unknown[] = [raw];
let commands = 0;
redis.pipeline = async batch => {
  if (batch.length !== 1 || batch[0][0] !== "GET") throw new Error("Only the grant GET is allowed");
  commands++;
  return reply;
};
globalThis.fetch = async () => { throw new Error("No provider or complete orders journey is exercised"); };

async function main() {
  is("confirmed grant retains its address", await ordersGrant(owner, token), address);
  is("the confirmed grant uses only one GET", commands, 1);
  let descriptors = 0;
  let consumerGets = 0;
  let transportThen = 0;
  reply = new Proxy([raw], {
    get(target, field, receiver) {
      // The async transport resolves its Promise before ordersGrant receives
      // the reply. Its then probe is counted separately, not called consumer IO.
      if (field === "then") { transportThen++; return undefined; }
      consumerGets++;
      return Reflect.get(target, field, receiver);
    },
    getOwnPropertyDescriptor(target, field) {
      descriptors++;
      return Reflect.getOwnPropertyDescriptor(target, field);
    },
  });
  is("an executable reply does not authorize an address", await ordersGrant(owner, token), null);
  is("the consumer executes no reply traps", [consumerGets, descriptors], [0, 0]);
  is("transport Promise probing is explicitly accounted for", transportThen, 1);
  reply = Object.freeze([raw]) as unknown as unknown[];
  is("confirmed frozen grant remains valid", await ordersGrant(owner, token), address);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
