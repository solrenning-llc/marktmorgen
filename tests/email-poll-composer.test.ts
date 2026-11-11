/**
 * The poll a creator adds to an email to the list (125 [F2-EMAIL-POLLS],
 * unit 7b: components/email-poll-composer.tsx, pollAsked).
 *
 * What fails here:
 *   - a field without its own label, or the answers without a named group;
 *   - a poll sent that the server would refuse (the same rules decide);
 *   - an add or remove button past the rules' bounds;
 *   - a draft said to keep the poll (it does not yet);
 *   - the creator not told how answers count and that only totals are seen.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PollComposer, emptyPoll, pollAsked } from "@/components/email-poll-composer";
import { MAX_POLL_DAYS, MAX_POLL_OPTIONS, POLL_DEFAULT_DAYS } from "@/lib/email-poll-rules";
import { done, is, part } from "./check";

const draw = (value: ReturnType<typeof emptyPoll>, on = true) =>
  renderToStaticMarkup(createElement(PollComposer, { on, value, onToggle: () => {}, onChange: () => {} }));

part("Off: one checkbox, nothing else");
const off = draw(emptyPoll(), false);
is("a labeled checkbox", /<label[^>]*><input(?=[^>]*type="checkbox")[^>]*\/>Add a poll<\/label>/.test(off), true);
is("no fields", /<input(?=[^>]*type="text")/.test(off), false);

part("On: every field labeled");
const filled = { question: "Which class next?", options: ["Glazing", "Trimming", "Firing"], days: 7 };
const on = draw(filled);
is("the question labeled", /<label[^>]*><span[^>]*>Question<\/span><input/.test(on), true);
is("the answers in a named group", /<fieldset[^>]*><legend[^>]*>Answers<\/legend>/.test(on), true);
is("each answer labeled by its number", [1, 2, 3].every((i) => on.includes(`>Answer ${i}</span>`)), true);
is("how long, labeled", /<span[^>]*>Open for<\/span><select/.test(on), true);
is("days up to the rules' most", (on.match(/<option /g) ?? []).length, MAX_POLL_DAYS);
is("says how answers count", /counted only when they press Confirm/.test(on), true);
is("says only totals are seen", /only the totals, never who answered what/.test(on), true);
is("says a draft does not keep it", /Drafts do not keep the poll/.test(on), true);
is("a remove button for each answer past two", (on.match(/>Remove answer \d<\/button>/g) ?? []).length, 3);
is("an add button below the most", /Add an answer<\/button>/.test(on), true);
const full = draw({ ...filled, options: Array.from({ length: MAX_POLL_OPTIONS }, (_, i) => `A${i}`) });
is("no add button at the most", /Add an answer/.test(full), false);
const two = draw({ ...filled, options: ["A", "B"] });
is("remove buttons disabled at two answers", (two.match(/<button(?=[^>]*disabled="")[^>]*>Remove answer \d<\/button>/g) ?? []).length, 2);

part("What is sent: what the server reads, or nothing");
is("a new poll: the default days, two empty answers", emptyPoll(), { question: "", options: ["", ""], days: POLL_DEFAULT_DAYS });
is("off: no poll at all", pollAsked(false, filled), { ok: true, poll: undefined });
is("on and whole: the poll as the rules read it", pollAsked(true, { ...filled, question: "  Which  class next? " }), { ok: true, poll: { question: "Which class next?", options: ["Glazing", "Trimming", "Firing"], days: 7 } });
is("on with no question: not sendable, saying what", pollAsked(true, { ...filled, question: "" }), { ok: false, problem: "question" });
is("on with an empty answer: not sendable", pollAsked(true, { ...filled, options: ["Glazing", " "] }).ok, false);
const words = draw({ ...filled, question: "" });
is("the problem shown beside the field", /aria-invalid="true"/.test(words) && /Write the question/.test(words), true);

done();
