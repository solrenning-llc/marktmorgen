"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { trackingConsentWords } from "@/lib/buyer-words/tracking-consent";
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";
import { pixelChoiceState, type Pixels } from "@/lib/pixels";
import { X_SCRIPT, xConfigCall, xEventCall } from "@/lib/x-pixel";
import { type Place, redditInitCall, redditScript, redditTrackCall } from "@/lib/reddit-pixel";
import { ADS_COOKIE_SECONDS, adsCookieName, nextAdsCookie } from "@/lib/ad-consent";

/**
 * The creator's own ad pixels, on their store's pages.
 *
 * Nothing loads until it is allowed. A visitor from a country whose rules ask
 * for consent first is asked, in plain words, and nothing runs unless they
 * say yes. Everywhere else the pixels run unless the browser sends Global
 * Privacy Control, which is a no given in advance. Either way the choice can
 * be changed from the link at the bottom of the page, and it is kept for this
 * store only, on this device. Every word is in the store's language
 * (lib/buyer-words/tracking-consent.ts), marked as such (`lang`).
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
  /**
   * `value` is in the currency's own units (27.5 dollars, 2700 yen); `currency` is its ISO code.
   * `id` is the id the platforms are given, made from the order's on the server
   * (lib/ad-events.ts adEventId), never the order's own; "" sends nothing.
   * `relay` is an opaque handle sealed on the server for this store and this
   * hour (lib/ad-events.ts adEventRelay), sent only to this site's own server,
   * which opens it and sends the same purchase from there; never to a pixel.
   * Never the checkout's own id: that is a key to the order, and every prop
   * here is written into the page, where the platforms' scripts run.
   */
  | { type: "purchase"; id: string; relay?: string; value: number; currency?: string; productId: string; title: string }
  /** `id`, when the route that took the sign-up sent the same lead from the server (lib/ad-events.ts), so it is counted once. */
  | { type: "lead"; productId: string; id?: string }
  | null;

// Each pixel starts once per page, however often the page redraws.
const started = new Set<string>();

const consentKey = (handle: string) => `nl_px_consent:${handle}`;

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

/** Whether this browser already marked one of these as sent. */
function sentBefore(keys: string[]): boolean {
  try {
    return keys.some((key) => localStorage.getItem(key) !== null);
  } catch {
    return false;
  }
}

/**
 * The query parameters on a store's pages that are keys to an order here
 * (506 [SG1], finding E-2): whoever has one opens what it names. The thanks
 * page's checkout (session_id) and PayPal order (paypal), the free page's
 * download token (token), a call package's booking link (pkg), a call's
 * new-time link (move), the gift of support's checkout (session_id on /tip)
 * and an order handed to the affiliate page (order). Every ad script reads
 * the page's own address with each event it sends (Meta's `dl`, Google's
 * page_location, TikTok's, Pinterest's, X's and Reddit's page URL) and the
 * page it came from (Meta's `rl`, Google's `dr`), so none of them may be on
 * either when one starts.
 */
export const KEY_PARAMS = ["session_id", "paypal", "token", "pkg", "move", "order"] as const;

/** The address without its keys, and the keys taken out, in order. */
export function withoutKeys(href: string): { href: string; keys: [string, string][] } {
  const url = new URL(href);
  const keys: [string, string][] = [];
  for (const name of KEY_PARAMS) {
    for (const value of url.searchParams.getAll(name)) keys.push([name, value]);
    url.searchParams.delete(name);
  }
  return { href: keys.length ? url.href : href, keys };
}

const keptKeysKey = (path: string) => `nl_px_keys:${path}`;

/** Set once the page is on its way back to its address with a key: nothing starts on the way. */
let leaving = false;
/** The keys' values taken out of this page's address, for the marks of purchases sent before ids were derived. */
let taken: string[] = [];

/**
 * Whether Next's router has wrapped history.replaceState (an own property of
 * history, set by the app router's effect: node_modules/next/dist/client/
 * components/app-router.js). Only then does a write without Next's own state
 * move the router's address along with the bar's; before it, a write keeps
 * Next's state, so the router's history entry stays whole.
 */
function routerListens(): boolean {
  return Object.prototype.hasOwnProperty.call(history, "replaceState");
}

