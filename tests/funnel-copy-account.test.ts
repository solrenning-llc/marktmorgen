/**
 * Copying a funnel into another store of the same account (app/api/store/
 * funnel-share, "copy-preview" and "copy"; lib/funnel-bundle.ts, mode
 * "account"; added 18 October 2026, ClickFunnels audit row F05), end to end
 * through the route against the in-memory Redis:
 *
 *   - only the account's owner may copy, only between its own stores: a
 *     teammate with every page and product permission, and a store of
 *     anyone else, are refused;
 *   - the preview writes nothing in either store and reports what the copy
 *     would need there and leave out;
 *   - the copy keeps the creator's own words (the about text, the videos,
 *     the deadline, what was said about them elsewhere), maps the funnel's
 *     products to the other store's, and arrives as a draft;
 *   - no product id, store id or payment id of the first store comes
 *     across (pictures never do: tests/funnel-share.test.ts);
 *   - it is counted as an export of the first store and an import of the
 *     other, so it is inside both plans' priced monthly figures.
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { readPage, writePage } from "@/lib/sales-page-store";
import { siteKey } from "@/lib/site-page-rules";
import { shareLimitsFor } from "@/lib/funnel-share-rules";
import { addProduct, claimHandle, createStore, ensureStatsId, setStripeAccount, storeForEmail, storeForId, storeRef } from "@/lib/store";
import { putMember } from "@/lib/team";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/funnel-share/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
// Each store's copies are counted in its calendar month, read again at each copy: a run crossing 00:00 UTC on a month's
// last day inside the loop below started a new month's count, and the copy past the limit went through. Only Date is
// stopped, for the whole run; timers and performance.now() run as usual.
mock.timers.enable({ apis: ["Date"], now: Date.now() });

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "owner@example.com";
  const MATE = "mate@example.com";
  const OTHER = "other@example.com";
  await claimHandle(OWNER, "firstshop", "First Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_fixture006", true);
  const second = await createStore(OWNER, "secondshop", "Second Shop", "");
  if (!second.ok) throw new Error("no second store");
  await ensureStatsId(storeRef(second.store));
  await claimHandle(OTHER, "othershop", "Other Shop", "");
  await ensureStatsId(OTHER);

  const firstGuide = await addProduct(OWNER, "First Guide", "", "0", null);
  const firstCourse = await addProduct(OWNER, "First Course", "", "49", null);
  const secondGuide = await addProduct(storeRef(second.store), "Second Guide", "", "0", null);
  const secondCourse = await addProduct(storeRef(second.store), "Second Course", "", "79", null);
  if (!firstGuide.ok || !firstCourse.ok || !secondGuide.ok || !secondCourse.ok) throw new Error("no products");

  let first = (await storeForEmail(OWNER))!;
  await putMember(first, MATE, "admin");
  const sessions: Record<string, string> = { [OWNER]: await openSession(OWNER), [MATE]: await openSession(MATE), [OTHER]: await openSession(OTHER) };
  const send = async (who: string, body: Record<string, unknown>, sid = first.sid) =>
    (await POST(new NextRequest("https://marktmorgen.com/api/store/funnel-share", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": sid, cookie: `${SESSION_COOKIE}=${sessions[who]}` }, body: JSON.stringify(body) }))).json();

  // The first store brings in a starter and makes it its own: an about text, a video, a deadline and things said about it elsewhere.
  const started = await send(OWNER, { action: "import", starter: "guide-signup", products: { x1: firstGuide.product.id, x2: firstCourse.product.id } });
  first = (await storeForEmail(OWNER))!;
  const funnel = (await readPageFunnels(first.statsId))[0];
  const landing = first.sitePages[0];
  const page = await readPage(first.statsId, siteKey(landing.id));
  await writePage(
    first.statsId!,
    siteKey(landing.id),
    {
      ...page,
      blocks: [
        ...page.blocks.map((b) => (b.kind === "bio" ? { ...b, body: "My own story, told once." } : b)),
        { id: "vd000001", kind: "video", heading: "A lesson to try", video: { provider: "youtube", id: "dQw4w9WgXcQ", hash: "" }, caption: "" },
        { id: "cd000001", kind: "countdown", heading: "Doors close", until: Math.floor(Date.now() / 1000) + 30 * 86_400, note: "" },
        { id: "qt000001", kind: "quotes", heading: "Said elsewhere", items: [{ text: "Clear and practical.", name: "A reader", url: "https://example.com/post/1" }] },
      ],
    },
    ROOM,
  );
  is("the first store has its funnel", [started.ok, Boolean(funnel)], [true, true]);

  part("Only the account's owner, only into its own stores");
  is("a teammate with every page and product permission is refused", (await send(MATE, { action: "copy-preview", funnel: funnel.id, to: second.store.sid })).error, "owner_only");
  const other = (await storeForEmail(OTHER))!;
  is("a store of anyone else is not a destination", (await send(OWNER, { action: "copy-preview", funnel: funnel.id, to: other.sid })).error, "not_yours");
  is("nor the store it is in", (await send(OWNER, { action: "copy-preview", funnel: funnel.id, to: first.sid })).error, "not_yours");
  is("nor something that is not a store id", (await send(OWNER, { action: "copy", funnel: funnel.id, to: "../x" })).error, "not_yours");

  part("The preview writes nothing, and says what the copy needs");
  const before = (await readPageFunnels((await storeForId(second.store.sid))!.statsId)).length;
  const preview = await send(OWNER, { action: "copy-preview", funnel: funnel.id, to: second.store.sid });
  const secondAfterPreview = (await storeForId(second.store.sid))!;
  is("it names both stores, and lists the other store's products to choose from", [preview.ok, preview.from, preview.to?.name, preview.products.map((p: { title: string }) => p.title).sort()], [true, "First Shop", "Second Shop", ["Second Course", "Second Guide"]]);
  is("nothing of the creator's own is left out between their own stores", preview.left, []);
  is("nothing is made there by a preview", [(await readPageFunnels(secondAfterPreview.statsId)).length, secondAfterPreview.sitePages.length], [before, 0]);
  is("the preview carries none of the first store's words", JSON.stringify(preview).includes("My own story"), false);

  part("The copy");
  const copied = await send(OWNER, { action: "copy", funnel: funnel.id, to: second.store.sid, products: { x1: secondGuide.product.id, x2: secondCourse.product.id }, name: "From the first shop" });
  const secondStore = (await storeForId(second.store.sid))!;
  const theirs = (await readPageFunnels(secondStore.statsId))[0];
  is("made there as a draft, walking that store's own products", [copied.ok, theirs?.name, theirs?.on, theirs?.steps.filter((s) => s.kind === "product").map((s) => s.id)], [true, "From the first shop", false, [secondGuide.product.id, secondCourse.product.id]]);
  const theirPage = await readPage(secondStore.statsId, siteKey(secondStore.sitePages[0].id));
  const bio = theirPage.blocks.find((b) => b.kind === "bio") as { body: string } | undefined;
  const video = theirPage.blocks.find((b) => b.kind === "video") as { video: { id: string } | null } | undefined;
  const countdown = theirPage.blocks.find((b) => b.kind === "countdown");
  const quotes = theirPage.blocks.find((b) => b.kind === "quotes") as { items: unknown[] } | undefined;
  is("the creator's own about text, video, deadline and quotes come across: both stores are theirs", [bio?.body, video?.video?.id, Boolean(countdown), quotes?.items.length], ["My own story, told once.", "dQw4w9WgXcQ", true, 1]);
  is("its pages are kept back from visitors and out of the menu", [theirPage.hidden, secondStore.sitePages.every((p) => !p.nav)], [true, true]);
  const written = JSON.stringify([theirPage, secondStore.sitePages, theirs]);
  is(
    "nothing names the first store, its products or its Stripe account",
    [first.statsId!, first.sid, firstGuide.product.id, firstCourse.product.id, "acct_fixture006"].filter((needle) => written.includes(needle)),
    [],
  );
  is("the first store is unchanged", (await readPageFunnels(first.statsId)).length, 1);

  part("Counted in both stores' priced monthly figures");
  const keys = redis.keys();
  is("an export of the first store and an import of the other", [keys.some((k) => k.includes(first.statsId!) && k.includes(":export:")), keys.some((k) => k.includes(secondStore.statsId!) && k.includes(":import:"))], [true, true]);
  const limit = shareLimitsFor(secondStore).importsPerMonth;
  let last: { ok?: boolean; error?: string } = {};
  for (let i = 0; i < limit + 1; i += 1) last = await send(OWNER, { action: "copy", funnel: funnel.id, to: second.store.sid, products: {} });
  is("past the other store's imports of the month, the copy is refused", last.error === "imports_full" || last.error === "exports_month", true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
