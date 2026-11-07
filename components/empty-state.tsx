import Link from "next/link";

/**
 * 656 [WG16]: one pattern for a list with nothing in it. A heading, one
 * sentence that says what this is and what comes, and at most one action,
 * drawn only when it goes somewhere on this site: never a dead button, never a
 * blank block. On a public store page it speaks to the buyer; in the studio it
 * speaks to the creator, with the action that fills the list.
 */
export type EmptyAction = { href: string; label: string };

/** A path on this site ("/..."), not another site, a fragment or a script. */
function works(action: EmptyAction | undefined): action is EmptyAction {
  if (!action || !action.label.trim()) return false;
  return /^\/(?!\/)/.test(action.href) && !/^\/\\/.test(action.href);
}

export function EmptyState({ title, body, action, className = "" }: { title: string; body: string; action?: EmptyAction; className?: string }) {
  if (!title.trim() || !body.trim()) return null;
  return (
    <div className={`st-note text-center ${className}`.trim()} data-empty-state="">
      <h2 className="text-base font-bold" style={{ color: "var(--st-text)" }}>{title}</h2>
      <p className="mt-2 text-sm">{body}</p>
      {works(action) ? (
        <Link href={action.href} className="btn st-btn mt-4">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
