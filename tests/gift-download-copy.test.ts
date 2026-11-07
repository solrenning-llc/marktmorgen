/**
 * The buyer of a gift who asks for its download is told why it does not open
 * here, without saying that an email was sent (VR item 2; Claude 5, rule 30 of
 * the #2641 review; Codex U's proof on codex/u-gift-orders-email-copy-red).
 * lib/gifts.ts gives the gift before it tries the recipient's email, and that
 * email can be refused, so "it opens from the email sent to the person" would
 * state a delivery nobody checked. The gift opens from the recipient's own
 * purchases at this store, which is how the store hands it over.
 */
import { ordersWords } from "@/lib/buyer-words/orders";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, string> = {
  en: "This was a gift, so it does not open here. The person it is for opens it from their own purchases at this store.",
  es: "Esto fue un regalo, así que no se abre aquí. La persona a quien va dirigido lo abre desde sus propias compras en esta tienda.",
  fr: "C'était un cadeau, il ne s'ouvre donc pas ici. La personne à qui il est destiné l'ouvre depuis ses propres achats dans cette boutique.",
  de: "Dies war ein Geschenk, daher wird es nicht hier geöffnet. Die beschenkte Person öffnet es über ihre eigenen Käufe in diesem Shop.",
  it: "Questo era un regalo, quindi non si apre qui. La persona a cui è destinato lo apre dai propri acquisti in questo negozio.",
  nl: "Dit was een cadeau, dus het opent niet hier. Degene voor wie het is, opent het via de eigen aankopen in deze winkel.",
  pt: "Isto foi um presente, por isso não abre aqui. A pessoa a quem se destina abre-o a partir das suas próprias compras nesta loja.",
};

part("A gift's download refusal says how it opens, never that an email was sent");
is("all seven buyer languages are covered", LANGUAGE_CODES.length, 7);
for (const code of LANGUAGE_CODES) {
  const said = ordersWords(code).downloadProblems.gift;
  is(`${code}: the exact sentence`, said, EXPECTED[code]);
  is(`${code}: no email named as the way in`, /e-?mail/i.test(said), false);
}
done();
