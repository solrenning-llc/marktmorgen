"use client";

import { useState } from "react";
import { EmailInput } from "@/components/email-input";
import Link from "next/link";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";

const MESSAGES: Record<string, string> = {
  invalid: "Type the email address of a second inbox you can open.",
  same: "The recovery address has to be another inbox than the one you log in with: that is what makes it a way back in.",
  limited: "That is a lot of codes in an hour. Try again later.",
  unsent: "The code could not be emailed to that address just now. Check it, and try again.",
  expired: "That took longer than ten minutes. Start again.",
  wrong: "That code is not right. Type the six digits in the email we sent there.",
  locked: "You got in through your recovery address, so this waits until the date at the top of your studio.",
  reauth: "This needs a login from the last 15 minutes. Log in again, then come back here.",
  rate_limited: "That is a lot of changes in an hour. Try again later.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

async function call(payload: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; address?: string }> {
  try {
    const response = await fetch("/api/auth/recovery-address", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as { ok?: boolean; error?: string; address?: string };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

/**
 * The person's recovery address (lib/recovery-address.ts), in the studio's
 * Account part: the way back in when they can no longer open the inbox they
 * log in with, or lose their phone with two-step login on.
 */
export function RecoveryAddressManager({ shown: initial }: { shown: string }) {
  const [shown, setShown] = useState(initial);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function run(payload: Record<string, unknown>, after: (answer: { address?: string }) => void) {
    setBusy(true);
    setError(null);
    const answer = await call(payload);
    setBusy(false);
    if (answer.error === "reauth") {
      setStale(true);
      return;
    }
    if (!answer.ok) {
      setError(MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error);
      return;
    }
    after(answer);
  }

  return (
    <section id="account-recovery" aria-labelledby="account-recovery-title" className="mt-8 scroll-mt-32 border-t border-line pt-6">
      <h3 id="account-recovery-title" className="flex items-center gap-2 font-semibold text-ink">
        <Icon name="mail" size={18} className="text-violet-deep" />
        Recovery address
      </h3>
      <p className="mt-2 text-sm text-ink-soft">
        {shown
          ? `${shown}. If you can no longer open the inbox you log in with, a link sent here lets you back in at once, from “Cannot open your email any more?” on the login page.`
          : "A second inbox for the day you cannot open the one you log in with: a link sent there lets you back in at once. Without one, or a passkey, losing that inbox means losing the account, and nobody here can open it for you."}
      </p>

      {stale ? (
        <div className="mt-4 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line">
          <p className="text-sm text-ink-soft">{MESSAGES.reauth}</p>
          <Link href="/signin?status=reauth" className="btn btn-secondary mt-3">
            Log in again
          </Link>
        </div>
      ) : sent ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "confirm", code }, (answer) => {
              setShown(answer.address ?? address);
              setSent(false);
              setAddress("");
              setCode("");
              toast("Recovery address saved.");
            });
          }}
        >
          <label className="block min-w-0 flex-1 basis-48 text-sm font-bold text-ink">
            {`Code sent to ${address}`}
            <input className="field mt-1 tracking-[0.15em]" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Checking…" : "Save it"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setSent(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "start", address }, () => setSent(true));
          }}
        >
          <div className="min-w-0 flex-1 basis-60">
            <label htmlFor="account-recovery-email" className="block text-sm font-bold text-ink">
              {shown ? "Change it to" : "Your recovery address"}
            </label>
            <EmailInput id="account-recovery-email" className="field mt-1" required autoComplete="email" value={address} onChange={setAddress} />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={busy}>
            {busy ? "Sending…" : "Send a code there"}
          </button>
          {shown ? (
            <button
              type="button"
              className="inline-flex min-h-11 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm("Remove your recovery address? Losing the inbox you log in with would then need a passkey to get back in.")) return;
                void run({ action: "remove" }, () => {
                  setShown("");
                  toast("Recovery address removed.");
                });
              }}
            >
              Remove
            </button>
          ) : null}
        </form>
      )}
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
