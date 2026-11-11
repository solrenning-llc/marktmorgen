/**
 * A poll's totals in the studio's "Sent and scheduled" (125
 * [F2-EMAIL-POLLS], unit 7c: components/email-poll-results.tsx).
 *
 * What fails here:
 *   - an answer from the server taken as totals when any part does not
 *     read, or when the counts do not add up to the votes (rule 24);
 *   - totals shown without each answer's words, or a share without its count;
 *   - "no answers yet" said of totals that could not be read;
 *   - a count drawn only as a bar (a picture with no words).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PollResultsView, readPollResultsAnswer } from "@/components/email-poll-results";
import { done, is, part } from "./check";

const poll = { question: "Which class next?", options: ["Glazing", "Trimming", "Firing"], days: 7 };
const closesAt = Date.UTC(2026, 10, 18, 12);
const good = { ok: true, state: "ok", counts: [1, 2, 1], votes: 4, open: true, closesAt };

part("The server's answer, read exactly");
is("whole totals", readPollResultsAnswer(good, 3), { kind: "totals", counts: [1, 2, 1], votes: 4, open: true, closesAt });
for (const [what, raw] of [
  ["counts that do not add up to the votes", { ...good, votes: 5 }],
  ["a count for an answer the poll does not have", { ...good, counts: [1, 2, 1, 0] }],
  ["a count that is not a whole number", { ...good, counts: [1, 2.5, 1], votes: 4.5 }],
  ["a negative count", { ...good, counts: [-1, 3, 2], votes: 4 }],
  ["no end", { ...good, closesAt: "soon" }],
  ["open that is not yes or no", { ...good, open: "yes" }],
  ["nothing", null],
] as [string, unknown][]) is(`unknown: ${what}`, readPollResultsAnswer(raw, 3), { kind: "unknown" });
is("the month spent: said with its own sentence", readPollResultsAnswer({ ok: false, error: "studio_used", message: "This needs 2 studio requests and 1 is left." }, 3), { kind: "used", message: "This needs 2 studio requests and 1 is left." });
// The mail route answers studio_used with its own sentence (notCounted), never a bare code (review, LOW).
is("the route's own words for a spent month are read as such", readPollResultsAnswer({ ok: false, error: "studio_used", message: "Your studio requests for this month are used up." }, 3).kind, "used");
is("no longer kept", readPollResultsAnswer({ ok: false, error: "poll_none" }, 3), { kind: "none" });
is("could not be read", readPollResultsAnswer({ ok: false, error: "poll_unknown" }, 3), { kind: "unknown" });

part("Drawn");
const html = renderToStaticMarkup(createElement(PollResultsView, { poll, result: { kind: "totals", counts: [1, 2, 1], votes: 4, open: true, closesAt } }));
is("the question", html.includes("Which class next?"), true);
is("each answer with its count and share in words", ["Glazing: 1 (25%)", "Trimming: 2 (50%)", "Firing: 1 (25%)"].every((line) => html.includes(line)), true);
is("the total, and that it is still open, with its end", /4 answers so far\. Open until November 18, 2026 \(UTC\)\./.test(html), true);
is("only totals, said", /never who answered what/.test(html), true);
is("a bar is decoration only", /<span[^>]*aria-hidden="true"[^>]*style="width:50%"/.test(html), true);
const none = renderToStaticMarkup(createElement(PollResultsView, { poll, result: { kind: "totals", counts: [0, 0, 0], votes: 0, open: false, closesAt } }));
is("no answers: said, with no division by zero", /No answers\. Closed on November 18, 2026 \(UTC\)\./.test(none) && !/NaN/.test(none), true);
const unknown = renderToStaticMarkup(createElement(PollResultsView, { poll, result: { kind: "unknown" } }));
is("unknown: never 'no answers'", /could not be read just now/.test(unknown) && !/No answers/.test(unknown), true);
is("the month spent: its sentence", renderToStaticMarkup(createElement(PollResultsView, { poll, result: { kind: "used", message: "This needs 2 studio requests." } })).includes("This needs 2 studio requests."), true);

done();
