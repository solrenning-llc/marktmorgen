"use client";

import { useEffect, useState } from "react";

/** What the inbox route answers (app/api/store/inbox): the same shape the studio's other calls get. */
type Post = (body: Record<string, unknown>) => Promise<Record<string, unknown> & { ok?: boolean; error?: string }>;

type State = { phase: "checking" } | { phase: "unknown" } | { phase: "open" } | { phase: "blocked"; reason: string };

/** The longest note, as lib/buyer-block.ts keeps it. */
const NOTE_MAX = 200;

const REFUSED: Record<string, string> = {
  many: "You have blocked as many people as a store can (500). Let someone write again first.",
  store_full: "Your store's data room is full. Delete something you no longer need, then try again.",
};

/**
 * Block the person of an inbox conversation in the store's messages
 * (567 [GD1] (f), unit 2; the rules are lib/buyer-block.ts). It first checks
 * whether they are blocked; what cannot be read is said as not known, with
 * "Check again", never as "not blocked". The creator's note is theirs alone.
 * Reports about an order the person paid for, and a withdrawal, still reach
 * the creator, and the box says so before anything is done. Every result is
 * said in a live region; blocking can be undone at once.
 */
export function InboxBlock({ id, post }: { id: string; post: Post }) {
  const [state, setState] = useState<State>({ phase: "checking" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");

  // Drawn with key={conversation id}, so a new conversation starts afresh: "checking", no note, nothing said.
  const stateOf = (answer: Record<string, unknown>): State =>
    answer.ok === true && answer.blocked === true
      ? { phase: "blocked", reason: typeof answer.reason === "string" ? answer.reason : "" }
      : answer.ok === true && answer.blocked === false
        ? { phase: "open" }
        : { phase: "unknown" };
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let current = true;
    post({ action: "blocked", id }).then((answer) => {
      if (current) setState(stateOf(answer));
    });
    return () => {
      current = false;
    };
  }, [id, post, asked]);

  async function block(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const reason = note.trim();
    const answer = await post({ action: "block", id, reason });
    setBusy(false);
    if (answer.ok === true && answer.blocked === true) {
      setState({ phase: "blocked", reason });
      setSaid("Blocked. They can no longer write to you from your store.");
    } else {
      setSaid(REFUSED[String(answer.error)] ?? "That did not work, so nothing changed. Check your connection and try again.");
    }
  }

  async function unblock() {
    if (busy) return;
    setBusy(true);
    const answer = await post({ action: "unblock", id });
    setBusy(false);
    if (answer.ok === true && answer.blocked === false) {
      setState({ phase: "open" });
      setNote("");
      setSaid("They can write to you again.");
    } else {
      setSaid("That did not work, so they are still blocked. Try again.");
    }
  }

  const control = "btn btn-ghost btn-sm min-h-11 ring-1 ring-line";

  return (
    <div className="mt-4 rounded-2xl p-4 ring-1 ring-line" data-inbox-block>
      {state.phase === "checking" ? <p className="text-sm text-ink-soft">Checking whether you blocked this person…</p> : null}
      {state.phase === "unknown" ? (
        <>
          <p className="text-sm">We could not check whether you blocked this person, so nothing is shown as blocked or not.</p>
          <button
            type="button"
            className={`${control} mt-2`}
            onClick={() => {
              setState({ phase: "checking" });
              setAsked((n) => n + 1);
            }}
          >
            Check again
          </button>
        </>
      ) : null}
      {state.phase === "open" ? (
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">Block this person</summary>
          <form onSubmit={block} className="mt-3 space-y-3">
            <p className="text-sm">
              They can no longer write to you in your store&apos;s chat or contact form. A report about an order they paid for, and a withdrawal from an order, still reach you.
            </p>
            <label className="block">
              <span className="field-label">Your note (only you see it, optional)</span>
              <input className="field" maxLength={NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            <button type="submit" className={control} disabled={busy} aria-busy={busy}>
              Block
            </button>
          </form>
        </details>
      ) : null}
      {state.phase === "blocked" ? (
        <>
          <p className="text-sm font-semibold">You blocked this person. They cannot write to you from your store.</p>
          {state.reason ? <p className="mt-1 text-sm text-ink-soft">Your note: {state.reason}</p> : null}
          <button type="button" className={`${control} mt-2`} disabled={busy} aria-busy={busy} onClick={() => void unblock()}>
            Let them write again
          </button>
        </>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
