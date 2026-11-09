/** A provider accepting a private-podcast email is not evidence of inbox delivery time. */
import { readFileSync } from "node:fs";
import { coursesWords } from "@/lib/buyer-words/courses";
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

part("The status notice says only what the sender knows");
for (const code of LANGUAGE_CODES) {
  const body = coursesWords(code).podcastNotices.sent.body;
  is(`${code}: provider acceptance is not an inbox deadline`, DEADLINE[code].test(body), false);
}

part("The real sender has acceptance evidence, not delivery evidence");
const sender = readFileSync("lib/podcast-access.ts", "utf8");
is("sendFeedLink maps the sender boolean directly to sent/error", sender.includes('return sent ? "sent" : "error";'), true);
is("the sender does not read a delivered event", /delivered|delivery event|webhook/i.test(sender), false);
done();
