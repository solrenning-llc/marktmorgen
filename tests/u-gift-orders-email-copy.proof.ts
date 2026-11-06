/**
 * Evidence that the buyer's order page makes a recipient email the way to
 * open a gift even when the real sender refuses that email. The gift already
 * belongs to the recipient and remains available through their purchases.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { ordersWords } from "@/lib/buyer-words/orders";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { deliverGift, startGift } from "@/lib/gifts";
import { importedFor } from "@/lib/imported-purchases";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const recipient = "friend@example.com";
const buyer = "buyer@example.com";

const honestGiftProblem: Record<LanguageCode, string> = {
  en: "This was a gift. The person it is for already has it in their purchases. We also tried to email them a link to open it.",
  es: "Esto fue un regalo. La persona a quien va dirigido ya lo tiene en sus compras. También intentamos enviarle por email un enlace para abrirlo.",
  fr: "C'était un cadeau\u00a0: la personne à qui il est destiné l'a déjà dans ses achats. Nous avons aussi essayé de lui envoyer par e-mail un lien pour l'ouvrir.",
  de: "Dies war ein Geschenk. Die beschenkte Person hat es bereits in ihren Käufen. Wir haben außerdem versucht, ihr per E-Mail einen Link zum Öffnen zu schicken.",
  it: "Questo era un regalo. La persona a cui è destinato lo ha già nei suoi acquisti. Abbiamo anche provato a inviarle via email un link per aprirlo.",
  nl: "Dit was een cadeau. Degene voor wie het is, heeft het al bij de aankopen. We hebben ook geprobeerd per e-mail een link te sturen om het te openen.",
  pt: "Isto foi um presente. A pessoa a quem se destina já o tem nas suas compras. Também tentámos enviar-lhe por email uma ligação para o abrir.",
};

const giftWord: Record<LanguageCode, RegExp> = {
  en: /gift/i,
  es: /regalo/i,
  fr: /cadeau/i,
  de: /Geschenk/i,
  it: /regalo/i,
  nl: /cadeau/i,
  pt: /presente/i,
};

part("The gift notice keeps access independent from an attempted email");
is("all seven buyer languages remain covered", LANGUAGE_CODES.length, 7);
for (const language of LANGUAGE_CODES) {
  const actual = ordersWords(language).downloadProblems.gift;
  is(`${language}: the page does not certify a sent email or make it the only way in`, actual, honestGiftProblem[language]);
  is(`${language}: the notice still says this order was a gift`, giftWord[language].test(actual), true);
}

type Mail = { to: string[]; subject: string; text: string };
const attempts: { mail: Mail; accepted: boolean }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.resend.com") return new Response("not found", { status: 404 });
  const mail = JSON.parse(String(init?.body)) as Mail;
  const accepted = attempts.length > 0;
  attempts.push({ mail, accepted });
  return accepted
    ? new Response(JSON.stringify({ id: "email_receipt_accepted" }))
    : new Response(JSON.stringify({ message: "recipient refused" }), { status: 503 });
}) as typeof fetch;

async function runtimeProof(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_receipt_copy_only";
  process.env.RESEND_API_KEY = "re_test_gifts_only";

  await claimHandle("owner@example.com", "harbor", "Gift Copy", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", {
    customerId: "cus_Owner00001",
    subscriptionId: "sub_Owner00001",
    active: true,
    period: paidPeriod(),
  });
  const made = await addProduct("owner@example.com", "Bread Notes", "", "29", null);
  if (!made.ok) throw new Error("the proof product was not created");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/bread-notes");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const started = await startGift(store, product, { to: recipient, from: "Ana", message: "Enjoy it." });
  if (!started.ok) throw new Error("the proof gift was not created");

  const outcome = await deliverGift({
    store,
    product,
    session: {
      id: `cs_test_${"g".repeat(24)}`,
      created: 1_900_000_000,
      amount_total: 2_900,
      currency: "usd",
      payment_intent: "pi_GiftReceipt001",
      metadata: { store: store.handle, product: product.id, gift: started.gift.id },
      customer_details: { email: buyer },
    },
    base: `https://marktmorgen.com/@${store.handle}`,
    from: '"Gift Copy" <hello@marktmorgen.com>',
    recordStart: async () => {},
    ordersLink: async () => `https://marktmorgen.com/@${store.handle}/orders?token=${"a".repeat(64)}`,
  });

  part("A refused recipient email does not undo the gift");
  is("the gift is handed over before the email outcome", outcome, "given");
  const refreshed = (await storeForEmail("owner@example.com"))!;
  is("the recipient keeps the paid gift in their purchases", (await importedFor(refreshed, recipient)).map((row) => row.productId), [product.id]);
  is("the real sender was tried exactly twice", attempts.length, 2);
  is("the recipient attempt was refused", [attempts[0]?.mail.to[0], attempts[0]?.accepted], [recipient, false]);
  is("the buyer receipt was accepted next", [attempts[1]?.mail.to[0], attempts[1]?.accepted], [buyer, true]);
  is("the buyer receipt still names the recipient", attempts[1]?.mail.text.includes(`For: ${recipient}`), true);
}

void runtimeProof().then(done);
