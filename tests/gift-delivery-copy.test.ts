import { readFileSync } from "node:fs";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const STORE = "Harbor Kitchen";
const EXPECTED: Record<LanguageCode, string> = {
  en: `You pay on Stripe's page. After payment, the gift belongs to their address. If the one email from ${STORE} reaches them, it has your name, your message and a link to open it. You get the receipt, not a copy.`,
  es: `Pagas en la página de Stripe. Después del pago, el regalo queda en su dirección. Si le llega el único email de ${STORE}, contiene tu nombre, tu mensaje y un enlace para abrirlo. Tú recibes el recibo, no una copia.`,
  fr: `Vous payez sur la page de Stripe. Après le paiement, le cadeau est associé à son adresse. Si l'e-mail unique de ${STORE} lui parvient, il contient votre nom, votre message et un lien pour l'ouvrir. Vous recevez le reçu, pas une copie.`,
  de: `Sie bezahlen auf der Seite von Stripe. Nach der Zahlung gehört das Geschenk zu ihrer Adresse. Falls die einzige E-Mail von ${STORE} sie erreicht, enthält sie Ihren Namen, Ihre Nachricht und einen Link zum Öffnen. Sie erhalten die Quittung, keine Kopie.`,
  it: `Paghi sulla pagina di Stripe. Dopo il pagamento, il regalo appartiene al suo indirizzo. Se le arriva l'unica email da ${STORE}, contiene il tuo nome, il tuo messaggio e un link per aprirlo. Tu ricevi la ricevuta, non una copia.`,
  nl: `Je betaalt op de pagina van Stripe. Na betaling hoort het cadeau bij het adres van de ontvanger. Als de ene e-mail van ${STORE} aankomt, bevat die je naam, je bericht en een link om het te openen. Jij krijgt de bon, geen kopie.`,
  pt: `Paga na página da Stripe. Depois do pagamento, o presente fica associado ao endereço da pessoa. Se o único email de ${STORE} lhe chegar, contém o seu nome, a sua mensagem e uma ligação para o abrir. Fica com o recibo, não com uma cópia.`,
};

part("Gift copy does not promise inbox delivery immediately after payment");
is("all seven buyer languages remain present", LANGUAGE_CODES.length, 7);
for (const code of LANGUAGE_CODES) {
  const text = wordsIn(code).giftNote(STORE);
  is(`${code}: renders the complete gift note`, text, EXPECTED[code]);
  is(`${code}: keeps the store name`, text.includes(STORE), true);
  is(`${code}: resolves every interpolation`, /undefined|NaN|\$\{|\[object/.test(text), false);
}

const source = readFileSync("lib/gifts.ts", "utf8");
const grant = source.indexOf("await grantImported");
const email = source.indexOf("await sendEmail", grant);
is("the paid gift belongs to the recipient before email is attempted", grant >= 0 && email > grant, true);
is("a refused gift email is logged without taking the gift back", source.includes('}).catch((error) => console.error("a gift email failed", error));'), true);
is("the gift sender has no inbox-delivery event", /delivered|delivery event|inbox event/i.test(source.slice(email, source.indexOf("const buyer", email))), false);
done();
