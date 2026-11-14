import Link from "next/link";
import { Icon } from "@/components/icons";
import { type StoreCheck, nextChecks, storeScore } from "@/lib/store-coach";

/**
 * Store setup checklist in the studio (lib/store-coach.ts): a score out
 * of 100, the next few things to do, each with where it is done, and the
 * rest folded away.
 */
export function StoreCoach({ checks }: { checks: StoreCheck[] }) {
  if (checks.length === 0) return null;
  const score = storeScore(checks);
  const next = nextChecks(checks);
  const done = checks.filter((check) => check.done);
  return (
    <section aria-labelledby="coach-title" className="card mt-8 p-6 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="coach-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Set up your store
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {next.length
              ? `${done.length} of ${checks.length} setup checks complete. Choose a next step below.`
              : `All ${checks.length} setup checks complete. Review your products and pages as your store changes.`}
          </p>
        </div>
        <p className="text-3xl font-semibold tabular-nums tracking-[-0.03em] text-violet-deep">
          {score}
          <span className="text-base text-ink-soft">/100</span>
        </p>
      </div>
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-sand"
        role="progressbar"
        aria-label="Store setup progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
      >
        <div className="h-full rounded-full bg-violet-brand transition-[width]" style={{ width: `${score}%` }} />
      </div>
      {next.length ? (
        <ol className="mt-5 space-y-3">
          {next.map((check) => (
            <li key={check.id} className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-paper p-4 ring-1 ring-line">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{check.label}</p>
                <p className="mt-0.5 text-sm text-ink-soft">{check.why}</p>
              </div>
              <Link href={check.href} className="btn btn-secondary btn-sm shrink-0">
                Do it
                <Icon name="arrow-right" size={16} />
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
      {done.length ? (
        <details className="mt-4">
          <summary className="cursor-pointer py-3 text-sm font-bold text-ink-soft">{`Already done (${done.length})`}</summary>
          <ul className="mt-2 space-y-1">
            {done.map((check) => (
              <li key={check.id} className="flex items-center gap-2 text-sm text-ink">
                <Icon name="check" size={16} className="text-violet-deep" />
                {check.label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
