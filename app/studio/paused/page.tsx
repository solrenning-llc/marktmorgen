import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { studioPath, studioView } from "@/lib/studio-route";
import { withinLimit, unknownLimit } from "@/lib/request-guard";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceWindow, resetWords } from "@/lib/allowance-window";
import { poolFullWords } from "@/lib/free-pool-rules";
import { PLAN_TITLES, PRO_ON_SALE, type Tier } from "@/lib/plan";
import { standingOf } from "@/lib/plan-standing";
import { PLANS_ON_SALE } from "@/lib/opening";
import { isBillingConfigured } from "@/lib/billing";
import { can } from "@/lib/team-roles";

export const metadata: Metadata = {
  title: "Studio paused — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** Drawn this many times a day for a store at the most, so a page that says "used" costs a bounded few requests. */
const SHOWN_PER_DAY = 20;

const LARGER: Record<Tier, Tier | null> = { creator: "pro", pro: "scale", scale: null };

/**
 * What the studio shows once a store's studio requests for its window are
 * used (lib/store-allowance-rules.ts): what happened, when the studio opens
 * again, and the way to a larger plan, which is never refused. Nothing else
 * is read or drawn, so this page costs a few commands.
 */
export default async function StudioPausedPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "member", { count: false });
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect("/");
  }
  const { view } = found;
  const { store } = view;
  // How many times it was shown today could not be read (rule 24): said so, never as shown too often.
  const room = await withinLimit("studio-paused", store.sid || store.handle, SHOWN_PER_DAY, 86_400).catch(unknownLimit);
  const shown = room === true;
  const pin = store.sid ? `?store=${store.sid}` : "";
  const standing = standingOf(store);
  const paying = standing === "paid";
  const larger = paying ? LARGER[store.tier] : null;
  const mayChange = can(view.role, "billing");
  const limit = allowanceFor(store, "studio");
  // Why the studio sent this here (lib/studio-route.ts, studioView): its figure used, no place for a store
  // that pays nothing (lib/free-pool-rules.ts), or a billing month Stripe could not be asked for just now.
  const why = query.why === "pool" ? "pool" : query.why === "unknown" ? "unknown" : query.why === "daily" ? "daily" : "used";
  // "Stripe could not be asked" only when the billing month is what is missing; otherwise the count itself.
  const noMonth = allowanceWindow(store) === null;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-40 border-b border-line bg-white/90 backdrop-blur-xl">
        <div className="container-page flex h-16 items-center justify-between gap-2 sm:gap-3">
          <Link href="/" className="shrink-0 rounded-[10px]" aria-label="Marktmorgen, home">
            <Logo />
          </Link>
        </div>
      </header>
      <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
        <div className="card max-w-2xl p-6 sm:p-8">
          <p className="eyebrow">Studio paused</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">
            {why === "pool"
              ? "Stores without a paid plan are full for this month"
              : why === "daily"
                ? "Too many plan changes, cancellations or downloads today"
              : why === "unknown"
                ? noMonth ? "Your plan\u2019s billing month could not be read just now" : "Your studio\u2019s requests could not be counted just now"
                : `${store.name}\u2019s studio requests ${standing === "trial" ? "for this trial" : "for this month"} are used`}
          </h1>
          {shown ? (
            <>
              <p className="mt-4 text-ink-soft">
                {why === "pool"
                  ? poolFullWords(PLANS_ON_SALE)
                  : why === "daily"
                    ? "They have a small daily limit of their own, so the month\u2019s studio requests never stop them. Try again tomorrow, or write to support."
                  : why === "unknown"
                    ? noMonth
                      ? "Your studio counts its requests in your plan\u2019s billing month, which we read from Stripe, and Stripe could not be asked just now. Nothing is lost: try again in a minute."
                      : "Your studio\u2019s requests could not be counted just now. Nothing is lost: try again in a minute."
                    : `${paying ? `Your plan includes ${limit.toLocaleString("en-US")} studio requests a month` : standing === "trial" ? `The trial includes ${limit.toLocaleString("en-US")} studio requests in all` : `Without a paid plan, your store has ${limit.toLocaleString("en-US")} studio requests a month`}: every page of the studio you open, every save, and the studio's own refreshing. They are used, so the studio is paused until they open again. Pausing the studio does not close your store to buyers, and nothing you made or sold is touched.`}
              </p>
              {why === "used" ? <p className="mt-3 font-semibold text-ink">{resetWords(store)}</p> : null}
              {/* app/api/billing/switch refuses while no plan is on sale, without billing or without a subscription. */}
              {why !== "daily" && larger && PLANS_ON_SALE && PRO_ON_SALE && isBillingConfigured() && store.subscriptionId && mayChange ? (
                <form action={`/api/billing/switch${pin}`} method="post" className="mt-6">
                  <input type="hidden" name="tier" value={larger} />
                  <input type="hidden" name="cycle" value={store.cycle} />
                  <button type="submit" className="btn btn-primary">
                    {`Move to ${PLAN_TITLES[larger]} now`}
                  </button>
                  <p className="mt-2 text-sm text-ink-soft">
                    {`${PLAN_TITLES[larger]} includes ${allowanceFor({ ...store, tier: larger }, "studio").toLocaleString("en-US")} studio requests a month, and the studio opens again as soon as the plan changes.`}
                  </p>
                </form>
              ) : null}
              {why === "daily" ? null : (
              <div className="mt-8 border-t border-line pt-6">
                <p className="text-sm font-bold text-ink">Never paused</p>
                <p className="mt-1 text-sm text-ink-soft">{PLANS_ON_SALE ? "Changing your plan, canceling it and taking your sales with you always work." : "Canceling your plan and taking your sales with you always work."}</p>
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  {can(view.role, "export") ? (
                    <form action="/api/store/export" method="get">
                      <input type="hidden" name="store" value={store.sid} />
                      <input type="hidden" name="what" value="sales" />
                      <input type="hidden" name="range" value="all" />
                      <button type="submit" className="btn btn-secondary btn-sm">
                        Download all sales (CSV)
                      </button>
                    </form>
                  ) : null}
                  {paying && mayChange && isBillingConfigured() && store.subscriptionId ? (
                    <details>
                      <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">Cancel the subscription</summary>
                      <p className="mt-2 text-sm text-ink-soft">Your store keeps taking payments until the end of the period you already paid for, and nothing more is charged.</p>
                      <form action={`/api/billing/cancel${pin}`} method="post" className="mt-3">
                        <input type="hidden" name="intent" value="cancel" />
                        <button type="submit" className="btn btn-secondary btn-sm">
                          Yes, cancel it
                        </button>
                      </form>
                    </details>
                  ) : null}
                  <Link href={studioPath(store)} className="btn btn-secondary btn-sm">
                    Open the studio
                  </Link>
                </div>
              </div>
              )}
            </>
          ) : room === "unknown" ? (
            <p className="mt-4 text-ink-soft" role="status">Your studio is paused for now. More about it could not be loaded just now: reload this page in a minute.</p>
          ) : (
            <p className="mt-4 text-ink-soft">Your studio is paused for now. Please come back tomorrow.</p>
          )}
        </div>
      </main>
    </div>
  );
}
