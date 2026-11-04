"use client";

import { useState, useSyncExternalStore } from "react";
import { type PublicKeyCredentialRequestOptionsJSON, browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Icon } from "@/components/icons";
import { passkeyAnswer, type PasskeyAnswer } from "@/lib/passkey-signin-response";

const MESSAGES: Record<string, string> = {
  not_recognised:
    "That passkey does not open an account here. If you removed it from your studio, log in with the emailed link instead.",
  rate_limited: "That is a lot of tries from one place. Wait a few minutes and try again.",
  unavailable: "Logging in is not switched on yet.",
  cancelled: "Nothing happened: the passkey prompt was closed. Try again when you are ready.",
  busy: "Your account's passkeys are being changed right now. Try again in a moment.",
  server_error: "Something went wrong on our side. Try again in a moment, or use the emailed link.",
};

async function call(payload: { action: "options" | "verify"; response?: unknown }): Promise<PasskeyAnswer> {
  const response = await fetch("/api/auth/passkey/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw: unknown = await response.json().catch(() => null);
  return passkeyAnswer(response.ok, raw, payload.action);
}

const noSubscription = () => () => {};

/**
 * "Log in with a passkey", under the email form on /signin.
 *
 * The browser offers whichever passkeys it holds for this site, so nothing is
 * typed. Shown only where the browser can use passkeys at all; the emailed
 * link above always works whether or not this does.
 */
export function PasskeySignIn() {
  const supported = useSyncExternalStore(noSubscription, () => browserSupportsWebAuthn(), () => false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!supported) return null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const first = await call({ action: "options" });
      if (!first.ok || !first.options) {
        setError(!first.ok ? MESSAGES[first.error] ?? MESSAGES.server_error : MESSAGES.server_error);
        return;
      }
      let response;
      try {
        response = await startAuthentication({ optionsJSON: first.options as unknown as PublicKeyCredentialRequestOptionsJSON });
      } catch {
        setError(MESSAGES.cancelled);
        return;
      }
      const done = await call({ action: "verify", response });
      if (done.ok && done.next) {
        window.location.assign(done.next ?? "/studio");
        return;
      }
      setError(!done.ok ? MESSAGES[done.error] ?? MESSAGES.server_error : MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 border-t border-line pt-6">
      <button type="button" onClick={() => void start()} aria-busy={busy} disabled={busy} className="btn btn-secondary btn-block">
        <Icon name="key" size={18} />
        {busy ? "Waiting for your passkey…" : "Log in with a passkey"}
      </button>
      <p className="mt-2 text-center text-sm text-ink-soft">For accounts that added one in their studio.</p>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
