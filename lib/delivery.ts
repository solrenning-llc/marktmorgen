/**
 * How much a store has sent out this month, in files.
 *
 * This was written when a download cost about five cents a gigabyte every
 * time it happened, and the number that decided whether a $29 store paid for
 * itself was how many files went out. The files that are sold are now kept
 * where sending one costs nothing (lib/vault.ts), so the money has gone out
 * of this figure. What is left of it is what a storefront is for: a plan
 * covers selling one's own work, not hosting files for the internet, and a
 * store far past the published figure is told so. It is counted, published
 * and said out loud, and it is never charged for.
 *
 * What it deliberately does NOT do is stop a delivery. Somebody paid the
 * creator for that file. Cutting the buyer off would be taking money for a
 * sale and then not completing it, which is the thing this whole company is
 * supposed to be the opposite of. Going over is a conversation with the
 * creator, not a door slammed on their customer.
 *
 * A lesson's video is not counted here. It is the one thing that does cost
 * by use, it is measured by the time it was watched and not by the
 * gigabyte, and it has rules of its own (lib/watch-rules.ts).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { signedOf, textCountOf } from "@/lib/redis-count";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { STREAM_PREFIX } from "@/lib/stream-rules";
import { VAULT_PREFIX } from "@/lib/vault-rules";

/**
 * The downloads a plan covers, per store, per calendar month.
 *
 * To reach it a creator has to send two hundred copies of a one-gigabyte
 * file in a month, which is a store doing very well. The number is published
 * rather than kept in a drawer, because a limit a creator cannot see is a
 * limit they can only discover by being told off for it. Nothing is charged
 * past it and nothing is stopped: the creator is written to.
 */
export const DELIVERY_ALLOWANCE_BYTES = 200 * 1024 * 1024 * 1024;

/**
 * Where free copies stop, and only free copies.
 *
 * A paid download is never refused, at any number, for the reason above: the
 * buyer paid for that file. But the delivery that can run away without
 * anybody having paid for anything is the free one — a lead magnet that
 * finds an audience, or is posted somewhere it was not meant to go, and is
 * pulled fifty thousand times.
 *
 * So free copies pause at fifty gigabytes a month, by themselves, and start
 * again when the month turns. Nobody is cut off from something they bought,
 * because nobody bought it, and the creator is told the same day.
 *
 * Fifty was set against money: at the eleven cents a gigabyte the host's own
 * file store charges for a file too large to cache, it is $5.50 against the
 * $27.86 a $29 subscription leaves after the card fee, and the figure it
 * replaced, 400 GB, could cost $44 a month on its own. A brake set above the
 * revenue it protects is not a brake. A file that is sold is now kept where
 * sending it costs nothing (lib/vault.ts), and the host's store is shut to
 * new ones (app/api/store/file), so the brake no longer guards a bill. It
 * stays where it was, because what it stops was never only a bill: a plan
 * is for a storefront, not for handing a file to the whole internet.
 *
 * And it is not tight for giving things away. Fifty gigabytes is a ten
 * megabyte lead magnet downloaded five thousand times in a month. A store
 * past it is not running a storefront any more.
 */
export const FREE_PAUSE_ABOVE_BYTES = 50 * 1024 * 1024 * 1024;

/** Counters are dropped a while after the month they describe. */
const KEEP_SECONDS = 70 * 24 * 60 * 60;

/**
 * The stores that have passed the allowance this month.
 *
 * Kept as a set the moment a store crosses, rather than found later by
 * reading every counter, because reading every counter means scanning the
 * whole keyspace once a day on a store we pay per command for — and the
 * crossing is a single moment that already has the number in its hand.
 *
 * It exists because the creator could see they were over and we could not.
 * The warning in their studio has been there all along; the one that reaches
 * us had not, so the first we would hear of a store sending twenty-five
 * terabytes was the invoice, a month late and already paid.
 */
const overKey = (month: string) => `nl:store:delivery:over:${month}`;

/**
 * Which creator a delivery folder belongs to.
 *
 * A folder name is a one-way hash of the creator's address, so that a public
 * file path says nothing about whose store it is. That is right, and it
 * leaves this file holding a number it cannot attach to a person — which is
 * why the notice about going over the allowance could only ever have been
 * written by hand.
 *
 * So the pairing is kept here, in our own store, where it was always
 * readable to us and never to anybody else. Nothing about the public path
 * changes; the hash still reveals nothing. It is written when a creator
 * uploads, which is the one moment both halves are in the same hand, and
 * read only by the daily run that writes to them.
 */
