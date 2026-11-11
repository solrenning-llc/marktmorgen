"use client";

import { useContext, useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { AI_ALLOWANCE_UNKNOWN, AiOn, allowanceOf } from "@/components/ai-assist";
import { FILLABLE, REWRITABLE, REWRITE_STYLES, type RewriteStyle, blockText } from "@/lib/block-rewrite-rules";
import type { PageBlock, SalesPage } from "@/lib/sales-page";

const MESSAGES: Record<string, string> = {
  used: "This month's writing help is used up. It starts again with your next billing month.",
  slow: "A few at a time: wait a minute, then try again.",
  failed: "That rewrite did not come back, or it tried to add something your page does not say, so it was not used. Started attempts count toward the monthly allowance. Try again, or another way.",
  unwritten: "That draft did not come back, or it tried to add something your product and page do not say, so it was not used. Started attempts count toward the monthly allowance. Add a few words to the product's description, then try again.",
  off: "The writing help is not available right now.",
  forbidden: "Your role on this store cannot do this.",
  notes: "Write something in this block first: it rewrites your words, it does not start from nothing.",
  changed: "You changed this block while it was being rewritten, so your words were kept and the rewrite was not used. Started attempts count toward the monthly allowance.",
};

/**
 * "Improve with AI" under one block of a sales page (lib/block-rewrite-rules.ts):
 * four ways to rewrite the creator's own words, and Undo. It changes the block
 * in the editor only; nothing is saved until the page's own Save.
 */
export function BlockRewrite({
  productId,
  block,
  page,
  onChange,
}: {
  productId: string;
  block: PageBlock;
  /** The page as it stands in the editor, for context. */
  page: () => SalesPage;
  onChange: (block: PageBlock) => void;
}) {
  const ai = useContext(AiOn);
  const [busy, setBusy] = useState<RewriteStyle | "fill" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [before, setBefore] = useState<PageBlock | null>(null);
  // The block as the AI left it: Undo is offered only while the block is still exactly that, so it never throws
  // away words typed after the rewrite.
  const [applied, setApplied] = useState<string | null>(null);
  // The block as the editor holds it now, read when a rewrite comes back.
  const latest = useRef(block);
  latest.current = block;
  const [left, setLeft] = useState(allowanceOf(ai));
  const allowanceId = useId();
  // An allowance that could not be read (null) keeps the buttons off and is said in words, never "0 left".
  const spent = left === null || left <= 0;
  if (!ai.on || !REWRITABLE.includes(block.kind)) return null;
  const empty = !blockText(block).trim();

  const fillable = FILLABLE.includes(block.kind);

  async function run(style: RewriteStyle | "fill") {
    setBusy(style);
    setError(null);
    const sent = JSON.stringify(block);
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(style === "fill" ? { kind: "fill", product: productId, block, page: page() } : { kind: "block", product: productId, style, block, page: page() }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: PageBlock; left?: number; error?: string };
      if (data.ok && data.value) {
        if (typeof data.left === "number") setLeft(data.left);
        // Typed in while it ran: the creator's words win, and the rewrite is not used.
        if (JSON.stringify(latest.current) !== sent) {
          setError(MESSAGES.changed);
          return;
        }
        setBefore(block);
        setApplied(JSON.stringify(data.value));
        onChange(data.value);
        return;
      }
      setError(MESSAGES[data.error ?? ""] ?? (style === "fill" ? MESSAGES.unwritten : MESSAGES.failed));
    } catch {
      setError(MESSAGES.failed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-violet-brand/20 bg-lilac/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-violet-deep">
          <Icon name="sparkle" size={15} />
          Improve with AI
        </span>
        {empty && fillable ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null || spent} aria-busy={busy === "fill"} aria-describedby={allowanceId} onClick={() => void run("fill")}>
            {busy === "fill" ? "Writing…" : "Write it with AI"}
          </button>
        ) : null}
        {(empty && fillable ? [] : REWRITE_STYLES).map((style) => (
          <button
            key={style.id}
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy !== null || empty || spent}
            aria-busy={busy === style.id}
            aria-describedby={allowanceId}
            onClick={() => void run(style.id)}
          >
            {busy === style.id ? "Rewriting…" : style.label}
          </button>
        ))}
        {before && applied === JSON.stringify(block) ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              onChange(before);
              setBefore(null);
              setApplied(null);
            }}
          >
            <Icon name="refresh" size={14} />
            Undo
          </button>
        ) : null}
        <span id={allowanceId} className="ml-auto text-xs text-ink-soft">{left === null ? AI_ALLOWANCE_UNKNOWN : `${left} left this month`}</span>
      </div>
      {error ? (
        <p className="notice notice-error mt-2 text-sm" role="alert">
          {error}
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-ink-soft" role="status">
          {before
            ? "Written in your store's language. Read it before you save; Undo puts it back as it was."
            : empty && fillable
              ? "A first draft from your product's description and the rest of this page. It adds no number or promise they do not already make."
              : empty
                ? "Write something here first, and it can rewrite it four ways."
              : "Your words, said another way, in your store's language. It adds no number or promise your page does not already make."}
        </p>
      )}
    </div>
  );
}
