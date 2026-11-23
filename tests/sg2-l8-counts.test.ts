/**
 * Counts read only in their exact shape: lesson video, a closing's told list
 * and reviews (audit SG2 L8, CX-123 rule 24).
 *
 * Each of these read a Redis reply with Number() or `|| 0`, which turns
 * null, text and garbage into 0, and so let a malformed reply count as fact:
 *
 *   - watchedIn (lib/watch.ts) read an unknown month of video as 0 seconds,
 *     and swallowed a Redis error into 0 too. It now throws, and the hourly
 *     job's per-store loop skips that store this round.
 *   - measure (lib/watch.ts) read a video's last total that was not a whole
 *     number as 0, and so counted the whole video again. Now a reply out of
 *     shape meters nothing this round (null, read again soon), and one
 *     malformed entry in a well-formed reply is resynced without counting
 *     it; never counted from 0.
 *   - measureDue (lib/watch.ts) read an unknown "last opened" as never, and
 *     took the store out of line. Unknown now keeps it in line.
 *   - toldOf (lib/closing-buyers.ts) read garbage on the told list as "told,
 *     not yet": a certain line in a person's copy of their data. It now
 *     throws, which fails the whole copy, as any read that fails does.
 *   - tellBuyers read a told list it could not read as "nobody told yet"
 *     and wrote to them all again; tellRefundShort read garbage as "told"
 *     (paid for) and the rest as not. Both now stop this round before any
 *     credit is taken or any email goes.
 *   - saveReview (lib/reviews.ts) read an unknown count of a product's
 *     reviews as 0, and let a review past the ceiling. It now refuses.
 *
 * The exact replies keep working as before.
 */
