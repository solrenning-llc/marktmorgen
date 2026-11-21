import { contactWords } from "@/lib/buyer-words/contact";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, { line: string; title: string; body: string }> = {
  en: {
    line: "Send Harbor Kitchen a message: a question, a collaboration, anything. We try to deliver it to their email. If they reply, their answer goes to yours.",
    title: "Your message was accepted for sending",
    body: "The message was accepted for sending to Harbor Kitchen's email. If Harbor Kitchen replies, the answer goes to the address you gave. Nothing else is sent to you.",
  },
  es: {
    line: "Envía un mensaje a Harbor Kitchen: una pregunta, una colaboración, lo que sea. Intentamos entregarlo en su email. Si responde, la respuesta llega al tuyo.",
    title: "Tu mensaje fue aceptado para el envío",
    body: "El mensaje fue aceptado para enviarlo al email de Harbor Kitchen. Si Harbor Kitchen responde, la respuesta llega a la dirección que diste. No se te envía nada más.",
  },
  fr: {
    line: "Envoyez un message à Harbor Kitchen : une question, une collaboration, ce que vous voulez. Nous essayons de le remettre à son adresse e-mail. Si Harbor Kitchen répond, sa réponse arrive à la vôtre.",
    title: "Votre message a été accepté pour envoi",
    body: "Le message a été accepté pour être envoyé à l'adresse e-mail de Harbor Kitchen. Si Harbor Kitchen répond, la réponse arrive à l'adresse indiquée. Rien d'autre ne vous est envoyé.",
  },
  de: {
    line: "Schick Harbor Kitchen eine Nachricht: eine Frage, eine Zusammenarbeit, was du willst. Wir versuchen, sie an die E-Mail-Adresse des Shops zu senden. Wenn Harbor Kitchen antwortet, kommt die Antwort an deine.",
    title: "Deine Nachricht wurde zum Senden angenommen",
    body: "Die Nachricht wurde zum Senden an die E-Mail-Adresse von Harbor Kitchen angenommen. Wenn Harbor Kitchen antwortet, geht die Antwort an die von dir angegebene Adresse. Sonst wird dir nichts geschickt.",
  },
  it: {
    line: "Manda un messaggio a Harbor Kitchen: una domanda, una collaborazione, quello che vuoi. Cerchiamo di consegnarlo alla sua email. Se Harbor Kitchen risponde, la risposta arriva alla tua.",
    title: "Il tuo messaggio è stato accettato per l'invio",
    body: "Il messaggio è stato accettato per essere inviato all'email di Harbor Kitchen. Se Harbor Kitchen risponde, la risposta arriva all'indirizzo che hai dato. Non ti viene inviato nient'altro.",
  },
  nl: {
    line: "Stuur Harbor Kitchen een bericht: een vraag, een samenwerking, wat je maar wilt. We proberen het op hun e-mailadres te bezorgen. Als Harbor Kitchen antwoordt, gaat het antwoord naar jouw adres.",
    title: "Je bericht is geaccepteerd voor verzending",
    body: "Het bericht is geaccepteerd om naar het e-mailadres van Harbor Kitchen te worden verstuurd. Als Harbor Kitchen antwoordt, gaat het antwoord naar het adres dat je opgaf. Verder wordt er niets naar je gestuurd.",
  },
  pt: {
    line: "Envie uma mensagem a Harbor Kitchen: uma pergunta, uma colaboração, o que quiser. Tentamos entregá-la no email da loja. Se Harbor Kitchen responder, a resposta segue para o seu.",
    title: "A sua mensagem foi aceite para envio",
    body: "A mensagem foi aceite para envio para o endereço de email de Harbor Kitchen. Se Harbor Kitchen responder, a resposta segue para o endereço que indicou. Não lhe é enviado mais nada.",
  },
};

async function main(): Promise<void> {
  part("Contact copy says only what provider acceptance proves");
  for (const code of LANGUAGE_CODES) {
    const words = contactWords(code);
    is(`${code}: the complete form introduction is conditional`, words.line("Harbor Kitchen"), EXPECTED[code].line);
    is(`${code}: the complete success title names acceptance`, words.sentTitle, EXPECTED[code].title);
    is(`${code}: the complete success body does not claim receipt or promise a reply`, words.sentBody("Harbor Kitchen"), EXPECTED[code].body);
  }

  part("The linked flow knows acceptance, not receipt or a future reply");
  const source = readFileSync("lib/store-contact.ts", "utf8");
  is("success starts with the sender's boolean answer", source.includes("const sent = await sendEmail("), true);
  is("filing in the store inbox is best effort after sender acceptance", source.includes("if (sent) await fileContact(") && source.includes("filing a contact message failed"), true);
  is("the public result follows acceptance and has no delivery-status read", [source.includes('return sent ? "sent" : "error"'), /deliveryStatus|delivery_status|GET[\s\S]*email/i.test(source)], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
