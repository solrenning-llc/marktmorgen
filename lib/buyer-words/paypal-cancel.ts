/**
 * What a buyer is told when their PayPal order is canceled because PayPal never confirmed the payment
 * (lib/paypal-cancel.ts, the email; app/[handle]/thanks/page.tsx, the page they come back to), in the store's
 * language (lib/store-language.ts), like the PayPal receipt (lib/buyer-words/giving.ts, ppSubject). English for
 * anything else, as givingWords does.
 *
 * Every language says everything English says, and nothing more. Money, links and counts arrive already written; a
 * sentence here only places them. Marktmorgen holds no money: PayPal pays the creator directly, so no sentence
 * promises a refund Marktmorgen could make.
 *
 * Browser-safe: no server code.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

/** A no-break space, before French ":" and "?", as lib/buyer-words/giving.ts writes it. */
const S = " ";

const en = {
  subject: (title: string) => `Your PayPal order for ${title} was canceled`,
  /** What stands for the product's title when it cannot be read (the listing, or the store, is gone). */
  yourOrder: "your order",
  heading: "Your PayPal order was canceled",
  canceled: (title: string, store: string, days: number) =>
    `Your PayPal order for ${title} from ${store} was canceled. PayPal did not confirm your payment within ${days} days, so you do not get ${title} for this order.`,
  notCharged: "You were not charged. PayPal did not take any money for this order.",
  pending: (store: string) =>
    `PayPal still shows your payment as pending. Marktmorgen never holds your money: PayPal pays it straight into the PayPal account of ${store}. If PayPal completes this payment later, reply to this email to ask ${store} for a refund, or open a dispute in your PayPal account.`,
  orderLine: (order: string, money: string) => `Order: ${order} (PayPal). Amount: ${money}.`,
  buyAgain: (title: string, link: string) => `To buy ${title} again, go to ${link}`,
  questions: (store: string) => `Questions? Reply to this email to reach ${store}.`,
  pageBody: (days: number) => `PayPal did not confirm the payment within ${days} days, so this order was canceled and nothing was handed over.`,
  pagePending: (store: string) =>
    `If PayPal shows the payment as completed later, the money went to the PayPal account of ${store}, not to Marktmorgen. Write to ${store} for a refund, or open a dispute in your PayPal account.`,
};

export type PayPalCancelWords = typeof en;

const es: PayPalCancelWords = {
  subject: (title) => `Tu pedido de PayPal de ${title} se ha cancelado`,
  yourOrder: "tu pedido",
  heading: "Tu pedido de PayPal se ha cancelado",
  canceled: (title, store, days) =>
    `Tu pedido de PayPal de ${title} en ${store} se ha cancelado. PayPal no confirmó tu pago en ${days} días, así que no recibes ${title} con este pedido.`,
  notCharged: "No se te ha cobrado nada. PayPal no tomó dinero por este pedido.",
  pending: (store) =>
    `PayPal sigue mostrando tu pago como pendiente. Marktmorgen nunca guarda tu dinero: PayPal lo paga directamente en la cuenta de PayPal de ${store}. Si PayPal completa este pago más adelante, responde a este correo para pedir a ${store} un reembolso, o abre una disputa en tu cuenta de PayPal.`,
  orderLine: (order, money) => `Pedido: ${order} (PayPal). Importe: ${money}.`,
  buyAgain: (title, link) => `Para comprar ${title} de nuevo, ve a ${link}`,
  questions: (store) => `¿Preguntas? Responde a este correo para contactar con ${store}.`,
  pageBody: (days) => `PayPal no confirmó el pago en ${days} días, así que este pedido se ha cancelado y no se ha entregado nada.`,
  pagePending: (store) =>
    `Si PayPal muestra el pago como completado más adelante, el dinero fue a la cuenta de PayPal de ${store}, no a Marktmorgen. Escribe a ${store} para pedir un reembolso, o abre una disputa en tu cuenta de PayPal.`,
};

