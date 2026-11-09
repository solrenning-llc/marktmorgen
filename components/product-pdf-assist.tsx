"use client";

import { useEffect, useRef, useState } from "react";
import { AiStepsAssist } from "@/components/ai-steps-assist";
import { READ_PDF_JOBS } from "@/lib/ai-rules";
import { MAX_ABOUT_LENGTH } from "@/lib/product-about";
import { PDF_ASSIST_COPY, type PdfProposal, pdfAssistSteps, readProposal, withBenefits } from "@/lib/product-pdf-assist-rules";

type Fields = { title: string; summary: string; about: string };

const isProposal = (value: unknown): value is PdfProposal => readProposal(value) !== null;

/**
 * "Suggest a title and benefits from your PDF" in the form that changes a
 * product with a PDF to read (758 [STN5], unit 4; lib/product-pdf-assist.ts).
 * The step-by-step box reads the PDF's first pages, then writes; what comes
 * back fills the form's name and short description, and puts the benefits
 * in front of the full description, never cutting what the creator wrote. A
 * name or short description that did not stick to the PDF is left as it was,
 * and said so. "Put back what was there" restores all three boxes. It saves
 * nothing: the creator reads, changes anything and presses the form's Save.
 */
export function ProductPdfAssist({ productId, fields, onChange }: { productId: string; fields: Fields; onChange: (next: Fields) => void }) {
  const [before, setBefore] = useState<Fields | null>(null);
  const [status, setStatus] = useState("");
  // What the boxes hold now, read when the draft arrives rather than when it was asked for.
  // The same for the form's own change, so what was typed meanwhile in the other boxes is kept.
  const latest = useRef(fields);
  const change = useRef(onChange);
  useEffect(() => {
    latest.current = fields;
    change.current = onChange;
  }, [fields, onChange]);

  function fill(proposal: PdfProposal) {
    const now = latest.current;
    const about = withBenefits(now.about, proposal.benefits, MAX_ABOUT_LENGTH);
    // The undo puts back what the boxes had before the first suggestion used, not one used before this one.
    setBefore((kept) => kept ?? now);
    change.current({ title: proposal.title ?? now.title, summary: proposal.summary ?? now.summary, about: about ?? now.about });
    setStatus(
      [proposal.title === null ? PDF_ASSIST_COPY.keptTitle : "", proposal.summary === null ? PDF_ASSIST_COPY.keptSummary : "", about === null ? PDF_ASSIST_COPY.tooLong : ""]
        .filter(Boolean)
        .join(" "),
    );
  }

  function undo() {
    if (!before) return;
    change.current(before);
    setBefore(null);
    setStatus(PDF_ASSIST_COPY.undone);
  }

  return (
    <div className="space-y-2">
      <AiStepsAssist<PdfProposal>
        title={PDF_ASSIST_COPY.title}
        hint={`${PDF_ASSIST_COPY.hint} It takes ${1 + READ_PDF_JOBS} of your writing jobs.`}
        placeholder={PDF_ASSIST_COPY.placeholder}
        allowEmpty
        payload={() => ({ kind: "product-pdf", product: productId })}
        steps={pdfAssistSteps()}
        validateResult={isProposal}
        messages={{ file: PDF_ASSIST_COPY.file }}
        onResult={fill}
        done={PDF_ASSIST_COPY.done}
      />
      <p className="text-sm text-ink" role="status" aria-live="polite">
        {status}
      </p>
      {before ? (
        <button type="button" className="btn btn-ghost btn-sm inline-flex min-h-11 items-center" onClick={undo}>
          {PDF_ASSIST_COPY.undo}
        </button>
      ) : null}
    </div>
  );
}
