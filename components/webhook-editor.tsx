"use client";

import { ConfirmAction } from "@/components/confirm-action";
import { UrlField } from "@/components/url-field";
import { WEBHOOK_CHECK } from "@/lib/fetch-url-check";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import type { DeliveryView, WebhookEvent, WebhooksView } from "@/lib/webhooks";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { MAX_ENDPOINTS } from "@/lib/webhook-limits";


/** Every event, in the order the studio lists them, with what each means. */
const EVENTS: { key: WebhookEvent; label: string; hint: string }[] = [
  { key: "sale.completed", label: "Sale completed", hint: "A paid checkout, or a one-click extra after one" },
  { key: "membership.started", label: "Membership started", hint: "Someone joined a membership" },
  { key: "membership.canceled", label: "Membership canceled", hint: "Set to end, or ended" },
  { key: "lead.captured", label: "Lead captured", hint: "Someone confirmed their address for a free product" },
  { key: "list.joined", label: "List joined", hint: "Someone confirmed their address to join your email list" },
  { key: "call.booked", label: "Call booked", hint: "A call or a seat in a session, paid" },
  { key: "call.moved", label: "Call moved", hint: "A buyer moved their booking" },
  { key: "refund.issued", label: "Refund issued", hint: "A refund on your Stripe account" },
  { key: "sequence.step", label: "Sequence step", hint: "Somebody reached a step of a sequence that calls your webhooks" },
];
const ALL = EVENTS.map((e) => e.key);

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  events: "Choose at least one event to send.",
  missing: "That endpoint is no longer there. Reload the page.",
  limited: "A store can send ten tests a minute. Wait a moment and try again.",
  not_failed: "Only a delivery that failed can be sent again.",
  not_heard: "That endpoint no longer gets this event. Add it under Events to send it again.",
  resent: "It was already sent again, or it is itself a copy sent again. Send the original again only if its last resend failed.",
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
};

