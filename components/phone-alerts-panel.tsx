"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { MAX_DEVICES } from "@/lib/phone-alerts-rules";
import { useHydrated } from "@/components/use-hydrated";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import { STUDIO_SCOPE, STUDIO_WORKER } from "@/components/studio-app";
import type { DeviceView, PhoneEvent, PhoneView } from "@/lib/phone-alerts";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";


/** Every event, in the order the studio lists them, with what each one says. */
const EVENTS: { key: PhoneEvent; label: string; hint: string }[] = [
  { key: "path", label: "Path", hint: "Your current mission, requested from Path, on online devices during your local daytime" },
  { key: "sale", label: "Sales", hint: "Every paid order: the amount and what was bought" },
  { key: "booking", label: "Bookings", hint: "A call or a seat booked: what, when, and what was paid" },
  { key: "report", label: "Community reports", hint: "A member reported a post or a comment" },
  { key: "affiliate", label: "Affiliate applications", hint: "Someone applied to promote your store" },
  { key: "live", label: "Live events", hint: "A community live event starts in 15 minutes" },
  { key: "comment", label: "Course comments", hint: "A student commented under a lesson" },
  { key: "message", label: "Buyer messages", hint: "A buyer wrote in your inbox: once until you read it, never what they wrote" },
  { key: "alert", label: "Alerts", hint: "Visits or sales from them fell, refunds piled up, or the month's goal is off pace or reached" },
];

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Notifications are not set up on this deployment, so nothing was saved.",
  invalid: "This browser gave a subscription we cannot send to. Try again, or use another browser.",
  full: `That is ${MAX_DEVICES} devices, as many as one person can have on a store. Remove one below first.`,
  missing: "That device is no longer there. Reload the page.",
  limited: "A store can send six tests a minute. Wait a moment and try again.",
  stale: "This device has to be turned on again before it can be sent anything.",
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
};

type Support = "checking" | "unsupported" | "ios-install" | "ready";

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

/** The public key as the browser's subscribe() wants it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options?.applicationServerKey;
  if (!key) return true;
  const bytes = new Uint8Array(key);
  const wanted = keyBytes(publicKey);
  return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i]);
}

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const NEVER_CHANGES = () => () => {};
const STANDALONE = "(display-mode: standalone)";
const subscribeToDisplayMode = (notify: () => void) => {
  const query = window.matchMedia(STANDALONE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

/**
 * Phone notifications: turn them on for the device the studio is open on,
 * choose what each device hears, send a test, and see every device that gets
 * them (lib/phone-alerts.ts).
 */
