/**
 * The repair of a broken move deletes the copy left behind only while the whole stored record is what the move
 * wrote (lib/store.ts settleDoubledStore; Claude 7's MEDIUM on #2271 @ acb27eeb28). The noted print is taken over
 * the record without its address, so a matching print alone does not prove the copy is untouched: a stored record
 * can carry a field the reader drops, or name another address, and still match. Such a copy is kept, null is
 * answered, and a person looks at it (scripts/move-repair.mjs).
 *
 * 1. the copy still as the move wrote it is deleted, although the store itself changed since (a Stripe answer)
 * 2. a copy whose print matches but whose stored record holds more than the reader keeps is not deleted
 * 3. a copy whose print matches but whose stored record names another address is not deleted
 * 4. a copy edited since (its name) is not deleted
 * 5. with no print noted, the old whole-record rule still settles two identical records
 *
 * Synthetic only: a stand-in Redis; the move is broken by refusing its last step, as a lost connection would.
 */
import { createHash } from "node:crypto";
import { claimHandle, moveAccount, setSubscription, settleDoubledStore, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const ownerKey = (email: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;

/** A move from `from` to `to` that writes the copy and then loses its last step: both records stay. Its noted print. */
async function brokenMove(from: string, to: string, handle: string): Promise<string> {
  await claimHandle(from, handle, `Store ${handle}`, "");
  const old = ownerKey(from);
  redis.pipeline = async (commands: Command[]) => {
    if (commands.some((command) => command[0] === "DEL" && command[1] === old)) throw new Error("connection lost");
    return real(commands);
  };
  let print = "";
  try {
    await moveAccount(from, to, async (noted) => {
      print = noted;
    }).catch(() => null);
  } finally {
    redis.pipeline = real;
  }
  return print;
}

async function raw(email: string): Promise<string> {
  const [value] = await real([["GET", ownerKey(email)]]);
  return String(value);
}

async function rewrite(email: string, change: (record: Record<string, unknown>) => void): Promise<void> {
  const record = JSON.parse(await raw(email)) as Record<string, unknown>;
  change(record);
  await real([["SET", ownerKey(email), JSON.stringify(record)]]);
}

const both = async (a: string, b: string) => [Boolean(await storeForEmail(a)), Boolean(await storeForEmail(b))];

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("1. the copy still as the move wrote it is deleted, though the store changed since");
  const A = "settle-a@example.com";
  const B = "settle-b@example.com";
  const printA = await brokenMove(A, B, "settle-one");
  is("(the move noted a print)", printA.length > 0, true);
  is("(both records are there)", await both(A, B), [true, true]);
  await setSubscription(A, { subscriptionId: "sub_Settle01", active: true });
  is("the repair keeps the store where its handle points", await settleDoubledStore(A, B, printA), A);
  is("and deletes the copy", await both(A, B), [true, false]);
  is("the change made since is kept", (await storeForEmail(A))?.subscriptionId, "sub_Settle01");

  part("2. a print that matches over a stored record holding more than the reader keeps: kept");
  const C = "settle-c@example.com";
  const D = "settle-d@example.com";
  const printC = await brokenMove(C, D, "settle-two");
  await rewrite(D, (record) => {
    record.keptByHand = "a note a person wrote on the copy";
  });
  is("the repair cannot tell, and answers null", await settleDoubledStore(C, D, printC), null);
  is("the copy is not deleted", await both(C, D), [true, true]);
  is("its stored record is as it was", (await raw(D)).includes("a note a person wrote on the copy"), true);

  part("3. a print that matches over a stored record naming another address: kept");
  const E = "settle-e@example.com";
  const F = "settle-f@example.com";
  const printE = await brokenMove(E, F, "settle-three");
  await rewrite(F, (record) => {
    record.email = "someone-else@example.com";
  });
  is("the repair cannot tell, and answers null", await settleDoubledStore(E, F, printE), null);
  is("the copy is not deleted", (await raw(F)).includes("someone-else@example.com"), true);

  part("4. a copy edited since is not deleted");
  const G = "settle-g@example.com";
  const H = "settle-h@example.com";
  const printG = await brokenMove(G, H, "settle-four");
  await rewrite(H, (record) => {
    record.name = "Renamed at the new address";
  });
  is("the repair answers null", await settleDoubledStore(G, H, printG), null);
  is("both records stay", await both(G, H), [true, true]);

  part("5. with no print noted, two records the same but for the address are settled as before");
  const I = "settle-i@example.com";
  const J = "settle-j@example.com";
  await brokenMove(I, J, "settle-five");
  is("the repair keeps the store where its handle points", await settleDoubledStore(I, J), I);
  is("and deletes the copy", await both(I, J), [true, false]);
  done();
}

void main();
