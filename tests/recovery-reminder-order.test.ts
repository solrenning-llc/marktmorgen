/**
 * A recovered renewal is credited to the reminder email only with evidence
 * that the email went out before the payment (lib/payment-recovery-report.ts,
 * recoveryReport): the first reminder's mark starts with the time it was taken
 * (lib/claim-mark.ts). A mark taken after the invoice's paid_at is not that
 * evidence, and with one attempt the renewal is not recovered at all; a legacy
 * mark "1" says an email went out but not when, so it is not credited either.
 * A retried renewal is still counted as recovered (issue #4431, Codex X8).
 */
import { recoveryReport } from "@/lib/payment-recovery-report";
import { sentKey } from "@/lib/dunning-keys";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const now = Date.UTC(2026, 10, 5, 1);
const paidAt = now / 1000 - 60;
const store = { handle: "recovery-order", previousHandles: [], releasedHandles: [], stripeAccountId: "acct_test_recovery_order", statsId: "e".repeat(32), currency: "usd" } as unknown as Store;
const invoice = (attempts: number) => ({ id: "in_order", currency: "usd", amount_paid: 4200, attempt_count: attempts, paid_out_of_band: false, billing_reason: "subscription_cycle", status_transitions: { paid_at: paidAt }, parent: { subscription_details: { metadata: { store: store.handle } } } });
let invoices: unknown[] = [];
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: invoices, has_more: false }), { status: 200 })) as typeof fetch;

async function report(attempts: number, mark: string | null) {
  redis.clear();
  invoices = [invoice(attempts)];
  if (mark !== null) redis.run(["SET", sentKey(store.stripeAccountId!, "in_order"), mark]);
  const r = await recoveryReport(store, true, now);
  return [r?.recovered, r?.cents, r?.afterEmail, r?.afterEmailCents];
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recovery_order_only";
  part("Control: the reminder went out before the payment");
  is("one attempt, mark before paid_at: recovered after the email", await report(1, `${now - 120_000}.123456789`), [1, 4200, 1, 4200]);

  part("The reminder's mark was taken after the payment");
  is("one attempt: not recovered, not credited to the email", await report(1, `${now - 50_000}.123456789`), [0, 0, 0, 0]);
  is("retried: recovered, but not after the email", await report(2, `${now - 50_000}.123456789`), [1, 4200, 0, 0]);

  part("A legacy mark \"1\": an email went out, but not when");
  is("one attempt: not recovered", await report(1, "1"), [0, 0, 0, 0]);
  is("retried: recovered, not credited to the email", await report(2, "1"), [1, 4200, 0, 0]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
