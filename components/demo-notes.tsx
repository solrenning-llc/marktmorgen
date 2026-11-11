import { TEST_CARD } from "@/lib/house-store";

/**
 * What the demo store says about itself, on the pages every store has.
 *
 * The demo is an ordinary store (lib/house-store.ts), so its pages are the
 * ones a creator's store is drawn with, and these two pieces are all that is
 * added to them: a strip across the top of every page of it, and the note
 * under what it sells. Both say the same two things before anybody reaches a
 * card form — that no real money moves here, and which card to type.
 */

/**
 * Across the top of every page of the demo store. In a named landmark, so a screen reader that moves by landmarks
 * still meets the notice that no real money moves (274 [AX1], tests/demo-strip-landmark.test.ts).
 */
export function DemoStrip() {
  return (
    <aside aria-label="Demo store">
      <p
        data-demo-strip=""
        className="flex flex-col items-center justify-center gap-0.5 bg-night px-4 py-2.5 text-center text-[0.8125rem] leading-5 text-white/80 sm:flex-row sm:gap-2"
      >
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="rounded-[5px] bg-white/12 px-1.5 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-white">
            Demo
          </span>
          Stripe test mode: no real money moves.
        </span>
        <span>
          Pay with <span className="font-mono font-semibold text-white">{TEST_CARD}</span>, any future date, any CVC.
        </span>
      </p>
    </aside>
  );
}

/**
 * Under what the demo store sells, where a creator's store says whose
 * account takes the payment. `full` adds what is different on a real store.
 */
export function DemoNote({ full = false }: { full?: boolean }) {
  return (
    <p className="st-note mt-6 text-sm">
      <strong>This is a demo store.</strong> Its checkout runs in Stripe&apos;s test mode: no real money moves and no
      real card is charged. Pay with the test card {TEST_CARD}, any future date and any CVC. What you buy is real:
      the files download, and a booked call holds its time and gets its own meeting link.
      {full
        ? " On a creator's store the same checkout takes real payments, on the creator's own Stripe account: Marktmorgen never holds the money and takes none of it."
        : null}
    </p>
  );
}
