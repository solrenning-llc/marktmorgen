/**
 * The words of a code only for people who already bought from this store
 * (554 [DS1], unit 2; lib/returning-code-rules.ts), in each language a store
 * can speak: the field on the buy form, and what the buyer is told when the
 * code is not taken.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";
import type { ReturningRefusal } from "@/lib/returning-code-rules";

export type ReturningCodeWords = {
  /** The line that opens the field. */
  open: string;
  /** Under it: what the code is and how it is checked. */
  note: string;
  codeLabel: string;
  emailLabel: string;
  /** Under the email: the email the checkout opens with, and that it is not kept. */
  emailNote: string;
  /** Why a code was not taken, one plain sentence each. */
  refused: Record<ReturningRefusal, string>;
};

const en: ReturningCodeWords = {
  open: "Bought here before? Use your code",
  note: "A code for returning buyers. Type it with the email you used for an earlier order here, and it comes off at checkout. Only one discount applies at a time: a sale running in the store comes first.",
  codeLabel: "Your code",
  emailLabel: "The email of your earlier order",
  emailNote: "We check it against your earlier orders, and the checkout opens with it. It is not kept.",
  refused: {
    code: "That code didn't work. Check the spelling, or it may have ended or been used up.",
    email: "That doesn't look like an email address. Check it and try again.",
    bought: "This code is only for people who bought from this store before, and we found no earlier order with that email. Try the email you used then.",
    unknown: "We couldn't check your earlier orders just now. Try again in a minute, or buy without the code.",
    busy: "Too many tries in a short time. Wait ten minutes and try again.",
  },
};

const es: ReturningCodeWords = {
  open: "¿Ya compraste aquí? Usa tu código",
  note: "Un código para quienes ya compraron. Escríbelo con el email de un pedido anterior en esta tienda y se descuenta al pagar. Solo se aplica un descuento a la vez: si hay una rebaja en la tienda, va primero.",
  codeLabel: "Tu código",
  emailLabel: "El email de tu pedido anterior",
  emailNote: "Lo comprobamos con tus pedidos anteriores y el pago se abre con él. No se guarda.",
  refused: {
    code: "Ese código no ha funcionado. Revisa cómo está escrito; también puede haber terminado o agotado sus usos.",
    email: "Eso no parece un email. Revísalo y vuelve a intentarlo.",
    bought: "Este código es solo para quienes ya compraron en esta tienda, y no encontramos ningún pedido anterior con ese email. Prueba con el email que usaste entonces.",
    unknown: "Ahora mismo no hemos podido comprobar tus pedidos anteriores. Inténtalo de nuevo en un minuto o compra sin el código.",
    busy: "Demasiados intentos en poco tiempo. Espera diez minutos y vuelve a intentarlo.",
  },
};

const fr: ReturningCodeWords = {
  open: "Déjà client ici ? Utilisez votre code",
  note: "Un code pour les clients qui ont déjà acheté. Saisissez-le avec l’e-mail d’une commande précédente dans cette boutique, et il est déduit au paiement. Une seule réduction s’applique à la fois : une promotion en cours dans la boutique passe en premier.",
  codeLabel: "Votre code",
  emailLabel: "L’e-mail de votre commande précédente",
  emailNote: "Nous le vérifions avec vos commandes précédentes, et le paiement s’ouvre avec lui. Il n’est pas conservé.",
  refused: {
    code: "Ce code n’a pas fonctionné. Vérifiez l’orthographe ; il est peut-être aussi terminé ou épuisé.",
    email: "Cela ne ressemble pas à une adresse e-mail. Vérifiez-la et réessayez.",
    bought: "Ce code est réservé aux personnes qui ont déjà acheté dans cette boutique, et nous n’avons trouvé aucune commande précédente avec cet e-mail. Essayez l’e-mail utilisé à l’époque.",
    unknown: "Nous n’avons pas pu vérifier vos commandes précédentes pour le moment. Réessayez dans une minute, ou achetez sans le code.",
    busy: "Trop d’essais en peu de temps. Attendez dix minutes et réessayez.",
  },
};

