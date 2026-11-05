"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { type PublicKeyCredentialCreationOptionsJSON, browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import { removalWhen } from "@/lib/removal-time";

export type PasskeyRow = { id: string; name: string; createdAt: string; lastUsedAt: string; synced: boolean };

const MESSAGES: Record<string, string> = {
  expired: "That took longer than five minutes. Press the button again.",
  invalid: "Your browser's answer could not be checked, so nothing was added. Try again.",
  full: "An account holds ten passkeys at most. Remove one you no longer use first.",
  taken: "That passkey is already on an account here.",
  cancelled: "Nothing was added: the passkey prompt was closed.",
  unknown: "That passkey is not on your account anymore. Reload the page.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Try again in a moment.",
  rate_limited: "That is a lot of passkey changes in an hour. Try again later.",
  busy: "Your passkeys are being changed by another request right now. Try again in a moment.",
  unsent: "We could not send the email that tells your account about this, so nothing was set. Try again in a moment.",
  reauth: "Adding a passkey needs a login from the last 15 minutes. Log in again below, then add it.",
  second_step: "Your account already has a passkey or an authenticator app, so adding another needs a login with one of them. Log in again with your passkey or your app's code, then add it here.",
};

type Answer = { ok?: boolean; error?: string; options?: unknown; passkeys?: PasskeyRow[]; removeOn?: number; loggedOut?: boolean };

/** Said inline when a removal is set but the browsers the passkey let in could not be logged out (review of #2556). */
export const SET_NOT_LOGGED_OUT = "The removal is set, but the browsers that logged in with this passkey could not be logged out just now. Choose “Log out of all devices” at the bottom of your studio.";

/** Said inline when a passkey is removed but the browsers it let in could not be logged out (audit SG2, finding 6). */
export const REMOVED_NOT_LOGGED_OUT = "The passkey is removed, but the browsers that logged in with it could not be logged out just now. Choose “Log out of all devices” at the bottom of your studio.";

const onDay = removalWhen;

async function call(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/auth/passkey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

function day(iso: string): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** A name to start from: what the device is, as far as its browser says. */
function guessName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows computer";
  return "This device";
}

const noSubscription = () => () => {};

/**
 * Where this browser remembers, for half an hour, that its person went to log
 * in again in order to add a passkey, so the studio can bring them back to
 * this spot when they return. Only a convenience: the server decides whether
 * the login is recent enough.
 */
const AFTER_LOGIN = "nimbus-passkey-after-login";
const AFTER_LOGIN_MS = 30 * 60 * 1000;

function rememberReturn(): void {
  try {
    window.localStorage.setItem(AFTER_LOGIN, String(Date.now()));
  } catch {
    // Without storage the person simply finds this section themselves.
  }
}

function takeReturn(): boolean {
  try {
    const at = Number(window.localStorage.getItem(AFTER_LOGIN));
    window.localStorage.removeItem(AFTER_LOGIN);
    return Number.isFinite(at) && at > 0 && Date.now() - at < AFTER_LOGIN_MS;
  } catch {
    return false;
  }
}

/**
 * The person's passkeys, in the studio's Account part: add one, see when
 * each was last used, remove one. A passkey is the person's, not a store's,
 * so the list is the same whichever store is open.
 *
 * `needsStep`: the account already has a passkey or an app and this session
 * was not opened with one (lib/second-step-gate.ts), so adding waits for a
 * login with one, and a removal waits `removalDays` with an email to the
 * account (lib/passkeys.ts scheduleRemoval): the way back for a lost passkey.
 * `removals` are the passkeys already waiting, by id, with their day in ms.
 */
