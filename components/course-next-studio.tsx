"use client";

/**
 * 299 [H5-2], in the studio: the one product suggested to a student once they
 * finish the course. A native select and a Save button, so it works by
 * keyboard, touch, mouse and voice alike; nothing changes until Save.
 */
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";

type Pick = { id: string; title: string };

export function CourseNextStudio({ productId, saved, options }: { productId: string; saved: string; options: Pick[] }) {
  const id = useId();
  const router = useRouter();
  const [chosen, setChosen] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/course", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: productId, action: "next", product: chosen }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!data.ok) {
        setError(
          data.error === "store_full"
            ? (data.message ?? "Your store has no room left. Nothing changed. Make room, then save again.")
            : data.error === "busy"
              ? "This course is being changed somewhere else right now. Nothing changed. Try again in a moment."
              : "The suggestion could not be saved just now. Nothing changed. Try again in a moment.",
        );
        return;
      }
      toast(chosen ? "Saved. Students who finish now see this suggestion." : "Saved. No product is suggested.");
      router.refresh();
    } catch {
      setError("The suggestion could not be saved just now. Nothing changed. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <label htmlFor={`${id}-next`} className="field-label">Suggest after finishing</label>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <select id={`${id}-next`} value={chosen} onChange={(e) => setChosen(e.target.value)} disabled={busy} className="field max-w-sm">
          <option value="">No suggestion</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.title}</option>
          ))}
        </select>
        {chosen !== saved ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy} aria-busy={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>
      {error ? <p role="alert" className="mt-3 text-sm font-semibold text-danger-text">{error}</p> : null}
    </div>
  );
}
