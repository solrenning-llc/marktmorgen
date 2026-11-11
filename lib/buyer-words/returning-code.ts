/**
 * The words of a code only for people who already bought from this store
 * (554 [DS1], unit 2; lib/returning-code-rules.ts), in each language a store
 * can speak: the field on the buy form, the answer after asking for a link,
 * the line once the emailed link is opened, and why a code was not taken.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";
import type { ReturningRefusal } from "@/lib/returning-code-rules";

export type ReturningCodeWords = {
  /** The line that opens the field. */
  open: string;
  /** Under it: what the code is and how it works. */
  note: string;
  codeLabel: string;
  emailLabel: string;
  /** Under the email: what is done with it. */
  emailNote: string;
  /** The button that asks for the link. */
  send: string;
  /** After asking: the same for every address, so it never says who bought here. */
  sent: string;
  /** Once the emailed link is opened: the code goes on with the buy button. */
  confirmed: string;
  /** Why a code was not taken, one plain sentence each. */
  refused: Record<ReturningRefusal, string>;
};

const en: ReturningCodeWords = {
  open: "Bought here before? Use your code",
  note: "A code for returning buyers. Type it with the email of an earlier order from this store, and we email that address a link to buy with the code. Only one discount applies at a time.",
  codeLabel: "Your code",
  emailLabel: "The email of your earlier order",
  emailNote: "If this email paid for an order here before, it gets a link that works once, for 30 minutes. We keep it only for those 30 minutes.",
  send: "Email me the link",
  sent: "If that email paid for an order here before, we just sent it a link. Open it to buy with your code; it works once, for 30 minutes.",
  confirmed: "Your email is confirmed. Press the buy button to buy with your code.",
  refused: {
    code: "That code didn't work. Check the spelling, or it may have ended or been used up.",
    email: "That doesn't look like an email address. Check it and try again.",
    link: "That link was already used or has run out. Ask for a new one below.",
    other: "The code can't go on this purchase: another discount already applies, or it is a gift, for several people or a pre-order. You can buy without it.",
    unknown: "We couldn't check that just now. Try again in a minute, or buy without the code.",
    busy: "Too many tries in a short time. Wait ten minutes and try again.",
  },
};

const es: ReturningCodeWords = {
  open: "¿Ya compraste aquí? Usa tu código",
  note: "Un código para quienes ya compraron. Escríbelo con el email de un pedido anterior en esta tienda y te enviamos a esa dirección un enlace para comprar con el código. Solo se aplica un descuento a la vez.",
  codeLabel: "Tu código",
  emailLabel: "El email de tu pedido anterior",
  emailNote: "Si este email pagó un pedido aquí antes, recibe un enlace que funciona una vez, durante 30 minutos. Solo lo guardamos esos 30 minutos.",
  send: "Envíame el enlace",
  sent: "Si ese email pagó un pedido aquí antes, acabamos de enviarle un enlace. Ábrelo para comprar con tu código; funciona una vez, durante 30 minutos.",
  confirmed: "Tu email está confirmado. Pulsa el botón de compra para comprar con tu código.",
  refused: {
    code: "Ese código no ha funcionado. Revisa cómo está escrito; también puede haber terminado o agotado sus usos.",
    email: "Eso no parece un email. Revísalo y vuelve a intentarlo.",
    link: "Ese enlace ya se usó o ha caducado. Pide uno nuevo abajo.",
    other: "El código no vale para esta compra: ya se aplica otro descuento, o es un regalo, para varias personas o una preventa. Puedes comprar sin él.",
    unknown: "Ahora mismo no hemos podido comprobarlo. Inténtalo de nuevo en un minuto o compra sin el código.",
    busy: "Demasiados intentos en poco tiempo. Espera diez minutos y vuelve a intentarlo.",
  },
};

