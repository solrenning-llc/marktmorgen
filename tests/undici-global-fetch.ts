/**
 * The @vercel/blob client's `fetch`, as its browser build has it
 * (node_modules/@vercel/blob/dist/undici-browser.js: the page's own fetch),
 * read at each call so a synthetic test can answer it. Without this the
 * Node build would reach the real network.
 */
export const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
