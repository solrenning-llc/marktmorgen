/**
 * A quiz's answers kept in the student's own browser while they answer
 * (297 [SQ8]; added 12 November 2026), so leaving the page, closing the
 * browser or losing the connection loses nothing, and coming back offers the
 * answers again. Nothing here is ever sent to us before the student presses
 * the quiz's own button; sending forgets it. Pure rules: no storage, no DOM.
 *
 *   - Kept per student and lesson, under QUIZ_KEEP_PREFIX with the store, the
 *     course, the lesson and a code made on our server from the course and the
 *     student's address (lib/quiz-keep-key.ts), so on a shared browser one
 *     student's draft is never put back for another (review of #4324).
 *   - Kept with the number of tries already recorded for that student
 *     (`tries`): pressing the quiz's button forgets nothing, so a send that
 *     fails (offline, refused, an allowance used up) loses nothing; once the
 *     server records the try, that number goes up and the draft no longer
 *     counts, and is forgotten.
 *   - Kept with the questions the try showed (`shown`, the quiz form's own
 *     list): a question bank draws other questions on the next try, so a
 *     draft for other questions is never put back, and is forgotten.
 *   - Only the quiz's choices are kept (q_ followed by a question id, and a
 *     choice's number), never the form's hidden fields.
 *   - Forgotten after QUIZ_KEEP_DAYS, unreadable data is forgotten too.
 */

export const QUIZ_KEEP_PREFIX = "mm:quiz:";
export const QUIZ_KEEP_DAYS = 30;
const KEEP_MS = QUIZ_KEEP_DAYS * 86_400_000;

/** Where one student's draft of one lesson's quiz is kept in this browser; `who` is the server's code for the student. */
export const quizKeepKey = (handle: string, product: string, lesson: string, who: string) => `${QUIZ_KEEP_PREFIX}${handle}:${product}:${lesson}:${who}`;

/** One question's choices as the student left them: every question of the try, even one left unanswered; `tries` is how many tries were recorded then. */
export type QuizDraft = { at: number; shown: string; tries: number; answers: Record<string, number[]> };

/** One choice input of the form, as the browser has it. */
export type ChoiceInput = { name: string; value: string; checked: boolean };

const QUESTION = /^q_[A-Za-z0-9_-]{1,64}$/;
const CHOICE = /^\d{1,3}$/;

/** The draft of a form's choices, at `now`; only q_ inputs with a choice number count. */
export function draftOf(inputs: readonly ChoiceInput[], shown: string, tries: number, now: number): QuizDraft {
  const answers: Record<string, number[]> = {};
  for (const input of inputs) {
    if (!QUESTION.test(input.name) || !CHOICE.test(input.value)) continue;
    answers[input.name] ??= [];
    if (input.checked) answers[input.name].push(Number(input.value));
  }
  return { at: now, shown, tries, answers };
}

/** Whether a draft holds any answer at all; an empty one is not worth keeping. */
export const hasAnswers = (draft: QuizDraft) => Object.values(draft.answers).some((picked) => picked.length > 0);

/**
 * The draft kept under a key, when it can be put back on this try: readable,
 * not older than QUIZ_KEEP_DAYS, for exactly these questions, made before
 * the same number of recorded tries (a try recorded since means it was sent
 * and counted), with at least one answer. Anything else is null, and the
 * caller forgets it.
 */
export function draftToRestore(raw: string | null, shown: string, tries: number, now: number): QuizDraft | null {
  if (!raw) return null;
  let kept: unknown;
  try {
    kept = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!kept || typeof kept !== "object") return null;
  const { at, shown: keptShown, tries: keptTries, answers } = kept as Partial<QuizDraft>;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now || now - at > KEEP_MS) return null;
  if (keptShown !== shown || keptTries !== tries || !answers || typeof answers !== "object") return null;
  const clean: Record<string, number[]> = {};
  for (const [name, picked] of Object.entries(answers)) {
    if (!QUESTION.test(name) || !Array.isArray(picked)) return null;
    if (!picked.every((n) => Number.isInteger(n) && n >= 0 && n < 1000)) return null;
    clean[name] = [...new Set(picked)];
  }
  const draft = { at, shown, tries, answers: clean };
  return hasAnswers(draft) ? draft : null;
}

/** Whether one choice input is checked once a draft is put back; inputs of questions the draft does not name keep their state. */
export function checkedAfter(input: ChoiceInput, draft: QuizDraft): boolean {
  const picked = draft.answers[input.name];
  if (!picked || !CHOICE.test(input.value)) return input.checked;
  return picked.includes(Number(input.value));
}

/** The part of the browser's storage the forgetting needs, so a test can hand in a synthetic one. */
export type DraftStorage = { getItem(key: string): string | null; removeItem(key: string): void };

/**
 * While the quiz cannot be answered, removes the draft kept under `key` that a
 * recorded try made useless (Codex L's review of #4324): once the student has
 * passed or used the last try (`final`), every draft for the lesson goes;
 * while they wait between tries, a draft made before a try recorded since
 * (another count), unreadable or too old goes, and one at the same count,
 * never recorded, stays to come back after the wait. Storage that cannot be
 * read or written (a private window) is left alone, without an error.
 */
export function forgetClosedDraft(storage: DraftStorage, key: string, tries: number, final: boolean, now: number): void {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return;
    if (!final) {
      let kept: unknown;
      try {
        kept = JSON.parse(raw);
      } catch {
        kept = null;
      }
      const { at, tries: keptTries } = (kept && typeof kept === "object" ? kept : {}) as Partial<QuizDraft>;
      if (keptTries === tries && typeof at === "number" && Number.isFinite(at) && at <= now && now - at <= KEEP_MS) return;
    }
    storage.removeItem(key);
  } catch {
    // Storage closed: nothing to forget.
  }
}
