import { addProduct, claimHandle, ensureStatsId, setProductPodcast, setPodcastEpisodes, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { feedToken, readFeedToken } from "@/lib/podcast-access";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_probe_only_a_stand_in";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const show = await addProduct("owner@example.com", "Sourdough Radio", "", "19", null);
  if (!show.ok) throw new Error("no product");
  await setProductPodcast("owner@example.com", show.product.id, { id: "a".repeat(32), episodes: 0 });
  await setPodcastEpisodes("owner@example.com", show.product.id, 1);
  const store = (await storeForEmail("owner@example.com"))!;

  part("The grant's write fails after the address's token was kept");
  const real = redis.pipeline.bind(redis);
  let fail = true;
  (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => {
    if (fail && JSON.stringify(commands).includes("nl:pod:t:")) { fail = false; throw new Error("synthetic: connection lost"); }
    return real(commands);
  };
  const first = await feedToken(store, show.product.id, "dana@example.com").catch((e: Error) => `threw: ${e.message}`);
  console.log("first call:", first);
  const second = await feedToken(store, show.product.id, "dana@example.com");
  console.log("second call token:", second);
  is("the token now given opens a feed", Boolean(second && (await readFeedToken(second))), true);
  done();
}
main();
