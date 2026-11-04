/**
 * What the buyer and the creator are told about payment when a session of a
 * series is moved (637 [GL5], unit 5b; owner's decision C2-62, 4 November
 * 2026), in the store's seven languages. Which message is sent is moveCase
 * (lib/call-series-billing.ts), read from the charge worked out for the new
 * start and the session's record, so the words are what the code does:
 *   - held_until_start: the creator moved it inside the cancellation
 *     deadline; the card is only reserved now, charged when the session
 *     starts, and canceling before then costs nothing.
 *   - planned: paid as before for the new time.
 *   - kept: it was charged already (at or after its deadline, or at once
 *     inside it) and that charge stays, whoever moved it;
 *     the creator canceling still refunds it.
 *   - charged_now: the buyer moved it inside the deadline: charged at once,
 *     not refunded.
 *   - paid_refundable_until: it was paid already and not kept: canceling by
 *     `until` refunds it in full.
 *   - pay_by_link: its payment failed and waits on the buyer: the link
 *     works until `until`, unpaid by then it is canceled, nothing charged.
 * `date` arrives written in the store's language; `hours` is the deadline
 * promised when booking (0 for none). The buyer is never named to the
 * creator. Browser-safe.
 */
import type { MoveCase } from "@/lib/call-series-billing";
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type MoveBy = "creator" | "buyer";
/**
 * `until`: moveCase's `until`, written in the store's language: the buyer's
 * last moment to cancel for a full refund (paid_refundable_until), or the
 * moment the pay link stops working (pay_by_link: payBy of the step that
 * failed, never a cancelBy already passed).
 */
export type MoveInput = { date: string; store: string; hours: number; by: MoveBy; until: string };
type Lines = (input: MoveInput) => string[];
export type SeriesMoveWords = { buyer: Record<MoveCase, Lines>; creator: Record<MoveCase, Lines> };

/** A space a line cannot break at, between a number and its unit. */
const N = " ";

const en: SeriesMoveWords = {
  buyer: {
    held_until_start: ({ date, store, hours }) => [`${store} moved your session to ${date}.`, `That is less than ${hours} hours away, so your card is only reserved now.`, "It is charged when the session starts.", "Cancel any time before then and you pay nothing for it."],
    planned: ({ date, store, hours, by }) => [by === "buyer" ? `You moved your session to ${date}.` : `${store} moved your session to ${date}.`, hours ? `Cancel at least ${hours} hours before it starts and you pay nothing for it.` : "Cancel any time before it starts and you pay nothing for it."],
    kept: ({ date, store, by }) => [by === "buyer" ? `You moved your session to ${date}.` : `${store} moved your session to ${date}.`, "This session was already charged.", "That charge stays, so it is not refunded if you cancel.", `If ${store} cancels it, you get your money back.`],
    charged_now: ({ date, hours }) => [`You moved your session to ${date}.`, `That is less than ${hours} hours away, so it is charged now.`, "It is not refunded if you cancel."],
    paid_refundable_until: (i) => [en.buyer.planned(i)[0], "This session was already charged.", `Cancel by ${i.until} and it is refunded in full.`],
    pay_by_link: (i) => [en.buyer.planned(i)[0], "Your payment for it has not gone through yet.", `Pay with the link by ${i.until}.`, "If it is not paid by then, the session is canceled and you are not charged."],
  },
  creator: {
    held_until_start: ({ date, hours }) => [`You moved the session to ${date}.`, `That is inside your ${hours}-hour cancellation deadline, so the buyer's card is only reserved.`, "It is charged when the session starts.", "If the buyer cancels before then, the reservation is released and nothing is charged."],
    planned: ({ date, by }) => [by === "buyer" ? `The buyer moved the session to ${date}.` : `You moved the session to ${date}.`, "Its payment follows your usual rules for the new time."],
    kept: ({ date, by }) => [by === "buyer" ? `The buyer moved the session to ${date}.` : `You moved the session to ${date}.`, "It was already charged, and that charge stays.", "If you cancel it, the buyer gets a full refund."],
    charged_now: ({ date, hours }) => [`The buyer moved the session to ${date}.`, `That is inside your ${hours}-hour cancellation deadline, so the buyer is being charged now.`, "It is not refunded if the buyer cancels."],
    paid_refundable_until: (i) => [en.creator.planned(i)[0], "The buyer was already charged for it.", `If the buyer cancels by ${i.until}, they get a full refund.`],
    pay_by_link: (i) => [en.creator.planned(i)[0], "The buyer's payment for it has not gone through yet.", `We emailed them a link to pay by ${i.until}.`, "If it is not paid by then, the session is canceled and its time opens again."],
  },
};

