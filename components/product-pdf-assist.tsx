"use client";

import { useEffect, useRef, useState } from "react";
import { AiStepsAssist } from "@/components/ai-steps-assist";
import { READ_PDF_JOBS } from "@/lib/ai-rules";
import { MAX_ABOUT_LENGTH } from "@/lib/product-about";
import { type AboutState, PDF_ASSIST_COPY, type PdfProposal, benefitsList, pdfAssistSteps, readProposal, withBenefits, withoutList } from "@/lib/product-pdf-assist-rules";

type Fields = { title: string; summary: string; about: string };

const isProposal = (value: unknown): value is PdfProposal => readProposal(value) !== null;

/**
 * "Suggest a title and benefits from your PDF" in the form that changes a
 * product with a PDF to read (758 [STN5], unit 4; lib/product-pdf-assist.ts).
 * The step-by-step box reads the PDF's first pages, then writes; what comes
 * back fills the form's name and short description, and puts the benefits
 * in front of the full description, never cutting what the creator wrote; a
 * second suggestion replaces the list the first one put there. A name or
 * short description that did not stick to the PDF is left as it was, and
 * said so. "Put back what was there" restores all three boxes and moves the
 * focus to what was said. It saves nothing: the creator reads, changes
 * anything and presses the form's Save.
 *
 * It is offered only once the form holds the full description: while that is
 * still being read, or could not be read, the box is not drawn, because what
 * it puts in front of the description would then be saved in its place.
 */
export function ProductPdfAssist({
  productId,
  fields,
  aboutState,
  onChange,
}: {
  productId: string;
  fields: Fields;
  /** Whether the form holds the full description yet (components/product-editor.tsx, loadingAbout and aboutUnread). */
  aboutState: AboutState;
  onChange: (next: Fields) => void;
}) {
  const [before, setBefore] = useState<Fields | null>(null);
  const [status, setStatus] = useState("");
  // The list this box put in front of the description, so the next suggestion replaces it instead of adding another.
  const inserted = useRef<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  // What the boxes hold now, read when the draft arrives rather than when it was asked for.
  // The same for the form's own change, so what was typed meanwhile in the other boxes is kept.
  const latest = useRef(fields);
  const change = useRef(onChange);
  useEffect(() => {
    latest.current = fields;
    change.current = onChange;
  }, [fields, onChange]);

  function fill(proposal: PdfProposal) {
    const now = { ...latest.current };
    const about = withBenefits(withoutList(now.about, inserted.current), proposal.benefits, MAX_ABOUT_LENGTH);
    if (about !== null) inserted.current = benefitsList(proposal.benefits);
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
    inserted.current = null;
    setBefore(null);
    setStatus(PDF_ASSIST_COPY.undone);
    // The button goes away: the focus moves to what was said, never to the top of the page.
    statusRef.current?.focus();
  }

  if (aboutState !== "ready") {
    return <p className="text-sm text-ink-soft">{aboutState === "loading" ? PDF_ASSIST_COPY.aboutLoading : PDF_ASSIST_COPY.aboutUnread}</p>;
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
        messages={{ file: PDF_ASSIST_COPY.file, empty: PDF_ASSIST_COPY.empty }}
        onResult={fill}
        done={PDF_ASSIST_COPY.done}
      />
      <p ref={statusRef} tabIndex={-1} className="text-sm text-ink" role="status" aria-live="polite">
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
