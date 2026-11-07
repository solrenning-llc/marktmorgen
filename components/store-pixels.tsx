"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { pixelChoiceState, type Pixels } from "@/lib/pixels";
import { X_SCRIPT, xConfigCall, xEventCall } from "@/lib/x-pixel";
import { type Place, redditInitCall, redditScript, redditTrackCall } from "@/lib/reddit-pixel";
import { ADS_COOKIE_SECONDS, adsCookieName, nextAdsCookie } from "@/lib/ad-consent";
import { CART_CHANGED_EVENT, CART_KEY_PREFIX, type Step, type StepKind, addedToCart, cartIdsOf, pageLocationOf, stepCalls, stepsAllowed, stepsMarkKey, stepsMarkValue, stepsWords } from "@/lib/pixel-steps";

/**
 * The creator's own ad pixels, on their store's pages.
 *
 * Nothing loads until it is allowed. A visitor from a country whose rules ask
 * for consent first is asked, in plain words, and nothing runs unless they
 * say yes. Everywhere else the pixels run unless the browser sends Global
 * Privacy Control, which is a no given in advance. Either way the choice can
 * be changed from the link at the bottom of the page, and it is kept for this
 * store only, on this device.
 *
 * The scripts are each platform's own standard snippet, loaded from the
 * platform, with the creator's id — which was checked against the platform's
 * exact format before it was saved, so it cannot carry anything else.
 */

type Fn = ((...args: unknown[]) => void) & Record<string, unknown>;

type PixelWindow = Window & {
  fbq?: Fn;
  _fbq?: Fn;
  gtag?: (...args: unknown[]) => void;
  dataLayer?: unknown[];
  ttq?: unknown[] & Record<string, unknown>;
  TiktokAnalyticsObject?: string;
  pintrk?: Fn;
  twq?: Fn;
  rdt?: Fn;
};

export type PixelEvent =
  /** `value` is in the currency's own units (27.5 dollars, 2700 yen); `currency` is its ISO code. */
  | { type: "purchase"; id: string; value: number; currency?: string; productId: string; title: string }
  /** `id`, when the route that took the sign-up sent the same lead from the server (lib/ad-events.ts), so it is counted once. */
  | { type: "lead"; productId: string; id?: string }
  | null;

// Each pixel starts once per page, however often the page redraws.
const started = new Set<string>();

const consentKey = (handle: string) => `nl_px_consent:${handle}`;

/** Global Privacy Control, a no given in advance by the browser. */
const gpcOn = () => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;

function readChoice(handle: string): "yes" | "no" | null {
  try {
    const value = localStorage.getItem(consentKey(handle));
    return value === "yes" || value === "no" ? value : null;
  } catch {
    return null;
  }
}

function writeChoice(handle: string, value: "yes" | "no" | null) {
  try {
    if (value) localStorage.setItem(consentKey(handle), value);
    else localStorage.removeItem(consentKey(handle));
  } catch {
    // A browser that keeps nothing asks again next time; nothing breaks.
  }
}

/**
 * Whether the yes was given to the words that name a product view and an add
 * to cart, and for which platforms (lib/pixel-steps.ts stepsMarkValue): kept
 * on Allow, removed on every other choice.
 */
function readMark(handle: string): string | null {
  try {
    return localStorage.getItem(stepsMarkKey(handle));
  } catch {
    return null;
  }
}

function writeMark(handle: string, value: string | null) {
  try {
    if (value) localStorage.setItem(stepsMarkKey(handle), value);
    else localStorage.removeItem(stepsMarkKey(handle));
  } catch {
    // Without storage there is no mark, so these two steps are never told.
  }
}

function readCart(handle: string): string[] {
  try {
    return cartIdsOf(localStorage.getItem(`${CART_KEY_PREFIX}${handle}`));
  } catch {
    return [];
  }
}

/**
 * The same yes, where the server can read it (lib/ad-consent.ts): kept while
 * the pixels may run, with the ad click this visit came from, and deleted the
 * moment they may not.
 */
