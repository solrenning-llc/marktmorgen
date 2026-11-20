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
  billingCountry: "Country you're sending from",
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
    abroad: { title: "Support can't be sent from the EU or the UK yet", body: "We can't yet charge the VAT the European Union and the United Kingdom require on it, so nothing was charged. If you are outside them, choose your country and try again." },
    country: { title: "Choose the country you're sending from", body: "Nothing was charged. Pick your country above the button, then press it again." },
  } as Record<string, Notice>,
};

export type TipsWords = typeof en;

const es: TipsWords = {
  heading: "Apoya mi trabajo",
  line: (store) => `Si algo que hizo ${store} te ha servido, puedes darle las gracias con la cantidad que elijas. No compras nada: le llega directamente.`,
  amounts: "Elige una cantidad",
  other: "Otra cantidad",
  button: "Enviar mi apoyo",
  billingCountry: "País desde el que envías",
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
    abroad: { title: "Aún no se puede enviar apoyo desde la UE ni el Reino Unido", body: "Todavía no podemos cobrar el IVA que la Unión Europea y el Reino Unido exigen sobre él, así que no se cobró nada. Si estás fuera de ellos, elige tu país y vuelve a intentarlo." },
    country: { title: "Elige el país desde el que envías", body: "No se cobró nada. Elige tu país encima del botón y vuelve a pulsarlo." },
  },
};

const fr: TipsWords = {
  heading: "Soutenir mon travail",
  line: (store) => `Si quelque chose fait par ${store} vous a aidé, vous pouvez dire merci avec le montant de votre choix. Rien n'est acheté : tout lui revient directement.`,
  amounts: "Choisissez un montant",
  other: "Un autre montant",
  button: "Envoyer mon soutien",
  billingCountry: "Pays depuis lequel vous envoyez",
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
    abroad: { title: "Pas encore possible depuis l'UE ni le Royaume-Uni", body: "Nous ne pouvons pas encore facturer la TVA que l'Union européenne et le Royaume-Uni exigent sur ce soutien, donc rien n'a été prélevé. Si vous êtes en dehors de ces pays, choisissez votre pays et réessayez." },
    country: { title: "Choisissez le pays depuis lequel vous envoyez", body: "Rien n'a été prélevé. Choisissez votre pays au-dessus du bouton, puis cliquez de nouveau dessus." },
  },
};

const de: TipsWords = {
  heading: "Unterstütze meine Arbeit",
  line: (store) => `Wenn dir etwas von ${store} geholfen hat, kannst du mit einem Betrag deiner Wahl Danke sagen. Du kaufst nichts: Es geht direkt an sie.`,
  amounts: "Wähle einen Betrag",
  other: "Anderer Betrag",
  button: "Unterstützung senden",
  billingCountry: "Land, aus dem du sendest",
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
    abroad: { title: "Aus der EU und dem Vereinigten Königreich noch nicht möglich", body: "Wir können die Mehrwertsteuer, die die Europäische Union und das Vereinigte Königreich darauf verlangen, noch nicht berechnen, deshalb wurde nichts abgebucht. Wenn du dich außerhalb davon befindest, wähle dein Land und versuche es erneut." },
    country: { title: "Wähle das Land, aus dem du sendest", body: "Es wurde nichts abgebucht. Wähle dein Land über der Schaltfläche und klicke sie dann noch einmal an." },
  },
};

const it: TipsWords = {
  heading: "Sostieni il mio lavoro",
  line: (store) => `Se qualcosa fatto da ${store} ti è stato utile, puoi dire grazie con la cifra che preferisci. Non compri nulla: arriva direttamente a chi l'ha fatto.`,
  amounts: "Scegli una cifra",
  other: "Un'altra cifra",
  button: "Invia il mio sostegno",
  billingCountry: "Paese da cui invii",
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
    abroad: { title: "Non ancora possibile dall'UE o dal Regno Unito", body: "Non possiamo ancora addebitare l'IVA che l'Unione europea e il Regno Unito richiedono su questo sostegno, quindi non è stato addebitato nulla. Se ti trovi fuori da questi paesi, scegli il tuo paese e riprova." },
    country: { title: "Scegli il paese da cui invii", body: "Non è stato addebitato nulla. Scegli il tuo paese sopra il pulsante, poi premilo di nuovo." },
  },
};

const nl: TipsWords = {
  heading: "Steun mijn werk",
  line: (store) => `Heeft iets van ${store} je geholpen, dan kun je bedanken met een bedrag naar keuze. Je koopt niets: het gaat rechtstreeks naar de maker.`,
  amounts: "Kies een bedrag",
  other: "Ander bedrag",
  button: "Mijn steun versturen",
  billingCountry: "Land waaruit je verstuurt",
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
    abroad: { title: "Nog niet mogelijk vanuit de EU of het Verenigd Koninkrijk", body: "We kunnen de btw die de Europese Unie en het Verenigd Koninkrijk hierover vragen nog niet berekenen, dus er is niets afgeschreven. Ben je daarbuiten, kies dan je land en probeer het opnieuw." },
    country: { title: "Kies het land waaruit je verstuurt", body: "Er is niets afgeschreven. Kies je land boven de knop en druk er dan opnieuw op." },
  },
};

// European Portuguese: the courteous third person, as in lib/buyer-words/giving.ts.
const pt: TipsWords = {
  heading: "Apoie o meu trabalho",
  line: (store) => `Se algo feito por ${store} lhe foi útil, pode agradecer com o valor que escolher. Não compra nada: o valor segue diretamente para quem o fez.`,
  amounts: "Escolha um valor",
  other: "Outro valor",
  button: "Enviar o meu apoio",
  billingCountry: "País a partir do qual envia",
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
    abroad: { title: "Ainda não é possível a partir da UE nem do Reino Unido", body: "Ainda não conseguimos cobrar o IVA que a União Europeia e o Reino Unido exigem sobre este apoio, por isso nada foi cobrado. Se estiver fora destes países, escolha o seu país e tente de novo." },
    country: { title: "Escolha o país a partir do qual envia", body: "Nada foi cobrado. Escolha o seu país acima do botão e carregue nele novamente." },
  },
};

export const TIPS_WORDS: Record<LanguageCode, TipsWords> = { en, es, fr, de, it, nl, pt };

export function tipsWords(language: unknown): TipsWords {
  return TIPS_WORDS[parseLanguage(language)];
}
