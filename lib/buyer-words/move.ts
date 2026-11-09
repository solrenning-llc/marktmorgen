/**
 * The words of moving a membership from another platform (lib/move-rules.ts),
 * as a member meets them, in the store's language (lib/store-language.ts):
 * the email with their link, the one reminder, and the page the link opens.
 *
 * Every language says all English says, nothing added and nothing softened.
 * `amount` is the first payment here ("$9"), `line` the price as it goes on
 * ("$9 a month"), `date` and `until` already written the language's way.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

type Notice = { title: string; body: string };

/** A non-breaking space, before French : ? ! ; */
const S = " ";

const en = {
  pageTitle: "Keep your membership",
  label: "Moving your membership",
  intro: (store: string, title: string) => `${store} has moved its memberships here, and yours of ${title} can come with you.`,
  forAddress: (email: string) => `This link is for ${email}.`,
  deferred: (amount: string, date: string, line: string) =>
    `Nothing is charged today. Your first payment here, ${amount}, is taken on ${date}, the day your membership would have renewed. After that, ${line}.`,
  deferredSoon: (amount: string, date: string, line: string) => `Nothing is charged today. Your first payment here, ${amount}, is taken on ${date}. After that, ${line}.`,
  now: (amount: string, line: string) => `Its next payment is due now, so the first one here, ${amount}, is taken when you keep it. After that, ${line}.`,
  keep: "Keep my membership",
  seePrices: (title: string) => `See today's prices for ${title}`,
  doNothing: "If you do nothing, nothing is charged here.",
  notices: {
    expired: { title: "This link no longer works", body: "It was for one person and one membership, for a limited time. The store's page has the membership, if you would like to join." },
    unavailable: { title: "This membership is not on sale just now", body: "Nothing was charged. The store's owner can tell you more." },
    price: { title: "This price is no longer offered", body: "The store no longer offers the price this link was for, so it cannot keep your membership at that price. Nothing was charged." },
    refused: { title: "The payment page could not be opened", body: "Nothing was charged. Try again in a few minutes." },
    limited: { title: "That was a lot of tries", body: "Nothing was charged. Wait a few minutes and press the button again." },
    kept: { title: "You have kept this membership", body: "It is already kept here, so nothing more is needed, and nothing was charged again." },
  } satisfies Record<string, Notice>,
  inviteSubject: (title: string, store: string) => `Keep your membership of ${title} with ${store}`,
  inviteDeferred: (store: string, title: string, amount: string, date: string) =>
    `${store} has moved its memberships to its own store, and your membership of ${title} can come with you. Keep it with the link below. Nothing is charged before ${date}, the day it would have renewed, and the first payment here is ${amount}.`,
  inviteNow: (store: string, title: string, amount: string) =>
    `${store} has moved its memberships to its own store, and your membership of ${title} can come with you. Its next payment is due now, so keeping it with the link below takes the first payment here, ${amount}.`,
  linkNote: (until: string) => `The link is yours alone and works until ${until}. If you do nothing, nothing is charged here.`,
  whyReminder: (store: string, date: string) =>
    `You are getting this because ${store} moved its members here. If you have not kept your membership by then, one reminder is sent a few days before ${date}, and nothing more.`,
  whyOnce: (store: string) => `You are getting this one email because ${store} moved its members here. Nothing more is sent because of it.`,
  reminderSubject: (title: string) => `Reminder: your membership of ${title}`,
  reminderBody: (store: string, title: string, amount: string, date: string) =>
    `Your membership of ${title} with ${store} has not moved yet. Keep it with the link below. Nothing is charged before ${date}, and the first payment here is ${amount}.`,
  reminderLast: "This is the only reminder. If you do nothing, nothing is charged here.",
  sentBy: (store: string) => `Sent by Marktmorgen on behalf of ${store}.`,
  stopLine: (store: string, link: string) => `Stop emails from ${store} about moving your membership: ${link}`,
  stopAsk: (who: string) => `Stop emails from ${who || "this store"} about moving your membership?`,
  stopButton: "Stop these emails",
  stopDoneTitle: "No more emails about it",
  stopDone: (email: string, who: string) => `${email} will not get more emails from ${who || "this store"} about moving a membership, nor any other reminder from it. Nothing else is needed.`,
};

