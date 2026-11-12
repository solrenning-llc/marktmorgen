/**
 * A closing's written-down payments and members are read exactly (CX-123
 * rule 24, queue item 307 [EC1]): a reply to HGETALL that is not Redis's own
 * list (missing, null, text, an object, a list holding a non-string) is
 * unknown, never an empty hash.
 *
 * Before, lib/closing-holds.ts paidPeriods took any such reply as "no member
 * paid for time past the closing day". On the closing day giveBackUnused
 * then answered a settlement with nothing failed, lib/plan-closing.ts wrote
 * the refunds down as done and deleted the payments kept for them: members
 * who paid for time after the closing lost it with no refund and no email.
 * membersOf read the work hash the same way, so tellBuyers' first round told
 * no member, and moved past them for good. heldPaymentsOf, for the copy of
 * a person's data, read it the same way.
 *
 * Synthetic data only, in-memory Redis, a stand-in Stripe that answers only
 * the balance (no refund may be asked for on an unread list).
 */
import { giveBackUnused } from "@/lib/closing-refunds";
import { heldPaymentsOf, membersOf, paidKey, paidPeriods, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 20);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_paidreadexact";

let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  stripeCalls += 1;
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname.replace(/^\/v1/, "") === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

const pipe = redis.pipeline.bind(redis);
/** The reply the next HGETALL of `key` gets instead of Redis's own; `none` answers the pipeline with no reply at all. */
let forced: { key: string; value: unknown; none?: boolean } | null = null;
redis.pipeline = async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (forced && one && one[0] === "HGETALL" && one[1] === forced.key) return forced.none ? [] : [forced.value];
  return pipe(commands);
};

const outcome = (run: () => Promise<unknown>) =>
  run().then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }),
  );

const SHAPES: [string, unknown, boolean?][] = [
  ["no reply at all", undefined, true],
  ["null", null],
  ["text", "garbled"],
  ["an object", {}],
  ["a number", 3],
  ["a list holding a number", [SUB, 5]],
];

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paid_read_exact_synthetic";
  redis.clear();
  const email = "paid-read-exact@example.com";
  await claimHandle(email, "paidreadexact", "Paid read fixture", "");
  const shop = (await storeForEmail(email))!;
  const seller: Store = { ...shop, stripeAccountId: "acct_paidreadexact" };
  const folder = await storeFolder(email);
  const row = { inv: "in_paidreadexact", pi: "pi_paidreadexact", amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" };
  await pipe([
    ["HSET", paidKey(folder), SUB, JSON.stringify(row)],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10, `m:${SUB}`, "member@example.com"],
  ]);

  part("control: Redis's own replies still read");
  is("the kept payment reads", [...(await paidPeriods(seller)).keys()], [SUB]);
  is("the member's address reads", (await membersOf(folder)).emails, ["member@example.com"]);
  forced = { key: paidKey(folder), value: [] };
  is("an empty hash is no payment", (await outcome(() => paidPeriods(seller))), { ok: true, value: new Map() });

  for (const [label, value, none] of SHAPES) {
    part(`the payments kept for the closing answered as ${label}`);
    forced = { key: paidKey(folder), value, none };
    is("paidPeriods: unknown, never no member owed", await outcome(() => paidPeriods(seller)), { ok: false, error: "UnknownReplyError" });
    is("heldPaymentsOf: unknown, never nothing kept for the person", await outcome(() => heldPaymentsOf(seller, "member@example.com")), { ok: false, error: "UnknownReplyError" });
    stripeCalls = 0;
    const final = await outcome(() => giveBackUnused(seller, DAY, { final: true }));
    is("the closing day's refunds are not settled as nothing owed", final.ok, false);
    is("no refund is asked for on a list that was not read", stripeCalls, 0);

    part(`the closing's members answered as ${label}`);
    forced = { key: workKey(folder), value, none };
    is("membersOf: unknown, never no member", await outcome(() => membersOf(folder)), { ok: false, error: "UnknownReplyError" });
  }

  forced = null;
  part("the kept payment is untouched");
  const [kept] = await pipe([["HGET", paidKey(folder), SUB]]);
  is("still there, with no outcome written", JSON.parse(String(kept)).r ?? null, null);
  done();
}

void main();
