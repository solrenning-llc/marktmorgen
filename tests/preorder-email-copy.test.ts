/**
 * A released pre-order is granted before its email is attempted. The page
 * therefore describes the durable purchase access and treats email as an
 * additional possibility, including when the sender refuses the request.
 */
import { preorderWords } from "@/lib/buyer-words/preorder";
import { importedKey } from "@/lib/imported-purchases";
import { confirmPreorder, readPreorder } from "@/lib/preorders";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "p".repeat(32);
const SESSION = "cs_test_preordercopy0001";
const PRODUCT = "breadbookcopy1";

const EXPECTED: Record<LanguageCode, string> = {
  en: "It is out now and it is yours. The way to open it is in your purchases; it may also reach you by email.",
  es: "Ya ha salido y es tuyo. La forma de abrirlo está en tus compras; también puede llegarte por email.",
  fr: "Il est sorti et il est à vous. Vous pouvez l'ouvrir depuis vos achats ; vous pouvez aussi recevoir le lien par e-mail.",
  de: "Es ist jetzt erschienen und gehört Ihnen. Sie können es über Ihre Käufe öffnen; der Zugang kann Sie auch per E-Mail erreichen.",
  it: "Ora è uscito ed è tuo. Puoi aprirlo dai tuoi acquisti; il modo per entrare può arrivarti anche via email.",
  nl: "Het is nu uit en het is van jou. Je kunt het vanuit je aankopen openen; de toegang kan je ook per e-mail bereiken.",
  pt: "Já saiu e é seu. Pode abri-lo a partir das suas compras; a forma de entrar também pode chegar-lhe por email.",
};

const store = {
  sid: "sidprecopy01",
  handle: "bakery",
  name: "Oven Notes",
  email: "owner@example.com",
  previousHandles: [],
  releasedHandles: [],
  statsId: STATS,
  currency: "usd",
  language: "en",
  stripeAccountId: "acct_test_preordercopy1",
  pastBuyers: true,
} as unknown as Store;

const product = {
  id: PRODUCT,
  title: "The Bread Book",
  priceCents: 2500,
  course: null,
} as unknown as Listing;

let senderRequests = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    senderRequests += 1;
    return new Response("refused", { status: 503 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_only";
  redis.clear();

  part("The seven released-preorder pages state durable access without claiming email success");
  for (const code of LANGUAGE_CODES) {
    const text = preorderWords(code).thanksOut;
    is(`${code}: complete released-preorder status`, text, EXPECTED[code]);
    is(`${code}: keeps ownership and email possibility`, [/e-?mail/i.test(text), !/undefined|NaN|\$\{|\[object/.test(text)], [true, true]);
  }

  part("Sender refusal does not undo the purchase access shown by the page");
  const outcome = await confirmPreorder(
    store,
    {
      id: SESSION,
      created: 1_794_000_000,
      status: "complete",
      payment_status: "paid",
      amount_total: 2500,
      currency: "usd",
      payment_intent: "pi_preordercopy0001",
      metadata: { store: "bakery", product: PRODUCT, preorder: "yes" },
      customer_details: { email: "ana@example.com" },
    } as Parameters<typeof confirmPreorder>[1],
    product,
    {
      base: "https://marktmorgen.com/@bakery",
      from: "Oven Notes <hello@example.com>",
      ordersLink: async () => "https://marktmorgen.com/@bakery/orders?for=ana%40example.com",
      recordStart: async () => {},
    },
  );
  const [granted] = await redis.pipeline([["HGET", importedKey(STATS, "ana@example.com"), PRODUCT]]);
  const kept = await readPreorder(store, PRODUCT, SESSION);
  is("release still completes after the sender refuses", outcome, "given");
  is("the sender really refused one request", senderRequests, 1);
  is("the purchase remains granted and marked given", [typeof granted === "string", Boolean(kept?.given)], [true, true]);

  done();
}

void main();
