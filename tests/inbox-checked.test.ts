/**
 * The inbox says when it last checked for new messages, and when it stopped
 * checking by itself (484 [IT1], complement item 5; the owner's request of 30
 * October 2026, 18h04; components/inbox-studio.tsx). The list is still read
 * at most once a minute while the tab is in view, 30 times for one opening of
 * the page: nothing more is read. Checked:
 *
 *   - the words: "Checked for new messages at 6:03 PM.", in the creator's
 *     own clock; and once the automatic checks stop, the owner's sentence;
 *   - a check that did not answer says so and keeps the last time, never a
 *     newer one;
 *   - the first time said is when the server read the list; the time is shown
 *     after the browser has drawn the page, so the server's page and the
 *     browser's agree, and is never announced each minute: only a check
 *     someone asked for, a failure and the pause are read out, politely;
 *   - the reading itself is unchanged: once a minute, while in view, 30 at
 *     the most (read in the source).
 */
import { readFileSync } from "node:fs";
import { CHECK_FAILED_WORDS, INBOX_AUTO_CHECKS, INBOX_PAUSED_WORDS, checkedWords } from "@/components/inbox-studio";
import { done, is, part } from "./check";

part("The words");
const at = new Date(2026, 10, 2, 18, 3).getTime();
is("the time it last checked, in the creator's own clock", checkedWords(at), "Checked for new messages at 6:03 PM.");
is("and once the automatic checks stop, the owner's sentence", INBOX_PAUSED_WORDS, "Automatic checks paused after 30 minutes. Press Check for new messages or reload the page.");

part("How it behaves");
const studio = readFileSync("components/inbox-studio.tsx", "utf8");
const flat = studio.replace(/\s+/g, " ");
is(
  "the first time said is when the server read the list, not when the browser drew it",
  [flat.includes("useState<number>(readAt)"), readFileSync("app/studio/inbox/page.tsx", "utf8").replace(/\s+/g, " ").includes("readAt={readAt}")],
  [true, true],
);
is(
  "a check that answered moves the time; one that did not says so and keeps the last one",
  [flat.includes("setCheckedAt(at); setCheckFailed(false);"), flat.includes("setCheckFailed(true); setSaid(CHECK_FAILED_WORDS);"), CHECK_FAILED_WORDS],
  [true, true, "We could not check for new messages just now. Try again in a moment."],
);
is(
  "the time is there to read but never announced each minute; only a check someone asked for, a failure and the pause are read out, politely",
  [flat.includes('<p className="mt-2 px-1 text-sm text-ink-soft" data-inbox-checked="">'), flat.includes('<p className="sr-only" role="status" aria-live="polite">{said}</p>'), flat.includes("if (asked) setSaid(checkedWords(at));"), flat.includes("void refresh(false);"), flat.includes("onClick={() => void refresh(true)}")],
  [true, true, true, true, true],
);
is(
  "the reading is unchanged: once a minute, while in view, 30 times at the most; paused and said right after the last one",
  [INBOX_AUTO_CHECKS, flat.includes("}, 60_000);"), flat.includes('if (document.visibilityState !== "visible") return;'), flat.includes("asked += 1; void refresh(false); // Paused, and said, right after the last one: never a minute late. if (asked >= INBOX_AUTO_CHECKS) { window.clearInterval(timer); setPaused(true); setSaid(INBOX_PAUSED_WORDS); }")],
  [30, true, true, true],
);

done();