export type MoveWords = {
  [K in keyof typeof en]: K extends "notices" ? Record<keyof typeof en.notices, Notice> : (typeof en)[K];
};

const es: MoveWords = {
  pageTitle: "Conserva tu membresía",
  label: "Traslado de tu membresía",
  intro: (store, title) => `${store} ha trasladado sus membresías aquí, y la tuya de ${title} puede venir contigo.`,
  forAddress: (email) => `Este enlace es para ${email}.`,
  deferred: (amount, date, line) =>
    `Hoy no se cobra nada. Tu primer pago aquí, ${amount}, se cobra el ${date}, el día en que tu membresía se habría renovado. Después, ${line}.`,
  deferredSoon: (amount, date, line) => `Hoy no se cobra nada. Tu primer pago aquí, ${amount}, se cobra el ${date}. Después, ${line}.`,
  now: (amount, line) => `Su próximo pago ya toca, así que el primero aquí, ${amount}, se cobra cuando la conservas. Después, ${line}.`,
  keep: "Conservar mi membresía",
  seePrices: (title) => `Ver los precios de hoy de ${title}`,
  doNothing: "Si no haces nada, aquí no se cobra nada.",
  notices: {
    expired: { title: "Este enlace ya no funciona", body: "Era para una persona y una membresía, durante un tiempo limitado. La página de la tienda tiene la membresía, si quieres unirte." },
    unavailable: { title: "Esta membresía no está a la venta ahora mismo", body: "No se cobró nada. El dueño de la tienda puede darte más información." },
    price: { title: "Este precio ya no se ofrece", body: "La tienda ya no ofrece el precio para el que era este enlace, así que no puede conservar tu membresía a ese precio. No se cobró nada." },
    refused: { title: "No se pudo abrir la página de pago", body: "No se cobró nada. Inténtalo de nuevo en unos minutos." },
    limited: { title: "Han sido muchos intentos", body: "No se cobró nada. Espera unos minutos y pulsa el botón otra vez." },
    kept: { title: "Ya conservaste esta membresía", body: "Ya está conservada aquí, así que no hace falta nada más, y no se volvió a cobrar nada." },
  },
  inviteSubject: (title, store) => `Conserva tu membresía de ${title} con ${store}`,
  inviteDeferred: (store, title, amount, date) =>
    `${store} ha trasladado sus membresías a su propia tienda, y tu membresía de ${title} puede venir contigo. Consérvala con el enlace de abajo. No se cobra nada antes del ${date}, el día en que se habría renovado, y el primer pago aquí es de ${amount}.`,
  inviteNow: (store, title, amount) =>
    `${store} ha trasladado sus membresías a su propia tienda, y tu membresía de ${title} puede venir contigo. Su próximo pago ya toca, así que al conservarla con el enlace de abajo se cobra el primer pago aquí, ${amount}.`,
  linkNote: (until) => `El enlace es solo tuyo y funciona hasta el ${until}. Si no haces nada, aquí no se cobra nada.`,
  whyReminder: (store, date) =>
    `Recibes esto porque ${store} trasladó a sus miembros aquí. Si para entonces no has conservado tu membresía, se envía un único recordatorio unos días antes del ${date}, y nada más.`,
  whyOnce: (store) => `Recibes este único email porque ${store} trasladó a sus miembros aquí. No se envía nada más por este motivo.`,
  reminderSubject: (title) => `Recordatorio: tu membresía de ${title}`,
  reminderBody: (store, title, amount, date) =>
    `Tu membresía de ${title} con ${store} aún no se ha trasladado. Consérvala con el enlace de abajo. No se cobra nada antes del ${date}, y el primer pago aquí es de ${amount}.`,
  reminderLast: "Este es el único recordatorio. Si no haces nada, aquí no se cobra nada.",
  sentBy: (store) => `Enviado por Marktmorgen en nombre de ${store}.`,
  stopLine: (store, link) => `Dejar de recibir correos de ${store} sobre el traslado de tu membresía: ${link}`,
  stopAsk: (who) => `¿Dejar de recibir correos de ${who || "esta tienda"} sobre el traslado de tu membresía?`,
  stopButton: "Dejar de recibir estos correos",
  stopDoneTitle: "No más correos sobre esto",
  stopDone: (email, who) => `${email} no recibirá más correos de ${who || "esta tienda"} sobre el traslado de una membresía, ni ningún otro recordatorio suyo. No hace falta nada más.`,
};

