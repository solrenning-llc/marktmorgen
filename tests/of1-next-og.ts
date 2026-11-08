/**
 * next/og for tests/of1-suspended-visitor-pages.test.ts: as tests/security/next-og.ts, every
 * drawing answers the same small PNG (the real one draws with WebAssembly that only Next's own
 * build can load), and the last tree it was asked to draw is kept, so the test can read what a
 * shared card or an icon would have shown.
 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

export const drawings: { last: unknown } = { last: null };

export class ImageResponse extends Response {
  constructor(element: unknown, options: { headers?: HeadersInit } = {}) {
    drawings.last = element;
    super(PNG, { headers: { "Content-Type": "image/png", "Cache-Control": "public, immutable, no-transform, max-age=31536000", ...(options.headers ?? {}) } });
  }
}
