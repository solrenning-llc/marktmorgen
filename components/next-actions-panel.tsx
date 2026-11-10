import Link from "next/link";
import type { NextActionId, NextView } from "@/lib/next-actions-rules";
import { NextActionDraft } from "@/components/next-action-draft";

/**
 * "Do this next" on the studio's Today (484 [IT1] complement WG, unit 2): one to three actions from numbers the
 * store already keeps (lib/next-actions-rules.ts chooses them, lib/next-actions-read.ts reads them). Each is a short
 * list item in plain words: the count, the recorded money with it, where the number comes from and when it was
 * counted, and a link named by where it goes (2.4.9), the size of a button (2.5.5). Nothing is sent, switched on or
 * charged from here. A number that could not be read is said, never drawn as zero; with nothing read for this
 * person, nothing is drawn at all. The block itself needs no script; where the studio allows it (`draftable`: the
 * role writes drafts and the store has the writing help), an action has "Write a draft with AI" under its link
 * (components/next-action-draft.tsx, unit 3), which costs `jobs` of the month's AI uses and sends nothing.
 */
export function NextActionsPanel({ view, draftable = [], jobs = 1 }: { view: NextView; draftable?: readonly NextActionId[]; jobs?: number }) {
  if (view.kind === "nothing" && !view.looked) return null;
  return (
    <section aria-labelledby="next-actions-title" className="card mt-8 p-6 sm:p-8" data-next-actions={view.kind}>
      <h2 id="next-actions-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Do this next
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">
        From numbers your store already has, with money at risk first. Nothing is sent or changed from here.
      </p>
      {view.kind === "actions" ? (
        <>
          <ol className="mt-4 space-y-3" aria-label="Suggested next steps, most important first">
            {view.actions.map((action) => (
              <li key={action.id} className="rounded-[var(--r-sm)] border border-line bg-white p-4" data-next-action={action.id}>
                <p className="font-semibold text-ink">{action.words}</p>
                {action.money ? <p className="mt-1 text-sm text-ink">{action.money}</p> : null}
                <p className="mt-1 text-sm text-ink-soft">{`${action.source} ${action.asOf}`}</p>
                <Link href={action.href} className="btn btn-secondary btn-sm mt-3">
                  {action.link}
                </Link>
                {draftable.includes(action.id) ? <NextActionDraft action={action.id} jobs={jobs} /> : null}
              </li>
            ))}
          </ol>
          {view.note ? <p className="notice notice-warn mt-4">{view.note}</p> : null}
        </>
      ) : view.kind === "unknown" ? (
        <p className="notice notice-warn mt-4">{view.words}</p>
      ) : (
        <p className="mt-4 text-ink">{view.words}</p>
      )}
    </section>
  );
}
