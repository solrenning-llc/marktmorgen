"use client";

import { useCallback, useEffect, useState } from "react";
import { useHydrated } from "@/components/use-hydrated";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import type { EmailProvider, Target } from "@/lib/email-platforms";
import type { Buyers, JobView, SyncView } from "@/lib/email-sync";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MAX_TAGS = 3;

/** The four platforms, as the studio shows them, with where each keeps its key. */
const PROVIDERS: { key: EmailProvider; name: string; target: string; tags: string; where: string; placeholder: string }[] = [
  {
    key: "mailchimp",
    name: "Mailchimp",
    target: "audience",
    tags: "Tags",
    where: "In Mailchimp: your profile, then Extras, then API keys, then “Create A Key.” The key ends in something like “-us21.”",
    placeholder: "Your Mailchimp API key (ends in -us21 or similar)",
  },
  {
    key: "kit",
    name: "Kit",
    target: "form",
    tags: "Tags",
    where: "In Kit (formerly ConvertKit): Settings, then Developer, then “Add a new key” under V4 Keys.",
    placeholder: "kit_…",
  },
  {
    key: "beehiiv",
    name: "beehiiv",
    target: "publication",
    tags: "Tags",
    where: "In beehiiv: Settings, then API under Workspace Settings, then “Create New API Key.”",
    placeholder: "Your beehiiv API key",
  },
  {
    key: "mailerlite",
    name: "MailerLite",
    target: "group",
    tags: "Groups",
    where: "In MailerLite: Integrations, then “MailerLite API,” then “Generate new token.”",
    placeholder: "eyJ0eXAiOiJKV1Qi…",
  },
];
const byKey = (key: EmailProvider) => PROVIDERS.find((p) => p.key === key) ?? PROVIDERS[0];

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  limited: "The studio cannot reach your platform again just now: that is twenty requests in a minute, or this month's calls to it are used up. Try again later.",
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
};

type Product = { id: string; title: string; free: boolean };

/** In the reader's own time zone once the page runs; in UTC, marked so, before. */
function when(ms: number, local: boolean): string {
  if (!ms) return "";
  const text = new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(local ? {} : { timeZone: "UTC" }),
  });
  return local ? text : `${text} UTC`;
}

function outcome(job: JobView, local: boolean): { text: string; tone: "ok" | "wait" | "bad" | "quiet" } {
  if (job.state === "added") return { text: "Sent", tone: "ok" };
  if (job.state === "skipped") return { text: "Not sent", tone: "quiet" };
  if (job.state === "queued") return { text: "Sending", tone: "wait" };
  if (job.state === "retrying") return { text: `Try ${job.attempts} failed; next ${when(job.next, local)}`, tone: "wait" };
  return { text: `Failed after ${job.attempts} ${job.attempts === 1 ? "try" : "tries"}`, tone: "bad" };
}

/**
 * The creator's own email platform: connect it with an API key, pick where
 * people go, choose who is sent and with which tags, test it, and see the
 * last sends (lib/email-sync.ts).
 */
