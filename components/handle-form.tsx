"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { ADULT_SENTENCE, ADULT_VERSION } from "@/lib/adult-confirmation";

type State =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  shape:
    "Use 3 to 24 letters, numbers, dots, hyphens or underscores, starting and ending with a letter or number.",
  reserved: "That name belongs to the site itself. Pick another one.",
  taken: "Someone already has that address. Pick another one.",
  already: "This account already has a store.",
  too_many: "An account runs five stores at most.",
  first: "Make your first store before another one.",
  signed_out: "Your session ended. Log in again.",
  adult: "Check the box to confirm you are at least 18, or the age of majority where you live. No store was made.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "We could not confirm whether your store was created. Check the studio before trying again.",
};

/**
 * Taking an address and making a store under it: the account's first, or,
 * with `another`, one more (app/api/store/claim). The studio opens on it.
 *
 * `initial` is the address typed on the home page, already checked by the
 * server with the store's handle rules (lib/handle-prefill.ts), so it is not
 * typed twice (WCAG 3.3.7). It only fills the field: nothing is held until
 * this form is sent, and the creator can change it first.
 *
 * The box "I am at least 18" starts unchecked and is the person's own choice
 * (lib/adult-confirmation.ts, 568 [GD2] (i)); the server makes no store
 * without it. Sent unchecked, the form says why next to the box and moves
 * focus to it, without a request.
 */
export function HandleForm({ another = false, initial = "" }: { another?: boolean; initial?: string }) {
  const [handle, setHandle] = useState(initial);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [adult, setAdult] = useState(false);
  const [adultMissing, setAdultMissing] = useState(false);
  const adultBox = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  const preview = handle.trim().replace(/^@+/, "").toLowerCase();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind === "saving") return;
    if (!adult) {
      setAdultMissing(true);
      setState({ kind: "idle" });
      adultBox.current?.focus();
      return;
    }
    setAdultMissing(false);
    setState({ kind: "saving" });

    try {
      const response = await fetch("/api/store/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, name, bio, another, adult: true, adultVersion: ADULT_VERSION }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const data = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown> : {};
      if (
        response.ok && data.ok === true && !data.error &&
        data.handle === preview &&
        typeof data.store === "string" && /^[0-9a-f]{32}$/.test(data.store)
      ) {
        // A fresh document keeps the studio title and selected store together.
        // A same-route refresh can expose the new body while head metadata changes.
        const destination = new URL(another ? "/studio" : window.location.href, window.location.origin);
        destination.pathname = "/studio";
        destination.searchParams.delete("handle");
        destination.searchParams.set("store", data.store);
        window.location.assign(destination.href);
        return;
      }
      if (data.error === "adult") setAdultMissing(true);
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
    <form onSubmit={submit} aria-busy={state.kind === "saving"} noValidate>
      <fieldset disabled={state.kind === "saving"} className="min-w-0 space-y-5">
      <div>
        <label htmlFor="store-handle" className="field-label">
          Your address
        </label>
        <div className="card mt-2 flex flex-wrap items-center pl-4 transition focus-within:border-violet-brand" data-address-field>
          <span className="max-w-full shrink-0 py-2 text-ink-soft [overflow-wrap:anywhere]">marktmorgen.com/<wbr />@</span>
          <input
            id="store-handle"
            name="handle"
            type="text"
            required
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="yourname"
            className="min-w-0 flex-[1_1_6rem] rounded-r-2xl bg-transparent px-1 py-3.5 text-ink outline-none placeholder:text-ink-soft/60"
          />
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          {preview
            ? `Your store will live at marktmorgen.com/@${preview}`
            : "This is the address you give people. You can change it later, and the old one keeps working."}
        </p>
      </div>

      <div>
        <label htmlFor="store-name" className="field-label">
          Store name
        </label>
        <input
          id="store-name"
          name="name"
          type="text"
          required
          maxLength={60}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="What people should see at the top"
          className="field mt-2"
        />
      </div>

      <div>
        <label htmlFor="store-bio" className="field-label">
          One line about it <span className="font-semibold text-ink-soft">(optional)</span>
        </label>
        <input
          id="store-bio"
          name="bio"
          type="text"
          maxLength={160}
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          placeholder="Who it is for, in one sentence"
          className="field mt-2"
        />
      </div>

      <div>
        <label htmlFor="store-adult" className="flex min-h-11 cursor-pointer items-start gap-3 text-ink">
          <input
            ref={adultBox}
            id="store-adult"
            name="adult"
            type="checkbox"
            required
            checked={adult}
            onChange={(event) => {
              setAdult(event.target.checked);
              if (event.target.checked) setAdultMissing(false);
            }}
            aria-invalid={adultMissing || undefined}
            aria-describedby={adultMissing ? "store-adult-note store-adult-missing" : "store-adult-note"}
            className="mt-0.5 h-5 w-5 shrink-0"
          />
          <span>{ADULT_SENTENCE}</span>
        </label>
        <p id="store-adult-note" className="mt-1 pl-8 text-sm text-ink-soft">
          Everyone who runs a store must be, as section 1 of the{" "}
          <Link href="/terms" className="font-semibold text-ink underline underline-offset-2">Marktmorgen Terms</Link>{" "}
          says.
        </p>
        {adultMissing ? (
          <p id="store-adult-missing" className="notice notice-error mt-2" role="alert">
            {MESSAGES.adult}
          </p>
        ) : null}
      </div>

      {state.kind === "error" && !adultMissing ? (
        <p
          className="notice notice-error "
          role="alert"
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={state.kind === "saving"}
        className="btn btn-primary btn-lg btn-block"
      >
        {state.kind === "saving" ? "Creating…" : another ? "Create this store" : "Create my store"}
      </button>
      </fieldset>
    </form>
  );
}
