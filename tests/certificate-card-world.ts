/**
 * next/og for tests/certificate-card-standing.test.ts: ImageResponse keeps
 * the element it was asked to draw, so the test reads every word of the
 * picture without drawing a PNG. Everything else is the real code.
 */
export const drawn: unknown[] = [];

export class ImageResponse {
  constructor(readonly element: unknown) {
    drawn.push(element);
  }
}