import { startClosingCredit } from "@/lib/closing-credit";
import { workKey } from "@/lib/closing-holds";
import { tellBuyers, tellRefundShort, toldOf } from "@/lib/closing-buyers";
import { saveReview } from "@/lib/reviews";
import { MAX_REVIEWS_PER_PRODUCT } from "@/lib/review-summary";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { measure, measureDue, watchedIn } from "@/lib/watch";
import { MEASURE_EVERY_MS } from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
/** The reply a matching pipeline gets instead of the real one; "throw" for a Redis that cannot be asked. */
let rule: Rule | null = null;
/** Every pipeline sent, so a test can see what was (not) written or taken. */
const sent: (string | number)[][][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(commands);
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const first = (name: string, prefix: string) => (commands: (string | number)[][]) =>
  commands[0]?.[0] === name && String(commands[0]?.[1]).startsWith(prefix);

/** "rejected" when the promise rejects, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "rejected"> {
  try {
    return await run();
  } catch {
    return "rejected";
  }
}

/** Whether any pipeline sent since `from` holds a command named `name` on a key starting with `prefix`. */
const sentSince = (from: number, name: string, prefix: string) =>
  sent.slice(from).some((commands) => commands.some((c) => c[0] === name && String(c[1]).startsWith(prefix)));

/** One GET or HGET slot that is not a counter's or a timestamp's exact text: each is unknown. */
const BAD_TEXT: [string, unknown][] = [
  ["text that is not a number", "lots"],
  ["a negative number", "-5"],
  ["a fraction", "1.5"],
  ["a number with a space", " 5"],
  ["true", true],
  ["a fractional number", 1.5],
  ["a negative number (not text)", -5],
  ["an object", { result: "5" }],
  ["a list", ["5"]],
];
/** A one-command pipeline's replies for a GET or HGET that must never be read as a count. */
const BAD_GETS: [string, unknown][] = [
  ...BAD_TEXT.map(([label, slot]) => [label, [slot]] as [string, unknown]),
  ["an empty reply", []],
  ["a second, unasked-for reply", ["5", "5"]],
  ["a reply that is not a list", { result: "5" }],
  ["a Redis that cannot be asked", "throw"],
];

// ------------------------------------------------------- the video service

const LIBRARY = "4242";
const API_KEY = "a-stand-in-library-key-for-tests-only";
const COLLECTION = "00000000-0000-4000-8000-00000000c011";
const VIDEO = "00000000-0000-4000-8000-0000000000a1";
/** What the video service says the one video has been watched, in all. */
let watchedTotal = 150;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin === STREAM_API_ORIGIN && url.pathname === `/library/${LIBRARY}/videos` && (init?.method ?? "GET") === "GET") {
    const items = url.searchParams.get("collection") === COLLECTION ? [{ guid: VIDEO, collectionId: COLLECTION, totalWatchTime: watchedTotal }] : [];
    return json({ totalItems: items.length, currentPage: 1, itemsPerPage: 1000, items });
  }
  return json({}, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = API_KEY;
  process.env.BUNNY_STREAM_TOKEN_KEY = "a-stand-in-token-key-for-tests-only";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";

  // ------------------------------------------------------------ watchedIn
  part("watchedIn: an unknown month of video is never 0 seconds");
  const watchFolder = "0123456789abcdef0123456789abcdef";
  for (const [label, reply] of BAD_GETS) {
    rule = { when: first("GET", "nl:watch:sec:"), reply };
    is(`watchedIn, ${label}: refused as unknown, never 0`, await outcome(() => watchedIn(watchFolder, "2026-11")), "rejected");
  }
  rule = { when: first("GET", "nl:watch:sec:"), reply: [null] };
  is("watchedIn: no key (nothing watched yet this month) is 0", await watchedIn(watchFolder, "2026-11"), 0);
  rule = { when: first("GET", "nl:watch:sec:"), reply: ["4200"] };
  is("watchedIn: a count is read", await watchedIn(watchFolder, "2026-11"), 4200);
  rule = { when: first("GET", "nl:watch:sec:"), reply: [4200] };
  is("watchedIn: a count decoded as a number is read", await watchedIn(watchFolder, "2026-11"), 4200);
  rule = null;

  // -------------------------------------------------------------- measure
  part("measure: a video's last total that cannot be read is never counted from 0");
  const folder = "fedcba9876543210fedcba9876543210";
  await redis.pipeline([["SET", `nl:stream:col:${folder}`, COLLECTION]]);
  await redis.pipeline([["HSET", `nl:watch:last:${folder}`, VIDEO, "100"]]);
  watchedTotal = 150;
  // An entry that is text but not a whole number sits in a well-formed reply:
  // it alone is resynced (tests/sg2-l8-watch-resync.test.ts), never counted
  // from 0. Any other slot makes the reply itself out of shape.
  const RESYNCED = BAD_TEXT.filter(([, slot]) => typeof slot === "string");
  for (const [label, slot] of RESYNCED) {
    await redis.pipeline([["HSET", `nl:watch:last:${folder}`, VIDEO, "100"]]);
    rule = { when: first("HGETALL", "nl:watch:last:"), reply: [[VIDEO, slot]] };
    const from = sent.length;
    is(`measure, a last total that is ${label}: nothing counted for that video this round`, await measure(folder), 0);
    is(`measure, a last total that is ${label}: nothing added to the month`, sentSince(from, "INCRBY", "nl:watch:sec:"), false);
    is(`measure, a last total that is ${label}: resynced to the video's current total`, sent.slice(from).some((commands) => commands.some((c) => c[0] === "HSET" && String(c[1]).startsWith("nl:watch:last:") && c[2] === VIDEO && c[3] === 150)), true);
  }
  rule = null;
  await redis.pipeline([["HSET", `nl:watch:last:${folder}`, VIDEO, "100"]]);
  const BAD_LAST: [string, unknown][] = [
    ...BAD_TEXT.filter(([, slot]) => typeof slot !== "string").map(([label, slot]) => [`a last total that is ${label}`, [[VIDEO, slot]]] as [string, unknown]),
    ["a last total that is null", [[VIDEO, null]]],
    ["a list of odd length (a field with no value)", [[VIDEO]]],
    ["a field that is not text", [[5, "100"]]],
    ["a reply that is not a list", [null]],
    ["a reply that is an object", [{ [VIDEO]: "100" }]],
    ["an empty pipeline reply", []],
    ["a second, unasked-for reply", [[VIDEO, "100"], []]],
    ["a Redis that cannot be asked", "throw"],
  ];
  for (const [label, reply] of BAD_LAST) {
    rule = { when: first("HGETALL", "nl:watch:last:"), reply };
    const from = sent.length;
    const got = await outcome(() => measure(folder));
    is(`measure, ${label}: not metered this round`, got === null || got === "rejected", true);
    is(`measure, ${label}: nothing added to the month`, sentSince(from, "INCRBY", "nl:watch:sec:"), false);
    is(`measure, ${label}: the last totals are not rewritten`, sentSince(from, "HSET", "nl:watch:last:") || sentSince(from, "HDEL", "nl:watch:last:"), false);
  }
  rule = null;
  is("measure: the exact reply adds only what the video grew by", await measure(folder), 50);
  is("measure: and the same total again adds nothing", await measure(folder), 0);
  rule = { when: first("HGETALL", "nl:watch:last:"), reply: [[]] };
  is("measure: a store never read before (no totals yet) counts all of its video", await measure(folder), 150);
  rule = null;

  // ----------------------------------------------------------- measureDue
  part("measureDue: an unknown last opening keeps the store in line, never takes it out");
  const DUE = "nl:watch:due";
  for (const [label, reply] of BAD_GETS) {
    await redis.pipeline([["ZADD", DUE, 0, folder]]);
    // Rule 23 (9 November 2026): the opened mark is read with the count of playback held (lib/watch.ts, holdPlayback),
    // a ZCARD beside the GET. A one-slot bad reply is given its held count (none) so the GET's own slot is what is unknown.
    rule = { when: first("GET", "nl:watch:opened:"), reply: Array.isArray(reply) && reply.length === 1 ? [...reply, 0] : reply };
    const now = Date.now();
    await outcome(() => measureDue(now + 60_000, now));
    rule = null;
    const [score] = await redis.pipeline([["ZSCORE", DUE, folder]]);
    is(`measureDue, ${label}: still in line`, score !== null, true);
  }
  {
    await redis.pipeline([["ZADD", DUE, 0, folder]]);
    // Rule 23 (9 November 2026): was [null]; the GET is now beside a ZCARD of the playback held, here none (0).
    rule = { when: first("GET", "nl:watch:opened:"), reply: [null, 0] };
    const now = Date.now();
    await measureDue(now + 60_000, now);
    rule = null;
    is("measureDue: never opened (no key) is taken out of line, as before", (await redis.pipeline([["ZSCORE", DUE, folder]]))[0], null);
    await redis.pipeline([["ZADD", DUE, 0, folder]]);
    rule = { when: first("GET", "nl:watch:opened:"), reply: [String(now - 1000), 0] };
    await measureDue(now + 60_000, now);
    rule = null;
    is("measureDue: opened a moment ago stays in line for the next hour", Number((await redis.pipeline([["ZSCORE", DUE, folder]]))[0]), now + MEASURE_EVERY_MS);
  }

  // --------------------------------------------------------------- toldOf
  part("toldOf: an unknown mark on the told list is never \"not yet\"");
  const owner = "sg2-l8-closing@example.com";
  await claimHandle(owner, "sglightclose", "SG L8 Close", "");
  const shop = await storeForEmail(owner);
  if (!shop) throw new Error("the test store was not made");
  const closingFolder = await storeFolder(storeRef(shop));
  for (const [label, reply] of BAD_GETS) {
    rule = { when: first("HGET", "nl:closing:told:"), reply };
    is(`toldOf, ${label}: refused as unknown`, await outcome(() => toldOf(shop, "buyer@example.com")), "rejected");
  }
  rule = { when: first("HGET", "nl:closing:told:"), reply: [null] };
  is("toldOf: not on the list", await toldOf(shop, "buyer@example.com"), null);
  rule = { when: first("HGET", "nl:closing:told:"), reply: ["x"] };
  is("toldOf: on the list, not told (the cap did not cover it)", await toldOf(shop, "buyer@example.com"), { toldAt: 0 });
  rule = { when: first("HGET", "nl:closing:told:"), reply: ["1790000000000"] };
  is("toldOf: told, and when", await toldOf(shop, "buyer@example.com"), { toldAt: 1790000000000 });
  rule = null;

  // ----------------------------------------------------------- tellBuyers
  part("tellBuyers: a told list that cannot be read writes to nobody again");
  await redis.pipeline([["HSET", workKey(closingFolder), "m:sub_sgl8", "member@example.com"]]);
  const BAD_HMGET: [string, unknown][] = [
    ...BAD_TEXT.map(([label, slot]) => [`a mark that is ${label}`, [[slot]]] as [string, unknown]),
    ["a list of marks that is too short", [[]]],
    ["a list of marks that is too long", [[null, null]]],
    ["a reply that is not a list", [null]],
    ["a reply that is an object", [{ "member@example.com": null }]],
    ["an empty pipeline reply", []],
    ["a second, unasked-for reply", [[null], [null]]],
    ["a Redis that cannot be asked", "throw"],
  ];
  const E = Date.UTC(2026, 10, 1);
  for (const [label, reply] of BAD_HMGET) {
    await startClosingCredit(closingFolder, 10);
    rule = { when: first("HMGET", "nl:closing:told:"), reply };
    const from = sent.length;
    const told = await outcome(() => tellBuyers(shop, E, E + 30 * 86_400_000, "", Date.now() + 60_000));
    is(`tellBuyers, ${label}: nobody told this round`, told === "rejected" || (told.done === false && told.sent === 0), true);
    is(`tellBuyers, ${label}: no email credit taken`, sentSince(from, "DECRBY", "nl:closing:credit:"), false);
  }
  {
    await startClosingCredit(closingFolder, 10);
    rule = { when: first("HMGET", "nl:closing:told:"), reply: [[null]] };
    const from = sent.length;
    await outcome(() => tellBuyers(shop, E, E + 30 * 86_400_000, "", Date.now() + 60_000));
    is("tellBuyers: not on the list (null) is told, its credit taken first", sentSince(from, "DECRBY", "nl:closing:credit:"), true);
    rule = { when: first("HMGET", "nl:closing:told:"), reply: [["1790000000000"]] };
    const again = sent.length;
    await outcome(() => tellBuyers(shop, E, E + 30 * 86_400_000, "", Date.now() + 60_000));
    is("tellBuyers: told already is not told again", sentSince(again, "DECRBY", "nl:closing:credit:"), false);
    rule = null;
  }

  // ------------------------------------------------------ tellRefundShort
  part("tellRefundShort: an unknown mark stops the round before anything is taken or sent");
  const short = [
    { email: "first@example.com", amount: 500, cur: "usd" },
    { email: "second@example.com", amount: 500, cur: "usd" },
  ];
  for (const [label, reply] of BAD_GETS) {
    await startClosingCredit(closingFolder, 10);
    rule = { when: (commands) => first("HGET", "nl:closing:told:")(commands) && commands[0]?.[2] === "first@example.com", reply };
    const from = sent.length;
    const told = await outcome(() => tellRefundShort(shop, short, E));
    is(`tellRefundShort, ${label}: not done this round`, told === "rejected" || (told.ok === false && told.sent === 0), true);
    is(`tellRefundShort, ${label}: no email credit taken for anyone`, sentSince(from, "DECRBY", "nl:closing:credit:"), false);
  }
  {
    await startClosingCredit(closingFolder, 10);
    rule = null;
    const from = sent.length;
    await tellRefundShort(shop, short, E);
    is("tellRefundShort: members not told before take their email from the credit", sentSince(from, "DECRBY", "nl:closing:credit:"), true);
  }

  // ----------------------------------------------------------- saveReview
  part("saveReview: an unknown count of a product's reviews lets no review past the ceiling");
  const STATS = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
  const PRODUCT = "sgleightprod";
  const input = (n: string) => ({ productId: PRODUCT, email: `reviewer-${n}@example.com`, reference: `cs_test_${n}`, pi: "", rating: 5, text: "Good.", name: "R" });
  const BAD_SIZES: [string, unknown][] = [
    ["a count that is null", [null, null]],
    ["a count written as text", [null, "5"]],
    ["a fractional count", [null, 1.5]],
    ["a negative count", [null, -1]],
    ["a count that is true", [null, true]],
    ["a count that is an object", [null, { n: 1 }]],
    ["a review that is an object", [{ rating: 5 }, 0]],
    ["a review that is a number", [5, 0]],
    ["a reply missing the count", [null]],
    ["a third, unasked-for reply", [null, 0, 0]],
    ["a reply that is not a list", { result: 0 }],
    ["a Redis that cannot be asked", "throw"],
  ];
  let n = 0;
  for (const [label, reply] of BAD_SIZES) {
    n += 1;
    rule = { when: first("HGET", `nl:rev:${STATS}:`), reply };
    const from = sent.length;
    const got = await outcome(() => saveReview(STATS, input(`bad${n}`), ROOM));
    is(`saveReview, ${label}: refused`, got === "rejected" || (typeof got === "object" && got.state !== "created" && got.state !== "updated"), true);
    is(`saveReview, ${label}: nothing written`, sentSince(from, "HSET", `nl:rev:${STATS}:`), false);
  }
  rule = { when: first("HGET", `nl:rev:${STATS}:`), reply: [null, MAX_REVIEWS_PER_PRODUCT] };
  is("saveReview: a product at its ceiling takes no more", await saveReview(STATS, input("full"), ROOM), { state: "full" });
  rule = null;
  is("saveReview: the real count still lets a review in", (await saveReview(STATS, input("real"), ROOM)).state, "created");

  done();
}

void main();
