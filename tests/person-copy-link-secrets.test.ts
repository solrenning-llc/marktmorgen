/**
 * The person's data copy (lib/person-copy.ts, GDPR art. 15) never carries a
 * secret that opens something in the person's name (C7 audit of the copy).
 *
 * Before, three sections were handed over as kept:
 *
 *   - an agreement's `id` is the secret in its signing link
 *     (lib/agreement-rules.ts): whoever held the file could sign as the
 *     person; with it went the store's `sid`, the linked payment request's
 *     secret (`payRequest`) and the internal reason an email failed;
 *   - a payment request's `id` is the secret in its pay link
 *     (lib/payment-request-rules.ts), with the store's `sid` and the last
 *     Stripe checkout opened for it (`session`);
 *   - a contact's `t` is the token in their unsubscribe link (lib/contacts.ts).
 *
 * The person has each link in the email that sent it, as the copy already
 * says of the booking link (lib/call-packages.ts) and the community
 * announcement link. What the record says about the person stays.
 *
 * Synthetic only: the Redis stand-in and a fetch stub.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/agreement-rules";
import { createAgreement } from "@/lib/agreement-store";
import { createRequest } from "@/lib/payment-request-store";
import { leadsKey } from "@/lib/contacts";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS } from "@/lib/person-copy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "copy-secrets@example.com";
const PERSON = "dana@example.com";
const UNSUB = "ab".repeat(20);

async function freshStore(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "copysecrets", "Secrets Coaching", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1CopySecretsxx", true);
  await setSubscription(OWNER, { customerId: "cus_copysecrets", subscriptionId: "sub_copysecrets", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

async function main(): Promise<void> {
  const store = await freshStore();
  const now = Date.now();

  const billed = await createRequest(store, { email: PERSON, name: "Dana", lines: [{ text: "Coaching, October", quantity: 1, cents: 48_000 }], note: "For October", dueDate: "", autoReminders: 0, total: 48_000 }, now);
  if (!billed.ok) throw new Error("payment request not made");
  const requestId = billed.request.id;

  const read = readDraft({ kind: "agreement", email: PERSON, name: "Dana Reyes", title: "Coaching", body: "Twelve calls.", lines: [], consent: true, payRequest: requestId }, "usd");
  if (!("draft" in read)) throw new Error("draft did not read");
  const made = await createAgreement(store, read.draft, now);
  if (!made.ok) throw new Error(made.message);
  const agreementId = made.agreement.id;

  await redis.pipeline([["HSET", leadsKey(store.listId!), PERSON, JSON.stringify({ agreed: true, agreedAt: "2026-10-01T00:00:00.000Z", firstAt: "2026-10-01T00:00:00.000Z", lastAt: "2026-10-01T00:00:00.000Z", titles: ["Coaching"], ids: [], source: "checkout", unsub: false, unsubAt: "", t: UNSUB, name: "Dana", tags: [], importedAt: "" })]]);

  const scope = (await erasureScope(store, PERSON))!;
  const section = async (module: string) => JSON.stringify(await COPIERS[module](scope));

  part("An agreement: what was agreed and signed, never its signing link's secret");
  {
    const copied = await section("lib/agreement-store.ts");
    is("the agreement is in the copy, with its version's text", [copied.includes("Twelve calls."), copied.includes("Dana Reyes")], [true, true]);
    is("its id, the secret in the signing link, is not", copied.includes(agreementId), false);
    is("nor the linked payment request's secret", copied.includes(requestId), false);
    is("nor the store's internal id", copied.includes(store.sid!), false);
  }

  part("A payment request: what was asked and its state, never its pay link's secret");
  {
    const copied = await section("lib/payment-request-store.ts");
    is("the request is in the copy, with its lines", [copied.includes("Coaching, October"), copied.includes("48000")], [true, true]);
    is("its id, the secret in the pay link, is not", copied.includes(requestId), false);
    is("nor the store's internal id", copied.includes(store.sid!), false);
  }

  part("A place on the list: whether they agreed, never the unsubscribe link's token");
  {
    const copied = await section("lib/contacts.ts");
    is("the contact is in the copy", [copied.includes(PERSON), copied.includes('"agreed":true')], [true, true]);
    is("the token in their unsubscribe link is not", copied.includes(UNSUB), false);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
