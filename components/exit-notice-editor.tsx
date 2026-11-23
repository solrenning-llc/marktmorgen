"use client";

import { useEffect, useRef, useState } from "react";
import { useStudioStore } from "@/components/studio-store-pin";

/**
 * The form of app/studio/moved: the closing store's new address, saved or
 * removed by a press, with what happened said in a status region that takes
 * the focus (97 [D2-OPEN-EXIT]). The server checks the address again
 * (lib/exit-redirect-rules.ts, exitDestination); the words below say why one
 * is refused and what to type instead.
 */
type State = { kind: "idle" | "sending" } | { kind: "done" | "error"; message: string };

function refusal(code: unknown): string {
  switch (code) {
    case "not_https":
      return "Use an address that starts with https://.";
    case "not_address":
      return "That is not a web address. Type the whole address, for example https://www.example.com.";
    case "credentials":
      return "Leave out any user name or password from the address.";
    case "port":
      return "Use the address without a port number (the part after a colon in the name).";
    case "not_public":
      return "Use a public web address. Addresses of a home or office network, or written as numbers, cannot be used.";
    case "own_site":
      return "Use an address outside Marktmorgen.";
    case "too_long":
      return "That address is too long. Use a shorter one, such as your site's home page.";
    case "empty":
      return "Type your new address first.";
    case "not_closing":
      return "This can be set only before your store's closing day. Nothing was changed.";
    case "signed_out":
      return "Sign in again, then come back to this page. Nothing was changed.";
    case "forbidden":
      return "Your role on this store cannot change this. Nothing was changed.";
    default:
      return "It could not be saved just now. Nothing was changed. Try again in a minute.";
  }
}

export function ExitNoticeEditor({ current, back }: { current: string; back: string }) {
  const sid = useStudioStore();
  const [value, setValue] = useState(current);
  const [saved, setSaved] = useState(current);
  const [state, setState] = useState<State>({ kind: "idle" });
  const said = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.kind === "done" || state.kind === "error") said.current?.focus();
  }, [state]);

  async function send(to: string) {
    if (!sid || state.kind === "sending") return;
    if (!to.trim() && !saved) {
      setState({ kind: "error", message: refusal("empty") });
      return;
    }
    setState({ kind: "sending" });
    try {
      const response = await fetch("/api/store/exit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-nimbus-store": sid },
        body: JSON.stringify({ to: to.trim() }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: unknown; to?: unknown };
      if (!response.ok || data.ok !== true) {
        setState({ kind: "error", message: refusal(data.error) });
        return;
      }
      const kept = typeof data.to === "string" ? data.to : "";
      setSaved(kept);
      setValue(kept);
      setState({ kind: "done", message: kept ? `Saved. After your store closes, its old address shows a link to ${kept}.` : "Removed. After your store closes, its old address shows no new address." });
    } catch {
      setState({ kind: "error", message: refusal("") });
    }
  }

  return (
    <form
      className="mt-8 max-w-2xl"
      onSubmit={(event) => {
        event.preventDefault();
        void send(value);
      }}
    >
      <label htmlFor="exit-to" className="block font-semibold text-ink">
        Your store&apos;s new address
      </label>
      <p id="exit-to-hint" className="mt-1 text-sm text-ink-soft">
        The whole address, starting with https://. For example, https://www.example.com.
      </p>
      <input
        id="exit-to"
        name="to"
        type="url"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        maxLength={2048}
        className="field mt-2 w-full"
        aria-describedby="exit-to-hint"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={state.kind === "sending"} aria-busy={state.kind === "sending"}>
          {state.kind === "sending" ? "Saving…" : "Save the new address"}
        </button>
        {saved ? (
          <button type="button" className="btn btn-secondary" disabled={state.kind === "sending"} onClick={() => void send("")}>
            Remove the new address
          </button>
        ) : null}
        <a href={back} className="link-arrow">
          Back to the studio
        </a>
      </div>
      <p ref={said} tabIndex={-1} role="status" className={state.kind === "error" ? "mt-4 notice notice-warn" : "mt-4 text-ink"}>
        {state.kind === "done" || state.kind === "error" ? state.message : ""}
      </p>
    </form>
  );
}
