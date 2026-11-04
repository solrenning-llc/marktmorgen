import Link from "next/link";
import type { ContactWords } from "@/lib/buyer-words/contact";
import type { CreatorCard } from "@/lib/creator-card";
import { crmPhone } from "@/lib/crm-rules";

/** A mailto: link to the address as typed: each side percent-encoded, so ? & % # / in it stay part of the address (RFC 6068). */
export function mailtoHref(email: string): string {
  return `mailto:${email.split("@").map(encodeURIComponent).join("@")}`;
}

/**
 * The card as the creator typed it: each way to reach them a link, and the
 * file to save it. As a preview in the studio (`preview`), the same card
 * under a third-level heading, with its links as plain text, so nothing in
 * it leaves the studio or saves a card that is not the one kept yet; its
 * Save contact is drawn dashed and says "(preview)", so it does not look
 * like a button that works. A phone shows as the creator typed it, grouped
 * their way; its link keeps only + and the digits (crmPhone), so every
 * phone dials it. Every link is at least 44px tall (2.5.5).
 */
export function CreatorCardView({ card, handle, storeName, words, preview = false }: { card: CreatorCard; handle: string; storeName: string; words: ContactWords["card"]; preview?: boolean }) {
  const Heading = preview ? "h3" : "h1";
  const id = preview ? "card-preview-name" : "card-name";
  const ways: { label: string; text: string; href: string }[] = [];
  if (card.email) ways.push({ label: words.email, text: card.email, href: mailtoHref(card.email) });
  if (card.phone) ways.push({ label: words.phone, text: card.phone, href: `tel:${crmPhone(card.phone) ?? card.phone.replace(/[^\d+]/g, "")}` });
  if (card.website) ways.push({ label: words.website, text: card.website.replace(/^https:\/\//, "").replace(/\/$/, ""), href: card.website });
  return (
    <article className="st-card p-7 sm:p-10" aria-labelledby={id}>
      <p className="st-muted text-sm">{words.pageTitle}</p>
      <Heading id={id} className="mt-2 font-display text-3xl font-semibold leading-tight [overflow-wrap:anywhere] sm:text-4xl">
        {card.name}
      </Heading>
      {card.title ? <p className="mt-2 text-lg [overflow-wrap:anywhere]">{card.title}</p> : null}
      {card.note ? <p className="st-muted mt-4 [overflow-wrap:anywhere]">{card.note}</p> : null}
      {ways.length ? (
        <dl className="mt-6 space-y-3">
          {ways.map((way) => (
            <div key={way.label}>
              <dt className="st-muted text-sm">{way.label}</dt>
              <dd>
                {preview ? (
                  <span className="inline-flex min-h-11 items-center font-semibold [overflow-wrap:anywhere]">{way.text}</span>
                ) : (
                  <a href={way.href} className="st-footer-link inline-flex min-h-11 items-center font-semibold [overflow-wrap:anywhere]">
                    {way.text}
                  </a>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-8">
        {preview ? (
          <span className="inline-flex min-h-11 items-center gap-2 rounded-full border-2 border-dashed border-current px-5 font-semibold">
            {words.save}
            <span lang="en" className="text-sm font-normal">
              (preview)
            </span>
          </span>
        ) : (
          <a href={`/@${handle}/contact/vcard`} download className="btn st-btn inline-flex min-h-11 items-center" aria-describedby="card-save-hint">
            {words.save}
          </a>
        )}
        <p id={preview ? "card-preview-save-hint" : "card-save-hint"} className="st-muted mt-2 text-sm">
          {words.saveHint}
        </p>
      </div>
      <p className="mt-8">
        {preview ? (
          <span className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">{words.store(storeName)}</span>
        ) : (
          <Link href={`/@${handle}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
            {words.store(storeName)}
          </Link>
        )}
      </p>
    </article>
  );
}