export function PhoneAlertsPanel({ view: initial }: { view: PhoneView }) {
  const local = useHydrated();
  const [view, setView] = useState(initial);
  // Only the events this person's role may hear (lib/phone-alerts.ts, eventsFor).
  const events = EVENTS.filter((e) => view.allowed.includes(e.key));
  const ALL = events.map((e) => e.key);
  const [support, setSupport] = useState<Support>("checking");
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [thisId, setThisId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<PhoneEvent[]>(ALL.filter((event) => event !== "path"));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installer, setInstaller] = useState<InstallEvent | null>(null);

  const isIos = useSyncExternalStore(
    NEVER_CHANGES,
    () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1),
    () => false,
  );
  const standalone = useSyncExternalStore(
    subscribeToDisplayMode,
    () => window.matchMedia(STANDALONE).matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    () => false,
  );

  const send = useCallback(async (body: Record<string, unknown>, tag: string | null) => {
    if (tag) setBusy(tag);
    setError(null);
    try {
      const response = await fetch("/api/store/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        id?: string | null;
        view?: PhoneView;
        delivered?: boolean;
        message?: string;
      };
      if (data.view) setView(data.view);
      if (!data.ok) {
        setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
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

  const registration = useCallback(async () => {
    return navigator.serviceWorker.register(STUDIO_WORKER, { scope: STUDIO_SCOPE });
  }, []);

  // What this browser can do, and whether it is one of the devices already.
  useEffect(() => {
    let cancelled = false;
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    (async () => {
      if (!supported) {
        if (!cancelled) setSupport(isIos && !standalone ? "ios-install" : "unsupported");
        return;
      }
      if (!cancelled) {
        setPermission(Notification.permission);
        setSupport("ready");
      }
      if (!initial.publicKey) return;
      try {
        const reg = await registration();
        let subscription = await reg.pushManager.getSubscription();
        if (!subscription) return;
        // Subscribed under a key we no longer have: subscribed again, quietly,
        // because the creator already said yes on this device.
        if (!sameKey(subscription, initial.publicKey) && Notification.permission === "granted") {
          const old = subscription;
          await old.unsubscribe().catch(() => false);
          subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(initial.publicKey) });
          const renewed = await send({ action: "renew", old: old.endpoint, subscription: subscription.toJSON() }, null);
          if (!renewed) return;
        }
        const found = await send({ action: "find", endpoint: subscription.endpoint }, null);
        if (!cancelled && found?.id) setThisId(found.id);
      } catch {
        // Nothing to show: the device simply reads as off.
      }
    })();
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstaller(event as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => {
      cancelled = true;
      window.removeEventListener("beforeinstallprompt", onPrompt);
    };
  }, [initial.publicKey, isIos, standalone, registration, send]);

  const mine = view.devices.find((d) => d.id === thisId) ?? null;
  const others = view.devices.filter((d) => d.id !== thisId);
  const full = view.devices.length >= MAX_DEVICES && !mine;

  async function turnOn() {
    if (!view.publicKey) return;
    setError(null);
    setBusy("on");
    try {
      const answer = await Notification.requestPermission();
      setPermission(answer);
      if (answer !== "granted") {
        setError(
          answer === "denied"
            ? "Notifications are blocked for this site. Allow them in your browser's settings for marktmorgen.com, then try again."
            : "Nothing was turned on: the browser's question was closed without an answer.",
        );
        return;
      }
      const reg = await registration();
      await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const subscription =
        existing && sameKey(existing, view.publicKey)
          ? existing
          : await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(view.publicKey) });
      const data = await send({ action: "add", subscription: subscription.toJSON(), events: chosen }, null);
      if (data?.id) {
        setThisId(data.id);
        toast("Notifications are on for this device.");
      }
    } catch {
      setError("This browser would not turn notifications on. Try again, or use another browser.");
    } finally {
      setBusy(null);
    }
  }

  async function turnOff() {
    if (!mine) return;
    setBusy("off");
    try {
      const reg = await registration();
      const subscription = await reg.pushManager.getSubscription();
      await subscription?.unsubscribe().catch(() => false);
    } catch {
      // Forgotten on our side all the same, below.
    }
    const data = await send({ action: "remove", id: mine.id }, null);
    setBusy(null);
    if (data) {
      setThisId(null);
      toast("Notifications are off for this device.");
    }
  }

  async function test(device: DeviceView) {
    const data = await send({ action: "test", id: device.id }, `test:${device.id}`);
    if (!data) return;
    if (data.delivered) toast(device.id === thisId ? "Test sent. It should appear in a few seconds." : `Test sent to ${device.label}.`);
    else setError(`The test did not go out: ${data.message || "no answer from the push service."}`);
  }

  async function setEvents(device: DeviceView, events: PhoneEvent[]) {
    if (await send({ action: "events", id: device.id, events }, `events:${device.id}`)) toast("Saved.");
  }

  async function install() {
    if (!installer) return;
    await installer.prompt();
    await installer.userChoice.catch(() => null);
    setInstaller(null);
  }

  const toggle = (list: PhoneEvent[], key: PhoneEvent) => (list.includes(key) ? list.filter((k) => k !== key) : ALL.filter((k) => k === key || list.includes(k)));

  return (
    <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section className="card p-6 sm:p-8" aria-labelledby="this-device-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="this-device-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            This device
          </h2>
          {support === "ready" ? (
            <span className={`tag ${mine ? "tag-live" : ""}`}>{mine ? "Notifications on" : "Notifications off"}</span>
          ) : null}
        </div>

        {!view.publicKey ? (
          <p className="notice notice-warn mt-4">Notifications are not set up on this deployment yet, so none can be turned on.</p>
        ) : support === "checking" ? (
          <p className="mt-3 text-ink-soft" aria-live="polite">
            Checking what this browser can do…
          </p>
        ) : support === "ios-install" ? (
          <div className="notice notice-warn mt-4">
            <p className="font-bold text-ink">Add to Home Screen first — iOS 16.4+</p>
            <p className="mt-1 text-sm text-ink-soft">
              On iPhone and iPad, notifications come only to the studio installed on your home screen, on iOS 16.4 or later.
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
              <li>Open this page in Safari.</li>
              <li>
                Tap Share (the square with an arrow pointing up), then &ldquo;Add to Home Screen,&rdquo; then Add.
              </li>
              <li>Open Studio from your home screen, go to Phone notifications, and turn them on there.</li>
            </ol>
          </div>
        ) : support === "unsupported" ? (
          <p className="notice notice-warn mt-4">
            This browser cannot receive notifications from websites. On Android, use Chrome, Edge, Firefox or Samsung Internet;
            on iPhone and iPad, Safari on iOS 16.4 or later, from the studio added to your home screen.
          </p>
        ) : (
          <>
            <p className="mt-2 text-ink-soft">
              {mine
                ? `This ${mine.label} is told about what you choose below, the moment it happens.`
                : "Get a notification on this device the moment something happens in your store. Your browser will ask you to allow it."}
            </p>
            {mine?.stale ? (
              <p className="notice notice-warn mt-4">
                This device has to be turned on again: press &ldquo;Turn off,&rdquo; then &ldquo;Turn on notifications.&rdquo;
              </p>
            ) : null}
            {permission === "denied" && !mine ? (
              <p className="notice notice-warn mt-4">
                Notifications are blocked for this site in your browser&apos;s settings. Allow them there, then come back.
              </p>
            ) : null}

            <fieldset className="mt-5">
              <legend className="field-label">Tell this device about</legend>
              <EventChoices
                choices={events}
                idPrefix="mine"
                value={mine ? mine.events : chosen}
                disabled={busy !== null}
                onToggle={(key) => (mine ? setEvents(mine, toggle(mine.events, key)) : setChosen(toggle(chosen, key)))}
              />
            </fieldset>

            <div className="mt-5 flex flex-wrap gap-3">
              {mine ? (
                <>
                  <button type="button" onClick={() => test(mine)} disabled={busy !== null || mine.stale} aria-busy={busy === `test:${mine.id}`} className="btn btn-primary">
                    <Icon name="phone" size={16} />
                    {busy === `test:${mine.id}` ? "Sending…" : "Send a test"}
                  </button>
                  <button type="button" onClick={turnOff} disabled={busy !== null} aria-busy={busy === "off"} className="btn btn-secondary">
                    {busy === "off" ? "Turning off…" : "Turn off on this device"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={turnOn}
                  disabled={busy !== null || full || permission === "denied" || !chosen.length}
                  aria-busy={busy === "on"}
                  className="btn btn-primary"
                >
                  <Icon name="phone" size={16} />
                  {busy === "on" ? "Turning on…" : "Turn on notifications"}
                </button>
              )}
            </div>
            {full ? <p className="mt-3 text-sm text-ink-soft">{MESSAGES.full}</p> : null}
          </>
        )}

        {error ? (
          <p className="notice notice-error mt-4" role="alert">
            {error}
          </p>
        ) : null}

        <details className="mt-6 rounded-[12px] bg-paper px-4 py-3 text-sm ring-1 ring-line">
          <summary className="cursor-pointer font-semibold text-ink-soft transition hover:text-violet-deep">What the notifications say</summary>
          <ul className="mt-3 space-y-2 text-ink-soft">
            <li>
              <span className="font-semibold text-ink">New sale: $29</span> — the product, and the one added at checkout. A
              one-click offer after paying is a sale of its own.
            </li>
            <li>
              <span className="font-semibold text-ink">New booking: $120</span> — the call and its time, in your time zone.
            </li>
            <li>
              <span className="font-semibold text-ink">New report in your community</span> — once for each reported post or
              comment, never what it says.
            </li>
            <li>
              <span className="font-semibold text-ink">New affiliate application</span> — approve or decline in your studio.
            </li>
            <li>
              <span className="font-semibold text-ink">Live in 15 minutes</span> — the community live event, its start time and
              how many people RSVP&apos;d.
            </li>
            <li>
              <span className="font-semibold text-ink">New comment on a lesson</span> — which lesson, and the start of what the
              student wrote, as they wrote it.
            </li>
            <li>
              <span className="font-semibold text-ink">New message from a buyer</span> — that your inbox has one, never what it
              says. Tap it to open the conversation. Once until you read it.
            </li>
            <li>We never add a buyer&apos;s or an applicant&apos;s name or email address; a comment&apos;s start shows only what the student typed.</li>
            <li>
              Sales from a buyer who closed the page before coming back from Stripe arrive within about five minutes. Reports,
              applications, comments and messages are held to twenty of each an hour.
            </li>
          </ul>
        </details>
      </section>

      <div className="grid gap-6">
        <section className="card p-6 sm:p-8" aria-labelledby="devices-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="devices-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Your devices
            </h2>
            <span className={`tag ${view.devices.length ? "tag-live" : ""}`}>{`${view.devices.length} of ${MAX_DEVICES}`}</span>
          </div>
          {view.devices.length === 0 ? (
            <p className="mt-2 text-ink-soft">None yet. Each phone, tablet or computer you turn notifications on for is listed here.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {[...(mine ? [mine] : []), ...others].map((device) => (
                <li key={device.id} className="rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                        {device.label}
                        {device.id === thisId ? <span className="tag tag-brand">This device</span> : null}
                      </span>
                      <span className="mt-1 block text-sm text-ink-soft">
                        {device.events.length === ALL.length
                          ? "Everything"
                          : device.events.length
                            ? device.events.map((key) => EVENTS.find((e) => e.key === key)?.label ?? key).join(", ")
                            : "Nothing (silent)"}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-soft">
                        {device.stale
                          ? "Needs turning on again on that device."
                          : device.last
                            ? device.last.ok
                              ? `Last sent ${when(device.last.at, local)}`
                              : `Last try failed ${when(device.last.at, local)}: ${device.last.error}`
                            : `Added ${when(device.addedAt, local)}`}
                      </span>
                    </span>
                    {device.id !== thisId ? (
                      <span className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => test(device)} disabled={busy !== null || device.stale} aria-busy={busy === `test:${device.id}`} className="btn btn-secondary btn-sm">
                          {busy === `test:${device.id}` ? "Sending…" : "Send test"}
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (await send({ action: "remove", id: device.id }, `remove:${device.id}`)) toast("Device removed.");
                          }}
                          disabled={busy !== null}
                          aria-busy={busy === `remove:${device.id}`}
                          aria-label={`Remove ${device.label}`}
                          className="btn btn-ghost btn-sm"
                        >
                          <Icon name="trash" size={16} />
                          Remove
                        </button>
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-6 sm:p-8" aria-labelledby="install-title">
          <h2 id="install-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            The studio on your home screen
          </h2>
          {standalone ? (
            <p className="mt-2 text-ink-soft">You are in the installed studio. It opens straight to your store&apos;s studio.</p>
          ) : (
            <>
              <p className="mt-2 text-ink-soft">
                Install the studio like an app: its own icon, its own window, opening on your store. It keeps nothing of your
                store on the device, so it needs a connection.
              </p>
              {installer ? (
                <button type="button" onClick={install} className="btn btn-primary mt-4">
                  Install the studio
                </button>
              ) : (
                <p className="mt-3 text-sm text-ink-soft">
                  {isIos
                    ? "On iPhone and iPad: in Safari, tap Share, then “Add to Home Screen.”"
                    : "On Android: open the browser menu and tap “Install app” or “Add to Home screen.” On a computer, Chrome and Edge show an install button in the address bar."}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function EventChoices({
  choices,
  idPrefix,
  value,
  disabled,
  onToggle,
}: {
  /** The events this person's role may hear. */
  choices: typeof EVENTS;
  idPrefix: string;
  value: PhoneEvent[];
  disabled: boolean;
  onToggle: (key: PhoneEvent) => void;
}) {
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {choices.map((event) => (
        <label
          key={event.key}
          htmlFor={`${idPrefix}-${event.key}`}
          className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] px-2 py-1.5 text-sm transition hover:bg-paper motion-reduce:transition-none"
        >
          <input
            id={`${idPrefix}-${event.key}`}
            type="checkbox"
            checked={value.includes(event.key)}
            disabled={disabled}
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
