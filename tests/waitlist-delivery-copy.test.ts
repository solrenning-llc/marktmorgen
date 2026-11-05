/**
 * A waitlist confirmation can prove that the sender accepted one request,
 * not when the message reaches the buyer's inbox. The status copy keeps the
 * confirmation instructions and removes the unsupported delivery deadline.
 */
import { givingWords } from "@/lib/buyer-words/giving";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, string> = {
  en: "We emailed you a button to confirm your spot on the waitlist for The Bread Book. It comes from Harbor Kitchen via Marktmorgen. If it is not there, look in spam.",
  es: "Te hemos enviado por email un botón para confirmar tu plaza en la lista de espera de The Bread Book. Llega de Harbor Kitchen a través de Marktmorgen. Si no está, mira en spam.",
  fr: "Nous vous avons envoyé par e-mail un bouton pour confirmer votre place sur la liste d'attente de The Bread Book. Il vient de Harbor Kitchen via Marktmorgen. S'il n'y est pas, regardez dans les spams.",
  de: "Wir haben Ihnen per E-Mail eine Schaltfläche geschickt, mit der Sie Ihren Platz auf der Warteliste für The Bread Book bestätigen. Sie kommt von Harbor Kitchen über Marktmorgen. Falls sie nicht da ist, sehen Sie im Spam-Ordner nach.",
  it: "Ti abbiamo inviato via email un pulsante per confermare il tuo posto nella lista d'attesa per The Bread Book. Arriva da Harbor Kitchen tramite Marktmorgen. Se non la trovi, guarda nello spam.",
  nl: "We hebben je een knop gemaild om je plek op de wachtlijst voor The Bread Book te bevestigen. De e-mail komt van Harbor Kitchen via Marktmorgen. Staat hij er niet, kijk dan in je spam.",
  pt: "Enviámos-lhe por email um botão para confirmar o seu lugar na lista de espera de The Bread Book. Chega de Harbor Kitchen através da Marktmorgen. Se não estiver lá, veja na pasta de spam.",
};

async function main(): Promise<void> {
  part("All seven accepted-request pages avoid an inbox deadline");
  for (const code of LANGUAGE_CODES) {
    const text = givingWords(code).waitSentBody("The Bread Book", "Harbor Kitchen");
    is(`${code}: complete confirmation status`, text, EXPECTED[code]);
    is(`${code}: keeps the store and spam guidance`, [text.includes("Harbor Kitchen"), /spam/i.test(text)], [true, true]);
    is(`${code}: has no unresolved interpolation`, /undefined|NaN|\$\{|\[object/.test(text), false);
  }

  done();
}

void main();