const fr: PayPalCancelWords = {
  subject: (title) => `Votre commande PayPal pour ${title} a été annulée`,
  yourOrder: "votre commande",
  heading: "Votre commande PayPal a été annulée",
  canceled: (title, store, days) =>
    `Votre commande PayPal pour ${title} chez ${store} a été annulée. PayPal n'a pas confirmé votre paiement dans un délai de ${days} jours, vous ne recevez donc pas ${title} pour cette commande.`,
  notCharged: "Vous n'avez pas été débité. PayPal n'a prélevé aucun argent pour cette commande.",
  pending: (store) =>
    `PayPal indique toujours votre paiement comme en attente. Marktmorgen ne détient jamais votre argent${S}: PayPal le verse directement sur le compte PayPal de ${store}. Si PayPal finalise ce paiement plus tard, répondez à cet e-mail pour demander un remboursement à ${store}, ou ouvrez un litige dans votre compte PayPal.`,
  orderLine: (order, money) => `Commande${S}: ${order} (PayPal). Montant${S}: ${money}.`,
  buyAgain: (title, link) => `Pour acheter ${title} à nouveau, rendez-vous sur ${link}`,
  questions: (store) => `Des questions${S}? Répondez à cet e-mail pour joindre ${store}.`,
  pageBody: (days) => `PayPal n'a pas confirmé le paiement dans un délai de ${days} jours, cette commande a donc été annulée et rien n'a été remis.`,
  pagePending: (store) =>
    `Si PayPal indique plus tard que le paiement est finalisé, l'argent est allé sur le compte PayPal de ${store}, pas à Marktmorgen. Écrivez à ${store} pour demander un remboursement, ou ouvrez un litige dans votre compte PayPal.`,
};

const de: PayPalCancelWords = {
  subject: (title) => `Ihre PayPal-Bestellung für ${title} wurde storniert`,
  yourOrder: "Ihre Bestellung",
  heading: "Ihre PayPal-Bestellung wurde storniert",
  canceled: (title, store, days) =>
    `Ihre PayPal-Bestellung für ${title} bei ${store} wurde storniert. PayPal hat Ihre Zahlung nicht innerhalb von ${days} Tagen bestätigt, daher erhalten Sie ${title} für diese Bestellung nicht.`,
  notCharged: "Ihnen wurde nichts berechnet. PayPal hat für diese Bestellung kein Geld abgebucht.",
  pending: (store) =>
    `PayPal zeigt Ihre Zahlung weiterhin als ausstehend an. Marktmorgen verwahrt nie Ihr Geld: PayPal zahlt es direkt auf das PayPal-Konto von ${store}. Wenn PayPal diese Zahlung später abschließt, antworten Sie auf diese E-Mail, um ${store} um eine Erstattung zu bitten, oder eröffnen Sie einen Konflikt in Ihrem PayPal-Konto.`,
  orderLine: (order, money) => `Bestellung: ${order} (PayPal). Betrag: ${money}.`,
  buyAgain: (title, link) => `Um ${title} erneut zu kaufen, gehen Sie zu ${link}`,
  questions: (store) => `Fragen? Antworten Sie auf diese E-Mail, um ${store} zu erreichen.`,
  pageBody: (days) => `PayPal hat die Zahlung nicht innerhalb von ${days} Tagen bestätigt, daher wurde diese Bestellung storniert und nichts übergeben.`,
  pagePending: (store) =>
    `Wenn PayPal die Zahlung später als abgeschlossen anzeigt, ging das Geld auf das PayPal-Konto von ${store}, nicht an Marktmorgen. Schreiben Sie ${store} wegen einer Erstattung, oder eröffnen Sie einen Konflikt in Ihrem PayPal-Konto.`,
};

const it: PayPalCancelWords = {
  subject: (title) => `Il tuo ordine PayPal per ${title} è stato annullato`,
  yourOrder: "il tuo ordine",
  heading: "Il tuo ordine PayPal è stato annullato",
  canceled: (title, store, days) =>
    `Il tuo ordine PayPal per ${title} da ${store} è stato annullato. PayPal non ha confermato il tuo pagamento entro ${days} giorni, quindi non ricevi ${title} con questo ordine.`,
  notCharged: "Non ti è stato addebitato nulla. PayPal non ha preso denaro per questo ordine.",
  pending: (store) =>
    `PayPal mostra ancora il tuo pagamento come in sospeso. Marktmorgen non trattiene mai il tuo denaro: PayPal lo versa direttamente sul conto PayPal di ${store}. Se PayPal completa questo pagamento più avanti, rispondi a questa email per chiedere un rimborso a ${store}, oppure apri una contestazione nel tuo conto PayPal.`,
  orderLine: (order, money) => `Ordine: ${order} (PayPal). Importo: ${money}.`,
  buyAgain: (title, link) => `Per acquistare di nuovo ${title}, vai su ${link}`,
  questions: (store) => `Domande? Rispondi a questa email per contattare ${store}.`,
  pageBody: (days) => `PayPal non ha confermato il pagamento entro ${days} giorni, quindi questo ordine è stato annullato e non è stato consegnato nulla.`,
  pagePending: (store) =>
    `Se PayPal mostra più avanti il pagamento come completato, il denaro è andato sul conto PayPal di ${store}, non a Marktmorgen. Scrivi a ${store} per un rimborso, oppure apri una contestazione nel tuo conto PayPal.`,
};

