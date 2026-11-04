"use client";

import { useContext, useState } from "react";
import { Icon } from "@/components/icons";
import { AiOn } from "@/components/ai-assist";
import type { SalesPage } from "@/lib/sales-page";
import { type LeftBlock, MAX_TRANSLATE_PARTS, pageWords, translateParts } from "@/lib/page-translate";
import { LANGUAGES, LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";

const MESSAGES: Record<string, string> = {
  notes: "There are no words on this page to translate yet.",
  long: `This page is too long to translate at once. Translate a shorter page, or remove a few blocks first.`,
  used: "Not enough of this month's writing help is left for this page. It starts again with your next billing month.",
  slow: "A few at a time: wait a minute, then try again.",
  failed: "The translation did not come back just now. Your content was not changed. Started attempts count toward the monthly allowance. Try again in a moment.",
  off: "The writing help is not available right now.",
  forbidden: "Your role on this store cannot do this.",
};

/**
 * The whole page put into another language at once (added 9 October 2026;
 * lib/ai.ts, translatePage): every heading, paragraph, point, question,
 * button, cell and picture description, the search title and line, and a
 * headline being tested. A page copied from a product sold in another
 * language, or a store that changes its language, is turned into the one it
 * sells in with one press. Nothing is
 * saved: the words replace those in the editor, Undo puts them back, and
 * Save keeps them.
 *
 * Says before it runs how many of the month's jobs the page takes, from the
 * same split the server makes.
 */
export function TranslatePage({
  productId,
  storeLanguage,
  page,
  onResult,
  kindName,
  onGo,
}: {
  productId: string;
  storeLanguage: LanguageCode;
  /** The page as it stands in the editor, read when the button is pressed. */
  page: () => SalesPage;
  /**
   * The translated page and the page that was sent. True when it was put in
   * the editor; false when the editor no longer holds what was sent.
   */
  onResult: (page: SalesPage, sent: SalesPage) => boolean;
  /** A block kind's name in the editor ("Booking", "Columns"), to say which block was left as it was. */
  kindName: (kind: LeftBlock["kind"]) => string;
  /** Opens that block in the editor, its version brought to the front, and puts the focus in it. */
  onGo: (block: LeftBlock) => void;
}) {
  const { on, left: startLeft } = useContext(AiOn);
  const [to, setTo] = useState<LanguageCode>(storeLanguage);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  // The blocks the last translation left as they were, named and reachable (inbox C4-29).
  const [leftBlocks, setLeftBlocks] = useState<LeftBlock[]>([]);
  const [left, setLeft] = useState(startLeft);
  if (!on) return null;
  const parts = translateParts(pageWords(page())).length;

  async function run() {
    setBusy(true);
    setNote(null);
    setLeftBlocks([]);
    const sent = page();
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "translate", product: productId, language: to, page: sent }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: { page?: SalesPage; untranslated?: number; left?: LeftBlock[] }; left?: number; error?: string };
      if (data.ok && data.value?.page) {
        if (typeof data.left === "number") setLeft(data.left);
        const applied = onResult(data.value.page, sent);
        setLeftBlocks(applied && Array.isArray(data.value.left) ? data.value.left : []);
        // A block whose translated words would not fit came back as it was (lib/page-translate.ts, keepEveryBlock): said, never hidden.
        const kept = typeof data.value.untranslated === "number" && data.value.untranslated > 0 ? data.value.untranslated : 0;
        const keptWords = kept
          ? ` ${kept === 1 ? "One block was" : `${kept} blocks were`} left in the old language, because the translated words were too long for ${kept === 1 ? "it" : "them"}: change ${kept === 1 ? "it" : "them"} by hand, listed below.`
          : "";
        setNote(
          applied
            ? { error: false, text: `Translated into ${LANGUAGES[to].english}.${keptWords} Read it through, then press Save. Undo puts the words back as they were.` }
            : { error: true, text: "The page changed while it was being translated, so nothing was replaced. Translate it again." },
        );
        return;
      }
      setNote({ error: true, text: MESSAGES[data.error ?? ""] ?? MESSAGES.failed });
    } catch {
      setNote({ error: true, text: MESSAGES.failed });
    } finally {
      setBusy(false);
    }
  }

  const tooLong = parts > MAX_TRANSLATE_PARTS;
  return (
    <details className="rounded-2xl border border-violet-brand/25 bg-lilac/40 px-4 py-3">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-violet-deep">
        <Icon name="globe" size={16} />
        Translate the whole page with AI
      </summary>
      <div className="mt-2 space-y-3 pb-1">
        <p className="text-sm text-ink-soft">
          Every heading, paragraph, point, question, button and picture description, and the page&apos;s title for search engines, in one step. Names, numbers and prices stay as they are; nothing is added. It replaces the words here; nothing is saved until you press Save.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="field-label">Into</span>
            <select className="field" value={to} onChange={(e) => setTo(e.target.value as LanguageCode)}>
              {LANGUAGE_CODES.map((code) => (
                <option key={code} value={code}>
                  {`${LANGUAGES[code].english}${code === storeLanguage ? " (your store's language)" : ""}`}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void run()} disabled={busy || parts === 0 || tooLong || left < parts} aria-busy={busy}>
            {busy ? "Translating…" : "Translate"}
          </button>
        </div>
        <p className="text-xs text-ink-soft">
          {parts === 0
            ? "Add a few blocks first."
            : tooLong
              ? MESSAGES.long
              : `This page takes ${parts} of your writing ${parts === 1 ? "job" : "jobs"} · ${left} left this month`}
        </p>
        {note ? (
          <p className={note.error ? "notice notice-error text-sm" : "text-sm font-semibold text-ink"} role={note.error ? "alert" : "status"}>
            {note.text}
          </p>
        ) : null}
        {leftBlocks.length ? (
          <ul className="space-y-1" aria-label="Blocks left in the old language">
            {leftBlocks.map((block) => {
              const where = `${kindName(block.kind)}, ${ordinal(block.at + 1)} block${block.b ? " of the second version" : ""}`;
              return (
                <li key={`${block.b ? "b" : "a"}-${block.id}`}>
                  <button type="button" className="inline-flex min-h-11 items-center text-sm font-semibold text-violet-deep underline underline-offset-4" onClick={() => onGo(block)}>
                    Go to {where}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

/** 1st, 2nd, 3rd, 4th…, 11th, 12th, 13th, 21st: a block's place, as the creator counts it. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}
