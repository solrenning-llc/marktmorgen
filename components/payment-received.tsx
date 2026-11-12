/**
 * The mark a buyer sees once a payment is confirmed (queue item 654 [WG14],
 * part (a)): a ring and a check drawn once, 600 ms in all, beside the words
 * in a status region. No sound, no confetti, no amount: it takes only its
 * words. The drawing repeats the words, so it is hidden from screen readers.
 *
 * The motion lives in app/globals.css (".mm-paid-*"): the mark is complete
 * by default and is animated only under prefers-reduced-motion:
 * no-preference, so a buyer who asks for less motion sees it already drawn.
 * It strokes in currentColor, so dark mode and forced colors follow the
 * text around it.
 *
 * Show it only for an order Stripe confirmed as paid; the page decides.
 */
export function PaymentReceived({ label }: { label: string }) {
  return (
    <div role="status" className="mm-paid inline-flex items-center gap-3">
      <svg aria-hidden="true" focusable="false" width="40" height="40" viewBox="0 0 40 40" className="mm-paid-mark shrink-0">
        <circle className="mm-paid-ring" cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="3" pathLength={1} />
        <path
          className="mm-paid-check"
          d="M12.5 20.5l5 5 10-11"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
        />
      </svg>
      <span className="font-semibold">{label}</span>
    </div>
  );
}
