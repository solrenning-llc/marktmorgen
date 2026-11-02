import type { Metadata } from "next";
import { EmailField } from "@/components/email-field";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { Icon } from "@/components/icons";
import { type Store, storeForId } from "@/lib/store";
import { photoUrl } from "@/lib/photo-limits";
import { storeBase } from "@/lib/purchase-email";
import { canRecover, ordersLinkFor } from "@/lib/buyer-orders";
import { libraryOwner, storesBoughtFrom } from "@/lib/buyer-library";

export const metadata: Metadata = {
  title: "Your library — Marktmorgen",
  description: "Everything you bought from creators on Marktmorgen, in one place: courses, files, memberships and calls. No account, no password.",
  robots: { index: false, follow: true },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const STATUS: Record<string, { tone: "ok" | "error"; text: string }> = {
  sent: { tone: "ok", text: "If that address bought anything here, a link to your library is on its way to it. Open it on this device or any other; it works for 24 hours." },
  email: { tone: "error", text: "That does not look like an email address. Type the one you paid with." },
  limited: { tone: "error", text: "Too many tries for now. Wait an hour and ask again." },
  error: { tone: "error", text: "The email could not be sent just now. Try again in a moment." },
};

/**
 * A buyer's library (lib/buyer-library.ts): every store an address bought
 * from, each opening its own list of purchases. Signed in by a link emailed
 * to the address, as each store's own list is.
 */
export default async function LibraryPage({ searchParams }: Params) {
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token.slice(0, 80) : "";
  const status = typeof query.status === "string" ? STATUS[query.status] : undefined;
  const email = token ? await libraryOwner(token) : null;

  // Each store's own list, opened by a link made for this address now (lib/buyer-orders.ts).
  const shelves: { store: Store; open: string | null }[] = [];
  if (email) {
    const stores = (await Promise.all((await storesBoughtFrom(email)).map((sid) => storeForId(sid).catch(() => null)))).filter((s): s is Store => s !== null);
    for (const store of stores) {
      const base = storeBase(store);
      shelves.push({ store, open: canRecover(store) ? await ordersLinkFor(store, email, base).catch(() => null) : null });
    }
    shelves.sort((a, b) => a.store.name.localeCompare(b.store.name, "en"));
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <header>
        <SiteNav />
      </header>
      <main id="content" className="flex-1">
        <section className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-20">
            <p className="eyebrow">Your library</p>
            <h1 className="t-h1 balance mt-4 max-w-3xl">Everything you bought here, in one place</h1>
            <p className="mt-4 max-w-2xl text-lg text-ink-soft">
              Courses, files, memberships and calls from every creator on Marktmorgen you bought from. No account and no password: we email you a link.
            </p>
          </div>
        </section>
        <section className="container-page py-12 sm:py-16" data-library>
          {email ? (
            <>
              <p className="text-ink-soft">{`For ${email}. This page works for 24 hours from the email.`}</p>
              <p className="mt-2 text-sm text-ink-soft">
                What you bought from a store is here while that store is open on Marktmorgen. A store whose creator closes it takes what was bought from it along, so download the files you want to keep. <Link href="/terms#closing" className="underline underline-offset-4">How a store closes</Link>.
              </p>
              {shelves.length ? (
                <ul className="mt-6 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {shelves.map(({ store, open }) => (
                    <li key={store.sid} className="card flex min-w-0 flex-col p-5" data-library-store={store.handle}>
                      <div className="flex items-center gap-3">
                        {store.photoId ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={photoUrl(store.photoId)} alt="" width={48} height={48} className="h-12 w-12 rounded-full object-cover" />
                        ) : (
                          <span aria-hidden="true" className="grid h-12 w-12 place-items-center rounded-full bg-lilac font-bold text-violet-deep">
                            {store.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <p className="min-w-0 truncate text-lg font-semibold">{store.name}</p>
                      </div>
                      {!open ? (
                        <p role="status" className="mt-4 text-sm text-ink-soft">
                          Your purchases could not be opened just now. Try again in a moment, or visit the store for help.
                        </p>
                      ) : null}
                      <div className="mt-5 flex min-w-0 flex-wrap gap-3">
                        {open ? (
                          <a href={open} className="btn btn-primary btn-sm btn-wrap min-w-0">
                            <Icon name="download" size={16} className="shrink-0" />
                            <span className="min-w-0 [overflow-wrap:anywhere]">Open your purchases</span>
                          </a>
                        ) : null}
                        <a href={storeBase(store)} className="btn btn-secondary btn-sm btn-wrap min-w-0">
                          <span className="min-w-0 [overflow-wrap:anywhere]">Visit the store</span>
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-6 text-ink">Nothing is listed for this address any more.</p>
              )}
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
              <form action="/api/library" method="post" className="card p-6 sm:p-8">
                <div aria-hidden="true" className="hidden">
                  <label>
                    Leave this empty
                    <input type="text" name="website" tabIndex={-1} autoComplete="off" />
                  </label>
                </div>
                <label htmlFor="library-email" className="field-label">
                  The email address you paid with
                </label>
                <EmailField id="library-email" name="email" required autoComplete="email" className="field mt-2" placeholder="you@example.com" store={false} />
                <button type="submit" className="btn btn-primary mt-4">
                  Email me my library
                </button>
                <p className="mt-4 text-sm text-ink-soft">
                  We send a link only if that address bought something here, and the page says the same either way. Each creator&apos;s own list still opens from their store too.
                </p>
              </form>
              <p className="mt-6 text-sm text-ink-soft">
                Purchases count from October 11, 2026, when the library opened. For anything bought before, open the store and use its own link to your purchases. <Link prefetch={false} href="/privacy#library" className="underline underline-offset-4">What is kept for this</Link>.
              </p>
            </div>
          )}
        </section>
      </main>
      <SiteFooter variant="slim" />
    </div>
  );
}
