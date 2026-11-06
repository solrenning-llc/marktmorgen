/**
 * A successful pause proves that Stripe accepted the pause. The follow-up
 * email is best effort: its helper can fail or return false without changing
 * the successful pause result. The page therefore must not promise that the
 * email is on its way or will arrive.
 */
import { readFileSync } from "node:fs";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, string> = {
  en: "We try to email you the dates, but the email may not arrive.",
  es: "Intentamos enviarte un correo con las fechas, pero puede no llegar.",
  fr: "Nous essayons de vous envoyer un e-mail avec les dates, mais il peut ne pas arriver.",
  de: "Wir versuchen, Ihnen die Daten per E-Mail zu schicken, aber die E-Mail kommt vielleicht nicht an.",
  it: "Proviamo a inviarti un'email con le date, ma potrebbe non arrivare.",
  nl: "We proberen je een e-mail met de datums te sturen, maar die komt mogelijk niet aan.",
  pt: "Tentamos enviar-lhe um e-mail com as datas, mas pode não chegar.",
};

async function main(): Promise<void> {
  part("All seven languages describe an email attempt that may not arrive");
  for (const language of LANGUAGE_CODES) {
    is(`${language}: paused notice`, membershipWords(language).pauseNotices.paused.body, EXPECTED[language]);
  }

  part("The real pause succeeds without confirmed email delivery");
  const pause = readFileSync("lib/membership-pause.ts", "utf8");
  const route = readFileSync("app/api/store/manage/pause/route.ts", "utf8");
  const email = readFileSync("lib/email.ts", "utf8");
  const pauseMembership = pause.slice(pause.indexOf("export async function pauseMembership"), pause.indexOf("export async function resumeMembership"));
  const tellPaused = pause.slice(pause.indexOf("async function tellPaused"));
  is("a failed follow-up email does not undo a confirmed pause", /await tellPaused[\s\S]*?\.catch[\s\S]*?return \{ ok: true, from, until \}/.test(pauseMembership), true);
  is("the sender's boolean is not used as delivery confirmation", /await sendEmail\(\{[\s\S]*?idempotencyKey:[\s\S]*?\}\);/.test(tellPaused), true);
  is("the email helper can return false", email.includes("export async function sendEmail") && email.includes("Promise<boolean>"), true);
  is("the route shows the paused notice from pause success alone", route.includes('return back(result.ok ? "paused"'), true);

  done();
}

void main();
