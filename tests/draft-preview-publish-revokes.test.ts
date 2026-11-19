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

  // Claude 4's LOW on #3597 @312543e765 (7022345363): a publish slowed past PREVIEW_LOCK_SECONDS loses the lock, so a
  // link asked for then is taken under the lock legitimately, still sees a draft and is made. Publication now ends the
  // draft's link once more after the product is public, before it lets go of the lock, so that link never opens later.
  part("A link made after a slow publish lost its lock is ended by the publish");
  const slow = await makeDraftPreview(await store(), made.product.id);
  const statsId = (await store()).statsId!;
  let late: Awaited<ReturnType<typeof preview>> | null = null;
  let held = false;
  const steady = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await steady(commands);
    if (!held && commands.some((c) => c[0] === "DEL" && String(c[1] ?? "").startsWith("nl:dpv:p:"))) {
      held = true;
      // The publish has ended the old link and is held past the lock's life: its lock runs out, as Redis would let it.
      await steady([["DEL", `nl:dpv:lock:${statsId}:${made.product.id}`]]);
      // The studio asks for a link now: it takes the lock, still sees a draft and is answered with a new link.
      late = await preview(made.product.id);
    }
    return replies;
  }) as typeof redis.pipeline;
  let slowPublish: Awaited<ReturnType<typeof visibility>>;
  try {
    slowPublish = await visibility(made.product.id, false);
  } finally {
    redis.pipeline = steady;
  }
  const lateAnswer = late as Awaited<ReturnType<typeof preview>> | null;
  is("published after the slow step", [slowPublish.status, slowPublish.body.ok], [200, true]);
  is("the old link is ended", await readDraftPreview(slow.code), null);
  is("a link was made while the lock had run out", [lateAnswer?.status, typeof lateAnswer?.body.code], [200, "string"]);
  is("the publish ends the link made in that window", lateAnswer?.body.code ? await readDraftPreview(lateAnswer.body.code) : "no code", null);
  const slowHidden = await visibility(made.product.id, true);
  is("unpublished after the slow publish", [slowHidden.status, slowHidden.body.ok], [200, true]);
  is("the draft has no link after the slow publish", await hasDraftPreview(await store(), made.product.id), false);
  if (lateAnswer?.body.code) is("the link made in that window never opens the draft again", await readDraftPreview(lateAnswer.body.code), null);
  const after = await preview(made.product.id);
  is("a new link for the draft can be made again", [after.status, typeof after.body.code], [200, "string"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
