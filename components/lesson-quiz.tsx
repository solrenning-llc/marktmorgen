import type { Attempt, Quiz } from "@/lib/quiz";
import { questionsPerTry, triesLeft } from "@/lib/quiz";
import { coursesWords } from "@/lib/buyer-words/courses";
import type { LanguageCode } from "@/lib/store-language";

/**
 * A lesson's quiz, as a student meets it: the questions to answer, and after
 * each try how it went. Plain form, no script: the answers are marked on the
 * server and the page comes back with the result.
 *
 * What is shown after a try follows lib/quiz.ts: which questions were right,
 * the explanations of those, and — once passed or out of tries — the right
 * answers and every explanation.
 *
 * With a question bank (630 [HN6](7)) `quiz` holds only the questions this
 * student's try draws, and a student who must wait between tries sees how
 * long, with the form shut, so the wait never shows the next questions.
 *
 * Said in the store's `language` (lib/buyer-words/courses.ts), English
 * unless given.
 */
export function LessonQuiz({
  quiz,
  attempt,
  mode,
  action,
  hidden,
  storeName,
  justMarked,
  waitSeconds = 0,
  stale = false,
  language = "en",
}: {
  quiz: Quiz;
  attempt: Attempt | null;
  /** "student" answers it; "owner" sees it with the answers; "visitor" is told it is there. */
  mode: "student" | "owner" | "visitor";
  action: string;
  hidden: Record<string, string>;
  storeName: string;
  /** Came straight back from marking a try: the result is announced. */
  justMarked: boolean;
  /** Seconds before this student may try again; 0 when they may now. */
  waitSeconds?: number;
  /** Came back because the questions sent were no longer this try's: nothing was counted. */
  stale?: boolean;
  language?: LanguageCode;
}) {
  const w = coursesWords(language);
  const total = questionsPerTry(quiz);
  const heading = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="quiz-title" className="font-display text-xl font-semibold">{w.quiz}</h2>
      <p className="st-muted text-sm">
        {[w.questions(total), w.passMark(quiz.passPercent), quiz.attempts ? w.tries(quiz.attempts) : null].filter(Boolean).join(" · ")}
      </p>
    </div>
  );

  if (mode === "visitor") {
    return (
      <section id="quiz" className="mt-8 scroll-mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }} aria-labelledby="quiz-title">
        {heading}
        <p className="st-muted mt-2 text-sm">{w.visitorQuiz}</p>
      </section>
    );
  }

  const used = attempt?.used ?? 0;
  const left = triesLeft(quiz, used);
  const passed = attempt?.passed === true;
  const last = attempt?.last ?? null;
  const reveal = mode === "owner" || passed || left === 0;
  const waiting = mode === "student" && !passed && left !== 0 && waitSeconds > 0;
  const canAnswer = mode === "student" && !passed && left !== 0 && !waiting;
  // A bank's next try draws other questions: the marks above them are the last try's.
  const fresh = Boolean(quiz.draw);
  const waitLine = waiting ? w.waitAgain(w.span(Math.max(1, Math.ceil(waitSeconds / 60)))) : null;
  const bank = mode === "owner"
    ? [
        quiz.draw ? w.bankDraw(quiz.draw, quiz.questions.length) : null,
        quiz.shuffle ? w.bankShuffle : null,
        quiz.waitMinutes ? w.bankWait(w.span(quiz.waitMinutes)) : null,
      ].filter((line): line is string => Boolean(line))
    : [];

  return (
    <section id="quiz" className="mt-8 scroll-mt-6 rounded-2xl px-5 py-5 sm:px-6" style={{ border: "1px solid var(--st-line-strong)" }} aria-labelledby="quiz-title">
      {heading}

      {stale && mode === "student" ? (
        <p className="st-note mt-3 text-sm" role="status">{w.staleTry}</p>
      ) : null}

      {mode === "owner" ? (
        <>
          <p className="st-note mt-3 text-sm">{w.ownerQuiz}</p>
          {bank.length ? <p className="st-muted mt-2 text-sm">{bank.join(" ")}</p> : null}
        </>
      ) : last ? (
        <div
          id="quiz-result"
          className="mt-3 rounded-2xl px-4 py-3"
          style={{ background: passed ? "var(--st-accent-soft)" : "var(--st-item)", color: "var(--st-text)" }}
          role={justMarked ? "status" : undefined}
        >
          <p className="font-semibold">
            {passed
              ? w.passedScore(last.grade.right, last.grade.total, last.grade.percent)
              : w.failedScore(last.grade.right, last.grade.total, last.grade.percent, quiz.passPercent)}
          </p>
          <p className="st-muted mt-1 text-sm">
            {passed
              ? w.passedNote
              : left === 0
                ? w.outOfTries(quiz.attempts, storeName)
                : left === null
                  ? fresh ? w.answerAny : w.againAny
                  : fresh ? w.answerLeft(left) : w.againLeft(left)}
          </p>
          {waitLine ? <p className="mt-1 text-sm font-semibold">{waitLine}</p> : null}
        </div>
      ) : (
        <p className="st-muted mt-2 text-sm">{left === null ? w.answerAny : w.answerLeft(left)}</p>
      )}

      <form action={action} method="post" className="mt-5">
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {canAnswer ? <input type="hidden" name="shown" value={quiz.questions.map((q) => q.id).join(",")} /> : null}
        <ol className="space-y-6">
          {quiz.questions.map((question, qi) => {
            const picked = last?.answers[question.id] ?? [];
            const mark = mode === "student" && last ? last.grade.marks[question.id] : undefined;
            const showWhy = reveal || mark === true;
            return (
              <li key={question.id}>
                <fieldset>
                  <legend className="font-semibold leading-snug" style={{ color: "var(--st-text)" }}>
                    <span className="st-muted mr-1 tabular-nums">{`${qi + 1}.`}</span>
                    <span className="whitespace-pre-line">{question.text}</span>
                    {question.kind === "multiple" ? <span className="st-muted mt-1 block text-sm font-normal">{w.chooseEvery}</span> : null}
                  </legend>
                  <div className="mt-3 space-y-2">
                    {question.choices.map((choice, ci) => {
                      const right = question.correct.includes(ci);
                      const chosen = picked.includes(ci);
                      return (
                        <label key={ci} className={`st-option !justify-start ${canAnswer ? "" : "!cursor-default"}`}>
                          <input
                            type={question.kind === "single" ? "radio" : "checkbox"}
                            name={`q_${question.id}`}
                            value={ci}
                            defaultChecked={mode === "student" ? chosen : mode === "owner" && right}
                            disabled={!canAnswer}
                            className="h-5 w-5 shrink-0"
                          />
                          <span className="min-w-0 flex-1 break-words">{choice}</span>
                          {reveal && right ? (
                            <span className="shrink-0 text-xs font-bold uppercase tracking-wide" style={{ color: "var(--st-accent-text)" }}>
                              {w.rightAnswer}
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                  {mark !== undefined ? (
                    <p className="mt-2 text-sm font-semibold" style={{ color: mark ? "var(--st-accent-text)" : "var(--st-text)" }}>
                      {mark ? w.gotIt : w.notQuite}
                    </p>
                  ) : null}
                  {showWhy && question.explanation ? (
                    <p className="st-muted mt-2 whitespace-pre-line text-sm leading-relaxed">{question.explanation}</p>
                  ) : null}
                </fieldset>
              </li>
            );
          })}
        </ol>
        {canAnswer ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn st-btn">
              {last ? w.checkAgain : w.check}
            </button>
            {left !== null ? <span className="st-muted text-sm">{w.triesLeft(left)}</span> : null}
          </div>
        ) : null}
      </form>
    </section>
  );
}
