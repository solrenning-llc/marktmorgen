"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/icons";
import { readAiAnswer } from "@/lib/ai-response";
import { AI_ALLOWANCE_UNKNOWN } from "@/components/ai-assist";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import type { FunnelType } from "@/lib/funnel-types";
import {
  FUNNEL_RESEARCH_JOBS,
  MAX_FUNNEL_AUDIENCE,
  MAX_FUNNEL_OFFER,
  MAX_FUNNEL_PROOF,
  type FunnelAiDraft,
  type FunnelResearch,
  followUpMoment,
  funnelDraftJobs,
  isFunnelAiDraft,
  isFunnelResearch,
} from "@/lib/funnel-ai-rules";

const MESSAGES: Record<string, string> = {
  unconfirmed: "The result could not be confirmed. Nothing in your setup was changed. Reload to check your AI uses before trying again.",
  notes: "Write a few words first: who it is for, or what they get.",
  long: "There is too much to send in one draft. Shorten what you typed, or the descriptions of the products in its steps.",
  used: "This month's AI uses are not enough for this. They start again with your next billing month.",
  slow: "A few at a time: wait a minute, then try again.",
  failed: "The AI did not answer just now. Nothing in your setup was changed. Started attempts count toward the monthly allowance.",
  off: "Writing with AI is not available right now.",
  forbidden: "Your role on this store cannot do this.",
  type: "That kind of funnel is not offered any more. Reload the page.",
  slot_missing: "Choose a product for every step first.",
  slot_free: "A step that needs a free product has a paid one.",
  slot_paid: "A step that needs a paid product has a free one.",
  slot_call: "A call cannot be a step of a funnel.",
  slot_twice: "Each product can fill one step.",
};
const REFUSED_BEFORE_START = new Set(["long", "notes", "slow", "used", "off", "forbidden", "type", "slot_missing", "slot_free", "slot_paid", "slot_call", "slot_twice"]);

/**
 * The AI first draft of a whole funnel, inside the guided setup's review
 * (components/funnel-type-picker.tsx), and the summary of who it is for from
 * the store's own records. What it returns fills the setup's own fields; the
 * creator reads and changes them, and nothing is created until they press
 * "Create disabled funnel".
 */
