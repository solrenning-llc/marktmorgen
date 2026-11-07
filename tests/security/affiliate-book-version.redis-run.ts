/**
 * The affiliate program's kept book (lib/affiliate-book-snapshot.ts): the
 * version a person's deletion raises, run on a real Redis. A refresh reads the
 * version before it reads the book and writes only while the version is still
 * the one it read, so a refresh that read a person's (masked) address before
 * they were deleted keeps nothing. The version is kept BOOK_KEEP_SECONDS after
 * the last deletion; this journey proves that once it runs out and is made
 * again it never comes back as a value it held before:
 *
 *   - a refresh that read the version before it ran out, with a person
 *     deleted after, keeps nothing and leaves no draft (an INCR started
 *     again from 1 and gave it the value it had read);
 *   - deletions in a row each give a version not held before, and so does
 *     the next one after it runs out again.
 *
 * Synthetic records only, in the database the runner empties.
 */
import type { Book } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { BOOK_KEEP_SECONDS, claimRefresh, forgetBookSnapshot, readBookVersion, releaseRefresh, writeSnapshot } from "@/lib/affiliate-book-snapshot";
import { redisPipeline } from "@/lib/redis";
import { check, finish } from "./check";

const store = { statsId: "bookver00001" } as Store;
const key = "nl:aff:bookver00001:book";
const version = `${key}:ver`;

function book(n: number): Book {
  const rows = Array.from({ length: n }, (_, i) => ({ affiliate: { id: `a${String(i).padStart(11, "0")}`, status: "approved", email: `p${i}@example.com`, paypal: "pay@example.com", note: "note" }, owed: 100, earned: 100, paid: 0 }));
  // The lead of a person deleted while the refresh reads: their address, masked, is in each line.
  const lines = rows.map((r) => ({ aff: r.affiliate.id, currency: "usd", title: "Course", lead: { id: "l", kind: "signup", email: "gone@example.com", readyAt: 0, why: "" } }));
  return { rows, lines, payouts: [], currency: "usd", elsewhere: 0, refundsChecked: true, invoicesChecked: true } as unknown as Book;
}
async function drafts(): Promise<string[]> {
  const [keys] = await redisPipeline([["KEYS", `${key}:new*`]]);
  return (keys as string[]).sort();
}
/** The version runs out, as it does BOOK_KEEP_SECONDS after the last deletion. */
async function runOut(): Promise<unknown> {
  await redisPipeline([["PEXPIRE", version, 1]]);
  await new Promise((done) => setTimeout(done, 20));
  return (await redisPipeline([["EXISTS", version]]))[0];
}

async function main(): Promise<void> {
  // A person deleted a little over a week ago: the version is raised and kept BOOK_KEEP_SECONDS.
  await forgetBookSnapshot(store.statsId!);
  const first = await readBookVersion(store);
  const [ttl] = await redisPipeline([["TTL", version]]);
  check("a deletion raises the version, kept BOOK_KEEP_SECONDS", [first !== "", Number(ttl) > BOOK_KEEP_SECONDS - 60 && Number(ttl) <= BOOK_KEEP_SECONDS], [true, true]);

  // A refresh begins and reads the version; it is about to run out.
  const held = (await claimRefresh(store))!;
  const before = await readBookVersion(store);
  check("the refresh read that deletion's version", before, first);
  // While the refresh reads Stripe, the week ends and the version runs out ...
  check("the version ran out", await runOut(), 0);
  // ... and another person is deleted, after the refresh read their lead.
  await forgetBookSnapshot(store.statsId!);
  const after = await readBookVersion(store);
  check("the version made again is not the one the refresh read", after !== before, true);
  check(
    "so the refresh that read before that deletion keeps nothing, and leaves no draft",
    [await writeSnapshot(store, book(3), 2_000, held, before, 1), (await redisPipeline([["EXISTS", key]]))[0], await drafts()],
    [null, 0, []],
  );
  await releaseRefresh(held);

  // Three more deletions in a row: each a version not held before.
  const seen = [first, after];
  for (let n = 0; n < 3; n += 1) {
    await forgetBookSnapshot(store.statsId!);
    seen.push(await readBookVersion(store));
  }
  check("each deletion gives a version not held before", seen.every((v) => v !== "") && new Set(seen).size === seen.length, true);
  // Run out once more: the next one is still none held before.
  check("the version ran out again", await runOut(), 0);
  await forgetBookSnapshot(store.statsId!);
  const last = await readBookVersion(store);
  check("and the next one is none held before", last !== "" && !seen.includes(last), true);

  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
