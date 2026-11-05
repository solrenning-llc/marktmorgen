"use client";

import { useId, useState } from "react";
import { FAQ_ADD_WORDS, faqDraft, type FaqAddRefusal } from "@/lib/faq-from-inbox";
import { MAX_FAQ_A, MAX_FAQ_Q } from "@/lib/store-faq";

/**
 * 630 [HN6](32): under an answered conversation, the question and the
 * store's answer put on the store page's questions in one step, without
 * saying who asked. The words come in ready to check, with the visitor's
 * name, addresses, links and phone numbers taken out; nothing is published
 * until the creator presses the button.
 */
export function FaqFromInbox({ messages, name, room, studioHref }: { messages: readonly { from: "visitor" | "store"; text: string }[]; name: string; room: number; studioHref: string }) {
  const draft = faqDraft(messages, name);
  const id = useId();
  const [q, setQ] = useState(draft?.q ?? "");
  const [a, setA] = useState(draft?.a ?? "");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const [refused, setRefused] = useState<FaqAddRefusal | "error" | null>(null);
  if (!draft) return null;

  const qLong = q.trim().length > MAX_FAQ_Q;
  const aLong = a.trim().length > MAX_FAQ_A;

  async function publish() {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    try {
      const response = await fetch("/api/store/faq", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ add: { q, a } }) });
      const data = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
      if (response.ok && data?.ok === true) setAdded(true);
      else setRefused(typeof data?.error === "string" && data.error in FAQ_ADD_WORDS ? (data.error as FaqAddRefusal) : "error");
    } catch {
      setRefused("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-5 rounded-xl p-4 ring-1 ring-line" data-faq-from-inbox>
      <summary className="cursor-pointer font-medium">Add this question to your store page</summary>
      {added ? (
        <p role="status" className="mt-3">
          Added. It shows now with the other questions on your store page. To change or remove it, use{" "}
          <a className="link" href={`${studioHref}#faq`}>Questions on your store page in the studio</a>.
        </p>
      ) : room <= 0 ? (
        <p className="mt-3">{FAQ_ADD_WORDS.full}</p>
      ) : (
        <form
          className="mt-3 space-y-3"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          <p id={`${id}-note`} className="text-sm text-ink-soft">
            The visitor&apos;s latest question and your answer to it.{" "}
            {draft.cut ? "Their name, email addresses, links and phone numbers were taken out. " : ""}
            Read both, change anything that could say who asked, then publish.
          </p>
          <label className="block">
            <span className="field-label">Question</span>
            <textarea className="field mt-1 w-full" rows={2} required aria-describedby={`${id}-note ${id}-q`} aria-invalid={qLong || undefined} value={q} onChange={(e) => setQ(e.target.value)} />
            <span id={`${id}-q`} className={`mt-1 block text-sm ${qLong ? "font-semibold" : "text-ink-soft"}`}>
              {q.trim().length} of {MAX_FAQ_Q} characters{qLong ? ". Too long: shorten it to publish." : "."}
            </span>
          </label>
          <label className="block">
            <span className="field-label">Answer</span>
            <textarea className="field mt-1 w-full" rows={4} required aria-describedby={`${id}-a`} aria-invalid={aLong || undefined} value={a} onChange={(e) => setA(e.target.value)} />
            <span id={`${id}-a`} className={`mt-1 block text-sm ${aLong ? "font-semibold" : "text-ink-soft"}`}>
              {a.trim().length} of {MAX_FAQ_A} characters{aLong ? ". Too long: shorten it to publish." : "."}
            </span>
          </label>
          {refused ? (
            <p role="alert" className="notice notice-warn">
              {refused === "error" ? "It could not be added. Your words are still here; try again." : FAQ_ADD_WORDS[refused]}
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || qLong || aLong || !q.trim() || !a.trim()}>
            {busy ? "Publishing…" : "Publish on my store page"}
          </button>
        </form>
      )}
    </details>
  );
}
