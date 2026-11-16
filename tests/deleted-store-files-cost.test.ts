/**
 * What deleting a deleted store's files sends to the file stores and to Redis is priced, and held to its ceiling
 * (#4348, Claude 7's MÉDIO on f0320f0425: "new Blob/Redis charges have no priced cost line").
 *
 * The defect: the delete's first try (app/api/store/stores, forgetStoreFiles) and every pass of the daily line
 * (lib/store-forget-retry.ts, removeDeletedStoreFiles) list each of a deleted store's folders page by page, delete
 * what they find a hundred at a time, and forget its community's picture count (a Redis DEL), with no line in
 * tests/plan-cost-registry.ts. Nothing bounded them either: a folder was listed to its end however long it was, and
 * a pass cut off by the line's deadline (OutOfTime) spent no try, so a store could take passes for good.
 *
 * Held here, on the real code with Blob in memory (tests/deleted-store-files-cost-world.ts):
 *   - a per-store line prices every pass a deleted store can take, at the paid Blob price, never a free quota;
 *   - one pass lists at most DELETED_STORE_LIST_PAGES pages a folder and sends at most a delete a hundred files;
 *     a folder past that fails the pass (counted, then given up and reported), never listed further;
 *   - a round of the line takes at most FORGET_TRIES tries and FORGET_LATE_PASSES passes cut off by the deadline;
 *   - a round the closing walk starts after one was given up forgets keys only, not files again;
 *   - the delete's first try lists with the same ceiling.
 * Synthetic only.
 */
import { readFileSync } from "node:fs";
import * as filesModule from "@/lib/deleted-store-files";
import { OutOfTime, deletedStoreFolders, removeDeletedStoreFiles } from "@/lib/deleted-store-files";
import * as lineModule from "@/lib/store-forget-retry";
import { FORGET_TRIES, queueStoreForget, retryStoreForgets } from "@/lib/store-forget-retry";
import { claimHandle, createStore, imageFolder, setCommunity, storeFolder, storeRef } from "@/lib/store";
import { communityFolder } from "@/lib/community-image";
import { TIERS } from "@/lib/plan";
import { BLOB_ADVANCED_OPERATION, COMMAND, PER_PAYMENT_LINES } from "./plan-cost-registry";
import { calls, files } from "./deleted-store-files-cost-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const named = (module: object, name: string): number | undefined => {
  const value = (module as Record<string, unknown>)[name];
  return typeof value === "number" ? value : undefined;
};

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const owner = "cost-owner@example.com";
  await claimHandle(owner, "cost-home", "Cost Home", "");
  const made = await createStore(owner, "cost-spare", "Cost Spare", "");
  if (!made.ok) throw new Error("no second store");
  const spare = made.store;
  const communityId = (await setCommunity(storeRef(spare), true))!.community!.id;
  const ref = storeRef(spare);
  const [folder, pictures] = [await storeFolder(ref), await imageFolder(ref)];

  const pages = named(filesModule, "DELETED_STORE_LIST_PAGES");
  const batch = named(filesModule, "DELETED_STORE_DELETE_BATCH");
  const latePasses = named(lineModule, "FORGET_LATE_PASSES");
  const folders = (await deletedStoreFolders(spare.sid, communityId)).length;

  part("A per-store line prices every pass a deleted store's files can take");
  is("the registry's ceilings are exported by the code that keeps them", [pages !== undefined, batch !== undefined, latePasses !== undefined], [true, true, true]);
  const line = PER_PAYMENT_LINES.find((l) => l.id === "deleted-store-files");
  is("a per-payment line, deleted-store-files, is there", line !== undefined, true);
  // One pass at its most: each folder listed to the ceiling, a delete for each hundred files listed, at the paid
  // Advanced Operation price (a list, and a delete taken as one); its community's count forgotten (DEL) and the line's
  // write of a pass cut off by the deadline. The delete's own try and each of the line's are passes.
  const listPages = folders * (pages ?? NaN);
  const deleteCalls = (folders * (pages ?? NaN) * 1000) / (batch ?? NaN);
  const pass = (listPages + deleteCalls) * BLOB_ADVANCED_OPERATION + 2 * COMMAND;
  const passes = FORGET_TRIES + (latePasses ?? NaN);
  const priced = TIERS.map((tier) => line?.monthlyUsd(tier) ?? 0);
  is("it prices every pass, at every plan, never zero", priced.map((usd) => Number.isFinite(usd) && usd > 0 && Math.abs(usd - passes * pass) < 1e-12), TIERS.map(() => true));
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("and a store that never paid carries it too", registry.includes("+ deletedStoreFilesCost()"), true);

  part("One pass is held to the line's ceiling, on the real code");
  const fill = (prefix: string, count: number) => {
    for (let i = 0; i < count; i += 1) files.add(`${prefix}${String(i).padStart(6, "0")}.webp`);
  };
  const ceiling = (pages ?? 2) * 1000;
  fill(`images/${pictures}/`, ceiling);
  fill(`stores/${folder}/p1/`, 3);
  fill(`community/${communityFolder(communityId)}/`, 2);
  calls.listPages = 0;
  calls.deleteCalls = 0;
  const removed = await removeDeletedStoreFiles(spare.sid, communityId).catch(() => -1);
  is("a store at the ceiling: every file goes in one pass", [removed, files.size], [ceiling + 5, 0]);
  is("within the pages and the deletes the line prices", [calls.listPages <= listPages, calls.deleteCalls <= deleteCalls], [true, true]);

  fill(`images/${pictures}/`, ceiling + 1);
  calls.listPages = 0;
  calls.deleteCalls = 0;
  is("a folder past the ceiling fails the pass, so it is counted and finally given up and reported", await rejects(() => removeDeletedStoreFiles(spare.sid, communityId)), true);
  is("never listed past the ceiling, and nothing deleted from it", [calls.listPages <= listPages, calls.deleteCalls, files.size], [true, 0, ceiling + 1]);
  files.clear();

  part("A round of the line takes a bounded number of passes, cut off by the deadline or not");
  redis.clear();
  await queueStoreForget(null, spare.sid, Date.now(), communityId);
  let taken = 0;
  let runs = 0;
  const alwaysLate = async () => {
    taken += 1;
    throw new OutOfTime();
  };
  let gaveUp = 0;
  while (runs < 60 && gaveUp === 0) {
    runs += 1;
    gaveUp += (await retryStoreForgets(Date.now() + 10_000, Date.now(), alwaysLate)).gaveUp;
  }
  is("a store always cut off by the deadline is given up, after its late passes and its tries", [gaveUp, taken], [1, FORGET_TRIES - 1 + (latePasses ?? NaN)]);

  part("A round the closing walk starts after one was given up does not list files again");
  await queueStoreForget(null, spare.sid, Date.now(), communityId);
  const asked: unknown[] = [];
  await retryStoreForgets(Date.now() + 10_000, Date.now(), async (...args: unknown[]) => {
    asked.push(args[4]);
  });
  is("its try forgets the keys only", asked, [false]);
  await queueStoreForget(null, "0".repeat(32), Date.now(), null);
  asked.length = 0;
  await retryStoreForgets(Date.now() + 10_000, Date.now(), async (...args: unknown[]) => {
    asked.push(args[4]);
  });
  is("a store in its first round still has its files deleted", asked, [true]);

  part("The delete's first try lists with the same ceiling");
  const route = readFileSync("app/api/store/stores/route.ts", "utf8");
  is("forgetStoreFiles lists each folder to DELETED_STORE_LIST_PAGES at most", route.includes("await listFiles(prefix, DELETED_STORE_LIST_PAGES)"), true);
  done();
}

void main();
