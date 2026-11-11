"use client";

import { useState } from "react";
import { useLeaveGuard } from "@/components/leave-guard";
import { toast } from "@/components/toast";
import type { Course } from "@/lib/course";
import {
  DEFAULT_PASS_PERCENT,
  DEFAULT_ATTEMPTS,
  MAX_ATTEMPTS,
  MAX_CHOICES,
  MAX_CHOICE_LENGTH,
  MAX_EXPLANATION_LENGTH,
  MAX_QUESTIONS,
  MAX_QUESTION_LENGTH,
  MIN_CHOICES,
  type Quiz,
  type QuizSetup,
} from "@/lib/quiz";
import { MAX_WAIT_MINUTES } from "@/lib/quiz-bank-rules";
import { QUIZ_MONTHLY_SUBMISSIONS } from "@/lib/quiz-usage-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { browserFrames, focusWhenDrawn } from "@/lib/focus-when-drawn";
import { AiAssist } from "@/components/ai-assist";
import { DEFAULT_QUIZ_DRAFT, type DraftedQuestion, QUIZ_DRAFT_COUNTS } from "@/lib/quiz-draft";

type DraftQuestion = {
  id: string;
  text: string;
  kind: "single" | "multiple";
  choices: string[];
  correct: number[];
  explanation: string;
};

/** `draw` and `waitMinutes` empty: every question, and no wait (630 [HN6](7)). */
type Draft = { passPercent: string; attempts: string; required: boolean; draw: string; shuffle: boolean; waitMinutes: string; questions: DraftQuestion[] };

const blankQuestion = (): DraftQuestion => ({ id: "", text: "", kind: "single", choices: ["", ""], correct: [], explanation: "" });

function problemText(problem: { reason?: string; at?: number | null } | undefined): string {
  const n = typeof problem?.at === "number" ? problem.at + 1 : null;
  switch (problem?.reason) {
    case "empty":
      return "Add at least one question.";
    case "too_many":
      return `A quiz holds up to ${MAX_QUESTIONS} questions.`;
    case "pass":
      return "Type a pass mark from 1 to 100 percent.";
    case "attempts":
      return `Type how many tries a student gets, from 1 to ${MAX_ATTEMPTS}.`;
    case "question":
      return `Question ${n}: write the question.`;
    case "choices":
      return `Question ${n}: give it ${MIN_CHOICES} to ${MAX_CHOICES} answers to choose from.`;
    case "choice":
      return `Question ${n}: two of its answers are the same.`;
    case "correct":
      return `Question ${n}: check the right answer.`;
    case "single":
      return `Question ${n}: it has one right answer, so check just one — or switch it to several right answers.`;
    default:
      return "Something went wrong on our side. Nothing was saved; try again in a moment.";
  }
}

const small = "text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40";

