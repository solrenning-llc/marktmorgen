"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { takedownAnswer } from "@/lib/takedown-response";

type Action = { type: "link"; id: string } | { type: "product"; id: string } | { type: "kit" } | { type: "store"; on: boolean };

/** One button that acts on a notice (app/api/takedown), and says what it did. */
/**
 * With `owed`, it sends only the email still owed for a takedown (app/api/takedown, `owed: true`), and never takes
 * anything down.
 */
export function TakedownButton({ token, action, label, danger = false, owed = false }: { token: string; action: Action; label: string; danger?: boolean; owed?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [said, setSaid] = useState("");
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={state !== "idle"}
        aria-busy={state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            const response = await fetch("/api/takedown", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(owed ? { token, action, owed: true } : { token, action }) });
            const raw: unknown = await response.json().catch(() => null);
            const answer = takedownAnswer(response.ok, raw);
            if (answer.ok) {
              setState("done");
              setSaid(`Done: ${answer.done}`);
              router.refresh();
              return;
            }
            setState("idle");
            const error = Boolean(raw) && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "error") ? (raw as Record<string, unknown>).error : null;
            const unsent = error === "notice_unsent";
            if (error === "unconfirmed") {
              setSaid("No email was sent: we could not confirm it was taken down, and it is up now. To take it down, use its own button on this page.");
              router.refresh();
              return;
            }
            setSaid(answer.nothing ? (owed ? "Nothing to do: that email was already sent." : "Nothing to do: it is already down.")
              : unsent ? "It is down, but we could not confirm that the email to the creator went out. Press the button again. If you see this again, write to the creator yourself."
              : "It did not work. Try again.");
          } catch {
            setState("idle");
            setSaid("It did not work. Try again.");
          }
        }}
        className={`btn btn-sm ${danger ? "btn-danger-solid" : "btn-secondary"}`}
      >
        {state === "busy" ? "Working…" : label}
      </button>
      {said ? <span role="status" className="text-sm text-ink-soft">{said}</span> : null}
    </span>
  );
}
