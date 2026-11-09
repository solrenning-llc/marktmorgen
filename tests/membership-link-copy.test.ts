import { readFileSync } from "node:fs";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED_NOTE: Record<LanguageCode, string> = {
  en: "If that address has a membership with Harbor Kitchen, we try to email a link to it. It works for one hour. We say the same thing whether or not it does, so nobody can use this page to find out who is a member.",
  es: "Si esa dirección tiene una membresía en Harbor Kitchen, intentamos enviarle un enlace por email. Funciona durante una hora. Decimos lo mismo tanto si la tiene como si no, para que nadie pueda usar esta página para averiguar quién es miembro.",
  fr: `Si cette adresse a un abonnement chez Harbor Kitchen, nous essayons de lui envoyer un lien par e-mail. Il fonctionne pendant une heure. Nous affichons le même message dans tous les cas, pour que personne ne puisse utiliser cette page pour savoir qui est membre.`,
  de: "Wenn diese Adresse eine Mitgliedschaft bei Harbor Kitchen hat, versuchen wir, einen Link dorthin per E-Mail zu senden. Er funktioniert eine Stunde lang. Wir sagen dasselbe, ob das der Fall ist oder nicht, damit niemand mit dieser Seite herausfinden kann, wer Mitglied ist.",
  it: "Se quell'indirizzo ha un abbonamento con Harbor Kitchen, proviamo a inviare un link via email. Funziona per un'ora. Diciamo la stessa cosa in ogni caso, così nessuno può usare questa pagina per scoprire chi è membro.",
  nl: "Als dat adres een lidmaatschap bij Harbor Kitchen heeft, proberen we er per e-mail een link naartoe te sturen. Die werkt een uur. We zeggen hetzelfde, of dat nu zo is of niet, zodat niemand via deze pagina kan uitzoeken wie lid is.",
  pt: "Se esse endereço tiver uma subscrição com Harbor Kitchen, tentamos enviar-lhe uma ligação por email. Funciona durante uma hora. Dizemos o mesmo quer tenha quer não, para que ninguém possa usar esta página para descobrir quem é membro.",
};

// Changed 07/11/2026 (membership-link oracle fix, tests/oracle-siblings-uniform-reply.test.ts): the answer is "sent"
// for every address before any email is tried, so the sent status says an email was tried, not that one is on its
// way, and what to do if none arrives. Was: "..., the link is on its way. ... If it is not there, look in spam." (x7).
const EXPECTED_SENT: Record<LanguageCode, string> = {
  en: "If that address has a membership with Harbor Kitchen, we tried to email it the link. It comes from Harbor Kitchen via Marktmorgen. If nothing arrives in a few minutes, check your spam folder, then ask again.",
  es: "Si esa dirección tiene una membresía en Harbor Kitchen, intentamos enviarle el enlace por email. Lo envía Harbor Kitchen a través de Marktmorgen. Si no llega nada en unos minutos, mira en la carpeta de spam y luego vuelve a pedirlo.",
  fr: "Si cette adresse a un abonnement chez Harbor Kitchen, nous avons essayé de lui envoyer le lien par e-mail. Il vient de Harbor Kitchen via Marktmorgen. Si rien n'arrive d'ici quelques minutes, regardez dans les spams, puis redemandez-le.",
  de: "Wenn diese Adresse eine Mitgliedschaft bei Harbor Kitchen hat, haben wir versucht, ihr den Link per E-Mail zu senden. Er kommt von Harbor Kitchen über Marktmorgen. Wenn in ein paar Minuten nichts ankommt, sehen Sie im Spam-Ordner nach und fragen Sie dann erneut.",
  it: "Se quell'indirizzo ha un abbonamento con Harbor Kitchen, abbiamo provato a inviargli il link via email. Lo invia Harbor Kitchen tramite Marktmorgen. Se tra qualche minuto non arriva nulla, guarda nella cartella spam, poi richiedilo.",
  nl: "Als dat adres een lidmaatschap bij Harbor Kitchen heeft, hebben we geprobeerd er de link naartoe te mailen. Hij komt van Harbor Kitchen via Marktmorgen. Komt er binnen een paar minuten niets aan, kijk dan in je spam en vraag hem daarna opnieuw.",
  pt: "Se esse endereço tiver uma subscrição com Harbor Kitchen, tentámos enviar-lhe a ligação por email. É enviada por Harbor Kitchen através da Marktmorgen. Se nada chegar dentro de alguns minutos, veja na pasta de spam e depois volte a pedir.",
};

part("Membership-link copy describes an attempt without an inbox deadline");
is("all seven buyer languages remain present", LANGUAGE_CODES.length, 7);
for (const code of LANGUAGE_CODES) {
  const words = membershipWords(code);
  const note = words.linkNote("Harbor Kitchen", 1);
  const sent = words.sentBody("Harbor Kitchen");
  is(`${code}: renders the complete request note`, note, EXPECTED_NOTE[code]);
  is(`${code}: renders the complete sent status`, sent, EXPECTED_SENT[code]);
  is(`${code}: keeps the store and spam guidance`, [note.includes("Harbor Kitchen"), sent.includes("Harbor Kitchen"), /spam/i.test(sent)], [true, true, true]);
  is(`${code}: preserves the link lifetime`, words.linkNote("Harbor Kitchen", 2) !== note, true);
  is(`${code}: has no unresolved interpolation`, /undefined|NaN|\$\{|\[object/.test(`${note} ${sent}`), false);
}

const manage = readFileSync("lib/membership-manage.ts", "utf8");
// Changed 07/11/2026 (membership-link oracle fix): the answer no longer comes from the sender's boolean, which told a
// member whose email failed ("error") from anybody else ("sent"); the email runs after the answer and its boolean
// only decides whether the unsent link is deleted. Was: the request returned `sent ? "sent" : "error"`.
is("the request answers the same before any email, and the sender's boolean only removes an unsent link", [
  /afterAnswer\("sending a membership link"[^\n]*\n\s*return "sent";/.test(manage),
  manage.includes("sent = await sendEmail"),
  /if \(!sent\) \{\s*await redisPipeline\(\[\["DEL", key\]\]\)/.test(manage),
  manage.includes('return sent ? "sent" : "error";'),
], [true, true, true, false]);
is("the request path has no delivery-status event", /delivery(?:Status|Event|Receipt)/.test(manage), false);
done();
