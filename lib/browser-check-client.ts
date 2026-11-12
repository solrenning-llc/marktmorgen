/**
 * The host's browser check (Vercel BotID), set up once per window for every
 * route it guards (Claude 6's MEDIUM on #3360).
 *
 * The host's script hands its challenge to one global that the first
 * initBotId in a window takes: a second initBotId never gets one, and its
 * protected requests never settle. The site has one layout, so a visitor who
 * goes from a store page to sign-in by an in-app link keeps the window. So
 * nothing else in the app calls initBotId: the sign-in form
 * (components/signin-form.tsx) and the store's beacon
 * (components/store-beacon.tsx) both call startBrowserCheck, and whichever
 * runs first sets the check up for both routes.
 *
 * It is set up only in production, as the sign-in form always did: off the
 * host there is no check to answer it (lib/bot-check.ts).
 */
import { initBotId } from "botid/client/core";
import { QUIET_INPUTS } from "@/lib/quiet-moment";

/** Every request the check signs: asking for a sign-in link, and a store's counts. */
export const BROWSER_CHECK_ROUTES = [
  { path: "/api/auth/request", method: "POST" },
  { path: "/api/store/hit", method: "POST" },
] as const;

type Init = (options: { protect: typeof BROWSER_CHECK_ROUTES }) => unknown;

/** The window's fetch from before the check wrapped it, once the check was started; null before. */
let plain: typeof fetch | null = null;

/**
 * Starts the check for the window if nobody has yet, and answers the fetch
 * from before it wrapped it, for a request that has to go without the check
 * when it cannot load. Null outside production and on the server.
 */
export function startBrowserCheck(init: Init = initBotId as unknown as Init): typeof fetch | null {
  if (plain) return plain;
  if (typeof window === "undefined" || process.env.NODE_ENV !== "production") return null;
  plain = window.fetch.bind(window);
  try {
    init({ protect: BROWSER_CHECK_ROUTES });
  } catch {
    // Without the check a request still goes; the server then treats it as unchecked (lib/bot-check.ts).
  }
  return plain;
}

/** How long after the page's load event the challenge waits for an idle moment, at most. */
export const WARM_IDLE_TIMEOUT_MS = 1_000;

/** The host's challenge script, at the path botid/client/core loads it from. */
export const CHALLENGE_SCRIPT = "/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/a-4-a/c.js";

/**
 * The address botid/client/core asks for its script on its first load: the path with i=0 (its first try), v=3 (its
 * protocol) and h=<host>. A preload is used only by a request for the very same address; one that differs is fetched
 * again (the check still works, as before, only without the head start). tests/browser-check-preload.test.ts holds this
 * against the installed botid.
 */
export function challengeScriptUrl(host: string): string {
  return `${CHALLENGE_SCRIPT}?i=0&v=3&h=${encodeURIComponent(host)}`;
}

/** How long after a press, tap or key the challenge's script waits before it runs, so the tap paints first. */
export const QUIET_TAP_MS = 300;

let warming = false;

/**
 * Runs the host's challenge ahead of the first count, at the first idle moment
 * after the page loaded (Claude 7's MEDIUM on #3642): the check-signed fetch
 * awaits the challenge before it makes its request, so a count first asked
 * while the page is being left (the tab closed before the buyer's first pause)
 * never left the page. Warm, it goes at once, with keepalive.
 *
 * The challenge is started by a protected fetch whose signal is already
 * aborted: the wrapper awaits the challenge first, then the request itself is
 * refused by the browser before anything is sent, so nothing reaches the
 * server and nothing is counted. Once per window; nothing outside production.
 */
export function warmBrowserCheckWhenIdle(win: Window & typeof globalThis = window): void {
  if (warming || typeof win === "undefined" || process.env.NODE_ENV !== "production") return;
  warming = true;
  const doc = win.document;
  // The script is fetched at once, by the network only: a preload runs nothing (v2, #3642 option 1). Then the
  // challenge is started, and the script runs, only at a moment the buyer is not tapping: not within QUIET_TAP_MS of
  // a press, tap or key, and not while the browser has input waiting. Fetched ahead, the script then runs at once, at
  // the moment chosen here, and not whenever it happens to arrive from the network.
  let lastInput = -Infinity;
  const mark = () => {
    lastInput = win.performance.now();
  };
  for (const type of QUIET_INPUTS) win.addEventListener(type, mark, { capture: true, passive: true });
  const fetched = new Promise<void>((done) => {
    const link = doc.createElement("link");
    link.rel = "preload";
    link.as = "script";
    link.href = challengeScriptUrl(win.location.host);
    link.onload = link.onerror = () => done();
    doc.head.appendChild(link);
  });
  const scheduling = (win.navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } }).scheduling;
  let started = false;
  const warm = () => {
    if (started) return;
    started = true;
    for (const type of QUIET_INPUTS) win.removeEventListener(type, mark, true);
    if (!startBrowserCheck()) return;
    win.fetch(BROWSER_CHECK_ROUTES[1].path, { method: "POST", signal: AbortSignal.abort(), keepalive: true }).catch(() => {});
  };
  const whenQuiet = () => {
    if (started) return;
    // Leaving the page: nobody is tapping, and the count needs the challenge now.
    if (doc.visibilityState === "hidden") return warm();
    const since = win.performance.now() - lastInput;
    if (since < QUIET_TAP_MS || scheduling?.isInputPending?.() === true) {
      win.setTimeout(whenIdle, Math.max(16, QUIET_TAP_MS - since));
      return;
    }
    warm();
  };
  const whenIdle = () => {
    if (typeof win.requestIdleCallback === "function") win.requestIdleCallback(whenQuiet, { timeout: WARM_IDLE_TIMEOUT_MS });
    else win.setTimeout(whenQuiet, 0);
  };
  // A page being left starts it at once, fetched or not.
  doc.addEventListener("visibilitychange", () => doc.visibilityState === "hidden" && warm(), { once: true });
  const loaded = new Promise<void>((done) => (doc.readyState === "complete" ? done() : win.addEventListener("load", () => done(), { once: true })));
  void Promise.all([loaded, fetched]).then(whenIdle);
}
