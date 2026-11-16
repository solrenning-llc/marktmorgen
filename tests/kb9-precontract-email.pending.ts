/**
 * PENDING, not run by tests/run.mjs (it runs *.test.ts only): unit 2b's
 * RED, moved byte for byte from tests/kb9-precontract.test.ts. It waits for
 * lib/purchase-email.ts, reserved by another unit; rename it to
 * tests/kb9-precontract-email.test.ts when that unit starts.
 *
 * The EU withdrawal function's pre-contract information (queue item 588
 * [KB9], unit 2, added 6 November 2026; Directive 2011/83/EU art. 6(1)(h)
 * and Annex I instruction 3 as amended by Directive (EU) 2023/2673, read in
 * docs/kb9-eu-withdrawal-2026-11-06.md, "Proposed units", item 2).
 *
 * The buyer is told, before and after the contract, where the online
 * withdrawal function is ("information about the existence and placement of
 * the withdrawal function referred to in Article 11a"). Checked:
 *
 *   - before the contract (held in tests/kb9-precontract.test.ts, not here):
 *     the membership box's sentence names the function by its own label
 *     (lib/buyer-words/withdrawal.ts, withdrawLink); the digital box keeps
 *     its 2026-10-30.2 words and does not; and one conditional line outside
 *     both sentences (withdrawal words, checkoutWhere) says where it is,
 *     beside every box and, where there is none (shipped items), in its place;
 *   - the order confirmation email (lib/purchase-email.ts, confirmationFor,
 *     called here with synthetic data) of an order still inside its
 *     withdrawal period carries the label in the store's language beside a
 *     link to the store's /orders list or /orders/withdraw page; one with no
 *     right left (digital content whose buyer gave the art. 16(m) yes, already
 *     handed over) carries neither.
 *
 * Synthetic store and orders only; no email is sent and Stripe is never
 * reached (any call is answered 404).
 */
import { withdrawalWords } from "@/lib/buyer-words/withdrawal";
import { CONSENT_META, consentMetaValue } from "@/lib/digital-consent";
import { confirmationFor, storeBase } from "@/lib/purchase-email";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
  new Response(JSON.stringify({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${String(input)}` } }), { status: 404 })) as typeof fetch;

const LANGUAGES = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;
const OWNER = "precontract@example.com";

/** The confirmation's lines that name the function, each with the line after it (the link may sit on its own line). */
function functionLinks(text: string, label: string, base: string): { named: boolean; linked: boolean } {
  const lines = text.split("\n");
  const at = lines.flatMap((line, index) => (line.includes(label) ? [index] : []));
  const link = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/orders(/withdraw)?(\\?|\\s|$)`);
  return { named: at.length > 0, linked: at.some((index) => link.test(lines[index]) || link.test(lines[index + 1] ?? "")) };
}

async function main(): Promise<void> {
  redis.clear();

  part("The confirmation email says where it is, while the period runs");
  await claimHandle(OWNER, "precontract", "Precontract Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPrecontr01", true);
  await setSubscription(OWNER, { customerId: "cus_Precontr001", subscriptionId: "sub_Precontr001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  const pack = await addProduct(OWNER, "Recipe pack", "", "27", null);
  if (!club.ok || !pack.ok) throw new Error("no products");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setProductLink(OWNER, pack.product.id, "https://example.com/pack");
  const store = (await storeForEmail(OWNER))!;
  const membership = (await readListing(store, club.product.id))!;
  const digital = (await readListing(store, pack.product.id))!;
  const base = storeBase(store);
  const now = Math.floor(Date.now() / 1000);
  const settled = (product: string, meta: Record<string, string>, mode = "payment") => ({
    id: `cs_test_${"k".repeat(24)}`,
    status: "complete",
    payment_status: "paid",
    mode,
    created: now,
    amount_total: 2000,
    currency: "usd",
    customer_details: { email: "buyer@example.com" },
    metadata: { store: store.handle, product, ...meta },
  });
  const letter = (language: string, session: ReturnType<typeof settled>, listing: typeof membership) =>
    confirmationFor({ ...store, language: language as typeof store.language }, session, now, [], [listing])?.text ?? "";

  // A membership joined today: the 14 days run (lib/withdrawal-rules.ts, withdrawalWindow; the yes never ends a membership's right).
  const joined = settled(club.product.id, { [CONSENT_META]: consentMetaValue(TEST_CONSENT, "membership") }, "subscription");
  is("a membership joined today: the email is sent", letter("en", joined, membership).length > 0, true);
  is(
    "it names the function by its label, in the store's language, with a link to the store's list of purchases or the withdrawal page",
    LANGUAGES.map((lang) => [lang, functionLinks(letter(lang, joined, membership), withdrawalWords(lang).withdrawLink, base)]),
    LANGUAGES.map((lang) => [lang, { named: true, linked: true }]),
  );

  // Digital content with the art. 16(m) yes, handed over at once: no right left, so no function to point to.
  const opened = settled(pack.product.id, { [CONSENT_META]: consentMetaValue(TEST_CONSENT, "digital") });
  is("digital content opened at once with the yes: the email is sent", letter("en", opened, digital).length > 0, true);
  is(
    "and it never offers the function, in any language",
    LANGUAGES.map((lang) => [lang, letter(lang, opened, digital).includes(withdrawalWords(lang).withdrawLink)]),
    LANGUAGES.map((lang) => [lang, false]),
  );

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});