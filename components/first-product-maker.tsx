"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FIRST_FORMATS, FORMAT_INFO, type FirstFormat, defaultAnswers, outlineFor, questionsFor } from "@/lib/first-product";
import { FIRST_PRODUCT_MAX_BREAKS, FIRST_PRODUCT_MAX_HEADING, FIRST_PRODUCT_MAX_PART } from "@/lib/first-product-limits";

/**
 * Make a first product in the studio (490 [PP1], unit 2): pick a format, answer a few questions by buttons, write
 * each part of the outline (lib/first-product.ts), and download it as a PDF a screen reader can read
 * (app/api/store/first-product/pdf). Nothing is written for the creator: every word in the file is theirs.
 *
 * What they write is kept on this device only (localStorage, read and written inside try/catch), so a reload or a
 * closed tab loses nothing; it is sent only when they ask for the PDF, and kept nowhere on our side.
 */
type Part = { heading: string; body: string };
type Draft = { format: FirstFormat; answers: Record<string, string>; title: string; know: string; groups: string[]; parts: Part[] };

const MESSAGES: Record<string, string> = {
  title: "Give it a title first. The title is the first thing on the PDF.",
  empty: "Write at least one part first. Parts left empty are left out of the PDF.",
  long: `Something is longer than the PDF can hold: a title or heading over ${FIRST_PRODUCT_MAX_HEADING} characters, more than 60,000 characters in all, or more than ${FIRST_PRODUCT_MAX_BREAKS} new lines. Shorten it and try again.`,
  parts: "The outline changed while you were writing. Reload this page; what you wrote is kept on this device.",
  format: "Choose what you are making first.",
  letters: "Some letters are not in the PDF's font (for example Chinese, Japanese or Korean). Write those parts with Latin, Greek or Cyrillic letters, or keep them for the product page.",
  studio: "Your store has used this month's studio requests. Your writing is kept on this device; download the PDF when they start again.",
  signed_out: "You are signed out. Sign in again in another tab; your writing stays here.",
  forbidden: "Your role in this store cannot change products, so it cannot make this file.",
};
const FALLBACK = "The PDF could not be made just now. Your writing is kept on this device; try again in a moment.";

const fresh = (format: FirstFormat): Draft => ({ format, answers: defaultAnswers(format), title: "", know: "", groups: [], parts: [] });

function readKept(key: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Draft>;
    const format = FIRST_FORMATS.find((f) => f === value.format);
    if (!format) return null;
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      format,
      answers: value.answers && typeof value.answers === "object" ? (value.answers as Record<string, string>) : defaultAnswers(format),
      title: text(value.title),
      know: text(value.know),
      groups: Array.isArray(value.groups) ? value.groups.map(text) : [],
      parts: Array.isArray(value.parts) ? value.parts.map((p) => ({ heading: text((p as Part)?.heading), body: text((p as Part)?.body) })) : [],
    };
  } catch {
    return null;
  }
}

