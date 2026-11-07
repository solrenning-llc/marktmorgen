/** A server-rendered first route from a task page to its central landmark. */
export function SkipLink() {
  return (
    <a
      href="#content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-[10px] focus:bg-white focus:px-4 focus:py-2.5 focus:font-semibold focus:text-violet-deep focus:shadow-lg"
    >
      Skip to the page content
    </a>
  );
}
