import type { Metadata } from "next";
import { cookies } from "next/headers";
import { storeForId } from "@/lib/store";
import { LINK_ID, MAX_PASSWORD, cookieFits, cookieName, countOpen, linkStore } from "@/lib/numbers-links";
import { takePublicRequest } from "@/lib/traffic";
import { readVerified } from "@/lib/verified-numbers";
import { formatMoney } from "@/lib/money";
import { channelName } from "@/lib/channel-names";

type Params = { params: Promise<{ id: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export const metadata: Metadata = { title: "Shared numbers — Marktmorgen", robots: { index: false, follow: false } };

const count = (n: number) => n.toLocaleString("en-US");
const longDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const regions = new Intl.DisplayNames(["en-US"], { type: "region" });

/** The time the page is drawn at. */
function moment(): number {
  return Date.now();
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="content" className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      {children}
    </main>
  );
}

/**
 * A store's counted numbers, for whoever the creator gave the link and its
 * password to (lib/numbers-links.ts): read-only, from the record kept once a
 * day (lib/verified-numbers.ts), with the day it was read and where each
 * number comes from.
 */
export default async function NumbersLinkPage({ params, searchParams }: Params) {
  const { id } = await params;
  const query = await searchParams;
  const now = moment();
  // A read that fails, or answers in an unknown shape, is said as not read: never "ended" or "opened too many times".
  const unread = (error: unknown) => {
    console.error("a shared numbers link could not be read", error);
    return (
      <Shell>
        <div className="card p-6 sm:p-8" role="status">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">These numbers could not be read just now</h1>
          <p className="mt-3 text-ink-soft">The link has not ended because of this. Try again in a moment.</p>
        </div>
      </Shell>
    );
  };
  const busy = () => (
    <Shell>
      <div className="card p-6 sm:p-8" role="status">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">These numbers can&apos;t be opened right now</h1>
        <p className="mt-3 text-ink-soft">The link still works. Try again later.</p>
      </div>
    </Shell>
  );
  let store: Awaited<ReturnType<typeof storeForId>>;
  try {
    const sid = LINK_ID.test(id) ? await linkStore(id) : null;
    store = sid ? await storeForId(sid) : null;
  } catch (error) {
    return unread(error);
  }
  const link = store?.numbersLinks.find((l) => l.id === id) ?? null;

  if (!store || !link || link.expires <= Math.floor(now / 1000) || store.suspended) {
    return (
      <Shell>
        <div className="card p-6 sm:p-8">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">This link has ended</h1>
          <p className="mt-3 text-ink-soft">It reached the end date its creator set, or they took it back. Ask them for a new one.</p>
        </div>
      </Shell>
    );
  }

  const jar = await cookies();
  if (!cookieFits(link, jar.get(cookieName(id))?.value, now)) {
    const wrong = query.wrong === "1";
    const tries = query.tries === "1";
    const notNow = query.busy === "1";
    const notChecked = query.unread === "1";
    return (
      <Shell>
        <div className="card p-6 sm:p-8">
          <p className="text-sm font-semibold text-ink-soft">{store.name}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-ink">{link.label}</h1>
          <p className="mt-3 text-ink-soft">These numbers are shared with a password. Type the one you were given.</p>
          <form action="/api/numbers-link" method="post" className="mt-5 space-y-3">
            <input type="hidden" name="id" value={id} />
            <label htmlFor="numbers-password" className="field-label">Password</label>
            <input id="numbers-password" name="password" type="password" required maxLength={MAX_PASSWORD} autoComplete="current-password" className="field" />
            {wrong ? <p className="notice notice-error" role="alert">That password does not open these numbers.</p> : null}
            {tries ? <p className="notice notice-error" role="alert">Too many tries for now. Wait ten minutes and try again.</p> : null}
            {notNow ? <p className="notice notice-info" role="status">These numbers can&apos;t be opened right now. Try again later.</p> : null}
            {notChecked ? <p className="notice notice-info" role="status">Your password could not be checked just now. Try again in a moment.</p> : null}
            <button type="submit" className="btn btn-primary">Open the numbers</button>
          </form>
        </div>
      </Shell>
    );
  }

  // Each opening is counted for the link, then is one of the store's public requests for its window (lib/traffic.ts).
  let counted: boolean;
  try {
    counted = await countOpen(id, now);
  } catch (error) {
    return unread(error);
  }
  if (!counted) {
    return (
      <Shell>
        <div className="card p-6 sm:p-8">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Opened too many times today</h1>
          <p className="mt-3 text-ink-soft">This link opens a few hundred times a day at most. It opens again tomorrow.</p>
        </div>
      </Shell>
    );
  }
  // The store's window refused, or not known to be taken (takePublicRequest answers false for both): a refusal that
  // has nothing to do with this link's openings, so it is said in words true for both (Claude 5 on #2971).
  if (!(await takePublicRequest(store, "public", now))) return busy();

  let verified: Awaited<ReturnType<typeof readVerified>>;
  try {
    verified = await readVerified(store);
  } catch (error) {
    return unread(error);
  }
  const money = (cents: number | null) => (cents === null ? "—" : formatMoney(cents, verified?.currency ?? store.currency));
  const until = new Date(link.expires * 1000).toISOString().slice(0, 10);

  return (
    <Shell>
      <header>
        <p className="text-sm font-semibold text-ink-soft">{`${store.name} · shared with you`}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.02em] text-ink">{link.label}</h1>
        <p className="mt-2 text-sm text-ink-soft">{`Read-only. This link works until ${longDay(until)}.`}</p>
      </header>
      {!verified ? (
        <div className="card mt-8 p-6 sm:p-8">
          <p className="text-ink">No recorded numbers are available for this link yet. Please try again later.</p>
        </div>
      ) : (
        <div data-numbers-link>
          <section aria-labelledby="numbers-windows" className="card mt-8 overflow-x-auto p-6 sm:p-8" tabIndex={0}>
            <table className="w-full text-left text-sm">
              <caption id="numbers-windows" className="text-left text-lg font-semibold text-ink">The store</caption>
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                  <th scope="col" className="py-2 font-semibold">Last</th>
                  <th scope="col" className="py-2 pl-3 text-right font-semibold">Daily visitors, added up</th>
                  <th scope="col" className="py-2 pl-3 text-right font-semibold">Page views</th>
                  <th scope="col" className="py-2 pl-3 text-right font-semibold">Checkouts</th>
                  {verified.salesRead ? <th scope="col" className="py-2 pl-3 text-right font-semibold">Sales</th> : null}
                  {verified.salesRead && link.money ? <th scope="col" className="py-2 pl-3 text-right font-semibold">Revenue</th> : null}
                </tr>
              </thead>
              <tbody>
                {(["d7", "d30", "d90"] as const).map((w) => {
                  const row = verified.windows[w];
                  return (
                    <tr key={w} className="border-b border-line/60">
                      <th scope="row" className="py-2 pr-3 font-medium text-ink">{w === "d7" ? "7 days" : w === "d30" ? "30 days" : "90 days"}</th>
                      <td className="py-2 pl-3 text-right tabular-nums">{count(row.visitors)}</td>
                      <td className="py-2 pl-3 text-right tabular-nums">{count(row.views)}</td>
                      <td className="py-2 pl-3 text-right tabular-nums">{count(row.checkouts)}</td>
                      {verified.salesRead ? <td className="py-2 pl-3 text-right tabular-nums">{count(row.sales ?? 0)}</td> : null}
                      {verified.salesRead && link.money ? <td className="py-2 pl-3 text-right tabular-nums">{money(row.cents)}</td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {verified.channels.length ? (
            <section aria-labelledby="numbers-channels" className="card mt-6 overflow-x-auto p-6 sm:p-8" tabIndex={0}>
              <table className="w-full text-left text-sm">
                <caption id="numbers-channels" className="text-left text-lg font-semibold text-ink">Where visitors came from, last 30 days</caption>
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                    <th scope="col" className="py-2 font-semibold">Channel</th>
                    <th scope="col" className="py-2 pl-3 text-right font-semibold">Visits</th>
                    {verified.salesRead ? <th scope="col" className="py-2 pl-3 text-right font-semibold">Sales</th> : null}
                    {verified.salesRead && link.money ? <th scope="col" className="py-2 pl-3 text-right font-semibold">Revenue</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {verified.channels.map((c) => (
                    <tr key={c.source} className="border-b border-line/60">
                      <th scope="row" className="py-2 pr-3 font-medium text-ink">{channelName(c.source)}</th>
                      <td className="py-2 pl-3 text-right tabular-nums">{count(c.visits)}</td>
                      {verified.salesRead ? <td className="py-2 pl-3 text-right tabular-nums">{count(c.sales ?? 0)}</td> : null}
                      {verified.salesRead && link.money ? <td className="py-2 pl-3 text-right tabular-nums">{money(c.cents)}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {verified.products.length ? (
            <section aria-labelledby="numbers-products" className="card mt-6 overflow-x-auto p-6 sm:p-8" tabIndex={0}>
              <table className="w-full text-left text-sm">
                <caption id="numbers-products" className="text-left text-lg font-semibold text-ink">Products sold, last 30 days</caption>
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                    <th scope="col" className="py-2 font-semibold">Product</th>
                    <th scope="col" className="py-2 pl-3 text-right font-semibold">Sales</th>
                    {link.money ? <th scope="col" className="py-2 pl-3 text-right font-semibold">Revenue</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {verified.products.map((p) => (
                    <tr key={p.title} className="border-b border-line/60">
                      <th scope="row" className="py-2 pr-3 font-medium text-ink [overflow-wrap:anywhere]">{p.title}</th>
                      <td className="py-2 pl-3 text-right tabular-nums">{count(p.sales)}</td>
                      {link.money ? <td className="py-2 pl-3 text-right tabular-nums">{money(p.cents)}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {verified.countries.length ? (
            <section aria-labelledby="numbers-countries" className="card mt-6 p-6 sm:p-8">
              <h2 id="numbers-countries" className="text-lg font-semibold text-ink">Where buyers are, last 90 days</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {verified.countries.map((c) => (
                  <li key={c.country} className="tag">{`${regions.of(c.country) ?? c.country} ${Math.round(c.share * 100)}%`}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="mt-6 text-sm text-ink-soft">
            {`Counted by Marktmorgen, not typed: visitors and page views on this store's own pages. Visitors are counted once a day, so a person who comes back on another day is counted again, and each day's count is an estimate, within about 1%${verified.salesRead ? `; sales${link.money ? ", revenue" : ""} and buyers' countries from the payments on the store's own Stripe account` : ""}. Read on ${longDay(verified.day)}, once a day. No buyer's name or address is in it.`}
          </p>
        </div>
      )}
    </Shell>
  );
}
