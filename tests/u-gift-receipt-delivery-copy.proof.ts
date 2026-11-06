/**
 * Evidence that a gift buyer's receipt says the recipient was emailed even
 * when the recipient message was refused and only the buyer's receipt was
 * accepted. The gift itself still belongs to the recipient.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { givingWords } from "@/lib/buyer-words/giving";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { deliverGift, startGift } from "@/lib/gifts";
import { importedFor } from "@/lib/imported-purchases";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const recipient = "friend@example.com";
const buyer = "buyer@example.com";

const honestReceipt: Record<LanguageCode, string> = {
  en: `We tried to email ${recipient} just now, with your name and your message and a link to open it. If the email reaches them, they can use that link. The gift is already theirs, on their address; you do not get a copy.`,
  es: `Acabamos de intentar enviar un email a ${recipient} con tu nombre, tu mensaje y un enlace para abrirlo. Si le llega, puede usar ese enlace. El regalo ya es suyo, en su dirección; tú no recibes una copia.`,
  fr: `Nous venons d'essayer d'envoyer un e-mail à ${recipient}, avec votre nom, votre message et un lien pour l'ouvrir. Si l'e-mail lui parvient, cette personne peut utiliser ce lien. Le cadeau est déjà à elle, sur son adresse; vous ne recevez pas de copie.`,
  de: `Wir haben gerade versucht, ${recipient} eine E-Mail mit Ihrem Namen, Ihrer Nachricht und einem Link zum Öffnen zu schicken. Falls die E-Mail ankommt, kann die beschenkte Person den Link verwenden. Das Geschenk gehört ihr bereits, unter ihrer Adresse; Sie erhalten keine Kopie.`,
  it: `Abbiamo appena provato a inviare un'email a ${recipient}, con il tuo nome, il tuo messaggio e un link per aprirlo. Se l'email arriva, la persona può usare quel link. Il regalo è già suo, sul suo indirizzo; tu non ne ricevi una copia.`,
  nl: `We hebben zojuist geprobeerd ${recipient} te e-mailen, met je naam, je bericht en een link om het te openen. Als de e-mail aankomt, kan de ontvanger die link gebruiken. Het cadeau is al van de ontvanger, op diens adres; jij krijgt geen kopie.`,
  pt: `Acabámos de tentar enviar um email para ${recipient}, com o seu nome, a sua mensagem e uma ligação para o abrir. Se o email lhe chegar, a pessoa pode usar essa ligação. O presente já é dela, no endereço dela; não recebe uma cópia.`,
};

part("A gift receipt describes the recipient email as an attempt");
is("the product still has all seven buyer languages", LANGUAGE_CODES.length, 7);
for (const language of LANGUAGE_CODES) {
  const actual = givingWords(language).weEmailed(recipient, true);
  is(`${language}: the receipt does not certify recipient email delivery`, actual, honestReceipt[language]);
  is(`${language}: the receipt keeps the recipient address`, actual.includes(recipient), true);
  is(`${language}: the receipt keeps the buyer's message in scope`, /message|mensaje|Nachricht|messaggio|bericht|mensagem/i.test(actual), true);
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

  part("A refused recipient email does not undo access or stop the buyer receipt");
  is("the gift is handed over before email outcome", outcome, "given");
  const refreshed = (await storeForEmail("owner@example.com"))!;
  is("the recipient keeps the paid gift", (await importedFor(refreshed, recipient)).map((row) => row.productId), [product.id]);
  is("the real sender was tried exactly twice", attempts.length, 2);
  is("the recipient attempt was refused", [attempts[0]?.mail.to[0], attempts[0]?.accepted], [recipient, false]);
  is("the buyer receipt was accepted next", [attempts[1]?.mail.to[0], attempts[1]?.accepted], [buyer, true]);
  is("the accepted receipt still certifies the refused attempt", attempts[1]?.mail.text.includes(`We emailed ${recipient} just now`), true);
  is("the receipt keeps the paid amount", attempts[1]?.mail.text.includes("$29"), true);
  is("the receipt keeps the gift recipient", attempts[1]?.mail.text.includes(`For: ${recipient}`), true);
}

void runtimeProof().then(done);
