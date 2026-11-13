import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { feeWords } from "@/lib/fee-words";

export const metadata: Metadata = {
  title: "Not here — Marktmorgen",
  robots: { index: false, follow: true },
};

/**
 * Any address with nothing behind it, the site's or a store's. A store that
 * changed its address is never here: its old address sends people on by
 * itself. So what is missing either never existed or was let go.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="flex-1">
        <section className="container-narrow py-20 sm:py-28">
          <p className="eyebrow">Page not found</p>
          <h1 className="t-h1 mt-4">We couldn&apos;t find this page</h1>
          <p className="t-lead mt-5 max-w-xl text-ink-soft">
            Check the address, especially the name after the @. If someone sent you the link, ask them to confirm it.
            You can also return home or open the Help center to choose your next step.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4">
            <Link href="/" className="btn btn-primary">
              Go to the home page
            </Link>
            <Link href="/demo" className="link-arrow">
              See the live demo store
              <Icon name="arrow-right" size={16} className="arrow" />
            </Link>
          </div>
          <ul className="mt-14 grid gap-4 sm:grid-cols-3">
            {[
              { href: "/help", icon: "info" as const, title: "Help center", body: "Answers about the product as it is today." },
              { href: "/#pricing", icon: "tag" as const, title: "Pricing", body: feeWords().pricingCard },
              { href: "/signin", icon: "store" as const, title: "Your store", body: "Log in with a link sent to your email." },
            ].map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="card card-hover flex h-full flex-col p-5">
                  <Icon name={item.icon} size={20} className="text-violet-deep" />
                  <span className="mt-3 font-semibold text-ink">{item.title}</span>
                  <span className="mt-1 text-sm text-ink-soft">{item.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
