import { formatMoney, parseCurrency, readMoney } from "@/lib/money";
import { PREVIEW_WORDS } from "@/lib/store-preview-words";

type Kind = "download" | "course" | "call" | "membership";
export type PreviewDraft = { bios: string[]; products: { title: string; summary: string; kind: Kind; price: string }[]; faq: { q: string; a: string }[] };

const KIND_WORDS: Record<Kind, string> = { download: "A file to download", course: "A course", call: "A call", membership: "A monthly membership" };

/**
 * 488 [IT5] unit 3b: a store preview's draft, read in order under headings (2.4.6, 2.4.10, 1.3.1). A price is shown
 * only where the visitor's own words gave it (parseStoreSetup already dropped any other); the draft is said plainly to
 * be a draft that nothing publishes. No time, no figure, no testimonial. `headingId` names the section for focus.
 */
export function StorePreviewDraft({ draft, currency, headingId }: { draft: PreviewDraft; currency: string; headingId: string }) {
  const code = parseCurrency(currency);
  const price = (raw: string) => {
    const amount = raw ? readMoney(raw, code) : null;
    return amount === null ? PREVIEW_WORDS.noPrice : formatMoney(amount, code);
  };
  const empty = !draft.bios.length && !draft.products.length && !draft.faq.length;
  return (
    <section aria-labelledby={headingId} className="pv-draft" data-store-preview-draft>
      <h3 id={headingId} tabIndex={-1}>Your store draft</h3>
      <p>{PREVIEW_WORDS.notPublished}</p>
      {empty ? <p>{PREVIEW_WORDS.empty}</p> : null}
      {draft.bios.length ? (
        <>
          <h4>Lines for under your name</h4>
          <ul>{draft.bios.map((bio) => <li key={bio}>{bio}</li>)}</ul>
        </>
      ) : null}
      {draft.products.length ? (
        <>
          <h4>Products</h4>
          <ul>
            {draft.products.map((product) => (
              <li key={product.title}>
                <strong>{product.title}</strong>
                <span>{` (${KIND_WORDS[product.kind] ?? KIND_WORDS.download}). `}</span>
                {product.summary ? <span>{`${product.summary} `}</span> : null}
                <span>{`Price: ${price(product.price)}`}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {draft.faq.length ? (
        <>
          <h4>Questions buyers ask</h4>
          <dl>
            {draft.faq.map((item) => (
              <div key={item.q}>
                <dt>{item.q}</dt>
                <dd>{item.a}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
    </section>
  );
}
