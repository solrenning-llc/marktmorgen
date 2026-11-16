/**
 * What an affiliate reads about pay per lead (lib/affiliate-leads.ts, added
 * 18 October 2026), in each of the store's languages: the terms before they
 * apply, the disclosure, and each lead's status on their own page. Amounts and
 * dates arrive already written in the store's language.
 */
import type { LeadKind, LeadReason, LeadStatus } from "@/lib/affiliate-lead-rules";
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type LeadWords = {
  term: (kind: LeadKind, amount: string, store: string) => string;
  termRules: (hold: number, daily: number, budget: string, store: string) => string;
  disclose: string;
  head: string;
  kind: Record<LeadKind, string>;
  status: Record<LeadStatus, string>;
  reason: Record<LeadReason, string>;
  until: (date: string) => string;
  /** A person who asked to be deleted, in place of their address. */
  deleted: string;
};

const en: LeadWords = {
  term: (kind, amount, store) =>
    kind === "signup"
      ? `${amount} for each confirmed email sign-up to ${store}'s list through your link: the person confirms from the email they are sent, and only an address new to the list counts.`
      : kind === "free"
        ? `${amount} for each free product claimed through your link, counted when the person opens the link emailed to them, the first time that address gets it.`
        : `${amount} for each call booked through your link that takes place: counted after the call, when it was not refunded and ${store} confirms it happened.`,
  termRules: (hold, daily, budget, store) =>
    `One lead per person, ever, and never your own address. A lead is payable after a ${hold}-day hold and once ${store} approves it. Up to ${daily} of your leads earn in a day, and all affiliates' leads together earn up to ${budget} a month; past that a lead is still shown to you and earns nothing. ${store} can reverse a lead that is not genuine, and you see why.`,
  disclose:
    "Being paid for each lead is a material connection too: say so wherever you ask people to sign up, claim or book through your link, and never sign anybody up yourself or use addresses that are not theirs.",
  head: "Your leads",
  kind: { signup: "Email sign-up", free: "Free product claimed", booking: "Booked call" },
  status: {
    "waiting for the call": "waiting for the call",
    "in hold": "in hold",
    "needs approval": "waiting for the store's approval",
    approved: "approved, payable",
    "not genuine": "reversed",
    refunded: "reversed: the booking was refunded",
    "over daily cap": "over the daily cap, earns nothing",
    "over hourly limit": "over the hourly limit, earns nothing",
    "over monthly budget": "over the program's monthly budget, earns nothing",
  },
  reason: { fake: "not a real person", duplicate: "the same person under another address", "no-show": "the call did not take place", other: "another reason" },
  until: (date) => `until ${date}`,
  deleted: "a person who asked to be deleted",
};

const es: LeadWords = {
  term: (kind, amount, store) =>
    kind === "signup"
      ? `${amount} por cada suscripción confirmada a la lista de ${store} a través de tu enlace: la persona la confirma desde el correo que recibe, y solo cuenta una dirección nueva en la lista.`
      : kind === "free"
        ? `${amount} por cada producto gratuito solicitado a través de tu enlace, contado cuando la persona abre el enlace que se le envía por correo, la primera vez que esa dirección lo recibe.`
        : `${amount} por cada llamada reservada a través de tu enlace que se realiza: se cuenta después de la llamada, si no se reembolsó y ${store} confirma que tuvo lugar.`,
  termRules: (hold, daily, budget, store) =>
    `Un lead por persona, para siempre, y nunca tu propia dirección. Un lead se puede pagar tras ${hold} días de espera y cuando ${store} lo aprueba. Hasta ${daily} de tus leads ganan en un día, y los leads de todos los afiliados juntos ganan hasta ${budget} al mes; pasado eso, el lead se te sigue mostrando y no gana nada. ${store} puede anular un lead que no sea genuino, y tú ves por qué.`,
  disclose:
    "Cobrar por cada lead también es una relación material: dilo dondequiera que pidas a la gente que se suscriba, solicite o reserve con tu enlace, y nunca suscribas tú a nadie ni uses direcciones que no sean suyas.",
  head: "Tus leads",
  kind: { signup: "Suscripción por correo", free: "Producto gratuito solicitado", booking: "Llamada reservada" },
  status: {
    "waiting for the call": "esperando la llamada",
    "in hold": "en espera",
    "needs approval": "esperando la aprobación de la tienda",
    approved: "aprobado, pagadero",
    "not genuine": "anulado",
    refunded: "anulado: la reserva se reembolsó",
    "over daily cap": "por encima del límite diario, no gana nada",
    "over hourly limit": "por encima del límite por hora, no gana nada",
    "over monthly budget": "por encima del presupuesto mensual del programa, no gana nada",
  },
  reason: { fake: "no es una persona real", duplicate: "la misma persona con otra dirección", "no-show": "la llamada no tuvo lugar", other: "otro motivo" },
  until: (date) => `hasta el ${date}`,
  deleted: "una persona que pidió ser eliminada",
};

