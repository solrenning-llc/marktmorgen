import Link from "next/link";
import { Icon } from "@/components/icons";
import { type Check, type CheckState, checkupSummary } from "@/lib/checkup-rules";

/** Said in words beside each part, with its own icon, so no state is told by color alone. */
const STATE: Record<CheckState, { words: string; className: string; icon: "alert" | "info" | "check-circle" }> = {
  problem: { words: "Problem", className: "tag tag-brand", icon: "alert" },
  "not-checked": { words: "Not checked", className: "tag", icon: "info" },
  ok: { words: "Fine", className: "tag tag-live", icon: "check-circle" },
};

/**
 * The checkup as the creator reads it (491 [PP2], unit 2): the line at the
 * top with the time it was read, then each part as a section named by its
 * heading. `hrefOf` turns a fix inside the studio into the link for this
 * store. Drawn on the server, no script of its own.
 */
export function CheckupList({ checks, checkedAt, hrefOf }: { checks: Check[]; checkedAt: number; hrefOf: (href: string) => string }) {
  const at = new Date(checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return (
    <>
      <p className="mt-5 max-w-2xl text-lg font-semibold text-ink" data-checkup-summary>
        {checkupSummary(checks)}
      </p>
      <p className="mt-1 text-sm text-ink-soft">{`Checked at ${at} (UTC).`}</p>
      <ul className="mt-6 max-w-3xl space-y-4">
        {checks.map((check) => {
          const state = STATE[check.state];
          return (
            <li key={check.id}>
              <section className="card p-5 sm:p-6" aria-labelledby={`check-${check.id}`} data-check={check.id} data-state={check.state}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id={`check-${check.id}`} className="text-lg font-semibold tracking-[-0.02em] text-ink">
                    {check.title}
                  </h2>
                  <span className={`${state.className} inline-flex items-center gap-1`}>
                    <Icon name={state.icon} size={14} />
                    {state.words}
                  </span>
                </div>
                <p className="mt-2 text-ink">{check.found}</p>
                {check.ifLeft ? (
                  <p className="mt-2 text-ink-soft">
                    <span className="font-semibold text-ink">If it stays this way: </span>
                    {check.ifLeft}
                  </p>
                ) : null}
                {check.fix?.kind === "studio" ? (
                  <p className="mt-3">
                    <Link href={hrefOf(check.fix.href)} className="btn btn-secondary btn-sm">
                      {check.fix.label}
                    </Link>
                  </p>
                ) : check.fix?.kind === "outside" ? (
                  <p className="mt-2 text-ink-soft">
                    <span className="font-semibold text-ink">How to fix it: </span>
                    {check.fix.where}
                  </p>
                ) : null}
              </section>
            </li>
          );
        })}
      </ul>
    </>
  );
}
