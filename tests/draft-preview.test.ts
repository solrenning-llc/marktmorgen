/**
 * A private preview link for a draft product (754 [STN1], unit 4a).
 *
 * Whoever can edit the store's products makes a link for a draft; it opens for
 * 7 days, a new one replaces the one before, and revoking ends it at once.
 * Only the SHA-256 of the code is kept. A published product gets no link. A
 * read that fails never opens a preview (it throws; the page answers that it
 * could not check). Synthetic store and products, against the in-memory Redis.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setProductHidden, setSubscription, storeForEmail } from "@/lib/store";
import { readFileSync } from "node:fs";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { PREVIEW_CODE, PREVIEW_SECONDS, TAKEN_DOWN_SECONDS, clearTakenDown, isTakenDown, makeDraftPreview, markTakenDown, readDraftPreview, revokeDraftPreview } from "@/lib/draft-preview";
import { POST as previewRoute } from "@/app/api/store/draft-preview/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "previewer@example.com";
  await claimHandle(owner, "previewer", "Previewer", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_prev", subscriptionId: "sub_prev", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(owner);
  const send = async (body: Record<string, unknown>, cookie = `${SESSION_COOKIE}=${session}`) => {
    const response = await previewRoute(new NextRequest("https://marktmorgen.com/api/store/draft-preview", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; code?: string; expiresAt?: number } };
  };
  const draft = await addProduct(owner, "The Draft Guide", "Not out yet", "19", null);
  const live = await addProduct(owner, "The Live Guide", "Out now", "19", null);
  if (!draft.ok || !live.ok) throw new Error("no products");
  await setProductHidden(owner, draft.product.id, true);
  const store = (await storeForEmail(owner))!;
  const now = 1_800_000_000;

  part("The rules");
  is("seven days", PREVIEW_SECONDS, 7 * 86_400);
  is("a code is 22 url-safe characters", [PREVIEW_CODE.test("A".repeat(22)), PREVIEW_CODE.test("A".repeat(21)), PREVIEW_CODE.test("A".repeat(21) + "/")], [true, false, false]);

  part("Made, read, replaced, revoked");
  const first = await makeDraftPreview(store, draft.product.id, now);
  is("a code and when it ends", [PREVIEW_CODE.test(first.code), first.expiresAt], [true, now + PREVIEW_SECONDS]);
  const stored = redis.keys().map((key) => { try { return JSON.stringify(redis.run(["GET", key])); } catch { return ""; } });
  is("the code itself is never stored", redis.keys().some((key) => key.includes(first.code)) || stored.some((value) => value.includes(first.code)), false);
  is("it opens the draft", await readDraftPreview(first.code, now + 60), { statsId: store.statsId, productId: draft.product.id, expiresAt: now + PREVIEW_SECONDS });
  is("not after it ends", await readDraftPreview(first.code, now + PREVIEW_SECONDS), null);
  is("not with a code of the wrong shape, without a read", await readDraftPreview("../../etc", now), null);
  is("not with an unknown code", await readDraftPreview("B".repeat(22), now), null);
  const second = await makeDraftPreview(store, draft.product.id, now);
  is("a new link replaces the one before", [await readDraftPreview(first.code, now + 60), (await readDraftPreview(second.code, now + 60))?.productId], [null, draft.product.id]);
  await revokeDraftPreview(store, draft.product.id);
  is("revoked: it no longer opens", await readDraftPreview(second.code, now + 60), null);

  part("A read that fails never opens it");
  const third = await makeDraftPreview(store, draft.product.id, now);
  const realPipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async () => { throw new Error("Redis request failed with status 500"); }) as typeof redis.pipeline;
  let threw = false;
  try {
    await readDraftPreview(third.code, now + 60);
  } catch {
    threw = true;
  } finally {
    redis.pipeline = realPipeline;
  }
  is("it throws, never answers with a preview", threw, true);

  // Review of e42726e5 (Claude 6), LOW 1: a reply off its shape was read as "no link"; it is "could not check".
  part("A reply that cannot be read is not an answer");
  const fourth = await makeDraftPreview(store, draft.product.id, now);
  const throws = async (reply: unknown, run: () => Promise<unknown>) => {
    redis.pipeline = (async () => reply) as typeof redis.pipeline;
    try { await run(); return false; } catch { return true; } finally { redis.pipeline = realPipeline; }
  };
  is("reading a link: a missing reply throws", [await throws([], () => readDraftPreview(fourth.code, now + 60)), await throws([42], () => readDraftPreview(fourth.code, now + 60))], [true, true]);
  is("making a link: a write not answered OK throws", [await throws([null, 0, 0], () => makeDraftPreview(store, draft.product.id, now)), await throws([null, "OK", null], () => makeDraftPreview(store, draft.product.id, now))], [true, true]);
  is("revoking: a missing reply throws", await throws([], () => revokeDraftPreview(store, draft.product.id)), true);

  // Review of e42726e5 (Claude 6), MEDIUM 1: a product taken down after a notice stayed open through its link.
  part("A product taken down after a notice");
  const before = await makeDraftPreview(store, draft.product.id, now);
  await markTakenDown(store, draft.product.id);
  is("its link stops at once", await readDraftPreview(before.code, now + 60), null);
  is("it is marked, for a bounded time", [await isTakenDown(store, draft.product.id), TAKEN_DOWN_SECONDS], [true, 400 * 86_400]);
  const sneaky = await makeDraftPreview(store, draft.product.id, now);
  is("even a link made straight after never opens", await readDraftPreview(sneaky.code, now + 60), null);
  const refusedDown = await send({ action: "make", id: draft.product.id });
  is("the route makes no new link for it", [refusedDown.status, refusedDown.body.error], [409, "taken_down"]);
  is("publishing it again is what clears the mark", readFileSync("app/api/store/product/route.ts", "utf8").includes("clearTakenDown("), true);
  await clearTakenDown(store, draft.product.id);
  is("cleared: links work again", [await isTakenDown(store, draft.product.id), (await readDraftPreview((await makeDraftPreview(store, draft.product.id, now)).code, now + 60))?.productId], [false, draft.product.id]);
  is("a mark that cannot be read throws", await throws([], () => isTakenDown(store, draft.product.id)), true);
  const route = readFileSync("app/api/store/draft-preview/route.ts", "utf8");
  is("the route reads the product exactly: unknown is 503, not 404", [route.includes("readListingExactly("), route.includes('product === "unknown"')], [true, true]);

  part("The route");
  const made = await send({ action: "make", id: draft.product.id });
  is("made for a draft", [made.status, made.body.ok, PREVIEW_CODE.test(made.body.code ?? "")], [200, true, true]);
  const refused = await send({ action: "make", id: live.product.id });
  is("a published product gets no link", [refused.status, refused.body.error], [409, "not_draft"]);
  const unknown = await send({ action: "make", id: "nope" });
  is("an unknown product: not found", unknown.status, 404);
  const stranger = await send({ action: "make", id: draft.product.id }, "");
  is("signed out: refused", stranger.status >= 400 && stranger.status < 500, true);
  const gone = await send({ action: "revoke", id: draft.product.id });
  is("revoked by the route", [gone.status, gone.body.ok, await readDraftPreview(made.body.code ?? "", Math.floor(Date.now() / 1000))], [200, true, null]);
  const odd = await send({ action: "share", id: draft.product.id });
  is("anything else: refused", odd.status, 400);

  // Review of e42726e5 (Claude 6), MEDIUM 1 (store half): a store switched off makes no link.
  part("A store switched off after notices");
  await noteTakedown(owner, null, true);
  const off = await send({ action: "make", id: draft.product.id });
  is("no link is made", [off.status, off.body.error], [409, "suspended"]);

  done();
}

main();