const fr: ReturningCodeWords = {
  open: "Déjà client ici ? Utilisez votre code",
  note: "Un code pour les clients qui ont déjà acheté. Saisissez-le avec l’e-mail d’une commande précédente dans cette boutique, et nous envoyons à cette adresse un lien pour acheter avec le code. Une seule réduction s’applique à la fois.",
  codeLabel: "Votre code",
  emailLabel: "L’e-mail de votre commande précédente",
  emailNote: "Si cet e-mail a payé une commande ici, il reçoit un lien valable une fois, pendant 30 minutes. Nous ne le gardons que ces 30 minutes.",
  send: "M’envoyer le lien",
  sent: "Si cet e-mail a déjà payé une commande ici, nous venons de lui envoyer un lien. Ouvrez-le pour acheter avec votre code ; il est valable une fois, pendant 30 minutes.",
  confirmed: "Votre e-mail est confirmé. Appuyez sur le bouton d’achat pour acheter avec votre code.",
  refused: {
    code: "Ce code n’a pas fonctionné. Vérifiez l’orthographe ; il est peut-être aussi terminé ou épuisé.",
    email: "Cela ne ressemble pas à une adresse e-mail. Vérifiez-la et réessayez.",
    link: "Ce lien a déjà servi ou a expiré. Demandez-en un nouveau ci-dessous.",
    other: "Le code ne peut pas s’appliquer à cet achat : une autre réduction s’applique déjà, ou c’est un cadeau, pour plusieurs personnes ou une précommande. Vous pouvez acheter sans lui.",
    unknown: "Nous n’avons pas pu vérifier pour le moment. Réessayez dans une minute, ou achetez sans le code.",
    busy: "Trop d’essais en peu de temps. Attendez dix minutes et réessayez.",
  },
};

const de: ReturningCodeWords = {
  open: "Schon einmal hier gekauft? Nutze deinen Code",
  note: "Ein Code für alle, die schon gekauft haben. Gib ihn mit der E-Mail einer früheren Bestellung in diesem Shop ein, dann schicken wir dieser Adresse einen Link zum Kaufen mit dem Code. Es gilt immer nur ein Rabatt.",
  codeLabel: "Dein Code",
  emailLabel: "Die E-Mail deiner früheren Bestellung",
  emailNote: "Wenn mit dieser E-Mail hier schon eine Bestellung bezahlt wurde, bekommt sie einen Link, der einmal und 30 Minuten lang funktioniert. Wir behalten sie nur diese 30 Minuten.",
  send: "Link per E-Mail senden",
  sent: "Wenn mit dieser E-Mail hier schon eine Bestellung bezahlt wurde, haben wir ihr gerade einen Link geschickt. Öffne ihn, um mit deinem Code zu kaufen; er funktioniert einmal, 30 Minuten lang.",
  confirmed: "Deine E-Mail ist bestätigt. Drück auf den Kaufen-Button, um mit deinem Code zu kaufen.",
  refused: {
    code: "Dieser Code hat nicht funktioniert. Prüfe die Schreibweise; er kann auch abgelaufen oder aufgebraucht sein.",
    email: "Das sieht nicht wie eine E-Mail-Adresse aus. Prüfe sie und versuche es noch einmal.",
    link: "Dieser Link wurde schon benutzt oder ist abgelaufen. Fordere unten einen neuen an.",
    other: "Der Code gilt nicht für diesen Kauf: Es gilt schon ein anderer Rabatt, oder es ist ein Geschenk, für mehrere Personen oder eine Vorbestellung. Du kannst ohne ihn kaufen.",
    unknown: "Wir konnten das gerade nicht prüfen. Versuche es in einer Minute noch einmal oder kaufe ohne den Code.",
    busy: "Zu viele Versuche in kurzer Zeit. Warte zehn Minuten und versuche es noch einmal.",
  },
};

const it: ReturningCodeWords = {
  open: "Hai già comprato qui? Usa il tuo codice",
  note: "Un codice per chi ha già comprato. Scrivilo con l’email di un ordine precedente in questo negozio e inviamo a quell’indirizzo un link per comprare con il codice. Si applica un solo sconto alla volta.",
  codeLabel: "Il tuo codice",
  emailLabel: "L’email del tuo ordine precedente",
  emailNote: "Se questa email ha già pagato un ordine qui, riceve un link valido una volta, per 30 minuti. La conserviamo solo per quei 30 minuti.",
  send: "Inviami il link",
  sent: "Se quella email ha già pagato un ordine qui, le abbiamo appena inviato un link. Aprilo per comprare con il tuo codice; vale una volta, per 30 minuti.",
  confirmed: "La tua email è confermata. Premi il pulsante di acquisto per comprare con il tuo codice.",
  refused: {
    code: "Questo codice non ha funzionato. Controlla come è scritto; potrebbe anche essere scaduto o esaurito.",
    email: "Non sembra un indirizzo email. Controllalo e riprova.",
    link: "Quel link è già stato usato o è scaduto. Chiedine uno nuovo qui sotto.",
    other: "Il codice non vale per questo acquisto: si applica già un altro sconto, oppure è un regalo, per più persone o un preordine. Puoi comprare senza.",
    unknown: "Al momento non siamo riusciti a controllare. Riprova tra un minuto o compra senza il codice.",
    busy: "Troppi tentativi in poco tempo. Aspetta dieci minuti e riprova.",
  },
};

