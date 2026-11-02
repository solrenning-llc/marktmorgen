import type { Metadata } from "next";
import { EmailField } from "@/components/email-field";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { type Store, storeForId } from "@/lib/store";
import { photoUrl } from "@/lib/photo-limits";
import { storeBase } from "@/lib/purchase-email";
import { type Affiliate, affiliateByEmail, affiliateLink, affiliatesOn, signInLinkFor } from "@/lib/affiliates";
import { hubOwner, storesPromoted } from "@/lib/affiliate-hub";
import { payoutPromise } from "@/lib/affiliate-setting";
import { SITE_URL } from "@/lib/site-url";

export const metadata: Metadata = {
  title: "Your affiliate programs — Marktmorgen",
  description: "Every creator you promote on Marktmorgen, in one place: your links, where each application stands, and each store's own page with your numbers. No account, no password.",
  robots: { index: false, follow: true },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const STATUS: Record<string, { tone: "ok" | "error"; text: string }> = {
  sent: { tone: "ok", text: "If that address is an affiliate of any store here, a link to your page is on its way to it. Open it on this device or any other; it works for 24 hours." },
  email: { tone: "error", text: "That does not look like an email address. Type the one you joined with." },
  limited: { tone: "error", text: "Too many tries for now. Wait an hour and ask again." },
  error: { tone: "error", text: "The email could not be sent just now. Try again in a moment." },
};

/** Where an affiliate stands with a store, in the words the page uses. */
const STANDING: Record<Affiliate["status"], string> = {
  approved: "Approved",
  pending: "Waiting for the creator",
  declined: "Not accepted",
  removed: "Ended by the creator",
};

type Row = { store: Store; affiliate: Affiliate; link: string | null; open: string | null; on: boolean };

/**
 * An affiliate's page across every store (lib/affiliate-hub.ts): each store
 * they joined, with their link and where they stand, each opening the
 * store's own page with their numbers. Signed in by a link emailed to the
 * address, as each store's own page is.
 */
export default async function AffiliateHubPage({ searchParams }: Params) {
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token.slice(0, 80) : "";
  const status = typeof query.status === "string" ? STATUS[query.status] : undefined;
  const email = token ? await hubOwner(token) : null;

  const rows: Row[] = [];
  if (email) {
    const origin = SITE_URL;
    const stores = (await Promise.all((await storesPromoted(email)).map((sid) => storeForId(sid).catch(() => null)))).filter((s): s is Store => s !== null);
    for (const store of stores) {
      const affiliate = await affiliateByEmail(store, email).catch(() => null);
      if (!affiliate) continue;
      const on = affiliatesOn(store);
      rows.push({
        store,
        affiliate,
        on,
        link: on && affiliate.status === "approved" ? affiliateLink(store, affiliate.code) : null,
        open: on ? await signInLinkFor(store, email, origin).catch(() => null) : null,
      });
    }
    // The programs they can work with first, then the rest, each by name.
    const rank = (row: Row) => (row.on && row.affiliate.status === "approved" ? 0 : row.on && row.affiliate.status === "pending" ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b) || a.store.name.localeCompare(b.store.name, "en"));
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="flex-1">
        <section className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-20">
            <p className="eyebrow">Your affiliate programs</p>
            <h1 className="t-h1 balance mt-4 max-w-3xl">Every creator you promote, in one place</h1>
            <p className="mt-4 max-w-2xl text-lg text-ink-soft">
              Your links, where each application stands, and each store&apos;s own page with your clicks, sales and what you were paid. No account and no
              password: we email you a link.
            </p>
          </div>
        </section>
        <section className="container-page py-12 sm:py-16" data-affiliate-hub>
          {email ? (
            <>
              <p className="text-ink-soft">{`For ${email}. This page works for 24 hours from the email.`}</p>
              {rows.length ? (
                <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {rows.map(({ store, affiliate, link, open, on }) => (
                    <li key={store.sid} className="card flex flex-col p-5" data-hub-store={store.handle}>
                      <div className="flex items-center gap-3">
                        {store.photoId ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={photoUrl(store.photoId)} alt="" width={48} height={48} className="h-12 w-12 rounded-full object-cover" />
                        ) : (
                          <span aria-hidden="true" className="grid h-12 w-12 place-items-center rounded-full bg-lilac font-bold text-violet-deep">
                            {store.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-lg font-semibold">{store.name}</p>
                          <p className="text-sm text-ink-soft">{on ? STANDING[affiliate.status] : "Program switched off by the creator"}</p>
                        </div>
                      </div>
                      {link ? (
                        <div className="mt-4">
                          <p className="text-sm font-semibold text-ink">Your link</p>
                          <p className="mt-1 break-all rounded-lg bg-sand/70 px-3 py-2 font-mono text-sm" data-hub-link>
                            {link}
                          </p>
                        </div>
                      ) : null}
                      {on ? <p className="mt-4 text-sm text-ink-soft">{payoutPromise(store.affiliates, store.name)}</p> : null}
                      {on && !open ? (
                        <p role="status" className="mt-4 text-sm text-ink-soft">
                          Your numbers could not be opened just now. Try again in a moment, or visit the store for help.
                        </p>
                      ) : null}
                      <div className="mt-5 flex flex-wrap gap-3">
                        {open ? (
                          <a href={open} className="btn btn-primary btn-sm">
                            Open your numbers
                          </a>
                        ) : null}
                        <a href={storeBase(store)} className="btn btn-secondary btn-sm">
                          Visit the store
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-6 text-ink">Nothing is listed for this address any more.</p>
              )}
              <div className="card mt-10 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
                <div>
                  <h2 className="text-lg font-semibold text-ink">Looking for more to promote?</h2>
                  <p className="mt-1 text-ink-soft">
                    The directory lists the programs creators here chose to show, with every term and what one sale of each product earns. A program you join
                    there appears on this page.
                  </p>
                </div>
                <Link href="/affiliate-programs" className="btn btn-secondary">
                  Browse programs
                </Link>
              </div>
              <p className="mt-6 text-sm text-ink-soft">
                Each creator pays their own affiliates, on the day their program states; Marktmorgen never holds or pays out this money.
              </p>
            </>
          ) : (
            <div className="max-w-xl">
              {token ? (
                <p className="notice notice-error mb-6" role="alert">
                  That link has expired or was already replaced. Ask for a new one below.
                </p>
              ) : null}
              {status ? (
                <p className={`notice ${status.tone === "ok" ? "notice-success" : "notice-error"} mb-6`} role={status.tone === "ok" ? "status" : "alert"}>
                  {status.text}
                </p>
              ) : null}
              <form action="/api/affiliate" method="post" className="card p-6 sm:p-8">
                <div aria-hidden="true" className="hidden">
                  <label>
                    Leave this empty
                    <input type="text" name="website" tabIndex={-1} autoComplete="off" />
                  </label>
                </div>
                <label htmlFor="hub-email" className="field-label">
                  The email address you joined with
                </label>
                <EmailField id="hub-email" name="email" required autoComplete="email" className="field mt-2" placeholder="you@example.com" store={false} />
                <button type="submit" className="btn btn-primary mt-4">
                  Email me my programs
                </button>
                <p className="mt-4 text-sm text-ink-soft">
                  We send a link only if that address is an affiliate of a store here, and the page says the same either way. Each store&apos;s own page still
                  opens from that store too.
                </p>
              </form>
              <p className="mt-6 text-sm text-ink-soft">
                A program you joined before October 13, 2026 appears once you next sign in to that store&apos;s affiliate page.{" "}
                <Link href="/privacy#affiliate-page" className="underline underline-offset-4">
                  What is kept for this
                </Link>
                . Not an affiliate yet?{" "}
                <Link href="/affiliate-programs" className="underline underline-offset-4">
                  Browse the programs
                </Link>
                .
              </p>
            </div>
          )}
        </section>
      </main>
      <SiteFooter variant="slim" />
    </div>
  );
}
