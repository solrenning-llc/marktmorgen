/**
 * Audit R51, finding 2 (synthetic): "What buyers say" on the store page (lib/store-quotes.ts) is kept on the store's
 * record and kept again by refreshStoreQuotes after a review changes. A review the creator hides, the buyer deletes or
 * the buyer's refund takes off its page must also leave those quotes, even when the one read refreshStoreQuotes makes
 * does not answer.
 *
 * What fails here:
 *   - a refresh whose read does not answer leaves the quotes as they were (words that may be off the page now);
 *   - no way to take one review's words off the record before the change is answered done (dropReviewQuote), or one
 *     that answers done on a record it could not read or write, or writes anything when nothing of it is quoted;
 *   - the studio's hide, or the buyer's delete or refund, answering done before those words are taken off.
 * Controls: a healthy refresh keeps the same quotes, in the same order, as before.
 */
import { readFileSync } from "node:fs";
import { type Store, addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { markOneRefunded, saveReview, setHidden } from "@/lib/reviews";
import * as storeQuotes from "@/lib/store-quotes";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Drop = (store: Store, review: { productId: string; createdAt: number }) => Promise<void>;
const dropReviewQuote = (storeQuotes as unknown as { dropReviewQuote?: Drop }).dropReviewQuote;
const { refreshStoreQuotes } = storeQuotes;

type Command = (string | number)[];
const STORE_KEY = "nl:store:owner:";
const real = redis.pipeline.bind(redis);
let mode: "" | "failList" | "unknownStore" | "failStoreWrite" = "";
let writes = 0;
redis.pipeline = (async (commands: Command[]) => {
  if (commands.some(([name, ...args]) => name !== "GET" && name !== "GETRANGE" && args.some((arg) => String(arg).startsWith(STORE_KEY)))) writes += 1;
  if (mode === "failList" && commands.some(([name, key]) => name === "ZREVRANGEBYSCORE" && String(key).startsWith("nl:rev:all:"))) {
    mode = "";
    throw new Error("Redis request failed with status 503 (synthetic)");
  }
  if (mode === "failStoreWrite" && commands.some(([name, ...args]) => name !== "GET" && name !== "GETRANGE" && args.some((arg) => String(arg).startsWith(STORE_KEY)))) {
    throw new Error("Redis request failed with status 503 (synthetic)");
  }
  const replies = await real(commands);
  if (mode === "unknownStore") {
    const at = commands.findIndex(([name, key]) => name === "GET" && String(key).startsWith(STORE_KEY));
    if (at >= 0) {
      mode = "";
      return replies.map((reply, i) => (i === at ? 7 : reply));
    }
  }
  return replies;
}) as typeof redis.pipeline;

const DAY = 86_400_000;
const PHONE = "Call me on 555 0100 any time, the book is great.";

async function world(owner: string, handle: string) {
  redis.clear();
  mode = "";
  await claimHandle(owner, handle, "R51 Quotes", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  const a = await addProduct(owner, "Bread Book", "", "19", null);
  const b = await addProduct(owner, "Cake Course", "", "49", null);
  if (!a.ok || !b.ok) throw new Error("no products");
  const base = Date.now() - 20 * DAY;
  const review = async (n: number, productId: string, text: string) => {
    const saved = await saveReview(statsId, { productId, email: `r51q${n}@example.test`, reference: `cs_test_R51Q${n}`, pi: `pi_R51Q${n}`, rating: 5, text, name: `Reader ${n}` }, ROOM, base + n * DAY);
    if (saved.state !== "created") throw new Error(`review ${n}: ${saved.state}`);
    return saved.review;
  };
  const r1 = await review(1, a.product.id, "The rye loaf alone was worth every cent of it.");
  const r2 = await review(2, b.product.id, PHONE);
  const r3 = await review(3, a.product.id, "My family asks for the seeded loaf every single week now.");
  await refreshStoreQuotes((await storeForEmail(owner))!);
  return { statsId, a: a.product.id, b: b.product.id, r1, r2, r3, base };
}

const quoted = async (owner: string) => (await storeForEmail(owner))!.quotes.map((q) => [q.n, q.t, q.ti]);
const hasPhone = async (owner: string) => (await storeForEmail(owner))!.quotes.some((q) => q.t.includes("555 0100"));

async function main(): Promise<void> {
  part("Control: a healthy refresh keeps the same quotes, in the same order");
  {
    const owner = "r51q-ok@example.com";
    const w = await world(owner, "r51qok");
    is("three quoted, newest first", await quoted(owner), [
      ["Reader 3", "My family asks for the seeded loaf every single week now.", "Bread Book"],
      ["Reader 2", PHONE, "Cake Course"],
      ["Reader 1", "The rye loaf alone was worth every cent of it.", "Bread Book"],
    ]);
    await setHidden(w.statsId, w.b, w.r2.id, true, "private");
    await refreshStoreQuotes((await storeForEmail(owner))!);
    is("hidden: the other two stay, in order", await quoted(owner), [
      ["Reader 3", "My family asks for the seeded loaf every single week now.", "Bread Book"],
      ["Reader 1", "The rye loaf alone was worth every cent of it.", "Bread Book"],
    ]);
  }

  part("A refresh whose read does not answer never leaves the words as they were");
  {
    const owner = "r51q-hide@example.com";
    const w = await world(owner, "r51qhide");
    await setHidden(w.statsId, w.b, w.r2.id, true, "private");
    mode = "failList";
    await refreshStoreQuotes((await storeForEmail(owner))!);
    is("the failing read was met", mode, "");
    is("hidden, refresh not read: the hidden words are not on the record", await hasPhone(owner), false);
    await refreshStoreQuotes((await storeForEmail(owner))!);
    is("the next healthy refresh keeps the right two again", (await quoted(owner)).map(([n]) => n), ["Reader 3", "Reader 1"]);
  }
  {
    const owner = "r51q-refund@example.com";
    const w = await world(owner, "r51qrefund");
    await markOneRefunded(w.statsId, w.b, w.r2.id);
    mode = "failList";
    await refreshStoreQuotes((await storeForEmail(owner))!);
    is("refunded, refresh not read: its words are not on the record", await hasPhone(owner), false);
  }

  part("dropReviewQuote: one review's words off the record, exactly, before the change is answered");
  is("dropReviewQuote is there", typeof dropReviewQuote, "function");
  if (dropReviewQuote) {
    {
      const owner = "r51q-drop@example.com";
      const w = await world(owner, "r51qdrop");
      const hidden = await setHidden(w.statsId, w.b, w.r2.id, true, "private");
      if (typeof hidden !== "object" || !hidden) throw new Error("not hidden");
      await dropReviewQuote((await storeForEmail(owner))!, hidden);
      is("its words are off; the others stay, in order", await quoted(owner), [
        ["Reader 3", "My family asks for the seeded loaf every single week now.", "Bread Book"],
        ["Reader 1", "The rye loaf alone was worth every cent of it.", "Bread Book"],
      ]);
      await refreshStoreQuotes((await storeForEmail(owner))!);
      is("and the refresh after it ends where the healthy path ends", (await quoted(owner)).map(([n]) => n), ["Reader 3", "Reader 1"]);
    }
    {
      const owner = "r51q-edit@example.com";
      const w = await world(owner, "r51qedit");
      // The buyer changed the words since the last keep, which was not kept again: the old words are still quoted.
      const edited = await saveReview(w.statsId, { productId: w.b, email: "r51q2@example.test", reference: "cs_test_R51Q2", pi: "pi_R51Q2", rating: 4, text: "Changed my words, with enough of them to show.", name: "Reader 2" }, ROOM, w.base + 4 * DAY);
      if (edited.state !== "updated") throw new Error(`edit: ${edited.state}`);
      const hidden = await setHidden(w.statsId, w.b, w.r2.id, true, "private");
      if (typeof hidden !== "object" || !hidden) throw new Error("not hidden");
      await dropReviewQuote((await storeForEmail(owner))!, hidden);
      is("an earlier version of its words goes too", await hasPhone(owner), false);
    }
    {
      const owner = "r51q-none@example.com";
      const w = await world(owner, "r51qnone");
      const snapshot = (await storeForEmail(owner))!;
      const later = { productId: w.b, createdAt: w.base + 10 * DAY };
      writes = 0;
      await dropReviewQuote(snapshot, later);
      // Read under the store's lock all the same (tests/r51-quotes-erasure-stale.test.ts): the request's own copy of
      // the store is not the record as it is now.
      is("nothing of it quoted: nothing written", writes, 0);
    }
    {
      const owner = "r51q-unknown@example.com";
      const w = await world(owner, "r51qunknown");
      const snapshot = (await storeForEmail(owner))!;
      mode = "unknownStore";
      const outcome = await dropReviewQuote(snapshot, w.r2).then(() => "done", () => "threw");
      is("the store's record read in another shape: it throws", [outcome, mode], ["threw", ""]);
      is("and the record is not written", await hasPhone(owner), true);
    }
    {
      const owner = "r51q-write@example.com";
      const w = await world(owner, "r51qwrite");
      const snapshot = (await storeForEmail(owner))!;
      mode = "failStoreWrite";
      const outcome = await dropReviewQuote(snapshot, w.r2).then(() => "done", () => "threw");
      mode = "";
      is("the write fails: it throws", outcome, "threw");
    }
  }

  part("The routes take the words off before they answer done");
  {
    const studio = readFileSync("app/api/store/reviews/route.ts", "utf8");
    const tail = studio.slice(studio.indexOf('if (done === "missing")'));
    const drop = tail.indexOf("await dropReviewQuote(store, done)");
    is("the studio's hide: dropped before ok", drop >= 0 && drop < tail.indexOf("return Response.json({ ok: true })"), true);
    const buyer = readFileSync("app/api/store/review/route.ts", "utf8");
    const del = buyer.slice(buyer.indexOf('if (action === "delete")'), buyer.indexOf("if (proof.refunded)"));
    const delDrop = del.indexOf("await dropReviewQuote(store, before)");
    is("the buyer's delete: dropped before the review is deleted", delDrop >= 0 && delDrop < del.indexOf("deleteReview("), true);
    const refund = buyer.slice(buyer.indexOf("if (proof.refunded)"), buyer.indexOf('return answer("refunded")'));
    const refundDrop = refund.indexOf("await dropReviewQuote(store, before)");
    is("the buyer's refund: dropped before it is marked", refundDrop >= 0 && refundDrop < refund.indexOf("markOneRefunded("), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
