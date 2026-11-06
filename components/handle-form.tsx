"use client";

import { useState } from "react";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

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
 */
export function HandleForm({ another = false, initial = "" }: { another?: boolean; initial?: string }) {
  const [handle, setHandle] = useState(initial);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  const preview = handle.trim().replace(/^@+/, "").toLowerCase();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind === "saving") return;
    setState({ kind: "saving" });

    try {
      const response = await fetch("/api/store/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, name, bio, another }),
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
        <div className="card mt-2 flex items-center pl-4 transition focus-within:border-violet-brand">
          <span className="text-ink-soft">marktmorgen.com/@</span>
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
            className="min-w-0 w-full rounded-r-2xl bg-transparent px-1 py-3.5 text-ink outline-none placeholder:text-ink-soft/60"
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

      {state.kind === "error" ? (
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
