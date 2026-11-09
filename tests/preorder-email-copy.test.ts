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
const S = " ";

const EXPECTED: Record<LanguageCode, string> = {
  en: "It is out now. The way to open it may appear in your purchases or reach you by email.",
  es: "Ya ha salido. La forma de abrirlo puede aparecer en tus compras o llegarte por email.",
  fr: "Il est sorti. Le lien pour l'ouvrir peut apparaître dans vos achats ou vous parvenir par e-mail.",
  de: "Es ist jetzt erschienen. Der Zugang kann in Ihren Käufen erscheinen oder Sie per E-Mail erreichen.",
  it: "Ora è uscito. Il modo per aprirlo può apparire nei tuoi acquisti o arrivarti via email.",
  nl: "Het is nu uit. De toegang kan in je aankopen verschijnen of je per e-mail bereiken.",
  pt: "Já saiu. A forma de o abrir pode aparecer nas suas compras ou chegar-lhe por email.",
};

const WAITING_EXPECTED: Record<LanguageCode, readonly string[]> = {
  en: [
    "Paid today. The day it comes out, find it in your purchases. We also try to email the way to open it to the address you pay with.",
    "It is expected on DAY. The day it comes out, find it in your purchases. We also try to email ADDRESS the way to open it.",
    "It is expected on DAY. The day it comes out, find it in your purchases. We also try to email the way to open it to the address you paid with.",
    "It is expected on DAY. The day it comes out, find it in your purchases. We also try to email you here the way to open it.",
    "The day it comes out, find it in your purchases. We also try to email you here the way to open it.",
    "Pre-ordered. Expected on DAY; find it here when it comes out. We also try to email you.",
    "This is a pre-order. It opens the day it comes out; find it in your purchases. We also try to email you.",
  ],
  es: [
    "Pagas hoy. El día que salga, búscalo en tus compras. También intentamos enviar por email cómo abrirlo a la dirección con la que pagas.",
    "Está previsto para el DAY. El día que salga, búscalo en tus compras. También intentamos enviar a ADDRESS por email cómo abrirlo.",
    "Está previsto para el DAY. El día que salga, búscalo en tus compras. También intentamos enviar por email cómo abrirlo a la dirección con la que pagaste.",
    "Está previsto para el DAY. El día que salga, búscalo en tus compras. También intentamos enviarte aquí por email cómo abrirlo.",
    "El día que salga, búscalo en tus compras. También intentamos enviarte aquí por email cómo abrirlo.",
    "Reservado. Previsto para el DAY; búscalo aquí cuando salga. También intentamos enviarte un email.",
    "Esto es una reserva. Se abre el día que salga; búscala en tus compras. También intentamos enviarte un email.",
  ],
  fr: [
    `Payé aujourd'hui. Le jour de sa sortie, retrouvez-le dans vos achats. Nous essayons aussi d'envoyer par e-mail de quoi l'ouvrir à l'adresse avec laquelle vous payez.`,
    `Sa sortie est prévue le DAY. Le jour venu, retrouvez-le dans vos achats. Nous essayons aussi d'envoyer à ADDRESS par e-mail de quoi l'ouvrir.`,
    `Sa sortie est prévue le DAY. Le jour venu, retrouvez-le dans vos achats. Nous essayons aussi d'envoyer par e-mail de quoi l'ouvrir à l'adresse avec laquelle vous avez payé.`,
    `Sa sortie est prévue le DAY. Le jour venu, retrouvez-le dans vos achats. Nous essayons aussi de vous envoyer ici par e-mail de quoi l'ouvrir.`,
    `Le jour de sa sortie, retrouvez-le dans vos achats. Nous essayons aussi de vous envoyer ici par e-mail de quoi l'ouvrir.`,
    `Précommandé. Prévu le DAY${S}; retrouvez-le ici le jour de sa sortie. Nous essayons aussi de vous envoyer un e-mail.`,
    `Ceci est une précommande. Elle s'ouvre le jour de la sortie${S}; retrouvez-la dans vos achats. Nous essayons aussi de vous envoyer un e-mail.`,
  ],
  de: [
    "Heute bezahlt. Am Tag des Erscheinens finden Sie es in Ihren Käufen. Wir versuchen außerdem, den Zugang per E-Mail an die Adresse zu senden, mit der Sie bezahlen.",
    "Es wird am DAY erwartet. Am Tag des Erscheinens finden Sie es in Ihren Käufen. Wir versuchen außerdem, den Zugang per E-Mail an ADDRESS zu senden.",
    "Es wird am DAY erwartet. Am Tag des Erscheinens finden Sie es in Ihren Käufen. Wir versuchen außerdem, den Zugang per E-Mail an die Adresse zu senden, mit der Sie bezahlt haben.",
    "Es wird am DAY erwartet. Am Tag des Erscheinens finden Sie es in Ihren Käufen. Wir versuchen außerdem, Ihnen den Zugang hier per E-Mail zu senden.",
    "Am Tag des Erscheinens finden Sie es in Ihren Käufen. Wir versuchen außerdem, Ihnen den Zugang hier per E-Mail zu senden.",
    "Vorbestellt. Erwartet am DAY; am Tag des Erscheinens finden Sie es hier. Wir versuchen außerdem, Ihnen eine E-Mail zu senden.",
    "Das ist eine Vorbestellung. Sie öffnet sich am Tag des Erscheinens; Sie finden sie in Ihren Käufen. Wir versuchen außerdem, Ihnen eine E-Mail zu senden.",
  ],
  it: [
    "Paghi oggi. Il giorno in cui esce, cercalo nei tuoi acquisti. Proviamo anche a inviare via email il modo per aprirlo all'indirizzo con cui paghi.",
    "L'uscita è prevista il DAY. Il giorno in cui esce, cercalo nei tuoi acquisti. Proviamo anche a inviare a ADDRESS via email il modo per aprirlo.",
    "L'uscita è prevista il DAY. Il giorno in cui esce, cercalo nei tuoi acquisti. Proviamo anche a inviare via email il modo per aprirlo all'indirizzo con cui hai pagato.",
    "L'uscita è prevista il DAY. Il giorno in cui esce, cercalo nei tuoi acquisti. Proviamo anche a inviarti qui via email il modo per aprirlo.",
    "Il giorno in cui esce, cercalo nei tuoi acquisti. Proviamo anche a inviarti qui via email il modo per aprirlo.",
    "Preordinato. Uscita prevista il DAY; cercalo qui quando esce. Proviamo anche a inviarti un'email.",
    "Questo è un preordine. Si apre il giorno in cui esce; cercalo nei tuoi acquisti. Proviamo anche a inviarti un'email.",
  ],
  nl: [
    "Vandaag betaald. Op de dag dat het uitkomt, vind je het bij je aankopen. We proberen ook per e-mail te sturen hoe je het opent, naar het adres waarmee je betaalt.",
    "Het wordt verwacht op DAY. Op de dag dat het uitkomt, vind je het bij je aankopen. We proberen ook ADDRESS per e-mail te sturen hoe je het opent.",
    "Het wordt verwacht op DAY. Op de dag dat het uitkomt, vind je het bij je aankopen. We proberen ook per e-mail te sturen hoe je het opent, naar het adres waarmee je betaalde.",
    "Het wordt verwacht op DAY. Op de dag dat het uitkomt, vind je het bij je aankopen. We proberen je hier ook per e-mail te sturen hoe je het opent.",
    "Op de dag dat het uitkomt, vind je het bij je aankopen. We proberen je hier ook per e-mail te sturen hoe je het opent.",
    "Vooraf besteld. Verwacht op DAY; vind het hier wanneer het uitkomt. We proberen je ook een e-mail te sturen.",
    "Dit is een voorbestelling. Die gaat open op de dag dat het uitkomt; vind die bij je aankopen. We proberen je ook een e-mail te sturen.",
  ],
  pt: [
    "Paga hoje. No dia em que sair, encontre-o nas suas compras. Também tentamos enviar por email a forma de o abrir para o endereço com que paga.",
    "Está previsto para DAY. No dia em que sair, encontre-o nas suas compras. Também tentamos enviar para ADDRESS por email a forma de o abrir.",
    "Está previsto para DAY. No dia em que sair, encontre-o nas suas compras. Também tentamos enviar por email a forma de o abrir para o endereço com que pagou.",
    "Está previsto para DAY. No dia em que sair, encontre-o nas suas compras. Também tentamos enviar-lhe aqui por email a forma de o abrir.",
    "No dia em que sair, encontre-o nas suas compras. Também tentamos enviar-lhe aqui por email a forma de o abrir.",
    "Pré-encomendado. Previsto para DAY; encontre-o aqui quando sair. Também tentamos enviar-lhe um email.",
    "Isto é uma pré-encomenda. Abre no dia em que sair; encontre-a nas suas compras. Também tentamos enviar-lhe um email.",
  ],
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

  part("The seven waiting-preorder surfaces preserve purchase access and describe release email as an attempt");
  for (const code of LANGUAGE_CODES) {
    const words = preorderWords(code);
    const actual = [
      words.note,
      words.thanksWhen("DAY", "ADDRESS"),
      words.thanksWhenAddress("DAY"),
      words.receiptWhen("DAY"),
      words.receiptLater,
      words.ordersLine("DAY"),
      words.notYet,
    ];
    actual.forEach((text, index) => is(`${code}: waiting phrase ${index + 1}`, text, WAITING_EXPECTED[code][index]));
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
