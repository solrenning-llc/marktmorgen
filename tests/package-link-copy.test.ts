/**
 * A package booking link is kept before its email is attempted. The thanks
 * page must therefore describe the email as an attempt, in every buyer
 * language, even when the sender refuses it.
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { recordPackage } from "@/lib/call-packages";
import { thanksWords } from "@/lib/buyer-words/thanks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const address = "dana@example.com";
const expected = {
  en: {
    missing:
      "We could not get your booking link just now. Refresh this page in a moment. If the link was made, we also tried to email it.",
    sent: `We also tried to email the same link to ${address}. If it arrives, keep it: it is how you book the rest.`,
  },
  es: {
    missing:
      "No pudimos obtener tu enlace de reserva ahora mismo. Actualiza esta página en un momento. Si se creó el enlace, también intentamos enviártelo por email.",
    sent: `También intentamos enviar el mismo enlace por email a ${address}. Si llega, guárdalo: es como reservas las demás.`,
  },
  fr: {
    missing:
      "Nous n'avons pas pu obtenir votre lien de réservation pour l'instant. Actualisez cette page dans un instant. Si le lien a été créé, nous avons aussi essayé de vous l'envoyer par e-mail.",
    sent: `Nous avons aussi essayé d'envoyer le même lien par e-mail à ${address}. S'il arrive, gardez-le : c'est avec lui que vous réservez les autres.`,
  },
  de: {
    missing:
      "Wir konnten Ihren Buchungslink gerade nicht abrufen. Laden Sie diese Seite gleich neu. Falls der Link erstellt wurde, haben wir auch versucht, ihn Ihnen per E-Mail zu senden.",
    sent: `Wir haben auch versucht, denselben Link per E-Mail an ${address} zu senden. Falls er ankommt, bewahren Sie ihn auf: Damit buchen Sie die übrigen.`,
  },
  it: {
    missing:
      "Al momento non siamo riusciti a ottenere il tuo link di prenotazione. Aggiorna questa pagina tra un momento. Se il link è stato creato, abbiamo anche provato a inviartelo via email.",
    sent: `Abbiamo anche provato a inviare lo stesso link via email a ${address}. Se arriva, conservalo: è così che prenoti le altre.`,
  },
  nl: {
    missing:
      "We konden je boekingslink nu niet ophalen. Vernieuw deze pagina zo meteen. Als de link is gemaakt, hebben we ook geprobeerd hem naar je te e-mailen.",
    sent: `We hebben ook geprobeerd dezelfde link naar ${address} te e-mailen. Als hij aankomt, bewaar hem: daarmee boek je de rest.`,
  },
  pt: {
    missing:
      "Não conseguimos obter a sua ligação de marcação neste momento. Atualize esta página daqui a pouco. Se a ligação foi criada, também tentámos enviá-la por email.",
    sent: `Também tentámos enviar a mesma ligação por email para ${address}. Se chegar, guarde-a: é com ela que marca as restantes.`,
  },
} as const;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_packages_only";

  let refused = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com") {
      refused += 1;
      return new Response(JSON.stringify({ message: "refused" }), { status: 500 });
    }
    return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
  }) as typeof fetch;

  part("The sender can refuse after the booking link is kept");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", {
    customerId: "cus_Owner00001",
    subscriptionId: "sub_Owner00001",
    active: true,
    period: paidPeriod(),
  });
  const made = await addProduct("owner@example.com", "Coaching package", "", "500", null);
  if (!made.ok) throw new Error("product was not made");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const bought = await recordPackage({
    store,
    product,
    base: "https://marktmorgen.com/@harbor",
    from: '"Harbor Kitchen" <hello@marktmorgen.com>',
    session: {
      id: `cs_test_${"p".repeat(24)}`,
      status: "complete",
      payment_status: "paid",
      created: Math.floor(Date.now() / 1000),
      amount_total: 50000,
      currency: "usd",
      metadata: { store: "harbor", product: product.id, kind: "package", sessions: "5", days: "90" },
      customer_details: { email: address },
    },
  });
  is("the sender refused once", refused, 1);
  is("the booking link still exists", Boolean(bought?.token), true);

  part("The complete page phrases say only what that behavior proves");
  is("all seven buyer languages are covered", Object.keys(expected).sort(), ["de", "en", "es", "fr", "it", "nl", "pt"]);
  for (const [language, phrases] of Object.entries(expected)) {
    const words = thanksWords(language);
    is(`${language}: missing-link note`, words.noBookingLink, phrases.missing);
    is(`${language}: email note`, words.packageSameLink(address), phrases.sent);
  }

  done();
}

void main();
