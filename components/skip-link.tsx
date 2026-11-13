/**
 * A server-rendered first route from a task page to its central landmark.
 * A store passes its own words and their lang (lib/buyer-words/skip.ts);
 * everywhere else the link stays in the site's English.
 */
export function SkipLink({ label, lang }: { label?: string; lang?: string } = {}) {
  return (
    <a
      href="#content"
      lang={lang}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-[10px] focus:bg-white focus:px-4 focus:py-2.5 focus:font-semibold focus:text-violet-deep focus:shadow-lg"
    >
      {label ?? "Skip to the page content"}
    </a>
  );
}
