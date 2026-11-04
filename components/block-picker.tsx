"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";
import { BLOCK_KINDS, type BlockKind } from "@/lib/sales-page";

/**
 * Choosing a block to add, as cards to look at rather than a list to read
 * (added 8 October 2026): each kind with its icon, its name and what it is
 * for, grouped by what it does on the page, with a box to find one by name.
 * Kajabi and Hotmart Pages open a gallery like this; a long drop-down was
 * all this editor had.
 *
 * The same list is drawn two ways (375 [TB1], 29 October 2026): "gallery",
 * opened in the block list where a block will go, and "menu", the side menu
 * kept beside the page on a wide screen, where a card is chosen and then a
 * place ("Add here"), or a place and then a card, or a card is dragged onto a
 * place. The search, the groups and what is offered are the same in both.
 */
export const BLOCK_GROUPS: { title: string; kinds: BlockKind[] }[] = [
  { title: "Make the case", kinds: ["benefits", "fit", "steps", "compare", "bonuses", "facts"] },
  { title: "Show it", kinds: ["video", "pictures", "feature", "row", "inside"] },
  { title: "Answer and reassure", kinds: ["faq", "guarantee", "reviews", "quotes", "bio", "text"] },
  { title: "Move them to buy", kinds: ["cta", "product", "countdown", "hero", "form"] },
];

/** The groups as they show for `query` among the kinds `allowed`: a group with nothing left is not shown. */
export function blockGroupsFor(allowed: readonly BlockKind[], query: string): { title: string; kinds: BlockKind[] }[] {
  const words = query.trim().toLowerCase();
  const matches = (kind: BlockKind) => {
    if (!allowed.includes(kind)) return false;
    if (!words) return true;
    const about = BLOCK_KINDS.find((k) => k.kind === kind);
    return Boolean(about && `${about.label} ${about.hint}`.toLowerCase().includes(words));
  };
  return BLOCK_GROUPS.map((g) => ({ ...g, kinds: g.kinds.filter(matches) })).filter((g) => g.kinds.length > 0);
}

export function BlockPicker({
  icons,
  allowed,
  where,
  onPick,
  onClose,
  layout = "gallery",
  chosen = null,
  onDragKind,
  top,
}: {
  icons: Record<BlockKind, IconName>;
  /** The kinds that can still be added: one hero, one place for reviews. */
  allowed: BlockKind[];
  /**
   * Where the block will go, said in the heading: "at the end", "after block 3".
   * In the side menu, null until a place has been chosen.
   */
  where: string | null;
  onPick: (kind: BlockKind) => void;
  /** The gallery closes; the side menu forgets the place or the card chosen. */
  onClose: () => void;
  layout?: "gallery" | "menu";
  /** The side menu only: the card chosen, waiting for its place. */
  chosen?: BlockKind | null;
  /** The side menu only: a card is being dragged (its kind), or no longer (null). */
  onDragKind?: (kind: BlockKind | null) => void;
  /** Drawn above the cards, under the search: the side menu's saved sections. */
  top?: ReactNode;
}) {
  const menu = layout === "menu";
  const [query, setQuery] = useState("");
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The gallery opens where a place was pressed, so the search takes the
    // focus; the side menu is always there and never takes it by itself.
    if (!menu) box.current?.focus();
  }, [menu]);
  const groups = blockGroupsFor(allowed, query);
  const chosenLabel = chosen ? BLOCK_KINDS.find((k) => k.kind === chosen)?.label ?? chosen : null;
  const heading = where !== null ? `Add a block ${where}` : chosenLabel ? `Where should ${chosenLabel} go?` : "Add to the page";
  const pending = where !== null || chosen !== null;
  const findId = menu ? "menu-block-find" : "block-find";
  return (
    <section
      aria-label={heading}
      className={menu ? "rounded-2xl bg-paper p-3 ring-1 ring-line" : "rounded-2xl bg-paper p-3 ring-1 ring-violet-brand/30 sm:p-4"}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (!menu || pending)) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-ink">{heading}</p>
        {!menu || pending ? (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-soft hover:bg-white hover:text-ink"
            aria-label={menu ? "Cancel, add nothing" : "Close without adding"}
          >
            <Icon name="close" size={17} />
          </button>
        ) : null}
      </div>
      {menu ? (
        <p className="mt-1 text-xs text-ink-soft">
          {where !== null
            ? "Choose a block below and it goes there."
            : chosenLabel
              ? "Press Add here between the blocks, where it should go."
              : "Choose a block, then press Add here where it should go. Or drag it there."}
        </p>
      ) : null}
      <label className="sr-only" htmlFor={findId}>
        Find a block
      </label>
      <input
        ref={box}
        id={findId}
        type="search"
        className="field mt-2"
        placeholder={menu ? "Find a block" : "Find a block: questions, video, button…"}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {top}
      {groups.length === 0 ? (
        allowed.length === 0 ? null : <p className="mt-3 text-sm text-ink-soft">No block matches that. Try another word.</p>
      ) : (
        groups.map((group) => (
          <div key={group.title} className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{group.title}</p>
            <div className={menu ? "mt-2 grid gap-2" : "mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"}>
              {group.kinds.map((kind) => {
                const about = BLOCK_KINDS.find((k) => k.kind === kind);
                if (!about) return null;
                const on = menu && chosen === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => onPick(kind)}
                    // In the side menu, with no place chosen yet, a card is chosen and stays chosen until its place.
                    aria-pressed={menu && where === null ? on : undefined}
                    draggable={menu && onDragKind ? true : undefined}
                    onDragStart={
                      menu && onDragKind
                        ? (event) => {
                            event.dataTransfer.effectAllowed = "copy";
                            event.dataTransfer.setData("text/plain", about.label);
                            onDragKind(kind);
                          }
                        : undefined
                    }
                    onDragEnd={menu && onDragKind ? () => onDragKind(null) : undefined}
                    className={`group flex min-h-11 items-start gap-3 rounded-xl bg-white p-3 text-left transition hover:-translate-y-px hover:ring-violet-brand/50 focus-visible:ring-2 focus-visible:ring-violet-brand motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${on ? "ring-2 ring-violet-brand" : "ring-1 ring-line"} ${menu && onDragKind ? "cursor-grab active:cursor-grabbing" : ""}`}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lilac text-violet-deep" aria-hidden="true">
                      <Icon name={on ? "check" : icons[kind]} size={17} />
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
