"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { BLOCK_KINDS, type BlockKind, type PageBlock } from "@/lib/sales-page";
import { MAX_SECTION_BLOCKS, MAX_SECTION_NAME, type SavedSection, blocksForPage, fitsPage, savable } from "@/lib/saved-blocks";

const MESSAGES: Record<string, string> = {
  name: "Give the section a name. Only you see it.",
  empty: "Check at least one block to save.",
  too_many: `A section holds up to ${MAX_SECTION_BLOCKS} blocks.`,
  kind: "The headline at the top, the reviews and columns stay on their own page: they cannot be in a section.",
  too_big: "Those blocks hold more words than one section can.",
  shape: "One of those blocks would not be kept as it is. Check it is complete and try again.",
  sections_full: "Your library holds all the sections your store can keep. Remove one to save another.",
  applies_full: "Pages have been updated from sections as often as your store's figure allows for now. More can be done when the figure opens again.",
  pages: "Those pages no longer use this section. Reload and try again.",
  forbidden: "Your role cannot change one of those pages.",
  unknown: "That section is gone. Reload the page.",
  server_error: "We could not confirm the result. Reload before trying again.",
  ...STUDIO_MESSAGES,
};

const label = (kind: BlockKind) => BLOCK_KINDS.find((k) => k.kind === kind)?.label ?? kind;
const headingOf = (block: PageBlock) => ("heading" in block && typeof block.heading === "string" ? block.heading : "") || ("label" in block && typeof block.label === "string" ? block.label : "");

type Use = { key: string; title: string; site: boolean; why: string };

/**
 * The store's saved sections, inside the page editor (lib/saved-blocks.ts):
 * put one on this page, save some of this page's blocks as a new one, and
 * after changing a section on this page, update the saved one and, if
 * chosen, the other pages that use it, listed before anything is changed.
 */
