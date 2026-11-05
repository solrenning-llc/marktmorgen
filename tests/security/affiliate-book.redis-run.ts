/**
 * The affiliate program's kept book (lib/affiliate-book-snapshot.ts): its
 * scripts, run as Lua on a real Redis. The in-memory double the unit check
 * uses (tests/public-reads-ceiling.test.ts) cannot run Lua and stands in for
 * each script step for step; this journey proves the scripts themselves:
 *
 *   - a refresh is counted before it reads, and a complete book written sets
 *     the count back, an incomplete one keeps it and is worked out again soon;
 *   - its part's size is counted in bytes, as Redis counts them;
 *   - a refresh whose lock ran out, and another took it, keeps nothing and
 *     leaves no draft, and the other's whole book stays;
 *   - a person deleted while a refresh reads: nothing kept, no draft;
 *   - marking only when the book was worked out never overwrites this
 *     refresh's own whole book, and a second commit of it changes nothing;
 *   - a draft a stopped refresh left is deleted by the next one;
 *   - a refresh counted and stopped before writing holds the next one off;
 *     one whose charge was refused takes its count back.
 *
 * Synthetic records only, in the database the runner empties.
 */
import type { Book } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import {
  BOOK_COMMIT, BOOK_FRESH_SECONDS, BOOK_KEEP_SECONDS, BOOK_MARK, BOOK_SHORT_SECONDS, beginAttempt, claimRefresh, forgetBookSnapshot, needsRefresh,
  readBookVersion, readSlice, releaseRefresh, snapshotState, undoAttempt, writeSnapshot,
} from "@/lib/affiliate-book-snapshot";
import { redisPipeline } from "@/lib/redis";
import { check, finish } from "./check";

const store = { statsId: "bookcheck01" } as Store;
const key = "nl:aff:bookcheck01:book";
const lock = `${key}:lock`;

function book(n: number, complete = true): Book {
  const rows = Array.from({ length: n }, (_, i) => ({ affiliate: { id: `a${String(i).padStart(11, "0")}`, status: "approved", email: `p${i}@example.com`, paypal: "pay@example.com", note: "note" }, owed: 100, earned: 100, paid: 0 }));
  // A title in another script and a masked address: more bytes than characters.
  const lines = rows.map((r) => ({ aff: r.affiliate.id, currency: "usd", title: "書籍コース", lead: { id: "l", kind: "signup", email: "bob@example.com", readyAt: 0, why: "" } }));
  return { rows, lines, payouts: [], currency: "usd", elsewhere: 0, refundsChecked: complete, invoicesChecked: complete } as unknown as Book;
}
async function drafts(): Promise<string[]> {
  const [keys] = await redisPipeline([["KEYS", `${key}:new*`]]);
  return (keys as string[]).sort();
}
async function get(k: string): Promise<unknown> {
  return (await redisPipeline([["GET", k]]))[0];
}

