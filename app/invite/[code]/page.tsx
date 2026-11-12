import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { Icon } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { storeForEmail } from "@/lib/store";
import { inviterFor } from "@/lib/creator-invites";
import { INVITE_BONUS_CENTS, INVITE_CODE_PATTERN, INVITE_COOKIE_DAYS, INVITE_HOLD_DAYS, INVITE_PROGRAM_OPEN, INVITE_PAUSE_NOTICE } from "@/lib/creator-invite-rules";
import { formatMoney } from "@/lib/money";
import { TRIAL_DAYS, publishedPriceWords as priceWords } from "@/lib/plan";
import { feeWords } from "@/lib/fee-words";

export const metadata: Metadata = {
  title: INVITE_PROGRAM_OPEN ? "You're invited — Marktmorgen" : "Creator invitations — Marktmorgen",
  description: INVITE_PROGRAM_OPEN ? "A creator invited you to Marktmorgen: sell digital products, courses, memberships and calls from one link, " + feeWords().inviteMeta + "." : INVITE_PAUSE_NOTICE,
  robots: { index: false, follow: false },
};

/**
 * Where a creator's invite link leads (lib/creator-invites.ts). It says who
 * sent it, what the invited creator gets, and asks before keeping anything:
 * nothing is stored until "Accept the invite" is pressed.
 */
export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toLowerCase();
  if (!INVITE_CODE_PATTERN.test(code)) notFound();
  if (!INVITE_PROGRAM_OPEN) return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="container-narrow flex-1 py-16">
        <p className="eyebrow">Creator invitations</p>
        <h1 className="t-h1 mt-5">New invitations are paused</h1>
        <p className="t-lead mt-6">{INVITE_PAUSE_NOTICE}</p>
        <p className="mt-4 text-ink-soft">If you previously accepted an invite on this browser, you can still finish creating your first store within its original 60-day window. Opening this page does not renew that window.</p>
        <Link href="/signin" className="btn btn-primary mt-6">Continue to your account</Link>
        <Link href="/studio/invite" className="link ml-4 inline-flex min-h-11 min-w-11 items-center">View existing credits</Link>
      </main>
      <SiteFooter />
    </div>
  );
  const inviter = await inviterFor(code).catch(() => null);
  if (!inviter) notFound();

  const email = await emailForSession((await cookies()).get(SESSION_COOKIE)?.value).catch(() => null);
  const hasStore = email ? Boolean(await storeForEmail(email).catch(() => null)) : false;
  const bonus = formatMoney(INVITE_BONUS_CENTS, "usd");
  const who = inviter.name.trim() || `@${inviter.handle}`;

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="flex-1">
        <section className="surface-daybreak on-dark overflow-hidden">
          <div className="awning" aria-hidden="true" />
          <div className="container-narrow py-16 sm:py-20">
            <p className="eyebrow">An invite from @{inviter.handle}</p>
            <h1 className="t-h1 balance mt-5 text-white">
              {who} invited you to <span className="serif font-normal text-[#cfc4ff]">Marktmorgen</span>
            </h1>
            <p className="t-lead mt-6 max-w-2xl text-white/80">
              Sell digital products, courses, memberships and calls from one link. Your buyers pay into your own Stripe account,
              {feeWords().inviteLead}
            </p>
          </div>
        </section>

        <section className="container-narrow py-12 sm:py-16">
          <h2 className="t-h3">What the invite gives you</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-3">
            {[
              { icon: "clock" as const, title: `${TRIAL_DAYS} days free`, text: `Then ${priceWords("creator", "month")}. Cancel anytime.` },
              {
                icon: "gift" as const,
                title: `${bonus} of credit`,
                text: `On your plan ${INVITE_HOLD_DAYS} days after your first payment, when its refund window has closed. It pays your next bill.`,
              },
              { icon: "percent" as const, title: feeWords().inviteCardTitle, text: feeWords().inviteCardText },
            ].map((item) => (
              <li key={item.title} className="card p-5">
                <span className="icon-tile icon-tile-sm">
                  <Icon name={item.icon} size={18} />
                </span>
                <p className="mt-3 font-semibold text-ink">{item.title}</p>
                <p className="mt-1 text-[0.9375rem] text-ink-soft">{item.text}</p>
              </li>
            ))}
          </ul>

          {hasStore ? (
            <div className="notice notice-info mt-8" role="status">
              <p className="font-semibold">You already have a Marktmorgen store</p>
              <p className="mt-1">
                Invites are for creators making their first store, so this one cannot count for you. You can invite creators
                yourself from your studio, under Invite creators.
              </p>
              <Link href="/studio" className="btn btn-primary mt-4">
                Open your studio
              </Link>
            </div>
          ) : (
            <div className="mt-8">
              {/* A plain link, never prefetched: following it is what keeps the invite. */}
              <a href={`/invite/${code}/accept`} className="btn btn-primary">
                Accept the invite
                <Icon name="arrow-right" size={16} />
              </a>
              <p className="mt-3 max-w-xl text-[0.875rem] text-ink-mute">
                {`Accepting keeps this invite on this browser for ${INVITE_COOKIE_DAYS} days, so it counts when you make your store. It counts once, for a first Marktmorgen store, and only if the account has not paid us before.`}
              </p>
            </div>
          )}

          <p className="mt-10 text-[0.9375rem] text-ink-soft">
            Want to look around first?{" "}
            <Link href="/demo" className="link">
              Open the live demo store
            </Link>{" "}
            or{" "}
            <Link href="/proof/compare" className="link">
              see how we compare
            </Link>
            .
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
