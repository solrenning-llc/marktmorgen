import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { TakedownButton } from "@/components/takedown-actions";
import { openReport, reportedProduct, unsentNotices } from "@/lib/takedown";
import { NewTab } from "@/components/new-tab";

export const metadata: Metadata = { title: "A notice — Marktmorgen", robots: { index: false, follow: false } };

type Params = { params: Promise<{ token: string }> };

/**
 * One notice, opened from the email it was sent in (lib/takedown.ts): what it
 * says, and the reported store's content with a button to take each piece
 * down. Only that store can be touched from here, and only for 60 days.
 */
export default async function TakedownPage({ params }: Params) {
  const { token } = await params;
  const opened = await openReport(token);
  if (!opened) notFound();
  const { report, store } = opened;
  // The product the address points at, however far down the list, and the first page of the rest.
  const pointed = store ? await reportedProduct(report, store) : null;
  const products = store ? [...(pointed && !pointed.hidden ? [pointed] : []), ...store.catalog.head.filter((p) => !p.hidden && p.id !== pointed?.id)] : [];
  // Taken down, but the email to the creator did not go out (Claude 6 on #3087): listed whenever the page is opened,
  // so the notice the law asks for can still be sent after the page that failed was closed.
  const owed = store ? await unsentNotices(report) : [];
  return (
    <LegalPage title={report.kind === "copyright" ? "Copyright notice" : "Notice of illegal content"} eyebrow={`Notice ${report.id}`} effective={null} legalNav={false} lastUpdated={new Date(report.at).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC"}>
      <LegalSection title="What it says">
        <p><strong className="text-black">Where:</strong> <a href={report.url} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2 [overflow-wrap:anywhere]">{report.url}<NewTab /></a></p>
        <p className="whitespace-pre-line [overflow-wrap:anywhere]"><strong className="text-black">{report.kind === "copyright" ? "The work:" : "Why:"}</strong> {report.work}</p>
        {report.original ? <p className="[overflow-wrap:anywhere]"><strong className="text-black">Original:</strong> {report.original}</p> : null}
        <p><strong className="text-black">From:</strong> {report.name} &lt;{report.email}&gt;{report.contact ? `, ${report.contact}` : ""}</p>
        <p><strong className="text-black">Signed:</strong> {report.signature}, with both statements confirmed.</p>
      </LegalSection>
      {store ? (
        <LegalSection title={`The store @${store.handle}`}>
          <p>
            {store.suspended ? "Its pages and sales are switched off. " : ""}
            {store.strikes.length
              ? `${store.strikes.length} piece${store.strikes.length === 1 ? "" : "s"} of content taken down before, the latest ${new Date(store.strikes[0].at).toLocaleDateString("en-US", { dateStyle: "long" })}: ${store.strikes.slice(0, 3).map((s) => s.what).join("; ")}.`
              : "Nothing taken down from it before."}
          </p>
          {owed.length ? (
            <>
              <p className="font-semibold text-black">Taken down, but the creator was not told yet</p>
              <ul className="space-y-3">
                {owed.map((o) => (
                  <li key={JSON.stringify(o.action)} className="flex flex-wrap items-center justify-between gap-3">
                    <span className="[overflow-wrap:anywhere]">{o.what}</span>
                    <TakedownButton token={token} action={o.action} label="Send the email to the creator" />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {store.links.filter((l) => !l.header).length ? (
            <>
              <p className="font-semibold text-black">Its links</p>
              <ul className="space-y-3">
                {store.links.filter((l) => !l.header).map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="[overflow-wrap:anywhere]">{l.title} — {l.url}</span>
                    <TakedownButton token={token} action={{ type: "link", id: l.id }} label="Remove this link" />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {products.length ? (
            <>
              <p className="font-semibold text-black">Its products</p>
              <ul className="space-y-3">
                {products.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{p.title}{p.id === pointed?.id ? " (the page the notice names)" : ""}</span>
                    <TakedownButton token={token} action={{ type: "product", id: p.id }} label="Unpublish this product" />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {store.kit.on ? (
            <p className="flex flex-wrap items-center justify-between gap-2">
              <span>Its media kit</span>
              <TakedownButton token={token} action={{ type: "kit" }} label="Unpublish the media kit" />
            </p>
          ) : null}
          <p className="flex flex-wrap items-center justify-between gap-2">
            <span>The whole store, for a repeat infringer or a store that is itself the problem</span>
            {store.suspended ? (
              <TakedownButton token={token} action={{ type: "store", on: false }} label="Switch the store back on" />
            ) : (
              <TakedownButton token={token} action={{ type: "store", on: true }} label="Switch off its pages and sales" danger />
            )}
          </p>
        </LegalSection>
      ) : (
        <LegalSection title="The store">
          <p>The address does not name a store on marktmorgen.com, or the store no longer exists. Check it by hand and answer the sender by replying to the email.</p>
        </LegalSection>
      )}
    </LegalPage>
  );
}