/** A lesson's quiz in the studio: its questions, the right answers, and the rules for passing. */
export function QuizEditor({
  productId,
  lessonId,
  setup,
  onCourse,
}: {
  productId: string;
  lessonId: string;
  setup: QuizSetup | null;
  onCourse: (course: Course) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [draftCount, setDraftCount] = useState<number>(DEFAULT_QUIZ_DRAFT);
  // The quiz as it was opened: leaving with changes to it asks first (487 [IT4], item 6), an untouched one never.
  const [opened, setOpened] = useState("");
  useLeaveGuard(draft !== null && JSON.stringify(draft) !== opened && !busy);

  async function open() {
    setError(null);
    if (!setup) {
      const fresh = { passPercent: String(DEFAULT_PASS_PERCENT), attempts: String(DEFAULT_ATTEMPTS), required: false, draw: "", shuffle: false, waitMinutes: "", questions: [blankQuestion()] };
      setDraft(fresh);
      setOpened(JSON.stringify(fresh));
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/store/course?id=${productId}&lessonId=${lessonId}&quiz=1`, { cache: "no-store" });
      const data = (await response.json()) as { ok?: boolean; quiz?: Quiz | null };
      const quiz = data.ok ? data.quiz : null;
      if (!quiz) {
        setError("The quiz could not be read just now. Close this and open it again before changing it.");
        return;
      }
      const read = {
        passPercent: String(quiz.passPercent),
        attempts: String(quiz.attempts),
        required: quiz.required,
        draw: quiz.draw ? String(quiz.draw) : "",
        shuffle: quiz.shuffle === true,
        waitMinutes: quiz.waitMinutes ? String(quiz.waitMinutes) : "",
        questions: quiz.questions.map((q) => ({ ...q, choices: [...q.choices], correct: [...q.correct] })),
      };
      setDraft(read);
      setOpened(JSON.stringify(read));
    } catch {
      setError("The quiz could not be read just now. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  async function send(quiz: Record<string, unknown> | null): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/course", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "quiz", id: productId, lessonId, quiz }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; course?: Course; problem?: { reason?: string; at?: number | null } };
      if (data.ok && data.course) {
        onCourse(data.course);
        return true;
      }
      setError(data.error === "quiz" ? problemText(data.problem) : data.error === "signed_out" ? "Your session ended. Log in again." : STUDIO_MESSAGES[data.error ?? ""] ?? problemText(undefined));
      return false;
    } catch {
      setError(problemText(undefined));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const change = (at: number, next: Partial<DraftQuestion>) =>
    setDraft((current) => (current ? { ...current, questions: current.questions.map((q, i) => (i === at ? { ...q, ...next } : q)) } : current));

  if (!draft) {
    return (
      <div>
        <p className="field-label">Quiz</p>
        {setup ? (
          <p className="mt-1 text-sm text-ink">
            {[
              `${setup.questions} ${setup.questions === 1 ? "question" : "questions"}`,
              `pass mark ${setup.passPercent}%`,
              setup.attempts ? `${setup.attempts} ${setup.attempts === 1 ? "try" : "tries"}` : "existing quiz: no attempt cap",
              setup.required ? "must be passed to go on" : "optional",
            ].join(" · ")}
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-mute">A few questions to check what stuck. Marked on the spot, with your explanation for each.</p>
        )}
        <button type="button" className="btn btn-secondary btn-sm mt-2" disabled={loading} aria-busy={loading} onClick={open}>
          {loading ? "Opening…" : setup ? "Edit the quiz" : "Add a quiz"}
        </button>
        {error ? (
          <p className="notice notice-error mt-2" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const prefix = `quiz-${lessonId}`;
  return (
    <form
      className="rounded-[var(--r-sm)] border border-line bg-paper p-4"
      aria-label="Quiz"
      onSubmit={async (event) => {
        event.preventDefault();
        const saved = await send({
          passPercent: draft.passPercent,
          attempts: draft.attempts,
          required: draft.required,
          draw: draft.draw,
          shuffle: draft.shuffle,
          waitMinutes: draft.waitMinutes,
          questions: draft.questions,
        });
        if (saved) {
          toast("Quiz saved.");
          setDraft(null);
        }
      }}
    >
      <p className="field-label">Quiz</p>
      {!setup || setup.usagePolicy ? <p className="mt-2 text-sm text-ink-soft">{`This quiz shares a limit of ${QUIZ_MONTHLY_SUBMISSIONS.toLocaleString("en-US")} submissions per store per UTC month with other new quizzes. Restoring tries or deleting a quiz does not restore the monthly allowance. Reserved submissions may count even if a response fails.`}</p> : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Pass mark (%)</span>
          <input
            className="field mt-2"
            inputMode="numeric"
            value={draft.passPercent}
            onChange={(e) => setDraft({ ...draft, passPercent: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) })}
            required
          />
        </label>
        <label className="block">
          <span className="field-label">Tries allowed</span>
          <input
            className="field mt-2"
            inputMode="numeric"
            placeholder={String(DEFAULT_ATTEMPTS)}
            value={draft.attempts}
            onChange={(e) => setDraft({ ...draft, attempts: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) })}
            aria-describedby={`${prefix}-tries`}
          />
          <span id={`${prefix}-tries`} className="mt-1 block text-xs text-ink-soft">{`1 to ${MAX_ATTEMPTS} tries. ${setup?.attempts === 0 ? "This existing quiz can keep 0 or an empty field to preserve its original setting." : `Empty uses ${DEFAULT_ATTEMPTS}.`}You can restore tries from the student list.`}</span>
        </label>
      </div>
      <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-sm text-ink">
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />
        <span>
          <span className="font-semibold">Students must pass it to go on.</span> The lessons after this one stay locked until they do, and a
          certificate needs it passed.
        </span>
      </label>

      <fieldset className="mt-4">
        <legend className="field-label">Question bank (optional)</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Questions per try</span>
            <input
              className="field mt-2"
              inputMode="numeric"
              placeholder={`All ${draft.questions.length}`}
              value={draft.draw}
              onChange={(e) => setDraft({ ...draft, draw: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) })}
              aria-describedby={`${prefix}-draw`}
            />
            <span id={`${prefix}-draw`} className="mt-1 block text-xs text-ink-soft">
              {`Fewer than the ${draft.questions.length} questions below, and each try picks that many for each student. Empty, or ${draft.questions.length} or more, shows every question.`}
            </span>
          </label>
          <label className="block">
            <span className="field-label">Minutes to wait between tries</span>
            <input
              className="field mt-2"
              inputMode="numeric"
              placeholder="No wait"
              value={draft.waitMinutes}
              onChange={(e) => setDraft({ ...draft, waitMinutes: e.target.value.replace(/[^0-9]/g, "").slice(0, 4) })}
              aria-describedby={`${prefix}-wait`}
            />
            <span id={`${prefix}-wait`} className="mt-1 block text-xs text-ink-soft">
              {`1 to ${MAX_WAIT_MINUTES.toLocaleString("en-US")} minutes (one day). Empty means a student can try again at once.`}
            </span>
          </label>
        </div>
        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-sm text-ink">
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" checked={draft.shuffle} onChange={(e) => setDraft({ ...draft, shuffle: e.target.checked })} />
          <span>
            <span className="font-semibold">Show the questions in a different order on each try.</span> The answers stay in the order you wrote them.
          </span>
        </label>
      </fieldset>

      <div className="mt-5">
        <AiAssist<DraftedQuestion[]>
          title="Draft questions with AI"
          hint="From this lesson's text, and anything you add here. The questions are added to the list below for you to read and change; nothing is saved until you press Save the quiz. The right answer is put in a different place from one question to the next."
          placeholder="Optional: what the quiz should check, or the main points of a lesson that is only a video."
          allowEmpty
          emptyMessage="This lesson has no text yet. Write the main points it teaches in the box, and the questions are drawn from them."
          extra={
            <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <span className="font-semibold">How many questions</span>
              <select className="field w-auto" value={draftCount} onChange={(e) => setDraftCount(Number(e.target.value))}>
                {QUIZ_DRAFT_COUNTS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          }
          payload={() => ({ kind: "quiz", id: productId, lessonId, count: draftCount })}
          onResult={(questions) =>
            setDraft((current) => {
              if (!current) return current;
              // Questions still empty are replaced; the creator's own are kept, and these follow them.
              const kept = current.questions.filter((q) => q.text.trim() || q.choices.some((c) => c.trim()));
              const added = questions.map((q) => ({ id: "", text: q.text, kind: q.kind, choices: [...q.choices], correct: [...q.correct], explanation: q.explanation }));
              return { ...current, questions: [...kept, ...added].slice(0, MAX_QUESTIONS) };
            })
          }
          done="The questions are added below. Read each one, change what you like, then save the quiz."
        />
      </div>

      <ol className="mt-5 space-y-4">
        {draft.questions.map((question, qi) => {
          const qid = `${prefix}-q${qi}`;
          return (
            <li key={qi} className="rounded-[var(--r-sm)] border border-line bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <label htmlFor={`${qid}-text`} className="field-label">{`Question ${qi + 1}`}</label>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-bold">
                  <button type="button" className={small} disabled={qi === 0} onClick={() => {
                    const list = [...draft.questions];
                    [list[qi - 1], list[qi]] = [list[qi], list[qi - 1]];
                    setDraft({ ...draft, questions: list });
                  }}>Up</button>
                  <button type="button" className={small} disabled={qi === draft.questions.length - 1} onClick={() => {
                    const list = [...draft.questions];
                    [list[qi + 1], list[qi]] = [list[qi], list[qi + 1]];
                    setDraft({ ...draft, questions: list });
                  }}>Down</button>
                  <button type="button" className="text-ink-soft underline underline-offset-4 transition hover:text-danger disabled:opacity-40" disabled={draft.questions.length === 1} onClick={() => setDraft({ ...draft, questions: draft.questions.filter((_, i) => i !== qi) })}>
                    Remove
                  </button>
                </div>
              </div>
              <textarea
                id={`${qid}-text`}
                rows={2}
                className="field mt-2"
                maxLength={MAX_QUESTION_LENGTH}
                value={question.text}
                onChange={(e) => change(qi, { text: e.target.value })}
                required
              />
              <fieldset className="mt-3">
                <legend className="sr-only">{`How many right answers question ${qi + 1} has`}</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name={`${qid}-kind`}
                      className="h-4 w-4 accent-violet-brand"
                      checked={question.kind === "single"}
                      onChange={() => change(qi, { kind: "single", correct: question.correct.slice(0, 1) })}
                    />
                    One right answer
                  </label>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name={`${qid}-kind`}
                      className="h-4 w-4 accent-violet-brand"
                      checked={question.kind === "multiple"}
                      onChange={() => change(qi, { kind: "multiple" })}
                    />
                    Several right answers
                  </label>
                </div>
              </fieldset>
              <fieldset className="mt-3">
                <legend className="text-sm font-semibold text-ink">Answers — check the right {question.kind === "single" ? "one" : "ones"}</legend>
                <ul className="mt-2 space-y-2">
                  {question.choices.map((choice, ci) => (
                    <li key={ci} className="flex items-center gap-2">
                      <input
                        type={question.kind === "single" ? "radio" : "checkbox"}
                        name={`${qid}-correct`}
                        aria-label={`Answer ${ci + 1} is right`}
                        className="h-5 w-5 shrink-0 accent-violet-brand"
                        checked={question.correct.includes(ci)}
                        onChange={(e) =>
                          change(qi, {
                            correct:
                              question.kind === "single"
                                ? [ci]
                                : e.target.checked
                                  ? [...question.correct, ci].sort((a, b) => a - b)
                                  : question.correct.filter((i) => i !== ci),
                          })
                        }
                      />
                      <input
                        className="field min-w-0 flex-1"
                        aria-label={`Answer ${ci + 1}`}
                        maxLength={MAX_CHOICE_LENGTH}
                        value={choice}
                        onChange={(e) => change(qi, { choices: question.choices.map((c, i) => (i === ci ? e.target.value : c)) })}
                      />
                      <button
                        type="button"
                        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-soft transition hover:bg-sand hover:text-danger disabled:opacity-30"
                        aria-label={`Remove answer ${ci + 1}`}
                        disabled={question.choices.length <= MIN_CHOICES}
                        onClick={() =>
                          change(qi, {
                            choices: question.choices.filter((_, i) => i !== ci),
                            correct: question.correct.filter((i) => i !== ci).map((i) => (i > ci ? i - 1 : i)),
                          })
                        }
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {question.choices.length < MAX_CHOICES ? (
                  <button type="button" className={`${small} mt-2 text-sm font-bold`} onClick={() => change(qi, { choices: [...question.choices, ""] })}>
                    Add an answer
                  </button>
                ) : null}
              </fieldset>
              <label className="mt-3 block">
                <span className="field-label">Explanation (optional)</span>
                <textarea
                  rows={2}
                  className="field mt-2"
                  maxLength={MAX_EXPLANATION_LENGTH}
                  value={question.explanation}
                  onChange={(e) => change(qi, { explanation: e.target.value })}
                />
                <span className="mt-1 block text-xs text-ink-soft">
                  Shown once they answer it right, or once they pass or run out of tries, with the right answer.
                </span>
              </label>
            </li>
          );
        })}
      </ol>
      {draft.questions.length < MAX_QUESTIONS ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm mt-3"
          onClick={() => {
            const next = draft.questions.length;
            setDraft({ ...draft, questions: [...draft.questions, blankQuestion()] });
            focusWhenDrawn(() => document.getElementById(`${prefix}-q${next}-text`), browserFrames());
          }}
        >
          Add a question
        </button>
      ) : (
        <p className="mt-3 text-sm text-ink-soft">{`That is ${MAX_QUESTIONS} questions, the most a quiz holds.`}</p>
      )}

      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary btn-sm">
          {busy ? "Saving…" : "Save the quiz"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setDraft(null); setError(null); }}>
          Cancel
        </button>
        {setup ? (
          removing ? (
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-soft">Remove the quiz? The lessons after it stop waiting on it.</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={async () => {
                  if (await send(null)) {
                    toast("Quiz removed.");
                    setDraft(null);
                    setRemoving(false);
                  }
                }}
              >
                Yes, remove it
              </button>
              <button type="button" className={`${small} font-bold`} onClick={() => setRemoving(false)}>Keep it</button>
            </span>
          ) : (
            <button type="button" className="ml-auto text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger" onClick={() => setRemoving(true)}>
              Remove the quiz
            </button>
          )
        ) : null}
      </div>
    </form>
  );
}
