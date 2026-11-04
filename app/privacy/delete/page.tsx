import type { Metadata } from "next";
import { EmailField } from "@/components/email-field";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { storeForHandle } from "@/lib/store";
import { readErasureLink } from "@/lib/erasure-request";
import { readErasureReceipt } from "@/lib/erasure-receipt";
import { ERASE_TOKEN } from "@/lib/erasure-rules";

export const metadata: Metadata = {
  title: "Delete your data — Marktmorgen",
  description: "Delete everything a store on Marktmorgen keeps about you, yourself, by a link emailed to you. No account, nobody to ask.",
  robots: { index: false, follow: true },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const STATUS: Record<string, { tone: "ok" | "error"; text: string }> = {
  sent: { tone: "ok", text: "If that address is known there, a link to delete it is on its way to it. It works for an hour, and nothing is deleted until you press the button on the page it opens." },
  email: { tone: "error", text: "That does not look like an email address. Type the one the store has." },
  limited: { tone: "error", text: "Too many tries for now. Wait an hour and ask again." },
  error: { tone: "error", text: "That could not be done just now. Nothing was deleted. Try again in a moment." },
  expired: { tone: "error", text: "That link has run out or was already used. Ask for a new one below." },
};

/** What is deleted, said to the person; lib/person-data.ts says the same to the creator, line by line. */
const DELETED = [
  "Your place on the store's list, and every link in its emails to you",
  "What the store's team noted about you: its fields, notes and deals",
  "Your answers to its forms, your conversations with its inbox, your reviews and their photos, and your places on its waitlists",
  "Your way through its sequences and workflows, and any email still waiting to reach you",
  "Your progress, quiz results, handed-in work, lesson comments and certificates in its courses, and your private podcast feeds",
  "Your community profile, points, notifications, private messages and what you said in its room",
  "Your Discord account's link to the store, and the roles it gave you",
  "What an import from another platform gave you there, with no payment here behind it: you lose access to it",
];

/** What is kept, and why; the registry's "kept" and "suppression" lines (lib/person-data.ts). */
const KEPT = [
  "A one-way fingerprint of your address, so that store never emails you again and no import puts you back. It cannot be turned back into your address. Only you can lift it, by joining that store's list again yourself.",
  "Your payments, on the creator's own Stripe account. They are the creator's sales and tax records; Marktmorgen does not store them.",
  "The few order records a purchase still needs for a refund or for delivery, with only what they need: PayPal orders, license keys you bought, gifts and group places, pre-orders, packages of calls, your place on a booked group call's guest list until 60 days after it, and when a physical order shipped.",
];

const NOT_YET = "Posts and comments you wrote in a store's community stay, shown without your name. Delete them in the community first if you want them gone, or ask the creator.";

/**
 * Deleting what a store keeps about you, yourself (lib/erasure-request.ts):
 * the address is proved by a link emailed to it, the page that link opens
 * says what goes and what stays, and the button deletes it. The creator is
 * told, not asked.
 */
export default async function DeletePage({ searchParams }: Params) {
  const query = await searchParams;
  const token = typeof query.token === "string" && ERASE_TOKEN.test(query.token) ? query.token : "";
  const statusKey = typeof query.status === "string" ? query.status : "";
  const status = STATUS[statusKey];
  const handle = typeof query.store === "string" ? query.store.slice(0, 60).toLowerCase() : "";
  const store = handle ? await storeForHandle(handle).catch(() => null) : null;
  const link = token ? await readErasureLink(token).catch(() => null) : null;
  const receipt = readErasureReceipt(query.receipt, token);
  const confirmed = receipt?.state === statusKey ? receipt : null;
  const n = confirmed?.count ?? 0;

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="flex-1">
        <section className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-20">
            <p className="eyebrow">Your data</p>
            <h1 className="t-h1 balance mt-4 max-w-3xl">Delete what a store keeps about you</h1>
            <p className="mt-4 max-w-2xl text-lg text-ink-soft">
              From one store, or from every store on Marktmorgen you bought from or joined. No account and nobody to ask: we email you a link, and you press the button.
            </p>
          </div>
        </section>
        <section className="container-page py-12 sm:py-16" data-erase>
          {statusKey === "done" && confirmed ? (
            <div className="max-w-2xl">
              <p className="notice notice-success" role="status">
                {n === 1 ? "Done. You were deleted from 1 store." : `Done. You were deleted from ${n} stores.`} Those stores will not email you again.
              </p>
              <p className="mt-6 text-sm text-ink-soft">
                Their creators keep your payments on their own Stripe accounts, as their sales records. <Link href="/privacy#delete" className="underline underline-offset-4">What is kept, and why</Link>.
              </p>
            </div>
          ) : link ? (
            <div className="max-w-2xl">
              {statusKey === "more" && confirmed ? (
                <p className="notice notice-info mb-6" role="status">
                  {`Deleted from ${n} ${n === 1 ? "store" : "stores"} so far. The rest could not be finished just now. Press the button again in a while; this link works for an hour, and you can ask for a new one at any time.`}
                </p>
              ) : null}
              <h2 className="t-h3 [overflow-wrap:anywhere]">{`Delete ${link.email}`}</h2>
              <p className="mt-2 text-ink-soft">{link.stores.length === 1 ? "From this store:" : "From these stores:"}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-ink">
                {link.stores.map((s) => (
                  <li key={s.sid}>{s.name}</li>
                ))}
              </ul>

              <h3 className="mt-8 text-lg font-semibold">Deleted</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                {DELETED.map((line) => (
                  <li key={line}>{line}.</li>
                ))}
              </ul>
              <h3 className="mt-6 text-lg font-semibold">Kept, and why</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                {KEPT.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <h3 className="mt-6 text-lg font-semibold">Not deleted by this</h3>
              <p className="mt-2 text-sm text-ink-soft">{NOT_YET}</p>
              <p className="mt-6 text-sm text-ink-soft">
                If you still have a course, a membership or a podcast from a store, you can get back into it later by the link it emails you, from its payment on the creator&apos;s Stripe account. This cannot be undone.
              </p>
              <form action="/api/privacy/erase" method="post" className="mt-6">
                <input type="hidden" name="action" value="confirm" />
                <input type="hidden" name="token" value={token} />
                <button type="submit" className="btn btn-danger-solid">
                  {link.stores.length === 1 ? `Delete my data from ${link.stores[0].name}` : `Delete my data from ${link.stores.length} stores`}
                </button>
              </form>
            </div>
          ) : (
            <div className="max-w-xl">
              {(statusKey === "done" || statusKey === "more") && !confirmed ? (
                <p className="notice notice-info mb-6" role="status">
                  This page cannot confirm the deletion result. Ask for a new link below to check which stores still hold your data.
                </p>
              ) : null}
              {token && !status ? (
                <p className="notice notice-error mb-6" role="alert">
                  That link has run out or was already used. Ask for a new one below.
                </p>
              ) : null}
              {status ? (
                <p className={`notice ${status.tone === "ok" ? "notice-success" : "notice-error"} mb-6`} role={status.tone === "ok" ? "status" : "alert"}>
                  {status.text}
                </p>
              ) : null}
              <form action="/api/privacy/erase" method="post" className="card p-6 sm:p-8">
                <input type="hidden" name="action" value="ask" />
                {store ? <input type="hidden" name="store" value={store.handle} /> : null}
                <div aria-hidden="true" className="hidden">
                  <label>
                    Leave this empty
                    <input type="text" name="website" tabIndex={-1} autoComplete="off" />
                  </label>
                </div>
                <label htmlFor="erase-email" className="field-label">
                  Your email address
                </label>
                <EmailField id="erase-email" name="email" required autoComplete="email" className="field mt-2" placeholder="you@example.com" store={false} />
                {store ? (
                  <fieldset className="mt-5">
                    <legend className="field-label">Delete it from</legend>
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
                  We send a link only if a store knows that address, and this page says the same either way. Nothing is deleted until you open the link and press the button.
                </p>
              </form>
              <p className="mt-6 text-sm text-ink-soft">
                {store ? null : "To delete your data from one store only, use the link at the foot of that store's page. "}
                Every store means the stores you bought from since October 11, 2026, and those whose list, waitlist or free product you signed up for yourself since October 17, 2026. Any other store, such as one that brought your address over from another platform, finds you from the link at the foot of its own page. <Link href="/privacy#delete" className="underline underline-offset-4">What is deleted, and what is kept</Link>.
              </p>
            </div>
          )}
        </section>
      </main>
      <SiteFooter variant="slim" />
    </div>
  );
}
