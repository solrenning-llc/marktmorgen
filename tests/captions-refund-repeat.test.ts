/**
 * The refunds of one AI captions payment are counted once each
 * (lib/billing.ts, refundsOnIntent; issue #4452): a list that repeats a
 * refund id cannot prove its rows are distinct, so it is unreadable (null)
 * and the debt stays in reconciliation, never closed on a doubled sum.
 * Synthetic data only.
 */
import { refundsOnIntent } from "@/lib/billing";
import { done, is, part } from "./check";

const PI = "pi_CaptionsRepeat0001";
let rows: unknown[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error("Unexpected synthetic host");
  const method = init?.method ?? "GET";
  if (method === "GET" && url.pathname === "/v1/payment_intents/" + PI) {
    return Response.json({ object: "payment_intent", id: PI, currency: "usd", amount_received: 8000 });
  }
  if (method === "GET" && url.pathname === "/v1/refunds") return Response.json({ object: "list", has_more: false, data: rows });
  throw new Error("Unexpected synthetic Stripe operation");
}) as typeof fetch;

const refund = (id: string, amount: number, status = "succeeded") => ({ id, object: "refund", payment_intent: PI, status, amount, currency: "usd" });

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_captions_refund_repeat_stand_in";

  part("A refund listed twice is never counted twice");
  const row = refund("re_SameRefund0001", 4000);
  rows = [row, row];
  is("a repeated refund id makes the list unreadable (null), never $80.00 returned", await refundsOnIntent(PI), null);
  rows = [row, { ...row }];
  is("a repeated id in two separate objects is unreadable too", await refundsOnIntent(PI), null);
  rows = [refund("re_SameRefund0001", 4000, "pending"), refund("re_SameRefund0001", 4000)];
  is("a repeated id with different statuses is unreadable", await refundsOnIntent(PI), null);

  part("Distinct refunds are still summed exactly");
  rows = [refund("re_SameRefund0001", 4000), refund("re_OtherRefund001", 4000)];
  is("two distinct $40.00 refunds return $80.00", await refundsOnIntent(PI), { returned: 8000, inFlight: 0, failed: 0, paid: 8000 });
  rows = [row];
  is("one $40.00 refund returns $40.00, so $40.00 is still owed", await refundsOnIntent(PI), { returned: 4000, inFlight: 0, failed: 0, paid: 8000 });

  part("A row whose id is not a refund id is unreadable");
  rows = [refund("", 4000)];
  is("an empty id is unreadable", await refundsOnIntent(PI), null);
  rows = [refund("ch_NotARefund0001", 4000)];
  is("a charge id is unreadable", await refundsOnIntent(PI), null);

  done();
}

void main();
