/**
 * Claude 4 (cloud AE) on #3597 @497fcbb51a, LEVE 2: publishing a draft did not end its preview link, and the link
 * checks only that it exists. A creator who publishes and then unpublishes again had a link shared in the draft days
 * open the draft once more, for up to its seven days. Publishing now ends the draft's link first; when that cannot be
 * confirmed, nothing is published (503 "unavailable", the studio's existing word) and the link stays closed to nobody
 * new. Real product route; synthetic store; MemoryRedis.
 */
import { NextRequest } from "next/server";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as previewRoute } from "@/app/api/store/draft-preview/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { hasDraftPreview, makeDraftPreview, readDraftPreview } from "@/lib/draft-preview";
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

  // Codex G's MEDIUM (g-20261116-0851), renewed by Codex N1 (N1-20261116-1050) and Codex P (P-20261116-0920): a link
  // asked for while publication had ended the old one but not yet made the product public was made, and opened the
  // draft again after a later unpublish. Publication and the link now take the same per-product lock, and the link
  // reads the product again under it: one that waited behind publication is refused, and nothing opens later.
  part("A link asked for between the end of the old link and publication never opens the draft");
  const preview = async (id: string) => {
    const response = await previewRoute(new NextRequest("https://marktmorgen.com/api/store/draft-preview", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "make", id }) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; code?: string; error?: string } };
  };
  await makeDraftPreview(await store(), made.product.id);
  let raced: Promise<Awaited<ReturnType<typeof preview>>> | null = null;
  const plain = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await plain(commands);
    if (!raced && commands.some((c) => c[0] === "DEL" && String(c[1] ?? "").startsWith("nl:dpv:p:"))) {
      // The old link has just ended; publication has not answered yet. The studio asks for a new link now.
      raced = preview(made.product.id);
      await Promise.race([raced, new Promise((resolve) => setTimeout(resolve, 300))]);
    }
    return replies;
  }) as typeof redis.pipeline;
  let racedPublish: Awaited<ReturnType<typeof visibility>>;
  try {
    racedPublish = await visibility(made.product.id, false);
  } finally {
    redis.pipeline = plain;
  }
  const answer = await raced!;
  is("published while the link was asked for", [racedPublish.status, racedPublish.body.ok], [200, true]);
  is("the link asked for in between is refused: the product is no longer a draft", [answer.status, answer.body.error], [409, "not_draft"]);
  const racedHidden = await visibility(made.product.id, true);
  is("unpublished after the race", [racedHidden.status, racedHidden.body.ok], [200, true]);
  is("the draft has no link after the race", await hasDraftPreview(await store(), made.product.id), false);
  if (answer.body.code) is("the code made in between never opens the draft", await readDraftPreview(answer.body.code), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
