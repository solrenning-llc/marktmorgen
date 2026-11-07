import Link from "next/link";
import { MAX_SURVEY_NOTE, SHOWN_SURVEY_NOTES, SURVEY_SCORES, type SurveyAnswer, type SurveySummary } from "@/lib/course-survey-rules";
import { type SurveyNotice, courseSurveyWords } from "@/lib/buyer-words/course-survey";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { ArrivalNotice } from "@/components/arrival-notice";

/** The notices that say something went wrong, as opposed to that it went through. */
const WARNINGS = new Set<string>(["score", "slow", "full", "noroom", "unknown", "unfinished"]);

function isNotice(value: string): value is SurveyNotice {
  return value === "saved" || value === "removed" || WARNINGS.has(value);
}

/**
 * The survey a student sees on the course page (285 [SX1]): one question, a
 * score from 0 to 10 and an optional comment, kept by lib/course-survey.ts.
 * Plain forms, so it works without a script; the page comes back with `?sv=`
 * saying what happened, and that notice takes the focus.
 *
 * `mode` "answer" is for a student who finished the course with access open:
 * the form, and the way to remove a kept answer. "remove" is for one who
 * cannot answer now (a lesson added since, an access that ended) but has an
 * answer kept: only that it is kept and the way to remove it. A removal is asked
 * first, on its own screen (`?sv=confirm`). `mine` is "unread" when the kept
 * answer could not be read: then nothing can be sent over it, only the notice
 * is shown.
 */