const nl: ReturningCodeWords = {
  open: "Al eens hier gekocht? Gebruik je code",
  note: "Een code voor wie hier al heeft gekocht. Typ hem met het e-mailadres van een eerdere bestelling in deze winkel, dan sturen we dat adres een link om met de code te kopen. Er geldt één korting tegelijk.",
  codeLabel: "Je code",
  emailLabel: "Het e-mailadres van je eerdere bestelling",
  emailNote: "Als met dit e-mailadres hier al een bestelling is betaald, krijgt het een link die één keer werkt, 30 minuten lang. We bewaren het alleen die 30 minuten.",
  send: "Stuur me de link",
  sent: "Als met dat e-mailadres hier al een bestelling is betaald, hebben we er net een link naartoe gestuurd. Open hem om met je code te kopen; hij werkt één keer, 30 minuten lang.",
  confirmed: "Je e-mailadres is bevestigd. Druk op de koopknop om met je code te kopen.",
  refused: {
    code: "Die code werkte niet. Controleer de spelling; hij kan ook verlopen of op zijn.",
    email: "Dat lijkt geen e-mailadres. Controleer het en probeer het opnieuw.",
    link: "Die link is al gebruikt of verlopen. Vraag hieronder een nieuwe aan.",
    other: "De code geldt niet voor deze aankoop: er geldt al een andere korting, of het is een cadeau, voor meerdere personen of een voorbestelling. Je kunt zonder kopen.",
    unknown: "We konden het nu niet controleren. Probeer het over een minuut opnieuw, of koop zonder de code.",
    busy: "Te veel pogingen in korte tijd. Wacht tien minuten en probeer het opnieuw.",
  },
};

const pt: ReturningCodeWords = {
  open: "Já comprou aqui? Use o seu código",
  note: "Um código para quem já comprou. Escreva-o com o email de uma encomenda anterior nesta loja e enviamos para esse endereço um link para comprar com o código. Só se aplica um desconto de cada vez.",
  codeLabel: "O seu código",
  emailLabel: "O email da sua encomenda anterior",
  emailNote: "Se este email já pagou uma encomenda aqui, recebe um link que funciona uma vez, durante 30 minutos. Só o guardamos durante esses 30 minutos.",
  send: "Enviem-me o link",
  sent: "Se esse email já pagou uma encomenda aqui, acabámos de lhe enviar um link. Abra-o para comprar com o seu código; funciona uma vez, durante 30 minutos.",
  confirmed: "O seu email está confirmado. Carregue no botão de compra para comprar com o seu código.",
  refused: {
    code: "Esse código não funcionou. Verifique como está escrito; também pode ter terminado ou esgotado.",
    email: "Isso não parece um endereço de email. Verifique-o e tente de novo.",
    link: "Esse link já foi usado ou expirou. Peça um novo abaixo.",
    other: "O código não se aplica a esta compra: já se aplica outro desconto, ou é um presente, para várias pessoas ou uma pré-encomenda. Pode comprar sem ele.",
    unknown: "Não conseguimos confirmar neste momento. Tente de novo dentro de um minuto, ou compre sem o código.",
    busy: "Demasiadas tentativas em pouco tempo. Espere dez minutos e tente de novo.",
  },
};

export const RETURNING_CODE_WORDS: Record<LanguageCode, ReturningCodeWords> = { en, es, fr, de, it, nl, pt };

export function returningCodeWords(language: unknown): ReturningCodeWords {
  return RETURNING_CODE_WORDS[parseLanguage(language)];
}