function writeAdsCookie(handle: string, on: boolean) {
  try {
    const name = adsCookieName(handle);
    const secure = location.protocol === "https:" ? "; Secure" : "";
    if (!on) {
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
      return;
    }
    const existing = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
    document.cookie = `${name}=${nextAdsCookie(existing, location.search, Date.now() / 1000)}; Path=/; Max-Age=${ADS_COOKIE_SECONDS}; SameSite=Lax${secure}`;
  } catch {
    // A browser that keeps no cookies is sent from the thanks page only, as before.
  }
}

function once(key: string): boolean {
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
  } catch {
    // Without storage the event may be sent twice on a reload, never not at all.
  }
  return true;
}

function script(src: string) {
  const tag = document.createElement("script");
  tag.async = true;
  tag.src = src;
  document.head.appendChild(tag);
}

function startMeta(w: PixelWindow, id: string) {
  if (!w.fbq) {
    const n = function (...args: unknown[]) {
      if (typeof n.callMethod === "function") (n.callMethod as (...a: unknown[]) => void)(...args);
      else (n.queue as unknown[]).push(args);
    } as Fn;
    n.push = n;
    n.loaded = true;
    n.version = "2.0";
    n.queue = [];
    w.fbq = n;
    if (!w._fbq) w._fbq = n;
    script("https://connect.facebook.net/en_US/fbevents.js");
  }
  w.fbq("init", id);
  w.fbq("track", "PageView");
}

