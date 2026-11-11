import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { StudioTrail } from "@/components/breadcrumb";
import { HandleForm } from "@/components/handle-form";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { MAX_STORES_PER_ACCOUNT, accountStores } from "@/lib/store";
import { TRIAL_DAYS, publishedPriceWords as priceWords } from "@/lib/plan";

export const metadata: Metadata = {
  title: "New store — Marktmorgen",
  robots: { index: false, follow: false },
};

/**
 * Making another store in the same account: its own address, its own
 * products, its own Stripe account and its own plan. Always a store of the
 * person signed in, whatever store their studio has open.
 */
export default async function NewStorePage() {
  const email = await emailForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!email) redirect("/signin");
  const owned = await accountStores(email);
  const first = owned.length === 0;
  const full = owned.length >= MAX_STORES_PER_ACCOUNT;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-40 border-b border-line bg-white/90 backdrop-blur-xl">
        <div className="container-page flex h-16 items-center justify-between gap-2 sm:gap-3">
          <Link href="/" className="shrink-0 rounded-[10px]" aria-label="Marktmorgen, home">
            <Logo />
          </Link>
          <Link href="/studio" className="btn btn-secondary btn-sm">
            Back to the studio
          </Link>
        </div>
      </header>

      <main id="content" className="container-narrow pb-20 pt-10 sm:pt-14">
        <StudioTrail store={{ sid: "" }} here={first ? "Your own store" : "Another store"} />
        <h1 className="t-h2 mt-3">{first ? "Make a store of your own" : "Open another store"}</h1>
        <p className="mt-3 text-ink-soft">
          {first
            ? "Separate from any store you help run: yours, under your own address."
            : `One account runs up to ${MAX_STORES_PER_ACCOUNT} stores. Each has its own address, products, buyers, Stripe account and plan, and you switch between them from the top of the studio.`}
        </p>

        {full ? (
          <div className="notice notice-info mt-8">
            <p className="font-semibold text-ink">{`You run ${MAX_STORES_PER_ACCOUNT} stores already`}</p>
            <p className="mt-1 text-sm text-ink-soft">That is the most one account can run. An empty store you no longer need can be deleted from its studio.</p>
          </div>
        ) : (
          <>
            <div className="card mt-8 p-6 sm:p-8">
              <HandleForm another={!first} />
            </div>
            <div className="mt-6 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">
              <p className="font-semibold text-ink">What it costs</p>
              <p className="mt-1">
                {first
                  ? `Making it is free, and so are its page and editor. Taking payments needs its plan: ${priceWords("creator", "month")}, with the first ${TRIAL_DAYS} days free.`
                  : `Making it is free, and so are its page and editor. Taking payments needs a plan of its own, from ${priceWords("creator", "month")}. The ${TRIAL_DAYS}-day free trial is for an account's first store, so this one is charged from the day you start its plan. Canceling it takes two clicks and touches no other store.`}
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
