/** Exact, conditional buyer copy: no delivery or inbox deadline is promised. */
import { readFileSync } from "node:fs";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";
const expected: Record<LanguageCode, string> = {
  "en": "If that address has access to this podcast, we'll try to email its feed link. Check your inbox and spam folder.",
  "es": "Si esa dirección tiene acceso a este pódcast, intentaremos enviarle por email el enlace a su feed. Revisa la bandeja de entrada y el spam.",
  "fr": "Si cette adresse a accès à ce podcast, nous essaierons de lui envoyer le lien de son flux par e-mail. Vérifiez votre boîte de réception et vos spams.",
  "de": "Wenn diese Adresse Zugang zu diesem Podcast hat, versuchen wir, ihr den Feed-Link per E-Mail zu senden. Sehen Sie im Posteingang und im Spam-Ordner nach.",
  "it": "Se quell'indirizzo ha accesso a questo podcast, proveremo a inviargli il link al feed per email. Controlla la posta in arrivo e lo spam.",
  "nl": "Als dat adres toegang heeft tot deze podcast, proberen we de feedlink per e-mail te sturen. Kijk in je inbox en bij spam.",
  "pt": "Se esse endereço tiver acesso a este podcast, tentaremos enviar-lhe por email a ligação para o feed. Consulte a sua caixa de entrada e o spam."
};
part("Each language describes only a conditional attempt");
for (const code of LANGUAGE_CODES) {
  is(`${code}: exact conditional email-attempt sentence`, coursesWords(code).podcastNotices.sent.body, expected[code]);
}
part("The sent result must not disclose access or certify inbox delivery");
const source = readFileSync("lib/podcast-access.ts", "utf8");
// Since the uniform reply (tests/access-link-uniform-reply.test.ts) the answer is "sent" for every address at once,
// and whether it may listen, the feed and its email are all decided after it (lib/after-answer.ts).
// Was: "no access still returns the same sent result without sending" (`if (!(await mayListen(...))) return "sent";`)
// and "the sending path maps acceptance to sent or error" (`return sent ? "sent" : "error";`).
is("every address gets the same sent result, before anything about it is read", source.includes('afterAnswer("sending a podcast feed link", () => sendFeedEmail(store, product, raw, input.base, input.from));\n  return "sent";'), true);
is("no access sends nothing", source.includes("if (!(await mayListen(store, product.id, raw))) return;"), true);
is("an email that did not go out is said only to the server's log", source.includes('if (!sent) console.error("a podcast feed link was not sent");'), true);
done();
