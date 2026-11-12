/**
 * Issue #4310 (money, rule 24): the members' paid periods a closing store keeps (lib/closing-holds.ts, paidPeriods)
 * were read leniently: an HGETALL reply in another shape read as no members, and a row that did not parse was left
 * out. On the closing day (lib/plan-closing.ts) that settled "nobody to give back to", marked the refunds done and
 * deleted the list, so those members never got their unused time back. Now either is unknown and throws, and the
 * refunds (giveBackUnused) are not settled on a guess: the closing stays held and tries again. Synthetic only.
 */
import { claimHandle, setStripeAccount, storeForEmail, storeFolder, storeRef } from "@/lib/store";
import { heldPaymentsOf, paidKey, paidPeriods } from "@/lib/closing-holds";
import { giveBackUnused } from "@/lib/closing-refunds";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Batch = (string | number)[][];
type Pipe = (b: Batch) => Promise<unknown[]>;
const DAY = Date.UTC(2026, 10, 20);
const S = Math.floor(DAY / 1000);

async function outcome<T>(work: () => Promise<T>): Promise<string> {
  try {
    const value = await work();
    return value instanceof Map ? `read ${value.size}` : `settled ${JSON.stringify(value)}`;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_paid_periods_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await setStripeAccount("owner@example.com", "acct_1ClosingPaid01", true);
  const store = (await storeForEmail("owner@example.com"))!;
  const key = paidKey(await storeFolder(storeRef(store)));
  const row = { inv: "in_ClosingPaid0001", amt: 3000, cur: "usd", ps: S - 10 * 86_400, pe: S + 20 * 86_400, e: "member@example.com" };
  await redis.pipeline([["HSET", key, "sub_ClosingPaid0001", JSON.stringify(row)]]);
  const real: Pipe = redis.pipeline.bind(redis);
  const answering = (reply: unknown): Pipe => async (b) => (b[0][0] === "HGETALL" && b[0][1] === key ? [reply] : real(b));
  const setPipe = (pipe: Pipe) => ((redis as unknown as { pipeline: Pipe }).pipeline = pipe);

  part("Control: a list that reads");
  is("the member is read", await outcome(() => paidPeriods(store)), "read 1");

  part("The list in another shape is unknown, never no members");
  for (const [what, reply] of [["text", "garbled"], ["a number", 7], ["an object", { a: 1 }], ["an odd list", ["sub_ClosingPaid0001"]]] as [string, unknown][]) {
    setPipe(answering(reply));
    try {
      is(`${what}: paidPeriods`, await outcome(() => paidPeriods(store)), "unknown");
      is(`${what}: the closing day's refunds are not settled as nothing to give`, await outcome(() => giveBackUnused(store, DAY, { final: true })), "unknown");
    } finally {
      setPipe(real);
    }
  }

  part("The person's copy of their data (lib/person-copy.ts) is never handed over with their payments silently missing");
  is("control: the member's own row is in their copy", await outcome(async () => new Map((await heldPaymentsOf(store, "member@example.com")).map((p) => [p.subscription, p]))), "read 1");
  setPipe(answering("garbled"));
  try {
    is("the list in another shape: unknown, so the copy fails rather than leave the payments out", await outcome(() => heldPaymentsOf(store, "member@example.com")), "unknown");
  } finally {
    setPipe(real);
  }
  await redis.pipeline([["HSET", key, "sub_ClosingPaid0003", "{not json"]]);
  is("a row that does not read: unknown (it could be theirs)", await outcome(() => heldPaymentsOf(store, "member@example.com")), "unknown");
  await redis.pipeline([["HDEL", key, "sub_ClosingPaid0003"]]);

  part("A member's row that does not read is unknown, never left out");
  for (const [what, value] of [["not JSON", "{not json"], ["no amount", JSON.stringify({ ...row, amt: "3000" })], ["no invoice", JSON.stringify({ ...row, inv: 7 })]] as [string, string][]) {
    await redis.pipeline([["HSET", key, "sub_ClosingPaid0002", value]]);
    is(`${what}: paidPeriods`, await outcome(() => paidPeriods(store)), "unknown");
  }
  await redis.pipeline([["HDEL", key, "sub_ClosingPaid0002"]]);
  is("control: with the row gone, the list reads again", await outcome(() => paidPeriods(store)), "read 1");

  done();
}

void main();
