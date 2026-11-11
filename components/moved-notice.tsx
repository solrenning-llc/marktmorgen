/**
 * What a visitor to a closed store's old address reads while its moved
 * notice runs (97 [D2-OPEN-EXIT]; lib/exit-redirect-rules.ts). The store's
 * owner gave the new address before the store closed; the visitor chooses to
 * follow it (WCAG 3.2.5, change on request), in this same window, and the
 * link passes nothing of this page on. The new site's host is the link's
 * text, in its ASCII form, so a look-alike name shows as what it is, and the
 * page says plainly that Marktmorgen did not check that site.
 */
const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

export function MovedNotice({ to, host, until }: { to: string; host: string; until: number }) {
  return (
    <main id="content" className="flex-1">
      <section className="container-narrow py-20 sm:py-28">
        <p className="eyebrow">Store closed here</p>
        <h1 className="t-h1 mt-4">This store has moved</h1>
        <p className="t-lead mt-5 max-w-xl text-ink-soft">
          The person who ran this store closed it on Marktmorgen. Before it closed, they told us the store is now at
          this address:
        </p>
        <p className="mt-8">
          <a href={to} rel="nofollow noopener noreferrer" className="btn btn-primary">
            Go to {host}
          </a>
        </p>
        <p className="mt-8 max-w-xl text-ink-soft">
          Marktmorgen did not check that site and is not part of it. This notice stays here until {DATE.format(until)}.
        </p>
      </section>
    </main>
  );
}
