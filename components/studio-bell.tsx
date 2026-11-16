import { useId } from "react";
import { Icon } from "@/components/icons";
import { type BellFacts, bellView } from "@/lib/bell-rules";
import type { Role } from "@/lib/team-roles";

/** Each link: 44 px tall at least, its words centered in it, underlined as a link. */
const LINK =
  "inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-4 hover:text-violet-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand";

/** The time the bell is drawn at, read once per page on the server (as lib/checkup.ts, checkupClock). */
function bellClock(): number {
  return Date.now();
}

/**
 * The studio's bell (766 [STN13], unit 4), beside "Help for this screen"
 * under the top bar of every studio screen: what needs the creator, kept
 * apart from news (lib/bell-rules.ts), from the store record the page
 * already holds.
 *
 * Drawn on the server, with no script: a native <details> that stays closed
 * until it is asked for, even when something waits, so it never interrupts
 * (2.2.4) and announces nothing when the page opens. How many need the
 * creator is said in words on its button, never by a color or a dot. What it
 * shows opens in the page under the button, never over the menu, and with
 * no heading, since it sits above the page's own title.
 */
export function StudioBell({ store, role, now = bellClock() }: { store: { sid: string } & BellFacts; role: Role; now?: number }) {
  const { needs, news } = bellView(store, role, now);
  const base = useId();
  const count = needs.length;
  return (
    <details className="min-w-0 open:basis-full">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full bg-paper px-4 text-sm font-semibold text-ink ring-1 ring-line hover:ring-violet-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand [&::-webkit-details-marker]:hidden">
        <Icon name="alert" size={16} />
        {count ? `Notifications: ${count} ${count === 1 ? "needs" : "need"} you` : "Notifications"}
      </summary>
      <div className="mt-2 max-w-[80ch] rounded-2xl bg-white p-4 text-sm leading-relaxed text-ink-soft ring-1 ring-line">
        <p id={`${base}-needs`} className="font-bold text-ink">Needs you</p>
        {count ? (
          <ul aria-labelledby={`${base}-needs`} className="mt-1 space-y-2">
            {needs.map((item) => (
              <li key={item.id}>
                <p className="text-ink">{item.words}</p>
                {item.link ? (
                  <a href={item.link.href} className={LINK}>
                    {item.link.label}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1">Nothing needs you right now.</p>
        )}
        {news.length ? (
          <>
            <p id={`${base}-news`} className="mt-3 border-t border-line pt-3 font-bold text-ink">News</p>
            <ul aria-labelledby={`${base}-news`} className="mt-1 space-y-1">
              {news.map((item) => (
                <li key={item.id}>{item.words}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </details>
  );
}