const fr: LeadWords = {
  term: (kind, amount, store) =>
    kind === "signup"
      ? `${amount} pour chaque inscription confirmée à la liste de ${store} par votre lien : la personne confirme depuis l'e-mail qu'elle reçoit, et seule une adresse nouvelle sur la liste compte.`
      : kind === "free"
        ? `${amount} pour chaque produit gratuit demandé par votre lien, compté quand la personne ouvre le lien qui lui est envoyé par e-mail, la première fois que cette adresse le reçoit.`
        : `${amount} pour chaque appel réservé par votre lien qui a lieu : compté après l'appel, s'il n'a pas été remboursé et que ${store} confirme qu'il a eu lieu.`,
  termRules: (hold, daily, budget, store) =>
    `Un lead par personne, une fois pour toutes, et jamais votre propre adresse. Un lead est payable après ${hold} jours d'attente et une fois approuvé par ${store}. Jusqu'à ${daily} de vos leads rapportent par jour, et les leads de tous les affiliés ensemble rapportent jusqu'à ${budget} par mois ; au-delà, un lead vous est toujours montré et ne rapporte rien. ${store} peut annuler un lead qui n'est pas authentique, et vous voyez pourquoi.`,
  disclose:
    "Être payé pour chaque lead est aussi un lien matériel : dites-le partout où vous demandez aux gens de s'inscrire, de demander ou de réserver par votre lien, et n'inscrivez jamais personne vous-même ni avec des adresses qui ne sont pas les leurs.",
  head: "Vos leads",
  kind: { signup: "Inscription par e-mail", free: "Produit gratuit demandé", booking: "Appel réservé" },
  status: {
    "waiting for the call": "en attente de l'appel",
    "in hold": "en attente",
    "needs approval": "en attente de l'approbation de la boutique",
    approved: "approuvé, payable",
    "not genuine": "annulé",
    refunded: "annulé : la réservation a été remboursée",
    "over daily cap": "au-delà du plafond quotidien, ne rapporte rien",
    "over hourly limit": "au-delà de la limite horaire, ne rapporte rien",
    "over monthly budget": "au-delà du budget mensuel du programme, ne rapporte rien",
  },
  reason: { fake: "pas une vraie personne", duplicate: "la même personne sous une autre adresse", "no-show": "l'appel n'a pas eu lieu", other: "une autre raison" },
  until: (date) => `jusqu'au ${date}`,
  deleted: "une personne qui a demandé à être supprimée",
};

const de: LeadWords = {
  term: (kind, amount, store) =>
    kind === "signup"
      ? `${amount} für jede bestätigte Anmeldung zur Liste von ${store} über Ihren Link: Die Person bestätigt sie in der E-Mail, die sie erhält, und nur eine Adresse, die neu auf der Liste ist, zählt.`
      : kind === "free"
        ? `${amount} für jedes kostenlose Produkt, das über Ihren Link angefordert wird, gezählt, wenn die Person den ihr gemailten Link öffnet, das erste Mal, dass diese Adresse es erhält.`
        : `${amount} für jedes über Ihren Link gebuchte Gespräch, das stattfindet: gezählt nach dem Gespräch, wenn es nicht erstattet wurde und ${store} bestätigt, dass es stattfand.`,
  termRules: (hold, daily, budget, store) =>
    `Ein Lead pro Person, für immer, und nie Ihre eigene Adresse. Ein Lead ist nach ${hold} Tagen Wartezeit auszahlbar, sobald ${store} ihn freigibt. Bis zu ${daily} Ihrer Leads verdienen an einem Tag, und die Leads aller Affiliates zusammen verdienen bis zu ${budget} im Monat; darüber hinaus wird ein Lead Ihnen weiter angezeigt und verdient nichts. ${store} kann einen Lead stornieren, der nicht echt ist, und Sie sehen den Grund.`,
  disclose:
    "Für jeden Lead bezahlt zu werden ist ebenfalls eine wesentliche Verbindung: Sagen Sie das überall, wo Sie Menschen bitten, sich über Ihren Link anzumelden, etwas anzufordern oder zu buchen, und melden Sie nie selbst jemanden an oder verwenden Adressen, die nicht ihnen gehören.",
  head: "Ihre Leads",
  kind: { signup: "E-Mail-Anmeldung", free: "Kostenloses Produkt angefordert", booking: "Gebuchtes Gespräch" },
  status: {
    "waiting for the call": "wartet auf das Gespräch",
    "in hold": "in Wartezeit",
    "needs approval": "wartet auf die Freigabe des Shops",
    approved: "freigegeben, auszahlbar",
    "not genuine": "storniert",
    refunded: "storniert: die Buchung wurde erstattet",
    "over daily cap": "über dem Tageslimit, verdient nichts",
    "over hourly limit": "über dem Stundenlimit, verdient nichts",
    "over monthly budget": "über dem Monatsbudget des Programms, verdient nichts",
  },
  reason: { fake: "keine echte Person", duplicate: "dieselbe Person unter einer anderen Adresse", "no-show": "das Gespräch fand nicht statt", other: "ein anderer Grund" },
  until: (date) => `bis ${date}`,
  deleted: "eine Person, die ihre Löschung verlangt hat",
};

