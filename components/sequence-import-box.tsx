"use client";

import { useId, useMemo, useRef, useState } from "react";
import { MAX_SEQUENCE_FILE_BYTES, SEQUENCE_TEMPLATE, sequenceTemplateCsv } from "@/lib/sequence-template";

export type ImportedStep = { delayHours: number; subject: string; body: string };
export type ImportReportLine = { line: number; column: string; reason: string };

/** One line of the report, as the creator reads it. */
export function reportWords(r: ImportReportLine): string {
  return `${r.line ? `Line ${r.line}` : "The file"}${r.column !== "file" ? `, ${r.column}` : ""}: ${r.reason}`;
}

const FAILED = "The file could not be read just now. Nothing was changed; try again in a moment.";

/**
 * "Bring in a sequence" (544 [SQ9], unit 2): the creator picks a CSV of the
 * emails they wrote for another service, in the template's columns. It is
 * read on the server (lib/sequence-import.ts) and comes back as the emails of
 * a new sequence in the studio's own editor, with a report of everything left
 * out or changed. Nothing is saved, sent or switched on here: the creator
 * picks what starts it, reads every email and saves it, paused.
 */
export function SequenceImportBox({
  disabled,
  onRead,
  describe,
}: {
  disabled: boolean;
  /** The emails read, and the report, which the editor keeps showing until the sequence is saved or closed. */
  onRead: (steps: ImportedStep[], report: ImportReportLine[]) => void;
  /** The studio's own words for a refusal (signed out, no Pro, no permission), or null for none. */
  describe: (error: string) => string | null;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReportLine[]>([]);
  const template = useMemo(() => `data:text/csv;charset=utf-8,${encodeURIComponent(sequenceTemplateCsv())}`, []);

  async function read() {
    if (!file || busy || disabled) return;
    setError(null);
    setReport([]);
    if (file.size > MAX_SEQUENCE_FILE_BYTES) {
      setError(`The file is larger than ${MAX_SEQUENCE_FILE_BYTES / 1000} KB. Split it into two sequences, or keep the emails' text only.`);
      return;
    }
    setBusy(true);
    try {
      const csv = await file.text();
      const response = await fetch("/api/store/mail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "flow-import", csv }) });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; steps?: ImportedStep[]; report?: ImportReportLine[] } | null;
      const lines = Array.isArray(data?.report) ? data.report : [];
      if (!response.ok || data?.ok !== true || !Array.isArray(data.steps)) {
        setReport(lines);
        // A file that could not be brought in says why, line by line; a refusal (signed out, no Pro) in the studio's words.
        setError(lines.length ? "This file could not be brought in. The lines below say why." : describe(data?.error ?? "") ?? FAILED);
        return;
      }
      if (!data.steps.length) {
        setError("No email in the file could be brought in. The report below says why for each one.");
        return;
      }
      onRead(data.steps, lines);
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
      // So picking the same file again, after changing it, reads it again.
      if (input.current) input.current.value = "";
      setFile(null);
    }
  }

  return (
    <div className="mt-5 rounded-[var(--r-sm)] border border-line bg-white p-4" data-sequence-import="">
      <p className="font-semibold text-ink">Bring in a sequence</p>
      <p className="mt-1 text-sm text-ink-soft">
        {`Copy the emails from your old service into the template, one email per row, in its columns (${SEQUENCE_TEMPLATE.join(", ")}). They open here as a new sequence for you to read, pick what starts it and save, paused. Nothing is sent.`}
      </p>
      <p className="mt-2 text-sm">
        <a href={template} download="sequence-template.csv" className="inline-flex min-h-11 items-center font-bold text-ink-soft underline underline-offset-4">
          Download the template (CSV)
        </a>
      </p>
      <label htmlFor={`${id}-file`} className="field-label mt-2 block">Your file</label>
      <input
        ref={input}
        id={`${id}-file`}
        type="file"
        accept=".csv,text/csv"
        className="mt-2 block text-sm"
        aria-describedby={`${id}-help`}
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setReport([]);
          setError(null);
        }}
      />
      <p id={`${id}-help`} className="mt-1 text-sm text-ink-soft">{`A CSV file, up to ${MAX_SEQUENCE_FILE_BYTES / 1000} KB and 20 emails. HTML is read as text; images, tracking and the old service's merge fields are taken out and listed.`}</p>
      <button type="button" className="btn btn-secondary mt-3" disabled={disabled || busy || !file} aria-busy={busy} onClick={() => void read()}>
        {busy ? "Reading…" : "Read the file"}
      </button>
      {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
      {/* Always there, so what is put in it is announced. */}
      <div className="mt-3" role="status" aria-live="polite">
        {report.length ? (
          <>
            <p className="text-sm font-semibold text-ink">{`What to check (${report.length})`}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-soft">
              {report.map((r, i) => (
                <li key={i}>{reportWords(r)}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
