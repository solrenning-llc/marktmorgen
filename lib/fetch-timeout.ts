/**
 * How long we wait on the services this app runs on before giving up.
 *
 * Every request to Upstash Redis, Stripe (our own account and the creators'
 * connected ones), Resend, Amazon SES, Vercel's domain API, Vercel Blob and the video service goes through
 * `timed`, with a limit of its own:
 *
 *   Redis    5 s    a pipeline answers in milliseconds; five seconds is a
 *                   service that is not there, and every page reads Redis
 *   Stripe   20 s   a charge confirmed with the card's bank can take a few
 *                   seconds; twenty is well past any that succeed
 *   Resend   10 s   one message, or a batch of a hundred
 *   Amazon   8 s    one message handed to Amazon SES, or one question
 *                   about the account (lib/ses.ts)
 *   Domains  15 s   Vercel's domain API, from the studio only
 *   Blob     15 s   to the first byte of an answer (a download may take as
 *                   long as it takes after that); 45 s for writing a
 *                   stamped PDF of up to 50 MB
 *   Video    8 s    one question to the service that keeps lesson videos
 *                   (lib/stream.ts); 3 s when a student's page is waiting
 *
 * Work with a hard end of its own — the five-minute jobs, which Vercel stops
 * at sixty seconds — runs inside `withCutoff`, and then every request made
 * inside it is also given up by that moment, whichever comes first. One
 * cutoff inside another keeps the earlier of the two.
 *
 * A request given up this way fails exactly as one that never reached the
 * service does: `fetch` throws a TypeError ("fetch failed"), and every
 * helper passes that on as it always did. So whatever a caller already does
 * when the network fails — refuse, fall back, keep a charge "pending" and
 * settle it later from what Stripe says — it does on a timeout too, and
 * nothing reads a request that timed out as one that worked. A request that
 * timed out may still have been done on the other side (a charge, an email):
 * the callers that must never do it twice send an idempotency key, and try
 * again with the same one.
 */

export const REDIS_TIMEOUT_MS = 5_000;
export const STRIPE_TIMEOUT_MS = 20_000;
export const RESEND_TIMEOUT_MS = 10_000;
export const SES_TIMEOUT_MS = 8_000;
export const DOMAINS_TIMEOUT_MS = 15_000;
export const BLOB_TIMEOUT_MS = 15_000;
export const BLOB_WRITE_TIMEOUT_MS = 45_000;
export const STREAM_TIMEOUT_MS = 8_000;
export const STREAM_PEEK_TIMEOUT_MS = 3_000;
export const VAULT_TIMEOUT_MS = 10_000;
export const VAULT_WRITE_TIMEOUT_MS = 45_000;

/**
 * Where the cutoff of the work in progress is kept. Some studio components
 * import modules that import this one (for a constant, a type), so it must
 * not name a Node module the browser's bundle cannot have: the server's
 * AsyncLocalStorage is found when it runs — the one Next.js puts on
 * globalThis, or Node's own. In a browser there is none, and no cutoff.
 */
type CutoffStore = { getStore(): number | undefined; run<R>(store: number, fn: () => R): R };
const cutoffs: CutoffStore | null = (() => {
  const g = globalThis as { AsyncLocalStorage?: new () => CutoffStore };
  if (typeof g.AsyncLocalStorage === "function") return new g.AsyncLocalStorage();
  const node = typeof process === "undefined" ? undefined : (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const hooks = node?.("node:async_hooks") as { AsyncLocalStorage?: new () => CutoffStore } | undefined;
  return hooks?.AsyncLocalStorage ? new hooks.AsyncLocalStorage() : null;
})();

/**
 * Runs `work` with a hard end: every request made inside it through `timed`
 * is given up by `at`, and one not yet sent after it is not sent.
 */
export function withCutoff<T>(at: number, work: () => Promise<T>): Promise<T> {
  if (!cutoffs) return work();
  const outer = cutoffs.getStore();
  return cutoffs.run(outer === undefined ? at : Math.min(outer, at), work);
}

/** Milliseconds left before the cutoff of the work this runs in; Infinity outside withCutoff. */
export function timeLeft(): number {
  const at = cutoffs?.getStore();
  return at === undefined ? Number.POSITIVE_INFINITY : at - Date.now();
}

/** How long to wait for a lock: `most`, or less when the cutoff is nearer, keeping `keep` for the work itself. */
export function lockWait(most: number, keep = 2_000): number {
  return Math.max(0, Math.min(most, timeLeft() - keep));
}

/** The error a request gives up with: the one `fetch` throws when the network fails. */
/** The reason a request cut short by our own run's time is given up with, never the provider's silence. */
export const RUN_TIME_RAN_OUT = "The run's own time ran out";
export const NO_TIME_TO_ASK = "there was no time left to ask";

export function givenUp(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

/**
 * Runs one request with a limit of `ms` (or less, near the cutoff). `work`
 * gets the signal to pass to `fetch`. The limit covers what `work` does:
 * a helper that reads the answer's body inside it is given up on when the
 * body stops arriving too, and one that returns a stream (a download, read
 * by the buyer's browser for as long as it takes) is limited only until the
 * answer starts, since the signal is never fired once `work` has returned.
 */
export async function timed<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const room = Math.min(ms, timeLeft());
  if (room < 50) throw givenUp(new Error(NO_TIME_TO_ASK));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The caller is answered when the time is up whether or not the library
  // doing the request honours the signal (Vercel Blob's retries, for one,
  // may not stop at once): the request is aborted, and its promise raced.
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Our own run's time (a cutoff nearer than `ms`) is told apart from the provider taking too long
      // (lib/stripe-silence.ts): only the second is the provider's silence.
      const reason = room < ms ? new DOMException(RUN_TIME_RAN_OUT, "TimeoutError") : new DOMException("The request took too long", "TimeoutError");
      controller.abort(reason);
      reject(givenUp(reason));
    }, room);
  });
  const running = work(controller.signal);
  // Whatever the request ends with after the time is up is let go quietly.
  running.catch(() => {});
  try {
    return await Promise.race([running, expired]);
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof TypeError && error.message === "fetch failed")) throw givenUp(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
