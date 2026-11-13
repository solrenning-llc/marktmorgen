/**
 * Synthetic only (Codex L, finding 2 on #3473, MEDIUM): a podcast product's removal reads the podcast's record again
 * under its lock before deleting it. When that read is not known (a reply in an unknown shape), the record (the only
 * thing naming the episodes' audio) must not be deleted on it: the removal answers 503 with nothing removed, and the
 * same removal asked again, with the read known, takes the product, the record and every episode's audio, including
 * an episode added after the first read.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { NextRequest } from "next/server";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setPodcastEpisodes, setProductPodcast, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { savePodcast, newPodcastId } from "@/lib/podcast";
import { deleted } from "./podcast-removed-blob-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "pod-removed-unknown-read@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "podunknownread", "Pod Unknown Read", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_PodUnknownRead1", true);
  await setSubscription(OWNER, { customerId: "cus_PodUnknownRead", subscriptionId: "sub_PodUnknownRead", active: true, tier: "creator", period: paidPeriod() });
  const folder = await storeFolder(OWNER);
  const made = await addProduct(OWNER, "Members Radio", "", "19");
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const podcastId = newPodcastId();
  if (!(await setProductPodcast(OWNER, id, { id: podcastId, episodes: 0 })).ok) throw new Error("not a podcast");
  const ep1 = `stores/${folder}/${id}/episode-one.mp3`;
  const ep2 = `stores/${folder}/${id}/episode-two.mp3`;
  const episode = (n: string, pathname: string, at: number) => ({ id: `aaaaaaaaaaa${n}`, title: n, notes: "", pathname, bytes: 1000, contentType: "audio/mpeg", at });
  await savePodcast({ id: podcastId, episodes: [episode("1", ep1, 1)] });
  await setPodcastEpisodes(OWNER, id, 1);

  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const remove = async () => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "remove", id }) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; cleanupPending?: boolean } };
  };
  const podKey = `nl:pod:${podcastId}`;
  const listed = async () => ((await storeForEmail(OWNER))!.catalog?.items ?? []).some((p: { id: string }) => p.id === id);

  part("The record's read under its lock answers in an unknown shape");
  // The first read of the record (before the removal) is known; every later one, until restored, is not. Meanwhile a
  // second episode is added, as the studio's podcast route would between the two reads.
  const real = redis.pipeline.bind(redis);
  let reads = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === podKey) {
      reads += 1;
      if (reads === 1) {
        const answer = await real(commands);
        await savePodcast({ id: podcastId, episodes: [episode("1", ep1, 1), episode("2", ep2, 2)] });
        return answer;
      }
      return [{ unknown: true }];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const first = await remove();
  redis.pipeline = real;
  is("[CORRETO] the record is kept", (await redis.pipeline([["GET", podKey]]))[0] !== null, true);
  is("[CORRETO] no episode's audio is deleted", [deleted.includes(ep1), deleted.includes(ep2)], [false, false]);
  is("[CORRETO] the removal does not answer finished", first.body.ok === true && !first.body.cleanupPending, false);

  part("Asked again with the read known");
  const second = await remove();
  is("the removal answers ok", second.body.ok, true);
  is("the product is gone", await listed(), false);
  is("the record is gone", (await redis.pipeline([["GET", podKey]]))[0], null);
  is("both episodes' audio are deleted, the one added between the reads too", [deleted.includes(ep1), deleted.includes(ep2)], [true, true]);
  done();
}

void main();
