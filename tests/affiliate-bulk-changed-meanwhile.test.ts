/**
 * A change in bulk that meets somebody changed by hand while it ran (#2995, Claude 2's money review of b67ec8f5,
 * LEVE). Synthetic only: the in-memory Redis double and the real lib/affiliates.ts; the hand change runs at a chosen
 * studio-request take, exactly as another tab would between the batch's read and its write.
 *
 * Before: the person changed meanwhile had no result, so the batch left them as "unavailable" and the studio said
 * "is still waiting. We could not check it just now" (approve) or "keeps their share. We could not check it" (share),
 * which is false: they were declined, approved or given another share by hand. An undo counted them as "could not be
 * put back just now. Press Undo again", which cannot help.
 *
 * Now: they are left out as "changed", said as such, and an undo counts them as changed since, never as "try again".
 * The same in each path that meets it: under the partner lock (decideMany's shares, changeRates' raises) and the plain
 * write over the record the batch read (decideMany, undoMany, changeRates' lowerings).
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type Charge, decideMany, readAffiliate, setRatesMany, undoMany, undoRates } from "@/lib/affiliates";
import { heldLines, readHeld, undoWords } from "@/lib/affiliate-bulk-words";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_bulk_changed_meanwhile";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);

/** Pays every take; on the `at`-th take (1-based), first runs `hand`: another tab's change. */
function chargeWith(at: number, hand: () => Promise<void>): Charge {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === at) await hand();
    return { give: async () => {}, force: async () => {} };
  };
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "changer@example.com";
  await claimHandle(owner, "changershop", "Changer store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1changershop77", true);
  await setSubscription(owner, { customerId: "cus_changer", subscriptionId: "sub_changer", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Cedar Course", "", "40");
  const P = made.ok ? made.product.id : "";
  const store = async () => (await storeForEmail(owner))!;
  await setAffiliateSetting(owner, { ...(await store()).affiliates, enabled: true, percent: 10, rates: {} });
  const people = `nl:aff:${(await store()).statsId}:people`;
  const person = (id: string, status: string, rate: number | null, share: { percent: number; products: string[] } | null = null) =>
    JSON.stringify({ id, email: `${id}@example.com`, code: `c${id}`, status, appliedAt: 1, decidedAt: 1, note: "", rate, paypal: "", share, cleared: null, by: null });
  const byHand = (id: string, status: string, rate: number | null, share: { percent: number; products: string[] } | null = null) => async () => {
    await real([["HSET", people, id, person(id, status, rate, share)]]);
  };
  const statusOf = async (id: string) => (await readAffiliate(await store(), id))?.status;
  const rateOf = async (id: string) => (await readAffiliate(await store(), id))?.rate;
  const misleading = (lines: string[]) => lines.some((line) => /still waiting|could not check|keeps their share/.test(line));

  part("1. Approving a partner who is declined by hand between the batch's read and the partner lock");
  const S = "5a5a5a5a5a5a";
  await real([["HSET", people, S, person(S, "pending", null, { percent: 20, products: [P] })]]);
  // Takes: 1 the batch's read, 2 its writes, 3 the partner lock and the store.
  const shared = await decideMany(await store(), [S], "approve", chargeWith(3, byHand(S, "declined", null, { percent: 20, products: [P] })));
  const sharedLines = heldLines(readHeld(shared.held), "approve");
  is("(the hand decline stands)", await statusOf(S), "declined");
  is("nothing is said approved", shared.before.length, 0);
  is("they are left out as changed meanwhile, never as could not be checked", shared.held.map((one) => [one.id, one.why]), [[S, "changed"]]);
  is("the studio does not say they are still waiting or that we could not check", misleading(sharedLines), false);

  part("2. Declining an application that is approved by hand between the batch's read and its write");
  const D = "dec11dedec11";
  await real([["HSET", people, D, person(D, "pending", null)]]);
  // Takes: 1 the batch's read, 2 its writes (the write runs right after).
  const plain = await decideMany(await store(), [D], "decline", chargeWith(2, byHand(D, "approved", null)));
  is("(the hand approval stands)", await statusOf(D), "approved");
  is("left out as changed meanwhile", plain.held.map((one) => [one.id, one.why]), [[D, "changed"]]);
  is("the studio does not say they are still waiting or that we could not check", misleading(heldLines(readHeld(plain.held), "approve")), false);

  part("3. Undoing a bulk decision when one was changed by hand between the undo's read and its write");
  const U = "0d00d00d00d0";
  await real([["HSET", people, U, person(U, "pending", null)]]);
  const decided = await decideMany(await store(), [U], "decline");
  is("(declined in bulk)", [decided.before.length, await statusOf(U)], [1, "declined"]);
  // Takes: 1 the undo's read, 2 its writes.
  const undone = await undoMany(await store(), decided.before, "decline", Date.now(), chargeWith(2, byHand(U, "approved", null)));
  is("(the hand approval stands)", await statusOf(U), "approved");
  is("nothing put back and nobody counted as to try again (changed since)", [undone.undone, undone.left], [0, 0]);
  is("the undo does not ask to press Undo again", /Press Undo again/.test(undoWords(undone.undone, undone.left, "approve")), false);

  part("4. Raising shares when one is declined by hand between the batch's read and the partner lock");
  const R = "ae15eae15eae";
  await real([["HSET", people, R, person(R, "approved", null)]]);
  // Takes: 1 the batch's read, 2 its writes, 3 the partner lock and the store.
  const raised = await setRatesMany(await store(), [R], 40, chargeWith(3, byHand(R, "declined", null)));
  is("(nothing written over the hand decline)", [await statusOf(R), await rateOf(R)], ["declined", null]);
  is("left out as changed meanwhile", raised?.refused.map((one) => [one.id, one.why]), [[R, "changed"]]);
  is("the studio does not say they keep their share for a check we could not make", misleading(heldLines(readHeld(raised?.refused ?? []), "rate")), false);

  part("5. Undoing a share change when one was given another share by hand meanwhile");
  const W = "0d0ae0d0ae00";
  await real([["HSET", people, W, person(W, "approved", 15)]]);
  const raisedW = await setRatesMany(await store(), [W], 30);
  is("(raised to 30 in bulk)", [raisedW?.before, await rateOf(W)], [[{ id: W, rate: 15 }], 30]);
  // Putting 15 back lowers it: the plain write. Takes: 1 the read, 2 the writes.
  const back = await undoRates(await store(), raisedW?.before ?? [], 30, chargeWith(2, byHand(W, "approved", 25)));
  is("(the hand share stands)", await rateOf(W), 25);
  is("nothing put back and nobody counted as to try again (changed since)", [back.undone, back.left], [0, 0]);
  const up = "0b0b0b0b0b0b";
  await real([["HSET", people, up, person(up, "approved", 35)]]);
  const cut = await setRatesMany(await store(), [up], 20);
  is("(lowered to 20 in bulk)", [cut?.before, await rateOf(up)], [[{ id: up, rate: 35 }], 20]);
  // Putting 35 back raises it: judged under the partner lock. Takes: 1 the read, 2 the writes, 3 the lock.
  const raiseBack = await undoRates(await store(), cut?.before ?? [], 20, chargeWith(3, byHand(up, "approved", 12)));
  is("(the hand share stands)", await rateOf(up), 12);
  is("a raise put back meets the hand change: changed since, not to try again", [raiseBack.undone, raiseBack.left], [0, 0]);

  part("6. Controls: nothing changed meanwhile");
  const C = "c0c0c0c0c0c0";
  await real([["HSET", people, C, person(C, "pending", null, { percent: 20, products: [P] })]]);
  const fine = await decideMany(await store(), [C], "approve");
  is("approved, nobody left out", [fine.before.map((one) => one.id), fine.held, await statusOf(C)], [[C], [], "approved"]);
}

main().then(done);
