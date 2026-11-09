// Three screens read a Redis list and drew "nothing" when the reply was lost or
// came back in another shape (rule 24; VR item 2): the studio's list of
// questions the store assistant could not answer, the community search's
// posts, lessons, events and members, and a product's reviews. A reply that is
// not in its exact shape is unknown, never an empty list: each reader throws
// UnknownReplyError, and the screen says it could not read instead of drawing
// "nothing". Only an exact empty reply means none. Writes do not change.
// Synthetic Redis only (tests/redis-stub.ts).
import { readFileSync } from "node:fs";
import { assistantMissed } from "@/lib/store-assistant";
import { search, searchEverything } from "@/lib/community-search";
import { visibleReviews } from "@/lib/reviews";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import { speechFor } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

/** Answers the first pipeline whose first command is `name` on `key` with `reply`; every other call reaches the stand-in. */
function swap(name: string, key: string, reply: unknown): { hit: () => boolean } {
  let hit = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!hit && batch[0]?.[0] === name && batch[0]?.[1] === key) {
      hit = true;
      return reply as unknown[];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  return { hit: () => hit };
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error instanceof Error && error.name === "UnknownReplyError" ? "unknown" : `threw ${String(error)}`;
  } finally {
    redis.pipeline = original;
  }
}

const sparse = (n: number): unknown[] => {
  const list: unknown[] = [];
  list.length = n;
  return list;
};

const STATS = "e".repeat(32);
const PRODUCT = "prod0001";
const COMMUNITY = "c".repeat(32);
const POST_WORDS = `nl:cm:${COMMUNITY}:w:bread`;

const reviewId = (n: number) => n.toString(16).padStart(24, "0");
const reviewRow = (n: number) => JSON.stringify({ id: reviewId(n), productId: PRODUCT, rating: 5, text: `Review ${n}`, name: "Ana", createdAt: 1_700_000_000 + n });

function seedReviews(): void {
  redis.clear();
  for (const n of [1, 2]) {
    redis.run(["HSET", `nl:rev:${STATS}:${PRODUCT}`, reviewId(n), reviewRow(n)]);
    redis.run(["ZADD", `nl:rev:vis:${STATS}:${PRODUCT}`, 1_700_000_000 + n, reviewId(n)]);
  }
}

function seedSearch(): void {
  redis.clear();
  redis.run(["ZADD", POST_WORDS, 11, "p11"]);
  redis.run(["ZADD", POST_WORDS, 12, "p12"]);
  redis.run(["ZADD", `nl:cm:${COMMUNITY}:w:jam`, 12, "p12"]);
}

