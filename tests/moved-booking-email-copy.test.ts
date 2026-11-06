/**
 * A completed move proves the new time was saved. It does not prove that
 * either email was accepted: tellMoved ignores sendEmail's boolean result,
 * and moveBooking also treats a thrown notification attempt as best effort.
 */
import { readFileSync } from "node:fs";
import { bookingWords } from "@/lib/buyer-words/booking";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, string> = {
  en: "Your new time is saved with Harbor Kitchen. We tried to email you the new time and a calendar file. The old time is free again for somebody else.",
  es: "Tu nuevo horario está guardado con Harbor Kitchen. Hemos intentado enviarte por email el nuevo horario y un archivo de calendario. El horario anterior vuelve a quedar libre para otra persona.",
  fr: "Votre nouvel horaire est enregistré auprès de Harbor Kitchen. Nous avons essayé de vous envoyer par e-mail le nouvel horaire et un fichier de calendrier. L'ancien créneau est de nouveau libre pour quelqu'un d'autre.",
  de: "Ihr neuer Termin ist bei Harbor Kitchen gespeichert. Wir haben versucht, Ihnen den neuen Termin und eine Kalenderdatei per E-Mail zu senden. Der alte Termin ist wieder für jemand anderen frei.",
  it: "Il tuo nuovo orario è registrato presso Harbor Kitchen. Abbiamo provato a inviarti via email il nuovo orario e un file di calendario. Il vecchio orario è di nuovo libero per qualcun altro.",
  nl: "Je nieuwe tijd is bij Harbor Kitchen opgeslagen. We hebben geprobeerd je de nieuwe tijd en een agendabestand te e-mailen. De oude tijd is weer vrij voor iemand anders.",
  pt: "O seu novo horário está guardado na Harbor Kitchen. Tentámos enviar-lhe por email o novo horário e um ficheiro de calendário. O horário anterior fica livre para outra pessoa.",
};

async function main(): Promise<void> {
  part("All seven moved-booking pages distinguish the saved move from the email attempt");
  for (const code of LANGUAGE_CODES) {
    is(`${code}: complete evidence-bound note`, bookingWords(code).movedNote("Harbor Kitchen"), EXPECTED[code]);
  }

  part("The real flow has no email-delivery evidence");
  const email = readFileSync("lib/email.ts", "utf8");
  const calls = readFileSync("lib/calls.ts", "utf8");
  const tellMoved = calls.slice(calls.indexOf("async function tellMoved"), calls.indexOf("async function teamForMove"));
  const route = readFileSync("app/api/store/book/move/route.ts", "utf8");
  const page = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  is("sendEmail can return false", email.includes("export async function sendEmail") && email.includes("Promise<boolean>"), true);
  is("both moved-email results are ignored", [(tellMoved.match(/await sendEmail\(\{/g) ?? []).length, /=\s*await sendEmail/.test(tellMoved)], [2, false]);
  is("a thrown notification attempt is best effort after the saved move", /await tellMoved\([\s\S]*?\.catch\([\s\S]*?sending the move emails failed/.test(calls), true);
  is("the route reports moved from the saved result alone", route.includes('return back(result.ok ? "moved" : result.reason);'), true);
  is("that status selects the unconditional buyer note", page.includes('const moved = status === "moved";') && page.includes("b.movedNote(store.name)"), true);

  done();
}

void main();
