import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmailField } from "@/components/email-field";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { storeForHandle } from "@/lib/store";
import { COPY_DOOR_OPEN, readCopyLink } from "@/lib/copy-request";
import { COPY_AGAIN_DAYS, COPY_TOKEN } from "@/lib/copy-request-rules";

export const metadata: Metadata = {
  title: "Get a copy of your data — Marktmorgen",
  description: "Get a copy of everything a store on Marktmorgen keeps about you, as a file you can read or take elsewhere, by a link emailed to you.",
  robots: { index: false, follow: true },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const STATUS: Record<string, { tone: "ok" | "error"; text: string }> = {
  sent: { tone: "ok", text: "If that address is known there, a link to your copy is on its way to it. It works for an hour." },
  email: { tone: "error", text: "That does not look like an email address. Type the one the store has." },
  limited: { tone: "error", text: "Too many tries for now. Wait an hour and ask again." },
  error: { tone: "error", text: "That could not be done just now. Try again in a moment." },
  expired: { tone: "error", text: "That link has run out. Ask for a new one below." },
};

const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * A copy of what a store keeps about you, yourself (619 [SZ3],
 * lib/copy-request.ts): the address is proved by a link emailed to it; the
 * page that link opens gives each store's copy as a file. "Not found" until
 * COPY_DOOR_OPEN.
 */
export default async function CopyPage({ searchParams }: Params) {
  if (!COPY_DOOR_OPEN) notFound();
  const query = await searchParams;
  const token = typeof query.token === "string" && COPY_TOKEN.test(query.token) ? query.token : "";
  const statusKey = typeof query.status === "string" ? query.status : "";
  const status = STATUS[statusKey];
  const due = typeof query.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.due) ? query.due : "";
  const handle = typeof query.store === "string" ? query.store.slice(0, 60).toLowerCase() : "";
  const store = handle ? await storeForHandle(handle).catch(() => null) : null;
  const link = token ? await readCopyLink(token).catch(() => null) : null;

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="flex-1">
        <section className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-20">
            <p className="eyebrow">Your data</p>
            <h1 className="t-h1 balance mt-4 max-w-3xl">Get a copy of what a store keeps about you</h1>
            <p className="mt-4 max-w-2xl text-lg text-ink-soft">
              From one store, or from every store on Marktmorgen you bought from or joined. No account and nobody to ask: we email you a link, and you download your copy.
            </p>
          </div>
        </section>
        <section className="container-page py-12 sm:py-16" data-copy>
          {link ? (
            <div className="max-w-2xl">
              {statusKey === "queued" && due ? (
                <p className="notice notice-info mb-6" role="status">
                  {`Your copy is being prepared. It will be ready by ${DAY.format(new Date(`${due}T00:00:00Z`))} at the latest. Ask for a new link then and download it.`}
                </p>
              ) : null}
              <h2 className="t-h3 [overflow-wrap:anywhere]">{`Your data, for ${link.email}`}</h2>
              <p className="mt-2 text-ink-soft">
                {`Each file has everything that store keeps about you: what you wrote and did there, what it noted about you, and what it keeps for your orders. A JSON file is for taking your data to another service; a spreadsheet opens in any spreadsheet app. Asked again within ${COPY_AGAIN_DAYS} days, you get the same copy.`}
              </p>
              <ul className="mt-6 space-y-4">
                {link.stores.map((s) => (
                  <li key={s.sid} className="card p-5">
                    <h3 className="text-lg font-semibold">{s.name}</h3>
                    <div className="mt-3 flex flex-wrap gap-3">
                      {(["json", "csv"] as const).map((format) => (
                        <form key={format} action="/api/privacy/copy" method="post">
                          <input type="hidden" name="action" value="make" />
                          <input type="hidden" name="token" value={token} />
                          <input type="hidden" name="sid" value={s.sid} />
                          <input type="hidden" name="format" value={format} />
                          <button type="submit" className={format === "json" ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}>
                            {format === "json" ? `Download from ${s.name} (JSON)` : `Download from ${s.name} (spreadsheet)`}
                          </button>
                        </form>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-6 text-sm text-ink-soft">
                Your payments are on each creator&apos;s own Stripe account, not kept by Marktmorgen: your receipts and the store can give you them.
              </p>
            </div>
          ) : (
            <div className="max-w-xl">
              {token && !status ? (
                <p className="notice notice-error mb-6" role="alert">
                  That link has run out. Ask for a new one below.
                </p>
              ) : null}
              {status ? (
                <p className={`notice ${status.tone === "ok" ? "notice-success" : "notice-error"} mb-6`} role={status.tone === "ok" ? "status" : "alert"}>
                  {status.text}
                </p>
              ) : null}
              <form action="/api/privacy/copy" method="post" className="card p-6 sm:p-8">
                <input type="hidden" name="action" value="ask" />
                {store ? <input type="hidden" name="store" value={store.handle} /> : null}
                <div aria-hidden="true" className="hidden">
                  <label>
                    Leave this empty
                    <input type="text" name="website" tabIndex={-1} autoComplete="off" />
                  </label>
                </div>
                <label htmlFor="copy-email" className="field-label">
                  Your email address
                </label>
                <EmailField id="copy-email" name="email" required autoComplete="email" className="field mt-2" placeholder="you@example.com" store={false} />
                {store ? (
                  <fieldset className="mt-5">
                    <legend className="field-label">Get it from</legend>
                    <label className="mt-2 flex items-start gap-2 text-sm">
                      <input type="radio" name="scope" value="store" defaultChecked className="mt-1" />
                      <span>{`${store.name} only`}</span>
                    </label>
                    <label className="mt-2 flex items-start gap-2 text-sm">
                      <input type="radio" name="scope" value="all" className="mt-1" />
                      <span>Every store on Marktmorgen I bought from or joined</span>
                    </label>
                  </fieldset>
                ) : (
                  <input type="hidden" name="scope" value="all" />
                )}
                <button type="submit" className="btn btn-primary mt-5">
                  Email me the link
                </button>
                <p className="mt-4 text-sm text-ink-soft">
                  We send a link only if a store knows that address, and this page says the same either way. It is free, and it never counts against the store.
                </p>
              </form>
            </div>
          )}
        </section>
      </main>
      <SiteFooter variant="slim" />
    </div>
  );
}
