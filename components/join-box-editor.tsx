"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_JOIN_HEADING, MAX_JOIN_LINE, parseJoin, type StoreJoin } from "@/lib/store-field-rules";
import { joinWords } from "@/lib/buyer-words/join";

/**
 * The sign-up box on the store page (lib/store-join.ts): on or off, and the
 * creator's own heading and line for it. A preview shows it as buyers see it,
 * in the store's language when the boxes are left empty.
 */
export function JoinBoxEditor({
  join,
  storeName,
  language,
  blocked,
}: {
  join: StoreJoin;
  storeName: string;
  language: string;
  /** Why it would not show yet: "" when it would. */
  blocked: "" | "plan" | "mail";
}) {
  const router = useRouter();
  const [on, setOn] = useState(join.on);
  const [heading, setHeading] = useState(join.heading);
  const [line, setLine] = useState(join.line);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const w = joinWords(language);
  const changed = on !== join.on || heading !== join.heading || line !== join.line;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/store/signup-box", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on, heading, line }),
      });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const saved = data.join && typeof data.join === "object" && !Array.isArray(data.join) ? data.join as Record<string, unknown> : {};
      const expected = parseJoin({on,heading,line});
      if (response.ok && data.ok === true && data.error === undefined && saved.on === expected.on && saved.heading === expected.heading && saved.line === expected.line) {
        toast("Email sign-up settings saved.");
        router.refresh();
        return;
      }
      setError("We could not confirm whether your email sign-up settings were saved. Reload this page to check before trying again.");
    } catch {
      setError("We could not confirm whether your email sign-up settings were saved. Reload this page to check before trying again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form id="signup" onSubmit={save} aria-busy={saving} className="card mt-8 scroll-mt-32 p-6 sm:p-8" noValidate>
      <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Email sign-up box</h2>
      <p className="mt-2 text-ink-soft">
        A box on your store page where visitors join your email list, without having to take anything. Each address joins only
        after its owner presses the button in a confirmation email, so your list holds real inboxes and nobody is signed up by
        someone else. They land in your list on the Email screen, ready for your broadcasts and welcome emails.
      </p>

      <label className="mt-5 flex items-start gap-3 text-ink">
        <input type="checkbox" disabled={saving} checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-1 size-5 shrink-0 accent-violet-brand" />
        <span className="font-semibold">Show the sign-up box on my store page</span>
      </label>
      {on && blocked ? (
        <p className="mt-3 rounded-2xl bg-sand/60 px-4 py-3 text-sm text-ink">
          {blocked === "plan"
            ? "It shows once your subscription is active again: confirmation emails are part of the plan."
            : "Email is not switched on for this site yet, so the box stays hidden until it is."}
        </p>
      ) : null}

      <div className="mt-5 grid gap-4">
        <div>
          <label htmlFor="join-heading-field" className="field-label">Heading (optional)</label>
          <input
            id="join-heading-field"
            disabled={saving}
            type="text"
            maxLength={MAX_JOIN_HEADING}
            value={heading}
            placeholder={w.heading}
            onChange={(e) => setHeading(e.target.value)}
            className="field mt-2"
          />
        </div>
        <div>
          <label htmlFor="join-line-field" className="field-label">One line under it (optional)</label>
          <textarea
            id="join-line-field"
            disabled={saving}
            rows={2}
            maxLength={MAX_JOIN_LINE}
            value={line}
            placeholder={w.line(storeName)}
            onChange={(e) => setLine(e.target.value)}
            className="field mt-2"
          />
          <p className="mt-1 text-sm text-ink-soft">Left empty, both are written for you in your store&apos;s language. Say what people get, and how often.</p>
        </div>
      </div>

      <div className="mt-5 rounded-2xl bg-paper p-5 ring-1 ring-line" role="group" aria-label="Preview">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-soft">Preview</p>
        <p className="mt-2 text-lg font-semibold text-ink">{heading.trim() || w.heading}</p>
        <p className="mt-1 text-sm text-ink-soft">{line.trim() || w.line(storeName)}</p>
        <div className="mt-3 flex gap-2" aria-hidden="true">
          <span className="flex-1 rounded-full bg-white px-4 py-2 text-sm text-ink-soft ring-1 ring-line">you@example.com</span>
          <span className="rounded-full bg-violet-brand px-4 py-2 text-sm font-semibold text-white">{w.button}</span>
        </div>
      </div>

      {error ? <p role="alert" className="mt-4 text-sm font-semibold text-danger-text">{error}</p> : null}
      <button type="submit" disabled={saving || !changed} className="btn btn-primary mt-5">
        {saving ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
