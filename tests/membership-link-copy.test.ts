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

const EXPECTED_SENT: Record<LanguageCode, string> = {
  en: "If that address has a membership with Harbor Kitchen, the link is on its way. It comes from Harbor Kitchen via Marktmorgen. If it is not there, look in spam.",
  es: "Si esa dirección tiene una membresía en Harbor Kitchen, el enlace va de camino. Lo envía Harbor Kitchen a través de Marktmorgen. Si no está, mira en la carpeta de spam.",
  fr: "Si cette adresse a un abonnement chez Harbor Kitchen, le lien est en route. Il vient de Harbor Kitchen via Marktmorgen. S'il n'y est pas, regardez dans les spams.",
  de: "Wenn diese Adresse eine Mitgliedschaft bei Harbor Kitchen hat, ist der Link unterwegs. Er kommt von Harbor Kitchen über Marktmorgen. Falls er nicht da ist, sehen Sie im Spam-Ordner nach.",
  it: "Se quell'indirizzo ha un abbonamento con Harbor Kitchen, il link è in arrivo. Lo invia Harbor Kitchen tramite Marktmorgen. Se non c'è, guarda nella cartella spam.",
  nl: "Als dat adres een lidmaatschap bij Harbor Kitchen heeft, is de link onderweg. Hij komt van Harbor Kitchen via Marktmorgen. Staat hij er niet, kijk dan in je spam.",
  pt: "Se esse endereço tiver uma subscrição com Harbor Kitchen, a ligação está a caminho. É enviada por Harbor Kitchen através da Marktmorgen. Se não estiver lá, veja na pasta de spam.",
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
is("the request result comes from the sender acceptance boolean", manage.includes('const sent = await sendEmail') && manage.includes('return sent ? "sent" : "error";'), true);
is("the request path has no delivery-status event", /delivery(?:Status|Event|Receipt)/.test(manage), false);
done();
