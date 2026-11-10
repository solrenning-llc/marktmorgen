/**
 * Reads that only feed what the studio shows, held to their exact shape (CX-123 rule 24, LEVE):
 *
 *   - the numbers a "By the numbers" block may show (lib/page-facts-read.ts): a read that did not come back
 *     is said as "could not be read just now", never as a store with no numbers, in the editor and in the
 *     page coach (lib/page-coach.ts); a store with no numbers, or one that does not show sales, reads as before;
 *   - the sales count kept for a store (lib/sold-count.ts, readSoldCounts): a reply in another shape is unknown,
 *     not "no count kept"; every caller still takes the unknown as nothing to say;
 *   - a saved section removed or written (lib/saved-block-store.ts) and an order put on the review list
 *     (lib/review-ask.ts): only the exact reply counts, never one that Number() turns into a 1.
 *
 * Synthetic store and products, the in-memory Redis stand-in; nothing real is read or sent.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, storeForEmail, updateLook } from "@/lib/store";
import { DEFAULT_LOOK } from "@/lib/store-look";
import type { Listing } from "@/lib/catalog";
import { readPageFacts } from "@/lib/page-facts-read";
import { readSoldCounts } from "@/lib/sold-count";
import { coachChecks } from "@/lib/page-coach";
import { emptyBlock, type PageBlock } from "@/lib/sales-page";
import { dropSection, writeSection } from "@/lib/saved-block-store";
import { scheduleReviewAsk } from "@/lib/review-ask";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipe = typeof redis.pipeline;
const real: Pipe = redis.pipeline;
/** Answers `reply` for every command that `match` picks, without running it, and runs the rest as they are. */
const answering = (match: (command: (string | number)[]) => boolean, reply: unknown): Pipe => async (commands) => {
  const out = await real(commands.filter((command) => !match(command)));
  return commands.map((command) => (match(command) ? reply : out.shift()));
};
const throwing = (match: (command: (string | number)[]) => boolean): Pipe => async (commands) => {
  if (commands.some(match)) throw new Error("synthetic: Redis did not answer");
  return real(commands);
};
const isSum = (c: (string | number)[]) => c[0] === "HGET" && String(c[1]).startsWith("nl:rev:sum:");
const isSold = (c: (string | number)[]) => c[0] === "GET" && String(c[1]).startsWith("nl:sold:");

const listing = (over: Partial<Listing>): Listing =>
  ({ id: "p1", title: "Field notes", priceCents: 2900, hidden: false, stock: null, recurring: null, call: null, pwyw: null, keys: null, options: [], file: null, link: "https://example.com", course: null, podcast: null, bundle: null, ...over }) as Listing;

