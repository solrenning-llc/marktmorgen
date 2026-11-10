import type { Metadata } from "next";
import Link from "next/link";
import { Icon, iconFor } from "@/components/icons";
import { RevealOnScroll } from "@/components/home-parts";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { HelpSearch } from "@/components/help-search";
import { CopyLink } from "@/components/copy-link";
import { HELP_SECTIONS, answerId } from "@/lib/help-content";

export const metadata: Metadata = {
  title: "Help center — Marktmorgen",
  description:
    "Straight answers about the store, the money, the files and what the subscription buys. If an answer is “not yet,” it says not yet.",
};

export default function HelpPage() {
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <RevealOnScroll />
      <SiteNav />

      <main id="content" className="flex-1">
        {/*
          A help centre opens in daylight. Somebody who is here is stuck, and
          a dark, ceremonial banner is the wrong greeting for that; the search
          field is what they need, so it is the largest thing on the screen.
        */}
        <section className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-18">
            <p className="eyebrow">Help center</p>
            <h1 className="t-h1 mt-4">
              How can we <span className="serif font-normal text-violet-deep">help?</span>
            </h1>
            <p className="t-lead mt-5 max-w-2xl text-ink-soft">
              Every answer here is about the product as it is today. Where the answer is &ldquo;not yet,&rdquo; it says
              not yet.
            </p>
            <p className="mt-3 flex items-center gap-2 text-sm text-ink-mute">
              <Icon name="check" size={15} className="text-mint-deep" />
              Checked against the product on September 28, 2026.
            </p>
            <p className="mt-3">
              Bought something from a creator here?{" "}
              <Link href="/help/buyers" className="link font-medium">Help for buyers</Link>
            </p>
            <p className="mt-3">
              Publication checks, buyer reviews and reporting:{" "}
              <Link href="/help/trust-and-safety" className="link font-medium">Trust and safety</Link>
            </p>
            <HelpSearch />
          </div>
        </section>

        <div className="container-page grid gap-10 py-14 sm:py-20 lg:grid-cols-[15rem_1fr] lg:gap-16">
          <nav aria-label="Help sections" className="min-w-0 lg:sticky lg:top-24 lg:self-start">
            <p className="text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-ink-mute">Sections</p>
            <ul className="mt-3 flex gap-2 overflow-x-auto pb-2 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0">
              {HELP_SECTIONS.map((section) => (
                <li key={section.id} className="shrink-0">
                  <a
                    href={`#${section.id}`}
                    className="flex min-h-[44px] items-center gap-2.5 rounded-[var(--r-md)] border border-line bg-white px-3 text-[0.9375rem] font-medium text-ink-soft transition-colors hover:border-line-strong hover:text-ink lg:border-transparent lg:bg-transparent lg:hover:bg-white"
                  >
                    <Icon name={iconFor(section.emoji)} size={18} className="text-violet-deep" />
                    {section.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 space-y-16">
            {HELP_SECTIONS.map((section) => (
              <section key={section.id} id={section.id} data-help-section className="reveal scroll-mt-24">
                <div className="flex items-start gap-4">
                  <span className="icon-tile">
                    <Icon name={iconFor(section.emoji)} size={22} />
                  </span>
                  <div>
                    <h2 className="t-section">{section.title}</h2>
                    <p className="mt-1 text-ink-soft">{section.blurb}</p>
                  </div>
                </div>

                <div className="mt-6 divide-y divide-line overflow-hidden rounded-[var(--r-lg)] border border-line bg-white">
                  {section.items.map((item) => (
                    <details key={item.q} id={answerId(item.q)} data-help-item className="group scroll-mt-24">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-6 px-5 py-5 font-semibold text-ink hover:bg-paper focus-visible:[outline-offset:-3px]! sm:px-6 [&::-webkit-details-marker]:hidden">
                        {item.q}
                        <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line text-ink-soft group-open:border-violet-brand group-open:text-violet-deep">
                          <Icon name="plus" size={16} className="group-open:hidden" />
                          <Icon name="minus" size={16} className="hidden group-open:block" />
                        </span>
                      </summary>
                      <div className="space-y-3 px-5 pb-6 sm:px-6">
                        {item.a.map((paragraph) => (
                          <p key={paragraph} className="leading-relaxed text-ink-soft">
                            {paragraph}
                          </p>
                        ))}
                        <CopyLink id={answerId(item.q)} />
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            ))}

            <section className="reveal card flex flex-col gap-6 p-7 sm:flex-row sm:items-center sm:justify-between sm:p-9">
              <div>
                <h2 className="t-section">Still stuck?</h2>
                <p className="mt-2 max-w-md text-ink-soft">
                  Write to us. A person reads it, and you will get an answer even if the answer is that we have not built
                  that part yet.
                </p>
                <p className="mt-4 text-sm text-ink-mute">
                  Looking for the rules instead?{" "}
                  <Link href="/terms" className="link font-medium">
                    Terms
                  </Link>
                  ,{" "}
                  <Link href="/privacy" className="link font-medium">
                    Privacy
                  </Link>{" "}
                  and{" "}
                  <Link href="/refunds" className="link font-medium">
                    Refunds
                  </Link>
                  .
                </p>
              </div>
              <a href="mailto:support@marktmorgen.com" className="btn btn-primary shrink-0">
                <Icon name="mail" size={18} />
                Email support
              </a>
            </section>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
