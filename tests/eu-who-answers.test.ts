/**
 * Who answers for what, said to the buyer before paying (Directive 2011/83/EU
 * art. 6a(1)(d), as amended by Directive (EU) 2019/2161: "where applicable,
 * how the obligations related to the contract are shared between the third
 * party offering the goods, services or digital content and the provider of
 * the online marketplace"). The Terms (app/terms/page.tsx, section 3) make the
 * creator the seller, not Marktmorgen, and leave the product, answering
 * buyers, refunds and any refund on a cancellation to the creator; the Refund
 * Policy (app/refunds/page.tsx, section 7) says the same to buyers. Checked,
 * on synthetic records only, with no network:
 *
 *   - the product page, drawn as a browser gets it, says that sentence next
 *     to the line on who takes the payment, in every store language;
 *   - the store page and the booking page draw it next to the same line.
 */
import { readFileSync } from "node:fs";
import { renderToReadableStream } from "react-dom/server";
import ProductPage from "@/app/[handle]/p/[product]/page";
import { addProduct, claimHandle, ensureStatsId, setLanguage, setProductLink, setStripeAccount, setSubscription } from "@/lib/store";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "harbor@example.com";
const STORE = "Harbor Kitchen";

/** The sentence, word for word, in each store language. */
const SAID: Record<LanguageCode, string> = {
  en: `${STORE} is the seller and answers for what you buy, for refunds and for any right you have to cancel. Marktmorgen hosts the store and its checkout and is not part of the sale.`,
  es: `${STORE} es quien vende y responde de lo que compras, de los reembolsos y de cualquier derecho de desistimiento que tengas. Marktmorgen aloja la tienda y su página de pago, y no es parte de la venta.`,
  fr: `${STORE} est le vendeur et répond de ce que vous achetez, des remboursements et de tout droit de rétractation dont vous disposez. Marktmorgen héberge la boutique et sa page de paiement, et n'est pas partie à la vente.`,
  de: `${STORE} ist der Verkäufer und verantwortlich für das, was Sie kaufen, für Erstattungen und für ein etwaiges Widerrufsrecht. Marktmorgen stellt den Shop und den Bezahlvorgang bereit und ist nicht Partei des Kaufvertrags.`,
  it: `${STORE} è il venditore e risponde di ciò che compri, dei rimborsi e di ogni diritto di recesso che hai. Marktmorgen ospita il negozio e la pagina di pagamento e non è parte della vendita.`,
  nl: `${STORE} is de verkoper en is verantwoordelijk voor wat je koopt, voor terugbetalingen en voor een eventueel herroepingsrecht. Marktmorgen host de winkel en de betaalpagina en is geen partij bij de verkoop.`,
  pt: `${STORE} é o vendedor e responde pelo que compra, pelos reembolsos e por qualquer direito de livre resolução que tenha. A Marktmorgen aloja a loja e a página de pagamento e não é parte na venda.`,
};

/** No call leaves the test: every request is recorded and answered with an empty list. */
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  calls.push(new URL(String(input instanceof Request ? input.url : input)).hostname);
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

/** The page's text as a reader gets it: tags dropped, entities read back. */
function textOf(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function drawn(product: string): Promise<string> {
  answering(new Request(`https://marktmorgen.com/@harbor/p/${product}`));
  const node = await ProductPage({ params: Promise.resolve({ handle: "@harbor", product }), searchParams: Promise.resolve({}) } as Parameters<typeof ProductPage>[0]);
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return textOf(await new Response(stream).text());
}

async function main(): Promise<void> {
  redis.clear();
  // A key of the live shape so the page is not in Stripe's test mode; no request reaches Stripe (fetch above).
  process.env.STRIPE_SECRET_KEY = "sk_live_eu_who_answers_stand_in";
  const made = await claimHandle(OWNER, "harbor", STORE, "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestEuWhoAns1", true);
  await setSubscription(OWNER, { customerId: "cus_EuWhoAns01", subscriptionId: "sub_EuWhoAns01", active: true, tier: "creator", period: paidPeriod() });
  const added = await addProduct(OWNER, "Meal Planner", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(OWNER, added.product.id, "https://example.com/planner");

  part("The product page, before paying, in every store language");
  for (const code of LANGUAGE_CODES) {
    await setLanguage(OWNER, code);
    const text = await drawn(added.product.id);
    is(`${code}: the line on who takes the payment is drawn`, text.includes(wordsIn(code).paidBy("Stripe", STORE)), true);
    is(`${code}: who answers for what, word for word`, text.includes(SAID[code]), true);
  }

  part("Next to the same line on the store page and the booking page");
  for (const file of ["app/[handle]/page.tsx", "app/[handle]/p/[product]/page.tsx", "app/[handle]/book/[product]/page.tsx"]) {
    const source = readFileSync(file, "utf8");
    const paid = source.indexOf("{w.paidBy(");
    const who = source.indexOf("{w.whoAnswers(store.name)}");
    is(`${file}: drawn right after the payment line`, paid > 0 && who > paid && who - paid < 400, true);
  }

  part("Nothing left the test");
  is("no request reached Stripe or anyone", calls.filter((host) => !host.endsWith("example.com")), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
