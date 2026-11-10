"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";

/** Characters as a reader counts them: one emoji is one (the same count lib/course-next-step-rules.ts holds). */
function counted(text: string): number {
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text.replace(/\s+/g, " ").trim())].length;
}

/**
 * The course's "Next step" in the studio (560 [AS1], unit 3): one product of
 * the store to suggest when a student is ready for more, and the creator's
 * own line. Nothing is shown to students without it, and no AI picks for the
 * creator. What the line may say is checked by the server, which answers with
 * the reason in plain words; the words are never cut or changed. The rules
 * are not loaded here (lib/course-next-step-rules.ts), so this page carries
 * none of the words they check.
 */
export function CourseNextStep({
  productId,
  current,
  choices,
  maxLine,
}: {
  productId: string;
  current: { productId: string; line: string } | null;
  /** The store's other products, by title, to pick from. */
  choices: { id: string; title: string }[];
  /** The most characters the line may have (MAX_NEXT_STEP_LINE). */
  maxLine: number;
}) {
  const id = useId();
  const router = useRouter();
  const [picked, setPicked] = useState(current?.productId ?? "");
  const [line, setLine] = useState(current?.line ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = picked !== (current?.productId ?? "") || line.trim() !== (current?.line ?? "");
  const used = counted(line);
  const over = used > maxLine;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/course", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: productId, action: "next-step", productId: picked, line: picked ? line : "" }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!data.ok) {
        setError(data.error === "next_step" && data.message ? data.message : "That could not be saved just now. Try again in a moment.");
        return;
      }
      toast(picked ? "Saved. Students see this next step on the course and after its last lesson." : "Saved. No next step is shown.");
      router.refresh();
    } catch {
      setError("That could not be saved just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-4 grid max-w-2xl gap-4" data-next-step-form="">
      <label className="block" htmlFor={`${id}-product`}>
        <span className="field-label">Product to suggest next</span>
        <select id={`${id}-product`} className="field mt-1" value={picked} onChange={(e) => setPicked(e.target.value)} aria-describedby={`${id}-product-help`}>
          <option value="">None: show no next step</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.title}
            </option>
          ))}
        </select>
        <span id={`${id}-product-help`} className="mt-1 block text-sm text-ink-soft">
          Students who already have it, or said &quot;No thanks&quot;, never see it. Nor does anyone while it is a draft or sold out.
        </span>
      </label>
      {picked ? (
        <label className="block" htmlFor={`${id}-line`}>
          <span className="field-label">Your line (optional)</span>
          <textarea
            id={`${id}-line`}
            className="field mt-1"
            rows={2}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            aria-describedby={`${id}-line-help ${id}-line-count`}
            aria-invalid={over || undefined}
            placeholder="When you are ready, go deeper with the advanced course."
          />
          <span id={`${id}-line-help`} className="mt-1 block text-sm text-ink-soft">
            One calm sentence in your own words. The card already shows the product and its price. Leave out discounts, numbers,
            quotes, links and words that rush, like &quot;now&quot; or &quot;last&quot;.
          </span>
          <span id={`${id}-line-count`} className={`mt-1 block text-sm ${over ? "font-semibold text-danger" : "text-ink-soft"}`}>
            {`${used} of ${maxLine} characters`}
          </span>
        </label>
      ) : null}
      {dirty ? (
        <p>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || over} aria-busy={busy}>
            Save
          </button>
        </p>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
