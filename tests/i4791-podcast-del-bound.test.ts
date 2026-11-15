/**
 * Issue #4791 (erasure, MEDIUM; Codex, transcribed by Claude 2): the deletion of a person's private podcast feeds
 * (lib/podcast-access.ts, forgetPodcastPerson) took any whole number its one DEL answered as done, so a count above
 * the distinct keys it named was counted as a finished step. Now a count above them is unknown: the step throws and
 * the erasure stays pending. Counts from none to the keys named stay done. Synthetic data, in-memory Redis.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { feedToken, forgetPodcastPerson } from "@/lib/podcast-access";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
async function main(): Promise<void> {
  console.error = () => {};
  const OWNER = "podcast-count@example.test";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
  const original = redis.pipeline.bind(redis);
  const email = "ana@example.test";
  async function erasedWith(answer: (keys: number) => unknown): Promise<string> {
    redis.clear();
    await claimHandle(OWNER, "podcount", "Podcast Count", "");
    await ensureStoreId(OWNER); await ensureStatsId(OWNER); await ensureListId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_PodCount", subscriptionId: "sub_PodCount", active: true, tier: "pro", period: paidPeriod() });
    const made = await addProduct(OWNER, "Synthetic Radio", "", "19", null);
    if (!made.ok) throw new Error("no product");
    const shop = (await storeForEmail(OWNER))!;
    await feedToken(shop, made.product.id, email);
    redis.pipeline = (async (commands: Command[]) => {
      const answers = await original(commands);
      return commands.length === 1 && commands[0][0] === "DEL" ? [answer(commands[0].length - 1)] : answers;
    }) as typeof redis.pipeline;
    try {
      return `resolved ${await forgetPodcastPerson(shop, [made.product.id], email)}`;
    } catch (e) {
      return e instanceof Error ? e.name : "rejected";
    } finally {
      redis.pipeline = original;
    }
  }
  part("A DEL count above the keys it named is unknown (the issue's reproduction: three keys answering 4)");
  is("three keys answering 4", await erasedWith(() => 4), "UnknownReplyError");
  is("the keys named and one more", await erasedWith((keys) => keys + 1), "UnknownReplyError");
  part("Controls: none up to every key named is done");
  is("none", await erasedWith(() => 0), "resolved 0");
  is("every key named", await erasedWith((keys) => keys), "resolved 3");
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