export function SavedSections({
  pageKey,
  allowed,
  blocks,
  room,
  disabled,
  onInsert,
}: {
  /** This page's key: a product's id, or site-<page id>. */
  pageKey: string;
  /** The kinds this page may hold. */
  allowed: readonly BlockKind[];
  blocks: PageBlock[];
  /** How many more blocks this page has room for. */
  room: number;
  disabled: boolean;
  onInsert: (blocks: PageBlock[]) => void;
}) {
  const [sections, setSections] = useState<SavedSection[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [uses, setUses] = useState<{ id: string; list: Use[]; checked: string[] } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function load() {
    try {
      const response = await fetch("/api/store/saved-blocks", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; sections?: SavedSection[]; limit?: number };
      if (!data.ok || !data.sections) throw new Error("unread");
      setSections(data.sections);
      setLimit(data.limit ?? 0);
    } catch {
      setNote("Your saved sections could not be read just now. Try again in a moment.");
    }
  }

  async function send(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (busy) return null;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/store/saved-blocks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      if (data.ok !== true) {
        setNote(MESSAGES[String(data.error)] ?? MESSAGES.server_error);
        return null;
      }
      return data;
    } catch {
      setNote(MESSAGES.server_error);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // The library's own rule (lib/saved-blocks.ts, NOT_IN_SECTIONS): never a list of kinds kept here.
  const offered = blocks.filter(savable);

  async function saveNew() {
    const picked = blocks.filter((block) => chosen.includes(block.id));
    const data = await send({ action: "save", name, blocks: picked });
    if (!data) return;
    const left = Number(data.picturesLeft ?? 0);
    toast(`Section saved${left ? `; its ${left === 1 ? "picture stays" : `${left} pictures stay`} on this page only` : ""}.`);
    setPicking(false);
    setChosen([]);
    setName("");
    await load();
  }

  /** The blocks on this page that came from a section, in order: its first run. */
  function runOf(id: string): PageBlock[] {
    const start = blocks.findIndex((block) => block.saved === id);
    if (start < 0) return [];
    const run: PageBlock[] = [];
    for (let i = start; i < blocks.length && blocks[i].saved === id; i += 1) run.push(blocks[i]);
    return run;
  }

  async function updateFromHere(section: SavedSection) {
    const data = await send({ action: "update", id: section.id, blocks: runOf(section.id), except: pageKey });
    if (!data) return;
    const list = (data.uses as Use[]) ?? [];
    toast("Saved section updated. Save this page to keep it here too.");
    setUses({ id: section.id, list, checked: list.filter((u) => !u.why).map((u) => u.key) });
    await load();
  }

  async function apply() {
    if (!uses || uses.checked.length === 0) return;
    const data = await send({ action: "apply", id: uses.id, pages: uses.checked });
    if (!data) return;
    const done = (data.done as string[]) ?? [];
    const skipped = (data.skipped as { key: string; why: string }[]) ?? [];
    toast(`${done.length} ${done.length === 1 ? "page" : "pages"} updated${skipped.length ? `, ${skipped.length} left as they were` : ""}. Each page's earlier version can be brought back.`);
    setUses(null);
  }

  return (
    <details
      className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5"
      onToggle={(event) => {
        if (event.currentTarget.open && sections === null) void load();
      }}
    >
      <summary className="-my-3 cursor-pointer py-3 text-sm font-semibold text-ink">
        <span className="inline-flex items-center gap-2">
          <Icon name="layout" size={17} />
          Saved sections
        </span>
      </summary>
      <p className="mt-2 text-xs text-ink-soft">
        Keep a group of blocks under a name and put it on any of your pages. Change it on one page, then update it everywhere it is used, after seeing which pages those are. Pictures stay on the page that shows them.
      </p>
      {note ? <p className="notice notice-error mt-3 text-sm" role="alert">{note}</p> : null}

      {sections === null ? (
        <p className="mt-3 text-sm text-ink-soft">Loading…</p>
      ) : (
        <>
          <p className="field-label mt-4">{`Your library (${sections.length} of ${limit})`}</p>
          {sections.length === 0 ? <p className="text-sm text-ink-soft">Nothing saved yet.</p> : null}
          <ul className="mt-1 space-y-2">
            {sections.map((section) => {
              const fits = fitsPage(section, allowed);
              const here = blocks.some((block) => block.saved === section.id);
              return (
                <li key={section.id} className="rounded-[12px] bg-white px-3 py-2.5 text-sm ring-1 ring-line">
                  <p className="font-semibold text-ink">{section.name}</p>
                  <p className="mt-0.5 text-xs text-ink-mute">{section.blocks.map((block) => label(block.kind)).join(" · ")}</p>
                  {!fits ? <p className="mt-1 text-xs text-ink-soft">It has a block this page cannot hold.</p> : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={disabled || busy || !fits || section.blocks.length > room}
                      onClick={() => {
                        onInsert(blocksForPage(section));
                        toast("Section added at the end. Save the page to keep it.");
                      }}
                    >
                      <Icon name="plus" size={16} />
                      Add to this page
                    </button>
                    {here ? (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || busy} onClick={() => void updateFromHere(section)}>
                        <Icon name="refresh" size={16} />
                        Update the saved section from this page
                      </button>
                    ) : null}
                    {removing === section.id ? (
                      <span className="flex items-center gap-2 text-xs text-ink-soft">
                        Pages keep their blocks.
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={busy}
                          onClick={async () => {
                            if (await send({ action: "remove", id: section.id })) {
                              setRemoving(null);
                              toast("Section removed from the library.");
                              await load();
                            }
                          }}
                        >
                          Yes, remove
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemoving(null)}>Keep it</button>
                      </span>
                    ) : (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRemoving(section.id)}>Remove</button>
                    )}
                  </div>
                  {uses?.id === section.id ? (
                    <div className="mt-3 rounded-[12px] bg-paper p-3 ring-1 ring-line">
                      {uses.list.length === 0 ? (
                        <p className="text-sm text-ink-soft">No other page uses it.</p>
                      ) : (
                        <>
                          <p className="text-sm font-semibold text-ink">Also update these pages?</p>
                          <ul className="mt-2 space-y-1.5">
                            {uses.list.map((use) => (
                              <li key={use.key}>
                                <label className="flex min-h-11 items-start gap-2 text-sm text-ink" htmlFor={`ss-${use.key}`}>
                                  <input
                                    id={`ss-${use.key}`}
                                    type="checkbox"
                                    className="mt-1 h-5 w-5"
                                    disabled={Boolean(use.why)}
                                    checked={uses.checked.includes(use.key)}
                                    onChange={(e) => setUses((u) => (u ? { ...u, checked: e.target.checked ? [...u.checked, use.key] : u.checked.filter((k) => k !== use.key) } : u))}
                                  />
                                  <span>
                                    {`${use.title} `}
                                    <span className="text-ink-mute">{use.site ? "(your page)" : "(product page)"}</span>
                                    {use.why ? <span className="block text-xs text-ink-soft">{use.why}</span> : null}
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button type="button" className="btn btn-primary btn-sm" disabled={busy || uses.checked.length === 0} onClick={() => void apply()}>
                              {`Update ${uses.checked.length} ${uses.checked.length === 1 ? "page" : "pages"}`}
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setUses(null)}>Leave them as they are</button>
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {picking ? (
            <div className="mt-4 rounded-[12px] bg-white p-3 ring-1 ring-line">
              <p className="text-sm font-semibold text-ink">{`Check the blocks to save, up to ${MAX_SECTION_BLOCKS}`}</p>
              <ul className="mt-2 space-y-1">
                {offered.map((block) => (
                  <li key={block.id}>
                    <label className="flex min-h-11 items-center gap-2 text-sm text-ink" htmlFor={`sp-${block.id}`}>
                      <input
                        id={`sp-${block.id}`}
                        type="checkbox"
                        className="h-5 w-5"
                        checked={chosen.includes(block.id)}
                        disabled={!chosen.includes(block.id) && chosen.length >= MAX_SECTION_BLOCKS}
                        onChange={(e) => setChosen((c) => (e.target.checked ? [...c, block.id] : c.filter((id) => id !== block.id)))}
                      />
                      {`${label(block.kind)}${headingOf(block) ? `: ${headingOf(block)}` : ""}`}
                    </label>
                  </li>
                ))}
              </ul>
              <label className="mt-3 block" htmlFor="ss-name">
                <span className="field-label">Name, for you</span>
                <input id="ss-name" type="text" className="field" maxLength={MAX_SECTION_NAME} value={name} placeholder="Questions buyers ask" onChange={(e) => setName(e.target.value)} />
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || !name.trim() || chosen.length === 0} onClick={() => void saveNew()}>
                  Save the section
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPicking(false); setChosen([]); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm mt-4" disabled={disabled || busy || offered.length === 0 || sections.length >= limit} onClick={() => setPicking(true)}>
              <Icon name="plus" size={16} />
              Save blocks of this page as a section
            </button>
          )}
          {sections.length >= limit && limit > 0 ? <p className="mt-2 text-xs text-ink-soft">{`Your store can keep ${limit} ${limit === 1 ? "section" : "sections"}. Remove one to save another.`}</p> : null}
        </>
      )}
    </details>
  );
}
