/**
 * Waits for a pause in what the buyer is doing before work the page cannot
 * split runs on the main thread.
 *
 * A store page's counts (components/store-beacon.tsx) go through the host's
 * browser check (lib/browser-check-client.ts). Its challenge script is one
 * block of work: about 225 ms on a phone four times slower than a laptop, in
 * the mobile render lab (tests/e2e/mobile-render.mjs). Sent as soon as the
 * page was drawn, it arrived while the buyer was making a first tap, and that
 * tap waited 256 to 320 ms to paint (11 November 2026, merge queue). So a
 * count waits until the page has loaded, nobody has pressed, tapped or typed
 * for `quietMs`, and the browser is idle. Every press starts the wait again.
 * When the page is hidden there is no tap to keep waiting, so it goes at once.
 *
 * It draws nothing and keeps nothing; the returned function cancels it.
 */

/** A press, a tap or a key: what the buyer is waiting on to paint. A scroll on a phone starts with a pointerdown too. */
export const QUIET_INPUTS = ["pointerdown", "keydown"] as const;

/** How long the page stays untouched before a count's check runs. */
export const QUIET_MS = 2_000;

type IdleWindow = Pick<
  Window,
  "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener"
> & {
  requestIdleCallback?: (
    run: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};
type QuietDocument = Pick<
  Document,
  "readyState" | "visibilityState" | "addEventListener" | "removeEventListener"
>;

/**
 * Runs `run` once: after the page's load, `quietMs` without a press, tap or
 * key, and then an idle moment (at most `quietMs` more); or at once when the
 * page is hidden. Returns a cancel, which also stops listening.
 */
export function whenQuiet(
  run: () => void,
  {
    quietMs = QUIET_MS,
    win = window as IdleWindow,
    doc = document as QuietDocument,
  }: { quietMs?: number; win?: IdleWindow; doc?: QuietDocument } = {},
): () => void {
  let over = false;
  let timer: number | undefined;
  let idle: { handle: number; viaIdle: boolean } | undefined;

  const stopWaiting = () => {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined;
    if (idle) {
      if (idle.viaIdle && win.cancelIdleCallback)
        win.cancelIdleCallback(idle.handle);
      else win.clearTimeout(idle.handle);
    }
    idle = undefined;
  };
  const stop = () => {
    over = true;
    stopWaiting();
    win.removeEventListener("load", arm);
    for (const name of QUIET_INPUTS) doc.removeEventListener(name, arm, true);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
  const go = () => {
    if (over) return;
    stop();
    run();
  };
  function arm() {
    // Before the load, the load arms it: a press while the page is still arriving changes nothing.
    if (over || doc.readyState !== "complete") return;
    stopWaiting();
    timer = win.setTimeout(() => {
      timer = undefined;
      idle =
        typeof win.requestIdleCallback === "function"
          ? {
              handle: win.requestIdleCallback(go, { timeout: quietMs }),
              viaIdle: true,
            }
          : { handle: win.setTimeout(go, 0), viaIdle: false };
    }, quietMs);
  }
  function onVisibility() {
    if (doc.visibilityState === "hidden") go();
  }

  for (const name of QUIET_INPUTS)
    doc.addEventListener(name, arm, { capture: true, passive: true });
  doc.addEventListener("visibilitychange", onVisibility);
  if (doc.visibilityState === "hidden") go();
  else if (doc.readyState === "complete") arm();
  else win.addEventListener("load", arm, { once: true });
  return stop;
}

/**
 * One count per key, each sent once at the buyer's first pause (`whenQuiet`).
 *
 * While the page stays alive, a count still waiting is not dropped: a tap on a link inside the store
 * cleans up the page that asked for it while the document stays, so it goes
 * at the next pause, on the next page, with what it read when its own page
 * opened (where the visitor came from), or at once when the page is hidden.
 * Asked again for a key that is waiting or sent (React's double effect, the
 * same page opened again), it does nothing. Each call keeps its own keys.
 */
export function countsAtPause(
  options?: Parameters<typeof whenQuiet>[1],
): (key: string, send: () => void) => void {
  const sent = new Set<string>();
  const waiting = new Set<string>();
  return (key, send) => {
    if (sent.has(key) || waiting.has(key)) return;
    waiting.add(key);
    whenQuiet(() => {
      waiting.delete(key);
      sent.add(key);
      send();
    }, options);
  };
}
