/**
 * A buyer's "where did you hear about us" answer (lib/heard.ts, recordHeard)
 * is counted with the sale's money. A paid checkout whose amount_total or
 * currency is missing or unreadable is unknown money, never a confirmed zero:
 * the answer is "unavailable", no done mark is left and nothing is counted, so
 * the same session read right later is counted with its real value (issue
 * #4389, Codex U). A sale in another currency still counts no money, as before.
 */
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { recordHeard } from "@/lib/heard";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_heard_amount_only";
const OWNER = "heard-amount@example.com";
let total: unknown = 2500;
let currency: unknown = "usd";
globalThis.fetch = (async (input: string | URL | Request) => {
  const id = decodeURIComponent(new URL(String(input)).pathname.split("/").pop() ?? "");
  return new Response(JSON.stringify({ id, status: "complete", payment_status: "paid", amount_total: total, currency, created: Math.floor(Date.now() / 1000) - 60, metadata: { store: "heardamount", product: "prod000001" } }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "heardamount", "Heard Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHeardAmount", true);
  const store = (await storeForEmail(OWNER))!;

  part("Control: a readable total is counted once");
  total = 2500;
  currency = "usd";
  is("counted", await recordHeard(store, "cs_test_heardamount0000000c", "friend"), "counted");
  is("then already", await recordHeard(store, "cs_test_heardamount0000000c", "friend"), "already");

  let n = 0;
  for (const [label, badTotal, badCurrency] of [
    ["amount_total as text", "2500", "usd"],
    ["amount_total missing", undefined, "usd"],
    ["amount_total negative", -5, "usd"],
    ["amount_total not whole", 12.5, "usd"],
    ["currency missing", 2500, undefined],
  ] as const) {
    n += 1;
    const session = `cs_test_heardamount000000${n}0`;
    part(label);
    total = badTotal;
    currency = badCurrency;
    is("unavailable, never a confirmed zero", await recordHeard(store, session, "friend"), "unavailable");
    is("no done mark left behind", redis.run(["EXISTS", `nl:heard:done:${session}`]), 0);
    total = 2500;
    currency = "usd";
    is("read right later: counted, not already", await recordHeard(store, session, "friend"), "counted");
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
