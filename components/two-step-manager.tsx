"use client";

import { useMemo, useState } from "react";
import { EmailInput } from "@/components/email-input";
import Link from "next/link";
import QRCode from "qrcode";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import { qrSvg } from "@/lib/share-links";

const MESSAGES: Record<string, string> = {
  wrong: "That code is not right. Type the six digits your app shows now.",
  expired: "That took longer than ten minutes. Start again.",
  already: "Two-step login is already on. Reload the page.",
  limited: "That is a lot of codes in an hour. Try again later.",
  unreadable: "Your app's codes cannot be checked right now, after a security change on our side. Use a recovery code.",
  reauth: "Turning this on needs a login from the last 15 minutes. Log in again, then come back here.",
  rate_limited: "That is a lot of changes in an hour. Try again later.",
  unavailable: "Two-step login is not available on this deployment yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Try again in a moment.",
  backup: "Type the email address of a second inbox you can open, to get back in if you lose your phone.",
  same: "The recovery address has to be another inbox than the one you log in with: that is what makes it a way back in.",
  unsent: "The code could not be emailed to that address just now. Check it, and try again.",
  "backup-wrong": "The code from your recovery address is not right. Type the six digits in the email we sent there.",
};

type Answer = { ok?: boolean; error?: string; secret?: string; uri?: string; codes?: string[] };

async function call(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/auth/two-step", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

/** The QR code an authenticator app scans, drawn here from the address: nothing is sent anywhere to draw it. */
function Qr({ uri }: { uri: string }) {
  const svg = useMemo(() => {
    try {
      const code = QRCode.create(uri, { errorCorrectionLevel: "M" });
      return qrSvg(Array.from(code.modules.data, Boolean), code.modules.size, 5);
    } catch {
      return "";
    }
  }, [uri]);
  if (!svg) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- drawn here as a data address; there is nothing to optimise
    <img
      src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
      alt="QR code to scan with your authenticator app"
      width={200}
      height={200}
      className="h-[200px] w-[200px] rounded-[8px] ring-1 ring-line"
    />
  );
}

