"use client";

import { useState } from "react";

type Line = { level: "stop" | "note"; text: string };
type Made = { products: number; forms: number; pages: number; funnels: number; setup: boolean };
type Step = { ok: boolean; done?: boolean; phase?: string; made?: Made; products?: { done: number; of: number }; error?: string; message?: string; lines?: Line[] };

const PHASE_WORDS: Record<string, string> = { products: "Products", forms: "Forms", pages: "Pages", funnels: "Funnels", setup: "The store page's setup", done: "Done" };

/** A new copy's id: a retry with it goes on with the same copy and never makes anything twice. */
function newCopyId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Copying this store into another of the account's stores
 * (app/api/store/store-copy): where to, whether the store page's setup goes
 * too, what it makes and leaves out, then the copy, one step at a time.
 */
export function StoreCopyPanel({ from, stores }: { from: string; stores: { sid: string; name: string; handle: string }[] }) {
  const [to, setTo] = useState(stores[0]?.sid ?? "");
  const [setup, setSetup] = useState(false);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [fits, setFits] = useState(false);
  const [busy, setBusy] = useState("");
  const [copyId, setCopyId] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [made, setMade] = useState<Made | null>(null);
  const name = stores.find((s) => s.sid === to)?.name ?? "";

  const call = async (body: Record<string, unknown>): Promise<Step & { fits?: boolean }> => {
    try {
      const response = await fetch("/api/store/store-copy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return (await response.json().catch(() => ({ ok: false }))) as Step & { fits?: boolean };
    } catch {
      return { ok: false, message: "The connection dropped. Try again: nothing is made twice." };
    }
  };

  const reset = () => {
    setLines(null);
    setFits(false);
    setCopyId("");
    setStatus("");
    setError("");
    setMade(null);
  };

  async function preview() {
    if (busy) return;
    setBusy("preview");
    setError("");
    const answer = await call({ action: "preview", to, setup });
    setBusy("");
    if (!answer.ok) {
      setError(answer.message ?? "That could not be read just now. Try again in a minute.");
      return;
    }
    setLines(answer.lines ?? []);
    setFits(answer.fits === true);
  }

  async function copy() {
    if (busy) return;
    const id = copyId || newCopyId();
    setCopyId(id);
    setBusy("copy");
    setError("");
    for (let n = 0; n < 200; n += 1) {
      const answer = await call({ action: "step", to, copy: id, setup });
      if (!answer.ok) {
        setBusy("");
        if (answer.lines?.length) setLines(answer.lines);
        setError(answer.message ?? "That step could not be done. Try again: the copy goes on from where it stopped, and nothing is made twice.");
        return;
      }
      setMade(answer.made ?? null);
      const phase = PHASE_WORDS[answer.phase ?? ""] ?? "";
      setStatus(answer.done ? "Done." : answer.phase === "products" && answer.products ? `${phase}: ${answer.products.done} of ${answer.products.of} copied…` : `${phase}…`);
      if (answer.done) break;
    }
    setBusy("");
  }

  return (
    <div className="card mt-8 max-w-3xl p-6 sm:p-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-semibold text-ink">Copy into</span>
          <select className="field mt-1" value={to} disabled={busy !== ""} onChange={(e) => { setTo(e.target.value); reset(); }}>
            {stores.map((s) => (
              <option key={s.sid} value={s.sid}>{`${s.name} (@${s.handle})`}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="mt-5 flex min-h-11 items-start gap-3">
        <input type="checkbox" className="mt-1" checked={setup} disabled={busy !== ""} onChange={(e) => { setSetup(e.target.checked); reset(); }} />
        <span className="text-sm text-ink">
          {`Also copy the store page's setup: the about line, colors and letters, links, social profiles, questions and answers, the order of its parts, sections and line of news. This replaces ${name || "that store"}'s own setup.`}
        </span>
      </label>
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className="btn btn-secondary" onClick={() => void preview()} disabled={busy !== "" || !to}>
          {busy === "preview" ? "Reading…" : "See what it makes"}
        </button>
        {lines && fits ? (
          <button type="button" className="btn btn-primary" onClick={() => void copy()} disabled={busy !== ""}>
            {busy === "copy" ? "Copying…" : copyId && !made?.setup && status !== "Done." ? "Go on with the copy" : `Copy into ${name}`}
          </button>
        ) : null}
      </div>
      <p className="mt-3 text-sm text-ink-soft">Seeing what it makes, and each step of the copy, are some of that store&apos;s studio requests for the month.</p>
      {lines ? (
        <ul className="mt-6 space-y-2" aria-label={`What a copy of ${from} makes in ${name}`}>
          {lines.map((line, i) => (
            <li key={i} className={line.level === "stop" ? "notice notice-error" : "text-sm text-ink"}>{line.text}</li>
          ))}
        </ul>
      ) : null}
      <div role="status" aria-live="polite" className="mt-4 text-sm font-semibold text-ink">
        {status}
        {made && status === "Done." ? ` Made in ${name}: ${made.products} products, ${made.pages} pages, ${made.forms} forms, ${made.funnels} funnels${made.setup ? ", and the store page's setup" : ""}; every product, page and funnel a draft.` : ""}
      </div>
      {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}
    </div>
  );
}
