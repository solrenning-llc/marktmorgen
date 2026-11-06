/**
 * A successful membership switch proves the Stripe change. Its follow-up
 * receipt is best effort: either sender can fail or return false while the
 * switch still succeeds. The result page must not promise receipt delivery.
 */
import { readFileSync } from "node:fs";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, readonly [string, string]> = {
  en: [
    "What the new plan includes is open to you now. We try to email you a receipt, but it may not arrive.",
    "What your membership includes stays the same. We try to email you a receipt, but it may not arrive.",
  ],
  es: [
    "Ya tienes acceso a lo que incluye el nuevo plan. Intentamos enviarte un recibo por correo, pero puede no llegar.",
    "Lo que incluye tu membresía sigue igual. Intentamos enviarte un recibo por correo, pero puede no llegar.",
  ],
  fr: [
    "Ce que comprend la nouvelle formule vous est accessible dès maintenant. Nous essayons de vous envoyer un reçu par e-mail, mais il peut ne pas arriver.",
    "Ce que comprend votre abonnement reste identique. Nous essayons de vous envoyer un reçu par e-mail, mais il peut ne pas arriver.",
  ],
  de: [
    "Was der neue Tarif umfasst, steht Ihnen jetzt offen. Wir versuchen, Ihnen eine Quittung per E-Mail zu schicken, aber die E-Mail kommt vielleicht nicht an.",
    "Was Ihre Mitgliedschaft umfasst, bleibt gleich. Wir versuchen, Ihnen eine Quittung per E-Mail zu schicken, aber die E-Mail kommt vielleicht nicht an.",
  ],
  it: [
    "Ciò che include il nuovo piano è già accessibile. Proviamo a inviarti una ricevuta via email, ma potrebbe non arrivare.",
    "Ciò che include il tuo abbonamento resta uguale. Proviamo a inviarti una ricevuta via email, ma potrebbe non arrivare.",
  ],
  nl: [
    "Wat het nieuwe abonnement omvat, staat nu voor je open. We proberen je een ontvangstbewijs per e-mail te sturen, maar die e-mail komt mogelijk niet aan.",
    "Wat je lidmaatschap omvat, blijft hetzelfde. We proberen je een ontvangstbewijs per e-mail te sturen, maar die e-mail komt mogelijk niet aan.",
  ],
  pt: [
    "O que o novo plano inclui já está disponível para si. Tentamos enviar-lhe um recibo por e-mail, mas pode não chegar.",
    "O que a sua subscrição inclui mantém-se igual. Tentamos enviar-lhe um recibo por e-mail, mas pode não chegar.",
  ],
};

async function main(): Promise<void> {
  part("Both switch notices in all seven languages describe an attempt that may not arrive");
  for (const language of LANGUAGE_CODES) {
    const notices = membershipWords(language).manageNotices;
    is(`${language}: plan switch receipt`, notices.switched.body, EXPECTED[language][0]);
    is(`${language}: yearly switch receipt`, notices.yearly.body, EXPECTED[language][1]);
  }

  part("Both real switches succeed without confirmed receipt delivery");
  const tier = readFileSync("lib/tier-switch.ts", "utf8");
  const yearly = readFileSync("lib/yearly-switch.ts", "utf8");
  const route = readFileSync("app/api/store/manage/switch/route.ts", "utf8");
  const email = readFileSync("lib/email.ts", "utf8");
  const tierSwitch = tier.slice(tier.indexOf("export async function switchTier"), tier.indexOf("async function tell"));
  const tierTell = tier.slice(tier.indexOf("async function tell"));
  const yearlySwitch = yearly.slice(yearly.indexOf("export async function switchYearly"), yearly.indexOf("async function tell"));
  const yearlyTell = yearly.slice(yearly.indexOf("async function tell"));
  is("a tier switch returns success after the best-effort notice", /await tell\([\s\S]*?return \{ ok: true, title: found\.to\.title \}/.test(tierSwitch), true);
  is("the tier receipt sender is caught without checking its boolean", /await sendEmail\(\{[\s\S]*?\}\)\.catch\(\(error\) => console\.error\("a tier switch receipt failed"/.test(tierTell), true);
  is("a yearly switch returns success after the best-effort notice", /await tell\([\s\S]*?return \{ ok: true, title: found\.product\.title \}/.test(yearlySwitch), true);
  is("the yearly receipt sender is caught without checking its boolean", /await sendEmail\(\{[\s\S]*?\}\)\.catch\(\(error\) => console\.error\("a move to yearly receipt failed"/.test(yearlyTell), true);
  is("the route shows both success notices from switch success alone", route.includes('const status = yearly.ok ? "yearly"') && route.includes('return back(result.ok ? "switched"'), true);
  is("the email helper can return false", email.includes("export async function sendEmail") && email.includes("Promise<boolean>"), true);

  done();
}

void main();
