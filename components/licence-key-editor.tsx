"use client";

import { ConfirmAction } from "@/components/confirm-action";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { SITE_URL } from "@/lib/site-url";
import type { Product } from "@/lib/store";
import {
  DEFAULT_KEYS,
  DEFAULT_LOW_AT,
  MAX_GROUPS,
  MAX_GROUP_LENGTH,
  MAX_KEY_FILE_BYTES,
  MAX_LOW_AT,
  MAX_POOL_KEYS,
  MAX_PREFIX_LENGTH,
  MAX_UPLOAD_KEYS,
  MIN_GROUPS,
  MIN_GROUP_LENGTH,
  type IssuedKey,
  type KeyCounts,
  type KeySetup,
  type KeySource,
  canHaveKeys,
  sampleKey,
} from "@/lib/licence-key-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  source: "Choose where the keys come from.",
  prefix: `Use up to ${MAX_PREFIX_LENGTH} letters, digits and dashes for the start of each key.`,
  groups: `Choose ${MIN_GROUPS} to ${MAX_GROUPS} groups.`,
  length: `Choose ${MIN_GROUP_LENGTH} to ${MAX_GROUP_LENGTH} characters in each group.`,
  low: `Type a number from 0 to ${MAX_LOW_AT.toLocaleString("en-US")}.`,
  kind: "License keys work only on paid products sold once, not on free products, memberships, calls, courses or bundles.",
  unknown: "This product was not found. It may have been deleted; reload the page.",
  too_big: `That file is too big to read. Split it into files of up to ${MAX_UPLOAD_KEYS.toLocaleString("en-US")} keys.`,
  too_many: `That is more than ${MAX_UPLOAD_KEYS.toLocaleString("en-US")} keys. Upload them in parts of up to ${MAX_UPLOAD_KEYS.toLocaleString("en-US")}.`,
  no_keys: "No keys were found in that. Put one key per line, or the key in the first column of a CSV.",
  unknown_key: "That key was never given by this product.",
  off: "License keys are off for this product.",
  signed_out: "Your session ended. Log in again.",
  store_full: "Your store has reached the most it can hold. Remove something, or shorten a long list of choices, first.",
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
};

type Loaded = {
  setup: KeySetup;
  sample: string;
  counts: KeyCounts;
  keys: IssuedKey[];
  matching: number;
};

type Answer = { ok?: boolean; error?: string } & Record<string, unknown>;

