import { ordersGrant } from "@/lib/buyer-orders";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

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
