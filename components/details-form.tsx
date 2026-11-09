"use client";

import { useEffect, useRef, useState } from "react";
import { AI_ALLOWANCE_UNKNOWN, allowanceOf } from "@/components/ai-assist";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import { MAX_BIO_LENGTH, MAX_NAME_LENGTH } from "@/lib/store-field-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  name: "Give the store a name before saving.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "We could not confirm whether your name and description changed. Check your page before trying again.",
};

type State =
  | { kind: "closed" }
  | { kind: "open" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

/** Changes the name and the line under it on the public page. */
export function DetailsForm({
  name: current,
  bio: currentBio,
  ai = { on: false, left: 0 },
}: {
  name: string;
  bio: string;
  /** The writing help, and what is left of it this month (lib/ai.ts, writeBio). */
  ai?: { on: boolean; left: number; known?: false };
}) {
  const router = useRouter();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [name, setName] = useState(current);
  const [bio, setBio] = useState(currentBio);
  const [state, setState] = useState<State>({ kind: "closed" });
  const [hint, setHint] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [writing, setWriting] = useState(false);
  const [aiNote, setAiNote] = useState("");
  const [left, setLeft] = useState<number | null>(allowanceOf(ai));

  /** Three lines to choose from, written from what the store sells and the words in the box. */
  async function suggest() {
    setWriting(true);
    setAiNote("");
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "bio", notes: hint }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: string[]; left?: number; error?: string };
      if (data.ok && Array.isArray(data.value)) {
        setLines(data.value);
        if (typeof data.left === "number") setLeft(data.left);
        return;
      }
      setAiNote(
        data.error === "notes"
          ? "Add a product first, or write a few words about your store in the box."
          : data.error === "used"
            ? "This month's writing help is used up. It starts again with your next billing month."
            : "The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.",
      );
    } catch {
      setAiNote("The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.");
    } finally {
      setWriting(false);
    }
  }

  useEffect(() => {
    if (!disclosure.current?.open) {
      setName(current);
      setBio(currentBio);
    }
  }, [current, currentBio]);

  function closeEditor() {
    if (disclosure.current) disclosure.current.open = false;
    setName(current);
    setBio(currentBio);
    setState({ kind: "closed" });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind === "saving" || writing) return;
    setState({ kind: "saving" });

    try {
      const response = await fetch("/api/store/details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, bio }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const data = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown> : {};
      if (
        response.ok && data.ok === true && !data.error &&
        data.name === name.slice(0, MAX_NAME_LENGTH).trim() &&
        data.bio === bio.slice(0, MAX_BIO_LENGTH).trim()
      ) {
        closeEditor();
        toast("Name and description saved.");
        router.refresh();
        return;
      }
      setState({
        kind: "error",
        message: typeof data.error === "string" && Object.hasOwn(MESSAGES, data.error)
          ? MESSAGES[data.error] : MESSAGES.server_error,
      });
    } catch {
      setState({ kind: "error", message: MESSAGES.server_error });
    }
  }

  return (
    <details ref={disclosure}>
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep [&::-webkit-details-marker]:hidden">
        Edit name and description
      </summary>
    <form onSubmit={submit} className="mt-2" aria-busy={state.kind === "saving"} noValidate>
      <fieldset disabled={state.kind === "saving"} className="min-w-0 space-y-4">
      <div>
        <label
          htmlFor="store-name"
          className="field-label"
        >
          Store name
        </label>
        <input
          id="store-name"
          name="name"
          type="text"
          required
          maxLength={MAX_NAME_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="field mt-2"
        />
      </div>

      <div>
        <label htmlFor="store-bio" className="field-label">
          One line about it
        </label>
        <textarea
          id="store-bio"
          name="bio"
          rows={2}
          maxLength={MAX_BIO_LENGTH}
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          className="field mt-2"
        />
        <p className="mt-1 text-sm text-ink-soft">
          {MAX_BIO_LENGTH - bio.length} characters left. It sits under the name
          on your page.
        </p>
        {ai.on ? (
          <div className="mt-3 rounded-2xl border border-violet-brand/25 bg-lilac/40 px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-violet-deep">
              <Icon name="sparkle" size={16} />
              Three lines to choose from, written with AI
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              From your store&apos;s name and what it sells, in your store&apos;s language. Add who it is for if you like.
            </p>
            <label htmlFor="bio-hint" className="sr-only">
              Who your store is for (optional)
            </label>
            <input id="bio-hint" className="field mt-2" maxLength={400} value={hint} placeholder="Who it is for, what makes it yours (optional)" onChange={(e) => setHint(e.target.value)} />
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void suggest()} disabled={writing || (left !== null && left <= 0)} aria-busy={writing}>
                {writing ? "Writing…" : lines.length ? "Three more" : "Suggest three lines"}
              </button>
              <span className="text-xs text-ink-soft">{left === null ? AI_ALLOWANCE_UNKNOWN : `${left} left this month`}</span>
            </div>
            {aiNote ? (
              <p className="notice notice-error mt-2 text-sm" role="alert">
                {aiNote}
              </p>
            ) : null}
            {lines.length ? (
              <ul className="mt-3 space-y-2" aria-label="Suggested lines">
                {lines.map((suggested) => (
                  <li key={suggested} className="flex flex-wrap items-start gap-2 rounded-xl bg-white p-3 ring-1 ring-line">
                    <span className="min-w-0 flex-1 text-sm text-ink">{suggested}</span>
                    <button type="button" className="btn btn-ghost btn-sm ring-1 ring-line" onClick={() => setBio(suggested.slice(0, MAX_BIO_LENGTH))} aria-label={`Use this line: ${suggested}`}>
                      Use this
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      {state.kind === "error" ? (
        <p
          className="notice notice-error "
          role="alert"
        >
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={state.kind === "saving" || writing}
          className="btn btn-primary"
        >
          {state.kind === "saving" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={closeEditor}
          className="btn btn-ghost"
        >
          Cancel
        </button>
      </div>
      </fieldset>
    </form>
    </details>
  );
}
