import Link from "next/link";
import { Logo } from "@/components/logo";
import { MorningLogo } from "@/components/morning-header";
import { feeWords } from "@/lib/fee-words";

const SUPPORT_EMAIL = "support@marktmorgen.com";
const SUPPORT = `mailto:${SUPPORT_EMAIL}`;

type FooterLink = { label: string; href: string };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Every feature", href: "/platform" },
      { label: "Grow your sales", href: "/grow-sales" },
      { label: "Live demo store", href: "/demo" },
      { label: "Courses", href: "/platform/courses" },
      { label: "Memberships", href: "/platform/memberships" },
      { label: "Paid calls", href: "/platform/calls" },
    ],
  },
  {
    title: "Creators",
    links: [
      { label: "Coaches", href: "/for/coaches" },
      { label: "Cooks", href: "/for/cooks" },
      { label: "Fitness", href: "/for/fitness" },
      { label: "Designers", href: "/for/designers" },
      { label: "Tell us what you sell", href: "/creators" },
    ],
  },
  {
    title: "Compare",
    links: [
      { label: "All comparisons", href: "/proof/comparisons" },
      { label: "Marktmorgen and Stan", href: "/proof/compare" },
      { label: "Feature by feature", href: "/proof/everything" },
      { label: "Marktmorgen and Gumroad", href: "/proof/gumroad" },
      { label: "Marktmorgen and Beacons", href: "/proof/beacons" },
      { label: "Speed test", href: "/proof/speed" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Help center", href: "/help" },
      { label: "Your library", href: "/library" },
      { label: "Affiliate programs", href: "/affiliate-programs" },
      { label: "Developers", href: "/developers" },
      { label: "Blog", href: "/blog" },
      { label: "Questions", href: "/proof/questions" },
      { label: "What we never do", href: "/proof/promises" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Our mission", href: "/mission" },
    ],
  },
  {
    // The same last column, with the same five links, on every Marktmorgen product (the home page's short footer
    // keeps their jobs elsewhere: log in and pricing in its header, support, refunds and cancelling below).
    title: "Account & billing",
    links: [
      { label: "Log in", href: "/signin?to=login" },
      { label: "Pricing", href: "/pricing" },
      // Section 3 of the Refund Policy is the one that says how to cancel.
      { label: "Cancel subscription", href: "/refunds#cancel" },
      { label: "Request a refund", href: "/refunds" },
      { label: "Contact support", href: SUPPORT },
    ],
  },
];

/**
 * The home page's own column (498 [ME3]): the home page is held to 30 links
 * (owner, 28 October 2026), so its footer keeps only what someone landing
 * there may be looking for, beside the legal links. Every other link stays
 * in the footer of every other page, one tap away.
 */
const HOME_COLUMN: { title: string; links: FooterLink[] } = {
  title: "More from Marktmorgen",
  links: [
    { label: "Every feature", href: "/platform" },
    { label: "All comparisons", href: "/proof/comparisons" },
    { label: "Help center", href: "/help" },
    { label: "Your library", href: "/library" },
    { label: "Cancel subscription", href: "/refunds#cancel" },
  ],
};

const LEGAL_LINKS: FooterLink[] = [
  { label: "Terms of Service", href: "/terms" },
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Refund Policy", href: "/refunds" },
  { label: "Copyright", href: "/copyright" },
  { label: "Report content", href: "/report" },
  { label: "Accessibility", href: "/accessibility" },
];

function FooterAnchor({ link, className }: { link: FooterLink; className: string }) {
  return link.href.startsWith("mailto:") ? (
    <a href={link.href} className={className}>
      {link.label}
    </a>
  ) : (
    <Link prefetch={false} href={link.href} className={className}>
      {link.label}
    </Link>
  );
}

/**
 * The site footer. `full` on marketing and content pages; `slim` on pages
 * where the person is in the middle of a task (logging in), so nothing pulls
 * them away from it; `home` on the home page, with one short column (HOME_COLUMN).
 */
export function SiteFooter({ variant = "full", morning = false }: { variant?: "full" | "slim" | "home"; morning?: boolean }) {
  const year = new Date().getFullYear();

  if (variant === "slim") {
    return (
      <footer className="border-t border-line bg-paper text-ink-mute">
        <div className="container-page flex flex-col gap-2 py-5 text-[0.8125rem] leading-relaxed sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <p>{`© ${year} Marktmorgen.`}</p>
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {[...LEGAL_LINKS, { label: "Support", href: SUPPORT }].map((link) => (
              <li key={link.label}>
                <FooterAnchor
                  link={link}
                  className="inline-flex min-h-11 items-center transition-colors hover:text-ink"
                />
              </li>
            ))}
          </ul>
        </div>
      </footer>
    );
  }

  return (
    <footer className="surface-night on-dark overflow-hidden">
      <div className="container-page grid gap-12 py-16 lg:grid-cols-[15rem_1fr] lg:gap-16 lg:py-20">
        <div className="max-w-xs">
          {/* On the pages in the morning look (VS1, app/home.css .hm-foot), their own light mark. */}
          {morning ? <MorningLogo /> : (
            <Link prefetch={false} href="/" className="inline-flex min-h-11 items-center rounded-[10px]" aria-label="Marktmorgen, home">
              <Logo tone="light" />
            </Link>
          )}
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-white/70">
            A store page for creators, built in public. Your buyers pay into your
            own Stripe account.
          </p>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-white/70">
            Written support, in English, from{" "}
            <a href={SUPPORT} className="font-medium text-white underline underline-offset-4">
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
          {/* The home page starts a store from its own address fields, at the top and the end. */}
          {variant === "home" ? null : (
            <Link prefetch={false} href="/signin" className="btn btn-light btn-sm mt-6">
              Start your store
            </Link>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 xl:grid-cols-[repeat(6,auto)] xl:justify-between">
          {(variant === "home" ? [HOME_COLUMN] : COLUMNS).map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <p className="whitespace-nowrap text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-white/70">
                {column.title}
              </p>
              <ul className="mt-4 space-y-1.5 text-[0.9375rem]">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <FooterAnchor
                      link={link}
                      className="inline-flex min-h-11 -my-2.5 items-center text-white/80 transition-colors hover:text-white"
                    />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      {/* pb clears the home indicator on an iPhone; the inset is zero everywhere else. */}
      <div className="container-page border-t border-white/12 pt-7 pb-[max(1.75rem,env(safe-area-inset-bottom))] text-[0.8125rem] leading-relaxed text-white/70">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
          <p>
            {`© ${year} Marktmorgen, by Solrenning — an independent software studio.`}
          </p>
          <ul className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
            {LEGAL_LINKS.map((link) => (
              <li key={link.href}>
                <FooterAnchor
                  link={link}
                  className="inline-flex min-h-11 -my-2.5 items-center text-white/80 transition-colors hover:text-white"
                />
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-4 flex flex-col gap-2 border-t border-white/10 pt-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
          <p>Payments processed by Stripe, on each creator&apos;s own account.</p>
          <div className="space-y-1.5 sm:max-w-md sm:text-right">
            <p className="flex items-center gap-2 sm:justify-end">
              <span className="h-1.5 w-1.5 rounded-full bg-mint-brand" aria-hidden="true" />
              {feeWords().short}
            </p>
            <p>
              Photographs from Unsplash, used for illustration. The people in them are not Marktmorgen
              customers, and nothing on this site is a testimonial.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