/**
 * Takes the keys out of the address, with history.replaceState, and keeps
 * the address as it was, with the address it became, in this tab's storage
 * under this page, so a reload or a step back to exactly that address can go
 * back (restoreKeys). Answers the values taken out, or null when the address
 * still names a key: then no pixel starts.
 */
function hideKeys(): string[] | null {
  try {
    const was = location.href;
    const { href, keys } = withoutKeys(was);
    if (!keys.length) return [];
    try {
      sessionStorage.setItem(keptKeysKey(location.pathname), JSON.stringify({ clean: href, was }));
    } catch {
      // Without this tab's storage a reload shows the page as a link without its key does.
    }
    // A state of null, so Next's router takes the new address as its own and
    // its next write (a refresh, a server action) does not put the key back.
    // Before the router listens (its effect runs after this component's on
    // the first round), the bar is cleared now, keeping Next's state, and the
    // router is told the same address right after that round.
    if (routerListens()) history.replaceState(null, "", href);
    else {
      history.replaceState(history.state, "", href);
      setTimeout(() => {
        if (routerListens() && location.href === href) history.replaceState(null, "", href);
      }, 0);
    }
    if (withoutKeys(location.href).keys.length) return null;
    const values = keys.map(([, value]) => value);
    taken = [...taken, ...values];
    return values;
  } catch {
    return null;
  }
}

/** Whether the page this one was opened from, on this site, named a key (document.referrer). */
function cameWithKey(): boolean {
  try {
    if (!document.referrer) return false;
    const from = new URL(document.referrer);
    return from.origin === new URL(location.href).origin && withoutKeys(from.href).keys.length > 0;
  } catch {
    return true;
  }
}

/**
 * A reload or a step back to a page whose keys were taken out of the address
 * opens it without them, and the server can only draw the order from its
 * address. So when the address is exactly the one the keys were taken out
 * of, as kept in this tab's storage for this page, the address as it was is
 * opened instead; that page takes them out again before its pixels start.
 * Only on a reload or a step back: a page opened afresh stays as it is.
 * Answers whether the page is going.
 */
