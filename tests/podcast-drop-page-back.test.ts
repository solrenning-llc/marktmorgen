/**
 * Synthetic only (cloud J's review of #3473, MEDIUM): dropListeners takes a page of listeners off the list before it
 * reads and deletes their feeds. When the read of their indexes or the deletion fails after that, the removal answers
 * 503, but the page must still be listed, so the next try finds those feeds; taken off for good, a product listed from
 * the start (never noted in goneKey) leaves a grant holding the buyer's address that neither feedsOf nor the erasure
 * can reach.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { NextRequest } from "next/server";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setPodcastEpisodes, setProductPodcast, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { newPodcastId, savePodcast } from "@/lib/podcast";
import { feedToken, forgetPodcastPerson, markListedFromStart } from "@/lib/podcast-access";
import { erasureScope } from "@/lib/person-erasure";
import { deleted } from "./podcast-removed-blob-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "podcast-drop-page-back@example.com";
const BUYER = "early-listener@example.com";
const original = redis.pipeline;

async function setUp(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "poddroppageback", "Pod Drop Page Back", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPodBack001", true);
  await setSubscription(OWNER, { customerId: "cus_PodDropPageBack", subscriptionId: "sub_PodDropPageBack", active: true, tier: "creator", period: paidPeriod() });
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

/** Fails, once, the first command that `match` picks after the page was taken off the list: thrown or an unknown reply. */
async function failingOnce<T>(match: (c: (string | number)[]) => boolean, how: "throw" | "unknown", run: () => Promise<T>): Promise<T> {
  let armed = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (armed && commands.some(match)) {
      armed = false;
      if (how === "throw") throw new Error("Redis request failed with status 503");
      return [{ error: "unknown" }];
    }
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  const cases: [string, (c: (string | number)[]) => boolean, "throw" | "unknown"][] = [
    ["the read of the listeners' indexes fails", (c) => c[0] === "MGET" && String(c[1]).startsWith("nl:pod:by:"), "throw"],
    ["the deletion of the listeners' feeds answers in an unknown shape", (c) => c[0] === "DEL" && c.slice(1).some((k) => String(k).startsWith("nl:pod:by:")), "unknown"],
  ];
  for (const [name, match, how] of cases) {
    part(`A product listed from the start: ${name} after the page was taken off the list`);
    await setUp();
    const radio = await podcastProduct("Listed Radio");
    is("its feeds are listed from the start", await markListedFromStart((await storeForEmail(OWNER))!, radio.id), true);
    is("a listener's feed is made", typeof (await feedToken((await storeForEmail(OWNER))!, radio.id, BUYER)), "string");
    const first = await failingOnce(match, how, () => remove(radio.id));
    is("the first removal answers 503", first.status, 503);
    is("[CORRETO] the listener is still listed, so the next try finds the feed", redis.keys().filter((k) => k.startsWith("nl:pod:ls:")).some((k) => (redis.run(["SMEMBERS", k]) as string[]).some((member) => member !== "+")), true);
    const second = await remove(radio.id);
    is("the second removal answers ok", [second.status, second.body.ok], [200, true]);
    is("[CORRETO] no grant holds the address after it", holdingAddress(BUYER), 0);
    is("[CORRETO] and no index of it is left", feedKeys().length, 0);
    const scope = await erasureScope((await storeForEmail(OWNER))!, BUYER);
    if (!scope) throw new Error("no scope");
    await forgetPodcastPerson(scope.store, scope.productIds, BUYER);
    is("[CORRETO] nor after the person's erasure", holdingAddress(BUYER), 0);
    is("the episodes' audio is deleted once the removal finished", radio.audio.every((path) => deleted.includes(path)), true);
  }
  done();
}

void main();
