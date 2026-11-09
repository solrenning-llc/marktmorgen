import type { Challenge, Counts, Progress } from "@/lib/community-challenges";
import { challengeDay, challengeDays, challengeWindowState, CHALLENGE_DAY_MS } from "@/lib/community-challenge-rules";
import { challengeDate, challengeWords } from "@/lib/buyer-words/challenges";
import type { LanguageCode } from "@/lib/store-language";

/**
 * One challenge on the community's challenges page: its state, its days (in
 * UTC, said so), what to do each day, and then either the member's own part
 * (joined or not, today's check-in, how many days and the streak, each day
 * by name) with a plain form to join or check in, or, for the creator, the
 * counts. Works without a script: each button posts a form, and the page
 * comes back with a word about what happened in a status region.
 */
export function ChallengeCard({
  handle,
  language,
  locale,
  challenge: c,
  level,
  now,
  owner,
  progress,
  counts,
}: {
  handle: string;
  language: LanguageCode;
  locale: string;
  challenge: Challenge;
  level: 2 | 3;
  now: number;
  owner: boolean;
  progress: Progress | null;
  counts: Counts | null;
}) {
  const w = challengeWords(language);
  const state = challengeWindowState(c.start, c.end, now);
  const days = challengeDays(c);
  const first = challengeDate(locale, c.start);
  const last = challengeDate(locale, c.end - CHALLENGE_DAY_MS);
  const labelId = `ch-${c.id}-title`;
  const Heading = level === 3 ? "h3" : "h2";
  const today = challengeDay(c.start, now);
  const form = (action: "join" | "checkin", label: string, primary: boolean) => (
    <form action="/api/store/community/challenge" method="post">
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="challenge" value={c.id} />
      <input type="hidden" name="action" value={action} />
      <button type="submit" className={primary ? "btn st-btn" : "cm-pill"}>{label}</button>
    </form>
  );

  return (
    <article id={`ch-${c.id}`} aria-labelledby={labelId} className="st-card p-4 sm:p-5">
      <p className="flex flex-wrap gap-1.5">
        <span className={`cm-badge ${state === "active" ? "cm-badge-creator" : state === "scheduled" ? "cm-badge-accent" : ""}`}>
          {state === "active" ? w.on : state === "scheduled" ? w.startsOn(first) : w.over}
        </span>
      </p>
      <Heading id={labelId} className="font-display mt-1.5 break-words text-lg font-semibold leading-snug tracking-[-0.01em]">{c.title}</Heading>
      <p className="st-muted mt-1 text-sm">{w.dates(first, last)}</p>
      {c.about ? <p className="mt-3 max-w-[70ch] whitespace-pre-line break-words">{c.about}</p> : null}
      <p className="mt-3 max-w-[70ch] break-words">
        <strong>{`${w.eachDay}: `}</strong>
        {c.task}
      </p>

      {owner ? (
        <div className="mt-4 text-sm">
          <p>{w.host}</p>
          {counts ? (
            <p className="mt-1 font-semibold">
              {w.counts(counts.joined, counts.checkIns)}
              {state === "active" ? ` ${w.today(counts.today)}` : ""}
            </p>
          ) : null}
        </div>
      ) : progress ? (
        <div className="mt-4">
          {state === "active" ? (
            progress.today ? (
              <p className="font-semibold">{w.checkedToday}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {form("checkin", w.checkIn, true)}
                {!progress.joined ? <p className="st-muted text-sm">{w.notJoined}</p> : null}
              </div>
            )
          ) : state === "scheduled" ? (
            progress.joined ? (
              <p className="text-sm">{w.opensOn(first)}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {form("join", w.join, true)}
                <p className="st-muted text-sm">{w.opensOn(first)}</p>
              </div>
            )
          ) : null}
          {progress.joined && progress.days.length ? (
            <>
              <p className="mt-3 text-sm">
                {w.progress(progress.checkIns, state === "ended" ? days : Math.min(days, today + 1))}
                {" "}
                {w.streak(progress.streak)}
              </p>
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer font-semibold">{w.yourDays}</summary>
                <ol className="mt-2 grid gap-1 sm:grid-cols-2">
                  {progress.days.map((done, d) => {
                    const date = challengeDate(locale, c.start + d * CHALLENGE_DAY_MS);
                    return (
                      <li key={d} className={done ? "" : "st-muted"}>
                        <span aria-hidden="true">{done ? "✓ " : "· "}</span>
                        {done ? w.dayDone(date) : w.dayMissed(date)}
                      </li>
                    );
                  })}
                </ol>
              </details>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
