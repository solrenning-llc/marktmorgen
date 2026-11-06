/**
 * Handing a question to the store proves that it was filed in the store's
 * inbox. It does not prove that the creator will answer. A later reply is a
 * separate action, and even its email attempt can return false.
 */
import { readFileSync } from "node:fs";
import { assistantWords } from "@/lib/buyer-words/assistant";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, readonly [string, string, string, string]> = {
  en: [
    "I don't know that from what Harbor Kitchen has published. I can pass your question to Harbor Kitchen. If they reply, it comes by email.",
    "That is one for Harbor Kitchen. Leave your email below and your question goes to their inbox.",
    "The assistant has answered all it can this month. Leave your question and your email, and it goes to Harbor Kitchen's inbox. If they reply, it comes by email.",
    "Sent to Harbor Kitchen's inbox. If they reply, it comes by email.",
  ],
  es: [
    "No lo sé con lo que Harbor Kitchen ha publicado. Puedo pasar tu pregunta a Harbor Kitchen. Si responde, te llega por correo.",
    "Eso debe responderlo Harbor Kitchen. Deja tu correo abajo y tu pregunta llega a su bandeja.",
    "El asistente ya respondió todo lo que puede este mes. Deja tu pregunta y tu correo, y llega a la bandeja de Harbor Kitchen. Si responde, te llega por correo.",
    "Enviado a la bandeja de Harbor Kitchen. Si responde, te llega por correo.",
  ],
  fr: [
    "Je ne le sais pas d'après ce que Harbor Kitchen a publié. Je peux transmettre votre question à Harbor Kitchen. Si la boutique répond, la réponse vous parvient par e-mail.",
    "C'est à Harbor Kitchen d'y répondre. Laissez votre e-mail ci-dessous et votre question arrive dans sa boîte.",
    "L'assistant a répondu à tout ce qu'il peut ce mois-ci. Laissez votre question et votre e-mail. Ils arrivent dans la boîte de Harbor Kitchen. Si la boutique répond, la réponse vous parvient par e-mail.",
    "Envoyé dans la boîte de Harbor Kitchen. Si la boutique répond, la réponse vous parvient par e-mail.",
  ],
  de: [
    "Das weiß ich aus dem, was Harbor Kitchen veröffentlicht hat, nicht. Ich kann deine Frage an Harbor Kitchen weitergeben. Wenn der Shop antwortet, kommt die Antwort per E-Mail.",
    "Das muss Harbor Kitchen beantworten. Gib unten deine E-Mail an, dann geht deine Frage in das Postfach des Shops.",
    "Der Assistent hat diesen Monat alles beantwortet, was er kann. Hinterlasse deine Frage und deine E-Mail. Beides geht in das Postfach von Harbor Kitchen. Wenn der Shop antwortet, kommt die Antwort per E-Mail.",
    "An Harbor Kitchen gesendet. Wenn der Shop antwortet, kommt die Antwort per E-Mail.",
  ],
  it: [
    "Non lo so da ciò che Harbor Kitchen ha pubblicato. Posso passare la tua domanda a Harbor Kitchen. Se risponde, la risposta ti arriva via email.",
    "Questa è una domanda per Harbor Kitchen. Lascia la tua email qui sotto e la domanda arriva nella sua casella.",
    "L'assistente ha risposto a tutto ciò che può questo mese. Lascia la tua domanda e la tua email. Arrivano nella casella di Harbor Kitchen. Se risponde, la risposta ti arriva via email.",
    "Inviato nella casella di Harbor Kitchen. Se risponde, la risposta ti arriva via email.",
  ],
  nl: [
    "Dat weet ik niet uit wat Harbor Kitchen heeft gepubliceerd. Ik kan je vraag doorgeven aan Harbor Kitchen. Als de winkel antwoordt, krijg je het antwoord per e-mail.",
    "Die vraag is voor Harbor Kitchen. Laat hieronder je e-mail achter en je vraag gaat naar de inbox van de winkel.",
    "De assistent heeft deze maand alles beantwoord wat hij kan. Laat je vraag en je e-mail achter. Ze gaan naar de inbox van Harbor Kitchen. Als de winkel antwoordt, krijg je het antwoord per e-mail.",
    "Naar de inbox van Harbor Kitchen gestuurd. Als de winkel antwoordt, krijg je het antwoord per e-mail.",
  ],
  pt: [
    "Não sei isso pelo que Harbor Kitchen publicou. Posso passar a sua pergunta à Harbor Kitchen. Se a loja responder, a resposta chega-lhe por e-mail.",
    "Essa é para Harbor Kitchen responder. Deixe o seu e-mail abaixo e a sua pergunta chega à caixa da loja.",
    "O assistente já respondeu tudo o que pode este mês. Deixe a sua pergunta e o seu e-mail. Chegam à caixa da Harbor Kitchen. Se a loja responder, a resposta chega-lhe por e-mail.",
    "Enviado para a caixa da Harbor Kitchen. Se a loja responder, a resposta chega-lhe por e-mail.",
  ],
};

async function main(): Promise<void> {
  part("All seven languages describe a filed question and make a later reply conditional");
  for (const code of LANGUAGE_CODES) {
    const words = assistantWords(code);
    const actual = [words.unknown("Harbor Kitchen"), words.handoff("Harbor Kitchen"), words.spent("Harbor Kitchen"), words.handoffDone("Harbor Kitchen")];
    actual.forEach((text, index) => is(`${code}: reply phrase ${index + 1}`, text, EXPECTED[code][index]));
  }

  part("The real flow proves filing, not a future creator reply");
  const assistant = readFileSync("lib/store-assistant.ts", "utf8");
  const inbox = readFileSync("lib/inbox.ts", "utf8");
  const email = readFileSync("lib/email.ts", "utf8");
  const handoff = assistant.slice(assistant.indexOf("export async function handToCreator"), assistant.indexOf("/** The newest questions"));
  const filed = inbox.slice(inbox.indexOf("export async function handOver"), inbox.indexOf("async function fromToken"));
  is("handoff success starts with a filed inbox conversation", handoff.includes("const filed = await handOver") && handoff.includes("if (!filed.ok)"), true);
  is("the success text is added immediately after filing", handoff.includes("assistantWords(store.language).handoffDone(store.name)"), true);
  is("telling the team is best effort after the inbox write", /await tellTeam[\s\S]*?\.catch[\s\S]*?return \{ ok: true/.test(filed), true);
  is("a creator reply is a separate action whose email result is exposed", inbox.includes("export type ReplyResult = { ok: true; thread: Thread; emailed: boolean }") && inbox.includes("export async function replyTo"), true);
  is("that later email attempt can return false", email.includes("export async function sendEmail") && email.includes("Promise<boolean>"), true);

  done();
}

void main();