function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `Marktmorgen recovery codes\nEach works once, in place of the code from your app.\n\n${codes.join("\n")}\n`;
  return (
    <div className="mt-4 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line">
      <p className="font-semibold text-ink">Save these recovery codes now</p>
      <p className="mt-1 text-sm text-ink-soft">
        They are shown this once. Each logs you in once without your phone. Keep them somewhere apart from your phone, such as your password manager.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm text-ink sm:grid-cols-5">
        {codes.map((code) => (
          <li key={code} className="rounded-[8px] bg-white px-2 py-1 text-center ring-1 ring-line">
            {code}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-3">
        <a className="btn btn-secondary" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download="marktmorgen-recovery-codes.txt">
          <Icon name="download" size={16} />
          Download them
        </a>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          I saved them
        </button>
      </div>
    </div>
  );
}

/**
 * The person's two-step login (lib/two-step.ts), in the studio's Account part,
 * beside their passkeys: turn it on with an authenticator app, see how many
 * recovery codes are left, make new ones, or turn it off.
 */
export function TwoStepManager({ on: initialOn, codesLeft: initialLeft, reset: initialReset, backup: backupShown, fresh, locked = false }: { on: boolean; codesLeft: number; reset: number; backup: string; fresh: boolean; locked?: boolean }) {
  const [reset, setReset] = useState(initialReset);
  const [recoveryShown, setRecoveryShown] = useState(backupShown);
  const [on, setOn] = useState(initialOn);
  const [left, setLeft] = useState(initialLeft);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [backup, setBackup] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The login is too old to turn it on (told by the page, or by the server when it ran out meanwhile). */
  const [stale, setStale] = useState(!fresh && !initialOn);
  const [asking, setAsking] = useState<"off" | "codes" | null>(null);

  async function run(payload: Record<string, unknown>, after: (answer: Answer) => void) {
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
    setCode("");
    after(answer);
  }

  const codeField = (label: string) => (
    <label className="block min-w-0 flex-1 basis-48 text-sm font-bold text-ink">
      {label}
      <input className="field mt-1 tracking-[0.15em]" inputMode="text" autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
    </label>
  );

  return (
    <section id="two-step" aria-labelledby="two-step-title" className="mt-8 scroll-mt-32 border-t border-line pt-6">
      <h3 id="two-step-title" className="flex items-center gap-2 font-semibold text-ink">
        <Icon name="lock" size={18} className="text-violet-deep" />
        Two-step login
      </h3>
      <p className="mt-2 text-sm text-ink-soft">
        {on
          ? `On. Logging in with the emailed link also asks for the code in your authenticator app; a passkey needs no code. ${left} recovery ${left === 1 ? "code" : "codes"} left.${recoveryShown ? ` Lose your phone and your codes, and a link to your recovery address, ${recoveryShown}, lets you back in.` : " There is no recovery address: add one above, so losing your phone never keeps you out."}`
          : "After the emailed link, ask for a six-digit code from an authenticator app, such as Google Authenticator, Microsoft Authenticator, 1Password or Authy. Someone who gets into your email still cannot open your studio without your phone. A passkey needs no code."}
      </p>

      {locked ? (
        <p className="notice mt-4 text-sm" role="status">
          You got in without your second step, so two-step login cannot be changed from this browser until it turns off; the date is at the top of your studio.
        </p>
      ) : null}

      {!locked && on && reset > 0 ? (
        <div className="notice notice-warn mt-4" role="status">
          <p className="text-sm text-ink">
            {`Set to turn off on ${new Date(reset).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}, asked from the login page by somebody without a code or a passkey. If that was not you, cancel it and change your email password.`}
          </p>
          <button
            type="button"
            className="btn btn-primary mt-3"
            disabled={busy}
            onClick={() =>
              void run({ action: "cancel" }, () => {
                setReset(0);
                toast("Canceled. Two-step login stays on.");
              })
            }
          >
            Cancel: keep two-step login on
          </button>
        </div>
      ) : null}

      {codes ? (
        <Codes
          codes={codes}
          onDone={() => {
            setCodes(null);
            toast("Two-step login is set.");
          }}
        />
      ) : null}

      {locked ? null : stale && !on ? (
        <div className="mt-4 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line">
          <p className="text-sm text-ink-soft">{MESSAGES.reauth}</p>
          <Link href="/signin?status=reauth" className="btn btn-secondary mt-3">
            Log in again
          </Link>
        </div>
      ) : !on && !setup ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "start", backup }, (answer) => answer.secret && answer.uri && setSetup({ secret: answer.secret, uri: answer.uri }));
          }}
        >
          {recoveryShown ? (
            <p className="min-w-0 flex-1 basis-60 text-sm text-ink-soft">{`Your recovery address, ${recoveryShown}, is the way back in if you ever lose your phone.`}</p>
          ) : (
            <div className="min-w-0 flex-1 basis-60">
              <label htmlFor="two-step-backup" className="block text-sm font-bold text-ink">
                Recovery address
              </label>
              <span id="two-step-backup-hint" className="block text-xs font-normal text-ink-soft">A second inbox you can open. If you ever lose your phone, a link sent there lets you straight back in.</span>
              <EmailInput id="two-step-backup" className="field mt-1" required autoComplete="email" value={backup} onChange={setBackup} describedBy="two-step-backup-hint" />
            </div>
          )}
          <button type="submit" className="btn btn-secondary" disabled={busy}>
            <Icon name="lock" size={16} />
            Turn on two-step login
          </button>
        </form>
      ) : !on && setup ? (
        <div className="mt-4 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line">
          <p className="text-sm text-ink-soft">Scan this with your authenticator app, or type the key into it. Then type the six digits it shows.</p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Qr uri={setup.uri} />
            <p className="min-w-0 break-all font-mono text-sm text-ink">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
          </div>
          <form
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run({ action: "finish", code, backupCode }, (answer) => {
                setOn(true);
                setSetup(null);
                if (!recoveryShown) setRecoveryShown(backup.trim());
                setLeft(answer.codes?.length ?? 0);
                setCodes(answer.codes ?? []);
              });
            }}
          >
            {codeField("Code from the app")}
            {recoveryShown ? null : (
              <label className="block min-w-0 flex-1 basis-48 text-sm font-bold text-ink">
                {`Code sent to ${backup}`}
                <input className="field mt-1 tracking-[0.15em]" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={backupCode} onChange={(e) => setBackupCode(e.target.value)} />
              </label>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Checking…" : "Turn it on"}
            </button>
          </form>
        </div>
      ) : asking ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (asking === "off") {
              void run({ action: "off", code }, () => {
                setOn(false);
                setAsking(null);
                toast("Two-step login is off.");
              });
            } else {
              void run({ action: "codes", code }, (answer) => {
                setAsking(null);
                setLeft(answer.codes?.length ?? 0);
                setCodes(answer.codes ?? []);
              });
            }
          }}
        >
          {codeField(asking === "off" ? "A code from your app, to turn it off" : "A code from your app, for new recovery codes")}
          <button type="submit" className={`btn ${asking === "off" ? "btn-secondary" : "btn-primary"}`} disabled={busy}>
            {asking === "off" ? "Turn it off" : "Make new codes"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className="btn btn-secondary" onClick={() => setAsking("codes")}>
            New recovery codes
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setAsking("off")}>
            Turn it off
          </button>
        </div>
      )}
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
