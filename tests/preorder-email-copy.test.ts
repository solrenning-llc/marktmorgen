/**
 * A released pre-order can be shown before its deferred hand-over runs. The
 * page therefore treats both purchase access and email as possibilities. The
 * release path still proves that sender refusal does not undo a later grant.
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
  en: "It is out now. The way to open it may appear in your purchases or reach you by email.",
  es: "Ya ha salido. La forma de abrirlo puede aparecer en tus compras o llegarte por email.",
  fr: "Il est sorti. Le lien pour l'ouvrir peut apparaître dans vos achats ou vous parvenir par e-mail.",
  de: "Es ist jetzt erschienen. Der Zugang kann in Ihren Käufen erscheinen oder Sie per E-Mail erreichen.",
  it: "Ora è uscito. Il modo per aprirlo può apparire nei tuoi acquisti o arrivarti via email.",
  nl: "Het is nu uit. De toegang kan in je aankopen verschijnen of je per e-mail bereiken.",
  pt: "Já saiu. A forma de o abrir pode aparecer nas suas compras ou chegar-lhe por email.",
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
