/**
 * A successful form sign-up request proves that the mail sender accepted an
 * attempt. It does not prove that the confirmation button reached the inbox.
 * The form result therefore describes the attempt and warns that it may not
 * arrive, while keeping the real next step clear in every buyer language.
 */
import { readFileSync } from "node:fs";
import { formWords } from "@/lib/buyer-words/form";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, string> = {
  en: "One more step: we tried to email you a button to confirm you want to hear from them, but it may not arrive.",
  es: "Un paso más: intentamos enviarte un email con un botón para confirmar que quieres recibir sus novedades, pero puede no llegar.",
  fr: "Encore une étape : nous avons essayé de vous envoyer un e-mail avec un bouton pour confirmer que vous voulez recevoir leurs nouvelles, mais il peut ne pas arriver.",
  de: "Noch ein Schritt: Wir haben versucht, Ihnen eine E-Mail mit einer Schaltfläche zu schicken, mit der Sie bestätigen, dass Sie Neuigkeiten erhalten möchten, aber die E-Mail kommt vielleicht nicht an.",
  it: "Ancora un passo: abbiamo provato a inviarti un'email con un pulsante per confermare che vuoi ricevere le sue novità, ma potrebbe non arrivare.",
  nl: "Nog één stap: we hebben geprobeerd je een e-mail te sturen met een knop om te bevestigen dat je hun nieuws wilt ontvangen, maar die komt mogelijk niet aan.",
  pt: "Só mais um passo: tentámos enviar-lhe um email com um botão para confirmar que quer receber as novidades, mas pode não chegar.",
};

async function main(): Promise<void> {
  part("All seven languages describe an email attempt that may not arrive");
  for (const language of LANGUAGE_CODES) {
    is(`${language}: form confirmation email`, formWords(language).confirmSent, EXPECTED[language]);
  }

  part("The real form flow proves sender acceptance, not inbox delivery");
  const page = readFileSync("app/[handle]/form/[form]/page.tsx", "utf8");
  const route = readFileSync("app/api/store/form/route.ts", "utf8");
  const join = readFileSync("lib/store-join.ts", "utf8");
  const email = readFileSync("lib/email.ts", "utf8");
  const askToJoin = join.slice(join.indexOf("export async function askToJoin"), join.indexOf("/** What a link is for"));

  is("the page shows this notice only for the joined query state", page.includes('pick(query.j) === "1"') && page.includes("w.confirmSent"), true);
  is("the form route sets that state only when askToJoin reports sent", route.includes('joined = asked === "sent"') && route.includes('${joined ? "&j=1" : ""}'), true);
  is("askToJoin calls the real mail sender", askToJoin.includes("const sent = await sendEmail"), true);
  is("sender acceptance selects sent while refusal selects error", askToJoin.includes('return sent ? "sent" : "error"'), true);
  is("the mail sender exposes only a boolean result", email.includes("export async function sendEmail") && email.includes("Promise<boolean>"), true);

  done();
}

void main();