const es: SeriesMoveWords = {
  buyer: {
    held_until_start: ({ date, store, hours }) => [`${store} movió tu sesión al nuevo horario: ${date}.`, `Faltan menos de ${hours}${N}horas, así que por ahora solo se reserva el importe en tu tarjeta.`, "Se cobra cuando empieza la sesión.", "Si cancelas antes, no pagas nada."],
    planned: ({ date, store, hours, by }) => [by === "buyer" ? `Moviste tu sesión al nuevo horario: ${date}.` : `${store} movió tu sesión al nuevo horario: ${date}.`, hours ? `Cancela al menos ${hours}${N}horas antes de que empiece y no pagas nada.` : "Cancela en cualquier momento antes de que empiece y no pagas nada."],
    kept: ({ date, store, by }) => [by === "buyer" ? `Moviste tu sesión al nuevo horario: ${date}.` : `${store} movió tu sesión al nuevo horario: ${date}.`, "Esta sesión ya se cobró.", "Ese cobro se mantiene, así que no se reembolsa si cancelas.", `Si ${store} la cancela, te devuelve el dinero.`],
    charged_now: ({ date, hours }) => [`Moviste tu sesión al nuevo horario: ${date}.`, `Faltan menos de ${hours}${N}horas, así que se cobra ahora.`, "No se reembolsa si cancelas."],
    paid_refundable_until: (i) => [es.buyer.planned(i)[0], "Esta sesión ya se cobró.", `Cancela a más tardar ${i.until} y se te reembolsa todo.`],
    pay_by_link: (i) => [es.buyer.planned(i)[0], "Tu pago de esta sesión aún no se ha completado.", `Paga con el enlace a más tardar ${i.until}.`, "Si no se paga para entonces, la sesión se cancela y no se te cobra nada."],
  },
  creator: {
    held_until_start: ({ date, hours }) => [`Moviste la sesión al nuevo horario: ${date}.`, `Queda dentro de tu plazo de ${hours}${N}horas, así que la tarjeta del comprador solo queda reservada.`, "Se cobra cuando empieza la sesión.", "Si el comprador cancela antes, la reserva se libera y no se cobra nada."],
    planned: ({ date, by }) => [by === "buyer" ? `El comprador movió la sesión al nuevo horario: ${date}.` : `Moviste la sesión al nuevo horario: ${date}.`, "Su pago sigue tus reglas habituales para la nueva hora."],
    kept: ({ date, by }) => [by === "buyer" ? `El comprador movió la sesión al nuevo horario: ${date}.` : `Moviste la sesión al nuevo horario: ${date}.`, "Ya se cobró, y ese cobro se mantiene.", "Si la cancelas, el comprador recibe un reembolso completo."],
    charged_now: ({ date, hours }) => [`El comprador movió la sesión al nuevo horario: ${date}.`, `Queda dentro de tu plazo de ${hours}${N}horas, así que se está cobrando al comprador ahora.`, "No se reembolsa si el comprador cancela."],
    paid_refundable_until: (i) => [es.creator.planned(i)[0], "Al comprador ya se le cobró.", `Si el comprador cancela a más tardar ${i.until}, recibe un reembolso completo.`],
    pay_by_link: (i) => [es.creator.planned(i)[0], "El pago del comprador aún no se ha completado.", `Le enviamos un enlace para pagar a más tardar ${i.until}.`, "Si no se paga para entonces, la sesión se cancela y su hora queda libre."],
  },
};