export function CourseSurveyBox({
  where,
  mode,
  mine,
  notice,
  language,
}: {
  where: { handle: string; product: string };
  mode: "answer" | "remove";
  /** "kept": an answer is kept, not read (the page of a student who has not finished reads only that). */
  mine: SurveyAnswer | "kept" | null | "unread";
  notice: string;
  language?: unknown;
}) {
  const w = courseSurveyWords(language);
  const kept = mine === "unread" || mine === "kept" ? null : mine;
  const has = mine !== null && mine !== "unread";
  if (mode === "remove" && mine === null) return null;
  const flash = isNotice(notice) ? w.notices[notice] : "";
  const warn = WARNINGS.has(notice);
  const confirming = notice === "confirm" && has;
  const hidden = (
    <>
      <input type="hidden" name="handle" value={where.handle} />
      <input type="hidden" name="product" value={where.product} />
    </>
  );
  return (
    <section id="survey" aria-labelledby="survey-title" className="mt-6 scroll-mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line-strong)" }}>
      <h2 id="survey-title" className="text-base font-bold" style={{ color: "var(--st-text)" }}>
        {w.title}
      </h2>
      <p className="st-muted mt-1 text-sm">{w.note}</p>
      {flash ? <ArrivalNotice className={`cm-flash mt-4 ${warn ? "cm-flash-warn" : ""}`}>{flash}</ArrivalNotice> : null}
      {mine === "unread" ? (
        <p className="cm-flash cm-flash-warn mt-4" role="alert">{w.notices.unknown}</p>
      ) : confirming ? (
        <>
          <ArrivalNotice className="mt-4 text-sm font-semibold">
            {kept ? <p style={{ color: "var(--st-text)" }}>{w.yours(kept.score)}</p> : null}
            <p className="mt-1" style={{ color: "var(--st-text)" }}>{w.confirm}</p>
          </ArrivalNotice>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <form action="/api/store/course/survey" method="post">
              {hidden}
              <input type="hidden" name="action" value="remove" />
              <input type="hidden" name="sure" value="1" />
              <button type="submit" className="btn st-btn">{w.confirmYes}</button>
            </form>
            <Link href={`/@${where.handle}/course/${where.product}#survey`} prefetch={false} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">{w.keep}</Link>
          </div>
        </>
      ) : (
        <>
          {kept ? <p className="mt-4 text-sm font-semibold" style={{ color: "var(--st-text)" }}>{w.yours(kept.score)}</p> : null}
          {mode === "remove" ? <p className="st-muted mt-1 text-sm">{w.removeOnly}</p> : (
            <form action="/api/store/course/survey" method="post" className="mt-4 space-y-4">
              {hidden}
              <input type="hidden" name="action" value="answer" />
              <fieldset aria-describedby="survey-ends" aria-invalid={notice === "score" ? true : undefined}>
                <legend className="st-label">{w.question}</legend>
                <p id="survey-ends" className="st-muted mt-1 text-xs">{w.low} {w.high}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {SURVEY_SCORES.map((score) => (
                    <label key={score} className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-md border px-3 text-sm" style={{ borderColor: "var(--st-line)", color: "var(--st-text)" }}>
                      <input type="radio" name="score" value={score} required defaultChecked={kept?.score === score} className="h-5 w-5" />
                      <span>{score}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="block">
                <span className="st-label">{w.noteLabel}</span>
                <textarea
                  className="st-field mt-2"
                  name="note"
                  rows={3}
                  maxLength={MAX_SURVEY_NOTE}
                  defaultValue={kept?.note ?? ""}
                  aria-describedby="survey-note-hint"
                />
              </label>
              <p id="survey-note-hint" className="st-muted text-xs">{w.noteHint(MAX_SURVEY_NOTE)}</p>
              <button type="submit" className="btn st-btn">{w.save}</button>
            </form>
          )}
          {has ? (
            // Sent without `sure`: the page comes back asking first (`?sv=confirm`).
            <form action="/api/store/course/survey" method="post" className="mt-2">
              {hidden}
              <input type="hidden" name="action" value="remove" />
              <button type="submit" className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">{w.remove}</button>
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}

export type OwnerSurveyView =
  | { kind: "ask"; href: string }
  | { kind: "used" | "changed" | "failed" }
  | { kind: "shown"; summary: SurveySummary };

/**
 * What the store's owner sees of the course's survey, on the course page
 * itself: nothing is read until they ask (each reading is paid from the
 * studio's requests), then the average, how many gave each score and the
 * comments, without names.
 */
export function CourseSurveySummary({ view, language }: { view: OwnerSurveyView; language?: unknown }) {
  const w = courseSurveyWords(language);
  const locale = LANGUAGES[parseLanguage(language)].locale;
  const shown = view.kind === "shown" ? view.summary : null;
  const notes = shown ? shown.notes.slice(0, SHOWN_SURVEY_NOTES) : [];
  return (
    <section id="survey-answers" aria-labelledby="survey-answers-title" className="mt-6 scroll-mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
      <h2 id="survey-answers-title" className="text-base font-bold" style={{ color: "var(--st-text)" }}>
        {w.ownerTitle}
      </h2>
      <p className="st-muted mt-1 text-sm">{w.ownerNote}</p>
      {view.kind === "ask" ? (
        <Link href={view.href} prefetch={false} className="st-footer-link mt-3 inline-flex min-h-11 items-center text-sm font-semibold">{w.ownerShow}</Link>
      ) : view.kind !== "shown" ? (
        <p className="cm-flash cm-flash-warn mt-4" role="alert">
          {view.kind === "used" ? w.ownerUsed : view.kind === "changed" ? w.ownerChanged : w.ownerFailed}
        </p>
      ) : !shown || shown.average === null ? (
        <p className="st-muted mt-4 text-sm">{w.ownerNone}</p>
      ) : (
        <>
          <p className="mt-4 text-sm font-semibold" style={{ color: "var(--st-text)" }}>
            {w.average(shown.average.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), shown.count)}
          </p>
          <ul className="mt-2 space-y-1 text-sm" style={{ color: "var(--st-text)" }}>
            {[...SURVEY_SCORES].reverse().map((score) => (
              <li key={score}>{w.countOf(score, shown.counts[score])}</li>
            ))}
          </ul>
          {notes.length ? (
            <>
              <h3 className="mt-6 text-base font-semibold" style={{ color: "var(--st-text)" }}>{w.ownerNotes}</h3>
              {shown.notes.length > notes.length ? <p className="st-muted mt-1 text-xs">{w.ownerNewest(notes.length)}</p> : null}
              <ol className="mt-3 space-y-3">
                {/* Only the month and year beside each comment: in a small course a day could say who wrote it. */}
                {notes.map((note, i) => (
                  <li key={`${note.at}-${i}`} className="text-sm">
                    <p className="font-semibold" style={{ color: "var(--st-text)" }}>
                      {w.noteScore(note.score)}
                      <span aria-hidden="true" className="st-muted font-normal"> · </span>
                      <span className="st-muted font-normal">{new Date(note.at * 1000).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" })}</span>
                    </p>
                    <p className="mt-1 whitespace-pre-line" style={{ color: "var(--st-text)" }}>{note.note}</p>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