const de: ReturningCodeWords = {
  open: "Schon einmal hier gekauft? Nutze deinen Code",
  note: "Ein Code für alle, die schon gekauft haben. Gib ihn mit der E-Mail einer früheren Bestellung in diesem Shop ein, dann wird er an der Kasse abgezogen. Es gilt immer nur ein Rabatt: Ein laufender Sale im Shop geht vor.",
  codeLabel: "Dein Code",
  emailLabel: "Die E-Mail deiner früheren Bestellung",
  emailNote: "Wir gleichen sie mit deinen früheren Bestellungen ab, und die Kasse öffnet sich mit ihr. Sie wird nicht gespeichert.",
  refused: {
    code: "Dieser Code hat nicht funktioniert. Prüfe die Schreibweise; er kann auch abgelaufen oder aufgebraucht sein.",
    email: "Das sieht nicht wie eine E-Mail-Adresse aus. Prüfe sie und versuche es noch einmal.",
    bought: "Dieser Code gilt nur für alle, die schon in diesem Shop gekauft haben, und wir haben keine frühere Bestellung mit dieser E-Mail gefunden. Versuche es mit der E-Mail, die du damals benutzt hast.",
    unknown: "Wir konnten deine früheren Bestellungen gerade nicht prüfen. Versuche es in einer Minute noch einmal oder kaufe ohne den Code.",
    busy: "Zu viele Versuche in kurzer Zeit. Warte zehn Minuten und versuche es noch einmal.",
  },
};

const it: ReturningCodeWords = {
  open: "Hai già comprato qui? Usa il tuo codice",
  note: "Un codice per chi ha già comprato. Scrivilo con l’email di un ordine precedente in questo negozio e viene scontato al pagamento. Si applica un solo sconto alla volta: una promozione in corso nel negozio viene prima.",
  codeLabel: "Il tuo codice",
  emailLabel: "L’email del tuo ordine precedente",
  emailNote: "La confrontiamo con i tuoi ordini precedenti e il pagamento si apre con essa. Non viene conservata.",
  refused: {
    code: "Questo codice non ha funzionato. Controlla come è scritto; potrebbe anche essere scaduto o esaurito.",
    email: "Non sembra un indirizzo email. Controllalo e riprova.",
    bought: "Questo codice è solo per chi ha già comprato in questo negozio, e non abbiamo trovato ordini precedenti con questa email. Prova con l’email che hai usato allora.",
    unknown: "Al momento non siamo riusciti a controllare i tuoi ordini precedenti. Riprova tra un minuto o compra senza il codice.",
    busy: "Troppi tentativi in poco tempo. Aspetta dieci minuti e riprova.",
  },
};

const nl: ReturningCodeWords = {
  open: "Al eens hier gekocht? Gebruik je code",
  note: "Een code voor wie hier al heeft gekocht. Typ hem met het e-mailadres van een eerdere bestelling in deze winkel, dan gaat hij bij het afrekenen van de prijs af. Er geldt één korting tegelijk: een lopende uitverkoop in de winkel gaat voor.",
  codeLabel: "Je code",
  emailLabel: "Het e-mailadres van je eerdere bestelling",
  emailNote: "We controleren het met je eerdere bestellingen, en het afrekenen opent ermee. Het wordt niet bewaard.",
  refused: {
    code: "Die code werkte niet. Controleer de spelling; hij kan ook verlopen of op zijn.",
    email: "Dat lijkt geen e-mailadres. Controleer het en probeer het opnieuw.",
    bought: "Deze code is alleen voor wie al eerder in deze winkel heeft gekocht, en we vonden geen eerdere bestelling met dat e-mailadres. Probeer het e-mailadres dat je toen gebruikte.",
    unknown: "We konden je eerdere bestellingen nu niet controleren. Probeer het over een minuut opnieuw, of koop zonder de code.",
    busy: "Te veel pogingen in korte tijd. Wacht tien minuten en probeer het opnieuw.",
  },
};

const pt: ReturningCodeWords = {
  open: "Já comprou aqui? Use o seu código",
  note: "Um código para quem já comprou. Escreva-o com o email de uma encomenda anterior nesta loja e é descontado no pagamento. Só se aplica um desconto de cada vez: uma promoção em curso na loja vem primeiro.",
  codeLabel: "O seu código",
  emailLabel: "O email da sua encomenda anterior",
  emailNote: "Confirmamo-lo com as suas encomendas anteriores e o pagamento abre com ele. Não é guardado.",
  refused: {
    code: "Esse código não funcionou. Verifique como está escrito; também pode ter terminado ou esgotado.",
    email: "Isso não parece um endereço de email. Verifique-o e tente de novo.",
    bought: "Este código é só para quem já comprou nesta loja, e não encontrámos nenhuma encomenda anterior com esse email. Experimente o email que usou nessa altura.",
    unknown: "Não conseguimos confirmar as suas encomendas anteriores neste momento. Tente de novo dentro de um minuto, ou compre sem o código.",
    busy: "Demasiadas tentativas em pouco tempo. Espere dez minutos e tente de novo.",
  },
};

export const RETURNING_CODE_WORDS: Record<LanguageCode, ReturningCodeWords> = { en, es, fr, de, it, nl, pt };

export function returningCodeWords(language: unknown): ReturningCodeWords {
  return RETURNING_CODE_WORDS[parseLanguage(language)];
}