function restoreKeys(): boolean {
  try {
    if (withoutKeys(location.href).keys.length) return false;
    const how = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
    if (how !== "reload" && how !== "back_forward") return false;
    const raw = sessionStorage.getItem(keptKeysKey(location.pathname));
    const kept = raw ? (JSON.parse(raw) as { clean?: unknown; was?: unknown } | null) : null;
    if (!kept || typeof kept.clean !== "string" || typeof kept.was !== "string" || kept.clean !== location.href) return false;
    const was = new URL(kept.was);
    if (was.origin !== new URL(location.href).origin || was.pathname !== location.pathname || withoutKeys(was.href).href !== kept.clean) return false;
    location.replace(was.href);
    return true;
  } catch {
    return false;
  }
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
  // Meta's automatic configuration reports the buttons clicked with where
  // they lead, and a store's links can name an order (a download's
  // session_id): off for this pixel, set before its init.
  w.fbq("set", "autoConfig", false, id);
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
  language,
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
  /** The store's language (lib/store-language.ts); English when missing or unknown. */
  language?: LanguageCode;
}) {
  // "unknown" until the browser has been asked, so the server's page and the
  // browser's first paint agree.
  const [state, setState] = useState<"unknown" | "ask" | "on" | "off">("unknown");

  // Back to the address with its keys after a reload, whatever the choice:
  // turning the pixels off reloads the page, which must still show the order.
  // And out of the address at once, whatever the choice, so a page opened
  // from this one is not told the key as where it came from.
  useEffect(() => {
    taken = [];
    leaving = restoreKeys();
    if (!leaving) hideKeys();
  }, []);

  useEffect(() => {
    const choice = readChoice(handle);
    const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
    const next = pixelChoiceState(choice,askFirst,gpc);
    // Read from this browser's storage, which only exists after the page is in it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(next);
  }, [handle, askFirst]);

  useEffect(() => {
    if (state === "on" || state === "off") writeAdsCookie(handle, state === "on");
  }, [state, handle]);

  useEffect(() => {
    if (state !== "on" || leaving) return;
    // Never a pixel while the address names an order: its keys go first. Nor
    // on a page opened from an address on this site that named one, which
    // every script would send as where the visitor came from.
    if (hideKeys() === null || cameWithKey()) return;
    const w = window as PixelWindow;
    const start =(kind: string, id: string | null, run: (w: PixelWindow, id: string) => void) => {
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
    start("x", pixels.x, (win, id) => startX(win, id, restricted));
    start("reddit", pixels.reddit, (win, id) => startReddit(win, id, restricted, place));

    // Before ids were derived, a purchase was marked sent under the order's own
    // id (the checkout's or PayPal's, both from the address, taken out of it
    // above): sent then, not again.
    const marked = event?.type === "purchase" ? taken.filter(Boolean).map((v) => `nl_px_sent:${v}`) : [];
    if (event?.type === "purchase" && event.id && !sentBefore(marked) && once(`nl_px_sent:${event.id}`)) {
      track(w, pixels, event, restricted);
      // The same purchase from our server now, where the creator set it up
      // (lib/ad-events.ts), rather than at the server's next pass over the
      // store's checkouts: asked only here, where the pixels were allowed to run.
      if (event.relay) {
        fetch("/api/store/ads-event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ h: handle, t: event.relay }),
          keepalive: true,
        }).catch(() => {});
      }
    }
    if (event?.type === "lead" && !started.has(`lead:${event.productId}`)) {
      started.add(`lead:${event.productId}`);
      track(w, pixels, event, restricted);
    }

    // A buy button leaves the page for Stripe at once. The event is sent
    // first, and the form goes on its way a moment later, exactly as pressed.
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target instanceof HTMLFormElement ? e.target : null;
      if (!form || !form.hasAttribute("data-checkout") || form.dataset.sent === "1") return;
      // Asking for a returning-buyer code's link is not starting a checkout (components/returning-code-box.tsx).
      if (e.submitter instanceof HTMLElement && e.submitter.hasAttribute("data-no-checkout")) return;
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
    return () => document.removeEventListener("submit", onSubmit, true);
  }, [state, pixels, event, handle, place]);

  if (state === "unknown") return null;

  const spoken = parseLanguage(language);
  const words = trackingConsentWords(spoken);
  const locale = LANGUAGES[spoken].locale;
  if ((navigator as Navigator & {globalPrivacyControl?:boolean}).globalPrivacyControl === true) {
    return <p lang={locale} className="mt-3 text-center text-xs st-footer-link">{words.gpc}</p>;
  }
  if (state === "ask") {
    return (
      <section
        lang={locale}
        aria-label={words.adsLabel}
        className="st-card fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl p-5 text-left sm:inset-x-6 sm:bottom-6"
        style={{ boxShadow: "0 18px 50px -18px rgba(0,0,0,.45)" }}
      >
        <p className="font-bold">{words.adsTitle(storeName)}</p>
        <p className="st-muted mt-1 text-sm leading-relaxed">
          {words.adsBody(names, storeName)}{" "}
          <Link href="/privacy#ads" className="st-footer-link font-semibold">
            {words.more}
          </Link>
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn st-btn"
            onClick={() => {
              const gpc = (navigator as Navigator & {globalPrivacyControl?:boolean}).globalPrivacyControl === true;
              writeChoice(handle,gpc ? "no" : "yes");
              setState(pixelChoiceState("yes",askFirst,gpc));
            }}
          >
            {words.allow}
          </button>
          <button
            type="button"
            className="btn st-option !w-auto !py-2.5 font-semibold"
            onClick={() => {
              writeChoice(handle, "no");
              setState("off");
            }}
          >
            {words.noThanks}
          </button>
        </div>
      </section>
    );
  }

  return (
    <p lang={locale} className="mt-3 text-center">
      <button
        type="button"
        className="st-footer-link text-xs font-semibold"
        onClick={() => {
          if (state === "on") {
            writeChoice(handle, "no");
            // Scripts already loaded cannot be unloaded from a page; the next
            // page this store opens loads none.
            window.location.reload();
          } else {
            writeChoice(handle, null);
            setState("ask");
          }
        }}
      >
        {state === "on" ? words.turnOff : words.settings}
      </button>
    </p>
  );
}
