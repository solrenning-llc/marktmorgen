import { PendingSubmit } from "@/components/pending-submit";
import Link from "next/link";
import { cookies } from "next/headers";
import { MorningLogo } from "@/components/morning-header";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RESET_DAYS, TWO_STEP_COOKIE, heldFor, twoStepStatus } from "@/lib/two-step";

export const metadata: Metadata = {
  title: "Your code — Marktmorgen",
  description: "The second step of logging in to Marktmorgen.",
  robots: { index: false, follow: false },
};

const NOTICES: Record<string, string> = {
  wrong: "That code is not right. Type the six digits your app shows now, or one of your recovery codes.",
  limited: "That is a lot of codes in an hour. Wait a while, then try again, or log in with a passkey.",
  unreadable:
    "Your app's codes cannot be checked right now, after a security change on our side. Use one of your recovery codes, or log in with a passkey, then turn two-step login off and on again.",
  "rescue-limited": "A link has gone to your recovery address three times this hour. Use the newest one, or try again later.",
  "rescue-unsent": "The email to your recovery address could not be sent just now. Try again in a moment.",
  "rescue-none": "There is no recovery address to send a link to for this login. Use a recovery code or a passkey, or the choice below.",
};

/**
 * The second step of logging in, for an account with two-step login
 * (lib/two-step.ts): the emailed link has been spent, and the session opens
 * once the code from the authenticator app, or a recovery code, is right.
 */
export default async function CodePage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const held = (await cookies()).get(TWO_STEP_COOKIE)?.value ?? "";
  const email = await heldFor(held);
  if (!email) redirect("/signin?status=expired");
  const status = typeof params.status === "string" ? params.status : "";
  const notice = NOTICES[status] ?? null;
  // A request to turn it off without a code, waiting its days (lib/two-step.ts askReset).
  const { reset, backup } = await twoStepStatus(email);
  const resetDay = reset ? new Date(reset).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";

  return (
    <div className="relative min-h-screen overflow-hidden">
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <MorningLogo />

        <h1 className="t-h1 mt-6">One more step</h1>
        <p className="mt-4 text-lg text-ink-soft">Your link was good. Now type the code your authenticator app shows for Marktmorgen.</p>

        <div className="card mt-8 p-6 sm:p-8">
          {notice ? (
            <p className="notice notice-error mb-5" role="alert">
              {notice}
            </p>
          ) : null}
          <form method="post" action="/api/auth/code" className="space-y-4">
            <label className="block" htmlFor="two-step-code">
              <span className="field-label">Code</span>
              <input
                id="two-step-code"
                name="code"
                className="field mt-2 text-lg tracking-[0.2em]"
                inputMode="text"
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={20}
                placeholder="123456"
              />
            </label>
            <PendingSubmit label="Log me in" pending="Checking…" className="btn btn-primary btn-lg btn-block" />
          </form>
          <p className="mt-4 text-sm text-ink-soft">
            No phone at hand? Type one of the recovery codes you saved when you turned this on; each works once. Or{" "}
            <Link href="/signin" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              log in with a passkey
            </Link>
            , which needs no code.
          </p>
          {/* The way back in at once: a link to the recovery address (lib/two-step.ts sendRescue). */}
          {status === "rescue-sent" ? (
            <p className="notice mt-5" role="status">
              {`We sent a link to your recovery address, ${backup}. Open it on any device: it turns two-step login off and logs you in. It works once, for 15 minutes.`}
            </p>
          ) : backup ? (
            <div className="mt-5 rounded-[12px] bg-paper px-4 py-4 text-sm ring-1 ring-line">
              <p className="font-semibold text-ink">Lost your phone, your recovery codes and your passkeys?</p>
              <p className="mt-1 text-ink-soft">{`We email a link to your recovery address, ${backup}. Opening it turns two-step login off and logs you in, right away.`}</p>
              <form method="post" action="/api/auth/code" className="mt-3">
                <input type="hidden" name="action" value="rescue" />
                <PendingSubmit label="Email my recovery address" pending="Sending…" className="btn btn-secondary" />
              </form>
            </div>
          ) : null}
          <details className="mt-5 text-sm text-ink-soft" open={Boolean(reset)}>
            <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-ink underline underline-offset-4">
              {backup ? "Cannot open your recovery address either?" : "Lost your phone, your recovery codes and your passkeys?"}
            </summary>
            <p className="mt-2">
              {reset
                ? `You can get in now, as before. Payments, your plan, your team, exports, settings, sending to your list, deleting a person or a product, your sign-in address, passkeys and two-step login stay locked until ${resetDay}, when two-step login turns off; everything else is open.`
                : `Get in now. Everything you need to keep selling is open at once: your products, pages, buyers, numbers and drafts. What could take money, data or the account away — payments, your plan, your team, exports, settings, sending to your list, deleting a person or a product, your sign-in address — stays locked for ${RESET_DAYS} days, and then two-step login turns off. That is what keeps someone who only got into your email from doing harm: we email you, and logging in with a code or a passkey in that time, or Cancel in your studio, logs them out.`}
            </p>
            <form method="post" action="/api/auth/code" className="mt-3">
              <input type="hidden" name="action" value="reset" />
              <PendingSubmit label="Get in now" pending="Letting you in…" className="btn btn-secondary" />
            </form>
          </details>
        </div>
      </main>
    </div>
  );
}
