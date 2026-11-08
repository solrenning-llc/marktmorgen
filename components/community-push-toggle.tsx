"use client";

import { useEffect, useState } from "react";
import type { CommunityWords } from "@/lib/buyer-words/community";

/** What the switch says: plain strings, so the page hands them over in the store's language. */
export type PushWords = CommunityWords["push"];

/**
 * Turning notifications on for this device.
 *
 * Three things this does that most of these do not, all for the same reason —
 * a notification somebody believes in and does not get is worse than one they
 * never expected:
 *
 *   - It says what it will and will not tell them, before they decide.
 *   - On iPhone and iPad it explains that the page has to be on the home
 *     screen first, with the steps, instead of offering a switch that cannot
 *     work. Apple requires that, not us.
 *   - When the browser has already been told no, it says so plainly, because
 *     no amount of pressing the button here can undo that: only the site's own
 *     settings in the browser can.
 */
export function CommunityPushToggle({
  handle,
  publicKey,
  devices,
  words: t,
}: {
  handle: string;
  /** Our VAPID public key. Empty when push is not set up on this deployment. */
  publicKey: string;
  /** How many devices this person already has listening. */
  devices: number;
  words: PushWords;
}) {
  const [state, setState] = useState<"unknown" | "off" | "on" | "denied" | "unsupported" | "homescreen">("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(devices);
  const scope = `/@${handle}/community/`;

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!publicKey) return setState("unsupported");
      const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (!supported) {
        // On an iPhone this is what a page that is not on the home screen
        // looks like: no PushManager at all until it is installed.
        const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const standalone = (window.navigator as any).standalone === true;
        return setState(iOS && !standalone ? "homescreen" : "unsupported");
      }
      if (Notification.permission === "denied") return setState("denied");
      try {
        const registration = await navigator.serviceWorker.getRegistration(scope);
        const existing = await registration?.pushManager.getSubscription();
        if (alive) setState(existing ? "on" : "off");
      } catch {
        if (alive) setState("off");
      }
    })();
    return () => {
      alive = false;
    };
  }, [publicKey, scope]);

  async function turnOn() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const allowed = await Notification.requestPermission();
      if (allowed !== "granted") {
        setState(allowed === "denied" ? "denied" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.register("/community-sw.js", { scope });
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey }));
      const response = await fetch("/api/store/community/push", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, action: "on", subscription: subscription.toJSON() }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; devices?: number };
      if (!data.ok) {
        // The subscription is undone rather than left listening to nothing:
        // a browser that thinks it is subscribed while we have no record of
        // it is a device that will never be told anything.
        await subscription.unsubscribe().catch(() => {});
        setError(
          data.error === "full"
            ? t.full
            : data.error === "noroom"
              ? t.noroom
            : data.error === "unavailable"
              ? t.unavailable
              : t.failed,
        );
        setState("off");
        return;
      }
      setCount(data.devices ?? count + 1);
      setState("on");
    } catch {
      setError(t.failed);
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Off once the server forgot this device: it answered { ok: true } only
   * after forgetting it, and pushes go only to the devices it keeps, so
   * nothing reaches this browser any more. The server goes first and the
   * browser is unsubscribed only once it answered, so a failed request never
   * leaves a device row behind (counted toward the member's devices) for a
   * browser that no longer listens. The browser's subscription is then
   * dropped quietly, with one more try if the first did not take; a
   * subscription it still keeps receives nothing. Anything short of the
   * server's { ok: true } keeps the switch on, says so, and Turn off can be
   * pressed again (forgetting is idempotent).
   */
  async function turnOff() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration(scope);
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/store/community/push", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ handle, action: "off", endpoint: subscription.endpoint }),
        });
        const data = (await response.json().catch(() => null)) as { ok?: unknown; devices?: unknown } | null;
        if (!response.ok || data?.ok !== true) throw new Error("the device was not forgotten");
        const drop = () => Promise.resolve().then(() => subscription.unsubscribe()).then((gone) => gone === true, () => false);
        if (!(await drop())) await drop();
        setCount(typeof data?.devices === "number" ? data.devices : Math.max(0, count - 1));
      } else {
        setCount(Math.max(0, count - 1));
      }
      setState("off");
    } catch {
      setError(t.offFailed);
      setState("on");
    } finally {
      setBusy(false);
    }
  }

  if (state === "unknown") return null;

  return (
    <div className="st-note mt-6 text-sm">
      <p className="font-bold" style={{ color: "var(--st-text)" }}>{t.title}</p>
      <p className="mt-1">
        {t.what}
      </p>

      {state === "homescreen" ? (
        <p className="mt-2">
          {t.homeBefore}<strong>{t.homeAdd}</strong>{t.homeAfter}
        </p>
      ) : state === "unsupported" ? (
        <p className="mt-2">{t.unsupported}</p>
      ) : state === "denied" ? (
        <p className="mt-2">
          {t.denied}
        </p>
      ) : state === "on" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="cm-pill" aria-disabled={busy} onClick={turnOff}>
            {t.turnOff}
          </button>
          <span className="st-muted text-xs font-semibold">
            {count === 1 ? t.onHere : t.onMany.replace("{n}", String(count))}
          </span>
        </div>
      ) : (
        <div className="mt-3">
          <button type="button" className="btn st-btn" aria-disabled={busy} onClick={turnOn}>
            {busy ? t.wait : t.turnOn}
          </button>
        </div>
      )}

      {error ? <p className="mt-2 font-semibold" style={{ color: "var(--st-text)" }} role="alert">{error}</p> : null}
    </div>
  );
}
