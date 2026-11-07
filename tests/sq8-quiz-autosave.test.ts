/**
 * 297 [SQ8] unit 1: a quiz's answers are kept while the student picks them,
 * in the student's own browser only, so leaving the page, closing the
 * browser or losing the connection loses nothing. They come back on return,
 * with a sentence saying so and a button to clear them. They are dropped once
 * the try is marked, when the questions changed, when the quiz is shut, and
 * after 30 days. Nothing is sent to the server for it and no supplier is
 * called, so it costs nothing per student. They are kept under a short mark
 * of the signed-in student, so another student on the same browser never
 * gets them back, and opening a quiz removes what was kept for anyone else.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_KEPT_PICKS,
  QUIZ_KEEP_DAYS,
  keptQuizAnswers,
  onQuizLoad,
  othersKept,
  parseQuizKept,
  pickedIn,
  quizFit,
  quizKeepKey,
  quizKeeperShows,
  quizStudentMark,
  sentKept,
} from "@/lib/quiz-autosave";
import { LessonQuiz } from "@/components/lesson-quiz";
import { COURSES_WORDS, coursesWords } from "@/lib/buyer-words/courses";
import type { Quiz } from "@/lib/quiz";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const NOW = 1_790_000_000_000;
const q = (id: string, kind: "single" | "multiple" = "single", choices = ["A", "B", "C"]) => ({ id, text: `Question ${id}`, kind, choices, correct: [0], explanation: "" });
const quiz: Quiz = { passPercent: 80, attempts: 3, questions: [q("aaaaaaaa"), q("bbbbbbbb", "multiple")] } as Quiz;
const fit = quizFit(quiz.questions);

part("Where they are kept");
// What the lesson's page already has for a signed-in student (lib/learn.ts emailKey): synthetic here.
const ANA = "a".repeat(32);
const BEN = "b".repeat(32);
const MARK = quizStudentMark(ANA);
is("under the student's mark, the store, the course and the lesson", quizKeepKey(MARK, "shop", "prod01", "less01"), `mm-quiz:${MARK}:shop:prod01:less01`);
is("the student's mark is short and says nothing of who they are", /^[0-9a-f]{8}$/.test(MARK) && !ANA.includes(MARK), true);
is("the same student, the same mark", quizStudentMark(ANA), MARK);
is("another student, another mark", quizStudentMark(BEN) === MARK, false);
is(`kept ${QUIZ_KEEP_DAYS} days at most`, QUIZ_KEEP_DAYS, 30);

part("What is kept: only the picks, never a hidden field");
is(
  "q_ fields with a choice's position; handle, product, lesson and shown are left out",
  keptQuizAnswers([["handle", "shop"], ["product", "p"], ["lesson", "l"], ["shown", "aaaaaaaa,bbbbbbbb"], ["q_aaaaaaaa", "1"], ["q_bbbbbbbb", "0"], ["q_bbbbbbbb", "2"]]),
  [["q_aaaaaaaa", "1"], ["q_bbbbbbbb", "0"], ["q_bbbbbbbb", "2"]],
);
is("a value that is not a choice's position is never kept", keptQuizAnswers([["q_aaaaaaaa", "hello"], ["q_aaaaaaaa", "-1"], ["q_aaaaaaaa", "1e3"], ["q_aaaaaaaa", ""]]), []);
is("a name that is not a question's is never kept", keptQuizAnswers([["q_", "1"], ["q_a b", "1"], ["q_<x>", "1"], ["qx_aaaaaaaa", "1"]]), []);
is("at most MAX_KEPT_PICKS picks", keptQuizAnswers(Array.from({ length: MAX_KEPT_PICKS + 50 }, (_, i) => [`q_q${i}`, "0"] as [string, string])).length, MAX_KEPT_PICKS);

part("The questions' fingerprint");
is("the same questions give the same fingerprint", quizFit(quiz.questions), fit);
is("a changed choice changes it", quizFit([q("aaaaaaaa"), q("bbbbbbbb", "multiple", ["A", "B", "D"])]) === fit, false);
is("a changed kind changes it", quizFit([q("aaaaaaaa"), q("bbbbbbbb")]) === fit, false);
is("another try's order changes it", quizFit([q("bbbbbbbb", "multiple"), q("aaaaaaaa")]) === fit, false);
is("another try's draw changes it", quizFit([q("aaaaaaaa")]) === fit, false);
is("short and plain", /^[0-9]+-[0-9a-f]{8}$/.test(fit), true);

part("Reading back what this browser kept");
const kept = (over: Record<string, unknown> = {}) => JSON.stringify({ at: NOW - 1_000, fit, answers: [["q_aaaaaaaa", "1"]], ...over });
is("fresh: read back", parseQuizKept(kept(), NOW)?.answers, [["q_aaaaaaaa", "1"]]);
is("nothing kept: nothing", parseQuizKept(null, NOW), null);
is("unreadable: nothing", parseQuizKept("{not json", NOW), null);
is("not an object: nothing", parseQuizKept("[1,2]", NOW), null);
is(`older than ${QUIZ_KEEP_DAYS} days: nothing`, parseQuizKept(kept({ at: NOW - QUIZ_KEEP_DAYS * DAY - 1 }), NOW), null);
is("from the future: nothing", parseQuizKept(kept({ at: NOW + DAY }), NOW), null);
is("a pick that is not a pick: nothing", parseQuizKept(kept({ answers: [["q_aaaaaaaa", "x"]] }), NOW), null);
is("answers that are not a list: nothing", parseQuizKept(kept({ answers: { q_aaaaaaaa: "1" } }), NOW), null);
is("a fingerprint that is not one: nothing", parseQuizKept(kept({ fit: 7 }), NOW), null);
is("a sent mark that is not a time: nothing", parseQuizKept(kept({ sent: "yes" }), NOW), null);
is("a key named like an object's own field is only data", parseQuizKept(kept({ answers: [["q___proto__", "1"]] }), NOW)?.answers, [["q___proto__", "1"]]);

part("What happens when the page opens");
const at = { fit, open: true, marked: false, now: NOW };
is("nothing kept: nothing to do", onQuizLoad(null, at), { kind: "none" });
is("kept for these questions: put back", onQuizLoad(kept(), at), { kind: "restore", answers: [["q_aaaaaaaa", "1"]], resave: null });
is("the questions changed since: forgotten", onQuizLoad(kept({ fit: "2-00000000" }), at), { kind: "forget" });
is("unreadable: forgotten", onQuizLoad("{not json", at), { kind: "forget" });
is("too old: forgotten", onQuizLoad(kept({ at: NOW - 31 * DAY }), at), { kind: "forget" });
is("the quiz is shut (passed, out of tries or waiting): forgotten", onQuizLoad(kept(), { ...at, open: false }), { kind: "forget" });
is("nothing picked: forgotten", onQuizLoad(kept({ answers: [] }), at), { kind: "forget" });
is("sent, and the page says the try was marked: forgotten", onQuizLoad(kept({ sent: NOW - 500 }), { ...at, marked: true }), { kind: "forget" });
is(
  "picked again after the try was marked (no sent mark): put back, even on the marked page",
  onQuizLoad(kept(), { ...at, marked: true }),
  { kind: "restore", answers: [["q_aaaaaaaa", "1"]], resave: null },
);
is(
  "sent, but the page never said it was marked (the connection dropped): put back, and the sent mark is taken off",
  onQuizLoad(kept({ sent: NOW - 500 }), at),
  { kind: "restore", answers: [["q_aaaaaaaa", "1"]], resave: { at: NOW - 1_000, fit, answers: [["q_aaaaaaaa", "1"]] } },
);
is("pressing the button marks what was kept as sent, without forgetting it", sentKept(kept(), NOW), { at: NOW - 1_000, fit, answers: [["q_aaaaaaaa", "1"]], sent: NOW });
is("…nothing kept, nothing to mark", sentKept(null, NOW), null);

part("Another student on the same browser");
const BEN_MARK = quizStudentMark(BEN);
const anaKey = quizKeepKey(MARK, "shop", "prod01", "less01");
const benKey = quizKeepKey(BEN_MARK, "shop", "prod01", "less01");
is("the same lesson is kept apart for each student, so Ben never gets Ana's picks back", anaKey === benKey, false);
is(
  "as Ben opens a quiz, everything kept for anyone else is to be removed, and nothing that is not a quiz's",
  othersKept([anaKey, quizKeepKey(MARK, "shop", "prod01", "less02"), benKey, quizKeepKey(BEN_MARK, "other", "p", "l"), "mm-quiz:shop:prod01:less01", "mm-form:shop", "theme"], BEN_MARK),
  [anaKey, quizKeepKey(MARK, "shop", "prod01", "less02"), "mm-quiz:shop:prod01:less01"],
);
is("…and Ben's own picks for other lessons stay", othersKept([benKey, quizKeepKey(BEN_MARK, "other", "p", "l")], BEN_MARK), []);

part("Putting the picks back exactly");
const picks: [string, string][] = [["q_aaaaaaaa", "1"], ["q_bbbbbbbb", "0"], ["q_bbbbbbbb", "2"]];
is("a kept pick is checked", pickedIn(picks, "q_bbbbbbbb", "2"), true);
is("a choice not kept is cleared, even if the last try had it", pickedIn(picks, "q_bbbbbbbb", "1"), false);
is("a question with nothing kept stays empty", pickedIn(picks, "q_cccccccc", "0"), false);

part("Said in every language of the store");
const keys = ["quizKeepNote", "quizKeepBack", "quizKeepClear", "quizKeepCleared"] as const;
const en = coursesWords("en");
is("English says where they stay, and where a result is if they were checked", [en.quizKeepNote, en.quizKeepBack, en.quizKeepClear, en.quizKeepCleared], [
  "Your answers are saved in this browser as you pick them, so you can leave and finish later.",
  "We put back the answers you picked here before. If you already checked them, your result is shown in this quiz.",
  "Clear these answers",
  "Your saved answers are cleared.",
]);
// Picks sent and marked, with the answer lost on the way back, come back too: never say nothing was checked.
const neverSaid: Record<string, string> = {
  en: "Nothing has been checked yet",
  es: "Todavía no se ha comprobado nada",
  fr: "Rien n'a encore été vérifié",
  de: "Es wurde noch nichts geprüft",
  it: "Non è stato ancora controllato nulla",
  nl: "Er is nog niets gecontroleerd",
  pt: "Ainda nada foi verificado",
};
for (const [lang, words] of Object.entries(COURSES_WORDS)) {
  is(`${lang}: never says nothing was checked`, Boolean(neverSaid[lang]) && !words.quizKeepBack.includes(neverSaid[lang]), true);
  if (lang === "en") continue;
  is(`${lang}: every sentence is its own`, keys.every((k) => typeof words[k] === "string" && words[k].length > 5 && words[k] !== en[k]), true);
}

part("What the keeper shows");
is("while saving: the note, no line, no button", quizKeeperShows("saving"), { note: true, line: null, clear: false });
is("after putting picks back: the note, the line, the button to clear", quizKeeperShows("back"), { note: true, line: "quizKeepBack", clear: true });
is("after Clear: the note stays, since new picks are still saved as they are made", quizKeeperShows("cleared"), { note: true, line: "quizKeepCleared", clear: false });

part("On the lesson's page");
const page = (props: Partial<Parameters<typeof LessonQuiz>[0]>) =>
  renderToStaticMarkup(
    createElement(LessonQuiz, {
      quiz,
      attempt: null,
      mode: "student",
      action: "/api/store/course/quiz",
      hidden: { handle: "shop", product: "prod01", lesson: "less01" },
      storeName: "Shop",
      justMarked: false,
      student: ANA,
      ...props,
    }),
  );
const student = page({});
is("a student's form carries the keeper, named for this student and lesson", student.includes(`data-quiz-keep="${anaKey}"`), true);
is("…another student's, under their own mark", page({ student: BEN }).includes(`data-quiz-keep="${benKey}"`), true);
is("the student's own key never reaches the page, only its short mark", student.includes(ANA), false);
is("without a signed-in student nothing is kept", page({ student: undefined }).includes("data-quiz-keep"), false);
is(
  "the live line is in the page from the start, empty, so what is put in it later is announced",
  /data-quiz-keep="[^"]+"[^>]*><span[^>]*role="status"[^>]*><\/span>/.test(student),
  true,
);
is("…with the questions' fingerprint", student.includes(`data-quiz-fit="${fit}"`), true);
is("the server draws no sentence: it shows only once the page runs scripts and the browser can keep them", student.includes(en.quizKeepNote) || student.includes(en.quizKeepBack), false);
is("the creator's own view keeps nothing", page({ mode: "owner" }).includes("data-quiz-keep"), false);
is("a visitor's view keeps nothing", page({ mode: "visitor" }).includes("data-quiz-keep"), false);
is("without the lesson's names nothing is kept", page({ hidden: { lesson: "less01" } }).includes("data-quiz-keep"), false);
const passed = page({ attempt: { used: 1, last: null, best: 100, passed: true } as never });
is("a passed quiz still carries the keeper, so it can forget", passed.includes('data-quiz-open="no"'), true);
is("an open quiz says so", student.includes('data-quiz-open="yes"'), true);
is("the page tells the keeper when the try was just marked", page({ justMarked: true }).includes('data-quiz-marked="yes"'), true);

part("Nothing leaves the browser for it");
const source = readFileSync("components/quiz-autosave.tsx", "utf8");
is("a client component", source.startsWith('"use client";'), true);
is("nothing is fetched or sent for it", /fetch\(|sendBeacon|XMLHttpRequest|WebSocket/.test(source), false);
const uses = source.match(/localStorage\.\w+\(/g) ?? [];
const guarded = source.match(/try \{\s*(?:return )?window\.localStorage\.\w+\(/g) ?? [];
is("every use of the browser's storage is the first thing in its own try (a private window throws)", uses.length > 0 && uses.length === guarded.length, true);
is("as a quiz opens it removes what was kept for any other student", source.includes("othersKept(") && source.includes("quizKeeperShows("), true);
is("it keeps on every pick and marks on sending", source.includes('addEventListener("change"') && source.includes('addEventListener("submit"'), true);
is("its sentences are announced politely, never by moving the page", source.includes('role="status"') && !/scrollIntoView|location\.(assign|replace|href)/.test(source), true);
const lib = readFileSync("lib/quiz-autosave.ts", "utf8");
is("the rules hold no state of their own and touch no storage", /localStorage|window\.|document\./.test(lib), false);

part("The privacy policy says so");
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
is("it names the key, says it stays in the browser and when it goes", privacy.includes("mm-quiz:") && /never receive/.test(privacy) && /Clear these answers/.test(privacy), true);
is("it says the key holds a mark of the student, never the address, and that another student's are removed", /short mark of the student, never their email address/.test(privacy) && /another student opens a quiz/.test(privacy), true);

done();
