"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import { MAKER_UNRECORDED, MAX_KEY_NAME, MAX_KEYS, pausedWords, type ShownKey, turnOnNote } from "@/lib/api-key-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  name: "Give the key a name, so you can tell later what uses it.",
  full: `A store can have ${MAX_KEYS} keys. Revoke one you no longer use first.`,
  unknown: "That key is already gone. Reload the page.",
  unavailable: "Keys cannot be made right now. Nothing was changed.",
  signed_out: "Your session ended. Log in again.",
  role: "Only the store's owner and Admins can make a key that writes.",
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
  second_step:
    "You logged in this time with the emailed link alone, and your account has a passkey or an authenticator app. Log in again with your passkey, or with the emailed link and your app's code, then make the key. Nothing was made.",
  second_step_on:
    "To turn a key back on, log in with a second step: your passkey, or the emailed link and your authenticator app's code. No second step yet? Add a passkey or turn on an app under Two-step login, then log in again with it.",
  not_yours: "Only whoever made this key can turn it back on. You can revoke it instead.",
  two_step_required: "This store's owner asks everyone on the team to log in with a second step. Log in again with your passkey, or with the emailed link and your app's code, then try again.",
  not_paused: "That key is already on. Reload the page.",
  whose: "Choose whose key it is: yours, or a person on the team.",
  role_disallows: "That person's role does not allow such a key. Change their role first, choose someone else, or revoke the key.",
  owner_only: "Only the store's owner can revoke a key made by someone no longer on the team.",
};

/** When, in the creator's own time zone: this runs in their browser. */
function when(seconds: number): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The keys a creator gives their own tools to read the store with.
 *
 * Shown in full once, when it is made, and never again: the studio keeps only
 * a fingerprint of it, so there is nothing here to show a second time and
 * nothing in the database for anybody to lift.
 */
