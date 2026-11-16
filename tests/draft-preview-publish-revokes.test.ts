/**
 * Claude 4 (cloud AE) on #3597 @497fcbb51a, LEVE 2: publishing a draft did not end its preview link, and the link
 * checks only that it exists. A creator who publishes and then unpublishes again had a link shared in the draft days
 * open the draft once more, for up to its seven days. Publishing now ends the draft's link first; when that cannot be
 * confirmed, nothing is published (503 "unavailable", the studio's existing word) and the link stays closed to nobody
 * new. Real product route; synthetic store; MemoryRedis.
 */
import { NextRequest } from "next/server";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { makeDraftPreview, readDraftPreview } from "@/lib/draft-preview";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductHidden, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const owner = "publish-revokes@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(owner, "publishrevokes", "Publish Revokes", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_pubrev00001", subscriptionId: "sub_pubrev00001", active: true, period: paidPeriod() });
  const session = await openSession(owner);
  const visibility = async (id: string, hidden: boolean) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "visibility", id, hidden }) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const made = await addProduct(owner, "Planner", "A weekly planner", "9", null);
  if (!made.ok) throw new Error("setup");
  await setProductLink(owner, made.product.id, "https://example.com/planner");
  await setProductHidden(owner, made.product.id, true);
  const store = async () => (await storeForEmail(owner))!;

  part("Published, then a draft again: the link shared in its draft days stays closed");
  const shared = await makeDraftPreview(await store(), made.product.id);
  is("the link opens while it is a draft", (await readDraftPreview(shared.code))?.productId, made.product.id);
  const published = await visibility(made.product.id, false);
  is("published", [published.status, published.body.ok], [200, true]);
  is("publishing ends the draft's link", await readDraftPreview(shared.code), null);
  const hidden = await visibility(made.product.id, true);
  is("unpublished again", [hidden.status, hidden.body.ok], [200, true]);
  is("the old link never opens the draft again", await readDraftPreview(shared.code), null);

  part("A link that cannot be ended: nothing is published");
  const again = await makeDraftPreview(await store(), made.product.id);
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "DEL" && String(c[1] ?? "").startsWith("nl:dpv:p:"))) throw new Error("synthetic: the store did not answer");
    return real(commands);
  }) as typeof redis.pipeline;
  let refused: Awaited<ReturnType<typeof visibility>>;
  try {
    refused = await visibility(made.product.id, false);
  } finally {
    redis.pipeline = real;
  }
  is("refused as unavailable, to try again", [refused.status, refused.body.error], [503, "unavailable"]);
  is("still a draft", (await readListing(await store(), made.product.id))?.hidden, true);
  is("its link still belongs to the draft only", (await readDraftPreview(again.code))?.productId, made.product.id);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
