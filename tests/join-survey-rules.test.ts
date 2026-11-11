/**
 * 421 [PT1], unit 1: the optional question right after a membership is
 * paid for, "What do you most hope to get from it?". Pure rules only
 * (lib/join-survey-rules.ts): the creator's setting (off until turned on,
 * ready choices, up to three of their own), a new version whenever the
 * choices change so results stay comparable and old answers keep their own
 * words, when it is asked (only after a confirmed payment, never as a step
 * in the way), and what is kept of an answer. The exit question already
 * exists (lib/leave-rules.ts) and is not touched.
 */
import {
  JOIN_HOPES,
  JOIN_NAMES,
  MAX_JOIN_COMMENT,
  MAX_OWN_HOPES,
  NO_JOIN_SURVEY,
  cleanJoinAnswer,
  editJoinSurvey,
  joinChoices,
  joinSurveyStep,
  parseJoinSurvey,
} from "@/lib/join-survey-rules";
import { done, is, part } from "./check";

const own = (n: number) => `own_${String(n).padStart(6, "0")}`;
const on = editJoinSurvey(NO_JOIN_SURVEY, { on: true });

part("Off for every store until its creator turns it on");
is("the default is off", NO_JOIN_SURVEY.on, false);
is("nothing kept reads as off, version 1, every ready choice", parseJoinSurvey(undefined), { on: false, version: 1, hopes: [...JOIN_HOPES], own: [] });
is("every ready choice has plain words", JOIN_HOPES.every((h) => JOIN_NAMES[h].length > 5), true);
is("\"Something else\" is always a choice", JOIN_HOPES.includes("other"), true);
is("turning it on does not start a new version", on, { ...NO_JOIN_SURVEY, on: true });
is("turning it off keeps the version", editJoinSurvey({ ...on, version: 4 }, { on: false }).version, 4);

part("What is kept is read strictly");
is("an unknown ready choice is dropped, \"Something else\" kept", parseJoinSurvey({ on: true, version: 2, hopes: ["learn", "bogus"] }).hopes, ["learn", "other"]);
is("ready choices keep the list's own order, each once", parseJoinSurvey({ hopes: ["community", "learn", "learn"] }).hopes, ["learn", "community", "other"]);
is("a version that is not a whole number from 1 reads as 1", [parseJoinSurvey({ version: 0 }).version, parseJoinSurvey({ version: 2.5 }).version, parseJoinSurvey({ version: "3" }).version], [1, 1, 1]);
is("own choices: at most three, each with its id, words trimmed", parseJoinSurvey({ own: [1, 2, 3, 4].map((n) => ({ id: own(n), text: `  Choice   ${n} ` })) }).own, [1, 2, 3].map((n) => ({ id: own(n), text: `Choice ${n}` })));
is("an own choice with a bad id or no words is dropped", parseJoinSurvey({ own: [{ id: "x", text: "A" }, { id: own(1), text: "  " }] }).own, []);
is("the most own choices is 3", MAX_OWN_HOPES, 3);

part("Changing the choices starts a new version; old answers keep their words");
const v1 = editJoinSurvey(on, { own: [{ id: own(1), text: "Weekly calls" }] });
is("adding an own choice is version 2", v1.version, 2);
const renamed = editJoinSurvey(v1, { own: [{ id: own(1), text: "Live calls each week" }] });
is("renaming it is version 3, with the same id", [renamed.version, renamed.own[0].id], [3, own(1)]);
is("dropping a ready choice is a new version", editJoinSurvey(on, { hopes: ["learn"] }).version, 2);
is("saving the same choices again is not", editJoinSurvey(v1, { own: [{ id: own(1), text: " Weekly  calls " }] }).version, 2);
const old = cleanJoinAnswer(v1, { v: 2, choice: own(1), comment: "" });
is("an answer keeps the words of the version it was given under", old, { ok: true, answer: { v: 2, choice: own(1), label: "Weekly calls", comment: "" } });
is("an answer from a page opened before a change is not filed under the new words", cleanJoinAnswer(renamed, { v: 2, choice: own(1), comment: "" }), { ok: false, problem: "version" });

part("The choices, as the page shows them");
is("ready choices first, then the creator's, \"Something else\" last", joinChoices(v1).map((c) => c.id), ["learn", "results", "community", "access", "support", own(1), "other"]);
is("each with its words", joinChoices(v1).find((c) => c.id === own(1))?.label, "Weekly calls");

part("Asked only after a confirmed payment for a membership, and never in the way");
const ask = (over: Partial<Parameters<typeof joinSurveyStep>[0]> = {}) =>
  joinSurveyStep({ setting: on, kind: "subscription", paid: "confirmed", answered: false, ...over });
is("a confirmed membership, not answered yet: asked", ask(), "ask");
is("off: not asked", ask({ setting: NO_JOIN_SURVEY }), "skip");
is("a one-time product: not asked", ask({ kind: "one-time" }), "skip");
is("a payment not confirmed yet: not asked", ask({ paid: "pending" }), "skip");
is("a payment that cannot be read: not asked", ask({ paid: "unknown" }), "skip");
is("already answered: asked once only", ask({ answered: true }), "skip");
is("whether it was answered cannot be read: not asked again", ask({ answered: null }), "skip");
is("the step is only ever \"ask\" or \"skip\": nothing waits on it", ["ask", "skip"].includes(ask()), true);

part("What is kept of an answer");
is("a ready choice", cleanJoinAnswer(on, { v: 1, choice: "learn", comment: "" }), { ok: true, answer: { v: 1, choice: "learn", label: JOIN_NAMES.learn, comment: "" } });
is("\"Something else\" with a comment", cleanJoinAnswer(on, { v: 1, choice: "other", comment: "  To   start a podcast  " }), { ok: true, answer: { v: 1, choice: "other", label: JOIN_NAMES.other, comment: "To start a podcast" } });
is("a comment is cut to the limit", (cleanJoinAnswer(on, { v: 1, choice: "other", comment: "a".repeat(MAX_JOIN_COMMENT + 50) }) as { answer: { comment: string } }).answer.comment.length, MAX_JOIN_COMMENT);
is("links and email addresses are taken out of a comment", (cleanJoinAnswer(on, { v: 1, choice: "other", comment: "see https://spam.example/x or mail me@x.com please" }) as { answer: { comment: string } }).answer.comment, "see or mail please");
is("a comment that is not text is none", (cleanJoinAnswer(on, { v: 1, choice: "learn", comment: 5 }) as { answer: { comment: string } }).answer.comment, "");
is("a choice that is not offered", cleanJoinAnswer(on, { v: 1, choice: "bogus", comment: "" }), { ok: false, problem: "choice" });
is("a ready choice the creator dropped", cleanJoinAnswer(editJoinSurvey(on, { hopes: ["learn"] }), { v: 2, choice: "community", comment: "" }), { ok: false, problem: "choice" });
is("nothing is kept while it is off", cleanJoinAnswer(NO_JOIN_SURVEY, { v: 1, choice: "learn", comment: "" }), { ok: false, problem: "off" });
is("an answer carries no name, address or order: only the version, the choice, its words and the comment", Object.keys((cleanJoinAnswer(on, { v: 1, choice: "learn", comment: "" }) as { answer: object }).answer).sort(), ["choice", "comment", "label", "v"]);

done();
