import { type LessonRating, MAX_RATING_NOTE, RATING_SCORES, type RatingSummary, SHOWN_RATING_NOTES } from "@/lib/lesson-rating-rules";
import { type RatingNotice, lessonRatingWords } from "@/lib/buyer-words/lesson-rating";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";

/** The notices that say something went wrong, as opposed to that it went through. */
const WARNINGS = new Set<string>(["score", "slow", "full", "noroom", "unknown"]);

function isNotice(value: string): value is RatingNotice {
  return value === "saved" || value === "removed" || WARNINGS.has(value);
}

/**
 * A student's quick rating at the end of a lesson (296 [SQ7]): 1 to 5 and an
 * optional comment, kept by lib/lesson-rating.ts. Plain forms, so it works
 * without a script; the page comes back with `?r=` saying what happened.
 * `mine` is "unread" when the kept rating could not be read: then nothing can
 * be sent over it, only the notice is shown.
 */
export function LessonRatingBox({
  where,
  mine,
  notice,
  language,
}: {
  where: { handle: string; product: string; lesson: string };
  mine: LessonRating | null | "unread";
  notice: string;
  language?: unknown;
}) {
  const w = lessonRatingWords(language);
  const flash = isNotice(notice) ? w.notices[notice] : "";
  const warn = WARNINGS.has(notice);
  const kept = mine === "unread" ? null : mine;
  const hidden = (
    <>
      <input type="hidden" name="handle" value={where.handle} />
      <input type="hidden" name="product" value={where.product} />
      <input type="hidden" name="lesson" value={where.lesson} />
    </>
  );
  return (
    <section id="rating" aria-labelledby="rating-title" className="mt-8 border-t pt-6" style={{ borderColor: "var(--st-line)" }}>
      <h2 id="rating-title" className="font-display text-xl font-semibold tracking-[-0.01em]" style={{ color: "var(--st-text)" }}>
        {w.title}
      </h2>
      <p className="st-muted mt-1 text-sm">{w.note}</p>
      {flash ? (
        <p className={`cm-flash mt-4 ${warn ? "cm-flash-warn" : ""}`} role={warn ? "alert" : "status"}>
          {flash}
        </p>
      ) : null}
      {mine === "unread" ? (
        <p className="cm-flash cm-flash-warn mt-4" role="alert">{w.notices.unknown}</p>
      ) : (
        <>
          {kept ? <p className="mt-4 text-sm font-semibold" style={{ color: "var(--st-text)" }}>{w.yours(kept.score)}</p> : null}
          <form action="/api/store/course/rating" method="post" className="mt-4 space-y-4">
            {hidden}
            <input type="hidden" name="action" value="rate" />
            <fieldset>
              <legend className="st-label">{w.legend}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {RATING_SCORES.map((score) => (
                  <label key={score} className="inline-flex min-h-11 min-w-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm" style={{ borderColor: "var(--st-line)", color: "var(--st-text)" }}>
                    <input type="radio" name="score" value={score} required defaultChecked={kept?.score === score} className="h-5 w-5" />
                    <span>{w.scores[score - 1]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="block">
              <span className="st-label">{w.noteLabel}</span>
              <textarea
                className="st-field mt-2"
                name="note"
                rows={2}
                maxLength={MAX_RATING_NOTE}
                defaultValue={kept?.note ?? ""}
                aria-describedby="rating-note-hint"
              />
            </label>
            <p id="rating-note-hint" className="st-muted text-xs">{w.noteHint(MAX_RATING_NOTE)}</p>
            <button type="submit" className="btn st-btn">{w.save}</button>
          </form>
          {kept ? (
            <form action="/api/store/course/rating" method="post" className="mt-2">
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

export type OwnerRatingView =
  /** `action`: the lesson's own address, to ask with `ratings=1` (a form, so no browser or link reader fetches it ahead and spends the studio's requests). */
  | { kind: "ask"; action: string }
  | { kind: "used" | "changed" | "failed" }
  | { kind: "shown"; summary: RatingSummary };

/**
 * What the store's owner sees of a lesson's ratings, on the lesson itself:
 * nothing is read until they ask (each reading is paid from the studio's
 * requests), then the average, how many gave each score and the comments,
 * without names, each with its month only, never its day.
 */
export function LessonRatingSummary({ view, language }: { view: OwnerRatingView; language?: unknown }) {
  const w = lessonRatingWords(language);
  const locale = LANGUAGES[parseLanguage(language)].locale;
  const shown = view.kind === "shown" ? view.summary : null;
  const notes = shown ? shown.notes.slice(0, SHOWN_RATING_NOTES) : [];
  return (
    <section id="ratings" aria-labelledby="ratings-title" className="mt-8 border-t pt-6" style={{ borderColor: "var(--st-line)" }}>
      <h2 id="ratings-title" className="font-display text-xl font-semibold tracking-[-0.01em]" style={{ color: "var(--st-text)" }}>
        {w.ownerTitle}
      </h2>
      <p className="st-muted mt-1 text-sm">{w.ownerNote}</p>
      {view.kind === "ask" ? (
        <form method="get" action={view.action} className="mt-3">
          <input type="hidden" name="ratings" value="1" />
          <button type="submit" className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">{w.ownerShow}</button>
        </form>
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
            {[5, 4, 3, 2, 1].map((score) => (
              <li key={score}>{w.countOf(score, shown.counts[score - 1])}</li>
            ))}
          </ul>
          {notes.length ? (
            <>
              <h3 className="mt-6 text-base font-semibold" style={{ color: "var(--st-text)" }}>{w.ownerNotes}</h3>
              {shown.notes.length > notes.length ? <p className="st-muted mt-1 text-xs">{w.ownerNewest(notes.length)}</p> : null}
              <ol className="mt-3 space-y-3">
                {notes.map((note, i) => (
                  <li key={`${note.at}-${i}`} className="text-sm">
                    <p className="font-semibold" style={{ color: "var(--st-text)" }}>
                      {w.noteScore(note.score)}
                      <span aria-hidden="true" className="st-muted font-normal"> · </span>
                      <span className="st-muted font-normal">{new Date(note.at * 1000).toLocaleDateString(locale, { year: "numeric", month: "long", timeZone: "UTC" })}</span>
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