const fr: SeriesMoveWords = {
  buyer: {
    held_until_start: ({ date, store, hours }) => [`${store} a déplacé votre séance au ${date}.`, `Il reste moins de ${hours}${N}heures, donc le montant est seulement réservé sur votre carte.`, "Il est débité au début de la séance.", "Annulez avant ce moment et vous ne payez rien."],
    planned: ({ date, store, hours, by }) => [by === "buyer" ? `Vous avez déplacé votre séance au ${date}.` : `${store} a déplacé votre séance au ${date}.`, hours ? `Annulez au moins ${hours}${N}heures avant le début et vous ne payez rien.` : "Annulez à tout moment avant le début et vous ne payez rien."],
    kept: ({ date, store, by }) => [by === "buyer" ? `Vous avez déplacé votre séance au ${date}.` : `${store} a déplacé votre séance au ${date}.`, "Cette séance a déjà été débitée.", "Ce débit reste acquis, donc il n'est pas remboursé si vous annulez.", `Si ${store} l'annule, vous êtes remboursé.`],
    charged_now: ({ date, hours }) => [`Vous avez déplacé votre séance au ${date}.`, `Il reste moins de ${hours}${N}heures, donc elle est débitée maintenant.`, "Elle n'est pas remboursée si vous annulez."],
    paid_refundable_until: (i) => [fr.buyer.planned(i)[0], "Cette séance a déjà été débitée.", `Annulez au plus tard ${i.until} et vous êtes remboursé en totalité.`],
    pay_by_link: (i) => [fr.buyer.planned(i)[0], "Votre paiement pour cette séance n'a pas encore abouti.", `Payez avec le lien au plus tard ${i.until}.`, "Sinon, la séance est annulée et rien ne vous est débité."],
  },
  creator: {
    held_until_start: ({ date, hours }) => [`Vous avez déplacé la séance au ${date}.`, `C'est dans votre délai d'annulation de ${hours}${N}heures, donc la carte de l'acheteur est seulement réservée.`, "Elle est débitée au début de la séance.", "Si l'acheteur annule avant, la réservation est libérée et rien n'est débité."],
    planned: ({ date, by }) => [by === "buyer" ? `L'acheteur a déplacé la séance au ${date}.` : `Vous avez déplacé la séance au ${date}.`, "Son paiement suit vos règles habituelles pour le nouvel horaire."],
    kept: ({ date, by }) => [by === "buyer" ? `L'acheteur a déplacé la séance au ${date}.` : `Vous avez déplacé la séance au ${date}.`, "Elle a déjà été débitée, et ce débit reste acquis.", "Si vous l'annulez, l'acheteur est remboursé en totalité."],
    charged_now: ({ date, hours }) => [`L'acheteur a déplacé la séance au ${date}.`, `C'est dans votre délai d'annulation de ${hours}${N}heures, donc l'acheteur est débité maintenant.`, "Ce n'est pas remboursé si l'acheteur annule."],
    paid_refundable_until: (i) => [fr.creator.planned(i)[0], "L'acheteur a déjà été débité pour cette séance.", `Si l'acheteur annule au plus tard ${i.until}, il est remboursé en totalité.`],
    pay_by_link: (i) => [fr.creator.planned(i)[0], "Le paiement de l'acheteur n'a pas encore abouti.", `Nous lui avons envoyé un lien pour payer au plus tard ${i.until}.`, "Sinon, la séance est annulée et son horaire se libère."],
  },
};

