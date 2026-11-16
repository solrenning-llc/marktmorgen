"use client";

import { useRef, useState } from "react";
import { shrink } from "@/components/shrink-image";
import { IMAGE_ACCEPT, MAX_SOURCE_BYTES } from "@/lib/product-image";
import { MAX_REVIEW_PHOTO_BYTES, REVIEW_PHOTO_SIDE } from "@/lib/review-summary";

/**
 * A photo on a review (lib/review-photo.ts): picked here, shrunk in the
 * buyer's browser to REVIEW_PHOTO_SIDE and MAX_REVIEW_PHOTO_BYTES, and sent
 * with the review's form as text in a hidden field, so the form stays a plain
 * form. Without JavaScript the field is simply not there.
 */
export function ReviewPhotoField({
  id,
  existing,
  words,
}: {
  id: string;
  /** The photo already on the review, by its address. */
  existing: string | null;
  words: { label: string; hint: string; remove: string; yours: string; problem: string };
}) {
  const input = useRef<HTMLInputElement>(null);
  const [data, setData] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);

  async function choose(file: File | undefined) {
    setProblem(false);
    if (!file) return;
    if (file.size > MAX_SOURCE_BYTES) {
      setProblem(true);
      return;
    }
    setBusy(true);
    try {
      const shrunk = await shrink(file, REVIEW_PHOTO_SIDE, MAX_REVIEW_PHOTO_BYTES);
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(shrunk.blob);
      });
      setData(text);
      setPreview(text);
      setRemove(false);
    } catch {
      setProblem(true);
      setData("");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const shown = preview ?? (remove ? null : existing);
  return (
    <div>
      <label htmlFor={id} className="st-label">{words.label}</label>
      <input ref={input} id={id} type="file" accept={IMAGE_ACCEPT} onChange={(e) => choose(e.target.files?.[0])} className="st-field mt-1" aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="st-muted mt-1 text-xs">{words.hint}</p>
      <input type="hidden" name="photo" value={data} />
      <input type="hidden" name="photo_remove" value={remove ? "yes" : ""} />
      {busy ? <p className="st-muted mt-2 text-sm" role="status">…</p> : null}
      {problem ? <p className="st-note mt-2 text-sm" role="alert">{words.problem}</p> : null}
      {shown ? (
        <div className="mt-3 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shown} alt={words.yours} width={80} height={80} className="h-20 w-20 rounded-xl object-cover" />
          <button
            type="button"
            onClick={() => {
              setData("");
              setPreview(null);
              setRemove(Boolean(existing));
              if (input.current) input.current.value = "";
            }}
            className="st-footer-link text-sm font-semibold underline underline-offset-4"
          >
            {words.remove}
          </button>
        </div>
      ) : null}
    </div>
  );
}
