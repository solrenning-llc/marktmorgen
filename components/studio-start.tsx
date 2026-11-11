import type { ActivationTiming } from "@/lib/store-activation";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { START_STEP_UNKNOWN, startList, startProgressWords } from "@/lib/studio-start-rules";

export type StartStep = {
  key: string;
  title: string;
  hint: string;
  done: boolean;
  /** Its check mark could not be read just now: shown as such, never done and never the next step. */
  unknown?: boolean;
  href: string;
};

/**
 * The first steps of a new store, in order, with what is already done ticked
 * (484 [IT1]): at most five steps to the first sale, then the rest
 * (lib/studio-start-rules.ts). Every tick is read from the store itself, so
 * nothing here can be ticked by pressing it; it disappears on its own once
 * every step is done. A step whose check mark could not be read just now is
 * not done here: it says so, and the list stays. The steps can be collapsed and opened again (a native
 * disclosure, so it works by keyboard and without scripts); the title, the
 * progress, the next step and the first offer's timing stay in sight.
 */
export function StudioStart({ steps: all, activation, launchChecklist }: { steps: StartStep[]; activation?: ActivationTiming; launchChecklist?: string }) {
  const { phase, steps, toSale } = startList(all);
  const done = steps.filter((s) => s.done).length;
  if (steps.length === 0 || (done === steps.length && !activation)) return null;
  const next = steps.find((s) => !s.done && !s.unknown);
  const percent = Math.round((done / steps.length) * 100);

  return (
    <section aria-labelledby="start-title" className="card mt-8 p-6 sm:p-8" data-start-phase={phase}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="start-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Getting your store ready
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{startProgressWords(phase, done, steps.length, toSale)}</p>
        </div>
        {next ? (
          <Link href={next.href} className="btn btn-primary btn-sm">
            {`Next: ${next.title}`}
            <Icon name="arrow-right" size={16} />
          </Link>
        ) : null}
      </div>
      {activation ? <p className="mt-3 text-sm text-ink-soft" data-activation-timing>
        {activation.state === "published" ? `First offer published ${activation.minutes} minutes after this store was registered.` : activation.state === "waiting" ? `${activation.minutes} minutes since this store was registered. Your first offer is still in preparation.` : "The original first-publication time is not recorded for this store."}
        {" "}This measures store registration, not an earlier sign-in or a sale. Drafts do not count as published offers.
      </p> : null}
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-sand"
        role="progressbar"
        aria-label={phase === "after" ? "More steps done" : toSale ? "Steps to your first sale done" : "First steps done"}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${steps.length}`}
      >
        <div className="h-full rounded-full bg-violet-brand transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
      <details className="group/start mt-4" open>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 text-sm [&::-webkit-details-marker]:hidden font-semibold text-ink-soft underline-offset-4 hover:text-ink hover:underline">
          <span aria-hidden="true" className="transition-transform motion-reduce:transition-none group-open/start:rotate-90">▸</span>
          <span className="group-open/start:hidden">Show the steps</span>
          <span className="hidden group-open/start:inline">Hide the steps</span>
        </summary>
        {launchChecklist ? <details className="group mt-5"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-3 font-semibold text-ink [&::-webkit-details-marker]:hidden"><span aria-hidden="true" className="transition-transform motion-reduce:transition-none group-open:rotate-90">▸</span>Review the saved launch checklist</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink-soft">{launchChecklist}</pre></details> : null}
        <ol className="mt-6 grid min-w-0 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {steps.map((step, i) => (
            <li key={step.key} className="flex min-w-0 gap-3">
              <span
                className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[0.75rem] font-semibold ${
                  step.done ? "bg-mint-soft text-mint-deep" : step === next ? "bg-violet-brand text-white" : "bg-sand text-ink-soft"
                }`}
              >
                {step.done ? <Icon name="check" size={14} strokeWidth={2.6} /> : step.unknown ? <span aria-hidden="true">?</span> : i + 1}
                <span className="sr-only">{step.done ? " (done)" : step.unknown ? " (could not be checked just now)" : ""}</span>
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {step.done ? (
                  <span className="font-semibold text-ink-mute line-through decoration-ink-mute/40">{step.title}</span>
                ) : (
                  <Link href={step.href} className="font-semibold text-ink underline-offset-4 hover:text-violet-deep hover:underline">
                    {step.title}
                  </Link>
                )}
                <span className="block text-sm text-ink-soft">{step.hint}</span>
                {step.unknown && !step.done ? <span className="block text-sm text-ink-soft">{START_STEP_UNKNOWN}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

/**
 * The studio's sections, one tap away, on every width. On a phone the row
 * scrolls sideways; its right edge fades out, so it is plain there is more,
 * and a little room after the last one lets it come clear of the fade.
 * Each link is a 44 × 44 px target (WCAG 2.5.5 AAA, AX274), even a short one
 * like "API" (tests/studio-nav-targets.test.ts).
 */
export function StudioNav({ items }: { items: { href: string; label: string }[] }) {
  return (
    <nav aria-label="Studio sections" className="sticky top-16 z-30 -mx-4 mt-6 border-b border-line bg-paper/95 px-4 backdrop-blur sm:mx-0 sm:rounded-full sm:border sm:px-2">
      <ul className="flex gap-1 overflow-x-auto py-2 pr-10 [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent)] [scrollbar-width:none] sm:pr-0 sm:[mask-image:none]">
        {items.map((item) => (
          <li key={item.href} className="shrink-0">
            <Link
              href={item.href}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-3.5 text-sm font-semibold text-ink-soft transition-colors hover:bg-white hover:text-ink focus-visible:bg-white"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
