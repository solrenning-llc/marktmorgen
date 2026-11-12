/**
 * The affiliate book's version (lib/affiliate-book-snapshot.ts) must never
 * repeat. It is raised each time a person is deleted and kept only
 * BOOK_KEEP_SECONDS; a refresh that read the version, then the lead with the
 * person's address, before the version expired and a person was deleted,
 * must keep nothing. When the expired version starts again from nothing and
 * lands on the very value the refresh read, the refresh's stale book (with
 * the deleted person's masked address) is taken as current.
 *
 * Synthetic records only, in the database the runner empties.
 */
import type { Book } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { claimRefresh, forgetBookSnapshot, readBookVersion, readSlice, releaseRefresh, writeSnapshot } from "@/lib/affiliate-book-snapshot";
import { redisPipeline } from "@/lib/redis";
import { check, finish } from "./check";

const store = { statsId: "bookgen01" } as Store;
const version = "nl:aff:bookgen01:book:ver";

function book(email: string): Book {
  const rows = [{ affiliate: { id: "a00000000001", status: "approved", email: "aff@example.com", paypal: "", note: "" }, owed: 100, earned: 100, paid: 0 }];
  const lines = [{ aff: "a00000000001", currency: "usd", title: "Course", lead: { id: "l1", kind: "signup", email, readyAt: 0, why: "" } }];
  return { rows, lines, payouts: [], currency: "usd", elsewhere: 0, refundsChecked: true, invoicesChecked: true } as unknown as Book;
}

async function main() {
  // A first book, then a first deletion: the version is now what one deletion leaves.
  const first = await claimRefresh(store);
  await writeSnapshot(store, book("someone@example.com"), 1_000, first!, await readBookVersion(store), 1);
  await releaseRefresh(first!);
  await forgetBookSnapshot(store.statsId!);
  const settled = await claimRefresh(store);
  await writeSnapshot(store, book(""), 2_000, settled!, await readBookVersion(store), 1);
  await releaseRefresh(settled!);

  // Eight days on: refresh A reads the version, then the lead, address still on it.
  const held = await claimRefresh(store);
  const read = await readBookVersion(store);
  const stale = book("bob@example.com");
  // The version's keep runs out while A reads Stripe (a real expiry on the real Redis).
  await redisPipeline([["PEXPIRE", version, 1]]);
  await new Promise((r) => setTimeout(r, 30));
  // The person is deleted: the address comes off the lead (not modelled), the book is deleted.
  await forgetBookSnapshot(store.statsId!);
  check("the version after the deletion is not the one A read", (await readBookVersion(store)) !== read, true);
  const written = await writeSnapshot(store, stale, 3_000, held!, read, 1);
  check("A, which read before the deletion, keeps nothing", written, null);
  const slice = await readSlice(store, "a00000000001");
  check("the deleted person's masked address is not in the kept book", slice?.book.lines.some((l) => (l as { lead?: { email?: string } }).lead?.email === "b•••@example.com") ?? false, false);
  await releaseRefresh(held!);
  finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
