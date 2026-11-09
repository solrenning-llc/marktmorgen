import { PendingSubmit } from "@/components/pending-submit";
import Link from "next/link";
import { MorningLogo } from "@/components/morning-header";
import type { Metadata } from "next";
import { LOCK_DAYS } from "@/lib/recovery-address";
import { LOCKED_LIST } from "@/lib/locked-words";
import { EMAIL_ADDRESS_RULE, wholeAddress } from "@/lib/email-address-rule";

export const metadata: Metadata = {
  title: "Cannot open your email — Marktmorgen",
  description: "Get back into your Marktmorgen account through its recovery address or a passkey.",
  robots: { index: false, follow: false },
};

/**
 * For a creator who can no longer open the inbox they log in with
 * (lib/recovery-address.ts): a passkey needs no email at all, and a link to
 * the account's recovery address lets them in at once.
 */
export default async function LostEmailPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const sent = params.status === "sent";
  const unavailable = params.status === "unavailable";
  return (
    <div className="relative min-h-screen overflow-hidden">
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <MorningLogo />
        <h1 className="t-h1 mt-6">Cannot open your email?</h1>
        <p className="mt-4 text-lg text-ink-soft">There are two ways back in, and neither needs that inbox.</p>

        <div className="card mt-8 p-6 sm:p-8">
          <h2 className="font-semibold text-ink">A passkey</h2>
          <p className="mt-1 text-sm text-ink-soft">If you added one, it logs you in with your fingerprint, face or device PIN, with everything open. Then move your sign-in address to an inbox you have, under Account in your studio.</p>
          <Link href="/signin" className="btn btn-secondary mt-3">
            Log in with a passkey
          </Link>

          <h2 className="mt-8 font-semibold text-ink">Your recovery address</h2>
          {sent ? (
            <p className="notice mt-2" role="status">
              Your request was received. Check your recovery inbox. If a link was sent, it works once, for 15 minutes.
            </p>
          ) : (
            <>
              {unavailable ? (
                <p className="notice notice-error mt-2" role="alert">
                  Email is unavailable right now. Try again in a moment, or use a passkey you already added.
                </p>
              ) : null}
              <p className="mt-1 text-sm text-ink-soft">
                {`Type the address you log in with. If your account has a recovery address, we email a link there that lets you in at once. Your products, pages, buyers and numbers are open straight away; ${LOCKED_LIST} open ${LOCK_DAYS} days later, unless you log in with your old inbox, a passkey or your app's code before then. That wait is only for what someone who got into an old inbox could take.`}
              </p>
              <form method="post" action="/api/auth/lost" className="mt-3 space-y-3">
                <label className="block" htmlFor="lost-email">
                  <span className="field-label">The address you log in with</span>
                  <input id="lost-email" name="email" type="email" pattern={EMAIL_ADDRESS_RULE} title={wholeAddress()} required maxLength={254} autoComplete="email" className="field mt-2" />
                </label>
                <PendingSubmit label="Email my recovery address" pending="Sending…" className="btn btn-primary" />
              </form>
            </>
          )}
          <p className="mt-6 text-sm text-ink-soft">
            Neither? Then the account cannot be opened without that inbox, and nobody here can open it for you: that is what keeps it yours. Get back into the inbox through your email provider&apos;s own recovery, and add a passkey and a recovery address once you are in.
          </p>
        </div>
      </main>
    </div>
  );
}
