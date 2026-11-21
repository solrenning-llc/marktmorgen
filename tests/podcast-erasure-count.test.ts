// #4791 (Codex V, erasure, MEDIUM): forgetPodcastPerson sends one DEL for a person's feed indexes, idempotency keys
// and held grants, and must take its reply only as a count it could have produced: a whole number from 0 to the number
// of distinct keys in that command. Anything else is unknown evidence, so the step throws and the erasure stays not
// finished (rule 24). Synthetic data, in-memory Redis.
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { feedToken, forgetPodcastPerson } from "@/lib/podcast-access";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

const OWNER = "podcast-count@example.test";
const LISTENER = "ana@example.test";

async function freshStore(): Promise<{ shop: Store; id: string }> {
  redis.clear();
  await claimHandle(OWNER, "podcount", "Podcast Count", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PodCount", subscriptionId: "sub_PodCount", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Synthetic Radio", "", "19", null);
  if (!made.ok) throw new Error("no product");
  const shop = (await storeForEmail(OWNER))!;
  await feedToken(shop, made.product.id, LISTENER);
  return { shop, id: made.product.id };
}

/** Runs the erasure with the DEL's reply replaced by `answer` (or left alone when undefined); says what it did. */
async function eraseAnswering(answer: unknown): Promise<{ outcome: string; keys: number; gone: number | null }> {
  const { shop, id } = await freshStore();
  const original = redis.pipeline.bind(redis);
  let keys = 0;
  redis.pipeline = (async (commands: Command[]) => {
    const answers = await original(commands);
    if (commands.length === 1 && commands[0][0] === "DEL") {
      keys = new Set(commands[0].slice(1)).size;
      if (answer !== undefined) return [answer];
    }
    return answers;
  }) as typeof redis.pipeline;
  let outcome = "resolved";
  let gone: number | null = null;
  try {
    gone = await forgetPodcastPerson(shop, [id], LISTENER);
  } catch (e) {
    outcome = e instanceof Error ? e.name : "rejected";
  }
  redis.pipeline = original;
  return { outcome, keys, gone };
}

async function main(): Promise<void> {
  console.error = () => {};
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

  part("A count no DEL of these keys could give is refused (the issue's case)");
  const four = await eraseAnswering(4);
  is("the DEL names three distinct keys", four.keys, 3);
  is("4 deleted out of 3 keys throws UnknownReplyError", four.outcome, "UnknownReplyError");
  const far = await eraseAnswering(1_000);
  is("1,000 deleted out of 3 keys throws UnknownReplyError", far.outcome, "UnknownReplyError");

  part("Every count a DEL of these keys could give stays valid");
  const real = await eraseAnswering(undefined);
  is("the real deletion resolves", real.outcome, "resolved");
  is("and returns a count from 1 to the number of keys", real.gone !== null && real.gone >= 1 && real.gone <= real.keys, true);
  const all = await eraseAnswering(3);
  is("3 out of 3 resolves", all.outcome, "resolved");
  is("and returns 3", all.gone, 3);
  const none = await eraseAnswering(0);
  is("0 out of 3 (already gone) resolves", none.outcome, "resolved");
  is("and returns 0", none.gone, 0);

  part("Replies that are not a count stay unknown");
  for (const [name, answer] of [["a negative", -1], ["a fraction", 1.5], ["a string", "2"], ["null", null]] as const) {
    const odd = await eraseAnswering(answer);
    is(`${name} throws UnknownReplyError`, odd.outcome, "UnknownReplyError");
  }

  done();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
