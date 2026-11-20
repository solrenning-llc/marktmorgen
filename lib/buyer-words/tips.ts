/**
 * The words of the "Support my work" box on a store page (lib/store-tips.ts)
 * and the page a supporter comes back to. The creator may write the heading
 * and the line in their own words; these are what shows when they did not.
 * Browser-safe.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

type Notice = { title: string; body: string };

const en = {
  heading: "Support my work",
  line: (store: string) => `If something ${store} made has helped you, you can say thank you with an amount of your choosing. Nothing is bought: it goes straight to them.`,
  amounts: "Choose an amount",
  other: "Another amount",
  button: "Send my support",
  secure: "You pay on Stripe's secure page, and can leave a message there.",
  testMode: "Test mode: no real money is taken.",
  lineName: (store: string) => `Support for ${store}`,
  message: "Your message",
  pageTitle: "Thank you",
  thanksTitle: "Thank you for your support",
  thanksBody: (store: string, amount: string) => `Your ${amount} has reached ${store}. It goes to them directly, and the payment shows on your statement under their name.`,
  thanksBodyNoAmount: (store: string) => `Your support has reached ${store}. It goes to them directly, and the payment shows on your statement under their name, with the amount charged.`,
  waitingTitle: "This payment is not confirmed",
  waitingBody: "Stripe has not confirmed it. If you left the payment page before paying, nothing was charged.",
  range: (least: string, most: string) => `Choose one of the amounts, or type one from ${least} to ${most}.`,
  notices: {
    amount: { title: "Choose an amount", body: "Pick one of the amounts, or type another within the range shown." },
    limited: { title: "Too many tries for now", body: "Wait a few minutes and try again." },
    closed: { title: "This store is not taking support right now", body: "Nothing was charged." },
    error: { title: "The payment page could not be opened", body: "Nothing was charged. Try again in a moment." },
  } as Record<string, Notice>,
};

export type TipsWords = typeof en;

const es: TipsWords = {
  heading: "Apoya mi trabajo",
  line: (store) => `Si algo que hizo ${store} te ha servido, puedes darle las gracias con la cantidad que elijas. No compras nada: le llega directamente.`,
  amounts: "Elige una cantidad",
  other: "Otra cantidad",
  button: "Enviar mi apoyo",
  secure: "Pagas en la página segura de Stripe, donde también puedes dejar un mensaje.",
  testMode: "Modo de prueba: no se cobra dinero real.",
  lineName: (store) => `Apoyo a ${store}`,
  message: "Tu mensaje",
  pageTitle: "Gracias",
  thanksTitle: "Gracias por tu apoyo",
  thanksBody: (store, amount) => `Tus ${amount} han llegado a ${store}. Le llegan directamente, y el pago aparece en tu extracto con su nombre.`,
  thanksBodyNoAmount: (store) => `Tu apoyo ha llegado a ${store}. Le llega directamente, y el pago aparece en tu extracto con su nombre y la cantidad cobrada.`,
  waitingTitle: "Este pago no está confirmado",
  waitingBody: "Stripe no lo ha confirmado. Si saliste de la página de pago antes de pagar, no se cobró nada.",
  range: (least, most) => `Elige una de las cantidades o escribe otra de ${least} a ${most}.`,
  notices: {
    amount: { title: "Elige una cantidad", body: "Escoge una de las cantidades o escribe otra dentro del rango indicado." },
    limited: { title: "Demasiados intentos por ahora", body: "Espera unos minutos y vuelve a intentarlo." },
    closed: { title: "Esta tienda no recibe apoyos ahora mismo", body: "No se cobró nada." },
    error: { title: "No se pudo abrir la página de pago", body: "No se cobró nada. Inténtalo de nuevo en un momento." },
  },
};

const fr: TipsWords = {
  heading: "Soutenir mon travail",
  line: (store) => `Si quelque chose fait par ${store} vous a aidé, vous pouvez dire merci avec le montant de votre choix. Rien n'est acheté : tout lui revient directement.`,
  amounts: "Choisissez un montant",
  other: "Un autre montant",
  button: "Envoyer mon soutien",
  secure: "Vous payez sur la page sécurisée de Stripe, où vous pouvez aussi laisser un message.",
  testMode: "Mode test : aucun argent réel n'est prélevé.",
  lineName: (store) => `Soutien à ${store}`,
  message: "Votre message",
  pageTitle: "Merci",
  thanksTitle: "Merci pour votre soutien",
  thanksBody: (store, amount) => `Vos ${amount} sont bien arrivés chez ${store}. Ils lui reviennent directement, et le paiement figure sur votre relevé à son nom.`,
  thanksBodyNoAmount: (store) => `Votre soutien est bien arrivé chez ${store}. Il lui revient directement, et le paiement figure sur votre relevé à son nom, avec le montant prélevé.`,
  waitingTitle: "Ce paiement n'est pas confirmé",
  waitingBody: "Stripe ne l'a pas confirmé. Si vous avez quitté la page de paiement avant de payer, rien n'a été prélevé.",
  range: (least, most) => `Choisissez l'un des montants, ou saisissez-en un de ${least} à ${most}.`,
  notices: {
    amount: { title: "Choisissez un montant", body: "Prenez l'un des montants, ou saisissez-en un autre dans la fourchette indiquée." },
    limited: { title: "Trop d'essais pour le moment", body: "Patientez quelques minutes, puis réessayez." },
    closed: { title: "Cette boutique ne reçoit pas de soutien pour l'instant", body: "Rien n'a été prélevé." },
    error: { title: "La page de paiement n'a pas pu s'ouvrir", body: "Rien n'a été prélevé. Réessayez dans un instant." },
  },
};

const de: TipsWords = {
  heading: "Unterstütze meine Arbeit",
  line: (store) => `Wenn dir etwas von ${store} geholfen hat, kannst du mit einem Betrag deiner Wahl Danke sagen. Du kaufst nichts: Es geht direkt an sie.`,
  amounts: "Wähle einen Betrag",
  other: "Anderer Betrag",
  button: "Unterstützung senden",
  secure: "Du zahlst auf der sicheren Seite von Stripe und kannst dort auch eine Nachricht hinterlassen.",
  testMode: "Testmodus: Es wird kein echtes Geld abgebucht.",
  lineName: (store) => `Unterstützung für ${store}`,
  message: "Deine Nachricht",
  pageTitle: "Danke",
  thanksTitle: "Danke für deine Unterstützung",
  thanksBody: (store, amount) => `Deine ${amount} sind bei ${store} angekommen. Sie gehen direkt an sie, und die Zahlung steht unter ihrem Namen auf deinem Kontoauszug.`,
  thanksBodyNoAmount: (store) => `Deine Unterstützung ist bei ${store} angekommen. Sie geht direkt an sie, und die Zahlung steht mit dem abgebuchten Betrag unter ihrem Namen auf deinem Kontoauszug.`,
  waitingTitle: "Diese Zahlung ist nicht bestätigt",
  waitingBody: "Stripe hat sie nicht bestätigt. Wenn du die Zahlungsseite vor dem Bezahlen verlassen hast, wurde nichts abgebucht.",
  range: (least, most) => `Wähle einen der Beträge oder gib einen von ${least} bis ${most} ein.`,
  notices: {
    amount: { title: "Wähle einen Betrag", body: "Nimm einen der Beträge oder gib einen anderen im angezeigten Rahmen ein." },
    limited: { title: "Gerade zu viele Versuche", body: "Warte ein paar Minuten und versuche es dann noch einmal." },
    closed: { title: "Dieser Shop nimmt gerade keine Unterstützung an", body: "Es wurde nichts abgebucht." },
    error: { title: "Die Zahlungsseite konnte nicht geöffnet werden", body: "Es wurde nichts abgebucht. Versuche es gleich noch einmal." },
  },
};

const it: TipsWords = {
  heading: "Sostieni il mio lavoro",
  line: (store) => `Se qualcosa fatto da ${store} ti è stato utile, puoi dire grazie con la cifra che preferisci. Non compri nulla: arriva direttamente a chi l'ha fatto.`,
  amounts: "Scegli una cifra",
  other: "Un'altra cifra",
  button: "Invia il mio sostegno",
  secure: "Paghi sulla pagina sicura di Stripe, dove puoi anche lasciare un messaggio.",
  testMode: "Modalità di prova: non viene addebitato denaro reale.",
  lineName: (store) => `Sostegno a ${store}`,
  message: "Il tuo messaggio",
  pageTitle: "Grazie",
  thanksTitle: "Grazie per il tuo sostegno",
  thanksBody: (store, amount) => `I tuoi ${amount} sono arrivati a ${store}. Vanno direttamente a chi l'ha fatto, e il pagamento compare nel tuo estratto conto con il suo nome.`,
  thanksBodyNoAmount: (store) => `Il tuo sostegno è arrivato a ${store}. Va direttamente a chi l'ha fatto, e il pagamento compare nel tuo estratto conto con il suo nome e l'importo addebitato.`,
  waitingTitle: "Questo pagamento non è confermato",
  waitingBody: "Stripe non l'ha confermato. Se hai lasciato la pagina di pagamento prima di pagare, non è stato addebitato nulla.",
  range: (least, most) => `Scegli una delle cifre o scrivine una da ${least} a ${most}.`,
  notices: {
    amount: { title: "Scegli una cifra", body: "Prendi una delle cifre o scrivine un'altra nell'intervallo indicato." },
    limited: { title: "Troppi tentativi per ora", body: "Aspetta qualche minuto e riprova." },
    closed: { title: "Questo negozio non riceve sostegno al momento", body: "Non è stato addebitato nulla." },
    error: { title: "Non è stato possibile aprire la pagina di pagamento", body: "Non è stato addebitato nulla. Riprova tra un momento." },
  },
};

const nl: TipsWords = {
  heading: "Steun mijn werk",
  line: (store) => `Heeft iets van ${store} je geholpen, dan kun je bedanken met een bedrag naar keuze. Je koopt niets: het gaat rechtstreeks naar de maker.`,
  amounts: "Kies een bedrag",
  other: "Ander bedrag",
  button: "Mijn steun versturen",
  secure: "Je betaalt op de beveiligde pagina van Stripe, waar je ook een bericht kunt achterlaten.",
  testMode: "Testmodus: er wordt geen echt geld afgeschreven.",
  lineName: (store) => `Steun voor ${store}`,
  message: "Je bericht",
  pageTitle: "Bedankt",
  thanksTitle: "Bedankt voor je steun",
  thanksBody: (store, amount) => `Je ${amount} is bij ${store} aangekomen. Het gaat rechtstreeks naar de maker, en de betaling staat onder diens naam op je afschrift.`,
  thanksBodyNoAmount: (store) => `Je steun is bij ${store} aangekomen en gaat rechtstreeks naar de maker. De betaling staat met het afgeschreven bedrag onder diens naam op je afschrift.`,
  waitingTitle: "Deze betaling is niet bevestigd",
  waitingBody: "Stripe heeft haar niet bevestigd. Ben je van de betaalpagina weggegaan voordat je betaalde, dan is er niets afgeschreven.",
  range: (least, most) => `Kies een van de bedragen of typ er een van ${least} tot ${most}.`,
  notices: {
    amount: { title: "Kies een bedrag", body: "Neem een van de bedragen of typ een ander binnen het aangegeven bereik." },
    limited: { title: "Even te veel pogingen", body: "Wacht een paar minuten en probeer het opnieuw." },
    closed: { title: "Deze winkel neemt nu geen steun aan", body: "Er is niets afgeschreven." },
    error: { title: "De betaalpagina kon niet worden geopend", body: "Er is niets afgeschreven. Probeer het zo opnieuw." },
  },
};

// European Portuguese: the courteous third person, as in lib/buyer-words/giving.ts.
const pt: TipsWords = {
  heading: "Apoie o meu trabalho",
  line: (store) => `Se algo feito por ${store} lhe foi útil, pode agradecer com o valor que escolher. Não compra nada: o valor segue diretamente para quem o fez.`,
  amounts: "Escolha um valor",
  other: "Outro valor",
  button: "Enviar o meu apoio",
  secure: "Paga na página segura da Stripe, onde também pode deixar uma mensagem.",
  testMode: "Modo de teste: não é cobrado dinheiro real.",
  lineName: (store) => `Apoio a ${store}`,
  message: "A sua mensagem",
  pageTitle: "Obrigado",
  thanksTitle: "Obrigado pelo seu apoio",
  thanksBody: (store, amount) => `Os seus ${amount} chegaram a ${store}. Seguem diretamente para quem o fez, e o pagamento aparece no seu extrato com esse nome.`,
  thanksBodyNoAmount: (store) => `O seu apoio chegou a ${store}. Segue diretamente para quem o fez, e o pagamento aparece no seu extrato com esse nome e o valor cobrado.`,
  waitingTitle: "Este pagamento não está confirmado",
  waitingBody: "A Stripe não o confirmou. Se saiu da página de pagamento antes de pagar, nada foi cobrado.",
  range: (least, most) => `Escolha um dos valores ou escreva outro entre ${least} e ${most}.`,
  notices: {
    amount: { title: "Escolha um valor", body: "Selecione um dos valores ou escreva outro dentro do intervalo indicado." },
    limited: { title: "Demasiadas tentativas por agora", body: "Aguarde alguns minutos e tente novamente." },
    closed: { title: "Esta loja não está a receber apoios neste momento", body: "Nada foi cobrado." },
    error: { title: "Não foi possível abrir a página de pagamento", body: "Nada foi cobrado. Tente novamente daqui a pouco." },
  },
};

export const TIPS_WORDS: Record<LanguageCode, TipsWords> = { en, es, fr, de, it, nl, pt };

export function tipsWords(language: unknown): TipsWords {
  return TIPS_WORDS[parseLanguage(language)];
}