export function FunnelAiDraftPanel({ type, picked, sid, ai, emailsPossible, onDraft }: {
  type: FunnelType;
  picked: Record<string, string>;
  sid: string;
  /** null when the month's AI uses could not be read (VR2): said in words, with the buttons off. */
  ai: { on: boolean; left: number | null };
  /** Whether a follow-up sequence fits this funnel's journey at all (lib/funnel-ai-rules.ts, followUpMoment). */
  emailsPossible: boolean;
  onDraft: (draft: FunnelAiDraft) => void;
}) {
  // The sentence under the two buttons says what they use, or why they are off: each button names it (AX274).
  const statusId = useId();
  const [audience, setAudience] = useState("");
  const [offer, setOffer] = useState("");
  const [proof, setProof] = useState("");
  const [notes, setNotes] = useState("");
  const [emails, setEmails] = useState(emailsPossible);
  const [busy, setBusy] = useState<"draft" | "research" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(ai.left ?? 0);
  const [known, setKnown] = useState(ai.left !== null);
  const [research, setResearch] = useState<FunnelResearch | null>(null);
  const [drafted, setDrafted] = useState(false);
  if (!ai.on) return null;
  const withEmails = emails && emailsPossible;
  const draftJobs = funnelDraftJobs(withEmails);

  async function run(kind: "funnel" | "funnel-research") {
    if (busy) return;
    const jobs = kind === "funnel" ? draftJobs : FUNNEL_RESEARCH_JOBS;
    if (jobs > left) {
      setError(MESSAGES.used);
      return;
    }
    setBusy(kind === "funnel" ? "draft" : "research");
    setError(null);
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-nimbus-store": sid },
        body: JSON.stringify({ kind, type: type.id, products: picked, audience, offer, proof, notes, emails: withEmails }),
      });
      const data = readAiAnswer(response.ok, await response.json().catch(() => null));
      if (data.ok) {
        setLeft(data.left);
        setKnown(true);
        if (kind === "funnel") {
          if (!isFunnelAiDraft(data.value, type)) return setError(MESSAGES.unconfirmed);
          onDraft(data.value);
          setDrafted(true);
        } else {
          if (!isFunnelResearch(data.value)) return setError(MESSAGES.unconfirmed);
          setResearch(data.value);
        }
        return;
      }
      if (!REFUSED_BEFORE_START.has(data.error)) setKnown(false);
      setError(Object.hasOwn(MESSAGES, data.error) ? MESSAGES[data.error] : MESSAGES.unconfirmed);
    } catch {
      setKnown(false);
      setError(MESSAGES.unconfirmed);
    } finally {
      setBusy(null);
    }
  }

  const sourceOf = (id: string) => research?.sources.find((source) => source.id === id);
  const date = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <section aria-labelledby="funnel-ai-title" className="mt-4 rounded-2xl border border-violet-brand/25 bg-lilac/40 p-4">
      <h4 id="funnel-ai-title" className="flex items-center gap-2 text-sm font-semibold text-violet-deep">
        <Icon name="sparkle" size={16} />
        Draft this funnel with AI
      </h4>
      <p className="mt-1 text-sm text-ink-soft">
        It writes each new page&apos;s words, the form&apos;s questions, offers from your own products and, if you want, three follow-up emails, from the products you chose and what you type here. It fills the fields below for you to read and change. Nothing is created until you press &ldquo;Create disabled funnel&rdquo;.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Who it is for</span>
          <textarea className="field mt-2" rows={3} maxLength={MAX_FUNNEL_AUDIENCE} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="New freelance designers who want their first steady clients." />
        </label>
        <label className="block">
          <span className="field-label">What they get</span>
          <textarea className="field mt-2" rows={3} maxLength={MAX_FUNNEL_OFFER} value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="A checklist, then a 6-lesson course on pricing and pitching." />
        </label>
        <label className="block">
          <span className="field-label">Proof you actually have (optional)</span>
          <textarea className="field mt-2" rows={3} maxLength={MAX_FUNNEL_PROOF} value={proof} onChange={(e) => setProof(e.target.value)} placeholder="Only what is true and you can show: years doing it, work you can link to. Leave empty if none." />
        </label>
        <label className="block">
          <span className="field-label">Anything else (optional)</span>
          <textarea className="field mt-2" rows={3} maxLength={MAX_AI_NOTES} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Tone, words to avoid, what the training covers." />
        </label>
      </div>
      {emailsPossible ? (
        <label className="mt-3 flex min-h-11 items-start gap-2">
          <input className="mt-1" type="checkbox" checked={emails} onChange={(e) => setEmails(e.target.checked)} />
          <span className="text-sm">Also draft three follow-up emails for the Email Studio</span>
        </label>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void run("funnel")} disabled={busy !== null || !known || left < draftJobs} aria-busy={busy === "draft"} aria-describedby={statusId}>
          {busy === "draft" ? "Drafting…" : drafted ? "Draft again" : "Draft the funnel"}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void run("funnel-research")} disabled={busy !== null || !known || left < FUNNEL_RESEARCH_JOBS} aria-busy={busy === "research"} aria-describedby={statusId}>
          {busy === "research" ? "Reading…" : "Summarize who it is for"}
        </button>
      </div>
      <p id={statusId} className="mt-2 text-xs text-ink-soft" role="status">
        {known
          ? `The draft uses ${draftJobs} of your monthly AI uses; the summary uses ${FUNNEL_RESEARCH_JOBS}. ${left} left this month. Each request also sets aside the most it could cost from your plan's monthly AI budget, which can run out before the uses do. Started attempts count, even if they fail.`
          : AI_ALLOWANCE_UNKNOWN}
        {drafted ? " Drafting again replaces the words below." : ""}
      </p>
      {error ? (
        <p className="notice notice-error mt-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {research ? (
        <div className="mt-4 rounded-xl border border-line bg-white p-3 text-sm">
          <p className="font-semibold text-ink">Who it is for, from your store&apos;s records</p>
          <p className="mt-1 text-xs text-ink-soft">Read only from your own store and what you typed. Nothing was searched on the web.</p>
          {research.audience ? <p className="mt-3"><span className="font-semibold">Audience: </span>{research.audience}</p> : null}
          {research.positioning ? <p className="mt-2"><span className="font-semibold">Positioning: </span>{research.positioning}</p> : null}
          {research.claims.length ? (
            <ul className="mt-3 list-disc space-y-1 pl-5">
              {research.claims.map((claim, i) => {
                const source = sourceOf(claim.source);
                return <li key={i}>{claim.text} <span className="text-xs text-ink-soft">({source ? `${source.label}, ${date(source.date)}` : claim.source})</span></li>;
              })}
            </ul>
          ) : null}
          <p className="mt-3 font-semibold">What this cannot tell</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-soft">{research.uncertainty.map((line, i) => <li key={i}>{line}</li>)}</ul>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-semibold">Sources read ({research.sources.length})</summary>
            <ul className="mt-2 space-y-1 text-xs text-ink-soft">{research.sources.map((source) => <li key={source.id}>{`[${source.id}] ${source.label} · ${date(source.date)}`}</li>)}</ul>
          </details>
          {research.audience ? <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => setAudience(research.audience.slice(0, MAX_FUNNEL_AUDIENCE))}>Use as &ldquo;Who it is for&rdquo;</button> : null}
        </div>
      ) : null}
      <p className="mt-3 text-xs text-ink-soft">
        Written in American English. It never invents testimonials, results, numbers, deadlines or quantities left; a sentence with a number your products and words do not carry is removed. Where only you know a fact, it leaves a part marked ⟦like this⟧: a page holding one stays hidden, and emails holding one cannot be saved, until you replace it.
      </p>
    </section>
  );
}

/** Whether a follow-up sequence fits this journey: re-exported for the setup. */
export const followUpFits = (type: FunnelType, picked: Record<string, string>) => followUpMoment(type, picked) !== null;
