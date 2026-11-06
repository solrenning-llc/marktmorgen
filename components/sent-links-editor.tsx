"use client";

import { useEffect, useRef, useState } from "react";
import { type LinkChange, SENT_LINK_CHANGES_MAX, SENT_LINK_MAX_LENGTH, currentOf } from "@/lib/sent-link-rules";

/** One sent email whose links can be changed, as the page reads it. `changes` null: they could not be read just now. */
/** `own`: whether each link went to the store, which then can only go to another page of it. */
export type SentEmailLinks = { id: string; subject: string; sentOn: string; links: string[]; own: boolean[]; changes: LinkChange[] | null };

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/**
 * "Change where a link goes" (124 [F2-EDIT-SENT-LINKS], lib/sent-links.ts):
 * each link of a recent one-off email, where it was written to go, where it
 * goes now, a field to send it somewhere else, and a button to send it back.
 * Every change is listed under its link.
 *
 * Accessibility (WCAG 2.2 AAA, AX274): every field has a visible label and
 * its hint and refusal tied to it (aria-describedby, aria-invalid); a
 * refusal is shown next to its field and stays until that field changes; a
 * button in use is aria-disabled, never disabled, so focus stays on it; one
 * short sentence per step is said in a polite live region, never the whole
 * list; nothing moves or times out; addresses wrap instead of scrolling.
 */
/** `home`: the store's own address, for the example a store link is given. */
export function SentLinksEditor({ emails: initial, home }: { emails: SentEmailLinks[]; home: string }) {
  const [emails, setEmails] = useState(initial);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    document.getElementById(id)?.focus();
  });

  async function change(email: SentEmailLinks, n: number, to: string) {
    const field = `${email.id}-${n}`;
    if (busy) return;
    setBusy(field);
    setLive("");
    setErrors((all) => ({ ...all, [field]: "" }));
    try {
      const response = await fetch("/api/store/mail/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "link-change", id: email.id, n, to }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; changes?: LinkChange[]; message?: string };
      if (answer.ok && Array.isArray(answer.changes)) {
        const changes = answer.changes;
        setEmails((all) => all.map((e) => (e.id === email.id ? { ...e, changes } : e)));
        setTyped((all) => ({ ...all, [field]: "" }));
        const now = currentOf(changes, n) ?? email.links[n];
        setLive(`Link ${n + 1} now goes to ${now}.`);
        focusAfter.current = `${field}-now`;
        return;
      }
      setErrors((all) => ({ ...all, [field]: typeof answer.message === "string" && answer.message ? answer.message : "That did not work. Nothing was changed. Try again in a moment." }));
      setLive(`Link ${n + 1} was not changed.`);
    } catch {
      setErrors((all) => ({ ...all, [field]: "That did not work. Check your connection and try again. Nothing was changed." }));
      setLive(`Link ${n + 1} was not changed.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <p role="status" aria-live="polite" className="sr-only">{live}</p>
      <ul className="space-y-10">
        {emails.map((email) => {
          const used = email.changes?.length ?? 0;
          return (
            <li key={email.id}>
              <section aria-labelledby={`${email.id}-title`} className="card p-5 sm:p-6">
                <h2 id={`${email.id}-title`} className="text-xl font-semibold break-words">{email.subject}</h2>
                <p className="mt-1 text-ink-soft">
                  Sent {email.sentOn}. {email.links.length === 1 ? "1 link" : `${email.links.length} links`} you can change.
                  {email.changes ? ` ${used} of ${SENT_LINK_CHANGES_MAX} changes used.` : ""}
                </p>
                {email.changes === null ? (
                  <p className="mt-3 text-ink">Where these links go now could not be read just now. Reload the page to try again. Each one still goes where it went.</p>
                ) : (
                  <ol className="mt-5 space-y-6">
                    {email.links.map((original, n) => {
                      const field = `${email.id}-${n}`;
                      const changes = email.changes ?? [];
                      const now = currentOf(changes, n) ?? original;
                      const history = changes.filter((c) => c.n === n);
                      const error = errors[field] ?? "";
                      const value = typed[field] ?? "";
                      const working = busy === field;
                      return (
                        <li key={field} className="border-t border-line pt-5">
                          <h3 className="font-semibold">Link {n + 1}</h3>
                          <dl className="mt-2 space-y-1">
                            <div>
                              <dt className="inline text-ink-soft">Written in the email: </dt>
                              <dd className="inline break-all">{original}</dd>
                            </div>
                            <div>
                              <dt className="inline text-ink-soft">Goes to now: </dt>
                              <dd id={`${field}-now`} tabIndex={-1} className="inline break-all font-semibold">{now}</dd>
                            </div>
                          </dl>
                          <form
                            className="mt-3"
                            onSubmit={(event) => {
                              event.preventDefault();
                              if (!working) void change(email, n, value);
                            }}
                          >
                            <label htmlFor={`${field}-to`} className="block font-medium">New address for link {n + 1}</label>
                            <p id={`${field}-hint`} className="mt-1 text-ink-soft">
                              {email.own[n]
                                ? `Starts with https://. This link went to your store, so it can go to another page of your store. For example: ${home}`
                                : `Starts with https://. It can go to another page on ${hostOf(original)}, or to a page of your store. For example: ${exampleFor(original)}`}
                            </p>
                            <input
                              id={`${field}-to`}
                              type="url"
                              inputMode="url"
                              autoComplete="off"
                              spellCheck={false}
                              maxLength={SENT_LINK_MAX_LENGTH}
                              value={value}
                              aria-describedby={`${field}-hint${error ? ` ${field}-error` : ""}`}
                              aria-invalid={error ? true : undefined}
                              onChange={(event) => {
                                setTyped((all) => ({ ...all, [field]: event.target.value }));
                                if (error) setErrors((all) => ({ ...all, [field]: "" }));
                              }}
                              className="input mt-2 w-full"
                            />
                            {error ? <p id={`${field}-error`} className="mt-2 font-medium text-ink">{error}</p> : null}
                            <div className="mt-3 flex flex-wrap gap-3">
                              <button type="submit" className="btn btn-primary" aria-disabled={working || undefined}>
                                {working ? "Saving…" : `Save the new address for link ${n + 1}`}
                              </button>
                              {now !== original ? (
                                <button type="button" className="btn btn-secondary" aria-disabled={working || undefined} onClick={() => { if (!working) void change(email, n, original); }}>
                                  Send link {n + 1} back to where it first went
                                </button>
                              ) : null}
                            </div>
                          </form>
                          {history.length ? (
                            <div className="mt-4">
                              <h4 className="font-medium">Changes to link {n + 1}</h4>
                              <ol className="mt-1 list-decimal space-y-1 pl-6">
                                {history.map((c, i) => (
                                  <li key={`${c.at}-${i}`} className="break-all">
                                    {day(c.at)}: {c.to === original ? `back to where it first went (${c.to})` : c.to}
                                  </li>
                                ))}
                              </ol>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return "the same site";
  }
}

function exampleFor(original: string): string {
  try {
    const url = new URL(original);
    return `${url.origin}/new-page`;
  } catch {
    return "https://example.com/new-page";
  }
}