export function EmailSyncEditor({ view: initial, products }: { view: SyncView; products: Product[] }) {
  const local = useHydrated();
  const [view, setView] = useState(initial);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const connected = view.connected;

  // The connect form.
  const [provider, setProvider] = useState<EmailProvider>(connected?.provider ?? "mailchimp");
  const [key, setKey] = useState("");

  // The settings form, from what is saved.
  const [target, setTarget] = useState(connected?.target?.id ?? "");
  const [free, setFree] = useState(connected?.free ?? true);
  const [buyers, setBuyers] = useState<Buyers>(connected?.buyers ?? "all");
  const [some, setSome] = useState<string[]>(connected?.products ?? []);
  const [tags, setTags] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(connected?.tags ?? {}).map(([id, list]) => [id, list.join(", ")])),
  );

  const post = useCallback(async (body: Record<string, unknown>, tag: string | null) => {
    if (tag) setBusy(tag);
    setError(null);
    try {
      const response = await fetch("/api/store/email-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        view?: SyncView;
        targets?: Target[];
        working?: boolean;
      };
      if (data.view) setView(data.view);
      if (!data.ok) {
        setError(data.message ?? MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
        return null;
      }
      return data;
    } catch {
      setError(MESSAGES.server_error);
      return null;
    } finally {
      if (tag) setBusy(null);
    }
  }, []);

  // The audiences are read fresh from the platform when the page opens.
  const connectedProvider = connected?.provider ?? null;
  useEffect(() => {
    if (!connectedProvider) return;
    let cancelled = false;
    fetch("/api/store/email-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "targets" }),
    })
      .then((response) => response.json() as Promise<{ ok?: boolean; targets?: Target[]; message?: string }>)
      .then((data) => {
        if (cancelled) return;
        if (data.ok && data.targets) setTargets(data.targets);
        else if (data.message) setError(data.message);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connectedProvider]);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    const data = await post({ action: "connect", provider, key: key.trim() }, "connect");
    if (!data?.view?.connected) return;
    setKey("");
    setReplacing(false);
    setTargets(data.targets ?? []);
    setTarget(data.view.connected.target?.id ?? "");
    toast(`${byKey(data.view.connected.provider).name} connected.`);
  }

  async function refresh() {
    const data = await post({ action: "targets" }, "targets");
    if (data?.targets) {
      setTargets(data.targets);
      toast("List read again.");
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const tagMap = Object.fromEntries(
      Object.entries(tags)
        .map(([id, text]) => [id, text.split(",").map((t) => t.trim()).filter(Boolean).slice(0, MAX_TAGS)] as const)
        .filter(([, list]) => list.length),
    );
    const data = await post({ action: "save", target, free, buyers, products: some, tags: tagMap }, "save");
    if (data) toast("Saved.");
  }

  async function test() {
    const data = await post({ action: "test" }, "test");
    if (!data) return;
    if (data.working) toast(data.message ?? "Connected.");
    else setError(data.message ?? "The connection did not work.");
  }

  async function disconnect() {
    const name = connected ? byKey(connected.provider).name : "the platform";
    const data = await post({ action: "disconnect" }, "disconnect");
    if (data) {
      setTargets(null);
      setTarget("");
      toast(`${name} disconnected. Its key was deleted.`);
    }
  }

  const info = connected ? byKey(connected.provider) : byKey(provider);
  const options = targets ?? (connected?.target ? [connected.target] : []);
  const paid = products.filter((p) => !p.free);
  const toggleSome = (id: string) => setSome(some.includes(id) ? some.filter((x) => x !== id) : [...some, id]);

  return (
    <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="grid min-w-0 gap-6">
        {!view.available ? (
          <p className="notice notice-warn">Keys cannot be stored safely on this deployment yet, so no platform can be connected.</p>
        ) : null}

        {connected && !replacing ? (
          <section className="card p-6 sm:p-8" aria-labelledby="platform-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-lilac text-violet-deep">
                  <Icon name="plug" size={18} />
                </span>
                <div>
                  <h2 id="platform-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                    {info.name}
                  </h2>
                  <p className="text-sm text-ink-soft">
                    API key <span className="font-mono tracking-wider text-ink">{`••••${connected.last4}`}</span>
                  </p>
                </div>
              </div>
              <span className={`tag ${connected.problem ? "" : connected.target ? "tag-live" : ""}`}>
                {connected.problem ? "Needs attention" : connected.target ? "Sending" : `Choose ${info.target === "audience" ? "an" : "a"} ${info.target}`}
              </span>
            </div>

            {connected.problem ? (
              <p className="notice notice-warn mt-4" role="status">
                {connected.problem.message}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={test} disabled={busy !== null} aria-busy={busy === "test"} className="btn btn-secondary btn-sm">
                <Icon name="check-circle" size={16} />
                {busy === "test" ? "Testing…" : "Test connection"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setProvider(connected.provider);
                  setReplacing(true);
                  setError(null);
                }}
                disabled={busy !== null}
                className="btn btn-ghost btn-sm"
              >
                <Icon name="key" size={16} />
                Replace key
              </button>
              <button type="button" onClick={disconnect} disabled={busy !== null} aria-busy={busy === "disconnect"} className="btn btn-ghost btn-sm">
                <Icon name="trash" size={16} />
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>

            <form onSubmit={save} className="mt-6 border-t border-line pt-6">
              <label htmlFor="sync-target" className="field-label">
                {`Add people to this ${info.target}`}
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <select
                  id="sync-target"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  required
                  className="field min-w-0 flex-1"
                >
                  <option value="" disabled>
                    {targets === null && !connected.target ? "Reading your account…" : `Choose ${info.target === "audience" ? "an" : "a"} ${info.target}`}
                  </option>
                  {options.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={refresh} disabled={busy !== null} aria-busy={busy === "targets"} className="btn btn-secondary shrink-0">
                  <Icon name="refresh" size={16} />
                  {busy === "targets" ? "Reading…" : "Refresh list"}
                </button>
              </div>
              {targets !== null && targets.length === 0 ? (
                <p className="field-hint mt-2">{`Your ${info.name} account has no ${info.target} yet. Make one there, then refresh the list.`}</p>
              ) : null}

              <fieldset className="mt-6">
                <legend className="field-label">Who is sent</legend>
                <label htmlFor="sync-free" className="mt-2 flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] px-2 py-1.5 text-sm transition hover:bg-paper motion-reduce:transition-none">
                  <input id="sync-free" type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" />
                  <span>
                    <span className="block font-semibold text-ink">Free sign-ups</span>
                    <span className="block text-xs text-ink-soft">Once they confirm their address, by opening the link we email them</span>
                  </span>
                </label>
                <div className="mt-2 grid gap-1">
                  {(
                    [
                      ["all", "Buyers of every product", "Anyone who pays, calls and memberships included"],
                      ["some", "Buyers of some products", "Only the products you check below"],
                      ["none", "No buyers", "Only free sign-ups, if checked above"],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label
                      key={value}
                      htmlFor={`sync-buyers-${value}`}
                      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] px-2 py-1.5 text-sm transition hover:bg-paper motion-reduce:transition-none"
                    >
                      <input
                        id={`sync-buyers-${value}`}
                        type="radio"
                        name="sync-buyers"
                        value={value}
                        checked={buyers === value}
                        onChange={() => setBuyers(value)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand"
                      />
                      <span>
                        <span className="block font-semibold text-ink">{label}</span>
                        <span className="block text-xs text-ink-soft">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {buyers === "some" ? (
                  paid.length ? (
                    <div className="mt-2 grid gap-1 rounded-[12px] bg-paper p-2 ring-1 ring-line sm:grid-cols-2">
                      {paid.map((p) => (
                        <label key={p.id} htmlFor={`sync-p-${p.id}`} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2 py-1.5 text-sm transition hover:bg-white motion-reduce:transition-none">
                          <input id={`sync-p-${p.id}`} type="checkbox" checked={some.includes(p.id)} onChange={() => toggleSome(p.id)} className="h-4 w-4 shrink-0 accent-violet-brand" />
                          <span className="min-w-0 break-words font-semibold text-ink">{p.title}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="field-hint mt-2">There is nothing for sale in your store yet.</p>
                  )
                ) : null}
                <p className="mt-3 flex gap-2 rounded-[12px] bg-lilac/60 px-3 py-2.5 text-sm text-ink-soft">
                  <Icon name="shield" size={16} className="mt-0.5 shrink-0 text-violet-deep" />
                  <span>
                    Only people who agreed to hear from you are sent: the box on your free-product form, or &ldquo;Also send me
                    emails&rdquo; above the buy button, which appears, unchecked, for the buyers you choose here.
                  </span>
                </p>
              </fieldset>

              {products.length ? (
                <details className="mt-6 rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line">
                  <summary className="cursor-pointer text-sm font-semibold text-ink-soft transition hover:text-violet-deep">
                    {`${info.tags} by product (optional, up to ${MAX_TAGS} each)`}
                  </summary>
                  <p className="mt-2 text-xs text-ink-soft">
                    {connected.provider === "mailerlite"
                      ? "MailerLite has groups, not tags: each name becomes a group, made the first time it is used."
                      : "Separate them with commas. A tag that does not exist yet is made the first time it is used."}
                  </p>
                  <div className="mt-3 grid gap-3">
                    {products.map((p) => (
                      <div key={p.id}>
                        <label htmlFor={`sync-tags-${p.id}`} className="block text-sm font-semibold text-ink">
                          {p.title}
                          {p.free ? <span className="ml-2 text-xs font-normal text-ink-soft">free</span> : null}
                        </label>
                        <input
                          id={`sync-tags-${p.id}`}
                          value={tags[p.id] ?? ""}
                          onChange={(e) => setTags({ ...tags, [p.id]: e.target.value })}
                          maxLength={160}
                          autoComplete="off"
                          placeholder={p.free ? "lead-magnet, free-guide" : "customer, bought-course"}
                          className="field mt-1"
                        />
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              <button type="submit" disabled={busy !== null || !target || (buyers === "some" && !some.length)} aria-busy={busy === "save"} className="btn btn-primary mt-6">
                {busy === "save" ? "Saving…" : "Save"}
              </button>
            </form>
          </section>
        ) : (
          <section className="card p-6 sm:p-8" aria-labelledby="connect-title">
            <h2 id="connect-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
              {replacing ? "Replace the key" : "Connect your email platform"}
            </h2>
            <p className="mt-2 text-ink-soft">
              {replacing
                ? "Paste a new key. Keeping the same platform keeps your settings; another one keeps who is sent and the tags, and asks where to add people."
                : "Paste an API key from your own account. It is checked with the platform, then kept encrypted: it is never shown again, only its last four characters."}
            </p>
            <form onSubmit={connect} className="mt-5">
              <fieldset>
                <legend className="field-label">Platform</legend>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {PROVIDERS.map((p) => (
                    <label
                      key={p.key}
                      htmlFor={`provider-${p.key}`}
                      className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-[12px] px-3 py-2 text-sm ring-1 transition motion-reduce:transition-none ${
                        provider === p.key ? "bg-lilac/60 ring-violet-brand" : "bg-white ring-line hover:ring-violet-brand/40"
                      }`}
                    >
                      <input
                        id={`provider-${p.key}`}
                        type="radio"
                        name="provider"
                        value={p.key}
                        checked={provider === p.key}
                        onChange={() => setProvider(p.key)}
                        className="h-4 w-4 shrink-0 accent-violet-brand"
                      />
                      <span>
                        <span className="block font-semibold text-ink">{p.name}</span>
                        <span className="block text-xs text-ink-soft">{`Adds to ${p.target === "audience" ? "an" : "a"} ${p.target}`}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label htmlFor="sync-key" className="field-label mt-5 block">
                {`${byKey(provider).name} API key`}
              </label>
              <input
                id="sync-key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                placeholder={byKey(provider).placeholder}
                className="field mt-2 font-mono text-sm"
                aria-describedby="sync-key-where"
              />
              <p id="sync-key-where" className="field-hint mt-2">
                {byKey(provider).where}
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <button type="submit" disabled={busy !== null || !key.trim() || !view.available} aria-busy={busy === "connect"} className="btn btn-primary">
                  {busy === "connect" ? `Checking with ${byKey(provider).name}…` : "Connect"}
                </button>
                {replacing ? (
                  <button type="button" onClick={() => setReplacing(false)} disabled={busy !== null} className="btn btn-ghost">
                    Keep the current key
                  </button>
                ) : null}
              </div>
            </form>
          </section>
        )}

        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-6">
        <section className="card p-6 sm:p-8" aria-labelledby="log-title">
          <h2 id="log-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Last sends
          </h2>
          {view.log.length ? (
            <>
              <ul className="mt-3 divide-y divide-line text-sm">
                {view.log.map((job) => {
                  const result = outcome(job, local);
                  return (
                    <li key={job.id} className="flex items-start justify-between gap-x-4 py-2.5">
                      <span className="min-w-0">
                        <span className="block break-all font-semibold text-ink">{job.email || (job.source === "free" ? "A free sign-up" : "A buyer")}</span>
                        <span className="block text-ink-soft">{`${job.title} · ${job.source === "free" ? "free" : "bought"} · ${when(job.createdAt, local)}`}</span>
                        {job.state === "added" || job.state === "skipped" ? (
                          job.note ? <span className="block text-xs text-ink-soft">{job.note}</span> : null
                        ) : job.lastError ? (
                          <span className="block text-xs text-ink-soft">{job.lastError}</span>
                        ) : null}
                      </span>
                      <span
                        className={`mt-0.5 shrink-0 text-right text-xs font-semibold ${
                          result.tone === "ok" ? "text-mint-deep" : result.tone === "bad" ? "text-danger" : "text-ink-soft"
                        }`}
                      >
                        {result.text}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-ink-soft">Kept for a week, the last 50 at most.</p>
            </>
          ) : (
            <p className="mt-2 text-ink-soft">Nothing yet. Each person sent, or not sent and why, is listed here.</p>
          )}
        </section>

        <details className="rounded-[12px] bg-white px-4 py-3 text-sm ring-1 ring-line">
          <summary className="cursor-pointer font-semibold text-ink-soft transition hover:text-violet-deep">How sending works</summary>
          <ul className="mt-3 space-y-2 text-ink-soft">
            <li>A free sign-up is sent when the address is confirmed; a buyer when the payment is confirmed, within about five minutes if they never come back from Stripe.</li>
            <li>Mailchimp: added as subscribed. Someone already in the audience is left as they are, so nobody who unsubscribed is subscribed again; tags are still added.</li>
            <li>Kit: added to the form, which starts whatever you attached to it. beehiiv: never reactivates an ended subscription. MailerLite: their status is never changed.</li>
            <li>We send the email address, a buyer&apos;s first name when Stripe has one, and the tags. Nothing else.</li>
            <li>When the platform does not answer, it is tried again after 5 minutes, 15 minutes, 1 hour, 3, 12 and 24 hours: seven tries in all. An address the platform refuses is not tried again.</li>
            <li>Only people from after you connect are sent. Unsubscribing in either place is not copied to the other.</li>
          </ul>
        </details>
      </div>
    </div>
  );
}
