/** A store's unknown pre-sale state must not delay another store's release. */
import { runPreorderReleases, soonState } from "@/lib/preorders";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const pipeline = redis.pipeline.bind(redis);
const stores = ["a", "b"].map((letter) => ({
  statsId: letter.repeat(32), handle: `release${letter}`, sid: `release${letter}`,
  stripeAccountId: "acct_test_release", email: `${letter}@example.test`,
} as Store));
const product = { id: "releaseitem", title: "Release item" } as Listing;
const members = stores.map((store) => `${store.statsId}|${product.id}|${store.handle}`);
globalThis.fetch = async () => { throw new Error("No external network in this regression"); };

async function main() {
  for (const [label, membersReply, daysReply] of [
    ["odd days", [product.id], [product.id]],
    ["object days", [product.id], {}],
    ["non-text days", [product.id], [product.id, 7]],
    ["mixed members", [product.id, null], []],
  ] as const) {
    redis.pipeline = async () => [membersReply, daysReply];
    const reading = await soonState(stores[0]).catch(() => null);
    is(`${label}: a known coming-soon product is not removed from the storefront/cart decision`, reading?.soon.has(product.id), true);
  }
  redis.pipeline = pipeline;
  redis.clear();
  await pipeline([["SADD", "nl:pre:jobs", ...members]]);
  // The first store's job has a paid pre-order waiting, so its coming-soon state is what decides it (#2963 lets a job
  // with nothing left to hand over go on that confirmed reading alone, before any coming-soon read).
  await pipeline([["HSET", `nl:pre:${stores[0].statsId}:${product.id}`, "cs_test_releasewaiting0001", JSON.stringify({ to: "buyer@example.test", at: 1, pi: "" })]]);
  let commands = 0;
  let healthyRead = false;
  redis.pipeline = async (batch: (string | number)[][]) => {
    commands += batch.length;
    if (commands > 100) throw new Error("Synthetic command ceiling exceeded");
    if (batch[0]?.[0] === "SISMEMBER" && batch[0]?.[1] === `nl:wl:${stores[0].statsId}:soon`) return [0, false];
    if (batch[0]?.[0] === "HGETALL" && batch[0]?.[1] === `nl:pre:${stores[1].statsId}:${product.id}`) healthyRead = true;
    return pipeline(batch);
  };
  let outcome: number | string;
  try {
    outcome = await runPreorderReleases(
      async (handle) => stores.find((store) => store.handle === handle) ?? null,
      async () => product,
      () => ({ base: "https://example.test", from: "Test <test@example.test>", ordersLink: async () => "https://example.test/orders", recordStart: async () => {} }),
      Date.now() + 5_000,
    ).catch(() => "threw");
  } finally { redis.pipeline = pipeline; }
  is("one unreadable member does not reject the whole release job", outcome, 0);
  is("the following healthy store is read in the same pass", healthyRead, true);
  const [remaining] = await pipeline([["SMEMBERS", "nl:pre:jobs"]]);
  is("the unknown member stays queued and only the healthy empty release is removed", remaining, [members[0]]);
  is("the synthetic exercise stays inside its predeclared command ceiling", commands <= 100, true);
  done();
}
void main().catch((error) => { console.error(error); process.exitCode = 2; });
