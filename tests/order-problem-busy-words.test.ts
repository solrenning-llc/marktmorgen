/**
 * The report page's "busy" words are true in both cases they cover (Claude 1's MEDIUM on #3838). The route answers
 * `busy` when the store is busy AND when a report of this order is being filed right now (the order's mark is
 * `pending`: a double press on Send, or a retry within five minutes after an unconfirmed one). In the second case the
 * report may have reached the creator, so the words never say that nothing was sent; they tell a buyer who already
 * pressed Send that it may have arrived, naming that button in each language.
 */
import { orderProblemWords } from "@/lib/buyer-words/order-problem";
import { done, is, part } from "./check";

const LANGUAGES = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;

for (const language of LANGUAGES) {
  part(`${language}: the busy words`);
  const words = orderProblemWords(language);
  is(`${language}: they name the Send button, for a buyer who already pressed it`, words.busyNow.includes(words.send), true);
}

part("en: never 'nothing was sent'");
is("the English busy words do not say nothing was sent", /nothing was sent/i.test(orderProblemWords("en").busyNow), false);

done();
