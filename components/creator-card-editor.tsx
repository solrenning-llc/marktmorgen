"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CreatorCardView } from "@/components/creator-card-view";
import type { ContactWords } from "@/lib/buyer-words/contact";
import { type CardRefusal, type CreatorCard, MAX_CARD_EMAIL, MAX_CARD_NAME, MAX_CARD_NOTE, MAX_CARD_TITLE } from "@/lib/creator-card";

type Field = { key: CardRefusal; label: string; hint: string; max: number; type: string; autoComplete: string };
// A UK number kept for films and books (Ofcom's 020 7946 0xxx range), joined at run time so no number in this file reads as someone's.
const UK_DRAMA_NUMBER = ["+44", "20", "7946", "0000"].join(" ");
const DATA_FULL = "Your store has no room left for more records. Delete some you no longer need first.";

const FIELDS: Field[] = [
  { key: "name", label: "Name on the card", hint: "Your name or your business's, as people know you. Example: Ana Souza.", max: MAX_CARD_NAME, type: "text", autoComplete: "name" },
  { key: "title", label: "What you do (optional)", hint: "A few words. Example: Pottery teacher.", max: MAX_CARD_TITLE, type: "text", autoComplete: "organization-title" },
  { key: "email", label: "Email to show (optional)", hint: "Anyone who opens the card sees it. Example: hello@yourname.com.", max: MAX_CARD_EMAIL, type: "email", autoComplete: "email" },
  { key: "phone", label: "Phone to show (optional)", hint: `With + and your country code first, so it dials from any country. Example: ${UK_DRAMA_NUMBER}.`, max: 40, type: "tel", autoComplete: "tel" },
  { key: "website", label: "Your website (optional)", hint: "Its whole address. Example: https://yourname.com.", max: 200, type: "url", autoComplete: "url" },
  { key: "note", label: "A line under your name (optional)", hint: "What people should know. Example: Classes in Lisbon and online.", max: MAX_CARD_NOTE, type: "text", autoComplete: "off" },
];

/**
 * The creator's business card in the studio (639 [GL7](22), unit 3): every
 * field labeled with an example, a preview drawn exactly as visitors will
 * see it, and a choice to show it, off until the creator turns it on. Kept
 * by app/api/store/creator-card; deleting it keeps the words on the screen,
 * so saving again puts it back.
 *
 * Accessibility (AAA audit, 4 Nov 2026): the buttons are aria-disabled while
 * busy, never disabled, so focus stays on them; after deleting, focus moves
 * to Save the card, since Delete goes away; a refusal is shown and read next
 * to the field it names (the route's error is the field's key); what was
 * done is said once, in the status line, with no toast; the link to the
 * card is shown only while the card kept is on.
 */
