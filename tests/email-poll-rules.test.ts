/**
 * A poll answered by a click in an email (125 [F2-EMAIL-POLLS], unit 1:
 * lib/email-poll-rules.ts).
 *
 * What fails here:
 *   - a poll kept that is not a real question with 2 to 5 distinct answers;
 *   - a vote counted from opening a link (a mail scanner opens every link):
 *     only the press of the page's confirm button, a POST, counts;
 *   - a vote counted after the poll closed, for an answer it does not have,
 *     with a link that is not the recipient's, or with any of it unknown;
 *   - more than one vote per recipient, or a vote that cannot be taken back;
 *   - results that say who chose what, or a count that cannot be read taken
 *     as zero.
 */
import {
  MAX_POLL_OPTIONS,
  MAX_POLL_DAYS,
  MIN_POLL_OPTIONS,
  POLL_DEFAULT_DAYS,
  pollClosesAt,
  pollEmailLines,
  pollState,
  readPollInput,
  tallyPoll,
  voteStep,
} from "@/lib/email-poll-rules";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const SENT = Date.UTC(2026, 11, 1, 12);
const good = { question: "Which course should I make next?", options: ["Glazing basics", "Wheel throwing", "Kiln care"], days: 7 };

part("The poll");
is("2 to 5 answers", [MIN_POLL_OPTIONS, MAX_POLL_OPTIONS], [2, 5]);
is("a whole poll reads", readPollInput(good), { ok: true, poll: { question: "Which course should I make next?", options: ["Glazing basics", "Wheel throwing", "Kiln care"], days: 7 } });
is("spaces are tidied, the words are kept", readPollInput({ ...good, question: "  Which   one?  ", options: [" A ", "B"] }), { ok: true, poll: { question: "Which one?", options: ["A", "B"], days: 7 } });
is("no days: the default", readPollInput({ question: "Q?", options: ["A", "B"] }), { ok: true, poll: { question: "Q?", options: ["A", "B"], days: POLL_DEFAULT_DAYS } });
is("days as a form sends them", readPollInput({ ...good, days: "14" }), { ok: true, poll: { ...good, days: 14 } });
for (const [what, raw, problem] of [
  ["nothing", null, "question"],
  ["no question", { ...good, question: "  " }, "question"],
  ["a question too long", { ...good, question: "x".repeat(201) }, "question"],
  ["one answer", { ...good, options: ["Only"] }, "options"],
  ["six answers", { ...good, options: ["1", "2", "3", "4", "5", "6"] }, "options"],
  ["an empty answer", { ...good, options: ["A", " "] }, "options"],
  ["an answer too long", { ...good, options: ["A", "x".repeat(61)] }, "options"],
  ["the same answer twice", { ...good, options: ["Kiln care", "kiln  CARE"] }, "options"],
  ["answers that are not text", { ...good, options: ["A", 2] }, "options"],
  ["no days", { ...good, days: 0 }, "days"],
  ["too many days", { ...good, days: MAX_POLL_DAYS + 1 }, "days"],
  ["half a day", { ...good, days: 1.5 }, "days"],
] as [string, unknown, string][]) is(`refused: ${what}`, readPollInput(raw), { ok: false, problem });

part("Open and closed");
is("closes the given days after it was sent", pollClosesAt(SENT, 7), SENT + 7 * DAY);
is("an unknown sending time: no end", pollClosesAt(Number.NaN, 7), null);
is("open after sending", pollState(SENT, 7, SENT + DAY), "open");
is("closed at its end", pollState(SENT, 7, SENT + 7 * DAY), "closed");
is("not sent yet: not open", pollState(SENT, 7, SENT - 1), "unknown");
is("an unknown clock", pollState(SENT, 7, Number.NaN), "unknown");
is("days that do not read", pollState(SENT, 99, SENT + DAY), "unknown");

part("Opening a link never votes");
const ask = { poll: { question: "Q?", options: ["A", "B", "C"], days: 7 }, sentAt: SENT, now: SENT + DAY, recipient: "valid" as const };
is("a link opened (GET): the confirm page, nothing counted", voteStep({ ...ask, method: "GET", option: 1 }), { step: "confirm", option: 1 });
is("the confirm button (POST): counted", voteStep({ ...ask, method: "POST", option: 1 }), { step: "record", option: 1 });
is("taking it back (POST, no answer): counted as taken back", voteStep({ ...ask, method: "POST", option: null }), { step: "withdraw" });
is("HEAD, as a scanner may send: the confirm page, nothing counted", voteStep({ ...ask, method: "HEAD", option: 1 }).step, "confirm");
is("an answer the poll does not have", voteStep({ ...ask, method: "POST", option: 3 }), { step: "invalid" });
is("an answer that is not a number", voteStep({ ...ask, method: "POST", option: "1" as unknown as number }), { step: "invalid" });
is("a link that is not the recipient's", voteStep({ ...ask, method: "POST", option: 1, recipient: "invalid" }), { step: "invalid" });
is("a link that could not be checked", voteStep({ ...ask, method: "POST", option: 1, recipient: "unknown" }), { step: "unknown" });
is("after the end: closed, nothing counted", voteStep({ ...ask, method: "POST", option: 1, now: SENT + 7 * DAY }), { step: "closed" });
is("after the end, opened: closed", voteStep({ ...ask, method: "GET", option: 1, now: SENT + 7 * DAY }), { step: "closed" });
is("an unknown clock: nothing counted", voteStep({ ...ask, method: "POST", option: 1, now: Number.NaN }), { step: "unknown" });
is("another method: nothing counted", voteStep({ ...ask, method: "PUT", option: 1 }), { step: "invalid" });

part("The results");
is("totals only, one vote per recipient", tallyPoll(3, ["0", "2", "2"]), { known: true, counts: [1, 0, 2], votes: 3 });
is("no votes", tallyPoll(2, []), { known: true, counts: [0, 0], votes: 0 });
is("a vote for an answer the poll does not have: unknown, never left out", tallyPoll(2, ["0", "5"]), { known: false });
is("a vote that does not read: unknown", tallyPoll(2, ["0", "x"]), { known: false });
is("a list that could not be read: unknown, never zero", tallyPoll(2, null), { known: false });
is("results never name anyone", Object.keys(tallyPoll(2, ["1"]) as object).sort(), ["counts", "known", "votes"]);

part("In the email");
const lines = pollEmailLines(good, (i) => `https://marktmorgen.com/v/tok?o=${i}`, SENT);
is("the question first", lines[0], "Which course should I make next?");
is("each answer is its own link, its words the link's text", lines.slice(1, 4), [
  "Glazing basics: https://marktmorgen.com/v/tok?o=0",
  "Wheel throwing: https://marktmorgen.com/v/tok?o=1",
  "Kiln care: https://marktmorgen.com/v/tok?o=2",
]);
is("says opening a link is not a vote", lines.some((l) => /counted only when you press Confirm/.test(l)), true);
is("says when it closes", lines.some((l) => l.includes("December 8, 2026")), true);
is("says nobody sees who answered what", lines.some((l) => /only the totals/.test(l)), true);

done();
