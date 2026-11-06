/**
 * Sweep A3 proof (CX-123 rules 24, 28 and 30), synthetic only: the in-memory Redis double. lib/imported-purchases.ts:
 *
 * 1. forgetImportedPerson, lines 208-209: the DEL and HDEL replies summed with `Number(n) || 0`. An answer in an
 *    unknown shape is "0 deleted", never an error, so lib/person-erasure.ts (line 162, which records a part as
 *    failed only when it throws) says the person's purchases brought over were erased while they are kept.
 *    lib/learn.ts forgetLearnerPerson (lines 960-964) already throws for this (rule 30).
 * 2. importedBuyers, lines 77-78: an HGETALL that is not a list is "nobody was brought over". lib/closing-buyers.ts
 *    line 192 builds from it the list of buyers told that the store is closing, then moves on to "start" and never
 *    reads it again: buyers brought over from another platform lose their purchases without being told.
 * 3. importedFor, lines 136-137 (importedFrom/pairs): an answer in an unknown shape is "no purchases". lib/next-offer.ts
 *    line 154 (which promises "unknown means nothing is shown") then offers a product the buyer already owns.
 * 4. grantImported, line 182: a write answer of unknown shape is "already had it" (false). lib/api-write.ts line 216
 *    then tells the API caller "already" and sends no email, after the day's allowance was taken.
 */
import { forgetImportedPerson, grantImported, importedBuyers, importedFor, importedKey } from "@/lib/imported-purchases";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const malformAll = (match: (c: Command) => boolean, bad: unknown) => {
  redis.pipeline = (async (commands: Command[]) => (commands.length && commands.every(match) ? bad : real(commands))) as typeof redis.pipeline;
};
const restore = () => {
  redis.pipeline = real;
};
const STATS = "s".repeat(24);
const JOB = "a".repeat(24);
const store = { statsId: STATS, sid: "", pastBuyers: true } as unknown as Store;

async function main(): Promise<void> {
  redis.clear();
  part("Fixture: an import brought Ana and Ben over");
  await grantImported(STATS, JOB, [
    { email: "ana@example.com", productId: "guide", items: null },
    { email: "ben@example.com", productId: "guide", items: null },
  ], 1_800_000_000, "", null);
  is("both recorded", [(await importedFor(store, "ana@example.com")).length, (await importedBuyers(STATS)).size], [1, 2]);

  part("1. forgetImportedPerson: healthy control");
  is("Ana's record and mark are deleted (2)", await forgetImportedPerson(STATS, "ana@example.com"), 2);

  part("1. DEFECT: the DEL/HDEL replies in an unknown shape (here: not run, answered with no result)");
  malformAll((c) => c[0] === "DEL" || c[0] === "HDEL", [undefined, undefined]);
  let outcome: unknown;
  try {
    outcome = await forgetImportedPerson(STATS, "ben@example.com");
  } catch (error) {
    outcome = (error as Error).name;
  }
  restore();
  const still = (await real([["EXISTS", importedKey(STATS, "ben@example.com")]]))[0];
  is("DEFECT: answers 0 with no error (the erasure records it as done), Ben's purchases still kept", [outcome, still], [0, 1]);

  part("2. importedBuyers: healthy control and DEFECT");
  is("healthy: Ben is listed", [...(await importedBuyers(STATS)).keys()], ["ben@example.com"]);
  malformAll((c) => c[0] === "HGETALL", [{ unexpected: true }]);
  const told = await importedBuyers(STATS);
  restore();
  is("DEFECT: an unknown answer is an empty list of buyers to tell (no error)", told.size, 0);

  part("3. importedFor: healthy control and DEFECT");
  is("healthy: Ben owns the guide", (await importedFor(store, "ben@example.com")).map((p) => p.productId), ["guide"]);
  malformAll((c) => c[0] === "HGETALL", [7]);
  const owned = await importedFor(store, "ben@example.com");
  restore();
  is("DEFECT: an unknown answer is 'owns nothing' (no error)", owned, []);

  part("4. grantImported with the store's data room (the API's gift, an import): healthy control and DEFECT");
  const OWNER = "sweepa3imported@example.com";
  await claimHandle(OWNER, "sweepimported", "Sweep Imported", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_SweepImp0001", subscriptionId: "sub_SweepImp0001", active: true, period: paidPeriod() });
  const room = (await storeForEmail(OWNER))!;
  is("healthy: a new grant is new", await grantImported(room.statsId!, "api:k1", [{ email: "cy@example.com", productId: "guide", items: null }], 1_800_000_000, room.sid, room), [true]);
  malformAll((c) => c[0] === "HSETNX", [undefined]);
  const isNew = await grantImported(room.statsId!, "api:k1", [{ email: "dee@example.com", productId: "guide", items: null }], 1_800_000_000, room.sid, room);
  restore();
  is("DEFECT: a write answer of unknown shape is 'already had it' (false), no error", isNew, [false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
