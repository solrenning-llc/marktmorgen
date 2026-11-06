import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { listBroadcastsStrict } from "@/lib/broadcasts";
import { isOwnLink } from "@/lib/mail-links";
import { storeBase } from "@/lib/purchase-email";
import { SENT_LINKS_MAX, SENT_LINK_CHANGES_MAX, SENT_LINK_KEEP_DAYS, linksOf } from "@/lib/sent-link-rules";
import { readSentLinksMany } from "@/lib/sent-links";
import { type SentEmailLinks, SentLinksEditor } from "@/components/sent-links-editor";

export const metadata: Metadata = {
  title: "Change where a link goes — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** The most recent sent emails shown, newest first. */
const SHOWN = 10;

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/**
 * Change where a link in a sent email goes (124 [F2-EDIT-SENT-LINKS],
 * lib/sent-links.ts): the store's most recent one-off emails that went out,
 * each link with where it was written to go and where it goes now. For
 * whoever may send ("send"): what changes here reaches the list.
 */
export default async function StudioSentLinksPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "send");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const all = await listBroadcastsStrict(store.listId).catch(() => null);
  const sent = (all ?? []).filter((b) => b.sent > 0);
  const changeable = sent.filter((b) => b.links === true && linksOf(b.body).length > 0).slice(0, SHOWN);
  const before = sent.filter((b) => b.links !== true).length;
  const kept = changeable.length ? await readSentLinksMany(changeable.map((b) => b.id)).catch(() => new Map()) : new Map();
  const emails: SentEmailLinks[] = changeable.map((b) => {
    const links = linksOf(b.body);
    return {
      id: b.id,
      subject: b.subject,
      sentOn: day(b.finishedAt || b.sendAt),
      links,
      own: links.map((href) => { try { return isOwnLink(new URL(href), store); } catch { return false; } }),
      changes: kept.has(b.id) ? (kept.get(b.id)?.changes ?? []) : null,
    };
  });
  const emailPage = studioPath(store, "", "email");
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: emailPage, label: "Back to email", short: "Email" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page max-w-3xl pb-20 pt-10 sm:pt-14">
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap gap-2 text-ink-soft">
              <li><Link href={studioPath(store)} className="underline">Studio</Link> <span aria-hidden="true">/</span></li>
              <li><Link href={emailPage} className="underline">Email</Link> <span aria-hidden="true">/</span></li>
              <li aria-current="page">Change where a link goes</li>
            </ol>
          </nav>
          <h1 className="t-h2 mt-3">Change where a link goes</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Sent an email with a wrong link, or one that stopped working? Send that link somewhere else here. Everybody who got the email goes to the new address when they open the link, even people who already opened it.
          </p>
          <h2 className="mt-8 text-lg font-semibold">What you can change</h2>
          <ul className="mt-2 max-w-2xl list-disc space-y-1 pl-6 text-ink-soft">
            <li>Links in one-off emails sent from November 6, 2026. The first {SENT_LINKS_MAX} links of each email.</li>
            <li>A link to your store can go to another page of your store. Any other link can go to another page on the same site, or to a page of your store.</li>
            <li>Up to {SENT_LINK_CHANGES_MAX} changes for each email, sending a link back included. Each change is listed. Until they are all used, you can send a link back to where it first went.</li>
            <li>Changes last {SENT_LINK_KEEP_DAYS} days from the first one. After that, the link goes where the email first sent it.</li>
            <li>A mail app that shows only plain text shows the address as written, which goes straight there.</li>
            <li>Nothing about who opened a link, or when, is kept for the email or shown to you. Each opening counts as one request of your store, like a page view.</li>
          </ul>
          {before > 0 ? (
            <p className="mt-6 max-w-2xl">
              {before === 1 ? "1 email was" : `${before} emails were`} sent before links could be changed. Their links go straight to the addresses written in them, so they cannot be changed.
            </p>
          ) : null}
          {all === null ? (
            <p className="mt-8">Your sent emails could not be read just now. Reload the page to try again.</p>
          ) : emails.length === 0 ? (
            <p className="mt-8">No sent email with links you can change yet. Links in the next one-off email you send can be changed here once it goes out.</p>
          ) : (
            <div className="mt-8">
              <SentLinksEditor emails={emails} home={storeBase(store)} />
            </div>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
