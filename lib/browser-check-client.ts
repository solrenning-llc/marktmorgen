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
  const warm = () => {
    if (!startBrowserCheck()) return;
    win.fetch(BROWSER_CHECK_ROUTES[1].path, { method: "POST", signal: AbortSignal.abort(), keepalive: true }).catch(() => {});
  };
  const whenIdle = () => {
    if (typeof win.requestIdleCallback === "function") win.requestIdleCallback(warm, { timeout: WARM_IDLE_TIMEOUT_MS });
    else win.setTimeout(warm, 0);
  };
  if (win.document.readyState === "complete") whenIdle();
  else win.addEventListener("load", whenIdle, { once: true });
}
