import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { BUYER_HELP, BUYER_HELP_CHECKED } from "@/lib/buyer-help";

export const metadata: Metadata = {
  title: "Help for buyers — Marktmorgen",
  description: "You bought from a creator on Marktmorgen. How to get back to it, find your receipt, cancel a membership, ask for a refund and reach the creator.",
};

/**
 * Help for buyers (630 [HN6](34), lib/buyer-help.ts). Every answer is open,
 * not folded away: a buyer who is here usually has one question and should
 * see it without a click.
 */
export default function BuyerHelpPage() {
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="flex-1">
        <section className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-18">
            <nav aria-label="Breadcrumb" className="text-sm">
              <ol className="flex flex-wrap gap-2 text-ink-soft">
                <li>
                  <Link href="/help" className="link">Help center</Link>
                  <span aria-hidden="true"> /</span>
                </li>
                <li aria-current="page">Help for buyers</li>
              </ol>
            </nav>
            <h1 className="t-h1 mt-4">You bought from a creator here</h1>
            <p className="t-lead mt-5 max-w-2xl text-ink-soft">
              Each store on Marktmorgen belongs to its creator. You paid them directly, and they answer for what they sell. Here is how to get back to
              what you bought and how to reach them.
            </p>
            <p className="mt-3 flex items-center gap-2 text-sm text-ink-mute">
              <Icon name="check" size={15} className="text-mint-deep" />
              Checked against the product on {BUYER_HELP_CHECKED}.
            </p>
            <nav aria-label="Questions on this page" className="mt-6">
              <ul className="flex flex-wrap gap-2">
                {BUYER_HELP.map((item) => (
                  <li key={item.id}>
                    <a href={`#${item.id}`} className="inline-flex min-h-11 items-center rounded-[var(--r-md)] border border-line bg-white px-3 font-medium text-ink-soft hover:text-ink">
                      {item.q}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </section>

        <div className="container-page max-w-3xl space-y-12 py-14 sm:py-20">
          {BUYER_HELP.map((item) => (
            <section key={item.id} id={item.id} aria-labelledby={`${item.id}-q`} className="scroll-mt-24">
              <h2 id={`${item.id}-q`} className="t-section">{item.q}</h2>
              <div className="mt-3 space-y-3">
                {item.a.map((paragraph) => (
                  <p key={paragraph} className="max-w-[70ch] leading-relaxed text-ink-soft">{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
          <p className="text-ink-soft">
            Are you a creator? Your questions are in the{" "}
            <Link href="/help" className="link font-medium">Help center</Link>.
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