function when(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function outcome(d: DeliveryView): { text: string; tone: "ok" | "wait" | "bad" } {
  if (d.state === "delivered") return { text: `Delivered${d.lastStatus ? ` (${d.lastStatus})` : ""}`, tone: "ok" };
  if (d.state === "queued") return { text: "Sending", tone: "wait" };
  if (d.state === "retrying") return { text: `Try ${d.attempts} failed; next ${when(d.next)}`, tone: "wait" };
  if (d.attempts === 0 || d.notSentPaused) return { text: "Not sent", tone: "bad" };
  return { text: `Failed after ${d.attempts} ${d.attempts === 1 ? "try" : "tries"}`, tone: "bad" };
}

/** Webhooks: the addresses told when something happens in the store, and how each send went. */
export function WebhookEditor({ view: initial }: { view: WebhooksView }) {
  const [view, setView] = useState(initial);
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState<WebhookEvent[]>(ALL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ where: string; value: string; oldUntil?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // After a new secret is confirmed, the eyes go to it (2.4.3): the confirming button is gone.
  const secretField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (secret) secretField.current?.focus();
  }, [secret]);
  const [editing, setEditing] = useState<{ id: string; events: WebhookEvent[] } | null>(null);

  async function send(body: Record<string, unknown>, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const response = await fetch("/api/store/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        view?: WebhooksView;
        secret?: string;
        delivered?: boolean;
        status?: number;
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
      setBusy(null);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const data = await send({ action: "add", url: url.trim(), events: chosen }, "add");
    if (data?.secret && data.view) {
      setSecret({ where: data.view.endpoints[data.view.endpoints.length - 1]?.where ?? "", value: data.secret });
      setUrl("");
      setChosen(ALL);
      toast("Endpoint added.");
    }
  }

  async function test(id: string) {
    const data = await send({ action: "test", id }, `test:${id}`);
    if (!data) return;
    if (data.delivered) toast(`Test delivered (${data.status}).`);
    else setError(`The test did not arrive: ${(data.message || "no answer").replace(/\.?$/, ".")} Nothing is retried for a test.`);
  }

  // 378 [TB4] unit 2: a new secret, shown once; the old one signs beside it for a day (lib/webhooks.ts ROTATION_HOURS).
  async function rotate(id: string, where: string) {
    const data = (await send({ action: "rotate", id }, `rotate:${id}`)) as { secret?: string; oldSecretUntil?: string } | null;
    if (data?.secret) {
      setSecret({ where, value: data.secret, oldUntil: data.oldSecretUntil });
      toast("New signing secret made.");
    }
  }

  // 378 [TB4] unit 3: a failed delivery sent again, once, as the same message.
  async function resend(id: string) {
    const data = await send({ action: "resend", delivery: id }, `resend:${id}`);
    if (!data) return;
    if (data.delivered) toast(`Sent again and delivered (${data.status}).`);
    else setError(`It did not arrive this time either${data.status ? ` (${data.status})` : ""}: ${(data.message || "no answer").replace(/\.?$/, ".")} It is not tried again by itself.`);
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // The field is selectable; copying by hand still works.
    }
  }

  const full = view.endpoints.length >= MAX_ENDPOINTS;
  const toggle = (list: WebhookEvent[], key: WebhookEvent) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  return (
    <section id="webhooks" className="card mt-8 scroll-mt-32 p-6 sm:p-8" aria-labelledby="webhooks-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="webhooks-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Webhooks and Zapier
        </h2>
        <span className={`tag ${view.endpoints.length ? "tag-live" : ""}`}>{`${view.endpoints.length} of ${MAX_ENDPOINTS}`}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        Tell your other tools what happens in your store. Paste a Zapier &ldquo;Catch Hook&rdquo; address, a Make or n8n
        webhook, or your own server&apos;s, choose the events, and each one is sent there as JSON the moment it happens
        (sales, memberships and refunds within about five minutes, when Stripe is read).
      </p>

      {secret ? (
        <div className="notice notice-success mt-5" role="status">
          <p className="font-semibold text-ink">{`Signing secret for ${secret.where}`}</p>
          <p className="mt-1 text-sm text-ink-soft">
            Shown this once. Keep it where your receiver can check signatures with it; Zapier does not need it.
          </p>
          {secret.oldUntil && Number.isFinite(Date.parse(secret.oldUntil)) ? (
            <p className="mt-1 text-sm text-ink-soft">{`Your old secret still signs every message beside this one until ${when(Date.parse(secret.oldUntil))}. Put this one in your receiver before then.`}</p>
          ) : null}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <label htmlFor="webhook-secret" className="sr-only">
              Signing secret
            </label>
            <input id="webhook-secret" ref={secretField} readOnly value={secret.value} onFocus={(e) => e.currentTarget.select()} className="field min-w-0 flex-1 font-mono text-sm" />
            <button type="button" onClick={copySecret} className="btn btn-secondary shrink-0">
              <Icon name={copied ? "check" : "key"} size={16} />
              <span aria-live="polite">{copied ? "Copied" : "Copy secret"}</span>
            </button>
          </div>
          <button type="button" onClick={() => setSecret(null)} className="btn btn-ghost btn-sm mt-2">
            I have kept it
          </button>
        </div>
      ) : null}

      {view.endpoints.length ? (
        <ul className="mt-5 space-y-3">
          {view.endpoints.map((endpoint) => (
            <li key={endpoint.id} className="rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <span className="min-w-0">
                  <span className="block break-all font-mono text-sm font-semibold text-ink">{endpoint.where}</span>
                  <span className="mt-1 block text-sm text-ink-soft">
                    {endpoint.events.length === ALL.length ? "Every event" : endpoint.events.map((key) => EVENTS.find((e) => e.key === key)?.label ?? key).join(", ")}
                  </span>
                  {endpoint.oldSecretUntil && Number.isFinite(Date.parse(endpoint.oldSecretUntil)) ? <span className="mt-1 block text-xs text-ink-soft">{`Old secret still signs until ${when(Date.parse(endpoint.oldSecretUntil))}`}</span> : null}
                </span>
                <span className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => test(endpoint.id)} disabled={busy !== null} aria-busy={busy === `test:${endpoint.id}`} className="btn btn-secondary btn-sm">
                    {busy === `test:${endpoint.id}` ? "Sending…" : "Send test"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(editing?.id === endpoint.id ? null : { id: endpoint.id, events: endpoint.events })}
                    aria-expanded={editing?.id === endpoint.id}
                    className="btn btn-ghost btn-sm"
                  >
                    Events
                  </button>
                  <ConfirmAction
                    className="btn btn-ghost btn-sm"
                    disabled={busy !== null}
                    busy={busy === `rotate:${endpoint.id}`}
                    label={`New secret for ${endpoint.where}`}
                    question="Make a new signing secret? It is shown once. Your old one keeps signing beside it for a day, then stops."
                    yes="Yes, make a new one"
                    onConfirm={() => rotate(endpoint.id, endpoint.where)}
                  >
                    <Icon name="key" size={16} />
                    New secret
                  </ConfirmAction>
                  <ConfirmAction
                    className="btn btn-ghost btn-sm"
                    disabled={busy !== null}
                    busy={busy === `remove:${endpoint.id}`}
                    label={`Remove ${endpoint.where}`}
                    question="Remove this endpoint? It stops getting events at once, and cannot be brought back."
                    yes="Yes, remove"
                    onConfirm={async () => {
                      if (await send({ action: "remove", id: endpoint.id }, `remove:${endpoint.id}`)) toast("Endpoint removed.");
                    }}
                  >
                    <Icon name="trash" size={16} />
                    Remove
                  </ConfirmAction>
                </span>
              </div>
              {editing?.id === endpoint.id ? (
                <form
                  className="mt-3 border-t border-line pt-3"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (await send({ action: "events", id: endpoint.id, events: editing.events }, `events:${endpoint.id}`)) {
                      setEditing(null);
                      toast("Events saved.");
                    }
                  }}
                >
                  <EventChoices idPrefix={`edit-${endpoint.id}`} value={editing.events} onToggle={(key) => setEditing({ ...editing, events: toggle(editing.events, key) })} />
                  <button type="submit" disabled={busy !== null || !editing.events.length} aria-busy={busy === `events:${endpoint.id}`} className="btn btn-primary btn-sm mt-3">
                    Save events
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {!full ? (
        <form onSubmit={add} className="mt-5">
          <label htmlFor="webhook-url" className="field-label">
            Endpoint address (https)
          </label>
          <UrlField
            id="webhook-url"
            autoComplete="off"
            value={url}
            onChange={setUrl}
            check={WEBHOOK_CHECK}
            placeholder="https://hooks.zapier.com/hooks/catch/…"
            className="field mt-2"
          />
          <fieldset className="mt-4">
            <legend className="field-label">Send these events</legend>
            <EventChoices idPrefix="new" value={chosen} onToggle={(key) => setChosen(toggle(chosen, key))} />
          </fieldset>
          <button type="submit" disabled={busy !== null || !chosen.length} aria-busy={busy === "add"} className="btn btn-primary mt-4">
            {busy === "add" ? "Adding…" : "Add endpoint"}
          </button>
        </form>
      ) : (
        <p className="mt-5 text-sm text-ink-soft">{`That is ${MAX_ENDPOINTS} endpoints, as many as a store can have. Remove one to add another.`}</p>
      )}

      {error ? (
        <p className="notice notice-error mt-4" role="alert">
          {error}
        </p>
      ) : null}

      <details className="mt-5 rounded-[12px] bg-paper px-4 py-3 text-sm ring-1 ring-line">
        <summary className="cursor-pointer font-semibold text-ink-soft transition hover:text-violet-deep">How sending works</summary>
        <ul className="mt-3 space-y-2 text-ink-soft">
          <li>Each event is a POST with a JSON body: its id, type, time, your store, and the details (product, amount, buyer).</li>
          <li>
            An answer other than 2xx is tried again after 5 minutes, 15 minutes, 1 hour, 3, 12 and 24 hours: seven tries in
            all, then it is marked failed. Redirects are not followed.
          </li>
          <li>
            While your plan&apos;s renewal payment has not gone through, or a payment for it is disputed, new endpoints and
            test messages are refused, and other events are not sent: each is marked &ldquo;Not sent&rdquo; here with the
            reason, is not sent later, and counts as one of the month&apos;s webhook deliveries when it can be counted. A delivery already being
            retried is stopped the same way. Events from your Stripe account in that time are not read until the payment is
            recorded or the dispute settled, and are sent then, as far back as Stripe keeps them (30 days). After that, sending goes on as usual while the month&apos;s
            webhook deliveries last.
          </li>
          <li>The same event can arrive twice in rare cases; its id never changes, so a receiver can ignore a repeat.</li>
          <li>
            Every message is signed. The header <span className="font-mono">Marktmorgen-Signature</span> reads{" "}
            <span className="font-mono">t=&lt;time&gt;,v1=&lt;signature&gt;</span>: the signature is HMAC-SHA256, in hex, of
            the time, a dot and the raw body, with your endpoint&apos;s secret. For a day after you make a new secret, a second{" "}
            <span className="font-mono">v1=</span> is added, signed with the old one: accept a message when any{" "}
            <span className="font-mono">v1</span> matches your secret.
          </li>
        </ul>
      </details>

      {view.log.length ? (
        <div className="mt-6">
          <h3 className="text-sm font-bold text-ink">{`Last ${view.log.length} ${view.log.length === 1 ? "delivery" : "deliveries"}`}</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {view.log.map((d) => {
              const result = outcome(d);
              return (
                <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                  <span className="min-w-0">
                    <span className="font-mono font-semibold text-ink">{d.type}</span>
                    <span className="text-ink-soft">{` · ${when(d.createdAt)} · `}</span>
                    <span className="break-all text-ink-soft">{d.endpoint}</span>
                    {d.lastError && d.state !== "delivered" ? <span className="block text-xs text-ink-soft">{d.lastError}</span> : null}
                    {d.resentFrom ? <span className="block text-xs text-ink-soft">Sent again by hand</span> : null}
                  </span>
                  {d.state === "failed" && d.type !== "test" && !d.resentFrom && (!d.resentAs || view.log.find((x) => x.id === d.resentAs)?.state === "failed") ? (
                    <button type="button" onClick={() => resend(d.id)} disabled={busy !== null} aria-busy={busy === `resend:${d.id}`} aria-label={`Send again: ${EVENTS.find((e) => e.key === d.type)?.label ?? d.type}, ${when(d.createdAt)}, to ${d.endpoint}`} className="btn btn-secondary btn-sm shrink-0">
                      {busy === `resend:${d.id}` ? "Sending…" : "Send again"}
                    </button>
                  ) : null}
                  <span
                    className={`shrink-0 text-xs font-semibold ${result.tone === "ok" ? "text-mint-deep" : result.tone === "bad" ? "text-danger" : "text-ink-soft"}`}
                  >
                    {result.text}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-ink-soft">Deliveries are kept for a week, the last 50 at most.</p>
        </div>
      ) : null}
    </section>
  );
}

function EventChoices({ idPrefix, value, onToggle }: { idPrefix: string; value: WebhookEvent[]; onToggle: (key: WebhookEvent) => void }) {
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {EVENTS.map((event) => (
        <label key={event.key} htmlFor={`${idPrefix}-${event.key}`} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] px-2 py-1.5 text-sm transition hover:bg-paper">
          <input
            id={`${idPrefix}-${event.key}`}
            type="checkbox"
            checked={value.includes(event.key)}
            onChange={() => onToggle(event.key)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand"
          />
          <span>
            <span className="block font-semibold text-ink">{event.label}</span>
            <span className="block text-xs text-ink-soft">{event.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