const de: SeriesMoveWords = {
  buyer: {
    held_until_start: ({ date, store, hours }) => [`${store} hat Ihren Termin auf ${date} verschoben.`, `Bis dahin sind es weniger als ${hours}${N}Stunden, daher wird der Betrag auf Ihrer Karte nur reserviert.`, "Er wird abgebucht, wenn der Termin beginnt.", "Wenn Sie vorher stornieren, zahlen Sie nichts."],
    planned: ({ date, store, hours, by }) => [by === "buyer" ? `Sie haben Ihren Termin auf ${date} verschoben.` : `${store} hat Ihren Termin auf ${date} verschoben.`, hours ? `Stornieren Sie mindestens ${hours}${N}Stunden vor Beginn, und Sie zahlen nichts.` : "Stornieren Sie jederzeit vor Beginn, und Sie zahlen nichts."],
    kept: ({ date, store, by }) => [by === "buyer" ? `Sie haben Ihren Termin auf ${date} verschoben.` : `${store} hat Ihren Termin auf ${date} verschoben.`, "Dieser Termin wurde bereits abgebucht.", "Diese Abbuchung bleibt bestehen und wird bei einer Stornierung nicht erstattet.", `Wenn ${store} ihn absagt, bekommen Sie Ihr Geld zurück.`],
    charged_now: ({ date, hours }) => [`Sie haben Ihren Termin auf ${date} verschoben.`, `Bis dahin sind es weniger als ${hours}${N}Stunden, daher wird jetzt abgebucht.`, "Bei einer Stornierung wird nichts erstattet."],
    paid_refundable_until: (i) => [de.buyer.planned(i)[0], "Dieser Termin wurde bereits abgebucht.", `Stornieren Sie bis ${i.until}, und Sie bekommen alles erstattet.`],
    pay_by_link: (i) => [de.buyer.planned(i)[0], "Ihre Zahlung für diesen Termin ist noch nicht durchgegangen.", `Zahlen Sie über den Link bis ${i.until}.`, "Sonst wird der Termin abgesagt, und Ihnen wird nichts berechnet."],
  },
  creator: {
    held_until_start: ({ date, hours }) => [`Sie haben den Termin auf ${date} verschoben.`, `Er liegt innerhalb Ihrer Stornofrist von ${hours}${N}Stunden, daher wird die Karte des Käufers nur reserviert.`, "Abgebucht wird, wenn der Termin beginnt.", "Storniert der Käufer vorher, wird die Reservierung freigegeben und nichts abgebucht."],
    planned: ({ date, by }) => [by === "buyer" ? `Der Käufer hat den Termin auf ${date} verschoben.` : `Sie haben den Termin auf ${date} verschoben.`, "Die Zahlung folgt für die neue Zeit Ihren üblichen Regeln."],
    kept: ({ date, by }) => [by === "buyer" ? `Der Käufer hat den Termin auf ${date} verschoben.` : `Sie haben den Termin auf ${date} verschoben.`, "Er wurde bereits abgebucht, und diese Abbuchung bleibt bestehen.", "Wenn Sie ihn absagen, bekommt der Käufer alles erstattet."],
    charged_now: ({ date, hours }) => [`Der Käufer hat den Termin auf ${date} verschoben.`, `Er liegt innerhalb Ihrer Stornofrist von ${hours}${N}Stunden, daher wird der Käufer jetzt belastet.`, "Storniert der Käufer, wird nichts erstattet."],
    paid_refundable_until: (i) => [de.creator.planned(i)[0], "Der Käufer wurde dafür bereits belastet.", `Storniert der Käufer bis ${i.until}, bekommt er alles erstattet.`],
    pay_by_link: (i) => [de.creator.planned(i)[0], "Die Zahlung des Käufers ist noch nicht durchgegangen.", `Wir haben ihm einen Link geschickt, um bis ${i.until} zu zahlen.`, "Sonst wird der Termin abgesagt, und die Zeit wird wieder frei."],
  },
};

const it: SeriesMoveWords = {
  buyer: {
    held_until_start: ({ date, store, hours }) => [`${store} ha spostato la tua sessione a ${date}.`, `Mancano meno di ${hours}${N}ore, quindi per ora l'importo è solo riservato sulla tua carta.`, "Viene addebitato quando la sessione inizia.", "Se annulli prima, non paghi nulla."],
    planned: ({ date, store, hours, by }) => [by === "buyer" ? `Hai spostato la tua sessione a ${date}.` : `${store} ha spostato la tua sessione a ${date}.`, hours ? `Annulla almeno ${hours}${N}ore prima dell'inizio e non paghi nulla.` : "Annulla in qualsiasi momento prima dell'inizio e non paghi nulla."],
    kept: ({ date, store, by }) => [by === "buyer" ? `Hai spostato la tua sessione a ${date}.` : `${store} ha spostato la tua sessione a ${date}.`, "Questa sessione è già stata addebitata.", "L'addebito resta, quindi non viene rimborsato se annulli.", `Se ${store} la annulla, ti restituisce i soldi.`],
    charged_now: ({ date, hours }) => [`Hai spostato la tua sessione a ${date}.`, `Mancano meno di ${hours}${N}ore, quindi viene addebitata ora.`, "Non viene rimborsata se annulli."],
    paid_refundable_until: (i) => [it.buyer.planned(i)[0], "Questa sessione è già stata addebitata.", `Annulla entro ${i.until} e ricevi un rimborso completo.`],
    pay_by_link: (i) => [it.buyer.planned(i)[0], "Il tuo pagamento per questa sessione non è ancora andato a buon fine.", `Paga con il link entro ${i.until}.`, "Altrimenti la sessione viene annullata e non ti viene addebitato nulla."],
  },
  creator: {
    held_until_start: ({ date, hours }) => [`Hai spostato la sessione a ${date}.`, `Rientra nel tuo termine di cancellazione di ${hours}${N}ore, quindi la carta dell'acquirente è solo riservata.`, "Viene addebitata quando la sessione inizia.", "Se l'acquirente annulla prima, la riserva viene liberata e non si addebita nulla."],
    planned: ({ date, by }) => [by === "buyer" ? `L'acquirente ha spostato la sessione a ${date}.` : `Hai spostato la sessione a ${date}.`, "Il pagamento segue le tue regole abituali per il nuovo orario."],
    kept: ({ date, by }) => [by === "buyer" ? `L'acquirente ha spostato la sessione a ${date}.` : `Hai spostato la sessione a ${date}.`, "È già stata addebitata, e l'addebito resta.", "Se la annulli, l'acquirente riceve un rimborso completo."],
    charged_now: ({ date, hours }) => [`L'acquirente ha spostato la sessione a ${date}.`, `Rientra nel tuo termine di cancellazione di ${hours}${N}ore, quindi l'acquirente viene addebitato ora.`, "Non viene rimborsata se l'acquirente annulla."],
    paid_refundable_until: (i) => [it.creator.planned(i)[0], "All'acquirente è già stata addebitata.", `Se l'acquirente annulla entro ${i.until}, riceve un rimborso completo.`],
    pay_by_link: (i) => [it.creator.planned(i)[0], "Il pagamento dell'acquirente non è ancora andato a buon fine.", `Gli abbiamo inviato un link per pagare entro ${i.until}.`, "Altrimenti la sessione viene annullata e l'orario torna libero."],
  },
};

