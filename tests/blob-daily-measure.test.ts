/**
 * The store's Vercel Blob folder is listed at most once a UTC day (owner's decision, 16 November 2026, asked directly
 * on #2848: "Medir só 1x por dia"). Between two listings, what a vault open measures is the last listed total plus
 * every byte a write to the store's Blob folder may have added since, tallied before the write (lib/blob.ts: a put by
 * its body, a put token at its maximum size), so the total is never less than what is there. Unknown is never zero:
 * a tally or a kept total that does not read in its exact shape refuses, and a day whose one listing is spent without
 * a kept total refuses until the next UTC day, saying so. No visible limit falls: a store may still fill its whole
 * storage figure. Synthetic only: an in-memory Blob (tests/blob-daily-measure-world.ts) and the in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { calls, blobs } from "./blob-daily-measure-world";
import { store as redis } from "./redis-stub";
import * as blob from "@/lib/blob";
import { storageUsedToday } from "@/lib/storage-quota";
import { BLOB_MEASURES_PER_DAY, BLOB_PUT_TOKEN_MAX_MS, BLOB_TALLY_WINDOW_MS, blobTallyKeys } from "@/lib/blob-tally";
import { PAID_UPLOAD_OPENS } from "@/lib/upload-budget-policy";
import { COST_LINES, BLOB_ADVANCED_OP, BLOB_PUT_TRIES, BLOB_LIST_PAGES, BLOB_LIST_MEASURES_A_MONTH, BLOB_TALLY_OPEN_COMMANDS, COMMAND } from "./plan-cost-registry";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { done, is, part } from "./check";

const F = "0123456789abcdef0123456789abcdef";
const G = "fedcba9876543210fedcba9876543210";
const DAY = 86_400_000;
const realNow = Date.now;
let clock = Date.UTC(2026, 10, 16, 10, 0, 0);
Date.now = () => clock;
const BRAKE = 1_000_000;

async function used() {
  try {
    return await storageUsedToday(F, BRAKE);
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}
async function refused(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "allowed";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

blobs.set(`stores/${F}/p1/book.pdf`, 1_000);
blobs.set(`stores/${G}/p1/other.pdf`, 5_000);

async function main() {
part("One listing a UTC day; the rest of the day reads the kept total and the tally");
{
  const first = await used();
  is("the first open of the day lists the folder", calls.list, 1);
  is("and measures what is there", (first as { bytes?: number }).bytes, 1_000);
  const second = await used();
  is("a second open the same day lists nothing", calls.list, 1);
  is("and reads the same total", (second as { bytes?: number }).bytes, 1_000);

  await blob.put(`stores/${F}/stamped/abc/book.pdf`, Buffer.alloc(300), { access: "private", addRandomSuffix: false });
  is("a put into the folder is tallied by its bytes, before it is sent", (await used() as { bytes?: number }).bytes, 1_300);
  await blob.put(`stores/${G}/stamped/abc/x.pdf`, Buffer.alloc(700), { access: "private", addRandomSuffix: false });
  await blob.put("images/abc/photo.png", Buffer.alloc(900), { access: "private", addRandomSuffix: false });
  is("a put into another store's folder or outside stores/ is not this store's", (await used() as { bytes?: number }).bytes, 1_300);

  await blob.issueSignedToken({ pathname: `stores/${F}/tasks/c/l/w/a.pdf`, operations: ["put"], maximumSizeInBytes: 2_000, validUntil: clock + 5 * 60_000 });
  is("a put token is tallied at its maximum size, whether or not the browser sends anything", (await used() as { bytes?: number }).bytes, 3_300);
  is("still one listing", calls.list, 1);
}

part("A write that cannot be tallied is refused before the file store is asked");
{
  const tokens = calls.token, copies = calls.copy;
  is("a put token into the folder with no maximum size", await refused(() => blob.issueSignedToken({ pathname: `stores/${F}/x/a.pdf`, operations: ["put"], validUntil: clock + 60_000 })), "blob_tally_unknown");
  is("a put token living longer than the window", await refused(() => blob.issueSignedToken({ pathname: `stores/${F}/x/a.pdf`, operations: ["put"], maximumSizeInBytes: 10, validUntil: clock + BLOB_PUT_TOKEN_MAX_MS + 1 })), "blob_tally_unknown");
  is("a put token for any path", await refused(() => blob.issueSignedToken({ pathname: "*", operations: ["put"], maximumSizeInBytes: 10, validUntil: clock + 60_000 })), "blob_tally_unknown");
  is("a put token with no path", await refused(() => blob.issueSignedToken({ operations: ["put"], maximumSizeInBytes: 10, validUntil: clock + 60_000 })), "blob_tally_unknown");
  is("a copy into the folder, whose size is not known before it", await refused(() => blob.copy("old/a.pdf", `stores/${F}/x/a.pdf`, { access: "private" } as never)), "blob_tally_unknown");
  is("none of them reached the file store", [calls.token - tokens, calls.copy - copies], [0, 0]);
  is("a read token for a file in the folder is not a write", await refused(() => blob.issueSignedToken({ pathname: `stores/${F}/p1/book.pdf`, operations: ["get"], validUntil: clock + 60_000 })), "allowed");
  is("nothing was tallied by them", (await used() as { bytes?: number }).bytes, 3_300);
}

part("The next UTC day lists again, and what was tallied and never sent stops counting");
{
  clock += DAY;
  const next = await used();
  is("a new day lists the folder once more", calls.list, 2);
  is("it measures what is there: the token that sent nothing is gone", (next as { bytes?: number }).bytes, 1_300);
}

part("A write tallied shortly before the listing and landing after it is still counted");
{
  clock = Date.UTC(2026, 10, 18, 0, 10, 0);
  const late = `stores/${F}/tasks/c/l/w/late.pdf`;
  const before = clock - 20 * 60_000;
  const saved = clock;
  clock = before;
  await blob.issueSignedToken({ pathname: late, operations: ["put"], maximumSizeInBytes: 4_000, validUntil: clock + 5 * 60_000 });
  clock = saved;
  const measured = await used();
  is("the day's listing ran", calls.list, 3);
  is("the listing did not see the file, the tally from the hour before it did", (measured as { bytes?: number }).bytes, 1_300 + 4_000);
  blobs.set(late, 4_000);
  is("once the file lands, the same day still counts it once", (await used() as { bytes?: number }).bytes, 5_300);
  is("the window reaches back far enough for a token's whole life", BLOB_TALLY_WINDOW_MS >= 2 * BLOB_PUT_TOKEN_MAX_MS, true);
}

part("Unknown is never zero");
{
  clock = Date.UTC(2026, 10, 19, 9, 0, 0);
  const day = Math.floor(clock / DAY);
  await redis.pipeline([["SET", blobTallyKeys.day(F, day), "1", "EX", 3 * 86_400]]);
  is("the day's one listing spent with no total kept: refused until the next UTC day, never listed again", await used(), { thrown: "storage_daily" });
  is("no listing", calls.list, 3);
  is("the studio says so honestly", typeof STUDIO_MESSAGES.storage_daily === "string" && /tomorrow/.test(STUDIO_MESSAGES.storage_daily), true);

  clock = Date.UTC(2026, 10, 20, 9, 0, 0);
  await redis.pipeline([["SET", blobTallyKeys.kept(F), "{not json", "EX", 3 * 86_400]]);
  const remeasured = await used();
  is("a kept total that does not read, with the day's listing free: listed again", calls.list, 4);
  is("and measured", (remeasured as { bytes?: number }).bytes, 5_300);
  await redis.pipeline([["SET", blobTallyKeys.added(F, Math.floor(clock / 3_600_000)), "lots", "EX", 3 * 86_400]]);
  const broken = await used();
  is("a tally that does not read: the measure is unavailable, never the kept total alone", (broken as { available?: boolean }).available, false);
  is("and nothing is listed for it", calls.list, 4);
}

part("The vault open measures through the daily total, and its refusal is said");
{
  const vault = readFileSync("lib/vault-storage.ts", "utf8");
  is("openReservedVault measures with storageUsedToday", vault.includes("storageUsedToday(input.folder, limit)"), true);
  const route = readFileSync("app/api/store/vault/route.ts", "utf8");
  is("the vault door answers storage_daily as itself, before the generic storage_ refusal", route.indexOf("\"storage_daily\"") > 0 && route.indexOf("\"storage_daily\"") < route.indexOf("message.startsWith(\"storage_\")"), true);
}

part("The cost line counts one listing a day, not one an open");
{
  const line = COST_LINES.find((each) => each.id === "blob-list");
  is("at most one listing a UTC day, a 31-day month", BLOB_LIST_MEASURES_A_MONTH, 31 * BLOB_MEASURES_PER_DAY);
  for (const tier of ["creator", "pro", "scale"] as const) {
    const expected = Math.min(PAID_UPLOAD_OPENS[tier], BLOB_LIST_MEASURES_A_MONTH) * BLOB_LIST_PAGES * BLOB_PUT_TRIES * BLOB_ADVANCED_OP
      + PAID_UPLOAD_OPENS[tier] * BLOB_TALLY_OPEN_COMMANDS * COMMAND;
    const got = line?.monthlyUsd(tier) ?? Number.NaN;
    is(`${tier}: listings and the tally's reads (US$ ${got.toFixed(5)} a month)`, Math.abs(got - expected) < 1e-12, true);
  }
}

}

main().then(() => {
  Date.now = realNow;
  done();
}, (error: unknown) => {
  Date.now = realNow;
  console.error(error);
  process.exitCode = 1;
});
