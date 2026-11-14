"use client";

import { useEffect, useState } from "react";
import { busiestHours, toLocalWeek } from "@/lib/buying-hours";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Below this many sales, the bars are shown but no pattern is claimed from them. */
const MIN_FOR_PATTERN = 10;

const hourWords = (h: number) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`);

/**
 * When your buyers buy (added 12 October 2026): the last 90 days of
 * checkouts by hour of the day and day of the week, in the time this browser
 * keeps, so emails and posts can go out when people buy. Read from the hours
 * of the sales on Stripe (lib/stats.ts, hoursOfWeek); nothing more is kept.
 */
export function BuyingHours({ hours }: { hours: number[] }) {
  const [offset, setOffset] = useState<number | null>(null);
  useEffect(() => {
    // The browser's own time, read once it is in the browser: the page is drawn on a server in UTC.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffset(new Date().getTimezoneOffset());
  }, []);
  const total = hours.reduce((sum, n) => sum + n, 0);
  if (offset === null || total === 0) return null;
  const week = toLocalWeek(hours, offset);
  const byDay = DAYS.map((_, d) => week.slice(d * 24, d * 24 + 24).reduce((sum, n) => sum + n, 0));
  const byHour = Array.from({ length: 24 }, (_, h) => DAYS.reduce((sum, _d, d) => sum + week[d * 24 + h], 0));
  const peakDay = Math.max(1, ...byDay);
  const peakHour = Math.max(1, ...byHour);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "your time";
  const topDay = byDay.indexOf(Math.max(...byDay));
  const start = busiestHours(byHour);
  const inWindow = byHour[start] + byHour[(start + 1) % 24] + byHour[(start + 2) % 24];

  return (
    <div className="mt-6" role="region" aria-labelledby="buying-hours" data-buying-hours>
      <p id="buying-hours" className="text-sm font-bold text-ink">
        When your buyers buy
      </p>
      <p className="mt-1 text-xs text-ink-soft">{`Checkouts of the last 90 days, in ${zone} time.`}</p>
      {total >= MIN_FOR_PATTERN ? (
        <p className="mt-2 text-sm text-ink" data-buying-pattern>
          {`${DAYS[topDay]} brought the most sales, ${byDay[topDay]} of ${total}. Between ${hourWords(start)} and ${hourWords((start + 3) % 24)} came ${inWindow}, the busiest three hours of the day.`}
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-soft">{`${total} ${total === 1 ? "sale" : "sales"} so far: too few to tell a pattern from chance. The bars fill in as you sell.`}</p>
      )}
      <div className="mt-3 grid gap-5 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">By day of the week</p>
          <ul className="mt-2 space-y-1">
            {DAYS.map((name, d) => (
              <li key={name} className="flex items-center gap-2 text-sm">
                <span className="w-24 shrink-0 text-ink-soft">{name}</span>
                <span className="h-2.5 min-w-0 flex-1 rounded-full bg-line" aria-hidden="true">
                  <span className="meter-fill block h-2.5 rounded-full bg-violet-brand/80" style={{ width: `${(byDay[d] / peakDay) * 100}%` }} />
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums text-ink">{byDay[d]}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">By hour of the day</p>
          <div className="mt-2 flex h-28 items-end gap-[3px]" role="img" aria-label={`Sales by hour: ${byHour.map((n, h) => `${hourWords(h)} ${n}`).join(", ")}`}>
            {byHour.map((n, h) => (
              <div key={h} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${hourWords(h)}: ${n} ${n === 1 ? "sale" : "sales"}`}>
                <div className="meter-fill w-full rounded-t-[3px] bg-violet-brand/80" style={{ height: `${Math.max(n ? 4 : 1, (n / peakHour) * 100)}%`, opacity: n ? 1 : 0.25 }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-ink-mute" aria-hidden="true">
            <span>12 am</span>
            <span>6 am</span>
            <span>12 pm</span>
            <span>6 pm</span>
            <span>11 pm</span>
          </div>
        </div>
      </div>
    </div>
  );
}
