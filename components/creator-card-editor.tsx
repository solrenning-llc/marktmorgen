"use client";

import { useRef, useState } from "react";
import { toast } from "@/components/toast";
import { CreatorCardView } from "@/components/creator-card-view";
import type { ContactWords } from "@/lib/buyer-words/contact";
import { type CreatorCard, MAX_CARD_EMAIL, MAX_CARD_NAME, MAX_CARD_NOTE, MAX_CARD_TITLE } from "@/lib/creator-card";

type Field = { key: "name" | "title" | "email" | "phone" | "website" | "note"; label: string; hint: string; max: number; type: string; autoComplete: string };

const FIELDS: Field[] = [
  { key: "name", label: "Name on the card", hint: "Your name or your business's, as people know you. Example: Ana Souza.", max: MAX_CARD_NAME, type: "text", autoComplete: "name" },
  { key: "title", label: "What you do (optional)", hint: "A few words. Example: Pottery teacher.", max: MAX_CARD_TITLE, type: "text", autoComplete: "organization-title" },
  { key: "email", label: "Email to show (optional)", hint: "Anyone who opens the card sees it. Example: hello@yourname.com.", max: MAX_CARD_EMAIL, type: "email", autoComplete: "email" },
  { key: "phone", label: "Phone to show (optional)", hint: "With + and your country code first (+1 for the US, +44 for the UK), so it dials from any country.", max: 40, type: "tel", autoComplete: "tel" },
  { key: "website", label: "Your website (optional)", hint: "Its whole address. Example: https://yourname.com.", max: 200, type: "url", autoComplete: "url" },
  { key: "note", label: "A line under your name (optional)", hint: "What people should know. Example: Classes in Lisbon and online.", max: MAX_CARD_NOTE, type: "text", autoComplete: "off" },
];

/**
 * The creator's business card in the studio (639 [GL7](22), unit 3): every
 * field labeled with an example, a preview drawn exactly as visitors will
 * see it, and a choice to show it, off until the creator turns it on. Kept
 * by app/api/store/creator-card; deleting it keeps the words on the screen,
 * so saving again puts it back.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [said, setSaid] = useState("");
  // Each edit counts here, so an answer to a save sent before it never writes over what was typed since (Codex G2 on #1963).
  const edits = useRef(0);
  const edit = (change: (typed: CreatorCard) => CreatorCard) => {
    edits.current += 1;
    setCard(change);
  };

  async function send(body: Record<string, unknown>): Promise<{ card: CreatorCard; removed: unknown } | null> {
    setBusy(true);
    setError("");
    setSaid("");
    try {
      const response = await fetch("/api/store/creator-card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer: unknown = await response.json().catch(() => null);
      const confirmed = confirmedCard(response.status, answer);
      if (confirmed) return { card: confirmed, removed: (answer as { removed?: unknown }).removed };
      // A refusal the server explains (a field, a full data room) is said as it is; anything else is not known.
      const refusal = answer && typeof answer === "object" ? (answer as { ok?: unknown; error?: unknown; message?: unknown }) : null;
      const refused = response.status >= 400 && response.status < 500 && refusal?.ok === false;
      if (refused && typeof refusal.message === "string" && refusal.message) setError(refusal.message);
      else if (refused && refusal.error === "data_full") setError("Your store's data room is full. Delete something you no longer need first.");
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
    const sentAt = edits.current;
    const answer = await send({ action: "save", ...card });
    if (!answer) return;
    const saved = answer.card;
    setKept(true);
    if (edits.current !== sentAt) {
      // Changed while it was saving: what was typed since stays on the screen, not yet saved.
      setSaid("Your card is saved as it was when you pressed Save. You changed it since: save again to keep the newer words.");
      return;
    }
    setCard(saved);
    const words = saved.on ? "Your card is saved and shown." : "Your card is saved. It is not shown until you turn it on.";
    setSaid(words);
    toast(words);
  }

  async function remove() {
    const left = await send({ action: "remove" });
    if (!left) return;
    // Deleted only when the server keeps no card at all: not merely off with no name, since a card kept with hidden
    // words (an email, a note) is still kept (Codex G on #1963). Otherwise Delete stays and the words below are untouched.
    if (!confirmedRemoval(left)) {
      setError(CARD_NOT_DELETED);
      return;
    }
    setKept(false);
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
          {FIELDS.map((field) => (
            <label key={field.key} className="block text-sm">
              <span className="field-label">{field.label}</span>
              <input
                type={field.type}
                className="field mt-1"
                value={card[field.key]}
                maxLength={field.max}
                autoComplete={field.autoComplete}
                required={field.key === "name" && card.on}
                aria-describedby={`card-${field.key}-hint`}
                onChange={(event) => edit((typed) => ({ ...typed, [field.key]: event.target.value }))}
              />
              <span id={`card-${field.key}-hint`} className="mt-1 block text-xs text-ink-soft">
                {field.hint}
              </span>
            </label>
          ))}
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={card.on} onChange={(event) => edit((typed) => ({ ...typed, on: event.target.checked }))} aria-describedby="card-on-hint" />
            <span>
              <span className="font-semibold text-ink">Show my card</span>
              <span id="card-on-hint" className="block text-ink-soft [overflow-wrap:anywhere]">{`At ${address}, with a Save contact button. Anyone with the address can see it.`}</span>
            </span>
          </label>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save the card
          </button>
          {kept ? (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void remove()}>
              Delete the card
            </button>
          ) : null}
        </div>
        <p className="mt-3 text-sm text-ink" role="status">
          {said}
        </p>
        <p className="mt-1 text-sm text-danger-text" role="alert">
          {error}
        </p>
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