const it: LeadWords = {
  term: (kind, amount, store) =>
    kind === "signup"
      ? `${amount} per ogni iscrizione confermata alla lista di ${store} tramite il tuo link: la persona conferma dall'email che riceve, e conta solo un indirizzo nuovo nella lista.`
      : kind === "free"
        ? `${amount} per ogni prodotto gratuito richiesto tramite il tuo link, contato quando la persona apre il link che le viene inviato via email, la prima volta che quell'indirizzo lo riceve.`
        : `${amount} per ogni chiamata prenotata tramite il tuo link che si svolge: contata dopo la chiamata, se non è stata rimborsata e ${store} conferma che si è svolta.`,
  termRules: (hold, daily, budget, store) =>
    `Un lead per persona, per sempre, e mai il tuo indirizzo. Un lead è pagabile dopo ${hold} giorni di attesa e quando ${store} lo approva. Fino a ${daily} dei tuoi lead guadagnano in un giorno, e i lead di tutti gli affiliati insieme guadagnano fino a ${budget} al mese; oltre, un lead ti viene comunque mostrato e non guadagna nulla. ${store} può annullare un lead non genuino, e tu vedi perché.`,
  disclose:
    "Essere pagati per ogni lead è anch'esso un legame rilevante: dillo ovunque chiedi alle persone di iscriversi, richiedere o prenotare con il tuo link, e non iscrivere mai nessuno tu stesso né usare indirizzi che non sono loro.",
  head: "I tuoi lead",
  kind: { signup: "Iscrizione via email", free: "Prodotto gratuito richiesto", booking: "Chiamata prenotata" },
  status: {
    "waiting for the call": "in attesa della chiamata",
    "in hold": "in attesa",
    "needs approval": "in attesa dell'approvazione del negozio",
    approved: "approvato, pagabile",
    "not genuine": "annullato",
    refunded: "annullato: la prenotazione è stata rimborsata",
    "over daily cap": "oltre il limite giornaliero, non guadagna nulla",
    "over hourly limit": "oltre il limite orario, non guadagna nulla",
    "over monthly budget": "oltre il budget mensile del programma, non guadagna nulla",
  },
  reason: { fake: "non è una persona reale", duplicate: "la stessa persona con un altro indirizzo", "no-show": "la chiamata non si è svolta", other: "un altro motivo" },
  until: (date) => `fino al ${date}`,
  deleted: "una persona che ha chiesto di essere cancellata",
};

