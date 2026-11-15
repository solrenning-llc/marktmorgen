/**
 * #4672, review 5bNDa (MEDIUM, UX): a message to a person no longer in the community (deleted, or who left) is not
 * written, and the sender was sent back to their conversations with no word, so the message vanished in silence. Now a
 * neutral warning says it was not sent, without saying why (nobody learns of another person's deletion from a message
 * box), in every language the community's buyer words are in.
 */
import { readFileSync } from "node:fs";
import { communityNotices } from "@/components/community-parts";
import { done, is, part } from "./check";

part("The warning, in every language, drawn as a warning");
for (const language of ["en", "es", "fr", "de", "it", "nl", "pt"]) {
  const notice = communityNotices(language).dmnotsent;
  is(`${language}: a warning`, notice?.tone, "warn");
  is(`${language}: it has words of its own`, typeof notice?.text === "string" && notice.text.length > 20 && (language === "en" || notice.text !== communityNotices("en").dmnotsent?.text), true);
}
is("English: says it was not sent, never why", communityNotices("en").dmnotsent?.text, "This conversation is no longer available. Your message was not sent.");

part("The route sends it");
const route = readFileSync("app/api/store/community/messages/route.ts", "utf8");
is("a recipient no longer in: back to the conversations with the warning", route.includes('if (!sent.ok && sent.reason === "gone") return back(box, "dmnotsent");'), true);
done();