const fr: MoveWords = {
  pageTitle: "Gardez votre abonnement",
  label: "Transfert de votre abonnement",
  intro: (store, title) => `${store} a transféré ses abonnements ici, et le vôtre à ${title} peut vous suivre.`,
  forAddress: (email) => `Ce lien est destiné à ${email}.`,
  deferred: (amount, date, line) =>
    `Rien n'est débité aujourd'hui. Votre premier paiement ici, ${amount}, est prélevé le ${date}, le jour où votre abonnement se serait renouvelé. Ensuite, ${line}.`,
  deferredSoon: (amount, date, line) => `Rien n'est débité aujourd'hui. Votre premier paiement ici, ${amount}, est prélevé le ${date}. Ensuite, ${line}.`,
  now: (amount, line) => `Son prochain paiement est dû maintenant, donc le premier ici, ${amount}, est prélevé lorsque vous le gardez. Ensuite, ${line}.`,
  keep: "Garder mon abonnement",
  seePrices: (title) => `Voir les prix actuels de ${title}`,
  doNothing: "Si vous ne faites rien, rien n'est débité ici.",
  notices: {
    expired: { title: "Ce lien ne fonctionne plus", body: "Il était destiné à une personne et à un abonnement, pour une durée limitée. La page de la boutique propose l'abonnement, si vous souhaitez le rejoindre." },
    unavailable: { title: "Cet abonnement n'est pas en vente pour le moment", body: "Rien n'a été débité. Le propriétaire de la boutique peut vous en dire plus." },
    price: { title: "Ce prix n'est plus proposé", body: "La boutique ne propose plus le prix auquel ce lien correspondait, il ne peut donc pas garder votre abonnement à ce prix. Rien n'a été débité." },
    refused: { title: "La page de paiement n'a pas pu s'ouvrir", body: "Rien n'a été débité. Réessayez dans quelques minutes." },
    limited: { title: "Cela fait beaucoup d'essais", body: "Rien n'a été débité. Patientez quelques minutes puis appuyez de nouveau sur le bouton." },
    kept: { title: "Vous avez gardé cet abonnement", body: "Il est déjà gardé ici, vous n'avez donc rien d'autre à faire, et rien n'a été débité de nouveau." },
  },
  inviteSubject: (title, store) => `Gardez votre abonnement à ${title} chez ${store}`,
  inviteDeferred: (store, title, amount, date) =>
    `${store} a transféré ses abonnements vers sa propre boutique, et votre abonnement à ${title} peut vous suivre. Gardez-le avec le lien ci-dessous. Rien n'est débité avant le ${date}, le jour où il se serait renouvelé, et le premier paiement ici est de ${amount}.`,
  inviteNow: (store, title, amount) =>
    `${store} a transféré ses abonnements vers sa propre boutique, et votre abonnement à ${title} peut vous suivre. Son prochain paiement est dû maintenant, donc le garder avec le lien ci-dessous prélève le premier paiement ici, ${amount}.`,
  linkNote: (until) => `Ce lien n'appartient qu'à vous et fonctionne jusqu'au ${until}. Si vous ne faites rien, rien n'est débité ici.`,
  whyReminder: (store, date) =>
    `Vous recevez ce message parce que ${store} a transféré ses membres ici. Si vous n'avez pas gardé votre abonnement d'ici là, un seul rappel est envoyé quelques jours avant le ${date}, et rien de plus.`,
  whyOnce: (store) => `Vous recevez ce seul e-mail parce que ${store} a transféré ses membres ici. Rien d'autre n'est envoyé pour cette raison.`,
  reminderSubject: (title) => `Rappel${S}: votre abonnement à ${title}`,
  reminderBody: (store, title, amount, date) =>
    `Votre abonnement à ${title} chez ${store} n'a pas encore été transféré. Gardez-le avec le lien ci-dessous. Rien n'est débité avant le ${date}, et le premier paiement ici est de ${amount}.`,
  reminderLast: "C'est le seul rappel. Si vous ne faites rien, rien n'est débité ici.",
  sentBy: (store) => `Envoyé par Marktmorgen pour le compte de ${store}.`,
  stopLine: (store, link) => `Ne plus recevoir d'e-mails de ${store} sur le transfert de votre abonnement${S}: ${link}`,
  stopAsk: (who) => `Ne plus recevoir d'e-mails de ${who || "cette boutique"} sur le transfert de votre abonnement${S}?`,
  stopButton: "Ne plus recevoir ces e-mails",
  stopDoneTitle: "Plus d'e-mails à ce sujet",
  stopDone: (email, who) => `${email} ne recevra plus d'e-mails de ${who || "cette boutique"} sur le transfert d'un abonnement, ni aucun autre de ses rappels. Vous n'avez rien d'autre à faire.`,
};

