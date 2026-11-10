/**
 * Synthetic only (audit A1 of the podcast and download audit, 9 November 2026): what removing a private podcast's
 * product leaves, and what a person's erasure can still reach afterwards.
 *
 *   1. A listener's feed made before every feed was listed by its product (a grant no list leads to): removing the
 *      product cannot find it, so the person's erasure and the copy of their data must still reach it.
 *   2. The podcast's record read in an unknown shape: nothing is removed (503), so its audio is never left with no
 *      record naming it.
 *   3. A page of the product's listeners read in an unknown shape: nothing is removed (503).
 *   4. Each page of listeners is paid for in studio requests before it is read.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { NextRequest } from "next/server";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setPodcastEpisodes, setProductPodcast, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { newPodcastId, savePodcast } from "@/lib/podcast";
import { feedToken, feedsOf, forgetPodcastPerson } from "@/lib/podcast-access";
import { erasureScope } from "@/lib/person-erasure";
import { allowanceUsed } from "@/lib/store-allowance";
import { deleted } from "./podcast-removed-blob-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "podcast-removed-legacy@example.com";
const BUYER = "early-listener@example.com";
const original = redis.pipeline;

async function setUp(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "podremovedlegacy", "Pod Removed Legacy", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPodLeg0001", true);
  await setSubscription(OWNER, { customerId: "cus_PodRemovedLegacy", subscriptionId: "sub_PodRemovedLegacy", active: true, tier: "creator", period: paidPeriod() });
}

/** A podcast product with two episodes, made as the tests of the store make one. */
async function podcastProduct(title: string): Promise<{ id: string; podcastId: string; audio: string[] }> {
  const folder = await storeFolder(OWNER);
  const made = await addProduct(OWNER, title, "", "19");
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const podcastId = newPodcastId();
  const enabled = await setProductPodcast(OWNER, id, { id: podcastId, episodes: 0 });
  if (!enabled.ok) throw new Error("not a podcast");
  const audio = [`stores/${folder}/${id}/first.mp3`, `stores/${folder}/${id}/second.mp3`];
  await savePodcast({ id: podcastId, episodes: audio.map((pathname, n) => ({ id: `bbbbbbbbbbb${n}`, title: `Part ${n}`, notes: "", pathname, bytes: 1_000, contentType: "audio/mpeg", at: n + 1 })) });
  await setPodcastEpisodes(OWNER, id, 2);
  return { id, podcastId, audio };
}

async function remove(id: string): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "remove", id }) }));
  return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
}

const feedKeys = () => redis.keys().filter((k) => k.startsWith("nl:pod:t:") || k.startsWith("nl:pod:by:"));
const holdingAddress = (email: string) => redis.keys().filter((k) => k.startsWith("nl:pod:t:")).filter((k) => String(redis.run(["GET", k])).includes(email)).length;

async function main(): Promise<void> {
  part("1. A feed made before feeds were listed by product: the erasure still reaches it after the product goes");
  await setUp();
  const early = await podcastProduct("Early Radio");
  is("an early listener's feed is made", typeof (await feedToken((await storeForEmail(OWNER))!, early.id, BUYER)), "string");
  // A feed from before every feed was listed by its product: its grant is there and no list leads to it.
  for (const key of redis.keys().filter((k) => k.startsWith("nl:pod:ls:"))) redis.run(["DEL", key]);
  const gone = await remove(early.id);
  is("the removal answers ok", gone.body.ok, true);
  is("[CORRETO] its episodes' audio is deleted", early.audio.every((path) => deleted.includes(path)), true);
  is("[CORRETO] its record is gone", redis.keys().includes(`nl:pod:${early.podcastId}`), false);
  const scope = await erasureScope((await storeForEmail(OWNER))!, BUYER);
  if (!scope) throw new Error("no scope");
  is("[CORRETO] the copy of their data still lists the feed of the removed product (feedsOf)", await feedsOf(scope.store, scope.productIds, BUYER), [early.id]);
  await forgetPodcastPerson(scope.store, scope.productIds, BUYER);
  is("[CORRETO] after the erasure no grant holds the address", holdingAddress(BUYER), 0);
  is("[CORRETO] and no index of it is left", feedKeys().length, 0);

  part("2. The podcast's record read in an unknown shape: nothing is removed");
  await setUp();
  const bent = await podcastProduct("Bent Radio");
  let bentOnce = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!bentOnce && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:pod:${bent.podcastId}`) {
      bentOnce = true;
      return [7];
    }
    return original(commands);
  }) as typeof redis.pipeline;
  const before = deleted.length;
  let refused: Awaited<ReturnType<typeof remove>>;
  try {
    refused = await remove(bent.id);
  } finally {
    redis.pipeline = original;
  }
  is("[CORRETO] the removal answers 503", refused.status, 503);
  is("[CORRETO] the product is still in the store", (await readListing((await storeForEmail(OWNER))!, bent.id))?.id, bent.id);
  is("nothing was deleted from the file store", deleted.length, before);

  part("3. A page of the product's listeners read in an unknown shape: nothing is removed");
  await setUp();
  const scanned = await podcastProduct("Scanned Radio");
  is("a listener's feed is made", typeof (await feedToken((await storeForEmail(OWNER))!, scanned.id, BUYER)), "string");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SSCAN" && String(c[1]).startsWith("nl:pod:ls:"))) return [["0"]];
    return original(commands);
  }) as typeof redis.pipeline;
  const before3 = deleted.length;
  let refused3: Awaited<ReturnType<typeof remove>>;
  try {
    refused3 = await remove(scanned.id);
  } finally {
    redis.pipeline = original;
  }
  is("[CORRETO] the removal answers 503", refused3.status, 503);
  is("[CORRETO] the product is still in the store", (await readListing((await storeForEmail(OWNER))!, scanned.id))?.id, scanned.id);
  is("nothing was deleted from the file store", deleted.length, before3);
  is("the listener's grant is still there, so the feed still opens", holdingAddress(BUYER), 1);

  part("4. Each page of listeners is paid for in studio requests before it is read");
  await setUp();
  const plain = await addProduct(OWNER, "Plain Workbook", "", "9");
  if (!plain.ok) throw new Error("no plain product");
  const crowded = await podcastProduct("Crowded Radio");
  const owner = (await storeForEmail(OWNER))!;
  for (let n = 0; n < 150; n += 1) await feedToken(owner, crowded.id, `listener-${n}@example.com`);
  const used0 = await allowanceUsed((await storeForEmail(OWNER))!, "studio");
  is("a plain product is removed", (await remove(plain.product.id)).body.ok, true);
  const used1 = await allowanceUsed((await storeForEmail(OWNER))!, "studio");
  is("the podcast with 150 listeners is removed", (await remove(crowded.id)).body.ok, true);
  const used2 = await allowanceUsed((await storeForEmail(OWNER))!, "studio");
  is("[CORRETO] its listeners took at least three more studio requests than a plain removal (a page read, and 150 listeners at 100 a request)", used2 - used1 - (used1 - used0) >= 3, true);
  is("[CORRETO] no feed of the 150 is left", feedKeys().length, 0);
  done();
}

void main();
