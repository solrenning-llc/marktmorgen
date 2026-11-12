import { SUPPORT_EMAIL } from "@/lib/creator-research";

/**
 * Refunds for AI captions Stripe has not confirmed yet, on the course page (lib/auto-captions.ts autoRefundsOwed).
 * Null means they could not be read (rule 24): the section says so, never hides as if nothing were owed.
 */
export function CaptionsRefundsOwed({ rows }: { rows: { id: string; cents: number; stuck: boolean }[] | null }) {
  if (rows !== null && !rows.length) return null;
  return (
    <section aria-labelledby="captions-refunds" className="mt-5 rounded-2xl border border-line bg-paper p-4" data-captions-refunds>
      <h2 id="captions-refunds" className="text-base font-bold text-ink">
        Refunds for AI captions not confirmed yet
      </h2>
      {rows === null ? (
        <p className="mt-2 text-sm text-ink" role="status">
          We could not check refunds for AI captions just now. Reload the page in a minute to try again.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm text-ink">
          {rows.map((row) => (
            <li key={row.id}>
              {row.stuck
                ? `A refund of $${(row.cents / 100).toFixed(2)} for AI captions was not confirmed by Stripe, and we have stopped checking it on our own. Write to ${SUPPORT_EMAIL} about it.`
                : `A refund of $${(row.cents / 100).toFixed(2)} for AI captions was asked for, and Stripe has not confirmed it yet. We check it again on our own; you do not need to do anything.`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