const de: MoveWords = {
  pageTitle: "Behalten Sie Ihre Mitgliedschaft",
  label: "Umzug Ihrer Mitgliedschaft",
  intro: (store, title) => `${store} hat seine Mitgliedschaften hierher verlegt, und Ihre Mitgliedschaft bei ${title} kann mitkommen.`,
  forAddress: (email) => `Dieser Link ist für ${email}.`,
  deferred: (amount, date, line) =>
    `Heute wird nichts berechnet. Ihre erste Zahlung hier, ${amount}, wird am ${date} abgebucht, dem Tag, an dem sich Ihre Mitgliedschaft verlängert hätte. Danach ${line}.`,
  deferredSoon: (amount, date, line) => `Heute wird nichts berechnet. Ihre erste Zahlung hier, ${amount}, wird am ${date} abgebucht. Danach ${line}.`,
  now: (amount, line) => `Ihre nächste Zahlung ist jetzt fällig, daher wird die erste hier, ${amount}, abgebucht, wenn Sie sie behalten. Danach ${line}.`,
  keep: "Meine Mitgliedschaft behalten",
  seePrices: (title) => `Heutige Preise für ${title} ansehen`,
  doNothing: "Wenn Sie nichts tun, wird hier nichts berechnet.",
  notices: {
    expired: { title: "Dieser Link funktioniert nicht mehr", body: "Er galt für eine Person und eine Mitgliedschaft, für begrenzte Zeit. Auf der Seite des Shops finden Sie die Mitgliedschaft, wenn Sie beitreten möchten." },
    unavailable: { title: "Diese Mitgliedschaft wird gerade nicht angeboten", body: "Es wurde nichts berechnet. Der Inhaber des Shops kann Ihnen mehr sagen." },
    price: { title: "Dieser Preis wird nicht mehr angeboten", body: "Der Shop bietet den Preis, für den dieser Link galt, nicht mehr an, deshalb kann er Ihre Mitgliedschaft nicht zu diesem Preis fortführen. Es wurde nichts berechnet." },
    refused: { title: "Die Zahlungsseite konnte nicht geöffnet werden", body: "Es wurde nichts berechnet. Versuchen Sie es in ein paar Minuten noch einmal." },
    limited: { title: "Das waren viele Versuche", body: "Es wurde nichts berechnet. Warten Sie ein paar Minuten und drücken Sie dann erneut auf die Schaltfläche." },
    kept: { title: "Sie haben diese Mitgliedschaft behalten", body: "Sie ist hier bereits behalten, es ist also nichts mehr nötig, und es wurde nichts erneut berechnet." },
  },
  inviteSubject: (title, store) => `Behalten Sie Ihre Mitgliedschaft bei ${title} von ${store}`,
  inviteDeferred: (store, title, amount, date) =>
    `${store} hat seine Mitgliedschaften in seinen eigenen Shop verlegt, und Ihre Mitgliedschaft bei ${title} kann mitkommen. Behalten Sie sie über den Link unten. Vor dem ${date}, dem Tag, an dem sie sich verlängert hätte, wird nichts berechnet, und die erste Zahlung hier beträgt ${amount}.`,
  inviteNow: (store, title, amount) =>
    `${store} hat seine Mitgliedschaften in seinen eigenen Shop verlegt, und Ihre Mitgliedschaft bei ${title} kann mitkommen. Ihre nächste Zahlung ist jetzt fällig, daher wird beim Behalten über den Link unten die erste Zahlung hier abgebucht: ${amount}.`,
  linkNote: (until) => `Der Link gilt nur für Sie und funktioniert bis zum ${until}. Wenn Sie nichts tun, wird hier nichts berechnet.`,
  whyReminder: (store, date) =>
    `Sie erhalten diese Nachricht, weil ${store} seine Mitglieder hierher verlegt hat. Wenn Sie Ihre Mitgliedschaft bis dahin nicht behalten haben, kommt einige Tage vor dem ${date} eine einzige Erinnerung, sonst nichts.`,
  whyOnce: (store) => `Sie erhalten diese eine E-Mail, weil ${store} seine Mitglieder hierher verlegt hat. Deswegen wird sonst nichts gesendet.`,
  reminderSubject: (title) => `Erinnerung: Ihre Mitgliedschaft bei ${title}`,
  reminderBody: (store, title, amount, date) =>
    `Ihre Mitgliedschaft bei ${title} von ${store} ist noch nicht umgezogen. Behalten Sie sie über den Link unten. Vor dem ${date} wird nichts berechnet, und die erste Zahlung hier beträgt ${amount}.`,
  reminderLast: "Dies ist die einzige Erinnerung. Wenn Sie nichts tun, wird hier nichts berechnet.",
  sentBy: (store) => `Gesendet von Marktmorgen im Auftrag von ${store}.`,
  stopLine: (store, link) => `Keine E-Mails mehr von ${store} zum Umzug Ihrer Mitgliedschaft: ${link}`,
  stopAsk: (who) => `Keine E-Mails mehr von ${who || "diesem Shop"} zum Umzug Ihrer Mitgliedschaft?`,
  stopButton: "Diese E-Mails stoppen",
  stopDoneTitle: "Keine E-Mails mehr dazu",
  stopDone: (email, who) => `${email} erhält keine E-Mails mehr von ${who || "diesem Shop"} zum Umzug einer Mitgliedschaft und auch keine anderen Erinnerungen von dort. Sonst ist nichts nötig.`,
};