export function FirstProductMaker({ storeKey, productsHref }: { storeKey: string; productsHref: string }) {
  const key = `mm:first-product:${storeKey}`;
  const [draft, setDraft] = useState<Draft>(() => fresh("guide"));
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "working" } | { kind: "error"; message: string } | { kind: "done"; file: string }>({ kind: "idle" });
  const [confirmReset, setConfirmReset] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // What was written here before comes back once the page is in the browser (nothing on the server to wait for).
  useEffect(() => {
    const kept = readKept(key);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from this device's storage after hydration
    if (kept) setDraft(kept);
    setLoaded(true);
  }, [key]);
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(draft));
    } catch {
      // A private window or blocked storage: the page still works, the writing is just not kept after a reload.
    }
  }, [key, draft, loaded]);

  const info = FORMAT_INFO[draft.format];
  const questions = questionsFor(draft.format, false);
  const outline = useMemo(() => outlineFor(draft.format, draft.answers, draft.title), [draft.format, draft.answers, draft.title]);
  const partAt = (i: number): Part => draft.parts[i] ?? { heading: "", body: "" };
  const groupAt = (g: number) => draft.groups[g] ?? "";
  const written = outline.parts.filter((_, i) => partAt(i).body.trim()).length;

  function setPart(i: number, change: Partial<Part>) {
    setDraft((current) => {
      const parts = [...current.parts];
      while (parts.length <= i) parts.push({ heading: "", body: "" });
      parts[i] = { ...parts[i], ...change };
      return { ...current, parts };
    });
    setState({ kind: "idle" });
  }

  async function download() {
    if (state.kind === "working") return;
    setState({ kind: "working" });
    try {
      const response = await fetch("/api/store/first-product/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: draft.format,
          answers: draft.answers,
          title: draft.title,
          groups: outline.groups.map((_, g) => groupAt(g)),
          // Only the parts this outline has: a part kept from a longer outline stays on this device, unsent.
          parts: outline.parts.map((_, i) => partAt(i)),
        }),
      });
      if (response.ok && response.headers.get("content-type") === "application/pdf") {
        const blob = await response.blob();
        const file = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "my-product.pdf";
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setState({ kind: "done", file });
        return;
      }
      const data = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      const error = data?.error ?? "";
      setState({ kind: "error", message: error === "studio" && data?.message ? data.message : (MESSAGES[error] ?? FALLBACK) });
    } catch {
      setState({ kind: "error", message: FALLBACK });
    }
  }

  // The result is said where focus can find it, once, without moving the page (WCAG 3.2.5).
  useEffect(() => {
    if (state.kind === "done" || state.kind === "error") statusRef.current?.focus();
  }, [state.kind]);

  return (
    <div className="mt-8 max-w-3xl space-y-10">
      <section aria-labelledby="fp-format">
        <h2 id="fp-format" className="t-h3">1. What will you make?</h2>
        <fieldset className="mt-4">
          <legend className="sr-only">Format</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIRST_FORMATS.map((format) => (
              <label key={format} className="card flex min-h-[44px] cursor-pointer items-start gap-3 p-4">
                <input
                  type="radio"
                  name="fp-format"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={draft.format === format}
                  onChange={() => {
                    setDraft((current) => ({ ...current, format, answers: defaultAnswers(format), groups: [], parts: current.format === format ? current.parts : [] }));
                    setState({ kind: "idle" });
                  }}
                />
                <span>
                  <span className="block font-semibold text-ink">{FORMAT_INFO[format].name}</span>
                  <span className="mt-1 block text-sm text-ink-soft">{FORMAT_INFO[format].what}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-3 text-sm text-ink-soft">Choosing another format starts its own outline. What you wrote for this one is cleared, so download it first if you want to keep it.</p>
      </section>

      <section aria-labelledby="fp-choices">
        <h2 id="fp-choices" className="t-h3">2. A few choices</h2>
        <div className="mt-4 space-y-6">
          {questions.map((question) => (
            <fieldset key={question.id}>
              <legend className="field-label">{question.ask}</legend>
              <div className="mt-2 space-y-1">
                {question.choices.map((choice) => (
                  <label key={choice.id} className="flex min-h-[44px] cursor-pointer items-center gap-3">
                    <input
                      type="radio"
                      name={`fp-${question.id}`}
                      className="h-4 w-4 shrink-0"
                      checked={draft.answers[question.id] === choice.id}
                      onChange={() => setDraft((current) => ({ ...current, answers: { ...current.answers, [question.id]: choice.id } }))}
                    />
                    <span>{choice.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </section>

      <section aria-labelledby="fp-write">
        <h2 id="fp-write" className="t-h3">3. Write it</h2>
        <div className="mt-4 space-y-6">
          <label className="block">
            <span className="field-label">Title</span>
            <input className="field mt-2" maxLength={FIRST_PRODUCT_MAX_HEADING} value={draft.title} onChange={(e) => { setDraft({ ...draft, title: e.target.value }); setState({ kind: "idle" }); }} aria-describedby="fp-title-hint" />
            <span id="fp-title-hint" className="field-hint mt-1 block">The first line of the PDF and the name of its file.</span>
          </label>
          <label className="block">
            <span className="field-label">{info.know}</span>
            <textarea className="field mt-2 min-h-28" maxLength={FIRST_PRODUCT_MAX_PART} value={draft.know} onChange={(e) => setDraft({ ...draft, know: e.target.value })} aria-describedby="fp-know-hint" />
            <span id="fp-know-hint" className="field-hint mt-1 block">{`For example: ${info.example} These are notes for you to write from. They are not put in the PDF.`}</span>
          </label>
          {outline.groups.length ? (
            <fieldset>
              <legend className="field-label">Group names</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                {outline.groups.map((name, g) => (
                  <label key={g} className="block">
                    <span className="field-hint block">{`Group ${g + 1}`}</span>
                    <input
                      className="field mt-1"
                      maxLength={FIRST_PRODUCT_MAX_HEADING}
                      value={groupAt(g) || name}
                      onChange={(e) => setDraft((current) => { const groups = [...current.groups]; while (groups.length <= g) groups.push(""); groups[g] = e.target.value; return { ...current, groups }; })}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <ol className="space-y-6">
            {outline.parts.map((part, i) => {
              const own = partAt(i);
              const heading = own.heading || part.heading;
              return (
                <li key={i} className="card p-4 sm:p-5">
                  {draft.format === "checklist" ? null : (
                    <label className="block">
                      <span className="field-label">{`Heading of part ${i + 1}`}</span>
                      <input className="field mt-2" maxLength={FIRST_PRODUCT_MAX_HEADING} value={heading} onChange={(e) => setPart(i, { heading: e.target.value })} />
                    </label>
                  )}
                  <label className="mt-3 block">
                    <span className="field-label">{draft.format === "checklist" ? (part.group !== undefined ? `${groupAt(part.group) || outline.groups[part.group]}, ${part.heading.toLowerCase()}` : part.heading) : `What goes under “${heading}”`}</span>
                    <textarea className="field mt-2 min-h-24" maxLength={FIRST_PRODUCT_MAX_PART} value={own.body} onChange={(e) => setPart(i, { body: e.target.value })} aria-describedby={`fp-ask-${i}`} />
                    <span id={`fp-ask-${i}`} className="field-hint mt-1 block">{`${part.ask} Up to ${FIRST_PRODUCT_MAX_PART.toLocaleString("en-US")} characters. Left empty, it is left out.`}</span>
                  </label>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section aria-labelledby="fp-download">
        <h2 id="fp-download" className="t-h3">4. Download it</h2>
        <p className="mt-3 text-ink-soft">{`${written} of ${outline.parts.length} parts written. The PDF is made for screen readers too, and holds only what you wrote.`}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={download} disabled={state.kind === "working"} aria-busy={state.kind === "working"}>
            {state.kind === "working" ? "Making the PDF…" : "Download the PDF"}
          </button>
          {confirmReset ? (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => { setDraft(fresh(draft.format)); setConfirmReset(false); setState({ kind: "idle" }); }}>Yes, clear what I wrote</button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmReset(false)}>Keep it</button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmReset(true)}>Start over</button>
          )}
        </div>
        {state.kind === "error" ? (
          <p ref={statusRef} tabIndex={-1} role="alert" className="notice notice-error mt-4">{state.message}</p>
        ) : state.kind === "done" ? (
          <p ref={statusRef} tabIndex={-1} role="status" className="notice mt-4">
            {`Downloaded “${state.file}”. Next, sell it: add a product in your studio and choose this file as what buyers get. `}
            <a href={productsHref} className="underline">Go to your products</a>
          </p>
        ) : null}
        <p className="mt-4 text-sm text-ink-soft">What you write is kept on this device only, until you clear it. It is sent to us only to make the PDF, and not kept.</p>
      </section>
    </div>
  );
}
