import { requestWords } from "@/lib/buyer-words/requests";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { createRequest, markPaid, requestOf, sendReceipt } from "@/lib/payment-request-store";
import { readDraft } from "@/lib/payment-request-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const RECEIPT: Record<LanguageCode, string> = {
  en: "This page is your receipt.",
  es: "Esta página es tu recibo.",
  fr: "Cette page est votre reçu.",
  de: "Diese Seite ist deine Quittung.",
  it: "Questa pagina è la tua ricevuta.",
  nl: "Deze pagina is je ontvangstbewijs.",
  pt: "Esta página é o seu recibo.",
};

let attempted = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.resend.com") throw new Error(`Unexpected provider: ${url.hostname}`);
  attempted += 1;
  return Response.json({ message: "Synthetic rejection" }, { status: 400 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_payment_requests_only_a_stand_in";
  const owner = "owner@example.com";
  await claimHandle(owner, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Reqreceiptcopy", true);
  await setSubscription(owner, { customerId: "cus_ReceiptCopy01", subscriptionId: "sub_ReceiptCopy01", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const now = Date.now();
  const draft = readDraft({ email: "buyer@example.com", name: "Buyer", lines: [{ text: "Guide", quantity: 1, amount: "12" }], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", now);
  if (!draft.ok) throw new Error("Synthetic draft refused");
  const created = await createRequest(store, draft.draft, now);
  if (!created.ok) throw new Error(`Synthetic request refused: ${created.reason}`);
  const paid = await markPaid(store, created.request.id, { id: "cs_test_ReceiptCopy00000001", payment_intent: "pi_ReceiptCopy0001", amount_total: 1200, created: Math.floor(now / 1000) }, now);
  if (!paid) throw new Error("Synthetic paid evidence refused");
  is("payment is recorded before the receipt attempt", [paid.fresh, paid.request.state, paid.request.amountPaid], [true, "paid", 1200]);

  part("A paid request still has its page receipt when the email is refused");
  for (const code of LANGUAGE_CODES) {
    is(`${code}: real receipt sender reports refusal`, await sendReceipt({ store: { ...store, language: code }, request: paid.request, base: "https://example.com/@harbor", from: "Synthetic <store@example.com>", idempotencyKey: `receipt-copy-${code}` }), false);
    is(`${code}: refusal does not undo the recorded payment`, (await requestOf(store, paid.request.id))?.state, "paid");
    const text = requestWords(code).paidBody("$12", store.name, "November 4, 2026");
    is(`${code}: identifies the page receipt without claiming email acceptance`, text.endsWith(RECEIPT[code]), true);
    is(`${code}: retains amount, store and payment date`, ["$12", store.name, "November 4, 2026"].every((value) => text.includes(value)), true);
  }
  is("each synthetic provider refusal was actually exercised once", attempted, LANGUAGE_CODES.length);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
