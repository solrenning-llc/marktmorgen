"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { CreatorCardView } from "@/components/creator-card-view";
import type { ContactWords } from "@/lib/buyer-words/contact";
import { type CreatorCard, MAX_CARD_EMAIL, MAX_CARD_NAME, MAX_CARD_NOTE, MAX_CARD_TITLE } from "@/lib/creator-card";

type Field = { key: "name" | "title" | "email" | "phone" | "website" | "note"; label: string; hint: string; max: number; type: string; autoComplete: string };

const FIELDS: Field[] = [
  { key: "name", label: "Name on the card", hint: "Your name or your business's, as people know you. Example: Ana Souza.", max: MAX_CARD_NAME, type: "text", autoComplete: "name" },
  { key: "title", label: "What you do (optional)", hint: "A few words. Example: Pottery teacher.", max: MAX_CARD_TITLE, type: "text", autoComplete: "organization-title" },
  { key: "email", label: "Email to show (optional)", hint: "Anyone who opens the card sees it. Example: hello@yourname.com.", max: MAX_CARD_EMAIL, type: "email", autoComplete: "email" },
  { key: "phone", label: "Phone to show (optional)", hint: "With + and your country code first, so it dials from any country. Example: +44 20 7946 0000.", max: 40, type: "tel", autoComplete: "tel" },
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
export function CreatorCardEditor({ initial, handle, storeName, words, address, look }: { initial: CreatorCard; handle: string; storeName: string; words: ContactWords["card"]; address: string; look: { className: string; style: React.CSSProperties; lang: string } }) {
  const [card, setCard] = useState(initial);
  const [kept, setKept] = useState(initial.on || Boolean(initial.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [said, setSaid] = useState("");

  async function send(body: Record<string, unknown>): Promise<CreatorCard | null> {
    setBusy(true);
    setError("");
    setSaid("");
    try {
      const response = await fetch("/api/store/creator-card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; card?: CreatorCard; message?: string; error?: string };
      if (answer.ok && answer.card) return answer.card;
      setError(answer.message ?? (answer.error === "data_full" ? "Your store's data room is full. Delete something you no longer need first." : "That did not save. Try again in a moment."));
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const saved = await send({ action: "save", ...card });
    if (!saved) return;
    setCard(saved);
    setKept(true);
    const words = saved.on ? "Your card is saved and shown." : "Your card is saved. It is not shown until you turn it on.";
    setSaid(words);
    toast(words);
  }

  async function remove() {
    const left = await send({ action: "remove" });
    if (!left) return;
    setKept(false);
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
                onChange={(event) => setCard((typed) => ({ ...typed, [field.key]: event.target.value }))}
              />
              <span id={`card-${field.key}-hint`} className="mt-1 block text-xs text-ink-soft">
                {field.hint}
              </span>
            </label>
          ))}
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={card.on} onChange={(event) => setCard((typed) => ({ ...typed, on: event.target.checked }))} aria-describedby="card-on-hint" />
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
