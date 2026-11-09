"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  current: "That is the address your store uses now.",
  unknown: "That address does not belong to this store.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing changed.",
  // The stops kept under the address could not be moved to the store first (app/api/store/release/route.ts).
  not_confirmed: "Nothing changed. We could not check your email settings just now. Try again in a moment.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

export function OldAddresses({ handles }: { handles: string[] }) {
  const router = useRouter();
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function release(handle: string) {
    setBusy(handle);
    setError(null);
    try {
      const response = await fetch("/api/store/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        setAsking(null);
        toast(`@${handle} no longer leads to your store.`);
        router.refresh();
        return;
      }
      setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(null);
    }
  }

  if (handles.length === 0) return null;

  return (
    <div className="mt-5 rounded-2xl bg-sand p-4">
      <p className="text-sm font-bold text-ink">
        Your older addresses still work
      </p>

      <ul className="mt-3 space-y-3">
        {handles.map((handle) => (
          <li key={handle}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-sm text-ink-soft">
                marktmorgen.com/@{handle}
              </span>
              {asking === handle ? null : (
                <button
                  type="button"
                  onClick={() => {
                    setAsking(handle);
                    setError(null);
                  }}
                  className="text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-danger"
                >
                  Let it go
                </button>
              )}
            </div>

            {asking === handle ? (
              <div className="mt-2 rounded-2xl border-2 border-pink-brand/30 bg-white p-4">
                <p className="text-sm text-ink-soft">
                  Any link already published under{" "}
                  <strong className="text-ink">@{handle}</strong> stops working
                  right away, and in 30 days the name can be taken by someone
                  else. Only let go of an address you never gave to anyone.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy === handle}
                    onClick={() => release(handle)}
                    className="btn btn-danger-solid btn-sm"
                  >
                    {busy === handle ? "Letting go…" : "Yes, let it go"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAsking(null)}
                    className="btn btn-ghost btn-sm"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {error ? (
        <p
          className="notice notice-error mt-3"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <p className="mt-3 text-sm text-ink-soft">
        Anyone opening one of these lands on your store. Nothing you already
        published has to be changed.
      </p>
    </div>
  );
}
