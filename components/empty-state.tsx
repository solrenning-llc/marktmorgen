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

/** `level` keeps the page's outline: 2 right under the page's h1, 3 under a section's h2. */
export function EmptyState({ title, body, action, level = 2, className = "" }: { title: string; body: string; action?: EmptyAction; level?: 2 | 3; className?: string }) {
  if (!title.trim() || !body.trim()) return null;
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <div className={`st-note text-center ${className}`.trim()} data-empty-state="">
      <Heading className="text-base font-bold" style={{ color: "var(--st-text)" }}>{title}</Heading>
      <p className="mt-2 text-sm">{body}</p>
      {works(action) ? (
        <Link href={action.href} className="btn st-btn mt-4">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/** A named place on the same page ("#asking-for-reviews"), never a bare "#". */
function inPage(action: EmptyAction | undefined): EmptyAction | null {
  return action && action.label.trim() && /^#[A-Za-z][\w-]*$/.test(action.href) ? action : null;
}

/**
 * The same pattern in the studio, drawn with the studio's own colors (--ink
 * 16:1 and --ink-soft 10:1 on white and on ivory) and left-aligned like the
 * lists it replaces. `level` keeps the page's outline: 3 under a list's h2, 4 under an h3,
 * 2 beside other boxes headed h2. The action is a path on this site, or a jump
 * to a named place on the same page, kept a plain link so the browser moves
 * the focus there; the .btn class is 48 px tall. `compact` is for a narrow
 * box under a visible heading: smaller type, so it does not outrank it.
 */
export function StudioEmptyState({ title, body, action, level = 3, compact = false, className = "" }: { title: string; body: string; action?: EmptyAction; level?: 2 | 3 | 4; compact?: boolean; className?: string }) {
  if (!title.trim() || !body.trim()) return null;
  const Heading = level === 2 ? "h2" : level === 4 ? "h4" : "h3";
  const jump = inPage(action);
  return (
    <div className={className || undefined} data-empty-state="">
      <Heading className={`${compact ? "text-base" : "text-lg"} font-semibold text-ink`}>{title}</Heading>
      <p className={`${compact ? "mt-1 text-sm" : "mt-2"} text-ink-soft`}>{body}</p>
      {works(action) ? (
        <Link href={action.href} className="btn btn-secondary mt-4">
          {action.label}
        </Link>
      ) : jump ? (
        <a href={jump.href} className="btn btn-secondary mt-4">
          {jump.label}
        </a>
      ) : null}
    </div>
  );
}
