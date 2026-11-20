/**
 * The words of a physical product a creator ships (lib/shipping.ts,
 * lib/shipments.ts), in every language a store sells in: on its page, on
 * Stripe's page, after paying, and in the email that says it has shipped.
 * Browser-safe.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const S = " ";

const en = {
  /** On Stripe's page, as the shipping line. */
  rate: "Shipping",
  freeRate: "Free shipping",
  /** On the product's page, under the price. */
  cost: (amount: string) => `+ ${amount} shipping`,
  free: "Free shipping",
  shipsTo: (where: string) => `Ships to: ${where}`,
  and: "and",
  more: (n: number) => `and ${n} more ${n === 1 ? "country" : "countries"}`,
  everywhere: "most countries",
  /** Everywhere but the EU/EEA, while the product's safety information is not filled (lib/physical-legal-ship.ts). */
  everywhereElse: "most countries, except for now the European Union, Iceland, Liechtenstein and Norway",
  // After paying, on the page and in the email.
  goingTo: "Shipping to",
  shipsBy: (store: string) => `${store} ships it and emails you when it is on its way.`,
  /** A second product shipped in the same order, in its own box after paying (lib/cart-shipping.ts). */
  alsoShips: (store: string) => `${store} ships it with the rest of your order, to the same address.`,
  // When the creator marks it as shipped.
  shippedSubject: (title: string) => `${title} is on its way`,
  shippedLead: (title: string, store: string) => `${store} has shipped ${title}.`,
  track: "Follow it here:",
  shippedTo: "It is going to:",
  shippedWhy: (store: string) => `You are getting this because you bought it from ${store}. Questions about it: reply to this email.`,
};

export type ShippingWords = typeof en;

const es: ShippingWords = {
  rate: "Envío",
  freeRate: "Envío gratis",
  cost: (amount) => `+ ${amount} de envío`,
  free: "Envío gratis",
  shipsTo: (where) => `Envíos a: ${where}`,
  and: "y",
  more: (n) => `y ${n} ${n === 1 ? "país más" : "países más"}`,
  everywhere: "la mayoría de los países",
  everywhereElse: "la mayoría de los países, por ahora sin la Unión Europea, Islandia, Liechtenstein y Noruega",
  goingTo: "Se envía a",
  shipsBy: (store) => `${store} lo envía y te escribe cuando esté en camino.`,
  alsoShips: (store) => `${store} lo envía con el resto de tu pedido, a la misma dirección.`,
  shippedSubject: (title) => `${title} está en camino`,
  shippedLead: (title, store) => `${store} ha enviado ${title}.`,
  track: "Síguelo aquí:",
  shippedTo: "Va a:",
  shippedWhy: (store) => `Te llega porque lo compraste en ${store}. Si tienes preguntas, responde a este correo.`,
};

const fr: ShippingWords = {
  rate: "Livraison",
  freeRate: "Livraison gratuite",
  cost: (amount) => `+ ${amount} de livraison`,
  free: "Livraison gratuite",
  shipsTo: (where) => `Pays de livraison${S}: ${where}`,
  and: "et",
  more: (n) => `et ${n}${S}${n === 1 ? "autre pays" : "autres pays"}`,
  everywhere: "la plupart des pays",
  everywhereElse: "la plupart des pays, sauf pour l'instant l'Union européenne, l'Islande, le Liechtenstein et la Norvège",
  goingTo: "Livraison à",
  shipsBy: (store) => `${store} l'expédie et vous écrit quand il est en route.`,
  alsoShips: (store) => `${store} l'expédie avec le reste de votre commande, à la même adresse.`,
  shippedSubject: (title) => `${title} est en route`,
  shippedLead: (title, store) => `${store} a expédié ${title}.`,
  track: `Suivez-le ici${S}:`,
  shippedTo: `Il est envoyé à${S}:`,
  shippedWhy: (store) => `Vous recevez ce message parce que vous l'avez acheté chez ${store}. Une question${S}? Répondez à cet e-mail.`,
};