async function call(method: "GET" | "POST", url: string, body?: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

const count = (n: number) => n.toLocaleString("en-US");
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const quiet = "text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:opacity-40";

/** A product's license keys in the studio: where they come from, how many are left, and who has which. */
export function LicenceKeyEditor({ product, handle }: { product: Product; handle: string }) {
  const router = useRouter();
  const on = product.keys !== null && canHaveKeys(product);
  const [editing, setEditing] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (q = "") => {
      const data = await call("GET", `/api/store/keys?id=${encodeURIComponent(product.id)}&q=${encodeURIComponent(q)}`);
      if (data.ok && data.on) setLoaded(data as unknown as Loaded);
      else if (!data.ok) setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    },
    [product.id],
  );

  useEffect(() => {
    if (!on) return;
    let live = true;
    (async () => {
      const data = await call("GET", `/api/store/keys?id=${encodeURIComponent(product.id)}`);
      if (!live) return;
      if (data.ok && data.on) setLoaded(data as unknown as Loaded);
      else if (!data.ok) setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    })();
    return () => {
      live = false;
    };
  }, [on, product.id, product.keys]);

  async function post(body: Record<string, unknown>): Promise<Answer> {
    setBusy(true);
    setError(null);
    const data = await call("POST", "/api/store/keys", { id: product.id, ...body });
    setBusy(false);
    if (!data.ok) setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    return data;
  }

  async function upload(text: string) {
    setUploadNote(null);
    if (text.length > MAX_KEY_FILE_BYTES) {
      setError(MESSAGES.too_big);
      return;
    }
    const data = await post({ action: "upload", text });
    if (!data.ok) return;
    const added = Number(data.added) || 0;
    const skipped = [
      Number(data.known) ? `${count(Number(data.known))} already added or given before` : null,
      Number(data.repeated) ? `${count(Number(data.repeated))} repeated in the file` : null,
      Number(data.refused) ? `${count(Number(data.refused))} lines that were not a key` : null,
      Number(data.overflow) ? `${count(Number(data.overflow))} over the ${count(MAX_POOL_KEYS)} a pool holds` : null,
    ].filter(Boolean);
    toast(added === 1 ? "1 key added." : `${count(added)} keys added.`);
    const served = Number(data.served) || 0;
    setUploadNote(
      [
        skipped.length ? `Skipped: ${skipped.join(", ")}.` : null,
        served ? `${count(served)} waiting ${served === 1 ? "buyer was" : "buyers were"} given a key and emailed it.` : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
    );
    setPasted("");
    setPasting(false);
    await load(query);
  }

  if (!canHaveKeys(product)) return null;

  if (!on && !editing) {
    return (
      <div className="mt-3">
        <button type="button" className={quiet} onClick={() => setEditing(true)}>
          Give each buyer a unique license key
        </button>
      </div>
    );
  }

  if (editing || !loaded) {
    return (
      <SetupForm
        initial={product.keys ?? DEFAULT_KEYS}
        busy={busy}
        error={error}
        first={!on}
        onCancel={() => {
          setEditing(false);
          setError(null);
        }}
        onSave={async (setup) => {
          const data = await post({ action: "setup", ...setup });
          if (!data.ok) return;
          toast(on ? "License keys saved." : "License keys are on.");
          setEditing(false);
          router.refresh();
        }}
        loading={on && !loaded && !editing && !error}
      />
    );
  }

  const { setup, counts } = loaded;
  const pool = setup.source === "pool";
  const low = pool && counts.left <= setup.lowAt;
  const checkUrl = `${SITE_URL}/api/store/license?store=${encodeURIComponent(handle)}&product=${encodeURIComponent(product.id)}&key=`;

  return (
    <section className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4" aria-label={`License keys for ${product.title}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">License keys</p>
        <span className="tag tag-live">On</span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        {pool
          ? "Each buyer gets the next key from the list you uploaded, shown on their thank-you page, in their confirmation email and on their list of purchases. No key is ever given twice."
          : `Each buyer gets a new key made for them, like ${loaded.sample}, shown on their thank-you page, in their confirmation email and on their list of purchases. No key is ever given twice.`}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        {pool ? (
          <div className={`rounded-[var(--r-sm)] p-3 ${low ? "bg-danger-soft" : "bg-sand"}`}>
            <dt className="text-xs font-semibold text-ink-soft">Left to give</dt>
            <dd className="text-xl font-semibold tabular-nums text-ink">{count(counts.left)}</dd>
          </div>
        ) : null}
        <div className="rounded-[var(--r-sm)] bg-sand p-3">
          <dt className="text-xs font-semibold text-ink-soft">Given</dt>
          <dd className="text-xl font-semibold tabular-nums text-ink">{count(counts.issued)}</dd>
        </div>
        <div className="rounded-[var(--r-sm)] bg-sand p-3">
          <dt className="text-xs font-semibold text-ink-soft">Revoked</dt>
          <dd className="text-xl font-semibold tabular-nums text-ink">{count(counts.revoked)}</dd>
        </div>
        {pool ? (
          <div className={`rounded-[var(--r-sm)] p-3 ${counts.waiting ? "bg-danger-soft" : "bg-sand"}`}>
            <dt className="text-xs font-semibold text-ink-soft">Buyers waiting</dt>
            <dd className="text-xl font-semibold tabular-nums text-ink">{count(counts.waiting)}</dd>
          </div>
        ) : null}
      </dl>

      {pool && counts.left === 0 ? (
        <p className="notice notice-error mt-3" role="status">
          {counts.waiting
            ? `No keys left, and ${count(counts.waiting)} ${counts.waiting === 1 ? "buyer is" : "buyers are"} waiting for one. Upload more: each waiting buyer gets the next key and an email with it, right away.`
            : "No keys left, so this product shows as sold out and no checkout opens for it. Upload more to sell it again."}
        </p>
      ) : low ? (
        <p className="notice notice-warn mt-3" role="status">
          {`Only ${count(counts.left)} ${counts.left === 1 ? "key" : "keys"} left. You get an email when a pool reaches ${count(setup.lowAt)}; when it is empty the product shows as sold out.`}
        </p>
      ) : null}

      {pool ? (
        <div className="mt-4">
          <input
            ref={file}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={async (event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              if (!chosen) return;
              if (chosen.size > MAX_KEY_FILE_BYTES) {
                setError(MESSAGES.too_big);
                return;
              }
              await upload(await chosen.text());
            }}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => file.current?.click()}>
              Upload a file of keys
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPasting(!pasting)} aria-expanded={pasting}>
              {pasting ? "Close" : "Paste keys"}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            {`A .txt with one key per line, or a .csv with the key in the first column; up to ${count(MAX_UPLOAD_KEYS)} at a time, ${count(MAX_POOL_KEYS)} waiting at once. Keys are handed out in the order they are in the file, exactly as written. A key this product has had before is skipped.`}
          </p>
          {pasting ? (
            <form
              className="mt-3"
              onSubmit={(event) => {
                event.preventDefault();
                upload(pasted);
              }}
            >
              <label htmlFor={`paste-${product.id}`} className="field-label">
                Keys, one per line
              </label>
              <textarea
                id={`paste-${product.id}`}
                rows={6}
                className="field mt-2 font-mono text-sm"
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                spellCheck={false}
              />
              <button type="submit" aria-busy={busy} disabled={busy || !pasted.trim()} className="btn btn-primary btn-sm mt-2">
                {busy ? "Adding…" : "Add these keys"}
              </button>
            </form>
          ) : null}
          {uploadNote ? (
            <p className="mt-2 text-sm text-ink-soft" role="status">
              {uploadNote}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-5">
        <form
          className="flex flex-wrap items-end gap-2"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            load(query);
          }}
        >
          <label className="min-w-[12rem] flex-1">
            <span className="field-label">Keys given</span>
            <input
              type="search"
              className="field field-search mt-2"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find by key, email or order reference"
            />
          </label>
          <button type="submit" className="btn btn-secondary btn-sm">
            Find
          </button>
        </form>
        {loaded.keys.length === 0 ? (
          <p className="mt-3 rounded-[var(--r-sm)] bg-sand p-4 text-sm text-ink-soft">
            {query.trim() ? "No key given by this product matches that." : "No key given yet. The first sale gets the first one."}
          </p>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-line rounded-[var(--r-sm)] border border-line">
              {loaded.keys.map((entry) => (
                <li key={entry.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className={`break-all font-mono font-semibold ${entry.revokedAt ? "text-ink-mute line-through" : "text-ink"}`}>{entry.key}</p>
                    <p className="break-all text-xs text-ink-soft">
                      {[
                        entry.email || "No email on the order",
                        entry.at ? DAY.format(new Date(entry.at * 1000)) : null,
                        entry.reference,
                        entry.revokedBy === "refund" ? "Revoked: refunded in full" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={quiet}
                    disabled={busy}
                    onClick={async () => {
                      const data = await post({ action: "revoke", key: entry.key, revoked: !entry.revokedAt });
                      if (!data.ok) return;
                      toast(entry.revokedAt ? "Key restored." : "Key revoked.");
                      await load(query);
                    }}
                  >
                    {entry.revokedAt ? "Restore" : "Revoke"}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-soft">
              {loaded.matching > loaded.keys.length
                ? `The ${loaded.keys.length} most recent of ${count(loaded.matching)}. Search to find any other.`
                : `${count(loaded.matching)} shown.`}{" "}
              Revoking does not refund anything or reach into your software: it marks the key, and the check below then answers
              &ldquo;revoked.&rdquo; Refunds are made in your Stripe dashboard, and a sale refunded in full there has its key
              revoked here by itself within about five minutes.
            </p>
          </>
        )}
      </div>

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-semibold text-ink">Check keys from your own app</summary>
        <p className="mt-2 text-ink-soft">
          Your software can ask whether a key is one this product gave and is still good. It answers{" "}
          <code className="font-mono">valid</code>, <code className="font-mono">revoked</code> or{" "}
          <code className="font-mono">unknown</code>, and nothing about the buyer. Up to 120 checks a minute from one IP address.
        </p>
        <code className="mt-2 block break-all rounded-[var(--r-sm)] bg-sand px-3 py-2 font-mono text-xs text-ink">{`GET ${checkUrl}THE-KEY`}</code>
      </details>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
        <button type="button" className={quiet} disabled={busy} onClick={() => setEditing(true)}>
          Change how keys are made
        </button>
        {pool && counts.left > 0 ? (
          <ConfirmAction
            className={quiet}
            disabled={busy}
            question="Remove the keys not yet given? They cannot be brought back; keys already given stay with their buyers."
            yes="Yes, remove them"
            onConfirm={async () => {
              const data = await post({ action: "clear" });
              if (!data.ok) return;
              toast("Keys not yet given were removed.");
              await load(query);
            }}
          >
            Remove the keys not yet given
          </ConfirmAction>
        ) : null}
        <button
          type="button"
          className="text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-danger disabled:opacity-40"
          disabled={busy}
          onClick={async () => {
            const data = await post({ action: "off" });
            if (!data.ok) return;
            toast("License keys are off.");
            setLoaded(null);
            router.refresh();
          }}
        >
          Stop giving keys
        </button>
      </div>
    </section>
  );
}

function SetupForm({
  initial,
  busy,
  error,
  first,
  loading,
  onSave,
  onCancel,
}: {
  initial: KeySetup;
  busy: boolean;
  error: string | null;
  first: boolean;
  loading: boolean;
  onSave: (setup: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [source, setSource] = useState<KeySource>(initial.source);
  const [prefix, setPrefix] = useState(initial.prefix);
  const [groups, setGroups] = useState(String(initial.groups));
  const [length, setLength] = useState(String(initial.groupLength));
  const [lowAt, setLowAt] = useState(String(initial.lowAt ?? DEFAULT_LOW_AT));

  if (loading) {
    return (
      <p className="mt-3 text-sm text-ink-soft" role="status">
        Reading your license keys…
      </p>
    );
  }

  const preview = sampleKey({
    prefix: prefix.trim().toUpperCase(),
    groups: Math.min(MAX_GROUPS, Math.max(MIN_GROUPS, Number(groups) || MIN_GROUPS)),
    groupLength: Math.min(MAX_GROUP_LENGTH, Math.max(MIN_GROUP_LENGTH, Number(length) || MIN_GROUP_LENGTH)),
  });

  return (
    <form
      className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ source, prefix, groups, groupLength: length, lowAt });
      }}
    >
      <fieldset>
        <legend className="field-label">Where each buyer&apos;s license key comes from</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--r-sm)] border border-line-strong bg-white p-3 text-sm transition hover:border-violet-brand has-[:checked]:border-violet-brand has-[:checked]:bg-lilac has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet-brand">
            <input type="radio" name="key-source" value="generated" checked={source === "generated"} onChange={() => setSource("generated")} className="mt-0.5 h-4 w-4 accent-violet-brand" />
            <span>
              <span className="block font-semibold text-ink">Made here, one per sale</span>
              <span className="block text-ink-soft">Never runs out. For software that checks keys with the link below.</span>
            </span>
          </label>
          <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--r-sm)] border border-line-strong bg-white p-3 text-sm transition hover:border-violet-brand has-[:checked]:border-violet-brand has-[:checked]:bg-lilac has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet-brand">
            <input type="radio" name="key-source" value="pool" checked={source === "pool"} onChange={() => setSource("pool")} className="mt-0.5 h-4 w-4 accent-violet-brand" />
            <span>
              <span className="block font-semibold text-ink">From a list you upload</span>
              <span className="block text-ink-soft">Keys your own system made. Sold out when the list is used up.</span>
            </span>
          </label>
        </div>
      </fieldset>

      {source === "generated" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="field-label">Starts with (optional)</span>
            <input
              className="field mt-2 font-mono uppercase"
              maxLength={MAX_PREFIX_LENGTH}
              value={prefix}
              onChange={(event) => setPrefix(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
              placeholder="STUDIO"
            />
          </label>
          <label className="block">
            <span className="field-label">Groups</span>
            <input className="field mt-2" type="number" min={MIN_GROUPS} max={MAX_GROUPS} step={1} value={groups} onChange={(event) => setGroups(event.target.value)} />
          </label>
          <label className="block">
            <span className="field-label">Characters per group</span>
            <input className="field mt-2" type="number" min={MIN_GROUP_LENGTH} max={MAX_GROUP_LENGTH} step={1} value={length} onChange={(event) => setLength(event.target.value)} />
          </label>
          <p className="text-sm text-ink-soft sm:col-span-3">
            Keys look like <code className="break-all font-mono font-semibold text-ink">{preview}</code>, with capital letters and digits that cannot be misread (no 0, O, 1 or I).
          </p>
        </div>
      ) : (
        <label className="mt-4 block">
          <span className="field-label">Email me when this many keys are left</span>
          <input className="field mt-2 w-40" type="number" min={0} max={MAX_LOW_AT} step={1} value={lowAt} onChange={(event) => setLowAt(event.target.value)} />
          <span className="mt-2 block text-xs text-ink-soft">
            {first ? "Upload the keys on the next step. Until there are some, this product shows as sold out." : "Once per top-up. 0 emails you only when the last one is given."}
          </span>
        </label>
      )}

      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary btn-sm">
          {busy ? "Saving…" : first ? "Start giving keys" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
