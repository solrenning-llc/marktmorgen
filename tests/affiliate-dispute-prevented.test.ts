/**
 * A dispute Stripe closed as `prevented` takes an affiliate's commission only when its own money left the creator
 * and did not come back (lib/affiliates.ts takenSince, with disputeTakes from lib/retained-revenue.ts; rule 24,
 * money).
 *
 * The defect this file was written around: the affiliate book counted every `prevented` dispute as money taken,
 * because DISPUTE_TAKES lists the state with no condition. Every other reader (lib/refunds.ts, lib/share-settle.ts,
 * lib/stats.ts) asks disputeTakes, which reads a prevented dispute's own balance transactions. Stripe's `prevented`
 * is either a block by the card network, where the creator keeps the money, or a resolution refunded before it became
 * a chargeback, whose money left through a Refund the refund reading already takes off. So:
 *
 *   - a blocked dispute (no balance transaction) took the whole commission of a sale whose money the creator kept;
 *   - a resolution refunded in part counted its Refund and the dispute's amount, taking the money back twice.
 *
 * Checked: a prevented dispute with no money moved, or withdrawn and put back, leaves the commission; one whose money
 * left takes it; one whose money cannot be read holds the book; a resolution with a Refund counts the Refund once;
 * a lost dispute still takes it (control).
 */
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_dispute_prevented_only";
process.env.RESEND_API_KEY = "re_test_affiliate_dispute_prevented_only";

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const PI = "pi_cs_one";

const list = (data: unknown[] = []) => ({ object: "list", data, has_more: false });
let refundPage: unknown = list();
let disputePage: unknown = list();
let writes = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (init?.method && init.method !== "GET") writes += 1;
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname === "/v1/refunds") return answer(refundPage);
  if (url.pathname === "/v1/disputes") return answer(disputePage);
  return answer(list());
}) as typeof fetch;

const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" });
const sale = (ref: string) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff: ANA, at: NOW - 3600, product: "prod01", title: "Rye course", base: 10_000, total: 10_000, currency: "usd", rate: 30, self: false, how: "click" });
const move = (amount: number) => ({ id: `txn_${amount < 0 ? "out" : "in"}`, object: "balance_transaction", amount, currency: "usd" });
const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_one", object: "dispute", status: "prevented", payment_intent: PI, amount: 10_000, currency: "usd", created: NOW, balance_transactions: [], ...over });
const refund = (over: Record<string, unknown> = {}) => ({ id: "re_one", object: "refund", status: "succeeded", payment_intent: PI, amount: 4_000, currency: "usd", ...over });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "rye", "Rye Mill", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPrevented1", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_one", sale("cs_one")],
  ]);
  const state = async () => {
    const book = await readBook(store);
    const one = book.lines.find((l) => l.ref === "cs_one");
    return { checked: book.refundsChecked, one: [one?.status, one?.commission] };
  };

  part("A prevented dispute whose money the creator kept takes nothing");
  disputePage = list([dispute()]);
  is("blocked by the network, no money moved: the full commission, checked", await state(), { checked: true, one: ["earned", 3_000] });
  disputePage = list([dispute({ balance_transactions: [move(-10_000), move(10_000)] })]);
  is("withdrawn and put back in full: the full commission, checked", await state(), { checked: true, one: ["earned", 3_000] });

  part("A prevented dispute whose money left takes it");
  disputePage = list([dispute({ balance_transactions: [move(-10_000)] })]);
  is("withdrawn and not put back: no commission, checked", await state(), { checked: true, one: ["refunded", 0] });

  part("A prevented dispute whose money cannot be read holds the book");
  for (const [what, moves] of [["no balance transactions field", undefined], ["a list of three", [move(-1), move(-1), move(-1)]], ["an amount in text", [{ ...move(-10_000), amount: "-10000" }]]] as [string, unknown][]) {
    disputePage = list([dispute({ balance_transactions: moves })]);
    is(`a prevented dispute with ${what}: not checked`, (await state()).checked, false);
  }

  part("A resolution refunded in part is counted once, by its Refund");
  refundPage = list([refund()]);
  disputePage = list([dispute({ amount: 4_000 })]);
  is("a $40 Refund and the prevented dispute it resolved: 30% of $60 kept, checked", await state(), { checked: true, one: ["partly refunded", 1_800] });
  refundPage = list();

  part("Control: a lost dispute still takes the commission");
  disputePage = list([dispute({ status: "lost", balance_transactions: [move(-10_000)] })]);
  is("a lost dispute: no commission, checked", await state(), { checked: true, one: ["refunded", 0] });
  disputePage = list([dispute({ status: "lost", balance_transactions: undefined })]);
  is("a lost dispute is lost whatever its balance transactions say: no commission, checked", await state(), { checked: true, one: ["refunded", 0] });
  disputePage = list();

  is("nothing was written to Stripe", writes, 0);
  done();
}

void main();