async function main(): Promise<void> {
  // A complete book, counted first.
  let held = (await claimRefresh(store))!;
  check("a refresh is counted before it reads: the first in a row", await beginAttempt(store, held, 1_000), 1);
  check("its write keeps the whole book", await writeSnapshot(store, book(3), 1_000, held, await readBookVersion(store), 1), { kept: true, short: false });
  const [raw] = await redisPipeline([["HGET", key, "a00000000001"]]);
  const state = await snapshotState(store, "a00000000001");
  check("its part's size is its UTF-8 bytes", [state?.sliceBytes, state?.sliceBytes === Buffer.byteLength(String(raw)), String(raw).length < Buffer.byteLength(String(raw))], [Buffer.byteLength(String(raw)), true, true]);
  check("the address masked, and none of the affiliate's own", [String(raw).includes("b•••@example.com"), String(raw).includes("p1@example.com")], [true, false]);
  check("a complete book sets the count back, and nothing is pending or left", [await get(`${key}:tries`), await get(`${key}:tried`), await get(`${key}:draft`), await drafts()], [null, null, null, []]);
  check("its part reads back", (await readSlice(store, "a00000000001"))?.book.rows[0]?.affiliate.id, "a00000000001");
  await releaseRefresh(held);

  // An incomplete one.
  held = (await claimRefresh(store))!;
  const tries = (await beginAttempt(store, held, 2_000))!;
  check("an incomplete book is kept and worked out again soon", await writeSnapshot(store, book(3, false), 2_000, held, await readBookVersion(store), tries), { kept: true, short: true });
  check("and the count stays", [await get(`${key}:tries`), (await snapshotState(store, "a00000000000"))?.freshFor], ["1", BOOK_SHORT_SECONDS]);
  await releaseRefresh(held);

  // Two refreshes overlap: A's lock runs out and B takes it.
  const a = (await claimRefresh(store))!;
  const versionA = await readBookVersion(store);
  await redisPipeline([["DEL", lock]]);
  const b = (await claimRefresh(store))!;
  check("B keeps its whole book", await writeSnapshot(store, book(4), 3_000, b, await readBookVersion(store), 1), { kept: true, short: false });
  check("A, its lock gone, keeps nothing", await writeSnapshot(store, book(2), 3_001, a, versionA, 1), null);
  check("the book is B's, whole, and no draft is left", [(await redisPipeline([["HGET", key, "_by"]]))[0], (await snapshotState(store, "a00000000003"))?.at, await drafts()], [b.token, 3_000, []]);
  await releaseRefresh(a);
  check("A letting go leaves B's lock", await get(lock), b.token);

  // Marking only, and committing again, after B's own commit landed.
  const keys = [b.key, `${key}:ver`, `${key}:new:${b.token}`, key, `${key}:draft`, `${key}:tries`, `${key}:tried`];
  const head = [b.token, await readBookVersion(store), BOOK_KEEP_SECONDS, "1", "_at", "3000", "_short", "0", "_by", b.token];
  check("marking only never overwrites this refresh's own whole book", [(await redisPipeline([["EVAL", BOOK_MARK, 7, ...keys, ...head, "_kept", "0"]]))[0], (await snapshotState(store, "a00000000003"))?.kept], [2, true]);
  check("and a second commit changes nothing", [(await redisPipeline([["EVAL", BOOK_COMMIT, 7, ...keys, ...head, "_kept", "1"]]))[0], (await redisPipeline([["HLEN", key]]))[0]], [1, 8]);
  await releaseRefresh(b);

  // A person deleted while a refresh reads.
  held = (await claimRefresh(store))!;
  const before = await readBookVersion(store);
  await forgetBookSnapshot(store.statsId!);
  check("a deletion raises the version and deletes the book", [(await readBookVersion(store)) !== before, (await redisPipeline([["EXISTS", key]]))[0]], [true, 0]);
  check("so the refresh that read before keeps nothing, and no draft", [await writeSnapshot(store, book(3), 4_000, held, before, 1), (await redisPipeline([["EXISTS", key]]))[0], await drafts()], [null, 0, []]);
  await releaseRefresh(held);

  // A draft a stopped refresh left, named by the pointer.
  held = (await claimRefresh(store))!;
  await redisPipeline([["SET", `${key}:draft`, held.token], ["HSET", `${key}:new:${held.token}`, "x", "1"], ["DEL", lock]]);
  const next = (await claimRefresh(store))!;
  await writeSnapshot(store, book(2), 5_000, next, await readBookVersion(store), 1);
  check("the next refresh deletes it as it begins", await drafts(), []);
  await releaseRefresh(next);

  // A deletion while a draft is being written deletes that draft too.
  held = (await claimRefresh(store))!;
  await redisPipeline([["SET", `${key}:draft`, held.token], ["HSET", `${key}:new:${held.token}`, "x", "1"]]);
  await forgetBookSnapshot(store.statsId!);
  check("a deletion deletes the draft being written", await drafts(), []);
  await releaseRefresh(held);

  // Counted, then stopped before writing; and counted, then refused its charge.
  // The book of 5_000 out of date a day later: a refresh is due, and one is counted and stops.
  const late = 5_000 + BOOK_FRESH_SECONDS + 100;
  check("the book out of date, a refresh is due", needsRefresh((await snapshotState(store, "a00000000000"))!, late), true);
  held = (await claimRefresh(store))!;
  check("counted: the first since the last complete book", await beginAttempt(store, held, late), 1);
  await releaseRefresh(held);
  const stopped = (await snapshotState(store, "a00000000000"))!;
  check("a refresh stopped before writing holds the next off for the short wait", [stopped.triedAt, needsRefresh(stopped, late + 60), needsRefresh(stopped, late + BOOK_SHORT_SECONDS + 1)], [late, false, true]);
  held = (await claimRefresh(store))!;
  check("counted again", await beginAttempt(store, held, 7_000), 2);
  await undoAttempt(store, held, 7_000);
  check("a refused charge takes its count back", [await get(`${key}:tries`), await get(`${key}:tried`)], ["1", null]);
  await releaseRefresh(held);
  check("a refresh that does not hold the lock is not counted", await beginAttempt(store, held, 8_000), null);

  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
