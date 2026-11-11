import type { StoreSearches } from "@/lib/search-console";

const RESULTS: Record<string, string> = {
  connected: "Search Console is connected. Each store's searches appear in its numbers the next time they are opened.",
  disconnected: "Search Console is disconnected.",
  declined: "Google's page was closed without allowing access. Nothing changed.",
  scope: "Access to Search Console was not selected on Google's page. Connect again and leave it selected.",
  expired: "That took too long or came from another session. Connect again.",
  error: "Google did not answer as expected. Try again in a moment.",
};

const day = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/**
 * Which Google searches found the store (lib/search-console.ts), and, for the
 * person who runs the site only, the switch that connects our Search Console.
 */
export function GoogleSearches({
  searches,
  operator,
  result,
}: {
  searches: StoreSearches | null;
  operator: { connected: boolean; account: string } | null;
  result: string;
}) {
  // ?gsc= is typed into the link: a name every object inherits (constructor, toString) is not a result.
  const resultText = Object.hasOwn(RESULTS, result) ? RESULTS[result] : undefined;
  return (
    <>
      {searches && searches.rows.length ? (
        <section className="card mt-8 p-6 sm:p-8" aria-labelledby="google-searches-title">
          <h2 id="google-searches-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Google searches that found you
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            {`What people typed into Google when your store's pages came up, ${day(searches.from)} to ${day(searches.to)}. Use their words in your titles and posts; a search where you are shown often and sit low on the page is one a clearer title can win.`}
          </p>
          <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="google-searches-title">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                  <th scope="col" className="py-1 font-semibold">Search</th>
                  <th scope="col" className="py-1 pl-3 text-right font-semibold">Clicks</th>
                  <th scope="col" className="py-1 pl-3 text-right font-semibold" title="How many times your store was shown for it">
                    Shown
                  </th>
                  <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Where your store stood on the page, on average: 1 is the top">
                    Place
                  </th>
                </tr>
              </thead>
              <tbody>
                {searches.rows.map((row) => (
                  <tr key={row.query} className="border-b border-line/60">
                    <th scope="row" className="py-1 pr-3 font-medium text-ink [overflow-wrap:anywhere]">{row.query}</th>
                    <td className="py-1 pl-3 text-right tabular-nums">{row.clicks.toLocaleString("en-US")}</td>
                    <td className="py-1 pl-3 text-right tabular-nums">{row.impressions.toLocaleString("en-US")}</td>
                    <td className="py-1 pl-3 text-right tabular-nums">{row.position.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            From Google Search Console, refreshed once a day; Google settles its figures about two days late and leaves out
            searches made by very few people. What these visitors bought is under Google in the table of channels.
          </p>
        </section>
      ) : null}

      {operator ? (
        <section className="card mt-8 p-6 sm:p-8" aria-labelledby="search-console-title">
          <h2 id="search-console-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Search Console for marktmorgen.com
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            {operator.connected
              ? `Connected${operator.account ? ` with ${operator.account}` : ""}. Every store on marktmorgen.com sees the Google searches that found it. Only you see this card.`
              : "Connect the Google account that holds marktmorgen.com in Search Console, and every store on marktmorgen.com sees the Google searches that found it. Read-only. Only you see this card."}
          </p>
          {resultText ? (
            <p className={`mt-3 notice ${result === "connected" || result === "disconnected" ? "notice-info" : "notice-warn"}`} role="status">
              {resultText}
            </p>
          ) : null}
          <form action="/api/operator/search-console" method="post" className="mt-4">
            {operator.connected ? <input type="hidden" name="action" value="disconnect" /> : null}
            <button type="submit" className={`btn btn-sm ${operator.connected ? "btn-secondary" : "btn-primary"}`}>
              {operator.connected ? "Disconnect Search Console" : "Connect Search Console"}
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
