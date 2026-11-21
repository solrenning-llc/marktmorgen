/**
 * The studio's notice that the store's short links were turned off and work again (the owner's decision 14 on #3330,
 * 9 November 2026; lib/short-link-rest.ts): shown to a store that pays, for 30 days after it paid again. Drawn on the
 * server; no script, nothing to do.
 */
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export function shortLinksOffWords(offAt: number, backAt: number): string[] {
  return [
    `While your store did not have a paid plan, its short links were turned off on ${day(offAt)}.`,
    `From then until ${day(backAt)}, anyone who opened one saw a page saying it was turned off.`,
    "Your plan is paid now, so your short links work again. You do not need to do anything.",
  ];
}

export function ShortLinksOffNotice({ offAt, backAt }: { offAt: number; backAt: number }) {
  return (
    <section id="short-links-off" aria-labelledby="short-links-off-title" className="notice notice-info mt-6 scroll-mt-24">
      <h2 id="short-links-off-title" className="font-bold text-ink">
        Your short links were turned off for a while
      </h2>
      {shortLinksOffWords(offAt, backAt).map((line) => (
        <p key={line} className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{line}</p>
      ))}
    </section>
  );
}
