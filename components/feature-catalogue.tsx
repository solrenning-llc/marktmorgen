"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { revealFocused } from "@/components/reveal-focus";

export type CatalogueItem = {
  slug: string;
  label: string;
  description: string;
  icon: IconName;
  group: string;
  plan: string;
  status: "live" | "building" | "proof";
  statusLabel: string;
};

export type CatalogueGroup = { key: string; title: string; line: string };

const STATUS_CLASS = {
  live: "tag tag-live",
  building: "tag tag-next",
  proof: "tag",
} as const;

/**
 * Every feature on one page, narrowed by the thing a creator came to do.
 *
 * Twenty cards in five headed blocks is a catalogue you scroll past; the same
 * twenty with a filter on top is a catalogue you use. The filter hides
 * nothing permanently — "All" is the state the page opens in, and every card
 * is in the HTML either way, so search engines and a browser without
 * JavaScript still see the whole list.
 */
export function FeatureCatalogue({
  items,
  groups,
}: {
  items: CatalogueItem[];
  groups: CatalogueGroup[];
}) {
  const [group, setGroup] = useState<string>("all");
  const top = useRef<HTMLDivElement | null>(null);
  const shown = group === "all" ? items : items.filter((i) => i.group === group);

  /*
   * The address bar is part of this filter.
   *
   * Pages elsewhere on the site link straight at one part of the catalogue —
   * /platform#group-sell, #group-paid, #group-grow — and a link like that
   * used to land at the top of the page with everything showing, because the
   * filter lived only in React state and no such element existed to jump to.
   * Now the hash is read on arrival and whenever it changes, so a link, a
   * reload, a pasted address and the browser's Back button all open the same
   * part. Pressing a filter writes the hash back without adding a history
   * entry, so Back still leaves the page rather than walking through every
   * filter somebody tried.
   */
  const known = useCallback(
    (hash: string) => {
      const key = hash.replace(/^#/, "").replace(/^group-/, "");
      if (!key) return null;
      if (key === "all") return "all";
      return groups.some((g) => g.key === key) ? key : null;
    },
    [groups],
  );

  useEffect(() => {
    const apply = (scroll: boolean) => {
      const key = known(window.location.hash);
      if (!key) return;
      setGroup(key);
      if (!scroll) return;
      // The header is fixed; `scroll-mt` on the anchor keeps the filter bar
      // clear of it rather than under it.
      top.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    };
    apply(true);
    const onHash = () => apply(true);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [known]);

  const pick = (key: string) => {
    setGroup(key);
    if (typeof window === "undefined") return;
    const hash = key === "all" ? "" : `#group-${key}`;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  };

  return (
    <div>
      {/*
        One real element per group, right where the catalog starts.

        The script above chooses the filter; these are what the browser itself
        jumps to, which is the half that keeps working when the script does
        not. They sit in the flow with nothing in them, and `scroll-mt-28`
        leaves the filter bar clear of the fixed header instead of under it.
      */}
      <span id="features" aria-hidden="true" className="block scroll-mt-28" />
      {groups.map((g) => (
        <span key={`anchor-${g.key}`} id={`group-${g.key}`} aria-hidden="true" className="block scroll-mt-28" />
      ))}
      <div
        ref={top}
        className="flex scroll-mt-28 flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="seg max-w-full overflow-x-auto" role="group" aria-label="Filter the features" onFocus={revealFocused}>
          <button
            type="button"
            className="seg-item"
            aria-pressed={group === "all"}
            onClick={() => pick("all")}
          >
            All
            <span className="text-[0.8125rem] font-semibold opacity-70">{items.length}</span>
          </button>
          {groups.map((g) => {
            const n = items.filter((i) => i.group === g.key).length;
            if (n === 0) return null;
            return (
              <button
                key={g.key}
                type="button"
                className="seg-item"
                aria-pressed={group === g.key}
                onClick={() => pick(g.key)}
              >
                {g.title}
                <span className="text-[0.8125rem] font-semibold opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
        <p className="text-sm text-ink-mute" aria-live="polite">
          {group === "all"
            ? `${items.length} features, each with its own page`
            : groups.find((g) => g.key === group)?.line}
        </p>
      </div>

      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((p) => (
          <li key={p.slug}>
            <Link
              href={`/platform/${p.slug}`}
              className="card card-hover group flex h-full flex-col p-6"
            >
              <span className="flex items-start justify-between gap-3">
                <span className="icon-tile">
                  <Icon name={p.icon} size={22} />
                </span>
                <span className="flex flex-wrap justify-end gap-1.5">
                  <span className={STATUS_CLASS[p.status]}>{p.statusLabel}</span>
                </span>
              </span>
              <span className="mt-5 block text-[1.125rem] font-semibold text-ink">{p.label}</span>
              <span className="mt-1.5 block flex-1 text-[0.9375rem] text-ink-soft">{p.description}</span>
              <span className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
                <span className="text-[0.8125rem] font-medium text-ink-mute">{p.plan}</span>
                <span className="inline-flex items-center gap-1 text-sm font-semibold text-violet-deep">
                  How it works
                  <Icon name="arrow-right" size={15} className="transition-transform group-hover:translate-x-0.5" />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
