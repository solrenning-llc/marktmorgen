import type { EmailPreview } from "@/lib/purchase-email-preview";

/**
 * The email a buyer gets after paying for one product, as an example the
 * creator can read in the studio before any sale (lib/purchase-email-preview.ts,
 * queue item 380 [TB6], unit 1). Drawn on the server from what the page has
 * already read; nothing in it can be pressed, and nothing is sent.
 */
export function PurchaseEmailPreview({ preview, productTitle }: { preview: EmailPreview; productTitle: string }) {
  return (
    <section id="purchase-email" aria-labelledby="purchase-email-title" className="card mt-6 scroll-mt-32 p-6 sm:p-8">
      <h2 id="purchase-email-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        The email buyers get after paying
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">
        {`An example for ${productTitle}, written the same way as the real email. Nothing is sent. The buyer, the order reference, and any license key or shipping address are made up. The price is your listed price.`}
      </p>
      <dl className="mt-5 grid max-w-[80ch] gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="font-semibold text-ink">From</dt>
        <dd className="text-ink-soft [overflow-wrap:anywhere]">{preview.from}</dd>
        <dt className="font-semibold text-ink">To</dt>
        <dd className="text-ink-soft [overflow-wrap:anywhere]">{`${preview.to} (an example buyer)`}</dd>
        <dt className="font-semibold text-ink">Subject</dt>
        <dd lang={preview.lang} className="text-ink [overflow-wrap:anywhere]">{preview.subject}</dd>
      </dl>
      <pre
        lang={preview.lang}
        className="mt-4 max-w-[80ch] whitespace-pre-wrap rounded-[12px] border border-line bg-paper p-4 font-sans text-sm leading-relaxed text-ink [overflow-wrap:anywhere]"
      >
        {preview.text}
      </pre>
      <p className="mt-4 max-w-2xl text-xs leading-relaxed text-ink-soft">
        Some lines change with each order, so only real emails have them: what a buyer added at checkout, what is inside a bundle, a buyer&apos;s yes to get access right away, a next product your Store assistant suggests, the price after a discount, a free trial or an introductory price, and a payment plan or yearly billing the buyer chose. Pre-orders, gifts and purchases for a team get emails of their own.
      </p>
    </section>
  );
}