const nl: PayPalCancelWords = {
  subject: (title) => `Je PayPal-bestelling voor ${title} is geannuleerd`,
  yourOrder: "je bestelling",
  heading: "Je PayPal-bestelling is geannuleerd",
  canceled: (title, store, days) =>
    `Je PayPal-bestelling voor ${title} bij ${store} is geannuleerd. PayPal heeft je betaling niet binnen ${days} dagen bevestigd, dus je krijgt ${title} niet voor deze bestelling.`,
  notCharged: "Er is niets van je afgeschreven. PayPal heeft voor deze bestelling geen geld afgeschreven.",
  pending: (store) =>
    `PayPal toont je betaling nog als in behandeling. Marktmorgen houdt nooit je geld vast: PayPal betaalt het rechtstreeks uit op de PayPal-rekening van ${store}. Als PayPal deze betaling later voltooit, beantwoord dan deze e-mail om ${store} om een terugbetaling te vragen, of open een geschil in je PayPal-rekening.`,
  orderLine: (order, money) => `Bestelling: ${order} (PayPal). Bedrag: ${money}.`,
  buyAgain: (title, link) => `Om ${title} opnieuw te kopen, ga naar ${link}`,
  questions: (store) => `Vragen? Beantwoord deze e-mail om ${store} te bereiken.`,
  pageBody: (days) => `PayPal heeft de betaling niet binnen ${days} dagen bevestigd, dus deze bestelling is geannuleerd en er is niets geleverd.`,
  pagePending: (store) =>
    `Als PayPal de betaling later als voltooid toont, is het geld naar de PayPal-rekening van ${store} gegaan, niet naar Marktmorgen. Schrijf ${store} voor een terugbetaling, of open een geschil in je PayPal-rekening.`,
};

const pt: PayPalCancelWords = {
  subject: (title) => `A sua encomenda PayPal de ${title} foi cancelada`,
  yourOrder: "a sua encomenda",
  heading: "A sua encomenda PayPal foi cancelada",
  canceled: (title, store, days) =>
    `A sua encomenda PayPal de ${title}, feita a ${store}, foi cancelada. O PayPal não confirmou o seu pagamento no prazo de ${days} dias, por isso não recebe ${title} com esta encomenda.`,
  notCharged: "Não lhe foi cobrado nada. O PayPal não retirou dinheiro por esta encomenda.",
  pending: (store) =>
    `O PayPal ainda mostra o seu pagamento como pendente. A Marktmorgen nunca guarda o seu dinheiro: o PayPal paga-o diretamente na conta PayPal de ${store}. Se o PayPal concluir este pagamento mais tarde, responda a este email para pedir um reembolso a ${store}, ou abra um litígio na sua conta PayPal.`,
  orderLine: (order, money) => `Encomenda: ${order} (PayPal). Valor: ${money}.`,
  buyAgain: (title, link) => `Para comprar ${title} novamente, aceda a ${link}`,
  questions: (store) => `Dúvidas? Responda a este email para contactar ${store}.`,
  pageBody: (days) => `O PayPal não confirmou o pagamento no prazo de ${days} dias, por isso esta encomenda foi cancelada e nada foi entregue.`,
  pagePending: (store) =>
    `Se o PayPal mostrar mais tarde o pagamento como concluído, o dinheiro foi para a conta PayPal de ${store}, não para a Marktmorgen. Escreva a ${store} para pedir um reembolso, ou abra um litígio na sua conta PayPal.`,
};

export const PAYPAL_CANCEL_WORDS: Record<LanguageCode, PayPalCancelWords> = { en, es, fr, de, it, nl, pt };

/** The words of a store with this language; English for anything else. */
export function paypalCancelWords(language: unknown): PayPalCancelWords {
  return PAYPAL_CANCEL_WORDS[parseLanguage(language)];
}