const it: MoveWords = {
  pageTitle: "Mantieni il tuo abbonamento",
  label: "Trasferimento del tuo abbonamento",
  intro: (store, title) => `${store} ha trasferito qui i suoi abbonamenti, e il tuo a ${title} può venire con te.`,
  forAddress: (email) => `Questo link è per ${email}.`,
  deferred: (amount, date, line) =>
    `Oggi non viene addebitato nulla. Il tuo primo pagamento qui, ${amount}, viene addebitato il ${date}, il giorno in cui il tuo abbonamento si sarebbe rinnovato. Poi, ${line}.`,
  deferredSoon: (amount, date, line) => `Oggi non viene addebitato nulla. Il tuo primo pagamento qui, ${amount}, viene addebitato il ${date}. Poi, ${line}.`,
  now: (amount, line) => `Il suo prossimo pagamento è dovuto adesso, quindi il primo qui, ${amount}, viene addebitato quando lo mantieni. Poi, ${line}.`,
  keep: "Mantieni il mio abbonamento",
  seePrices: (title) => `Vedi i prezzi di oggi per ${title}`,
  doNothing: "Se non fai nulla, qui non viene addebitato nulla.",
  notices: {
    expired: { title: "Questo link non funziona più", body: "Era per una persona e un abbonamento, per un tempo limitato. La pagina del negozio ha l'abbonamento, se vuoi iscriverti." },
    unavailable: { title: "Questo abbonamento al momento non è in vendita", body: "Non è stato addebitato nulla. Il proprietario del negozio può darti più informazioni." },
    price: { title: "Questo prezzo non è più offerto", body: "Il negozio non offre più il prezzo a cui si riferiva questo link, quindi non può mantenere il tuo abbonamento a quel prezzo. Non è stato addebitato nulla." },
    refused: { title: "Non è stato possibile aprire la pagina di pagamento", body: "Non è stato addebitato nulla. Riprova tra qualche minuto." },
    limited: { title: "Sono stati molti tentativi", body: "Non è stato addebitato nulla. Aspetta qualche minuto e premi di nuovo il pulsante." },
    kept: { title: "Hai mantenuto questo abbonamento", body: "È già mantenuto qui, quindi non serve altro, e non è stato addebitato nulla di nuovo." },
  },
  inviteSubject: (title, store) => `Mantieni il tuo abbonamento a ${title} con ${store}`,
  inviteDeferred: (store, title, amount, date) =>
    `${store} ha trasferito i suoi abbonamenti nel proprio negozio, e il tuo abbonamento a ${title} può venire con te. Mantienilo con il link qui sotto. Non viene addebitato nulla prima del ${date}, il giorno in cui si sarebbe rinnovato, e il primo pagamento qui è di ${amount}.`,
  inviteNow: (store, title, amount) =>
    `${store} ha trasferito i suoi abbonamenti nel proprio negozio, e il tuo abbonamento a ${title} può venire con te. Il suo prossimo pagamento è dovuto adesso, quindi mantenerlo con il link qui sotto addebita il primo pagamento qui, ${amount}.`,
  linkNote: (until) => `Il link è solo tuo e funziona fino al ${until}. Se non fai nulla, qui non viene addebitato nulla.`,
  whyReminder: (store, date) =>
    `Ricevi questo messaggio perché ${store} ha trasferito qui i suoi membri. Se per allora non avrai mantenuto il tuo abbonamento, viene inviato un solo promemoria qualche giorno prima del ${date}, e nient'altro.`,
  whyOnce: (store) => `Ricevi questa sola email perché ${store} ha trasferito qui i suoi membri. Non viene inviato nient'altro per questo motivo.`,
  reminderSubject: (title) => `Promemoria: il tuo abbonamento a ${title}`,
  reminderBody: (store, title, amount, date) =>
    `Il tuo abbonamento a ${title} con ${store} non è ancora stato trasferito. Mantienilo con il link qui sotto. Non viene addebitato nulla prima del ${date}, e il primo pagamento qui è di ${amount}.`,
  reminderLast: "Questo è l'unico promemoria. Se non fai nulla, qui non viene addebitato nulla.",
  sentBy: (store) => `Inviato da Marktmorgen per conto di ${store}.`,
  stopLine: (store, link) => `Non ricevere più email da ${store} sul trasferimento del tuo abbonamento: ${link}`,
  stopAsk: (who) => `Non ricevere più email da ${who || "questo negozio"} sul trasferimento del tuo abbonamento?`,
  stopButton: "Interrompi queste email",
  stopDoneTitle: "Niente più email su questo",
  stopDone: (email, who) => `${email} non riceverà più email da ${who || "questo negozio"} sul trasferimento di un abbonamento, né altri suoi promemoria. Non serve altro.`,
};

