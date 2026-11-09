/**
 * Synthetic only (audit A1 of the podcast and download audit, 9 November 2026): removing a private podcast's product.
 *
 * The product route's removal (app/api/store/product/route.ts, action "remove") deletes the product's file, its
 * pictures, its page, its reviews and a course's lessons, and nothing of a podcast: the episodes' audio, the
 * podcast's record (nl:pod:<id>) and every listener's feed grant (nl:pod:by / nl:pod:t, which hold the buyer's
 * address) stay. A person's erasure (lib/person-erasure.ts) reads its products from the catalogue as it is now
 * (erasureScope: current.catalog.items), so forgetPodcastPerson never reaches the grant of a removed product, and
 * the copy of a person's data (feedsOf) never lists it either.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setPodcastEpisodes, setProductFile, setProductPodcast, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { savePodcast, newPodcastId } from "@/lib/podcast";
import { feedToken, feedsOf, forgetPodcastPerson, readFeedToken } from "@/lib/podcast-access";
import { erasureScope } from "@/lib/person-erasure";
import { deleted } from "./podcast-removed-blob-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "aud-podcast-removed@example.com";
const BUYER = "listener@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "audpodremoved", "Aud Pod Removed", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_AudPodRemoved1", true);
  await setSubscription(OWNER, { customerId: "cus_AudPodRemoved", subscriptionId: "sub_AudPodRemoved", active: true, tier: "creator", period: paidPeriod() });
  const folder = await storeFolder(OWNER);

  // The podcast: a product with two episodes, as the studio's podcast route writes them.
  const made = await addProduct(OWNER, "Members Radio", "", "19");
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const podcastId = newPodcastId();
  const enabled = await setProductPodcast(OWNER, id, { id: podcastId, episodes: 0 });
  if (!enabled.ok) throw new Error("not a podcast");
  const ep1 = `stores/${folder}/${id}/episode-one.mp3`;
  const ep2 = `stores/${folder}/${id}/episode-two.mp3`;
  await savePodcast({ id: podcastId, episodes: [
    { id: "aaaaaaaaaaa1", title: "One", notes: "", pathname: ep1, bytes: 90_000_000, contentType: "audio/mpeg", at: 1 },
    { id: "aaaaaaaaaaa2", title: "Two", notes: "", pathname: ep2, bytes: 90_000_000, contentType: "audio/mpeg", at: 2 },
  ] });
  await setPodcastEpisodes(OWNER, id, 2);

  // Control: an ordinary product with a file, removed the same way.
  const other = await addProduct(OWNER, "Workbook", "", "9");
  if (!other.ok) throw new Error("no control product");
  const pdf = `stores/${folder}/${other.product.id}/workbook.pdf`;
  const filed = await setProductFile(OWNER, other.product.id, { pathname: pdf, name: "workbook.pdf", bytes: 1000, contentType: "application/pdf", addedAt: new Date().toISOString() });
  if (!filed.ok) throw new Error(`control file not set: ${filed.reason}`);

  // A listener's feed, as the thanks page or "Email me my feed" makes it.
  const token = await feedToken((await storeForEmail(OWNER))!, id, BUYER);
  is("a listener's feed is made", typeof token === "string", true);

  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const remove = async (pid: string) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "remove", id: pid }) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };

  part("Control: an ordinary product's file goes with it");
  const c = await remove(other.product.id);
  is("control removal answers ok", c.body.ok, true);
  is("control: its file is deleted", deleted.includes(pdf), true);

  part("The podcast product removed from the studio");
  const r = await remove(id);
  is("removal answers ok", r.body.ok, true);
  is("[CORRETO] episode one's audio is deleted", deleted.includes(ep1), true);
  is("[CORRETO] episode two's audio is deleted", deleted.includes(ep2), true);
  is("[CORRETO] the podcast's record is gone", redis.keys().includes(`nl:pod:${podcastId}`), false);
  is("[CORRETO] no listener grant for the removed product is left", redis.keys().filter((k) => k.startsWith("nl:pod:t:") || k.startsWith("nl:pod:by:")).length, 0);
  // Changed with the fix (rule 23): the audit's proof read the grant as still there (its address readable, the defect's
  // state); the grant is now deleted with the product, so the old feed's token opens nothing.
  is("[CORRETO] the old feed's token opens nothing: its grant went with the product", await readFeedToken(token as string), null);

  part("The listener then asks the store to erase them (erasureScope + the podcast step, as erasePerson runs it)");
  const scope = await erasureScope((await storeForEmail(OWNER))!, BUYER);
  if (!scope) throw new Error("no scope");
  is("the erasure's products leave the removed one out", scope.productIds.includes(id), false);
  is("the copy of their data lists no feed (feedsOf)", await feedsOf(scope.store, scope.productIds, BUYER), []);
  await forgetPodcastPerson(scope.store, scope.productIds, BUYER);
  const left = redis.keys().filter((k) => k.startsWith("nl:pod:t:")).map((k) => redis.run(["GET", k]));
  is("[CORRETO] after the erasure no grant holds the address", left.filter((v) => typeof v === "string" && v.includes(BUYER)).length, 0);

  part("What the creator and the buyer are told (added with the fix)");
  const editor = readFileSync(join(process.cwd(), "components/product-editor.tsx"), "utf8");
  is("the studio says, before a podcast is removed, that its episodes and every buyer's feed go", editor.includes("Its podcast episodes are deleted too, and the private feed of every buyer stops working for good."), true);
  const words = readFileSync(join(process.cwd(), "lib/buyer-words/courses.ts"), "utf8");
  is("the buyer is no longer told the feed works for as long as they have the podcast", words.includes("for as long as you have the podcast"), false);
  done();
}

void main();
