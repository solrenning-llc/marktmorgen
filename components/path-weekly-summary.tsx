import type { PathWeeklySummary as WeeklySummary } from "@/lib/path-weekly-summary";
import type { Streak } from "@/lib/path-rules";

const dateWords = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

/** A private reflection on saved check-in dates, using the page's existing current streak. */
export function PathWeeklySummary({ summary, streak }: { summary: WeeklySummary; streak: Streak | null }) {
  return <section className="mt-8 rounded-2xl border border-line bg-white p-6" aria-labelledby="path-weekly-title">
    <h2 id="path-weekly-title" className="t-h3">Your week in Path</h2>
    {summary.state === "unavailable" ? <p className="mt-3">Your saved check-in days could not be read for this week.</p> : <>
      <p className="mt-3">Week: <time dateTime={summary.monday}>{dateWords(summary.monday)}</time> to <time dateTime={summary.sunday}>{dateWords(summary.sunday)}</time>.</p>
      <p className="mt-2 text-sm text-ink-soft">Saved time zone: {summary.timeZone}. Recorded through <time dateTime={summary.today}>{dateWords(summary.today)}</time>. This week is still in progress.</p>
      <p className="mt-4 font-semibold">{summary.days.length ? `${summary.days.length} saved check-in ${summary.days.length === 1 ? "day" : "days"} this week` : "No check-in days are saved for this week."}</p>
      {summary.days.length ? <ul className="mt-2 list-disc space-y-1 pl-5" aria-label="Saved check-in days">
        {summary.days.map(day => <li key={day}><time dateTime={day}>{dateWords(day)}</time></li>)}
      </ul> : null}
      <p className="mt-3 text-sm text-ink-soft">Check-in days are dates saved when you open Path.</p>
      {streak ? <p className="mt-3">Current streak: {streak.days} check-in {streak.days === 1 ? "day" : "days"}. {streak.restLeft} rest {streak.restLeft === 1 ? "day" : "days"} left this week.</p> : null}
      <p className="mt-3">Review the days you returned, then choose your next useful step below.</p>
    </>}
  </section>;
}
