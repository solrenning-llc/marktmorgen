"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { takedownAnswer } from "@/lib/takedown-response";

type Action = { type: "link"; id: string } | { type: "product"; id: string } | { type: "kit" } | { type: "store"; on: boolean };

/** One button that acts on a notice (app/api/takedown), and says what it did. */
export function TakedownButton({ token, action, label, danger = false }: { token: string; action: Action; label: string; danger?: boolean }) {
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
            const response = await fetch("/api/takedown", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action }) });
            const raw: unknown = await response.json().catch(() => null);
            const answer = takedownAnswer(response.ok, raw);
            if (answer.ok) {
              setState("done");
              setSaid(`Done: ${answer.done}`);
              router.refresh();
              return;
            }
            setState("idle");
            const unsent = Boolean(raw) && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "error") && (raw as Record<string, unknown>).error === "notice_unsent";
            setSaid(answer.nothing ? "Nothing to do: it is already down."
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