async function main(): Promise<void> {
  redis.clear();
  const owner = "facts@example.com";
  await claimHandle(owner, "factshop", "Facts Shop", "");
  await ensureStatsId(owner);
  await updateLook(owner, { ...DEFAULT_LOOK, sold: true });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const product = listing({});

  part("A store with no numbers reads as before");
  is("nothing to say, nothing unread", await readPageFacts(store, product), { facts: {}, factsUnread: [] });

  part("A store with numbers reads as before");
  await real([
    ["HSET", `nl:rev:sum:${statsId}`, "p1", JSON.stringify({ count: 4, stars: 18, visible: 4, hidden: 0, refunded: 0, dist: [0, 0, 0, 2, 2] })],
    ["SET", `nl:sold:${statsId}`, JSON.stringify({ at: 1_800_000_000_000, p: { p1: 42 } })],
  ]);
  const healthy = await readPageFacts(store, product);
  is("rating and buyers, nothing unread", [Object.keys(healthy.facts ?? {}).sort(), healthy.factsUnread], [["buyers", "rating"], []]);
  is("the numbers themselves", [healthy.facts?.rating?.value, healthy.facts?.buyers?.value], ["4.5", "42"]);
  is("the sales count kept, in its shape", (await readSoldCounts(store))?.byProduct, { p1: 42 });

  part("A read that did not come back is unknown, not none");
  redis.pipeline = throwing(() => true);
  // A bundle whose items are kept apart from the store record, so reading them asks Redis.
  const kept = { ...store, catalog: { id: "cat1", items: ["b1", "p2", "p3"].map((id) => ({ id, kind: 0, options: [] })), head: [], inline: null } };
  const inBundle = listing({ id: "b1", bundle: ["p2", "p3"] });
  is("every number unread on a bundle", await readPageFacts(kept, inBundle), { facts: {}, factsUnread: ["rating", "buyers", "products"] });
  redis.pipeline = throwing(isSum);
  const noReviews = await readPageFacts(store, product);
  is("only the reviews unread; the sales count still said", [Object.keys(noReviews.facts ?? {}), noReviews.factsUnread], [["buyers"], ["rating"]]);

  part("A sales count kept in another shape is unknown");
  for (const [what, reply] of [
    ["a number", 42],
    ["a list", ["{}"]],
    ["an empty string", ""],
    ["not JSON", "{oops"],
    ["JSON without its time", JSON.stringify({ p: { p1: 42 } })],
  ] as const) {
    redis.pipeline = answering(isSold, reply);
    const thrown = await readSoldCounts(store).then(() => null, (error: unknown) => error);
    is(`${what}: refused as unknown`, thrown instanceof UnknownReplyError, true);
    is(`${what}: the numbers say it`, (await readPageFacts(store, product)).factsUnread, ["buyers"]);
  }
  redis.pipeline = answering(isSold, null);
  is("no count kept is still none", await readSoldCounts(store), null);
  redis.pipeline = real;

  part("The page coach says the numbers could not be read");
  const page = { blocks: [emptyBlock("hero")] as PageBlock[], seoDescription: "", test: null };
  const coach = (facts: Awaited<ReturnType<typeof readPageFacts>>) =>
    coachChecks({ page, productTitle: "Field notes", free: false, picture: false, pictureAlt: "", facts: facts.facts ?? {}, factsUnread: facts.factsUnread }).find((c) => c.id === "facts");
  is("no numbers, nothing unread: never asked for", coach({ facts: {}, factsUnread: [] }), undefined);
  is("numbers counted: asked for as before", coach(healthy)?.why, "Your store has counted numbers for this product. Shown big, they say in a second what a paragraph says in a minute.");
  const unread = coach({ facts: {}, factsUnread: ["rating", "buyers"] });
  is("unread: kept, and said so", [unread?.done, unread?.why], [false, "Some of your store's numbers for this product could not be read just now, so this check may be off. Reload the page to read them again."]);
  const withBlock = { ...page, blocks: [...page.blocks, { ...(emptyBlock("facts") as Extract<PageBlock, { kind: "facts" }>), show: ["rating"] }] as PageBlock[] };
  // Claude 5 on #3025: a number that could not be read is not a number shown, so the check stays open and says why.
  const onlyUnread = coachChecks({ page: withBlock, productTitle: "Field notes", free: false, picture: false, pictureAlt: "", facts: {}, factsUnread: ["rating"] }).find((c) => c.id === "facts");
  is(
    "a numbers block showing only an unread number is not called done, and says it may be off",
    [onlyUnread?.done, onlyUnread?.why],
    [false, "Some of your store's numbers for this product could not be read just now, so this check may be off. Reload the page to read them again."],
  );
  const bothShown = { ...withBlock, blocks: [...page.blocks, { ...(emptyBlock("facts") as Extract<PageBlock, { kind: "facts" }>), show: ["rating", "buyers"] }] as PageBlock[] };
  is(
    "a numbers block showing a counted number is done, though another is unread",
    coachChecks({ page: bothShown, productTitle: "Field notes", free: false, picture: false, pictureAlt: "", facts: healthy.facts?.buyers ? { buyers: healthy.facts.buyers } : {}, factsUnread: ["rating"] }).find((c) => c.id === "facts")?.done,
    true,
  );

  part("The editor and the review say it too");
  const editor = readFileSync("components/page-editor.tsx", "utf8");
  is("the field says it per number", editor.includes('factsUnread.includes(fact.key) ? "could not be read just now"'), true);
  is("the block's line counts them", editor.includes("could not be read just now`"), true);
  is("the studio passes both", readFileSync("app/studio/pages/page.tsx", "utf8").includes("{...(await readPageFacts(store, selected))}"), true);
  is("the coach in the editor gets them", readFileSync("components/page-coach.tsx", "utf8").includes("facts, factsUnread })"), true);
  is("the AI review gets them", readFileSync("app/api/store/ai/route.ts", "utf8").includes("factsUnread: facts.factsUnread"), true);

  part("A saved section's reply, exactly");
  redis.pipeline = answering((c) => c[0] === "HDEL", "1");
  is("removed answered as a string: unknown", await dropSection(statsId, "s1").then(() => null, (e: unknown) => e instanceof UnknownReplyError), true);
  redis.pipeline = answering((c) => c[0] === "HDEL", [1]);
  is("removed answered as a list: unknown", await dropSection(statsId, "s1").then(() => null, (e: unknown) => e instanceof UnknownReplyError), true);
  redis.pipeline = answering((c) => c[0] === "HDEL", 1);
  is("removed answered 1: removed", await dropSection(statsId, "s1"), true);
  redis.pipeline = answering((c) => c[0] === "HDEL", 0);
  is("removed answered 0: was not there", await dropSection(statsId, "s1"), false);
  const section = { id: "s1", name: "Questions", blocks: [], updatedAt: 1 };
  redis.pipeline = answering((c) => c[0] === "EVAL", [1]);
  is("written answered as a list: not called saved", await writeSection(statsId, section, true, 5).then((r) => r, () => "refused"), "refused");
  redis.pipeline = answering((c) => c[0] === "EVAL", "1");
  is("written answered as a string: not called saved", await writeSection(statsId, section, true, 5).then((r) => r, () => "refused"), "refused");
  // Claude 5 on #3025: the reply is read from its own slot once (repliesFor), so a getter is never a section kept.
  redis.pipeline = (async () => {
    const replies: unknown[] = [];
    Object.defineProperty(replies, 0, { get: () => 1, enumerable: true });
    return replies;
  }) as unknown as Pipe;
  is("written answered by a getter: not called saved", await writeSection(statsId, section, true, 5).then((r) => r, () => "refused"), "refused");
  redis.pipeline = (async () => [1, 1]) as unknown as Pipe;
  is("written answered twice: not called saved", await writeSection(statsId, section, true, 5).then((r) => r, () => "refused"), "refused");
  redis.pipeline = answering((c) => c[0] === "EVAL", 0);
  is("written answered 0: full, as before", await writeSection(statsId, section, true, 5), "full");
  redis.pipeline = answering((c) => c[0] === "EVAL", -2);
  is("written answered -2: gone, as before", await writeSection(statsId, section, false, 5), "gone");
  redis.pipeline = real;
  is("a real write still saves", await writeSection(statsId, section, true, 5), "ok");

  part("An order put on the review list, exactly");
  const asking = { statsId, handle: "factshop", reviewAsk: { ...store.reviewAsk, days: 7 } };
  redis.pipeline = answering((c) => c[0] === "ZADD", "1");
  is("added answered as a string: unknown", await scheduleReviewAsk(asking, "cs_test_a1b2c3d4e5f6", 1_800_000_000).then(() => null, (e: unknown) => e instanceof UnknownReplyError), true);
  redis.pipeline = real;
  is("a real add is an add", await scheduleReviewAsk(asking, "cs_test_a1b2c3d4e5f6", 1_800_000_000), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
