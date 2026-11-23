/**
 * Board #5285, row #2593 (Claude 5's LEVE on #2593, a Codex PR): #2593 took the "usually arrives within a minute"
 * promise out of the waitlist page, because sending an email proves only that the sender accepted it, never when it
 * reaches the inbox (VR item 2). The same promise stayed in the sibling copy outside its diff, in every language:
 * giving.ts expiredRecover, affiliates.ts sentBody, moved-purchases.ts openOne and openMany, and the studio sign-in
 * form. Claude 5's note on the same review: the Italian waitlist sentence said "Se non la trovi" (feminine) of "un
 * pulsante" (masculine).
 */
import { readFileSync } from "node:fs";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { givingWords } from "@/lib/buyer-words/giving";
import { movedPurchaseWords } from "@/lib/buyer-words/moved-purchases";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const DEADLINE: Record<LanguageCode, RegExp> = {
  en: /within a minute/i,
  es: /menos de un minuto/i,
  fr: /moins d'une minute/i,
  de: /innerhalb einer Minute/i,
  it: /entro un minuto/i,
  nl: /binnen een minuut/i,
  pt: /menos de um minuto/i,
};
const STORE = "Harbor Kitchen";
const ORDERS = "https://marktmorgen.com/@harbor/orders";
const EMAIL = "reader@example.test";

part("No sibling copy promises when an email reaches the inbox");
for (const code of LANGUAGE_CODES) {
  const texts: [string, string][] = [
    ["giving.expiredRecover", givingWords(code).expiredRecover],
    ["affiliates.sentBody", affiliatesWords(code).sentBody(STORE)],
    ["moved.openOne", movedPurchaseWords(code).openOne(ORDERS, EMAIL)],
    ["moved.openMany", movedPurchaseWords(code).openMany(ORDERS, EMAIL)],
  ];
  for (const [name, text] of texts) {
    is(`${code} ${name}: no inbox deadline`, DEADLINE[code].test(text), false);
    is(`${code} ${name}: nothing left unfilled`, /undefined|NaN|\$\{|\[object/.test(text), false);
  }
  is(`${code} affiliates.sentBody: keeps the store and the spam guidance`, [affiliatesWords(code).sentBody(STORE).includes(STORE), /spam/i.test(affiliatesWords(code).sentBody(STORE))], [true, true]);
  is(`${code} moved: keeps the orders page and the address`, [ORDERS, EMAIL].every((part) => movedPurchaseWords(code).openOne(ORDERS, EMAIL).includes(part)), true);
}

part("The studio sign-in form keeps its spam guidance without a deadline");
const signin = readFileSync("components/signin-form.tsx", "utf8");
is("no 'within a minute'", /within a minute/i.test(signin), false);
is("still says where to look", signin.includes("Look in spam or promotions."), true);

part("The Italian waitlist sentence agrees with 'un pulsante'");
const italian = givingWords("it").waitSentBody("The Bread Book", STORE);
is("'Se non lo trovi', not 'Se non la trovi'", [italian.includes("Se non lo trovi"), italian.includes("Se non la trovi")], [true, false]);

done();
