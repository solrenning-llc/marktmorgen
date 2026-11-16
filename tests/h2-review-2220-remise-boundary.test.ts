import { DEAL_WORDS, heldToFacts } from "@/lib/store-assistant-rules";
import { neutralLine } from "@/lib/assistant-reminder-rules";
import { done, is, part } from "./check";

const facts = "Cours de poterie. Le prix est affiché sur la page.";

part("Only a written French elision can introduce the handed-over object");
for (const reply of [
  "La remise de lcertificat réduit le prix.",
  "La remise de l certificat réduit le prix.",
]) {
  is(`${reply}: the facts gate refuses the malformed exception`, heldToFacts(reply, facts), false);
  is(`${reply}: remise remains a deal word`, DEAL_WORDS.test(reply), true);
  is(`${reply}: the reminder cannot repeat it`, neutralLine(reply, facts), "");
}

is("a real elision still permits handing over an attestation", heldToFacts("La remise de l'attestation suit le cours.", facts), true);

done();
