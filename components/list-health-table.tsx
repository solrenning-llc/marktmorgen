import { HEALTH_WINDOW_DAYS } from "@/lib/mail-health-rules";
import type { HealthCounts } from "@/lib/mail-health-levels";
import { BOTH_NEEDED, SOFT_BOUNCE_NOTE, TERMS, UNREAD, healthRows, levelWords, pauseLevelWords, roomBeforePause, roomLine, roomWords } from "@/lib/list-health-rules";

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
 * disagree. Each row says the level that pauses (count and share, both
 * needed). At the level, both room cells say the next notice of either kind
 * pauses (pauseIfOver runs after every one counted), and the distance
 * sentence is left out: KB20's advice already says so.
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
  const room = roomBeforePause(health);
  const distance = room.atLevel ? "" : roomLine(room);
  return (
    <>
      <div className="mt-4 overflow-x-auto rounded-[6px] focus-visible:[outline:3px_solid_var(--focus)] focus-visible:[outline-offset:3px]" role="region" aria-label="Bounces and spam reports, and how far they are from a pause" tabIndex={0}>
        <table className="w-full text-left text-sm text-ink">
          <caption className="pb-2 text-left font-semibold">{`Email to your list, and the one email to buyers you brought over, in the last ${HEALTH_WINDOW_DAYS} days (counting starts again when a pause ends): how far it is from a pause`}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="py-2 pr-3 font-semibold">Measure</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Count</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">{`Share of the ${health.sent.toLocaleString("en-US")} sent`}</th>
              <th scope="col" className="px-3 py-2 font-semibold">Level</th>
              <th scope="col" className="px-3 py-2 font-semibold">Level that pauses it</th>
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
                <td className="px-3 py-2 tabular-nums">{pauseLevelWords(row.measure)}</td>
                {/* A number sits on the right with the other figures; the sentence said at the level reads from the left. */}
                <td className={row.atLevel ? "py-2 pl-3" : "py-2 pl-3 text-right tabular-nums"}>{roomWords(row.room, row.atLevel)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-ink-soft">{BOTH_NEEDED}</p>
      {distance ? <p className="mt-2 text-sm">{distance}</p> : null}
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

/**
 * The health section when the seven days could not be read (lib/mail-health.ts
 * listHealth throws on an incomplete or malformed read, CX-123 rule 24): no
 * count, no level, no distance from a pause and no "nothing was sent", since
 * none of them is known.
 */
export function ListHealthUnread() {
  return <p className="mt-2 text-sm text-ink-soft">{UNREAD}</p>;
}
