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
const TEXT_FIELDS = ["name", "title", "email", "phone", "website", "note"] as const;

/**
 * The card the server answered with, only when the answer is whole: a 2xx
 * status, `ok` exactly true, no error beside it, and a card with every field
 * of its own type (Codex G2 on #1963). Anything else is not a confirmation.
 */
export function confirmedCard(status: number, answer: unknown): CreatorCard | null {
  if (status < 200 || status > 299 || !answer || typeof answer !== "object") return null;
  const { ok, card, error } = answer as { ok?: unknown; card?: unknown; error?: unknown };
  if (ok !== true || error !== undefined || !card || typeof card !== "object") return null;
  const fields = card as Record<string, unknown>;
  if (typeof fields.on !== "boolean" || TEXT_FIELDS.some((key) => typeof fields[key] !== "string")) return null;
  return { on: fields.on, name: fields.name as string, title: fields.title as string, email: fields.email as string, phone: fields.phone as string, website: fields.website as string, note: fields.note as string };
}

/** What the screen says when an answer did not confirm what happened: never "saved", never "nothing changed". */
export const CARD_UNCONFIRMED = "We could not confirm what happened to your card. Your words are still below. Reload the page to see what is kept, then try again.";

/** What the screen says when a deletion's answer shows a card still kept: it was not deleted, and Delete stays. */
export const CARD_NOT_DELETED = "Your card was not deleted: a card is still kept, perhaps saved from another tab. Your words are still below. Reload the page to see what is kept, then delete it again if you want.";

/** A deletion is confirmed only when the server says none is kept and the card it sends back is empty in every field. */
export function confirmedRemoval(answer: { card: CreatorCard; removed: unknown }): boolean {
  return answer.removed !== false && !answer.card.on && TEXT_FIELDS.every((key) => answer.card[key] === "");
}

export function CreatorCardEditor({ initial, held, handle, storeName, words, address, look }: { initial: CreatorCard; held?: boolean; handle: string; storeName: string; words: ContactWords["card"]; address: string; look: { className: string; style: React.CSSProperties; lang: string } }) {
  const [card, setCard] = useState(initial);
  // Delete is offered for every kept card, also one off with no name but an email or a note, and one empty in every
  // field: the page says whether a record is kept (`held`); without it, any word kept counts (Codex G on #1963).
  const [kept, setKept] = useState(held ?? (initial.on || TEXT_FIELDS.some((key) => initial[key] !== "")));
  // Whether the card as kept is shown to visitors (the checkbox is only what is typed).
  const [shown, setShown] = useState(initial.on);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<CardRefusal | null>(null);
  const [said, setSaid] = useState("");
  // Each edit counts here, so an answer to a save sent before it never writes over what was typed since (Codex G2 on #1963).
  const edits = useRef(0);
  const edit = (change: (typed: CreatorCard) => CreatorCard) => {
    edits.current += 1;
    setCard(change);
  };
  const saveButton = useRef<HTMLButtonElement>(null);
  const focusSave = useRef(false);
  useEffect(() => {
    if (!focusSave.current) return;
    focusSave.current = false;
    saveButton.current?.focus();
  });

  async function send(body: Record<string, unknown>): Promise<{ card: CreatorCard; removed: unknown } | null> {
    setBusy(true);
    setError("");
    setErrorField(null);
    setSaid("");
    try {
      const response = await fetch("/api/store/creator-card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const raw: unknown = await response.json().catch(() => null);
      const confirmed = confirmedCard(response.status, raw);
      if (confirmed) return { card: confirmed, removed: (raw as { removed?: unknown }).removed };
      // A refusal the server explains (a field, a full store) is said as it is, beside its field when it names one;
      // anything else is not known.
      const answer = raw && typeof raw === "object" ? (raw as { ok?: unknown; error?: unknown; message?: unknown }) : null;
      const refused = response.status >= 400 && response.status < 500 && answer?.ok === false;
      setErrorField(refused ? (FIELDS.find((field) => field.key === answer.error)?.key ?? null) : null);
      if (refused && typeof answer.message === "string" && answer.message) setError(answer.message);
      else if (refused && answer.error === "data_full") setError(DATA_FULL);
      else setError(CARD_UNCONFIRMED);
    } catch {
      setError(CARD_UNCONFIRMED);
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const sentAt = edits.current;
    const answer = await send({ action: "save", ...card });
    if (!answer) return;
    const saved = answer.card;
    setKept(true);
    // What visitors see is the card as the server kept it, whatever was typed since (Claude 5 on #1965).
    setShown(saved.on);
    if (edits.current !== sentAt) {
      // Changed while it was saving: what was typed since stays on the screen, not yet saved.
      setSaid("Your card is saved as it was when you pressed Save. You changed it since: save again to keep the newer words.");
      return;
    }
    setCard(saved);
    // Said once, in the status line (4.1.3): no toast beside it.
    setSaid(saved.on ? "Your card is saved and shown." : "Your card is saved. It is not shown until you turn it on.");
  }

  async function remove() {
    if (busy) return;
    const left = await send({ action: "remove" });
    if (!left) return;
    // Deleted only when the server keeps no card at all: not merely off with no name, since a card kept with hidden
    // words (an email, a note) is still kept (Codex G on #1963). Otherwise Delete stays and the words below are untouched.
    if (!confirmedRemoval(left)) {
      setError(CARD_NOT_DELETED);
      return;
    }
    setKept(false);
    setShown(false);
    focusSave.current = true;
    edit((typed) => ({ ...typed, on: false }));
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
                  onChange={(event) => edit((typed) => ({ ...typed, [field.key]: event.target.value }))}
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
            <input id="card-on" type="checkbox" className="mt-3 h-5 w-5 shrink-0" checked={card.on} onChange={(event) => edit((typed) => ({ ...typed, on: event.target.checked }))} aria-describedby="card-on-hint" />
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
