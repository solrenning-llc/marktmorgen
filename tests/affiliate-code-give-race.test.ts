/**
 * Giving a discount code to an affiliate while the same code is taken back, or given for the first time twice at
 * once: the code's room in the store's data room is counted exactly once for as long as the code is held (Claude 2's
 * MEDIUM on #3300, lib/affiliate-codes.ts giveCode). Synthetic only: the in-memory Redis double, through the real
 * lib/affiliate-codes.ts.
 *
 * giveCode read HEXISTS, took room with needData only when the code was not held, then wrote it with HSET, in three
 * separate steps with no lock. A take-back of the same code landing between the HEXISTS (1, so no room taken) and the
 * HSET deleted the field and gave its room back, then the HSET wrote the field again: the code held, its room not
 * counted (dataUsed 0 instead of the code's bytes), as often as the creator repeats it, against the per-plan storage
 * ceiling. Two first gives at once both read HEXISTS 0 and took the room twice for one field, so the store could read
 * as full when it was not. Now whether the code is held, its room and the write are one step (GIVE_CODE), so neither
 * can happen.
 *
 * Controls: a new code takes room once, a move takes none, a take-back gives it back, a code that does not fit is
 * refused with DataRoomError and not written, and a move on a full store is still given.
 */
import { codeOwners, giveCode, takeCodeBack } from "@/lib/affiliate-codes";
import { DataRoomError, dataKey, dataUsed } from "@/lib/store-data";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "code-race@example.com";
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";
const CAL = "cccccccccccc";
const PROMO = "promo_1TestCodeRace0001";
const SECOND = "promo_1TestCodeRace0002";
const FULL = "promo_1TestCodeRace0003";

/**
 * Runs `cut` once, just before the give's write reaches Redis: the HSET on the codes hash (the old three steps) or the
 * one script that checks, counts and writes (GIVE_CODE). That is the last moment another request can land in.
 */
let cut: (() => Promise<void>) | null = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const write = commands.some((c) => (c[0] === "HSET" && /^nl:aff:[^:]+:promo$/.test(String(c[1]))) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:affiliate-code-give:")));
  if (write && cut) {
    const run = cut;
    cut = null;
    await run();
  }
  return real(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "coderace", "Code Race", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_coderace", subscriptionId: "sub_coderace", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const owner = async (promo: string) => (await codeOwners(store)).get(promo) ?? "";
  const used = async () => (await dataUsed(store))?.used ?? -1;

  part("Control: a new code takes room once, a move takes none, a take-back gives it back");
  const empty = await used();
  is("a new code is given to Ana", await giveCode(store, PROMO, ANA), true);
  const one = await used();
  is("it takes room", one > empty, true);
  is("moving it to Ben is given", await giveCode(store, PROMO, BEN), true);
  is("a move takes no room", await used(), one);
  is("taking it back is true", await takeCodeBack(store, PROMO), true);
  is("its room is given back", await used(), empty);

  part("A take-back of the same code just before the move is written: the code's room stays counted");
  is("the code is given to Ana again", await giveCode(store, PROMO, ANA), true);
  is("(its room is counted)", await used(), one);
  cut = async () => {
    is("(the take-back that lands in between removes the code)", await takeCodeBack(store, PROMO), true);
  };
  is("moving it to Ben is given", await giveCode(store, PROMO, BEN), true);
  is("(the take-back ran)", cut, null);
  is("the code is Ben's", await owner(PROMO), BEN);
  is("the code held has its room counted, not 0", await used(), one);
  is("taking it back gives the room back to where it started", await takeCodeBack(store, PROMO), true);
  is("nothing is left counted for a code nobody holds", await used(), empty);

  part("Repeating the race never leaves codes held with no room counted");
  for (let round = 1; round <= 3; round += 1) {
    is(`round ${round}: given to Ana`, await giveCode(store, PROMO, ANA), true);
    cut = async () => {
      await takeCodeBack(store, PROMO);
    };
    is(`round ${round}: moved to Ben with a take-back in between`, await giveCode(store, PROMO, BEN), true);
    is(`round ${round}: the code is Ben's and its room is counted`, [await owner(PROMO), await used()], [BEN, one]);
  }
  is("taken back after the rounds", await takeCodeBack(store, PROMO), true);
  is("the room is back where it started", await used(), empty);

  part("Two first gives of the same code at once: the room is taken once for the one field");
  cut = async () => {
    is("(the other first give, landing in between, is given)", await giveCode(store, SECOND, CAL), true);
  };
  is("the first give is given", await giveCode(store, SECOND, ANA), true);
  is("(the other give ran)", cut, null);
  is("one field, held by whichever wrote last", await owner(SECOND), ANA);
  is("its room is taken once, not twice", await used(), one);
  is("taking it back is true", await takeCodeBack(store, SECOND), true);
  is("the room is back where it started", await used(), empty);

  part("Control: a code that does not fit is refused and not written; a move on a full store is still given");
  is("a code is given to Ana", await giveCode(store, PROMO, ANA), true);
  const room = dataKey(store)!;
  const total = await real([["HGET", room, "#"]]);
  await real([["HSET", room, "#", 1_000_000_000_000]]);
  let refused = "";
  try {
    refused = `returned ${String(await giveCode(store, FULL, BEN))}`;
  } catch (error) {
    refused = error instanceof DataRoomError ? "DataRoomError" : `other: ${String(error)}`;
  }
  is("a fresh code on a full store throws DataRoomError", refused, "DataRoomError");
  is("and it is not written", await owner(FULL), "");
  is("a move on a full store takes no room and is given", await giveCode(store, PROMO, BEN), true);
  is("the code is Ben's", await owner(PROMO), BEN);
  await real([["HSET", room, "#", String((total as unknown[])[0])]]);
  is("(the room total is put back)", await used(), one);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
