/**
 * A visit counted after the store's erasure began writes no owner back under its folder (lib/traffic.ts, markMonth;
 * lib/delivery.ts, rememberFolderOwner).
 *
 * The month's first visit, and every hundredth, wrote the folder's owner (nl:store:folder-owner:<folder>, the creator's
 * address) with a plain SET. A visit that reached the store's public page after its erasure began wrote the erased
 * creator's address back, for good, under a folder the erasure had just cleared (Codex L-20261120-0627). Now the write
 * goes through the store's fence (lib/live-fence.ts, KEEP_IF_STORE_LIVE): a store erasing or gone gets nothing written;
 * a live store's owner is kept with no expiry, as before: it is the creator's record, read by the daily usage job, not
 * a cache (Claude 3's LEVE on #5110: a fenced write with EX turned the key an upload kept for good into one that
 * expired 400 days after a visit).
 *
 * Real code over the in-memory Redis; synthetic records only.
 */
import { rememberFolderOwner, storeKeysOf } from "@/lib/delivery";
import { ERASING_KEY, claimHandle, closeStoreRecord, ensureStatsId, ensureStoreId, erasingField, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { PARTS_PER_VISIT } from "@/lib/traffic-rules";
import { recordParts, recordVisit } from "@/lib/traffic";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
/** The plain SET the owner used to be written with from a visit: never sent any more. */
let plainWrites = 0;
redis.pipeline = (async (batch: Batch) => {
  if (batch.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:store:folder-owner:"))) plainWrites += 1;
  return original(batch);
}) as typeof redis.pipeline;

let shops = 0;
async function shop() {
  shops += 1;
  const email = `folder-owner-${shops}@example.com`;
  is(`synthetic store ${shops}`, (await claimHandle(email, `folderowner${shops}`, "A store", "")).ok, true);
  await ensureStatsId(email);
  await ensureStoreId(email);
  await setSubscription(email, { customerId: `cus_FolderOwner${shops}`, subscriptionId: `sub_FolderOwner${shops}`, active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const ref = storeRef(store);
  const folder = await storeFolder(ref);
  return { store, ref, key: `nl:store:folder-owner:${folder}`, field: await erasingField(ref) };
}
const owner = async (key: string) => (await original([["GET", key]]))[0];
const ttl = async (key: string) => Number((await original([["TTL", key]]))[0]);

async function main() {
  part("Control: the month's first visit remembers the folder's owner, through the fence, with no expiry");
  const live = await shop();
  is("the visit counts", await recordVisit(live.store, "203.0.113.1"), true);
  is("the owner is remembered", await owner(live.key), live.ref.toLowerCase());
  is("kept with no expiry (TTL -1), as before the fence", await ttl(live.key), -1);
  is("no plain SET", plainWrites, 0);

  part("An upload keeps the owner for good; a visit after it never gives the key an expiry");
  const uploaded = await shop();
  const folder = uploaded.key.slice("nl:store:folder-owner:".length);
  await rememberFolderOwner(folder, uploaded.ref);
  plainWrites = 0;
  is("the upload's write has no expiry", await ttl(uploaded.key), -1);
  is("a visit counts", await recordVisit(uploaded.store, "203.0.113.4"), true);
  is("the key still has no expiry", await ttl(uploaded.key), -1);
  is("the daily usage job still finds the store for its folder", (await storeKeysOf([folder]))[0] !== null, true);

  part("A store whose erasure has begun: the live room's first hundredths, which mark the month, write no owner back");
  const erasing = await shop();
  is("the first visit counts", await recordVisit(erasing.store, "203.0.113.2"), true);
  // The erasure begins and clears the folder's owner, as closing does.
  await original([["HSET", ERASING_KEY, erasing.field, String(Date.now())], ["DEL", erasing.key]]);
  is("the live room still counts toward the month", await recordParts(erasing.store, 1), 1);
  is("but the owner is not written back", await owner(erasing.key), null);
  await original([["HDEL", ERASING_KEY, erasing.field]]);

  part("A store closed meanwhile: a hundred visits' worth of the live room marks the month, and writes no owner");
  const closed = await shop();
  is("the first visit counts", await recordVisit(closed.store, "203.0.113.3"), true);
  const before = closed.store;
  is("closed", await closeStoreRecord(closed.store, [closed.key]), true);
  is("cleared by the closing", await owner(closed.key), null);
  is("the live room still counts", await recordParts(before, 100 * PARTS_PER_VISIT), 100 * PARTS_PER_VISIT);
  is("and the owner is not written back", await owner(closed.key), null);
  is("never by a plain SET", plainWrites, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