const nl: SeriesMoveWords = {
  buyer: {
    held_until_start: ({ date, store, hours }) => [`${store} heeft je sessie verplaatst naar ${date}.`, `Dat is over minder dan ${hours}${N}uur, dus het bedrag wordt nu alleen op je kaart gereserveerd.`, "Het wordt afgeschreven als de sessie begint.", "Annuleer je eerder, dan betaal je niets."],
    planned: ({ date, store, hours, by }) => [by === "buyer" ? `Je hebt je sessie verplaatst naar ${date}.` : `${store} heeft je sessie verplaatst naar ${date}.`, hours ? `Annuleer minstens ${hours}${N}uur voor het begin en je betaalt niets.` : "Annuleer op elk moment voor het begin en je betaalt niets."],
    kept: ({ date, store, by }) => [by === "buyer" ? `Je hebt je sessie verplaatst naar ${date}.` : `${store} heeft je sessie verplaatst naar ${date}.`, "Deze sessie is al afgeschreven.", "Die betaling blijft staan, dus je krijgt niets terug als je annuleert.", `Annuleert ${store} haar, dan krijg je je geld terug.`],
    charged_now: ({ date, hours }) => [`Je hebt je sessie verplaatst naar ${date}.`, `Dat is over minder dan ${hours}${N}uur, dus het wordt nu afgeschreven.`, "Je krijgt niets terug als je annuleert."],
    paid_refundable_until: (i) => [nl.buyer.planned(i)[0], "Deze sessie is al afgeschreven.", `Annuleer uiterlijk ${i.until} en je krijgt alles terug.`],
    pay_by_link: (i) => [nl.buyer.planned(i)[0], "Je betaling voor deze sessie is nog niet gelukt.", `Betaal met de link uiterlijk ${i.until}.`, "Anders wordt de sessie geannuleerd en betaal je niets."],
  },
  creator: {
    held_until_start: ({ date, hours }) => [`Je hebt de sessie verplaatst naar ${date}.`, `Dat valt binnen je annuleringstermijn van ${hours}${N}uur, dus de kaart van de koper wordt alleen gereserveerd.`, "Het wordt afgeschreven als de sessie begint.", "Annuleert de koper eerder, dan vervalt de reservering en wordt er niets afgeschreven."],
    planned: ({ date, by }) => [by === "buyer" ? `De koper heeft de sessie verplaatst naar ${date}.` : `Je hebt de sessie verplaatst naar ${date}.`, "De betaling volgt je gewone regels voor de nieuwe tijd."],
    kept: ({ date, by }) => [by === "buyer" ? `De koper heeft de sessie verplaatst naar ${date}.` : `Je hebt de sessie verplaatst naar ${date}.`, "Ze is al afgeschreven, en die betaling blijft staan.", "Annuleer je haar, dan krijgt de koper alles terug."],
    charged_now: ({ date, hours }) => [`De koper heeft de sessie verplaatst naar ${date}.`, `Dat valt binnen je annuleringstermijn van ${hours}${N}uur, dus de koper wordt nu belast.`, "De koper krijgt niets terug bij annuleren."],
    paid_refundable_until: (i) => [nl.creator.planned(i)[0], "De koper heeft er al voor betaald.", `Annuleert de koper uiterlijk ${i.until}, dan krijgt die alles terug.`],
    pay_by_link: (i) => [nl.creator.planned(i)[0], "De betaling van de koper is nog niet gelukt.", `We hebben een link gestuurd om uiterlijk ${i.until} te betalen.`, "Anders wordt de sessie geannuleerd en komt de tijd weer vrij."],
  },
};

