"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { BLOCK_KINDS, type BlockKind } from "@/lib/sales-page";

/**
 * Choosing a block to add, as cards to look at rather than a list to read
 * (added 8 October 2026): each kind with its icon, its name and what it is
 * for, grouped by what it does on the page, with a box to find one by name.
 * Kajabi and Hotmart Pages open a gallery like this; a long drop-down was
 * all this editor had.
 */
export const BLOCK_GROUPS: { title: string; kinds: BlockKind[] }[] = [
  { title: "Make the case", kinds: ["benefits", "fit", "steps", "compare", "bonuses", "facts"] },
  { title: "Show it", kinds: ["video", "pictures", "feature", "row", "inside"] },
  { title: "Answer and reassure", kinds: ["faq", "guarantee", "reviews", "quotes", "bio", "text"] },
  { title: "Move them to buy", kinds: ["cta", "product", "countdown", "hero", "form"] },
];

export function BlockPicker({
  icons,
  allowed,
  where,
  onPick,
  onClose,
}: {
  icons: Record<BlockKind, IconName>;
  /** The kinds that can still be added: one hero, one place for reviews. */
  allowed: BlockKind[];
  /** Where the block will go, said in the heading: "at the end", "after block 3". */
  where: string;
  onPick: (kind: BlockKind) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  const words = query.trim().toLowerCase();
  const matches = (kind: BlockKind) => {
    if (!allowed.includes(kind)) return false;
    if (!words) return true;
    const about = BLOCK_KINDS.find((k) => k.kind === kind);
    return Boolean(about && `${about.label} ${about.hint}`.toLowerCase().includes(words));
  };
  const groups = BLOCK_GROUPS.map((g) => ({ ...g, kinds: g.kinds.filter(matches) })).filter((g) => g.kinds.length > 0);
  return (
    <section
      aria-label={`Add a block ${where}`}
      className="rounded-2xl bg-paper p-3 ring-1 ring-violet-brand/30 sm:p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-ink">{`Add a block ${where}`}</p>
        <button type="button" onClick={onClose} className="ml-auto inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-soft hover:bg-white hover:text-ink" aria-label="Close without adding">
          <Icon name="close" size={17} />
        </button>
      </div>
      <label className="sr-only" htmlFor="block-find">
        Find a block
      </label>
      <input
        ref={box}
        id="block-find"
        type="search"
        className="field mt-2"
        placeholder="Find a block: questions, video, button…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {groups.length === 0 ? (
        <p className="mt-3 text-sm text-ink-soft">No block matches that. Try another word.</p>
      ) : (
        groups.map((group) => (
          <div key={group.title} className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{group.title}</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.kinds.map((kind) => {
                const about = BLOCK_KINDS.find((k) => k.kind === kind);
                if (!about) return null;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => onPick(kind)}
                    className="group flex min-h-11 items-start gap-3 rounded-xl bg-white p-3 text-left ring-1 ring-line transition hover:-translate-y-px hover:ring-violet-brand/50 focus-visible:ring-2 focus-visible:ring-violet-brand"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lilac text-violet-deep" aria-hidden="true">
                      <Icon name={icons[kind]} size={17} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{about.label}</span>
                      <span className="mt-0.5 line-clamp-2 text-xs text-ink-soft">{about.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