function startGoogle(w: PixelWindow, id: string) {
  if (!w.gtag) {
    w.dataLayer = w.dataLayer || [];
    // gtag.js reads an arguments object, not an array, so this is written
    // exactly as Google's snippet writes it.
    w.gtag = function () {
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer!.push(arguments);
    };
    w.gtag("js", new Date());
    script(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`);
  }
  w.gtag("config", id);
}

function startTikTok(w: PixelWindow, id: string) {
  // TikTok's own loader, written out: a queue that takes calls until the
  // library arrives, and the library itself, fetched with the creator's id.
  const name = "ttq";
  w.TiktokAnalyticsObject = name;
  type Queue = unknown[] & Record<string, unknown>;
  const ttq = (w.ttq = w.ttq || ([] as unknown as Queue)) as Queue;
  const methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie", "holdConsent", "revokeConsent", "grantConsent"];
  const setAndDefer = (target: Queue, method: string) => {
    target[method] = (...args: unknown[]) => target.push([method, ...args]);
  };
  ttq.methods = methods;
  ttq.setAndDefer = setAndDefer;
  for (const method of methods) setAndDefer(ttq, method);
  ttq.instance = (key: string) => {
    const table = (ttq._i as Record<string, Queue> | undefined) ?? {};
    const one = table[key] || ([] as unknown as Queue);
    for (const method of methods) setAndDefer(one, method);
    return one;
  };
  ttq.load = (key: string, options?: Record<string, unknown>) => {
    const src = "https://analytics.tiktok.com/i18n/pixel/events.js";
    const table = ((ttq._i as Record<string, Queue> | undefined) ??= {} as Record<string, Queue>);
    ttq._i = table;
    const one = [] as unknown as Queue;
    one._u = src;
    table[key] = one;
    ttq._t = { ...((ttq._t as Record<string, number>) ?? {}), [key]: Date.now() };
    ttq._o = { ...((ttq._o as Record<string, unknown>) ?? {}), [key]: options || {} };
    script(`${src}?sdkid=${encodeURIComponent(key)}&lib=${name}`);
  };
  (ttq.load as (key: string) => void)(id);
  (ttq.page as () => void)();
}

function startPinterest(w: PixelWindow, id: string) {
  if (!w.pintrk) {
    const n = function (...args: unknown[]) {
      (n.queue as unknown[]).push(args);
    } as Fn;
    n.queue = [];
    n.version = "3.0";
    w.pintrk = n;
    script("https://s.pinimg.com/ct/core.js");
  }
  w.pintrk("load", id);
  w.pintrk("page");
}

/**
 * X's base code, written out (613 [WP12]; lib/x-pixel.ts has the calls): a
 * queue that takes calls until X's script arrives, then `config` with the
 * pixel's ID. A visitor who never said yes (allowed only because their
 * country does not ask first) is sent with X's `restricted_data_use`.
 */
function startX(w: PixelWindow, id: string, restricted: boolean) {
  if (!w.twq) {
    const n = function (...args: unknown[]) {
      if (typeof n.exe === "function") (n.exe as (...a: unknown[]) => void)(...args);
      else (n.queue as unknown[]).push(args);
    } as Fn;
    n.version = "1.1";
    n.queue = [];
    w.twq = n;
    script(X_SCRIPT);
  }
  w.twq(...xConfigCall(id, restricted));
}

/**
 * Reddit's base code, written out (613 [WP12] unit 2; lib/reddit-pixel.ts has
 * the calls): a queue until Reddit's script arrives, `init` (marked Limited
 * Data Use for a visitor who never said yes) and the page visit. Never an
 * email or other identifier.
 */
function startReddit(w: PixelWindow, id: string, limited: boolean, place: Place) {
  if (!w.rdt) {
    const n = function (...args: unknown[]) {
      if (typeof n.sendEvent === "function") (n.sendEvent as (...a: unknown[]) => void)(...args);
      else (n.callQueue as unknown[]).push(args);
    } as Fn;
    n.callQueue = [];
    w.rdt = n;
    script(redditScript(id));
  }
  w.rdt(...redditInitCall(id, limited, place));
  w.rdt("track", "PageVisit");
}

/**
 * One step, to each of the creator's pixels that is loaded on this page and
 * that the visitor's yes named (`allowed`, read just before this is called).
 */
function sendStep(w: PixelWindow, pixels: Pixels, step: Step, allowed: StepKind[]) {
  for (const [kind, args] of stepCalls(pixels, step, pageLocationOf(location.href))) {
    if (!allowed.includes(kind)) continue;
    if (kind === "meta" && w.fbq) w.fbq(...args);
    else if (kind === "google" && w.gtag) w.gtag(...args);
    else if (kind === "reddit" && w.rdt) w.rdt(...args);
  }
}

function track(w: PixelWindow, pixels: Pixels, event: Exclude<PixelEvent, null> | { type: "checkout" }, restricted = true) {
  const toReddit = w.rdt ? redditTrackCall(pixels, event) : null;
  if (toReddit && w.rdt) w.rdt(...toReddit);
  const toX = w.twq ? xEventCall(pixels, event, restricted) : null;
  if (toX && w.twq) w.twq(...toX);
  const ttq = w.ttq as (Record<string, (...args: unknown[]) => void>) | undefined;
  if (event.type === "purchase") {
    const money = { value: event.value, currency: (event.currency ?? "usd").toUpperCase() };
    if (pixels.meta && w.fbq) w.fbq("track", "Purchase", { ...money, content_ids: [event.productId], content_type: "product" }, { eventID: event.id });
    if (pixels.google && w.gtag) w.gtag("event", "purchase", { ...money, transaction_id: event.id, items: [{ item_id: event.productId, item_name: event.title }] });
    // The order's id as the event's, so TikTok counts this and the server's (lib/ad-events.ts) as one.
    if (pixels.tiktok && ttq) ttq.track("CompletePayment", { ...money, contents: [{ content_id: event.productId, content_name: event.title }], content_type: "product" }, { event_id: event.id });
    if (pixels.pinterest && w.pintrk) w.pintrk("track", "checkout", { ...money, order_id: event.id, order_quantity: 1, event_id: event.id });
  } else if (event.type === "lead") {
    // The lead's id as the event's, where the server sent it too, so each platform counts one.
    const same = event.id ? { eventID: event.id } : undefined;
    if (pixels.meta && w.fbq) w.fbq("track", "Lead", { content_ids: [event.productId] }, ...(same ? [same] : []));
    if (pixels.google && w.gtag) w.gtag("event", "generate_lead");
    if (pixels.tiktok && ttq) ttq.track("SubmitForm", {}, ...(event.id ? [{ event_id: event.id }] : []));
    if (pixels.pinterest && w.pintrk) w.pintrk("track", "lead", event.id ? { event_id: event.id } : {});
  } else {
    if (pixels.meta && w.fbq) w.fbq("track", "InitiateCheckout");
    if (pixels.google && w.gtag) w.gtag("event", "begin_checkout");
    if (pixels.tiktok && ttq) ttq.track("InitiateCheckout");
  }
}

export function StorePixels({
  handle,
  storeName,
  pixels,
  names,
  askFirst,
  place = { country: null, region: null },
  event = null,
  viewed,
}: {
  handle: string;
  storeName: string;
  pixels: Pixels;
  /** "Meta and Google", said to the visitor. */
  names: string;
  /** True where the visitor has to say yes before anything loads. */
  askFirst: boolean;
  /** Where the visitor is, for Reddit's Limited Data Use (lib/reddit-pixel.ts placeOf). */
  place?: Place;
  event?: PixelEvent;
  /** A product's own page: which product, told as a product view (lib/pixel-steps.ts). */
  viewed?: string;
}) {
  // "unknown" until the browser has been asked, so the server's page and the
  // browser's first paint agree.
  const [state, setState] = useState<"unknown" | "ask" | "on" | "off">("unknown");

  useEffect(() => {
    const choice = readChoice(handle);
    const next = pixelChoiceState(choice, askFirst, gpcOn());
    // Read from this browser's storage, which only exists after the page is in it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(next);
    // A choice changed in another tab of this store counts here at once: a
    // "Turn off" there stops what this page would send next.
    const onChoice = (e: StorageEvent) => {
      if (e.key === null || e.key === consentKey(handle) || e.key === stepsMarkKey(handle)) setState(pixelChoiceState(readChoice(handle), askFirst, gpcOn()));
    };
    // A page shown again from the back/forward cache missed those changes.
    const onBack = (e: PageTransitionEvent) => {
      if (e.persisted) setState(pixelChoiceState(readChoice(handle), askFirst, gpcOn()));
    };
    window.addEventListener("storage", onChoice);
    window.addEventListener("pageshow", onBack);
    return () => {
      window.removeEventListener("storage", onChoice);
      window.removeEventListener("pageshow", onBack);
    };
  }, [handle, askFirst]);

  useEffect(() => {
    if (state === "on" || state === "off") writeAdsCookie(handle, state === "on");
  }, [state, handle]);

  useEffect(() => {
    if (state !== "on") return;
    const w = window as PixelWindow;
    const start = (kind: string, id: string | null, run: (w: PixelWindow, id: string) => void) => {
      if (!id || started.has(`${kind}:${id}`)) return;
      started.add(`${kind}:${id}`);
      run(w, id);
    };
    start("meta", pixels.meta, startMeta);
    start("google", pixels.google, startGoogle);
    start("tiktok", pixels.tiktok, startTikTok);
    start("pinterest", pixels.pinterest, startPinterest);
    // Said yes on this store, or only allowed because this country does not ask first.
    const restricted = readChoice(handle) !== "yes";
    // Read again from storage right before anything is sent after this: the
    // visitor may have changed the choice in another tab since this started.
    const stillOn = () => pixelChoiceState(readChoice(handle), askFirst, gpcOn()) === "on";
    const stepsNow = () => stepsAllowed(pixelChoiceState(readChoice(handle), askFirst, gpcOn()), readChoice(handle), readMark(handle));
    start("x", pixels.x, (win, id) => startX(win, id, restricted));
    start("reddit", pixels.reddit, (win, id) => startReddit(win, id, restricted, place));

    if (event?.type === "purchase" && once(`nl_px_sent:${event.id}`)) {
      track(w, pixels, event, restricted);
      // The same purchase from our server now, where the creator set it up
      // (lib/ad-events.ts), rather than at the server's next pass over the
      // store's checkouts: asked only here, where the pixels were allowed to run.
      fetch("/api/store/ads-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ h: handle, s: event.id }),
        keepalive: true,
      }).catch(() => {});
    }
    if (event?.type === "lead" && !started.has(`lead:${event.productId}`)) {
      started.add(`lead:${event.productId}`);
      track(w, pixels, event, restricted);
    }

    // A buy button leaves the page for Stripe at once. The event is sent
    // first, and the form goes on its way a moment later, exactly as pressed.
    const onSubmit = (e: SubmitEvent) => {
      if (!stillOn()) return;
      const form = e.target instanceof HTMLFormElement ? e.target : null;
      if (!form || !form.hasAttribute("data-checkout") || form.dataset.sent === "1") return;
      if (typeof form.requestSubmit !== "function") {
        track(w, pixels, { type: "checkout" }, restricted);
        return;
      }
      e.preventDefault();
      form.dataset.sent = "1";
      track(w, pixels, { type: "checkout" }, restricted);
      const submitter = e.submitter instanceof HTMLElement ? e.submitter : undefined;
      window.setTimeout(() => {
        form.requestSubmit(submitter as HTMLButtonElement | undefined);
        // Coming back to this page, the button works again.
        window.setTimeout(() => delete form.dataset.sent, 1000);
      }, 300);
    };
    document.addEventListener("submit", onSubmit, true);

    // A product view and an add to cart (601 [KB22] U9), only for a visitor
    // who pressed Allow on the words that name them, only to the platforms
    // those words named, and checked again at the moment each is sent.
    if (viewed && !started.has(`view:${viewed}`) && stepsNow().length) {
      started.add(`view:${viewed}`);
      sendStep(w, pixels, { type: "view", productId: viewed }, stepsNow());
    }
    // The cart says when this page changed it (components/store-cart.tsx).
    // What was in it when this started, put back from a link included, is
    // not told; taking a product out is not told either.
    let before = readCart(handle);
    const onCart = () => {
      const now = readCart(handle);
      for (const productId of addedToCart(before, now)) sendStep(w, pixels, { type: "cart", productId }, stepsNow());
      before = now;
    };
    // Another tab's change is never told here; it only moves what was there.
    const onOtherTab = () => {
      before = readCart(handle);
    };
    // A page shown again from the back/forward cache: the cart may have
    // changed while it was away, and that is not told either.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) before = readCart(handle);
    };
    window.addEventListener(CART_CHANGED_EVENT, onCart);
    window.addEventListener("storage", onOtherTab);
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener(CART_CHANGED_EVENT, onCart);
      window.removeEventListener("storage", onOtherTab);
      window.removeEventListener("pageshow", onShow);
    };
  }, [state, pixels, event, handle, place, viewed, askFirst]);

  if (state === "unknown") return null;

  if (gpcOn()) {
    return <p className="mt-3 text-center text-xs st-footer-link">Your browser’s Global Privacy Control keeps ad measurement off. Manage this signal in your browser settings.</p>;
  }
  if (state === "ask") {
    return (
      <section
        aria-label="Ad measurement"
        className="st-card fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl p-5 text-left sm:inset-x-6 sm:bottom-6"
        style={{ boxShadow: "0 18px 50px -18px rgba(0,0,0,.45)" }}
      >
        <p className="font-bold">{`${storeName} measures its ads`}</p>
        <p className="st-muted mt-1 text-sm leading-relaxed">
          {[
            `With your permission, this page loads ad measurement from ${names}, which sets cookies.`,
            `${storeName} tells them about your sign-ups and purchases, so it can see which of its ads bring people here.`,
            stepsWords(pixels, storeName),
            "If you say no, nothing loads, nothing is sent, and the page works just the same.",
          ]
            .filter(Boolean)
            .join(" ")}{" "}
          <Link href="/privacy#ads" className="st-footer-link font-semibold">
            More about this
          </Link>
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn st-btn"
            onClick={() => {
              const gpc = gpcOn();
              writeChoice(handle,gpc ? "no" : "yes");
              // The yes counts for these steps only on the platforms the words above named.
              writeMark(handle, gpc ? null : stepsMarkValue(pixels));
              setState(pixelChoiceState("yes",askFirst,gpc));
            }}
          >
            Allow
          </button>
          <button
            type="button"
            className="btn st-option !w-auto !py-2.5 font-semibold"
            onClick={() => {
              writeChoice(handle, "no");
              writeMark(handle, null);
              setState("off");
            }}
          >
            No thanks
          </button>
        </div>
      </section>
    );
  }

  return (
    <p className="mt-3 text-center">
      <button
        type="button"
        className="st-footer-link text-xs font-semibold"
        onClick={() => {
          if (state === "on") {
            writeChoice(handle, "no");
            writeMark(handle, null);
            // Scripts already loaded cannot be unloaded from a page; the next
            // page this store opens loads none.
            window.location.reload();
          } else {
            writeChoice(handle, null);
            writeMark(handle, null);
            setState("ask");
          }
        }}
      >
        {state === "on" ? "Turn off ad measurement" : "Ad measurement settings"}
      </button>
    </p>
  );
}