const nl: MoveWords = {
  pageTitle: "Houd je lidmaatschap",
  label: "Je lidmaatschap verhuist",
  intro: (store, title) => `${store} heeft zijn lidmaatschappen hierheen verhuisd, en het jouwe van ${title} kan mee.`,
  forAddress: (email) => `Deze link is voor ${email}.`,
  deferred: (amount, date, line) =>
    `Vandaag wordt er niets afgeschreven. Je eerste betaling hier, ${amount}, wordt op ${date} afgeschreven, de dag waarop je lidmaatschap zou zijn verlengd. Daarna ${line}.`,
  deferredSoon: (amount, date, line) => `Vandaag wordt er niets afgeschreven. Je eerste betaling hier, ${amount}, wordt op ${date} afgeschreven. Daarna ${line}.`,
  now: (amount, line) => `De volgende betaling is nu al aan de beurt, dus de eerste hier, ${amount}, wordt afgeschreven als je het houdt. Daarna ${line}.`,
  keep: "Mijn lidmaatschap houden",
  seePrices: (title) => `Bekijk de prijzen van vandaag voor ${title}`,
  doNothing: "Als je niets doet, wordt hier niets afgeschreven.",
  notices: {
    expired: { title: "Deze link werkt niet meer", body: "Hij was voor één persoon en één lidmaatschap, voor beperkte tijd. Op de pagina van de winkel staat het lidmaatschap, als je lid wilt worden." },
    unavailable: { title: "Dit lidmaatschap is nu niet te koop", body: "Er is niets afgeschreven. De eigenaar van de winkel kan je meer vertellen." },
    price: { title: "Deze prijs wordt niet meer aangeboden", body: "De winkel biedt de prijs waarvoor deze link was niet meer aan, dus hij kan je lidmaatschap niet tegen die prijs houden. Er is niets afgeschreven." },
    refused: { title: "De betaalpagina kon niet worden geopend", body: "Er is niets afgeschreven. Probeer het over een paar minuten opnieuw." },
    limited: { title: "Dat waren veel pogingen", body: "Er is niets afgeschreven. Wacht een paar minuten en druk dan opnieuw op de knop." },
    kept: { title: "Je hebt dit lidmaatschap gehouden", body: "Het is hier al gehouden, dus er is verder niets nodig, en er is niets opnieuw afgeschreven." },
  },
  inviteSubject: (title, store) => `Houd je lidmaatschap van ${title} bij ${store}`,
  inviteDeferred: (store, title, amount, date) =>
    `${store} heeft zijn lidmaatschappen naar zijn eigen winkel verhuisd, en je lidmaatschap van ${title} kan mee. Houd het via de link hieronder. Er wordt niets afgeschreven vóór ${date}, de dag waarop het zou zijn verlengd, en de eerste betaling hier is ${amount}.`,
  inviteNow: (store, title, amount) =>
    `${store} heeft zijn lidmaatschappen naar zijn eigen winkel verhuisd, en je lidmaatschap van ${title} kan mee. De volgende betaling is nu al aan de beurt, dus als je het via de link hieronder houdt, wordt de eerste betaling hier afgeschreven, ${amount}.`,
  linkNote: (until) => `De link is alleen voor jou en werkt tot ${until}. Als je niets doet, wordt hier niets afgeschreven.`,
  whyReminder: (store, date) =>
    `Je krijgt dit omdat ${store} zijn leden hierheen heeft verhuisd. Heb je je lidmaatschap dan nog niet gehouden, dan komt er een paar dagen voor ${date} één herinnering, en verder niets.`,
  whyOnce: (store) => `Je krijgt deze ene e-mail omdat ${store} zijn leden hierheen heeft verhuisd. Daarom wordt er verder niets gestuurd.`,
  reminderSubject: (title) => `Herinnering: je lidmaatschap van ${title}`,
  reminderBody: (store, title, amount, date) =>
    `Je lidmaatschap van ${title} bij ${store} is nog niet verhuisd. Houd het via de link hieronder. Er wordt niets afgeschreven vóór ${date}, en de eerste betaling hier is ${amount}.`,
  reminderLast: "Dit is de enige herinnering. Als je niets doet, wordt hier niets afgeschreven.",
  sentBy: (store) => `Verstuurd door Marktmorgen namens ${store}.`,
  stopLine: (store, link) => `Geen e-mails meer van ${store} over het verhuizen van je lidmaatschap: ${link}`,
  stopAsk: (who) => `Geen e-mails meer van ${who || "deze winkel"} over het verhuizen van je lidmaatschap?`,
  stopButton: "Stop deze e-mails",
  stopDoneTitle: "Geen e-mails meer hierover",
  stopDone: (email, who) => `${email} krijgt geen e-mails meer van ${who || "deze winkel"} over het verhuizen van een lidmaatschap, en ook geen andere herinneringen van daar. Verder hoef je niets te doen.`,
};

