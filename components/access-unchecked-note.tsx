/**
 * Said to a student whose access to a course could not be checked just now (lib/course-door.ts, "unchecked"): a status
 * region, so a screen reader announces it, in the store's language, with a real link that loads the page again (a full
 * load, so the server asks again: nothing unknown was kept). Never a checkout or anything to buy beside it.
 */
type Props = { title: string; body: string; retry: string; href: string; className?: string };

export function AccessUncheckedNote({ title, body, retry, href, className = "" }: Props) {
  return (
    <div className={`st-note ${className}`.trim()} role="status">
      <p className="font-bold" style={{ color: "var(--st-text)" }}>{title}</p>
      <p className="mt-1 text-sm">{body}</p>
      <a href={href} className="btn st-btn mt-3">
        {retry}
      </a>
    </div>
  );
}
