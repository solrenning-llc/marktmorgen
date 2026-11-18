/**
 * A usage notice the provider certainly refused is tried again by the next run (Claude 7's cron hunt).
 *
 * The daily usage watch writes to a creator once a month when their orders, visits or video hours reach their plan's
 * figure. It took the month's mark (nl:<meter>:told:<folder>:<month>, SET NX) before sending and kept it whatever the
 * send answered: a notice the provider refused (a certain "not sent") was never sent that month. The mark is now given
 * back on a certain refusal only, while it still holds this run's value; an answer that is not known (the provider
 * may have taken it) keeps it, so nothing is sent twice.
 *
 * Driven through the orders part, the one with nothing to measure first; the three parts share the same mark
 * (lib/usage-billing.ts). Synthetic store; Resend is a stand-in; real MemoryRedis.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { rememberFolderOwner } from "@/lib/delivery";
import { allowanceWindow, calendarWindow } from "@/lib/allowance-window";
import { paidOrdersLimitFor } from "@/lib/order-rules";
import { GET as usage } from "@/app/api/cron/usage/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
delete process.env.CRON_SECRET;

/** "refuse": the provider answers a certain refusal; "lose": it answers nothing that can be read; "accept": it takes it. */
let provider: "refuse" | "lose" | "accept" = "accept";
const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { subject?: string };
    if (!String(body.subject ?? "").includes("this billing month")) return new Response(JSON.stringify({ id: "email_other" }), { status: 200 });
    if (provider === "refuse") return new Response(JSON.stringify({ name: "validation_error", message: "The recipient was refused" }), { status: 422 });
    if (provider === "lose") throw new TypeError("Connection lost after the email was posted");
    sent.push(String(body.subject));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const run = () => usage({ headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof usage>[0]);
const quiet = async <T>(work: () => Promise<T>): Promise<T> => {
  const errors = console.error, logs = console.log;
  console.error = () => {};
  console.log = () => {};
  try { return await work(); } finally { console.error = errors; console.log = logs; }
};

async function storePastItsOrders(): Promise<void> {
  redis.clear();
  sent.length = 0;
  const OWNER = "owner@ordersword.example";
  await claimHandle(OWNER, "orders-word", "Orders Word", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1OrdersWordXXXX", true);
  await setSubscription(OWNER, { customerId: "cus_ordersword", subscriptionId: "sub_ordersword", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const folder = await storeFolder(storeRef(store));
  await rememberFolderOwner(folder, OWNER);
  const window = allowanceWindow(store)!.id;
  const limit = paidOrdersLimitFor(store)!;
  redis.run(["SADD", `nl:orders:folders:${calendarWindow().id}`, folder]);
  redis.run(["SET", `nl:orders:n:${folder}:${window}`, String(limit)]);
}

test("a notice the provider refused is sent by the next run", async () => {
  await storePastItsOrders();
  provider = "refuse";
  await quiet(run);
  assert.equal(sent.length, 0);
  provider = "accept";
  await quiet(run);
  assert.equal(sent.length, 1, "the next run writes to the creator");
  await quiet(run);
  assert.equal(sent.length, 1, "and once only");
});

test("control: a notice whose answer was lost is not sent again", async () => {
  await storePastItsOrders();
  provider = "lose";
  await quiet(run);
  provider = "accept";
  await quiet(run);
  assert.equal(sent.length, 0, "the provider may have taken it: the month's mark stands");
});