const pt: MoveWords = {
  pageTitle: "Mantenha a sua subscrição",
  label: "Transferência da sua subscrição",
  intro: (store, title) => `${store} transferiu as suas subscrições para aqui, e a sua de ${title} pode vir consigo.`,
  forAddress: (email) => `Esta ligação é para ${email}.`,
  deferred: (amount, date, line) =>
    `Hoje não é cobrado nada. O seu primeiro pagamento aqui, ${amount}, é cobrado a ${date}, o dia em que a sua subscrição se renovaria. Depois disso, ${line}.`,
  deferredSoon: (amount, date, line) => `Hoje não é cobrado nada. O seu primeiro pagamento aqui, ${amount}, é cobrado a ${date}. Depois disso, ${line}.`,
  now: (amount, line) => `O próximo pagamento já é devido, por isso o primeiro aqui, ${amount}, é cobrado quando a mantiver. Depois disso, ${line}.`,
  keep: "Manter a minha subscrição",
  seePrices: (title) => `Ver os preços de hoje de ${title}`,
  doNothing: "Se não fizer nada, não é cobrado nada aqui.",
  notices: {
    expired: { title: "Esta ligação já não funciona", body: "Era para uma pessoa e uma subscrição, por tempo limitado. A página da loja tem a subscrição, se quiser aderir." },
    unavailable: { title: "Esta subscrição não está à venda neste momento", body: "Não foi cobrado nada. O proprietário da loja pode dar-lhe mais informações." },
    price: { title: "Este preço já não é oferecido", body: "A loja já não oferece o preço a que esta ligação se referia, por isso não pode manter a sua subscrição a esse preço. Não foi cobrado nada." },
    refused: { title: "Não foi possível abrir a página de pagamento", body: "Não foi cobrado nada. Tente novamente dentro de alguns minutos." },
    limited: { title: "Foram muitas tentativas", body: "Não foi cobrado nada. Aguarde alguns minutos e prima o botão novamente." },
    kept: { title: "Já manteve esta subscrição", body: "Já está mantida aqui, por isso não é preciso mais nada, e não foi cobrado nada de novo." },
  },
  inviteSubject: (title, store) => `Mantenha a sua subscrição de ${title} com ${store}`,
  inviteDeferred: (store, title, amount, date) =>
    `${store} transferiu as suas subscrições para a sua própria loja, e a sua subscrição de ${title} pode vir consigo. Mantenha-a com a ligação abaixo. Não é cobrado nada antes de ${date}, o dia em que se renovaria, e o primeiro pagamento aqui é de ${amount}.`,
  inviteNow: (store, title, amount) =>
    `${store} transferiu as suas subscrições para a sua própria loja, e a sua subscrição de ${title} pode vir consigo. O próximo pagamento já é devido, por isso mantê-la com a ligação abaixo cobra o primeiro pagamento aqui, ${amount}.`,
  linkNote: (until) => `A ligação é só sua e funciona até ${until}. Se não fizer nada, não é cobrado nada aqui.`,
  whyReminder: (store, date) =>
    `Recebe esta mensagem porque ${store} transferiu os seus membros para aqui. Se até lá não tiver mantido a sua subscrição, é enviado um único lembrete alguns dias antes de ${date}, e nada mais.`,
  whyOnce: (store) => `Recebe este único email porque ${store} transferiu os seus membros para aqui. Não é enviado mais nada por esse motivo.`,
  reminderSubject: (title) => `Lembrete: a sua subscrição de ${title}`,
  reminderBody: (store, title, amount, date) =>
    `A sua subscrição de ${title} com ${store} ainda não foi transferida. Mantenha-a com a ligação abaixo. Não é cobrado nada antes de ${date}, e o primeiro pagamento aqui é de ${amount}.`,
  reminderLast: "Este é o único lembrete. Se não fizer nada, não é cobrado nada aqui.",
  sentBy: (store) => `Enviado pela Marktmorgen em nome de ${store}.`,
  stopLine: (store, link) => `Deixar de receber emails de ${store} sobre a transferência da sua subscrição: ${link}`,
  stopAsk: (who) => `Deixar de receber emails ${who ? `de ${who}` : "desta loja"} sobre a transferência da sua subscrição?`,
  stopButton: "Deixar de receber estes emails",
  stopDoneTitle: "Sem mais emails sobre isto",
  stopDone: (email, who) => `${email} não voltará a receber emails ${who ? `de ${who}` : "desta loja"} sobre a transferência de uma subscrição, nem nenhum outro lembrete seu. Não é preciso mais nada.`,
};

export const MOVE_WORDS: Record<LanguageCode, MoveWords> = { en, es, fr, de, it, nl, pt };

export function moveWords(language: unknown): MoveWords {
  return MOVE_WORDS[parseLanguage(language)];
}