async function main(): Promise<void> {
  const store = { statsId: STATS } as Store;
  const missedKey = `nl:assist:missed:${STATS}`;

  part("The assistant's unanswered questions: an off-shape read is unknown, never an empty list");
  const missedReads: [string, unknown][] = [
    ["a text pipeline", "OK"],
    ["a short pipeline", []],
    ["an extra reply", [[], []]],
    ["a null list", [null]],
    ["a text list", ["nope"]],
    ["an object list", [{}]],
    ["a non-string row", [[JSON.stringify({ q: "Is it a PDF?", at: 1 }), 7]]],
    ["a hole in the list", [sparse(1)]],
  ];
  for (const [label, reply] of missedReads) {
    redis.clear();
    redis.run(["LPUSH", missedKey, JSON.stringify({ q: "Is it a PDF?", at: 1 })]);
    const read = swap("LRANGE", missedKey, reply);
    is(`${label} is unknown`, await outcome(() => assistantMissed(store)), "unknown");
    is(`${label} was the reply read`, read.hit(), true);
  }
  part("The assistant's unanswered questions: controls");
  redis.clear();
  is("an exact empty list is none", await outcome(() => assistantMissed(store)), []);
  redis.run(["LPUSH", missedKey, JSON.stringify({ q: "Is it a PDF?", at: 1 })]);
  is("a healthy list is read", await outcome(() => assistantMissed(store)), [{ question: "Is it a PDF?", at: 1 }]);

  part("The studio says the list could not be read, never that there is none");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  const editor = readFileSync("components/store-assistant-editor.tsx", "utf8");
  is("the studio page keeps a failed read as unknown", studio.includes("assistantMissed(own).catch(() => null)") && !studio.includes("assistantMissed(own).catch(() => [])"), true);
  is("the editor takes an unknown list", editor.includes("missed: { question: string; at: number }[] | null;"), true);
  is(
    "the editor says it in a live region",
    editor.includes('role="status">The questions the assistant could not answer could not be read just now. Try again in a moment.</p>'),
    true,
  );

  part("Community search: an off-shape page is unknown, never no match");
  const pageReads: [string, unknown][] = [
    ["a text pipeline", "OK"],
    ["a short pipeline", []],
    ["a null page", [null, 2]],
    ["a text page", ["nope", 2]],
    ["a non-string entry", [["p12", 12, "p11", "11"], 2]],
    ["an odd page", [["p12", "12", "p11"], 2]],
    ["a score that is not a number", [["p12", "twelve"], 2]],
    ["a hole in the page", [sparse(2), 2]],
    ["a count that is not a count", [["p12", "12", "p11", "11"], "2"]],
    ["a lost count", [["p12", "12", "p11", "11"], null]],
  ];
  for (const [label, reply] of pageReads) {
    seedSearch();
    const read = swap("ZREVRANGEBYSCORE", POST_WORDS, reply);
    is(`one word: ${label} is unknown`, await outcome(() => search(COMMUNITY, "bread")), "unknown");
    is(`one word: ${label} was the reply read`, read.hit(), true);
  }
  const workReads: [string, unknown][] = [
    ["a text pipeline", "OK"],
    ["a null page", [null]],
    ["a non-string entry", [["p12", 12]]],
    ["an odd page", [["p12"]]],
  ];
  for (const [label, reply] of workReads) {
    seedSearch();
    let hit = false;
    redis.pipeline = (async (batch: Command[]) => {
      if (!hit && batch[0]?.[0] === "ZREVRANGEBYSCORE") {
        hit = true;
        return reply as unknown[];
      }
      return original(batch);
    }) as typeof redis.pipeline;
    is(`several words: ${label} is unknown`, await outcome(() => search(COMMUNITY, "bread jam")), "unknown");
    is(`several words: ${label} was the reply read`, hit, true);
  }
  for (const [label, count] of [["a text count", "1"], ["a lost count", null], ["a negative count", -1]] as [string, unknown][]) {
    seedSearch();
    let hit = false;
    redis.pipeline = (async (batch: Command[]) => {
      if (!hit && batch[0]?.[0] === "ZINTERSTORE") {
        hit = true;
        return [count, 1];
      }
      return original(batch);
    }) as typeof redis.pipeline;
    is(`several words: ${label} of matches is unknown`, await outcome(() => search(COMMUNITY, "bread jam")), "unknown");
    is(`several words: ${label} was the reply read`, hit, true);
  }

  part("Community search: controls");
  redis.clear();
  is("an exact empty index finds nothing", await outcome(() => search(COMMUNITY, "bread")), { posts: [], next: null, used: ["bread"], total: 0 });
  seedSearch();
  is("a healthy index finds both, newest first", await outcome(() => search(COMMUNITY, "bread")), { posts: ["p12", "p11"], next: null, used: ["bread"], total: 2 });
  is("several words find the one holding both", await outcome(() => search(COMMUNITY, "bread jam")), { posts: ["p12"], next: null, used: ["bread", "jam"], total: 1 });

  part("Community search: a kind that could not be searched is unknown in the four at once, the others still found");
  seedSearch();
  swap("ZREVRANGEBYSCORE", POST_WORDS, "OK");
  const four = (await outcome(() => searchEverything(COMMUNITY, "bread"))) as Record<string, unknown>;
  is("the posts are unknown (null), not an empty page", four.post, null);
  is("the lessons are still searched", four.lesson, { posts: [], next: null, used: ["bread"], total: 0 });

  part("The search page says a kind could not be searched, never No match");
  const page = readFileSync("app/[handle]/community/search/page.tsx", "utf8");
  is("an indexed tab that could not be searched carries no number", page.includes("pages[t] === null ? null"), true);
  is("an indexed tab that could not be searched is said", page.includes('indexed(tab) && pages?.[tab] === null ? "index"'), true);
  is("a later page that could not be searched is said too", page.includes("search(id, asked, before, tab).catch((): null => null)"), true);
  const english = COMMUNITY_WORDS.en.searchUnread;
  is("the English words, plain", english("index"), "This part of the community could not be searched just now, so we cannot say whether it holds a match. Try again in a moment.");
  for (const [code, words] of Object.entries(COMMUNITY_WORDS)) {
    if (code === "en") continue;
    is(`${code}: its own words for an indexed tab`, [words.searchUnread("index") !== english("index"), words.searchUnread("index") !== words.searchUnread("room"), words.searchUnread("index") !== words.searchUnread("dm")], [true, true, true]);
  }

  part("A product's reviews: an off-shape read is unknown, never no reviews");
  const visible = `nl:rev:vis:${STATS}:${PRODUCT}`;
  const records = `nl:rev:${STATS}:${PRODUCT}`;
  const idReads: [string, unknown][] = [
    ["a text pipeline", "OK"],
    ["a short pipeline", []],
    ["a null list", [null]],
    ["a text list", ["nope"]],
    ["a non-string id", [[reviewId(2), 7]]],
    ["a hole in the list", [sparse(1)]],
  ];
  for (const [label, reply] of idReads) {
    seedReviews();
    const read = swap("ZREVRANGEBYSCORE", visible, reply);
    is(`the ids: ${label} is unknown`, await outcome(() => visibleReviews(STATS, PRODUCT)), "unknown");
    is(`the ids: ${label} was the reply read`, read.hit(), true);
  }
  const rowReads: [string, unknown][] = [
    ["a text pipeline", "OK"],
    ["a short pipeline", []],
    ["a null list", [null]],
    ["a short list", [[reviewRow(2)]]],
    ["a long list", [[reviewRow(2), reviewRow(1), reviewRow(1)]]],
    ["a row that is a number", [[reviewRow(2), 7]]],
    ["a hole in the list", [sparse(2)]],
  ];
  for (const [label, reply] of rowReads) {
    seedReviews();
    const read = swap("HMGET", records, reply);
    is(`the records: ${label} is unknown`, await outcome(() => visibleReviews(STATS, PRODUCT)), "unknown");
    is(`the records: ${label} was the reply read`, read.hit(), true);
  }

  part("A product's reviews: controls");
  redis.clear();
  is("no reviews is none", await outcome(() => visibleReviews(STATS, PRODUCT)), []);
  seedReviews();
  is("both reviews, newest first", ((await outcome(() => visibleReviews(STATS, PRODUCT))) as { id: string }[]).map((r) => r.id), [reviewId(2), reviewId(1)]);
  redis.run(["HDEL", records, reviewId(1)]);
  is("a record gone since (an exact nil) is left out", ((await outcome(() => visibleReviews(STATS, PRODUCT))) as { id: string }[]).map((r) => r.id), [reviewId(2)]);

  part("The pages say the reviews could not be read, never that there are none");
  const product = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  const reviewsPage = readFileSync("app/[handle]/p/[product]/reviews/page.tsx", "utf8");
  const list = readFileSync("components/review-list.tsx", "utf8");
  const studioPages = readFileSync("app/studio/pages/page.tsx", "utf8");
  const pageEditor = readFileSync("components/page-editor.tsx", "utf8");
  is("the product page keeps a failed read as unknown", product.includes("pickedFirst).catch((): null => null)") && !/visibleReviews\([^)]*\)\.catch\(\(\) => \[\]\)/.test(product), true);
  is("the reviews page keeps a failed read as unknown", reviewsPage.includes("REVIEWS_PER_PAGE).catch((): null => null)"), true);
  is("the section takes an unknown list", list.includes("reviews: Review[] | null;"), true);
  is("the section says it in a live region", list.includes('<p className="st-note mt-6 text-sm" role="status">{w.reviewsUnread}</p>'), true);
  is("the studio keeps a failed read as unknown", studioPages.includes("picked).catch((): null => null)") && !/visibleReviews\([^)]*\)\.catch\(\(\) => \[\]\)/.test(studioPages), true);
  is("the editor says the reviews to pick could not be read", pageEditor.includes("The reviews could not be read just now, so none can be picked. Try again in a moment."), true);
  const englishReviews = speechFor("en", "usd").w.reviewsUnread;
  is("the English words, plain", englishReviews, "The reviews could not be loaded just now. Try again in a moment.");
  for (const code of LANGUAGE_CODES) {
    if (code === "en") continue;
    const own = speechFor(code, "usd").w.reviewsUnread;
    is(`${code}: its own words`, typeof own === "string" && own.length > 0 && own !== englishReviews, true);
  }

  done();
}

void main();
