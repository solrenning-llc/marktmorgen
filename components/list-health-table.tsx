import { HEALTH_WINDOW_DAYS } from "@/lib/mail-health-rules";
import { healthLevels, type HealthCounts } from "@/lib/mail-health-levels";
import { SOFT_BOUNCE_NOTE, TERMS, healthRows, levelWords, roomBeforePause, roomLine, roomWords } from "@/lib/list-health-rules";

/**
 * The list's health as a table, inside the email studio's health section
 * (570 [DR1], unit 2; added 4 November 2026): each count of the last seven
 * days with its share, its level in words and how many more would pause the
 * list's email, then the words explained in place.
 *
 * A server component that reads nothing: it is given the seven days the page
 * already read for KB20 (lib/mail-health.ts, listHealth), so the page makes
 * no second reading. The level comes from KB20's healthLevels and the shares
 * from its shareWords, so this table and the sentence above it never
 * disagree. At the level, the distance sentence is left out: KB20's advice
 * already says what happens then.
 *
 * Nothing here says an email was delivered, opened, put in the inbox or sent
 * to spam: no sender can know that, and the one sentence that names those
 * words says so (TERMS.spamUnknown).
 */
export function ListHealthTable({ health }: { health: HealthCounts }) {
  if (health.sent === 0) {
    return <p className="mt-3 text-sm text-ink-soft">{`Nothing was sent in these ${HEALTH_WINDOW_DAYS} days, so there is nothing yet to compare with the level that pauses email to your list.`}</p>;
  }
  const rows = healthRows(health);
  if (!rows) return null;
  const distance = healthLevels(health).worst === "over" ? "" : roomLine(roomBeforePause(health));
  return (
    <>
      <div className="mt-4 overflow-x-auto" role="region" aria-label="Bounces and spam reports, and how far they are from a pause" tabIndex={0}>
        <table className="w-full text-left text-sm text-ink">
          <caption className="pb-2 text-left font-semibold">{`Email to your list in the last ${HEALTH_WINDOW_DAYS} days, and how far it is from a pause`}</caption>
          <thead>
            <tr className="border-b border-line">
              <td />
              <th scope="col" className="px-3 py-2 text-right font-semibold">Count</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">{`Share of the ${health.sent.toLocaleString("en-US")} sent`}</th>
              <th scope="col" className="px-3 py-2 font-semibold">Level</th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">More that would pause it</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.measure} className="border-b border-line">
                <th scope="row" className="py-2 pr-3 font-semibold">{row.label}</th>
                <td className="px-3 py-2 text-right tabular-nums">{row.count.toLocaleString("en-US")}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.share}</td>
                <td className="px-3 py-2">{levelWords(row.level)}</td>
                <td className="py-2 pl-3 text-right tabular-nums">{roomWords(row.room)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {distance ? <p className="mt-3 text-sm">{distance}</p> : null}
      <h3 className="mt-4 text-base font-semibold">What these words mean</h3>
      <dl className="mt-2 text-sm">
        <dt className="font-semibold">Bounce</dt>
        <dd className="mt-1 text-ink-soft">{`${TERMS.bounce} ${SOFT_BOUNCE_NOTE}`}</dd>
        <dt className="mt-3 font-semibold">Spam complaint</dt>
        <dd className="mt-1 text-ink-soft">{TERMS.spamComplaint}</dd>
      </dl>
      <p className="mt-3 text-sm text-ink-soft">{TERMS.spamUnknown}</p>
    </>
  );
}
