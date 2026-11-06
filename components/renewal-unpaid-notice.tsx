import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { RENEWAL_KEPT_WORDS, RENEWAL_PAUSED_WORDS, RENEWAL_RESUME_WORDS } from "@/lib/renewal-unpaid-words";

/**
 * The studio's notice when the plan's renewal payment did not go through
 * (232 [CA1] unit 4): what has stopped, what has not, and the one thing to
 * do. Drawn on the server; no script. `payUrl` is Stripe's own page for the
 * open invoice (lib/billing.ts, renewalInvoicePage), read on this load; when
 * Stripe did not give one, the notice says how to get it from a person.
 * `canPay` is false for a team member without the billing permission, who
 * is told to ask the owner instead of being shown a link to pay.
 */
export function RenewalUnpaidNotice({ payUrl, canPay }: { payUrl: string | null; canPay: boolean }) {
  return (
    <section id="renewal-unpaid" aria-labelledby="renewal-unpaid-title" className="notice notice-warn mt-6 scroll-mt-24">
      <h2 id="renewal-unpaid-title" className="font-bold text-ink">
        Your plan&apos;s renewal payment did not go through
      </h2>
      <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{RENEWAL_PAUSED_WORDS}</p>
      <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{RENEWAL_KEPT_WORDS}</p>
      {canPay ? (
        payUrl ? (
          <p className="mt-2 max-w-[80ch] text-sm leading-relaxed text-ink-soft">
            <a href={payUrl} className="inline-flex min-h-11 items-center font-bold text-ink underline underline-offset-4">
              Pay the open invoice on Stripe&apos;s page
            </a>{" "}
            (you can use the same card or another one). {RENEWAL_RESUME_WORDS} Then reload this page.
          </p>
        ) : (
          <p className="mt-2 max-w-[80ch] text-sm leading-relaxed text-ink-soft">
            We could not get the page that pays it just now. Reload this page in a minute, or write to{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="inline-flex min-h-11 items-center font-bold text-ink underline underline-offset-4">
              {SUPPORT_EMAIL}
            </a>{" "}
            and we will send you the link. {RENEWAL_RESUME_WORDS}
          </p>
        )
      ) : (
        <p className="mt-2 max-w-[80ch] text-sm leading-relaxed text-ink-soft">
          Only someone who manages billing for this store can pay it. Ask the store owner. {RENEWAL_RESUME_WORDS}
        </p>
      )}
    </section>
  );
}