const ownerKey = (folder: string) => `nl:store:folder-owner:${folder}`;

/** Remembers whose folder this is, so the allowance notice can reach them. */
export async function rememberFolderOwner(folder: string, email: string): Promise<void> {
  if (!isRedisConfigured() || !folder || !email) return;
  try {
    await redisPipeline([["SET", ownerKey(folder), email.toLowerCase()]]);
  } catch (error) {
    console.error("could not remember a folder's owner", error);
  }
}

/** The month a delivery belongs to, in UTC so it never depends on a server. */
export function monthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The store folder a file path belongs to.
 *
 * Every stored file lives at `stores/<folder>/<product>/<name>`, and a lesson
 * video at the video service at `stream/<folder>/<lesson>/<id>`, so the owner
 * can be read from the path itself. That matters on the buyer's download,
 * which knows the file but has never seen the creator's address.
 */
export function folderFromPathname(pathname: string): string | null {
  const parts = pathname.split("/");
  // A lesson video kept by the video service is written down under the same
  // folder, with its own first piece (lib/stream-rules.ts).
  // And so is a file in the store that charges nothing for a download
  // (lib/vault-rules.ts).
  if (parts.length < 4 || (parts[0] !== "stores" && parts[0] !== STREAM_PREFIX && parts[0] !== VAULT_PREFIX)) return null;
  return parts[1] || null;
}

const counterKey = (folder: string, month: string) =>
  `nl:store:delivery:${folder}:${month}`;

/**
 * Adds a delivery to this month's total.
 *
 * Counted when the file is handed over rather than when it finishes arriving,
 * because a download that goes straight from storage never reports back. That
 * makes the number an upper bound: a buyer who cancels halfway is still
 * counted in full. Erring high is the right way round for a figure whose job
 * is to warn.
 *
 * Never throws. A counter that cannot be written must not cost a buyer the
 * file they paid for. Answers whether the delivery was counted (true too
 * when there is nothing to count): false when INCRBY failed or answered in
 * any other shape than a whole total at least the bytes just added (CX-123
 * rule 24), so a free copy is not handed out uncounted (lib/serve-file.ts).
 */
export async function recordDelivery(
  pathname: string,
  bytes: number,
): Promise<boolean> {
  if (!isRedisConfigured()) return true;
  if (!Number.isFinite(bytes) || bytes <= 0) return true;
  const folder = folderFromPathname(pathname);
  if (!folder) return true;

  const month = monthKey();
  const key = counterKey(folder, month);
  const added = Math.round(bytes);
  let total: number | null;
  try {
    const replies = repliesFor(
      await redisPipeline([
        ["INCRBY", key, added],
        ["EXPIRE", key, KEEP_SECONDS],
      ]),
      2,
    );
    const read = replies ? signedOf(replies[0]) : null;
    total = read !== null && read >= added ? read : null;
  } catch (error) {
    console.error("could not record a delivery", error);
    return false;
  }
  try {
    // Written down once, on the delivery that takes the store past the line.
    // Checking the crossing rather than the total keeps a store that is far
    // over from writing this on every file it hands out for the rest of the
    // month. An unknown total may have crossed it: the store is written down
    // too, and the watch names it only if its real total is over.
    if (total === null || (total > DELIVERY_ALLOWANCE_BYTES && total - added <= DELIVERY_ALLOWANCE_BYTES)) {
      await redisPipeline([
        ["SADD", overKey(month), folder],
        ["EXPIRE", overKey(month), KEEP_SECONDS],
      ]);
    }
  } catch (error) {
    console.error("could not write down a store past its allowance", error);
  }
  if (total === null) console.error("recording a delivery: Redis answered INCRBY in an unknown shape");
  return total !== null;
}

export type DeliveryMonth = {
  bytes: number;
  allowance: number;
  /** True once the month's deliveries are past what the price covers. */
  over: boolean;
};

/**
 * The month's counter, in bytes, read only in its exact shape (CX-123 rule
 * 24); null when it could not be read or came back in any other shape.
 */
async function monthBytes(folder: string): Promise<number | null> {
  try {
    const replies = repliesFor(await redisPipeline([["GET", counterKey(folder, monthKey())]]), 1);
    const count = replies ? textCountOf(replies[0]) : null;
    // No key is nothing sent yet this month: INCRBY makes it on the first delivery.
    return count === "absent" ? 0 : count;
  } catch (error) {
    console.error("could not read this month's deliveries", error);
    return null;
  }
}

