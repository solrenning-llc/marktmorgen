/**
 * "next/og" for tests/child-safety-access.test.ts: keeps what a shared card
 * would draw, so the test can read whether it names a product, without the
 * real drawer (which needs fonts and WebAssembly outside Next).
 */
export const drawn: unknown[] = [];

export class ImageResponse extends Response {
  constructor(element: unknown, init?: ResponseInit) {
    super("card", { ...init, headers: { "content-type": "image/png" } });
    drawn.push(element);
  }
}
