import Link from "next/link";
import type { ContactWords } from "@/lib/buyer-words/contact";
import type { CreatorCard } from "@/lib/creator-card";

/** The card as the creator typed it: each way to reach them a link, and the file to save it. */
export function CreatorCardView({ card, handle, storeName, words }: { card: CreatorCard; handle: string; storeName: string; words: ContactWords["card"] }) {
  const ways: { label: string; text: string; href: string }[] = [];
  if (card.email) ways.push({ label: words.email, text: card.email, href: `mailto:${card.email}` });
  if (card.phone) ways.push({ label: words.phone, text: card.phone, href: `tel:${card.phone}` });
  if (card.website) ways.push({ label: words.website, text: card.website.replace(/^https:\/\//, "").replace(/\/$/, ""), href: card.website });
  return (
    <article className="st-card p-7 sm:p-10" aria-labelledby="card-name">
      <p className="st-muted text-sm">{words.pageTitle}</p>
      <h1 id="card-name" className="mt-2 font-display text-3xl font-semibold leading-tight [overflow-wrap:anywhere] sm:text-4xl">
        {card.name}
      </h1>
      {card.title ? <p className="mt-2 text-lg [overflow-wrap:anywhere]">{card.title}</p> : null}
      {card.note ? <p className="st-muted mt-4 [overflow-wrap:anywhere]">{card.note}</p> : null}
      {ways.length ? (
        <dl className="mt-6 space-y-3">
          {ways.map((way) => (
            <div key={way.label}>
              <dt className="st-muted text-sm">{way.label}</dt>
              <dd>
                <a href={way.href} className="st-footer-link inline-flex min-h-11 items-center font-semibold [overflow-wrap:anywhere]">
                  {way.text}
                </a>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-8">
        <a href={`/@${handle}/contact/vcard`} download className="btn st-btn inline-flex min-h-11 items-center" aria-describedby="card-save-hint">
          {words.save}
        </a>
        <p id="card-save-hint" className="st-muted mt-2 text-sm">
          {words.saveHint}
        </p>
      </div>
      <p className="mt-8">
        <Link href={`/@${handle}`} className="st-footer-link text-sm font-semibold">
          {words.store(storeName)}
        </Link>
      </p>
    </article>
  );
}