const nl: LeadWords = {
  term: (kind, amount, store) =>
    kind === "signup"
      ? `${amount} voor elke bevestigde inschrijving op de lijst van ${store} via je link: de persoon bevestigt vanuit de e-mail die hij krijgt, en alleen een adres dat nieuw is op de lijst telt.`
      : kind === "free"
        ? `${amount} voor elk gratis product dat via je link wordt aangevraagd, geteld wanneer de persoon de link opent die hem gemaild wordt, de eerste keer dat dat adres het krijgt.`
        : `${amount} voor elk via je link geboekt gesprek dat plaatsvindt: geteld na het gesprek, als het niet is terugbetaald en ${store} bevestigt dat het heeft plaatsgevonden.`,
  termRules: (hold, daily, budget, store) =>
    `Eén lead per persoon, voorgoed, en nooit je eigen adres. Een lead is uitbetaalbaar na ${hold} dagen wachten en zodra ${store} hem goedkeurt. Tot ${daily} van je leads verdienen per dag, en de leads van alle affiliates samen verdienen tot ${budget} per maand; daarboven wordt een lead je nog steeds getoond en verdient hij niets. ${store} kan een lead die niet echt is terugdraaien, en jij ziet waarom.`,
  disclose:
    "Betaald worden per lead is ook een materiële band: zeg dat overal waar je mensen vraagt zich via je link in te schrijven, iets aan te vragen of te boeken, en schrijf nooit zelf iemand in of gebruik adressen die niet van hen zijn.",
  head: "Je leads",
  kind: { signup: "Inschrijving per e-mail", free: "Gratis product aangevraagd", booking: "Geboekt gesprek" },
  status: {
    "waiting for the call": "wacht op het gesprek",
    "in hold": "in wachttijd",
    "needs approval": "wacht op goedkeuring van de winkel",
    approved: "goedgekeurd, uitbetaalbaar",
    "not genuine": "teruggedraaid",
    refunded: "teruggedraaid: de boeking is terugbetaald",
    "over daily cap": "boven het daglimiet, verdient niets",
    "over hourly limit": "boven het uurlimiet, verdient niets",
    "over monthly budget": "boven het maandbudget van het programma, verdient niets",
  },
  reason: { fake: "geen echt persoon", duplicate: "dezelfde persoon onder een ander adres", "no-show": "het gesprek vond niet plaats", other: "een andere reden" },
  until: (date) => `tot ${date}`,
  deleted: "iemand die heeft gevraagd verwijderd te worden",
};

const pt: LeadWords = {
  term: (kind, amount, store) =>
    kind === "signup"
      ? `${amount} por cada inscrição confirmada na lista de ${store} através da sua ligação: a pessoa confirma a partir do e-mail que recebe, e só conta um endereço novo na lista.`
      : kind === "free"
        ? `${amount} por cada produto gratuito pedido através da sua ligação, contado quando a pessoa abre a ligação que lhe é enviada por e-mail, na primeira vez que esse endereço o recebe.`
        : `${amount} por cada chamada marcada através da sua ligação que se realiza: contada depois da chamada, se não foi reembolsada e ${store} confirma que aconteceu.`,
  termRules: (hold, daily, budget, store) =>
    `Um lead por pessoa, para sempre, e nunca o seu próprio endereço. Um lead pode ser pago após ${hold} dias de espera e quando ${store} o aprova. Até ${daily} dos seus leads ganham num dia, e os leads de todos os afiliados juntos ganham até ${budget} por mês; além disso, o lead continua a ser-lhe mostrado e não ganha nada. ${store} pode anular um lead que não seja genuíno, e vê porquê.`,
  disclose:
    "Ser pago por cada lead também é uma ligação material: diga-o sempre que pedir às pessoas que se inscrevam, peçam ou marquem através da sua ligação, e nunca inscreva ninguém por si próprio nem use endereços que não sejam delas.",
  head: "Os seus leads",
  kind: { signup: "Inscrição por e-mail", free: "Produto gratuito pedido", booking: "Chamada marcada" },
  status: {
    "waiting for the call": "à espera da chamada",
    "in hold": "em espera",
    "needs approval": "à espera da aprovação da loja",
    approved: "aprovado, pagável",
    "not genuine": "anulado",
    refunded: "anulado: a marcação foi reembolsada",
    "over daily cap": "acima do limite diário, não ganha nada",
    "over hourly limit": "acima do limite por hora, não ganha nada",
    "over monthly budget": "acima do orçamento mensal do programa, não ganha nada",
  },
  reason: { fake: "não é uma pessoa real", duplicate: "a mesma pessoa com outro endereço", "no-show": "a chamada não aconteceu", other: "outro motivo" },
  until: (date) => `até ${date}`,
  deleted: "uma pessoa que pediu para ser apagada",
};

export const LEAD_WORDS: Record<LanguageCode, LeadWords> = { en, es, fr, de, it, nl, pt };

export function leadWords(language: unknown): LeadWords {
  return LEAD_WORDS[parseLanguage(language)];
}
