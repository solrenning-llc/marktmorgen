"use client";

import { useRef, useState } from "react";
import type { Source } from "@/lib/csv-map-ai-rules";

/** A field of the import, as the import screen lists it. */
export type SuggestField = { key: string; label: string };

type Suggestion = { field: string; column: number };

/** What the route's refusals mean, in plain words. */
export const SUGGEST_MESSAGES: Readonly<Record<string, string>> = {
  off: "AI suggestions come with the Studio and Scale plans, paid and up to date. Choose the columns yourself below.",
  not_needed: "Every column already has a match. Check them below.",
  no_header: "The first row of this file does not look like column names, so nothing was sent to the AI. Choose the columns yourself below.",
  cost_unknown: "The AI suggestion could not be priced, so it was not asked. Choose the columns yourself below.",
  failed: "The AI suggestion could not be made just now. Choose the columns yourself, or try again in a moment.",
  unreadable: "The AI's answer could not be read, so nothing was suggested. Choose the columns yourself below.",
  slow: "You asked for several suggestions in a short time. Try again in a few minutes.",
  none: "The AI found no column for the fields still open. Choose them yourself below, or leave the optional ones out.",
};

/**
 * "Suggest the open columns with AI" on the import screen (lib/csv-map-ai.ts,
 * app/api/store/import-columns). Only the file's column names are sent, never
 * a cell. Each suggestion waits for the creator: "Use this column" sets that
 * one field (onUse), "Not this one" drops it; nothing changes otherwise, and
 * a field the creator has set meanwhile is never suggested over.
 *
 * Each button's accessible name is its visible text (WCAG 2.5.3); what it
 * acts on is its description, the suggestion's own line (aria-describedby).
 * After a choice the focus goes to the next suggestion's "Use this column",
 * or to the summary when none is left, never to the page (2.4.3). While the
 * request runs, the button stays focusable and says so (aria-disabled), and
 * a second press does nothing.
 */
export function ImportColumnSuggest({
  kind,
  header,
  fields,
  mapping,
  onUse,
}: {
  kind: string;
  header: string[];
  fields: SuggestField[];
  mapping: Record<string, number>;
  onUse: (field: string, column: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const useButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const summary = useRef<HTMLParagraphElement | null>(null);
  const open = fields.filter((f) => (mapping[f.key] ?? -1) < 0);
  // A suggestion is shown only while its field is still open: the creator's own choice always wins.
  const shown = suggestions.filter((s) => (mapping[s.field] ?? -1) < 0 && s.column >= 0 && s.column < header.length);
  const lineId = (field: string) => `suggest-${kind}-${field}`;

  async function ask() {
    if (busy) return;
    setBusy(true);
    setNote("");
    setSuggestions([]);
    try {
      const guess = Object.fromEntries(fields.map((f) => [f.key, mapping[f.key] ?? -1]));
      const response = await fetch("/api/store/import-columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, header, guess }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; columns?: Record<string, { column: number; from: Source }> } | null;
      if (!data?.ok || !data.columns) {
        setNote(SUGGEST_MESSAGES[data?.error ?? ""] ?? SUGGEST_MESSAGES.failed);
        return;
      }
      const found = Object.entries(data.columns)
        .filter(([, c]) => c.from === "ai")
        .map(([field, c]) => ({ field, column: c.column }));
      setSuggestions(found);
      setNote(found.length ? `${found.length === 1 ? "One suggestion" : `${found.length} suggestions`} below. Nothing changes until you choose "Use this column".` : SUGGEST_MESSAGES.none);
    } catch {
      setNote(SUGGEST_MESSAGES.failed);
    } finally {
      setBusy(false);
    }
  }

  function settle(field: string, use: boolean) {
    const s = suggestions.find((x) => x.field === field);
    const at = shown.findIndex((x) => x.field === field);
    const rest = shown.filter((x) => x.field !== field);
    // The next suggestion in the list, else the one before it; with none left, the summary.
    const next = rest[Math.min(Math.max(at, 0), rest.length - 1)]?.field ?? null;
    setSuggestions((all) => all.filter((x) => x.field !== field));
    const label = fields.find((f) => f.key === field)?.label ?? field;
    if (use && s) {
      onUse(field, s.column);
      setNote(`${label} now reads from the column "${header[s.column] || `Column ${s.column + 1}`}".`);
    } else {
      setNote(`${label} is still yours to choose.`);
    }
    requestAnimationFrame(() => (next ? useButtons.current[next] : summary.current)?.focus());
  }

  if (open.length === 0 && shown.length === 0 && !note) return null;
  return (
    <section className="rounded-2xl bg-white p-4 ring-1 ring-line" aria-labelledby={`suggest-${kind}`}>
      <h3 id={`suggest-${kind}`} className="text-sm font-bold text-ink">
        Not sure which column is which?
      </h3>
      <p className="mt-1 text-sm text-ink-soft">
        AI can suggest a column for each field that has none yet. Only the column names are sent, never what is in the rows. Nothing changes until you choose
        &ldquo;Use this column&rdquo; for each one.
      </p>
      {open.length > 0 ? (
        <button type="button" onClick={ask} aria-disabled={busy} aria-busy={busy} className="btn btn-ghost btn-sm mt-3">
          {busy ? "Asking for suggestions…" : "Suggest the open columns with AI"}
        </button>
      ) : null}
      <p ref={summary} tabIndex={-1} role="status" className="mt-3 text-sm text-ink">
        {note}
      </p>
      {shown.length > 0 ? (
        <ul className="mt-2 grid gap-3">
          {shown.map((s) => {
            const label = fields.find((f) => f.key === s.field)?.label ?? s.field;
            const name = header[s.column] || `Column ${s.column + 1}`;
            return (
              <li key={s.field} className="rounded-xl p-3 ring-1 ring-line">
                <p id={lineId(s.field)} className="text-sm text-ink">
                  <strong>{label}</strong>: the column &ldquo;{name}&rdquo; <span className="text-ink-soft">(suggested by AI, not checked yet)</span>
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    ref={(el) => {
                      useButtons.current[s.field] = el;
                    }}
                    onClick={() => settle(s.field, true)}
                    className="btn btn-primary btn-sm"
                    aria-describedby={lineId(s.field)}
                  >
                    Use this column
                  </button>
                  <button type="button" onClick={() => settle(s.field, false)} className="btn btn-ghost btn-sm" aria-describedby={lineId(s.field)}>
                    Not this one
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
