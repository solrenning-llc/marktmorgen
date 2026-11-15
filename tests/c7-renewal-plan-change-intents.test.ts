/**
 * Merge of main into #4549 (15 November 2026): main counts a membership's plan change charged at once
 * ("subscription_update") with its renewals (paidAfterCheckout, MM-E2E-SUB-1), and this PR confirms a refund or a
 * dispute as the store's only through the payments of the invoices it counts (renewalPaymentIntents; Claude 1 cloud R's
 * MÉDIO). Both read the same invoices now: a plan change's payment is the store's, as a renewal's is, and a "manual"
 * invoice or another store's never is. Pure; synthetic invoices only.
 */
import { renewalPaymentIntents } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const store = { handle: "harbor", previousHandles: [], releasedHandles: [] } as unknown as Store;
const invoice = (id: string, reason: string, storeHandle = "harbor", status = "paid") =>
  ({ id, status, billing_reason: reason, payment_intent: `pi_${id}`, subscription_details: { metadata: { store: storeHandle } }, metadata: { store: storeHandle } });

part("The payments renewalPaymentIntents confirms are those of the invoices the renewals count");
const intents = renewalPaymentIntents(store, [
  invoice("cycle", "subscription_cycle"),
  invoice("change", "subscription_update"),
  invoice("manual", "manual"),
  invoice("first", "subscription_create"),
  invoice("other", "subscription_cycle", "elsewhere"),
  invoice("open", "subscription_update", "harbor", "open"),
]);
is("a renewal's payment is the store's", intents.has("pi_cycle"), true);
is("a plan change charged at once is the store's too", intents.has("pi_change"), true);
is("a manual invoice never is", intents.has("pi_manual"), false);
is("the checkout's own first invoice is not a renewal", intents.has("pi_first"), false);
is("another store's never is", intents.has("pi_other"), false);
is("an unpaid one never is", intents.has("pi_open"), false);
done();
