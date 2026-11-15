import Link from "next/link";
import { Logo, LogoMark } from "@/components/logo";
import { Icon } from "@/components/icons";
import type { Store } from "@/lib/store";
import { MAX_STORES_PER_ACCOUNT } from "@/lib/store";
import { type Role, ROLE_NAMES, can } from "@/lib/team-roles";
import { StudioSearch } from "@/components/studio-search";
import { ScreenHelp } from "@/components/screen-help";
import { StudioBell } from "@/components/studio-bell";
import type { BellFacts } from "@/lib/bell-rules";

type Entry = { store: Pick<Store, "sid" | "name" | "handle">; role: Role };

/**
 * The studio's top bar: the logo, which store is open, and a way to another.
 *
 * The switcher is a <details> of plain forms, so it opens with a tap or the
 * keyboard and works with no JavaScript at all. Choosing a store posts to
 * app/api/store/stores, which remembers it for next time; every link and
 * request on the page then carries that store (components/studio-store-pin).
 * People on a team see the stores they help run beside their own, with their
 * role on each.
 *
 * Under the bar, in the page rather than over it, the studio's one search box
 * (components/studio-search.tsx, 766 [STN13]), with a buyer's address offered
 * only to the roles that may read orders.
 */
export function StudioHeader({
  current,
  role,
  stores,
  owned,
  action,
}: {
  current: Pick<Store, "sid" | "name" | "handle"> & BellFacts;
  role: Role;
  stores: Entry[];
  /** How many stores this person owns, for the "New store" line. */
  owned: number;
  /** The button on the right: the store's own page, or back to the studio. */
  action: { href: string; label: string; short: string; icon?: "arrow-up-right" };
}) {
  const room = owned > 0 && owned < MAX_STORES_PER_ACCOUNT;
  return (
    <>
    <header className="sticky top-0 z-40 border-b border-line bg-white/90 backdrop-blur-xl">
      <div className="container-page flex h-16 items-center justify-between gap-2 sm:gap-3">
        <Link href="/" className="shrink-0 rounded-[10px]" aria-label="Marktmorgen, home">
          <span className="hidden sm:inline">
            <Logo />
          </span>
          <span className="sm:hidden">
            <LogoMark />
          </span>
        </Link>
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <details className="group relative min-w-0 [&:not([open])>div]:hidden">
            <summary
              className="flex min-h-11 min-w-0 cursor-pointer list-none items-center gap-1 rounded-full bg-paper px-2 py-1.5 sm:gap-2 sm:px-3 ring-1 ring-line transition hover:ring-violet-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand motion-reduce:transition-none [&::-webkit-details-marker]:hidden"
              aria-label={`Store: ${current.name}. Switch store`}
            >
              <span
                aria-hidden="true"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-lilac text-xs font-bold uppercase text-violet-deep"
              >
                {current.name.slice(0, 1)}
              </span>
              <span className="min-w-0 max-w-[7.5rem] truncate text-sm font-semibold text-ink sm:max-w-[14rem]">{current.name}</span>
              {role !== "owner" ? (
                <span className="hidden shrink-0 sm:inline">
                  <span className="tag">{ROLE_NAMES[role]}</span>
                </span>
              ) : null}
              <Icon
                name="chevron-down"
                size={16}
                className="hidden shrink-0 text-ink-mute transition-transform sm:block group-open:rotate-180 motion-reduce:transition-none"
              />
            </summary>
            <div className="fixed inset-x-4 top-[4.25rem] z-50 w-[calc(100vw-2rem)] rounded-2xl bg-white p-2 shadow-lg ring-1 ring-line sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-80">
              <p className="px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">Your stores</p>
              <ul>
                {stores.map((entry) => {
                  const on = entry.store.sid === current.sid;
                  return (
                    <li key={entry.store.sid || entry.store.handle}>
                      <form action={`/api/store/stores?store=${entry.store.sid}`} method="post">
                        <input type="hidden" name="action" value="select" />
                        <button
                          type="submit"
                          aria-current={on ? "true" : undefined}
                          className={`flex min-h-[44px] w-full items-center gap-3 rounded-[12px] px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand motion-reduce:transition-none ${
                            on ? "bg-lilac" : "hover:bg-paper"
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-ink">{entry.store.name}</span>
                            <span className="block truncate text-xs text-ink-soft">{`@${entry.store.handle}`}</span>
                          </span>
                          <span className={`tag shrink-0 ${entry.role === "owner" ? "" : "tag-brand"}`}>{ROLE_NAMES[entry.role]}</span>
                          {on ? <Icon name="check" size={16} className="shrink-0 text-violet-deep" /> : null}
                        </button>
                      </form>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-1 border-t border-line pt-1">
                {stores.length > 1 ? (
                  <Link
                    href={"/studio/totals?store=" + encodeURIComponent(current.sid)}
                    prefetch={false}
                    className="flex min-h-[44px] items-center gap-2 rounded-[12px] px-3 py-2 text-sm font-semibold text-violet-deep hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand"
                  >
                    <Icon name="chart" size={16} />
                    All your stores added up
                  </Link>
                ) : null}
                {room ? (
                  <Link
                    href="/studio/new"
                    className="flex min-h-[44px] items-center gap-2 rounded-[12px] px-3 py-2 text-sm font-semibold text-violet-deep hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand"
                  >
                    <Icon name="plus" size={16} />
                    New store
                    <span className="ml-auto text-xs font-normal text-ink-mute">{`${owned} of ${MAX_STORES_PER_ACCOUNT}`}</span>
                  </Link>
                ) : owned === 0 ? (
                  <Link
                    href="/studio/new"
                    className="flex min-h-[44px] items-center gap-2 rounded-[12px] px-3 py-2 text-sm font-semibold text-violet-deep hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand"
                  >
                    <Icon name="plus" size={16} />
                    A store of your own
                  </Link>
                ) : (
                  <p className="px-3 py-2 text-xs text-ink-soft">{`${MAX_STORES_PER_ACCOUNT} of ${MAX_STORES_PER_ACCOUNT} stores, the most one account can run.`}</p>
                )}
              </div>
            </div>
          </details>
          {role === "owner" ? <Link prefetch={false} href={"/studio/path?store=" + encodeURIComponent(current.sid)} className="btn btn-secondary btn-sm">Path</Link> : null}
          <Link href={action.href} className="btn btn-secondary btn-sm shrink-0">
            <span className="hidden min-[400px]:inline">{action.label}</span>
            <span className="min-[400px]:hidden">{action.short}</span>
            {action.icon ? <Icon name={action.icon} size={16} /> : null}
          </Link>
        </div>
      </div>
    </header>
    <StudioSearch sid={current.sid} buyers={can(role, "orders")} />
    <div className="border-b border-line bg-white"><div className="container-page flex flex-wrap items-start gap-2 py-2"><ScreenHelp checkup={can(role, "settings") ? "/studio/checkup?store=" + encodeURIComponent(current.sid) : null} /><StudioBell store={current} role={role} /></div></div>
    </>
  );
}