const de: ShippingWords = {
  rate: "Versand",
  freeRate: "Kostenloser Versand",
  cost: (amount) => `+ ${amount} Versand`,
  free: "Kostenloser Versand",
  shipsTo: (where) => `Lieferländer: ${where}`,
  and: "und",
  more: (n) => `und ${n} ${n === 1 ? "weiteres Land" : "weitere Länder"}`,
  everywhere: "die meisten Länder",
  everywhereElse: "die meisten Länder, vorerst ohne die Europäische Union, Island, Liechtenstein und Norwegen",
  goingTo: "Versand an",
  shipsBy: (store) => `${store} verschickt es und schreibt Ihnen, sobald es unterwegs ist.`,
  alsoShips: (store) => `${store} verschickt es mit dem Rest Ihrer Bestellung an dieselbe Adresse.`,
  shippedSubject: (title) => `${title} ist unterwegs`,
  shippedLead: (title, store) => `${store} hat ${title} verschickt.`,
  track: "Hier können Sie es verfolgen:",
  shippedTo: "Es geht an:",
  shippedWhy: (store) => `Sie erhalten diese E-Mail, weil Sie es bei ${store} gekauft haben. Fragen dazu? Antworten Sie auf diese E-Mail.`,
};

const it: ShippingWords = {
  rate: "Spedizione",
  freeRate: "Spedizione gratuita",
  cost: (amount) => `+ ${amount} di spedizione`,
  free: "Spedizione gratuita",
  shipsTo: (where) => `Paesi di spedizione: ${where}`,
  and: "e",
  more: (n) => `e altri ${n} ${n === 1 ? "paese" : "paesi"}`,
  everywhere: "la maggior parte dei paesi",
  everywhereElse: "la maggior parte dei paesi, per ora esclusi l'Unione europea, l'Islanda, il Liechtenstein e la Norvegia",
  goingTo: "Spedito a",
  shipsBy: (store) => `${store} lo spedisce e ti scrive quando è in viaggio.`,
  alsoShips: (store) => `${store} lo spedisce con il resto del tuo ordine, allo stesso indirizzo.`,
  shippedSubject: (title) => `${title} è in viaggio`,
  shippedLead: (title, store) => `${store} ha spedito ${title}.`,
  track: "Seguilo qui:",
  shippedTo: "Va a:",
  shippedWhy: (store) => `Ricevi questa email perché l'hai acquistato da ${store}. Domande? Rispondi a questa email.`,
};

const nl: ShippingWords = {
  rate: "Verzending",
  freeRate: "Gratis verzending",
  cost: (amount) => `+ ${amount} verzending`,
  free: "Gratis verzending",
  shipsTo: (where) => `Verzendlanden: ${where}`,
  and: "en",
  more: (n) => `en ${n} ${n === 1 ? "ander land" : "andere landen"}`,
  everywhere: "de meeste landen",
  everywhereElse: "de meeste landen, voorlopig zonder de Europese Unie, IJsland, Liechtenstein en Noorwegen",
  goingTo: "Verzonden naar",
  shipsBy: (store) => `${store} verstuurt het en mailt je zodra het onderweg is.`,
  alsoShips: (store) => `${store} verstuurt het met de rest van je bestelling, naar hetzelfde adres.`,
  shippedSubject: (title) => `${title} is onderweg`,
  shippedLead: (title, store) => `${store} heeft ${title} verstuurd.`,
  track: "Volg het hier:",
  shippedTo: "Het gaat naar:",
  shippedWhy: (store) => `Je krijgt dit omdat je het bij ${store} hebt gekocht. Vragen? Beantwoord deze mail.`,
};

const pt: ShippingWords = {
  rate: "Envio",
  freeRate: "Envio gratuito",
  cost: (amount) => `+ ${amount} de envio`,
  free: "Envio gratuito",
  shipsTo: (where) => `Países de envio: ${where}`,
  and: "e",
  more: (n) => `e mais ${n} ${n === 1 ? "país" : "países"}`,
  everywhere: "a maioria dos países",
  everywhereElse: "a maioria dos países, por agora sem a União Europeia, a Islândia, o Liechtenstein e a Noruega",
  goingTo: "Enviado para",
  shipsBy: (store) => `${store} envia-o e escreve-lhe quando estiver a caminho.`,
  alsoShips: (store) => `${store} envia-o com o resto da sua encomenda, para a mesma morada.`,
  shippedSubject: (title) => `${title} está a caminho`,
  shippedLead: (title, store) => `${store} enviou ${title}.`,
  track: "Acompanhe-o aqui:",
  shippedTo: "Vai para:",
  shippedWhy: (store) => `Recebe esta mensagem porque o comprou a ${store}. Dúvidas? Responda a este email.`,
};

export const SHIPPING_WORDS: Record<LanguageCode, ShippingWords> = { en, es, fr, de, it, nl, pt };

export function shippingWords(language: unknown): ShippingWords {
  return SHIPPING_WORDS[parseLanguage(language)];
}