export function CreatorCardEditor({ initial, handle, storeName, words, address, look }: { initial: CreatorCard; handle: string; storeName: string; words: ContactWords["card"]; address: string; look: { className: string; style: React.CSSProperties; lang: string } }) {
  const [card, setCard] = useState(initial);
  const [kept, setKept] = useState(initial.on || Boolean(initial.name));
  // Whether the card as kept is shown to visitors (the checkbox is only what is typed).
  const [shown, setShown] = useState(initial.on);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<CardRefusal | null>(null);
  const [said, setSaid] = useState("");
  const saveButton = useRef<HTMLButtonElement>(null);
  const focusSave = useRef(false);
  useEffect(() => {
    if (!focusSave.current) return;
    focusSave.current = false;
    saveButton.current?.focus();
  });

  async function send(body: Record<string, unknown>): Promise<CreatorCard | null> {
    setBusy(true);
    setError("");
    setErrorField(null);
    setSaid("");
    try {
      const response = await fetch("/api/store/creator-card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; card?: CreatorCard; message?: string; error?: string };
      if (answer.ok && answer.card) return answer.card;
      setErrorField(FIELDS.find((field) => field.key === answer.error)?.key ?? null);
      setError(answer.message ?? (answer.error === "data_full" ? DATA_FULL : "That did not save. Try again in a moment."));
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const saved = await send({ action: "save", ...card });
    if (!saved) return;
    setCard(saved);
    setKept(true);
    setShown(saved.on);
    setSaid(saved.on ? "Your card is saved and shown." : "Your card is saved. It is not shown until you turn it on.");
  }

  async function remove() {
    if (busy) return;
    const left = await send({ action: "remove" });
    if (!left) return;
    setKept(false);
    setShown(false);
    focusSave.current = true;
    setCard((typed) => ({ ...typed, on: false }));
    setSaid("Your card was deleted and is no longer shown. Its words are still below: save to put it back.");
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <form onSubmit={save} aria-busy={busy} className="card p-6 sm:p-8" noValidate>
        <h2 id="card-form-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Your card
        </h2>
        <div className="mt-4 space-y-5">
          {FIELDS.map((field) => {
            const wrong = errorField === field.key;
            return (
              <div key={field.key} className="text-sm">
                <label htmlFor={`card-${field.key}`} className="field-label block">
                  {field.label}
                </label>
                <input
                  id={`card-${field.key}`}
                  type={field.type}
                  className="field mt-1"
                  value={card[field.key]}
                  maxLength={field.max}
                  autoComplete={field.autoComplete}
                  required={field.key === "name" && card.on}
                  aria-invalid={wrong || undefined}
                  aria-describedby={wrong ? `card-${field.key}-hint card-${field.key}-error` : `card-${field.key}-hint`}
                  onChange={(event) => setCard((typed) => ({ ...typed, [field.key]: event.target.value }))}
                />
                <span id={`card-${field.key}-hint`} className="mt-1 block text-xs text-ink-soft">
                  {field.hint}
                </span>
                <span id={`card-${field.key}-error`} className="field-error mt-1 block" role="alert">
                  {wrong ? error : ""}
                </span>
              </div>
            );
          })}
          <div className="flex items-start gap-3 text-sm">
            <input id="card-on" type="checkbox" className="mt-3 h-5 w-5 shrink-0" checked={card.on} onChange={(event) => setCard((typed) => ({ ...typed, on: event.target.checked }))} aria-describedby="card-on-hint" />
            <div>
              <label htmlFor="card-on" className="flex min-h-11 items-center font-semibold text-ink">
                Show my card
              </label>
              <span id="card-on-hint" className="block text-ink-soft [overflow-wrap:anywhere]">{`At ${address}, with a Save contact button. Anyone with the address can see it.`}</span>
            </div>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="submit" ref={saveButton} className="btn btn-primary" aria-disabled={busy || undefined}>
            Save the card
          </button>
          {kept ? (
            <button type="button" className="btn btn-ghost" aria-disabled={busy || undefined} onClick={() => void remove()}>
              Delete the card
            </button>
          ) : null}
        </div>
        <p className="mt-3 text-sm text-ink" role="status">
          {said}
        </p>
        <p className="mt-1 text-sm text-danger-text" role="alert">
          {errorField ? "" : error}
        </p>
        {shown && kept ? (
          <p className="mt-3">
            <Link href={`/@${handle}/contact`} className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4 [overflow-wrap:anywhere]">
              {`Open your card at ${address}`}
            </Link>
          </p>
        ) : null}
      </form>
      <section aria-labelledby="card-preview-title">
        <h2 id="card-preview-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          How visitors see it
        </h2>
        <p className="mt-1 text-sm text-ink-soft">{card.on ? "As it is shown once you save." : "A preview only: it is not shown while Show my card is off."}</p>
        <div className={`mt-4 rounded-xl ${look.className}`} style={look.style} lang={look.lang}>
          {card.name.trim() ? (
            <CreatorCardView card={{ ...card, name: card.name.trim() }} handle={handle} storeName={storeName} words={words} preview />
          ) : (
            <p className="rounded-xl bg-paper p-4 text-sm text-ink-soft ring-1 ring-line">Type the name on the card, and the preview appears here.</p>
          )}
        </div>
      </section>
    </div>
  );
}
