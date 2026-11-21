/**
 * Cancelling a live event is confirmed when the event record changes. Email
 * notices are queued afterward and can have no recipients or fail at the
 * sender. The buyer page therefore keeps the cancellation certain while
 * describing the email as an attempt that may not arrive.
 */
import { readFileSync } from "node:fs";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, string> = {
  en: "Harbor Kitchen canceled this event. If you RSVP'd, we try to email you, but the email may not arrive. There is nothing for you to do.",
  es: "Harbor Kitchen canceló este evento. Si habías confirmado tu asistencia, intentamos avisarte por email, pero el mensaje puede no llegar. No tienes que hacer nada.",
  fr: "Harbor Kitchen a annulé cet événement. Si vous aviez confirmé votre présence, nous essayons de vous prévenir par e-mail, mais le message peut ne pas arriver. Vous n'avez rien à faire.",
  de: "Harbor Kitchen hat dieses Event abgesagt. Wenn Sie zugesagt hatten, versuchen wir, Sie per E-Mail zu informieren, aber die E-Mail kommt vielleicht nicht an. Sie müssen nichts tun.",
  it: "Harbor Kitchen ha annullato questo evento. Se avevi confermato la partecipazione, proviamo ad avvisarti via email, ma il messaggio potrebbe non arrivare. Non devi fare nulla.",
  nl: "Harbor Kitchen heeft dit evenement geannuleerd. Als je had aangegeven dat je zou gaan, proberen we je per e-mail te informeren, maar die e-mail komt mogelijk niet aan. Je hoeft niets te doen.",
  pt: "Harbor Kitchen cancelou este evento. Se tinha confirmado a presença, tentamos enviar-lhe um email, mas pode não chegar. Não precisa de fazer nada.",
};

async function main(): Promise<void> {
  part("All seven languages keep cancellation certain and make the email attempt conditional");
  for (const language of LANGUAGE_CODES) {
    is(`${language}: canceled event notice`, communityWords(language).canceledByCreator("Harbor Kitchen"), EXPECTED[language]);
  }

  part("The real cancellation flow does not prove that every RSVP was emailed");
  const page = readFileSync("app/[handle]/community/events/[event]/page.tsx", "utf8");
  const route = readFileSync("app/api/store/community/events/route.ts", "utf8");
  const mail = readFileSync("lib/community-event-mail.ts", "utf8");
  const cancel = route.slice(route.indexOf('if (action === "cancel")'), route.indexOf('if (action === "delete")'));
  const startJob = mail.slice(mail.indexOf("async function startJob"), mail.indexOf("/** The creator moved or cancelled"));
  const advance = mail.slice(mail.indexOf("export async function advanceEventJob"), mail.indexOf("type Due ="));

  is("the buyer page selects the notice from the persisted canceled state", page.includes("event.cancelled ?") && page.includes("w.canceledByCreator(store.name)"), true);
  is("the route confirms cancellation before queueing its notice", cancel.indexOf("await cancelEvent") < cancel.indexOf("await queueEventNotice"), true);
  is("a cancellation still returns success after only handing the job to after", cancel.includes("notify(await queueEventNotice") && cancel.includes("return Response.json({ ok: true })"), true);
  is("a missing job makes notify return without changing cancellation success", route.includes("if (!job) return;") && route.includes("const notify ="), true);
  is("no RSVP readers means no email job", startJob.includes("if (!readers.length) return null"), true);
  is("sender refusal records a failed email job", advance.includes('outcome === "refused"') && advance.includes('finish("failed", "The email service would not take it. Nothing more was sent.")'), true);

  done();
}

void main();
