/**
 * The email a buyer on a payment plan gets when a payment Stripe took after the plan's agreed end was refunded
 * (lib/plan-late-notice.ts; the owner's decision of 9 November 2026, item 12), in each language a store can speak.
 *
 * Plain data: the amount and the dates come already written the store's way (lib/buyer-words, speechFor).
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type LateRefundFacts = { store: string; product: string | null; amount: string; paidOn: string; endedOn: string; link: string };
export type PlanLateRefundWords = { subject: (store: string) => string; lines: (facts: LateRefundFacts) => string[] };

const en: PlanLateRefundWords = {
  subject: (store) => `${store}: a payment after your plan's end was refunded`,
  lines: ({ store, product, amount, paidOn, endedOn, link }) => [
    `Your payment plan with ${store}${product ? ` for "${product}"` : ""} was agreed to end on ${endedOn}. A payment of ${amount} was taken on ${paidOn}, after that date.`,
    "",
    "That payment has been refunded in full. It can take a few business days to show on your statement.",
    "",
    "Your plan has ended. No more payments will be taken for it.",
    "",
    `Questions? You can reach ${store} here: ${link}`,
  ],
};
const es: PlanLateRefundWords = {
  subject: (store) => `${store}: se ha reembolsado un pago posterior al final de tu plan`,
  lines: ({ store, product, amount, paidOn, endedOn, link }) => [
    `Tu plan de pagos con ${store}${product ? ` para «${product}»` : ""} debía terminar el ${endedOn}. El ${paidOn}, después de esa fecha, se cobró un pago de ${amount}.`,
    "",
    "Ese pago se ha reembolsado por completo. Puede tardar unos días hábiles en aparecer en tu extracto.",
    "",
    "Tu plan ha terminado. No se cobrarán más pagos por él.",
    "",
    `¿Tienes preguntas? Puedes contactar con ${store} aquí: ${link}`,
  ],
};
const fr: PlanLateRefundWords = {
  subject: (store) => `${store} : un paiement après la fin de votre plan a été remboursé`,
  lines: ({ store, product, amount, paidOn, endedOn, link }) => [
    `Votre paiement échelonné avec ${store}${product ? ` pour « ${product} »` : ""} devait se terminer le ${endedOn}. Le ${paidOn}, après cette date, un paiement de ${amount} a été prélevé.`,
    "",
    "Ce paiement a été remboursé en totalité. Il peut falloir quelques jours ouvrés pour qu’il apparaisse sur votre relevé.",
    "",
    "Votre plan est terminé. Aucun autre paiement ne sera prélevé.",
    "",
    `Des questions ? Vous pouvez joindre ${store} ici : ${link}`,
  ],
};
const de: PlanLateRefundWords = {
  subject: (store) => `${store}: Eine Zahlung nach dem Ende Ihres Ratenplans wurde erstattet`,
  lines: ({ store, product, amount, paidOn, endedOn, link }) => [
    `Ihr Ratenplan bei ${store}${product ? ` für „${product}“` : ""} sollte am ${endedOn} enden. Am ${paidOn}, nach diesem Datum, wurde eine Zahlung von ${amount} eingezogen.`,
    "",
    "Diese Zahlung wurde vollständig erstattet. Es kann einige Werktage dauern, bis sie auf Ihrem Kontoauszug erscheint.",
    "",
    "Ihr Plan ist beendet. Dafür werden keine weiteren Zahlungen eingezogen.",
    "",
    `Fragen? Sie erreichen ${store} hier: ${link}`,
  ],
};
const it: PlanLateRefundWords = {
  subject: (store) => `${store}: un pagamento dopo la fine del tuo piano è stato rimborsato`,
  lines: ({ store, product, amount, paidOn, endedOn, link }) => [
    `Il tuo piano di pagamento con ${store}${product ? ` per «${product}»` : ""} doveva terminare il ${endedOn}. Il ${paidOn}, dopo quella data, è stato addebitato un pagamento di ${amount}.`,
    "",
    "Quel pagamento è stato rimborsato per intero. Possono servire alcuni giorni lavorativi perché compaia sul tuo estratto conto.",
    "",
    "Il tuo piano è terminato. Non verranno addebitati altri pagamenti.",
    "",
    `Domande? Puoi contattare ${store} qui: ${link}`,
  ],
};
const nl: PlanLateRefundWords = {
  subject: (store) => `${store}: een betaling na het einde van je betalingsplan is terugbetaald`,
  lines: ({ store, product, amount, paidOn, endedOn, link }) => [
    `Je betalingsplan bij ${store}${product ? ` voor "${product}"` : ""} zou eindigen op ${endedOn}. Op ${paidOn}, na die datum, is een betaling van ${amount} afgeschreven.`,
    "",
    "Die betaling is volledig terugbetaald. Het kan enkele werkdagen duren voordat je die op je afschrift ziet.",
    "",
    "Je plan is beëindigd. Er worden geen betalingen meer voor afgeschreven.",
    "",
    `Vragen? Je kunt ${store} hier bereiken: ${link}`,
  ],
};
const pt: PlanLateRefundWords = {
  subject: (store) => `${store}: foi reembolsado um pagamento posterior ao fim do seu plano`,
  lines: ({ store, product, amount, paidOn, endedOn, link }) => [
    `O seu plano de pagamentos com ${store}${product ? ` para «${product}»` : ""} devia terminar em ${endedOn}. Em ${paidOn}, depois dessa data, foi cobrado um pagamento de ${amount}.`,
    "",
    "Esse pagamento foi reembolsado na totalidade. Pode demorar alguns dias úteis até aparecer no seu extrato.",
    "",
    "O seu plano terminou. Não serão cobrados mais pagamentos.",
    "",
    `Dúvidas? Pode contactar ${store} aqui: ${link}`,
  ],
};

export const PLAN_LATE_REFUND_WORDS: Record<LanguageCode, PlanLateRefundWords> = { en, es, fr, de, it, nl, pt };

export function planLateRefundWords(language: unknown): PlanLateRefundWords {
  return PLAN_LATE_REFUND_WORDS[parseLanguage(language)];
}
