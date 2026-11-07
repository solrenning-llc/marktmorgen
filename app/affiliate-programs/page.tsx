import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { AffiliateDirectory } from "@/components/affiliate-directory";
import { DIRECTORY_ORDER, readDirectory } from "@/lib/affiliate-directory";
import { INDEX_DIRECTORY_AT } from "@/lib/directory-index";

const TITLE = "Affiliate programs to promote — Marktmorgen";
const DESCRIPTION =
  "Creators' own affiliate programs, each with its share of a sale, how long a click counts, the day the creator pays and what one sale of each product, or one payment of a membership, earns. Apply to the ones you would recommend anyway.";

/**
 * The rows, read once a request: the page and its title share this one read (React cache), so a visit builds the
 * directory at most once. null when it could not be read, or was built too recently to build again
 * (lib/affiliate-directory.ts, DIRECTORY_BUILD_SECONDS): the page then says the list is unavailable just now.
 */
const directoryRows = cache(() => readDirectory().catch(() => null));

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const rows = await directoryRows();
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: "/affiliate-programs" },
    // Asked to be found only once there is a catalogue to find (lib/directory-index.ts, INDEX_DIRECTORY_AT).
    robots: rows !== null && rows.length >= INDEX_DIRECTORY_AT ? { index: true, follow: true } : { index: false, follow: true },
  };
}

const HONEST = [
  {
    title: "Say it is an affiliate link",
    body: "Wherever you share one, say plainly that you earn from it: “I earn a commission if you buy through this link,” next to the link, not at the end of a long post. In the United States the FTC asks for this, and in Europe the law on unfair commercial practices does too.",
  },
  {
    title: "Promise only what the product does",
    body: "Describe it with the creator's own words and your own experience. Never promise income, weight lost or any other result the product does not guarantee, and never invent a review or a deadline.",
  },
  {
    title: "Paid by the creator, on their day",
    body: "Every sale is paid to the creator's own Stripe account, and the creator pays you, on the day their program states. Marktmorgen keeps the record of every click and sale on both sides, and pays nobody.",
  },
];

export default async function AffiliateProgramsPage() {
  await connection();
  const rows = await directoryRows();
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="flex-1">
        <section className="surface-navy nb-grid-lines on-dark overflow-hidden">
          <div className="container-page py-14 sm:py-20">
            <p className="eyebrow">Affiliate programs</p>
            <h1 className="t-h1 balance mt-5 max-w-3xl text-white">
              Recommend what you believe in,{" "}
              <span className="serif font-normal text-[#cfc4ff]">and see every term before you apply.</span>
            </h1>
            <p className="t-lead mt-6 max-w-2xl text-white/80">
              Creators who sell on Marktmorgen list their own programs here: the share of each sale, how long a click counts, when they pay, and what one sale of
              each product, or one payment of a membership, earns at today&apos;s price. Read from their stores, never typed for this page.
            </p>
            <p className="mt-4 text-sm text-white/80">
              Already promoting creators here?{" "}
              <Link href="/affiliate" className="underline underline-offset-4">
                See all your programs in one place
              </Link>
              .
            </p>
            <p className="mt-6 text-sm text-white/70" data-count>
              {rows === null
                ? "The program list could not be checked just now."
                : rows.length === 0
                ? "No program is listed yet."
                : `${rows.length} ${rows.length === 1 ? "program" : "programs"} listed.`}
            </p>
          </div>
        </section>

        <section className="container-page py-10 sm:py-14">
          {rows === null ? (
            <div role="status" className="card mx-auto max-w-2xl p-6 text-center sm:p-8">
              <h2 className="text-lg font-semibold text-ink">The program list is unavailable just now</h2>
              <p className="mt-2 text-ink-soft">We could not check the list. This does not mean there are no programs. Try again in a moment.</p>
              <form action="/affiliate-programs" method="get" className="mt-5">
                <button type="submit" className="btn btn-primary">Try again</button>
              </form>
            </div>
          ) : rows.length ? (
            <AffiliateDirectory rows={rows} />
          ) : (
            <div className="card mx-auto max-w-2xl p-6 text-center sm:p-8">
              <h2 className="text-lg font-semibold text-ink">The first programs are on their way</h2>
              <p className="mt-2 text-ink-soft">
                Creators choose to be listed from their studio, and a program appears here once it can take payments and has a product that earns. Nothing here is
                made up to fill the page.
              </p>
              <Link href="/signin" className="btn btn-primary mt-5">
                List your own program
              </Link>
            </div>
          )}
          <p className="mx-auto mt-8 max-w-3xl text-center text-sm text-ink-soft" id="order">
            {DIRECTORY_ORDER}
          </p>
        </section>

        <section className="bg-sand/60">
          <div className="container-page py-12 sm:py-16">
            <h2 className="t-h2 balance">Promote it honestly</h2>
            <p className="mt-3 max-w-2xl text-ink-soft">What every program here asks of its affiliates, and what keeps a recommendation worth trusting.</p>
            <ul className="mt-8 grid gap-4 md:grid-cols-3">
              {HONEST.map((item) => (
                <li key={item.title} className="card p-5">
                  <h3 className="font-semibold text-ink">{item.title}</h3>
                  <p className="mt-2 text-sm text-ink-soft">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="container-page py-12 sm:py-16">
          <div className="card flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
            <div>
              <h2 className="text-lg font-semibold text-ink">Sell on Marktmorgen?</h2>
              <p className="mt-1 text-ink-soft">Turn on your affiliate program in your studio and check “List my program in the affiliate directory.” Switch it off and it leaves this page at once.</p>
            </div>
            <Link href="/platform/affiliates" className="btn btn-secondary">
              How affiliates work
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
