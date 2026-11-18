/**
 * A quiz's answers kept in the student's own browser (297 [SQ8];
 * lib/quiz-keep-rules.ts, components/quiz-keep.tsx; added 12 November 2026).
 * The rules with synthetic drafts, and the real quiz drawn on the server:
 *
 *   - the draft holds every question of the try, answered or not, and only
 *     the quiz's own choices, never a hidden field;
 *   - it is put back only for exactly the same questions, when readable, not
 *     older than 7 days, not from the future and not empty;
 *   - putting it back sets each question it names and leaves the others;
 *   - the quiz offers the keeping only while the student may answer, never
 *     to the owner or a visitor, nor after passing or with no tries left;
 *   - every buyer language says it, and the privacy policy and the personal
 *     data register say where it is kept.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as keepRules from "@/lib/quiz-keep-rules";
import { QUIZ_KEEP_DAYS, checkedAfter, draftOf, draftToRestore, hasAnswers, quizKeepKey } from "@/lib/quiz-keep-rules";
import * as keepKey from "@/lib/quiz-keep-key";
import { deviceQuizKey } from "@/lib/quiz-keep-key";
import { devicePlaceKey } from "@/lib/lesson-position";
import { LessonQuiz } from "@/components/lesson-quiz";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { PERSON_DATA } from "@/lib/person-data";
import type { Quiz } from "@/lib/quiz";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 12, 12);
const shown = "aaaaaaaaaaa1,aaaaaaaaaaa2";
const inputs = [
  { name: "q_aaaaaaaaaaa1", value: "0", checked: false },
  { name: "q_aaaaaaaaaaa1", value: "1", checked: true },
  { name: "q_aaaaaaaaaaa2", value: "0", checked: false },
  { name: "q_aaaaaaaaaaa2", value: "1", checked: false },
  { name: "handle", value: "store", checked: false },
  { name: "q_aaaaaaaaaaa2", value: "x", checked: true },
];

part("What is kept");
{
  const draft = draftOf(inputs, shown, 0, NOW);
  is("every question of the try, answered or not; never a hidden field or a value that is not a choice", draft, { at: NOW, shown, tries: 0, version: "", answers: { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [] } });
  is("worth keeping only with an answer", [hasAnswers(draft), hasAnswers(draftOf(inputs.map((i) => ({ ...i, checked: false })), shown, 0, NOW))], [true, false]);
  is("kept per store, course, lesson and student", quizKeepKey("shop", "prod", "lesson", "abc"), "mm:quiz:shop:prod:lesson:abc");
}

part("When it is put back");
{
  const kept = JSON.stringify(draftOf(inputs, shown, 0, NOW - 3_600_000));
  is("the same questions, an hour later", draftToRestore(kept, shown, 0, NOW)?.answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [] });
  is("other questions (a bank drew again): never", draftToRestore(kept, "aaaaaaaaaaa3,aaaaaaaaaaa2", 0, NOW), null);
  const old = JSON.stringify({ ...draftOf(inputs, shown, 0, 0), at: NOW - (QUIZ_KEEP_DAYS * 86_400_000 + 1) });
  is(`older than ${QUIZ_KEEP_DAYS} days: never`, draftToRestore(old, shown, 0, NOW), null);
  is("from the future: never", draftToRestore(JSON.stringify({ ...JSON.parse(kept), at: NOW + 60_000 }), shown, 0, NOW), null);
  is("unreadable, empty or not a draft: never", [draftToRestore("{", shown, 0, NOW), draftToRestore(null, shown, 0, NOW), draftToRestore("[]", shown, 0, NOW), draftToRestore(JSON.stringify({ at: NOW, shown, tries: 0, answers: { q_aaaaaaaaaaa1: [] } }), shown, 0, NOW)], [null, null, null, null]);
  is("a choice that is not a small whole number: the whole draft is refused", draftToRestore(JSON.stringify({ at: NOW, shown, tries: 0, answers: { q_aaaaaaaaaaa1: [1.5] } }), shown, 0, NOW), null);
  is("a send that was refused or never arrived (no try recorded): still put back", draftToRestore(kept, shown, 0, NOW) !== null, true);
  is("a try recorded since (the server's count went up): never, it was sent and counted", draftToRestore(kept, shown, 1, NOW), null);
  is("a draft from before this rule, with no count: never", draftToRestore(JSON.stringify({ ...JSON.parse(kept), tries: undefined }), shown, 0, NOW), null);
  is("a field that is not a question: refused", draftToRestore(JSON.stringify({ at: NOW, shown, tries: 0, answers: { handle: [1] } }), shown, 0, NOW), null);
}

part("One student's draft is never another's (review of #4324)");
{
  const keyBefore = process.env.NIMBUS_DATA_KEY;
  process.env.NIMBUS_DATA_KEY = "k".repeat(64);
  try {
    const ada = deviceQuizKey("course1", "ada@example.com"), bo = deviceQuizKey("course1", "bo@example.com");
    is("a code per student, made on the server, the same each visit", [Boolean(ada && /^[0-9a-f]{32}$/.test(ada)), ada === deviceQuizKey("course1", " ADA@example.com "), ada !== bo], [true, true, true]);
    is("so the two students' drafts live under different keys", quizKeepKey("shop", "prod", "lesson", ada ?? "") !== quizKeepKey("shop", "prod", "lesson", bo ?? ""), true);
    is("never the address, nor the video place's code", [ada?.includes("ada"), ada === devicePlaceKey("course1", "ada@example.com"), ada === deviceQuizKey("course2", "ada@example.com")], [false, false, false]);
  } finally {
    if (keyBefore === undefined) delete process.env.NIMBUS_DATA_KEY;
    else process.env.NIMBUS_DATA_KEY = keyBefore;
  }
  const stripeBefore = process.env.STRIPE_SECRET_KEY;
  const dataBefore = process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.NIMBUS_DATA_KEY;
  is("no server key: no code, so nothing is kept", deviceQuizKey("course1", "ada@example.com"), null);
  if (stripeBefore !== undefined) process.env.STRIPE_SECRET_KEY = stripeBefore;
  if (dataBefore !== undefined) process.env.NIMBUS_DATA_KEY = dataBefore;
}

part("A quiz the creator changed never gets an old draft (review of #4324, LOW 3)");
{
  // The draft keeps a choice by its place (value={ci}); a reordered choice would get another one's mark. The server's
  // code for the quiz's words and choices (quizVersion) is kept with it, and a draft for another code is never put back.
  const v1 = JSON.stringify(keepRules.draftOf(inputs, shown, 0, NOW - 60_000, "v1"));
  type Restore = (raw: string | null, shown: string, tries: number, now: number, version: string) => keepRules.QuizDraft | null;
  const restore = keepRules.draftToRestore as unknown as Restore;
  is("the same quiz: put back", restore(v1, shown, 0, NOW, "v1")?.answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [] });
  is("the quiz changed since: never", restore(v1, shown, 0, NOW, "v2"), null);
  is("a draft kept before the code: never", restore(JSON.stringify({ ...JSON.parse(v1), version: undefined }), shown, 0, NOW, "v1"), null);
  const version = (keepKey as unknown as Record<string, unknown>).quizVersion as ((questions: Quiz["questions"]) => string) | undefined;
  const q = (id: string, text: string, choices: string[], correct = [0]) => ({ id, text, kind: "single" as const, choices, correct, explanation: "" });
  const base = [q("aaaaaaaaaaa1", "One?", ["A", "B"]), q("aaaaaaaaaaa2", "Two?", ["C", "D"])];
  is("the server makes the code", typeof version, "function");
  if (version) {
    is("the same words and choices: the same code", version(base), version(base.map((x) => ({ ...x }))));
    is("choices reordered: another code", version(base) === version([q("aaaaaaaaaaa1", "One?", ["B", "A"]), base[1]]), false);
    is("a question's words changed: another code", version(base) === version([q("aaaaaaaaaaa1", "One, really?", ["A", "B"]), base[1]]), false);
    is("the questions in another order (a shuffled try): the same code, since each answer is kept by its question", version(base), version([base[1], base[0]]));
    is("which choice is right is never in it", version(base), version([q("aaaaaaaaaaa1", "One?", ["A", "B"], [1]), base[1]]));
  }
  const quizView = readFileSync("components/lesson-quiz.tsx", "utf8");
  const keeper = readFileSync("components/quiz-keep.tsx", "utf8");
  is("the lesson hands the code to the keeping", /version=\{quizVersion\(quiz\.questions\)\}/.test(quizView), true);
  is("which keeps it and checks it", /draftOf\(snapshot\(\), shown, tries, Date\.now\(\), version\)/.test(keeper) && /draftToRestore\(raw, shown, tries, Date\.now\(\), version\)/.test(keeper), true);
}

part("Putting it back");
{
  const draft = { at: NOW, shown, tries: 0, version: "", answers: { q_aaaaaaaaaaa1: [0], q_aaaaaaaaaaa2: [] } };
  is("each named question as the draft says", inputs.slice(0, 4).map((i) => checkedAfter(i, draft)), [true, false, false, false]);
  is("a question the draft does not name keeps its state", checkedAfter({ name: "q_bbbbbbbbbbb1", value: "0", checked: true }, draft), true);
}

part("Offered only while the student may answer");
{
  const quiz: Quiz = {
    questions: [
      { id: "aaaaaaaaaaa1", text: "One?", kind: "single", choices: ["A", "B"], correct: [1], explanation: "" },
      { id: "aaaaaaaaaaa2", text: "Two?", kind: "multiple", choices: ["C", "D"], correct: [0, 1], explanation: "" },
    ],
    passPercent: 50,
    attempts: 3,
  } as unknown as Quiz;
  const draw = (mode: "student" | "owner" | "visitor", attempt: unknown = null) =>
    renderToStaticMarkup(createElement(LessonQuiz, { quiz, attempt: attempt as never, mode, action: "/api/store/course/quiz", hidden: { handle: "shop", product: "prod", lesson: "lessonaaaaa1" }, storeName: "Shop", justMarked: false, keeper }));
  let keeper: string | null = "c".repeat(32);
  is("a student who may answer", draw("student").includes("data-quiz-keep"), true);
  keeper = null;
  is("without the server's code for the student, nothing is kept", draw("student").includes("data-quiz-keep"), false);
  keeper = "c".repeat(32);
  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  is("the lesson page makes the code for the signed-in student only, and hands it to the quiz", [/const quizKeeper = student \? deviceQuizKey\(course\.id, student\.email\) : null;/.test(page), /keeper=\{quizKeeper\}/.test(page)], [true, true]);
  is("pressing the quiz's button forgets nothing: only a recorded try does", /addEventListener\("submit"/.test(readFileSync("components/quiz-keep.tsx", "utf8")), false);
  is("the owner, a visitor: no", [draw("owner").includes("data-quiz-keep"), draw("visitor").includes("data-quiz-keep")], [false, false]);
  is("before scripts run it draws nothing visible: the quiz is the plain form it was", /<span class="block" data-quiz-keep="true"><\/span>/.test(draw("student")), true);
}

part("Old or unreadable drafts go whenever a lesson or the library opens, and all of them at sign-out (review of #4324, MEDIUM 1)");
{
  // A synthetic browser storage: what localStorage offers the sweep (length, key, getItem, removeItem).
  const storageOf = (entries: [string, string][]) => {
    const kept = new Map(entries);
    return { kept, storage: { get length() { return kept.size; }, key: (i: number) => [...kept.keys()][i] ?? null, getItem: (k: string) => kept.get(k) ?? null, removeItem: (k: string) => void kept.delete(k) } };
  };
  const named = keepRules as unknown as Record<string, unknown>;
  const sweep = named.sweepQuizDrafts as ((storage: unknown, now: number) => number) | undefined;
  const forgetAll = named.forgetAllQuizDrafts as ((storage: unknown) => number) | undefined;
  const fresh = JSON.stringify(draftOf(inputs, shown, 0, NOW - 60_000));
  const stale = JSON.stringify(draftOf(inputs, shown, 0, NOW - (QUIZ_KEEP_DAYS * 86_400_000 + 1)));
  const future = JSON.stringify(draftOf(inputs, shown, 0, NOW + 86_400_000));
  const { kept, storage } = storageOf([
    ["mm:quiz:shop:prod:one:" + "a".repeat(32), fresh],
    ["mm:quiz:shop:prod:two:" + "a".repeat(32), stale],
    ["mm:quiz:gone:prod:one:" + "b".repeat(32), "not json"],
    ["mm:quiz:shop:prod:three:" + "c".repeat(32), future],
    ["mm:quiz:shop:prod:four:" + "c".repeat(32), "[1,2]"],
    ["mm:place:other", "kept"],
  ]);
  is("the sweep exists", typeof sweep, "function");
  if (sweep) {
    is("removes the four old, unreadable or impossible drafts", sweep(storage, NOW), 4);
    is("and keeps the fresh draft and what is not a quiz draft", [...kept.keys()], ["mm:quiz:shop:prod:one:" + "a".repeat(32), "mm:place:other"]);
  }
  is("signing out removes them all", typeof forgetAll === "function" ? [forgetAll(storage), [...kept.keys()]] : null, [1, ["mm:place:other"]]);
  const lesson = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  const library = readFileSync("app/library/page.tsx", "utf8");
  const signin = readFileSync("app/signin/page.tsx", "utf8");
  is("every lesson and the library sweep, for anyone who opens them", [/<QuizSweep \/>/.test(lesson), /<QuizSweep \/>/.test(library)], [true, true]);
  is("the page signing out ends on removes every draft", /status\.startsWith\("out"\) \? <ForgetQuizDrafts \/>/.test(signin), true);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the privacy policy says when they are removed", /id="quiz-drafts"[\s\S]{0,2400}Each time a lesson or the library opens in that browser[\s\S]{0,300}signing out removes them all/.test(privacy), true);
  is("and the register too", PERSON_DATA.some((r) => r.file === "lib/quiz-keep-rules.ts" && /a lesson or the library opens/.test(r.what) && /sign out/.test(r.what)), true);
}

part("The key in the browser says nothing about the course (review of #4324, MEDIUM 6)");
{
  // On a shared computer, and to any third-party pixel on the store's own origin (components/store-pixels.tsx), a key
  // naming the store, the product and the lesson told who took which course. The key is now only the prefix and the
  // server's code for the course, the lesson and the student (deviceQuizKey), and a key in the old shape is removed.
  const keyBefore = process.env.NIMBUS_DATA_KEY;
  process.env.NIMBUS_DATA_KEY = "k".repeat(64);
  try {
    const code = keepKey.deviceQuizKey as unknown as (course: string, lesson: string, email: string) => string | null;
    const keyOf = keepRules.quizKeepKey as unknown as (who: string) => string;
    const one = code("course1", "lesson1", "ada@example.com");
    is("a code per course, lesson and student", [Boolean(one && /^[0-9a-f]{32}$/.test(one)), one !== code("course1", "lesson2", "ada@example.com"), one !== code("course2", "lesson1", "ada@example.com"), one !== code("course1", "lesson1", "bo@example.com"), one === code("course1", "lesson1", " ADA@example.com ")], [true, true, true, true, true]);
    is("the key is the prefix and that code, nothing else", /^mm:quiz:[0-9a-f]{32}$/.test(keyOf(one ?? "")) && keyOf(one ?? "") === `mm:quiz:${one}`, true);
  } finally {
    if (keyBefore === undefined) delete process.env.NIMBUS_DATA_KEY;
    else process.env.NIMBUS_DATA_KEY = keyBefore;
  }
  const kept = new Map<string, string>([
    ["mm:quiz:shop:prod:lesson1:" + "a".repeat(32), JSON.stringify(draftOf(inputs, shown, 0, NOW - 60_000))],
    ["mm:quiz:" + "b".repeat(32), JSON.stringify(draftOf(inputs, shown, 0, NOW - 60_000))],
  ]);
  const storage = { get length() { return kept.size; }, key: (i: number) => [...kept.keys()][i] ?? null, getItem: (k: string) => kept.get(k) ?? null, removeItem: (k: string) => void kept.delete(k) };
  keepRules.sweepQuizDrafts(storage, NOW);
  is("the sweep removes a key in the old, readable shape, however fresh, and keeps an opaque one", [...kept.keys()], ["mm:quiz:" + "b".repeat(32)]);
  const lessonPage = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  is("the lesson page makes the code from the course, the lesson and the student", /deviceQuizKey\(course\.id, lesson\.id, student\.email\)/.test(lessonPage), true);
  const policy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the privacy policy no longer says the key names the store, the course and the lesson", /followed by the store, the course, the lesson/.test(policy), false);
}

part("Said in every language, and in the privacy policy");
{
  const keys = ["quizKeptBack", "quizKeptClear", "quizKeptCleared"] as const;
  for (const [lang, w] of Object.entries(COURSES_WORDS)) {
    is(`${lang}: three phrases`, keys.every((k) => typeof w[k] === "string" && w[k].length > 3), true);
    if (lang !== "en") is(`${lang}: not left in English`, keys.filter((k) => w[k] === COURSES_WORDS.en[k]), []);
  }
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  // Review of #4324 (MEDIUM 2): a shared or school computer may hold a child's choices, so a draft is kept 7 days at
  // most, enough for a reload, a dropped connection or leaving the page, and the words say 7.
  is("a draft is kept 7 days at the most", QUIZ_KEEP_DAYS, 7);
  is("the privacy policy names the key and when it goes", /id="quiz-drafts"[\s\S]{0,1400}<code>mm:quiz:<\/code>[\s\S]{0,900}7\s+days/.test(privacy) && !/id="quiz-drafts"[\s\S]{0,2600}30\s+days/.test(privacy), true);
  is("and the register says the same days", PERSON_DATA.some((r) => r.file === "lib/quiz-keep-rules.ts" && r.what.includes("older than 7 days")), true);
  is("and says the button the student presses", privacy.includes("&quot;Clear my answers&quot;") && COURSES_WORDS.en.quizKeptClear === "Clear my answers", true);
  is("the personal data register says it is never ours", PERSON_DATA.some((r) => r.file === "lib/quiz-keep-rules.ts" && r.how === "none" && r.what.includes("#quiz-drafts")), true);
}

done();
