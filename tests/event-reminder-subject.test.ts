/**
 * A live event's reminder email says when the event starts in its subject,
 * in every buyer language, with no piece of code left in it: the French one
 * hour reminder once read "Dans 1${S}heure : <title>", a plain string where a
 * template was meant (lib/buyer-words/community.ts).
 *
 * Pure words over a synthetic event; nothing is sent.
 */
import { eventMailWords } from "@/lib/community-event-mail";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is } from "./check";

const TITLE = "Pottery Q&A";
const event = { id: "e1", title: TITLE, start: 1_790_000_000, minutes: 60, tz: "Europe/Paris" } as Parameters<typeof eventMailWords>[2];

for (const language of LANGUAGE_CODES) {
  const w = communityWords(language);
  for (const tomorrow of [true, false]) {
    const subject = w.evReminderSubject(tomorrow, TITLE);
    is(`${language} ${tomorrow ? "tomorrow" : "one hour"}: no code in the subject`, /\$\{|\}/.test(subject), false);
    is(`${language} ${tomorrow ? "tomorrow" : "one hour"}: the subject ends with the title`, subject.endsWith(TITLE), true);
  }
  for (const kind of ["24", "1"] as const) {
    const words = eventMailWords({ handle: "kiln", name: "Kiln", language }, { name: "Kiln club" }, event, { kind, was: 0, wasMinutes: 0 } as Parameters<typeof eventMailWords>[3]);
    is(`${language} reminder ${kind}: no code in the email`, [/\$\{/.test(words.subject), /\$\{/.test(words.body), /\$\{/.test(words.why)], [false, false, false]);
  }
}

// The French words, exactly, with the no-break space French puts before a colon.
is("French one hour subject", communityWords("fr").evReminderSubject(false, TITLE), `Dans 1\u00a0heure\u00a0: ${TITLE}`);
is("French tomorrow subject, unchanged", communityWords("fr").evReminderSubject(true, TITLE), `Demain\u00a0: ${TITLE}`);

done();