const pt: SeriesMoveWords = {
  buyer: {
    held_until_start: ({ date, store, hours }) => [`${store} mudou a sua sessão para ${date}.`, `Faltam menos de ${hours}${N}horas, por isso o valor fica só reservado no seu cartão.`, "É cobrado quando a sessão começa.", "Se cancelar antes, não paga nada."],
    planned: ({ date, store, hours, by }) => [by === "buyer" ? `Mudou a sua sessão para ${date}.` : `${store} mudou a sua sessão para ${date}.`, hours ? `Cancele pelo menos ${hours}${N}horas antes do início e não paga nada.` : "Cancele a qualquer momento antes do início e não paga nada."],
    kept: ({ date, store, by }) => [by === "buyer" ? `Mudou a sua sessão para ${date}.` : `${store} mudou a sua sessão para ${date}.`, "Esta sessão já foi cobrada.", "Essa cobrança mantém-se, por isso não é reembolsada se cancelar.", `Se ${store} a cancelar, recebe o seu dinheiro de volta.`],
    charged_now: ({ date, hours }) => [`Mudou a sua sessão para ${date}.`, `Faltam menos de ${hours}${N}horas, por isso é cobrada agora.`, "Não é reembolsada se cancelar."],
    paid_refundable_until: (i) => [pt.buyer.planned(i)[0], "Esta sessão já foi cobrada.", `Cancele até ${i.until} e recebe o reembolso total.`],
    pay_by_link: (i) => [pt.buyer.planned(i)[0], "O seu pagamento desta sessão ainda não foi concluído.", `Pague com o link até ${i.until}.`, "Caso contrário, a sessão é cancelada e não lhe é cobrado nada."],
  },
  creator: {
    held_until_start: ({ date, hours }) => [`Mudou a sessão para ${date}.`, `Fica dentro do seu prazo de cancelamento de ${hours}${N}horas, por isso o cartão do comprador fica só reservado.`, "É cobrada quando a sessão começa.", "Se o comprador cancelar antes, a reserva é libertada e nada é cobrado."],
    planned: ({ date, by }) => [by === "buyer" ? `O comprador mudou a sessão para ${date}.` : `Mudou a sessão para ${date}.`, "O pagamento segue as suas regras habituais para o novo horário."],
    kept: ({ date, by }) => [by === "buyer" ? `O comprador mudou a sessão para ${date}.` : `Mudou a sessão para ${date}.`, "Já foi cobrada, e essa cobrança mantém-se.", "Se a cancelar, o comprador recebe o reembolso total."],
    charged_now: ({ date, hours }) => [`O comprador mudou a sessão para ${date}.`, `Fica dentro do seu prazo de cancelamento de ${hours}${N}horas, por isso o comprador está a ser cobrado agora.`, "Não é reembolsada se o comprador cancelar."],
    paid_refundable_until: (i) => [pt.creator.planned(i)[0], "O comprador já foi cobrado por ela.", `Se o comprador cancelar até ${i.until}, recebe o reembolso total.`],
    pay_by_link: (i) => [pt.creator.planned(i)[0], "O pagamento do comprador ainda não foi concluído.", `Enviámos-lhe um link para pagar até ${i.until}.`, "Caso contrário, a sessão é cancelada e o horário fica livre."],
  },
};

export const SERIES_MOVE_WORDS: Record<LanguageCode, SeriesMoveWords> = { en, es, fr, de, it, nl, pt };

/** The payment part of a moved session's message, for the buyer or the creator, in the store's language (English when unknown). */
export function seriesMoveMessage(language: unknown, to: "buyer" | "creator", which: MoveCase, input: MoveInput): string {
  return SERIES_MOVE_WORDS[parseLanguage(language)][to][which](input).join(" ");
}
