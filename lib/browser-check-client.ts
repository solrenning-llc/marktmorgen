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
 * It is set up only in production, as the sign-in form always did, and only
 * on the host whose answer the server reads: lib/bot-check.ts (browserProof)
 * answers "human" whenever VERCEL is not "1", so anywhere else the challenge
 * script is pure main-thread cost. On the CI's production build it ran about
 * 3 s after a store page loaded, for 75 to 330 ms, and was the long task under
 * every slow tap of the mobile render check (TODOS-100, from #3360). The build
 * says which host it is for in NEXT_PUBLIC_BROWSER_CHECK (next.config.ts).
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
  if (typeof window === "undefined" || process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_BROWSER_CHECK !== "1") return null;
  plain = window.fetch.bind(window);
  try {
    init({ protect: BROWSER_CHECK_ROUTES });
  } catch {
    // Without the check a request still goes; the server then treats it as unchecked (lib/bot-check.ts).
  }
  return plain;
}
