import type { PathCheckoutNotice as Notice } from "@/lib/path-checkout";
export function PathCheckoutNotice({ notice, reviewHref }: { notice: Notice; reviewHref: string | null }) {
  return <aside className="notice mt-6" aria-labelledby="path-checkout-title">
    <h2 id="path-checkout-title" className="font-semibold">{notice.title}</h2>
    <p className="mt-2">{notice.body}</p>
    <p className="mt-2 text-sm text-ink-soft">Path counts your Stripe sales and your live PayPal sales, less refunds.</p>
    {reviewHref ? <a className="mt-3 inline-flex min-h-11 items-center underline" href={reviewHref}>{notice.state === "preview" ? "See what is available" : "Review your store"}</a> : null}
  </aside>;
}