/**
 * What this store has sent out so far this month. Null when the counter
 * could not be read: the studio then leaves the figure out rather than show
 * an unknown as 0 bytes.
 */
export async function deliveredThisMonth(
  folder: string,
): Promise<DeliveryMonth | null> {
  const allowance = DELIVERY_ALLOWANCE_BYTES;
  if (!isRedisConfigured() || !folder) {
    return { bytes: 0, allowance, over: false };
  }
  const bytes = await monthBytes(folder);
  if (bytes === null) return null;
  return { bytes, allowance, over: bytes > allowance };
}

/**
 * Every store past the allowance this month, with what it has sent.
 *
 * Read by the daily usage watch (app/api/cron/usage/route.ts), which is the
 * only thing that tells us. Nothing here stops a delivery: a creator over
 * the line is a conversation, and this is what makes the conversation
 * possible in the week it matters rather than after the invoice.
 *
 * Throws when Redis cannot be asked or answers in an unknown shape (CX-123
 * rule 24): an unread list is never "nobody is over", and an unread total is
 * never 0 bytes. The day's run then fails where it can be seen, and the
 * next one reads again.
 */
export async function storesOverAllowance(
  now: Date = new Date(),
): Promise<{ folder: string; bytes: number }[]> {
  if (!isRedisConfigured()) return [];
  const month = monthKey(now);
  const listed = repliesFor(await redisPipeline([["SMEMBERS", overKey(month)]]), 1);
  const members = listed ? stringList(listed[0]) : null;
  if (!members) throw new UnknownReplyError("the stores over the delivery allowance");
  const folders = members.filter((f) => f !== "");
  if (folders.length === 0) return [];
  const totals = repliesFor(await redisPipeline(folders.map((f) => ["GET", counterKey(f, month)])), folders.length);
  if (!totals) throw new UnknownReplyError("the delivery totals");
  const rows: { folder: string; bytes: number }[] = [];
  for (let i = 0; i < folders.length; i += 1) {
    const count = textCountOf(totals[i]);
    if (count === null) throw new UnknownReplyError("a store's delivery total");
    // A total whose key is gone (the month's counter expired) is nothing sent: it is not named.
    rows.push({ folder: folders[i], bytes: count === "absent" ? 0 : count });
  }
  return rows.filter((row) => row.bytes > DELIVERY_ALLOWANCE_BYTES).sort((a, b) => b.bytes - a.bytes);
}

/** "1.4 TB", for a line in an email. */
export function bytesWords(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/**
 * Whether this store's free copies may go out this month: "open", "over"
 * (the counter, read, is past the line: paused until the month turns), or
 * "unknown" (the counter could not be read, or came back in any other
 * shape: CX-123 rule 24). Nobody paid for a free copy, so "unknown" is never
 * room for one; it is not "over" either, and is never told as such.
 *
 * Asked before a free file is handed over, and never before a paid one.
 */
export async function freeDeliveryPause(folder: string): Promise<"open" | "over" | "unknown"> {
  if (!isRedisConfigured() || !folder) return "open";
  const bytes = await monthBytes(folder);
  if (bytes === null) return "unknown";
  return bytes > FREE_PAUSE_ABOVE_BYTES ? "over" : "open";
}

/** Whether this store's free copies are paused: past the line, or the counter unknown. */
export async function freeDeliveryPaused(folder: string): Promise<boolean> {
  return (await freeDeliveryPause(folder)) !== "open";
}

/**
 * The key each of these folders' stores is kept under (lib/store.ts): the
 * owner's address for an account's first store, "#" and the store's id for
 * its others. Null for a folder nobody uploaded to through the studio.
 */
export async function storeKeysOf(folders: string[]): Promise<(string | null)[]> {
  if (!isRedisConfigured() || folders.length === 0) return folders.map(() => null);
  try {
    const raw = await redisPipeline(folders.map((f) => ["GET", ownerKey(f)]));
    return raw.map((v) => (typeof v === "string" && v ? v : null));
  } catch (error) {
    console.error("could not read which store a folder belongs to", error);
    return folders.map(() => null);
  }
}

/** The creators behind a set of folders, for the notice that goes to them. */
export async function ownersOf(folders: string[]): Promise<(string | null)[]> {
  if (!isRedisConfigured() || folders.length === 0) return folders.map(() => null);
  try {
    const raw = await redisPipeline(folders.map((f) => ["GET", ownerKey(f)]));
    return raw.map((v) => (typeof v === "string" && v.includes("@") ? v : null));
  } catch (error) {
    console.error("could not read who a folder belongs to", error);
    return folders.map(() => null);
  }
}
