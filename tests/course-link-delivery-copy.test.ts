import { readFileSync } from "node:fs";
import { ordersWords } from "@/lib/buyer-words/orders";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EMAIL = "buyer@example.test";
const EXPECTED: Record<LanguageCode, { course: string; bundle: string }> = {
  en: {
    course: `If you pressed "Start the course" after paying, it opens right away on that device. Anywhere else, the course page asks for your email: type ${EMAIL} and request an email link that lets that device in. There is no password to make.`,
    bundle: `A course you started after paying opens right away on that device. Anywhere else, its page asks for your email: type ${EMAIL} and request an email link that lets that device in.`,
  },
  es: {
    course: `Si pulsaste «Empezar el curso» después de pagar, se abre al instante en ese dispositivo. En cualquier otro, la página del curso te pide tu email: escribe ${EMAIL} y pide por email un enlace que dé acceso a ese dispositivo. No hay contraseña que crear.`,
    bundle: `Un curso que empezaste después de pagar se abre al instante en ese dispositivo. En cualquier otro, su página te pide tu email: escribe ${EMAIL} y pide por email un enlace que dé acceso a ese dispositivo.`,
  },
  fr: {
    course: `Si vous avez cliqué sur « Commencer la formation » après le paiement, elle s'ouvre immédiatement sur cet appareil. Ailleurs, la page de la formation vous demande votre e-mail : saisissez ${EMAIL} et demandez par e-mail un lien qui donne accès à cet appareil. Aucun mot de passe à créer.`,
    bundle: `Une formation commencée après le paiement s'ouvre immédiatement sur cet appareil. Ailleurs, sa page vous demande votre e-mail : saisissez ${EMAIL} et demandez par e-mail un lien qui donne accès à cet appareil.`,
  },
  de: {
    course: `Wenn Sie nach dem Bezahlen auf „Kurs starten“ geklickt haben, öffnet sich der Kurs auf diesem Gerät sofort. Überall sonst fragt die Kursseite nach Ihrer E-Mail-Adresse: Geben Sie ${EMAIL} ein und fordern Sie per E-Mail einen Link an, der dieses Gerät freischaltet. Sie müssen kein Passwort anlegen.`,
    bundle: `Ein Kurs, den Sie nach dem Bezahlen gestartet haben, öffnet sich auf diesem Gerät sofort. Überall sonst fragt seine Seite nach Ihrer E-Mail-Adresse: Geben Sie ${EMAIL} ein und fordern Sie per E-Mail einen Link an, der dieses Gerät freischaltet.`,
  },
  it: {
    course: `Se dopo il pagamento hai premuto «Inizia il corso», si apre subito su quel dispositivo. Altrove, la pagina del corso ti chiede la tua email: inserisci ${EMAIL} e richiedi via email un link che dia accesso a quel dispositivo. Non c'è nessuna password da creare.`,
    bundle: `Un corso che hai iniziato dopo il pagamento si apre subito su quel dispositivo. Altrove, la sua pagina ti chiede la tua email: inserisci ${EMAIL} e richiedi via email un link che dia accesso a quel dispositivo.`,
  },
  nl: {
    course: `Als je na het betalen op ‘Start de cursus’ hebt gedrukt, opent de cursus meteen op dat apparaat. Op elk ander apparaat vraagt de cursuspagina om je e-mailadres: vul ${EMAIL} in en vraag per e-mail een link aan die dat apparaat toegang geeft. Je hoeft geen wachtwoord aan te maken.`,
    bundle: `Een cursus die je na het betalen hebt gestart, opent meteen op dat apparaat. Op elk ander apparaat vraagt de pagina om je e-mailadres: vul ${EMAIL} in en vraag per e-mail een link aan die dat apparaat toegang geeft.`,
  },
  pt: {
    course: `Se carregou em «Começar o curso» depois de pagar, o curso abre de imediato nesse dispositivo. Em qualquer outro, a página do curso pede o seu email: introduza ${EMAIL} e peça por email uma ligação que dê acesso a esse dispositivo. Não há palavra-passe para criar.`,
    bundle: `Um curso que começou depois de pagar abre de imediato nesse dispositivo. Em qualquer outro, a página do curso pede o seu email: introduza ${EMAIL} e peça por email uma ligação que dê acesso a esse dispositivo.`,
  },
};

part("Course access copy describes requesting a link, not inbox delivery time");
is("all seven buyer languages remain present", LANGUAGE_CODES.length, 7);
for (const code of LANGUAGE_CODES) {
  const words = ordersWords(code);
  const course = words.courseNote(EMAIL);
  const bundle = words.bundleCourseNote(EMAIL);
  is(`${code}: renders the complete single-course note`, course, EXPECTED[code].course);
  is(`${code}: renders the complete bundle-course note`, bundle, EXPECTED[code].bundle);
  is(`${code}: both notes keep the buyer address`, [course.includes(EMAIL), bundle.includes(EMAIL)], [true, true]);
  is(`${code}: both notes resolve every interpolation`, /undefined|NaN|\$\{|\[object/.test(course + bundle), false);
}

const route = readFileSync("app/api/store/course/link/route.ts", "utf8");
is("the public route acts on the request result, not an inbox-delivery event", route.includes("await requestCourseLink"), true);
done();
