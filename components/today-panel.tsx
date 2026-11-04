import Link from "next/link";
import { SOME_UNREAD, type TodayId, type TodayView } from "@/lib/today-rules";

/** Where each line leads, said inside its link so the link says where it goes (2.4.9). */
const GOES: Record<TodayId, string> = {
  sales: "See your numbers",
  inbox: "Open your inbox",
  calls: "See your upcoming calls",
  events: "Open your community events",
  ship: "See orders to ship",
  renewals: "See your memberships",
  reviews: "Answer your reviews",
  reports: "Open your community's reports",
  affiliates: "See affiliate requests",
  questions: "See the questions",
};

/**
 * "Today" (484 [IT1], complement item 1, unit 2a): what needs the creator
 * today, one line each with its number, each a link straight to the screen
 * that deals with it (lib/today-rules.ts decides the lines). A line is shown
 * only with the address it leads to (`hrefs`), set by the studio where that
 * place exists. Days are UTC, like every number in the studio, and the
 * numbers are those of the moment the page opened (`at`), which it says.
 * Nothing is drawn when there is nothing this person can be shown: no line
 * with its place, no part not read, and no topic looked at.
 */
export function TodayPanel({ view, hrefs, at }: { view: TodayView; hrefs: Partial<Record<TodayId, string>>; at: number }) {
  const lines = view.kind === "lines" ? view.lines.filter((line) => hrefs[line.id]) : [];
  if (view.kind === "lines" ? !lines.length && !view.unread : !view.words) return null;
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return (
    <section aria-labelledby="today-title" className="card mt-8 p-6 sm:p-8" data-today={view.kind}>
      <h2 id="today-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Today
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        {`Counted when this page opened, at ${time} `}
        <abbr title="Coordinated Universal Time">UTC</abbr>
        {". Days start at midnight "}
        <abbr title="Coordinated Universal Time">UTC</abbr>.
      </p>
      {view.kind === "lines" ? (
        <>
          {lines.length ? (
            <ul className="mt-4 space-y-2">
              {lines.map((line) => (
                <li key={line.id}>
                  <Link href={hrefs[line.id]!} className="flex min-h-11 flex-wrap items-center gap-x-2 rounded-[var(--r-sm)] border border-line bg-white px-4 py-2 text-ink underline-offset-4 hover:underline">
                    <span className="font-semibold">{line.words}</span>
                    <span className="text-sm text-ink-soft">{GOES[line.id]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {view.unread ? <p className="notice notice-warn mt-4">{SOME_UNREAD}</p> : null}
        </>
      ) : (
        <p className="mt-4 text-ink">{view.words}</p>
      )}
    </section>
  );
}
