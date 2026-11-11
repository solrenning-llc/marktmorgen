/**
 * A package booking link is kept before its email is attempted, but the
 * thanks page can also render when no attempt was made. Its unconditional
 * copy must therefore describe email as a possibility in every language.
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
      "We could not get your booking link just now. Refresh this page in a moment. If an email with the link reaches you, keep it to book the rest.",
    sent: `The same link may reach ${address} by email. If it does, keep it: it is how you book the rest.`,
  },
  es: {
    missing:
      "No pudimos obtener tu enlace de reserva ahora mismo. Actualiza esta página en un momento. Si recibes un email con el enlace, guárdalo para reservar las demás.",
    sent: `El mismo enlace puede llegar por email a ${address}. Si llega, guárdalo: es como reservas las demás.`,
  },
  fr: {
    missing:
      "Nous n'avons pas pu obtenir votre lien de réservation pour l'instant. Actualisez cette page dans un instant. Si vous recevez un e-mail contenant le lien, gardez-le pour réserver les autres séances.",
    sent: `Le même lien peut arriver par e-mail à ${address}. S'il arrive, gardez-le : c'est avec lui que vous réservez les autres.`,
  },
  de: {
    missing:
      "Wir konnten Ihren Buchungslink gerade nicht abrufen. Laden Sie diese Seite gleich neu. Falls Sie eine E-Mail mit dem Link erhalten, bewahren Sie ihn auf, um die übrigen Termine zu buchen.",
    sent: `Derselbe Link kann per E-Mail an ${address} ankommen. Falls er ankommt, bewahren Sie ihn auf: Damit buchen Sie die übrigen.`,
  },
  it: {
    missing:
      "Al momento non siamo riusciti a ottenere il tuo link di prenotazione. Aggiorna questa pagina tra un momento. Se ricevi un'email con il link, conservalo per prenotare le altre sessioni.",
    sent: `Lo stesso link potrebbe arrivare via email a ${address}. Se arriva, conservalo: è così che prenoti le altre.`,
  },
  nl: {
    missing:
      "We konden je boekingslink nu niet ophalen. Vernieuw deze pagina zo meteen. Als je een e-mail met de link ontvangt, bewaar hem dan om de rest te boeken.",
    sent: `Dezelfde link kan per e-mail aankomen op ${address}. Als hij aankomt, bewaar hem: daarmee boek je de rest.`,
  },
  pt: {
    missing:
      "Não conseguimos obter a sua ligação de marcação neste momento. Atualize esta página daqui a pouco. Se receber um email com a ligação, guarde-a para marcar as restantes sessões.",
    sent: `A mesma ligação pode chegar por email a ${address}. Se chegar, guarde-a: é com ela que marca as restantes.`,
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

  const noAddress = await recordPackage({
    store,
    product,
    base: "https://marktmorgen.com/@harbor",
    from: '"Harbor Kitchen" <hello@marktmorgen.com>',
    session: {
      id: `cs_test_${"n".repeat(24)}`,
      status: "complete",
      payment_status: "paid",
      amount_total: 50000,
      currency: "usd",
      metadata: { store: "harbor", product: product.id, kind: "package", sessions: "5", days: "90" },
      customer_details: null,
    },
  });
  is("no package record is made without a buyer address", noAddress, null);
  is("the missing-address path does not attempt the sender", refused, 1);

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
