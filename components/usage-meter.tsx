import type { ReactNode } from 'react';

/** Unknown counters never render as zero or as available capacity. */
export function UsageMeter({ label, used, limit, format, unavailable, description }: {
  label: string;
  used: number | null;
  limit: number;
  format: (n: number) => string;
  unavailable: string;
  description?: ReactNode;
}) {
  const validLimit = Number.isSafeInteger(limit) && limit >= 0;
  const known = typeof used === 'number' && Number.isSafeInteger(used) && used >= 0 && validLimit;
  const percent = known ? (limit > 0 ? Math.min(100, Math.round((used! / limit) * 100)) : 100) : null;
  return <div>
    <p className="font-semibold text-ink">{label}</p>
    {known ? <>
      <p className="mt-1 text-ink-soft">{format(used!)} of {format(limit)} this month.</p>
      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-sand" role="progressbar" aria-label={label} aria-valuenow={percent!} aria-valuemin={0} aria-valuemax={100}>
        <div className={`meter-fill h-full rounded-full ${used! >= limit ? 'bg-amber-brand' : 'bg-gradient-to-r from-violet-brand to-sky-brand'}`} style={{ width: `${percent}%` }} />
      </div>
    </> : <p className="mt-2 notice notice-warn" role="status">
      {unavailable} {validLimit ? `Monthly threshold: ${format(limit)}.` : 'The monthly threshold could not be verified.'}
    </p>}
    {description ? <p className="mt-2 text-sm text-ink-soft">{description}</p> : null}
  </div>;
}
