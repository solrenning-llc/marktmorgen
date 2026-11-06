import { POLL_OPEN_DAYS, SEQUENCE_POLL_KEEP_DAYS, SEQUENCE_POLL_ROUND_DAYS, pollResults } from "@/lib/mail-poll-votes";

const DATE: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" };
const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", DATE);
const percent = (count: number, total: number) => (total ? Math.round((count / total) * 100) : 0);

/**
 * The totals of the polls in the store's one-off emails and sequences
 * (lib/mail-poll-votes.ts), newest first: how many people picked each
 * answer, in words and as a bar, never who picked what. A sequence's poll is
 * shown one round at a time, under its email's subject (`subjects` is keyed
 * by a one-off email's id and by a sequence email's campaign). Shown only
 * when the list has a poll; a read that fails says so instead of showing
 * nothing.
 */
export async function MailPollResults({ listId, subjects }: { listId: string | null; subjects: ReadonlyMap<string, string> }) {
  const polls = await pollResults(listId);
  if (polls !== null && polls.length === 0) return null;
  return (
    <section aria-labelledby="poll-results-title" className="card mt-8 p-6 sm:p-8">
      <h2 id="poll-results-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Poll results</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        Totals only: who picked what is never shown, to you or to anyone. Each reader answers once, from their own email, and can take their answer back. A poll takes answers for 30 days after its email goes out; its totals stay here 60 days more.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        {`A poll in a sequence email is counted in rounds of ${SEQUENCE_POLL_ROUND_DAYS} days. Each round takes answers until ${POLL_OPEN_DAYS} days after its last day, and its totals stay here ${SEQUENCE_POLL_KEEP_DAYS} days more. If you change the poll's words, a new count starts.`}
      </p>
      {polls === null ? (
        <p role="status" className="notice notice-warn mt-4 text-sm">Poll results could not be read just now. Nothing is lost. Reload the page to try again.</p>
      ) : (
        <ul className="mt-4 space-y-6">
          {polls.map((poll) => (
            <li key={poll.id}>
              <h3 className="font-semibold text-ink [overflow-wrap:anywhere]">{poll.question}</h3>
              <p className="mt-1 text-sm text-ink-soft">
                {[
                  subjects.get(poll.id) ? `In “${subjects.get(poll.id)}”` : "",
                  poll.campaign ? `${subjects.get(poll.campaign) ? `Sequence email “${subjects.get(poll.campaign)}”` : "Sequence email"}, sent ${day(poll.closes - (POLL_OPEN_DAYS + SEQUENCE_POLL_ROUND_DAYS) * 86_400)} to ${day(poll.closes - POLL_OPEN_DAYS * 86_400 - 1)}` : "",
                  poll.closed ? `Closed on ${day(poll.closes)}` : `Open until ${day(poll.closes)}`, `${poll.total.toLocaleString("en-US")} ${poll.total === 1 ? "answer" : "answers"}`].filter(Boolean).join(" · ")}
              </p>
              <ul className="mt-2 space-y-2">
                {poll.answers.map((answer, i) => (
                  <li key={i} className="text-sm">
                    <span className="[overflow-wrap:anywhere]">{`${answer.text}: ${answer.count.toLocaleString("en-US")} (${percent(answer.count, poll.total)}%)`}</span>
                    <span aria-hidden="true" className="mt-1 block h-2 rounded-full bg-sand">
                      <span className="block h-2 rounded-full bg-ink" style={{ width: `${percent(answer.count, poll.total)}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
