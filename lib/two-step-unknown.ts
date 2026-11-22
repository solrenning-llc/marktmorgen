/**
 * Rule 24 for the two-step lock, at the routes that ask it (the open point of
 * #3552). A session's lock that could not be read (lib/two-step.ts lockedUntil
 * or lockedFor threw: Redis did not answer) is neither "locked" nor "free":
 * nothing that waits for the lock is done, and the person is told so in plain
 * words, with a 503 and when to try again, never a server error, never the
 * "locked" notice on a guess, never read as unlocked.
 *
 * Only the read handed in is caught: an error anywhere else in a route is
 * never answered here. Every caller asks before it writes anything, so the
 * sentence can say that nothing was changed (tests/r24-lock-unread-routes.test.ts).
 */

/** How long to wait before trying again, in seconds (the Retry-After header). */
export const LOCK_UNREAD_RETRY_SECONDS = 60;

/** The sentence, the same in every answer. */
export const LOCK_UNREAD_MESSAGE = "We couldn't check your sign-in right now. Nothing was changed. Try again in a minute.";

/** What a read of the lock answers when it failed. */
export const LOCK_UNREAD: unique symbol = Symbol("two-step lock unread");

const HEADERS = { "Retry-After": String(LOCK_UNREAD_RETRY_SECONDS), "Cache-Control": "no-store" } as const;

/** The read's own answer, or LOCK_UNREAD when it failed (said in the log, never to the person). */
export async function lockOrUnread<T>(read: Promise<T>): Promise<T | typeof LOCK_UNREAD> {
  try {
    return await read;
  } catch (error) {
    console.error("reading a session's two-step lock failed", error);
    return LOCK_UNREAD;
  }
}

/** The answer for a route the studio's code reads (JSON). */
export function lockUnreadJson(): Response {
  return Response.json({ ok: false, error: "lock_unread", message: LOCK_UNREAD_MESSAGE }, { status: 503, headers: HEADERS });
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The answer for a route reached by a form or a link: a small page in plain
 * words, with a way back (`back`, an address on this site; `to`, where it
 * leads, said in the link). Light and dark, text far above 7:1, a link at
 * least 44px tall, nothing that moves.
 */
export function lockUnreadPage(back: string, to: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>Try again in a minute</title>` +
    `<style>:root{color-scheme:light dark}body{font:1.125rem/1.6 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;background:#fff;color:#1d1b29}` +
    `a{color:inherit;display:inline-block;min-height:44px;padding:.5rem 0;text-decoration:underline;text-underline-offset:.2em}a:focus-visible{outline:3px solid currentColor;outline-offset:3px}` +
    `@media (prefers-color-scheme:dark){body{background:#14121c;color:#f4f2fa}}</style></head>` +
    `<body><main><h1>Try again in a minute</h1><p>${escape(LOCK_UNREAD_MESSAGE)}</p><p><a href="${escape(back)}">Back to ${escape(to)}</a></p></main></body></html>`;
  return new Response(html, { status: 503, headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * The read's own answer, or the response to send instead when it failed:
 * JSON by default, or the page with a way back for a form or a link.
 */
export async function lockRead<T>(read: Promise<T>, page?: { back: string; to: string }): Promise<T | Response> {
  const value = await lockOrUnread(read);
  if (value !== LOCK_UNREAD) return value;
  return page ? lockUnreadPage(page.back, page.to) : lockUnreadJson();
}