export function PasskeyManager({
  initial,
  fresh,
  needsStep = false,
  canKeep = true,
  removals = {},
  removalDays = 7,
}: {
  initial: PasskeyRow[];
  fresh: boolean;
  needsStep?: boolean;
  /** Whether this session may press "Keep it" (lib/second-step-gate.ts mayKeepPasskey); the server checks again. */
  canKeep?: boolean;
  removals?: Record<string, number>;
  removalDays?: number;
}) {
  const supported = useSyncExternalStore(noSubscription, () => browserSupportsWebAuthn(), () => true);
  const [list, setList] = useState(initial);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The login is too old to add a passkey (told by the page, or by the server when it ran out meanwhile). */
  const [stale, setStale] = useState(!fresh);
  /** Adding needs a login with the passkey or app the account already has (told by the page, or by the server). */
  const [blocked, setBlocked] = useState(needsStep);
  const [waiting, setWaiting] = useState(removals);
  const [back, setBack] = useState(false);
  const section = useRef<HTMLElement>(null);
  const nameField = useRef<HTMLInputElement>(null);

  // Back from logging in again to add a passkey: brought to this spot, ready.
  useEffect(() => {
    if (!fresh) return;
    // After the page has settled, and only once however often this runs.
    const timer = window.setTimeout(() => {
      if (!takeReturn()) return;
      setBack(true);
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      section.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      nameField.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  async function add() {
    setBusy("add");
    setError(null);
    try {
      const first = await call({ action: "options" });
      if (first.error === "reauth") {
        setStale(true);
        return;
      }
      if (first.error === "second_step") {
        setBlocked(true);
        return;
      }
      if (!first.ok || !first.options) {
        setError(MESSAGES[first.error ?? ""] ?? MESSAGES.server_error);
        return;
      }
      let response;
      try {
        response = await startRegistration({ optionsJSON: first.options as PublicKeyCredentialCreationOptionsJSON });
      } catch {
        setError(MESSAGES.cancelled);
        return;
      }
      const done = await call({ action: "add", response, name: name.trim() || guessName() });
      if (done.error === "reauth") {
        setStale(true);
        return;
      }
      if (done.error === "second_step") {
        setBlocked(true);
        return;
      }
      if (!done.ok) {
        setError(MESSAGES[done.error ?? ""] ?? MESSAGES.server_error);
        return;
      }
      setList(done.passkeys ?? list);
      setName("");
      setBack(false);
      toast("Passkey added.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: PasskeyRow) {
    const question = blocked
      ? `Remove “${row.name}”? You did not log in with a passkey or an app code (or logged in with a passkey that is set to be removed), so it is removed in ${removalDays} days, and we email you now. To stop it, log in with another passkey or your app's code, then press Keep it next to it. Logging in alone does not stop it.`
      : `Remove “${row.name}”? You will no longer be able to log in with it.`;
    if (!window.confirm(question)) return;
    setBusy(row.id);
    setError(null);
    const done = await call({ action: "remove", id: row.id });
    setBusy(null);
    if (!done.ok) {
      setError(MESSAGES[done.error ?? ""] ?? MESSAGES.server_error);
      return;
    }
    if (typeof done.removeOn === "number") {
      const at = done.removeOn;
      setBlocked(true);
      setWaiting((rows) => ({ ...rows, [row.id]: at }));
      // Something to act on stays inline, never in a toast that goes (components/toast.tsx).
      if (done.loggedOut === false) setError(`“${row.name}” will be removed on ${onDay(at)}. ${SET_NOT_LOGGED_OUT}`);
      else toast(`“${row.name}” will be removed on ${onDay(at)}.`);
      return;
    }
    setList((rows) => rows.filter((r) => r.id !== row.id));
    // Something to act on stays inline, never in a toast that goes (components/toast.tsx).
    if (done.loggedOut === false) setError(REMOVED_NOT_LOGGED_OUT);
    else toast("Passkey removed.");
  }

  /** Calls off a removal that waits: any session may, as keeping a passkey takes nothing away. */
  async function keep(row: PasskeyRow) {
    setBusy(`keep:${row.id}`);
    setError(null);
    const done = await call({ action: "keep", id: row.id });
    setBusy(null);
    if (!done.ok) {
      setError(MESSAGES[done.error ?? ""] ?? MESSAGES.server_error);
      return;
    }
    setWaiting((rows) => Object.fromEntries(Object.entries(rows).filter(([id]) => id !== row.id)));
    toast(`“${row.name}” stays.`);
  }

  return (
    <section ref={section} id="passkeys" aria-labelledby="passkeys-title" className="mt-8 scroll-mt-32 border-t border-line pt-6">
      <h3 id="passkeys-title" className="flex items-center gap-2 font-semibold text-ink">
        <Icon name="key" size={18} className="text-violet-deep" />
        Passkeys
      </h3>
      <p className="mt-2 text-sm text-ink-soft">
        Log in with your fingerprint, face or device PIN instead of waiting for an email. The emailed link keeps
        working either way, so losing a phone never locks you out. We keep only the public half of each key.
      </p>

      {list.length ? (
        <ul className="mt-4 divide-y divide-line rounded-[12px] ring-1 ring-line">
          {list.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
              <span className="min-w-0">
                <span className="block break-words font-semibold text-ink">{row.name}</span>
                <span className="block text-xs text-ink-soft">
                  {`Added ${day(row.createdAt)} · last used ${day(row.lastUsedAt)}${row.synced ? " · synced across your devices" : ""}`}
                </span>
                {waiting[row.id] ? (
                  <span className="block text-xs font-bold text-ink">{canKeep
                    ? `Will be removed on ${onDay(waiting[row.id])}. To keep it, press Keep it.`
                    : `Will be removed on ${onDay(waiting[row.id])}. To keep it, log in with another passkey or your app's code, then press Keep it here. Logging in alone does not keep it.`}</span>
                ) : null}
              </span>
              {waiting[row.id] && canKeep ? (
                <button
                  type="button"
                  onClick={() => void keep(row)}
                  disabled={busy !== null}
                  aria-busy={busy === `keep:${row.id}`}
                  className="inline-flex min-h-11 -my-2.5 items-center text-sm font-bold text-ink underline underline-offset-4"
                >
                  {`Keep it`}
                  <span className="sr-only">{`: keep “${row.name}”`}</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void remove(row)}
                disabled={busy !== null}
                aria-busy={busy === row.id}
                className="inline-flex min-h-11 -my-2.5 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-[12px] bg-paper px-4 py-3 text-sm text-ink-soft ring-1 ring-line">No passkeys yet.</p>
      )}

      {back && !stale ? (
        <p className="notice mt-4" role="status">
          You logged in again. Name this device and add your passkey now.
        </p>
      ) : null}

      {blocked ? (
        <div className="mt-4 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line">
          <p className="text-sm text-ink-soft">{MESSAGES.second_step}</p>
          {list.length ? (
            <p className="mt-2 text-sm text-ink-soft">
              {`Lost your passkey? Press Remove next to it. Because you did not log in with a passkey or an app code (or logged in with a passkey that is set to be removed), it is removed after ${removalDays} days, and we email you now. To stop it, log in with another passkey or your app's code, then press Keep it next to it; logging in alone does not stop it, and the passkey being removed cannot. Once no passkey is left, you can add a new one here. Lost your authenticator app too? After the emailed link, the code page offers a way in that also waits ${removalDays} days; ask for the passkey's removal from there as well, and both waits run at the same time.`}
            </p>
          ) : null}
          <Link href="/signin?status=reauth" onClick={rememberReturn} className="btn btn-secondary mt-3">
            <Icon name="key" size={16} />
            Log in again with a passkey or a code
          </Link>
        </div>
      ) : supported && stale ? (
        <div className="mt-4 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line">
          <p className="text-sm text-ink-soft">
            Adding a passkey needs a login from the last 15 minutes, because a passkey keeps working after this
            session ends. Log in again with a link sent to your email, or with a passkey you already have, and you come
            back here to add it.
          </p>
          <Link href="/signin?status=reauth" onClick={rememberReturn} className="btn btn-secondary mt-3">
            <Icon name="key" size={16} />
            Log in again
          </Link>
        </div>
      ) : supported ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="min-w-0 flex-1 basis-48 text-sm font-bold text-ink">
            Name it
            <input
              ref={nameField}
              className="field mt-1"
              maxLength={60}
              value={name}
              placeholder={`${guessName()}, for example`}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-secondary" disabled={busy !== null} aria-busy={busy === "add"}>
            <Icon name="plus" size={16} />
            {busy === "add" ? "Waiting for your device…" : "Add a passkey"}
          </button>
        </form>
      ) : (
        <p className="mt-4 text-sm text-ink-soft">This browser cannot make passkeys. The emailed link works as always.</p>
      )}
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