export function ApiKeyEditor({ keys: first }: { keys: ShownKey[] }) {
  const [keys, setKeys] = useState<ShownKey[]>(first);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [made, setMade] = useState<{ key: string; name: string; paused: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Revoking asks twice, in the page: a key revoked by a slip stops a
  // creator's automation, and there is no putting it back.
  const [revoking, setRevoking] = useState<string | null>(null);
  // Turning a paused key back on asks once too, saying what it means (turnOnNote): it is not paused again by the rule.
  const [turning, setTurning] = useState<string | null>(null);
  // For a key that could not be linked to anyone: whose the owner says it is, "owner" or a teammate's address.
  const [whose, setWhose] = useState("");

  async function send(payload: Record<string, unknown>, which: string) {
    setBusy(which);
    setError(null);
    try {
      const response = await fetch("/api/store/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; key?: string; paused?: boolean; keys?: ShownKey[] };
      if (!data.ok) {
        setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
        return null;
      }
      if (data.keys) setKeys(data.keys);
      return data;
    } catch {
      setError(MESSAGES.server_error);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function make(event: React.FormEvent) {
    event.preventDefault();
    const data = await send({ action: "make", name, write }, "make");
    if (data?.key) {
      setMade({ key: data.key, name: name.trim(), paused: data.paused === true });
      setName("");
      setWrite(false);
      setCopied(false);
    }
  }

  async function revoke(id: string) {
    const data = await send({ action: "revoke", id }, `revoke:${id}`);
    if (data) {
      setRevoking(null);
      toast("Key revoked. Anything still using it is refused from now on.");
    }
  }

  // A key the team's two-step rule paused (owner C3-100), turned back on by whoever made it.
  async function turnOn(id: string, as = "") {
    const data = await send({ action: "turn_on", id, ...(as ? { as } : {}) }, `on:${id}`);
    setTurning(null);
    if (data) toast("Key turned back on. Anything using it works again.");
  }

  async function copy() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.key);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // The field is selectable; copying by hand still works.
    }
  }

  const full = keys.length >= MAX_KEYS;

  return (
    <section id="api" className="card mt-8 scroll-mt-32 p-6 sm:p-8" aria-labelledby="api-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="api-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          API keys
        </h2>
        <span className={`tag ${keys.length ? "tag-live" : ""}`}>{`${keys.length} of ${MAX_KEYS}`}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        Let your own tools read your store: your list, your members, your students, your affiliates and your bookings.
        A key reads and changes nothing, unless you make it one that can also write: add people to your list, change
        their labels, and give or take back products.{" "}
        <Link href="/developers" className="font-semibold text-ink underline underline-offset-4">
          What each address returns
        </Link>
      </p>

      {made ? (
        <div className="notice notice-success mt-5" role="status">
          <p className="font-semibold text-ink">{`Your key for ${made.name}`}</p>
          <p className="mt-1 text-sm text-ink-soft">
            Shown this once. Keep it where only your tool can read it, and never in a web page: anybody who opens the page
            could copy it.
          </p>
          {made.paused ? (
            <p className="mt-1 text-sm font-semibold text-ink">
              It is paused: the team now logs in with a second step. Log in again with yours, then press Turn back on below.
            </p>
          ) : null}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <label htmlFor="api-key" className="sr-only">API key</label>
            <input id="api-key" readOnly value={made.key} onFocus={(e) => e.currentTarget.select()} className="field min-w-0 flex-1 font-mono text-sm" />
            <button type="button" onClick={copy} className="btn btn-secondary shrink-0">
              <Icon name={copied ? "check" : "key"} size={16} />
              <span aria-live="polite">{copied ? "Copied" : "Copy key"}</span>
            </button>
          </div>
          <button type="button" onClick={() => setMade(null)} className="btn btn-ghost btn-sm mt-2">
            I have kept it
          </button>
        </div>
      ) : null}

      {keys.length ? (
        <ul className="mt-5 space-y-3">
          {keys.map((key) => (
            <li key={key.id} className="rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">{key.name}</span>
                  <span className="mt-1 block text-sm text-ink-soft">
                    <span className="font-mono">{`nl_live_${key.hint}…`}</span>
                    {` · ${key.write ? "Reads and writes" : "Reads only"} · ${key.maker === MAKER_UNRECORDED ? `Made ${when(key.madeAt)} (who made it was not recorded)` : `Made by ${key.maker} on ${when(key.madeAt)}`} · ${key.usedAt ? `Last used ${when(key.usedAt)}` : "Never used"}`}
                  </span>
                  {key.paused ? (
                    <span className="mt-1 block text-sm">
                      <span className="font-semibold text-ink">Paused.</span>{" "}
                      <span className="text-ink-soft">
                        {pausedWords(key)}
                      </span>
                    </span>
                  ) : null}
                </span>
                {turning === key.id ? (
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="max-w-xl text-ink">
                      <span className="font-semibold">Turn it back on?</span> {turnOnNote(key, whose)}
                    </span>
                    {key.why === "unmatched" ? (
                      <label className="flex flex-wrap items-center gap-2" htmlFor={`whose-${key.id}`}>
                        <span className="font-semibold text-ink">Whose key is it?</span>
                        <select id={`whose-${key.id}`} value={whose} onChange={(e) => setWhose(e.target.value)} className="field min-h-11 w-auto">
                          <option value="">Choose a person</option>
                          <option value="owner">Mine</option>
                          {key.whoseChoices.map((email) => (
                            <option key={email} value={email}>
                              {email}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => turnOn(key.id, key.why === "unmatched" ? whose : "")}
                      disabled={busy !== null || (key.why === "unmatched" && !whose)}
                      aria-busy={busy === `on:${key.id}`}
                      className="btn btn-primary btn-sm"
                    >
                      {busy === `on:${key.id}` ? "Turning on…" : "Yes, turn it on"}
                    </button>
                    <button type="button" onClick={() => setTurning(null)} className="btn btn-ghost btn-sm">Keep it paused</button>
                  </span>
                ) : revoking === key.id ? (
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold text-ink">Revoke it? Anything using it stops working, and so do the webhook endpoints it added.</span>
                    <button type="button" onClick={() => revoke(key.id)} disabled={busy !== null} aria-busy={busy === `revoke:${key.id}`} className="btn btn-danger btn-sm">
                      {busy === `revoke:${key.id}` ? "Revoking…" : "Yes, revoke"}
                    </button>
                    <button type="button" onClick={() => setRevoking(null)} className="btn btn-ghost btn-sm">Keep it</button>
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    {key.mayTurnOn ? (
                      <button type="button" onClick={() => {
                          setTurning(key.id);
                          setWhose("");
                        }} disabled={busy !== null} className="btn btn-primary btn-sm">
                        Turn back on
                      </button>
                    ) : null}
                    {key.mayRevoke ? (
                      <button type="button" onClick={() => setRevoking(key.id)} disabled={busy !== null} className="btn btn-secondary btn-sm">
                        Revoke
                      </button>
                    ) : null}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {full ? (
        <p className="mt-5 text-sm text-ink-soft">{`You have ${MAX_KEYS} keys, the most a store can have. Revoke one to make another.`}</p>
      ) : (
        <form onSubmit={make} className="mt-5 flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="block min-w-0 flex-1" htmlFor="api-key-name">
            <span className="field-label">What will use it</span>
            <input
              id="api-key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_KEY_NAME}
              placeholder="Zapier, my CRM sync…"
              className="field mt-2"
              required
            />
          </label>
          <button type="submit" disabled={busy !== null} aria-busy={busy === "make"} className="btn btn-primary shrink-0">
            {busy === "make" ? "Making…" : "Make a key"}
          </button>
          </div>
          <label htmlFor="api-key-write" className="flex cursor-pointer items-start gap-3 text-sm">
            <input id="api-key-write" type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" />
            <span>
              <span className="font-semibold text-ink">It can also write.</span>{" "}
              <span className="text-ink-soft">
                Add people who agreed to hear from you to your list, change their labels, and give or take back products,
                as an import does. Chosen now, for good: a key made to read stays one that reads.
              </span>
            </span>
          </label>
        </form>
      )}

      {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}
    </section>
  );
}
