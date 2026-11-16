import { readFileSync } from "node:fs";
import { thanksWords } from "@/lib/buyer-words/thanks";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const TITLE = "Team handbook";
const EXPECTED: Record<LanguageCode, string> = {
  en: `Send it to the people it is for. Each one opens it and types their own email address. If the email with the link reaches them, opening it puts ${TITLE} on that address, as if they had bought it.`,
  es: `Envíalo a las personas para quienes es. Cada una lo abre y escribe su propia dirección de email. Si le llega el email con el enlace, al abrirlo ${TITLE} queda en esa dirección, como si lo hubiera comprado.`,
  fr: `Envoyez-le aux personnes concernées. Chacune l'ouvre et saisit sa propre adresse e-mail ; si l'e-mail contenant le lien lui parvient, l'ouvrir met ${TITLE} sur cette adresse, comme si elle l'avait acheté.`,
  de: `Schicken Sie ihn an die Personen, für die er gedacht ist. Jede öffnet ihn und gibt ihre eigene E-Mail-Adresse ein. Falls die E-Mail mit dem Link sie erreicht, wird ${TITLE} beim Öffnen dieser Adresse zugeordnet, als hätte sie es gekauft.`,
  it: `Mandalo alle persone a cui è destinato. Ognuna lo apre e scrive il proprio indirizzo email. Se le arriva l'email con il link, aprendolo ${TITLE} viene associato a quell'indirizzo, come se l'avesse comprato.`,
  nl: `Stuur hem naar de mensen voor wie hij is. Ieder opent hem en typt een eigen e-mailadres. Als de e-mail met de link aankomt, staat ${TITLE} na het openen op dat adres, alsof die persoon het zelf kocht.`,
  pt: `Envie-a às pessoas a quem se destina. Cada uma abre-a e escreve o próprio endereço de email. Se o email com a ligação lhe chegar, ao abri-la ${TITLE} fica associado a esse endereço, como se o tivesse comprado.`,
};

part("Group-place copy conditions inbox arrival on evidence the sender does not have");
is("all seven buyer languages remain present", LANGUAGE_CODES.length, 7);
for (const code of LANGUAGE_CODES) {
  const text = thanksWords(code).groupSend(TITLE);
  is(`${code}: renders the complete group-place instruction`, text, EXPECTED[code]);
  is(`${code}: keeps the product title`, text.includes(TITLE), true);
}

part("The sender boundary confirms acceptance or refusal, not inbox delivery");
const source = readFileSync("lib/group-buy.ts", "utf8");
const start = source.indexOf("export async function askPlace");
const end = source.indexOf("export type Taken", start);
const askPlace = source.slice(start, end);
is("the real flow maps sender refusal to unavailable", askPlace.includes('return sent ? "sent" : "unavailable";'), true);
is("the real flow does not consume an inbox-delivery event", /deliveredToInbox|delivery event|inbox event/i.test(askPlace), false);
done();
