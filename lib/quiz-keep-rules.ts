/**
 * A quiz's answers kept in the student's own browser while they answer
 * (297 [SQ8]; added 12 November 2026), so leaving the page, closing the
 * browser or losing the connection loses nothing, and coming back offers the
 * answers again. Nothing here is ever sent to us before the student presses
 * the quiz's own button; sending forgets it. Pure rules: no storage, no DOM.
 *
 *   - Kept per student and lesson, under QUIZ_KEEP_PREFIX and a code made on
 *     our server from the course, the lesson and the student's address
 *     (lib/quiz-keep-key.ts), and nothing else: the key names no store, course
 *     or lesson, and on a shared browser one student's draft is never put back
 *     for another (review of #4324, MEDIUM 6). A key in the older readable
 *     shape is removed by the sweep.
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
 *   - Forgotten after QUIZ_KEEP_DAYS, unreadable data is forgotten too: not
 *     only when the same lesson opens again, but every time a lesson or the
 *     library opens in that browser, every quiz draft there is looked at and
 *     the old or unreadable ones removed (sweepQuizDrafts), and signing out
 *     removes all of them (forgetAllQuizDrafts; review of #4324).
 */

export const QUIZ_KEEP_PREFIX = "mm:quiz:";
export const QUIZ_KEEP_DAYS = 7;
const KEEP_MS = QUIZ_KEEP_DAYS * 86_400_000;

/** Where one student's draft of one lesson's quiz is kept in this browser; `who` is the server's code for the course, lesson and student. */
export const quizKeepKey = (who: string) => `${QUIZ_KEEP_PREFIX}${who}`;

/** A key in today's shape: the prefix and the server's code, nothing else; any other mm:quiz: key is from before (MEDIUM 6). */
const OPAQUE_KEY = /^mm:quiz:[0-9a-f]{32}$/;

/** One question's choices as the student left them: every question of the try, even one left unanswered; `tries` is how many tries were recorded then. */
export type QuizDraft = { at: number; shown: string; tries: number; version: string; answers: Record<string, number[]> };

/** One choice input of the form, as the browser has it. */
export type ChoiceInput = { name: string; value: string; checked: boolean };

const QUESTION = /^q_[A-Za-z0-9_-]{1,64}$/;
const CHOICE = /^\d{1,3}$/;

/**
 * The draft of a form's choices, at `now`; only q_ inputs with a choice number count. `version` is the server's code
 * for the quiz's words and choices (lib/quiz-keep-key.ts quizVersion; review of #4324), kept so a quiz changed since
 * never gets it back.
 */
export function draftOf(inputs: readonly ChoiceInput[], shown: string, tries: number, now: number, version = ""): QuizDraft {
  const answers: Record<string, number[]> = {};
  for (const input of inputs) {
    if (!QUESTION.test(input.name) || !CHOICE.test(input.value)) continue;
    answers[input.name] ??= [];
    if (input.checked) answers[input.name].push(Number(input.value));
  }
  return { at: now, shown, tries, version, answers };
}

/** Whether a draft holds any answer at all; an empty one is not worth keeping. */
export const hasAnswers = (draft: QuizDraft) => Object.values(draft.answers).some((picked) => picked.length > 0);

/**
 * The draft kept under a key, when it can be put back on this try: readable,
 * not older than QUIZ_KEEP_DAYS, for exactly these questions, made before
 * the same number of recorded tries (a try recorded since means it was sent
 * and counted), for the same version of the quiz's words and choices, with
 * at least one answer. Anything else is null, and the
 * caller forgets it.
 */
export function draftToRestore(raw: string | null, shown: string, tries: number, now: number, version = ""): QuizDraft | null {
  if (!raw) return null;
  let kept: unknown;
  try {
    kept = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!kept || typeof kept !== "object") return null;
  const { at, shown: keptShown, tries: keptTries, version: keptVersion, answers } = kept as Partial<QuizDraft>;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now || now - at > KEEP_MS) return null;
  if (keptShown !== shown || keptTries !== tries || keptVersion !== version || !answers || typeof answers !== "object") return null;
  const clean: Record<string, number[]> = {};
  for (const [name, picked] of Object.entries(answers)) {
    if (!QUESTION.test(name) || !Array.isArray(picked)) return null;
    if (!picked.every((n) => Number.isInteger(n) && n >= 0 && n < 1000)) return null;
    clean[name] = [...new Set(picked)];
  }
  const draft = { at, shown, tries, version, answers: clean };
  return hasAnswers(draft) ? draft : null;
}

/**
 * This tab's draft written over the one kept on the device by another tab (review of #4324, MEDIUM 11): the kept
 * answers stay, and only the questions answered in this tab (`touched`) take this tab's, so one tab never wipes what
 * the student answered in another. A kept draft that could not be put back on this try (other questions, another
 * count, another version of the quiz, too old, unreadable) is not merged in.
 */
export function mergeDrafts(stored: string | null, mine: QuizDraft, touched: readonly string[], now: number): QuizDraft {
  const kept = draftToRestore(stored, mine.shown, mine.tries, now, mine.version);
  if (!kept) return mine;
  const answers: Record<string, number[]> = { ...mine.answers };
  for (const [name, picked] of Object.entries(kept.answers)) if (!touched.includes(name)) answers[name] = picked;
  return { ...mine, answers };
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

/** The part of the browser's storage the sweep needs: its keys, so a test can hand in a synthetic one. */
export type SweepStorage = DraftStorage & { readonly length: number; key(index: number): string | null };

/** Every quiz draft's key in this browser's storage, read before any is removed. */
function quizKeys(storage: SweepStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const name = storage.key(i);
    if (name?.startsWith(QUIZ_KEEP_PREFIX)) keys.push(name);
  }
  return keys;
}

/**
 * Removes every quiz draft in this browser that is unreadable, from the
 * future, older than QUIZ_KEEP_DAYS or under a key in the older readable
 * shape, whichever lesson or student it is for
 * (review of #4324): run each time a lesson or the library opens, so a draft
 * for a lesson never opened again does not stay. Answers how many went.
 * Storage that cannot be read or written is left alone, without an error.
 */
export function sweepQuizDrafts(storage: SweepStorage, now: number): number {
  let removed = 0;
  try {
    for (const name of quizKeys(storage)) {
      // A key in the older readable shape names the store, the course and the lesson: removed whatever it holds.
      if (!OPAQUE_KEY.test(name)) {
        storage.removeItem(name);
        removed += 1;
        continue;
      }
      let kept: unknown = null;
      try {
        kept = JSON.parse(storage.getItem(name) ?? "");
      } catch {
        kept = null;
      }
      const at = kept && typeof kept === "object" && !Array.isArray(kept) ? (kept as Partial<QuizDraft>).at : undefined;
      if (typeof at === "number" && Number.isFinite(at) && at <= now && now - at <= KEEP_MS) continue;
      storage.removeItem(name);
      removed += 1;
    }
  } catch {
    // Storage closed: nothing to sweep.
  }
  return removed;
}

/** Removes every quiz draft in this browser, for every lesson and student: on signing out (review of #4324). Answers how many went. */
export function forgetAllQuizDrafts(storage: SweepStorage): number {
  let removed = 0;
  try {
    for (const name of quizKeys(storage)) {
      storage.removeItem(name);
      removed += 1;
    }
  } catch {
    // Storage closed: nothing kept there either.
  }
  return removed;
}
