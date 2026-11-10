import { UsageMeter } from "@/components/usage-meter";

/** The already-read list-email count; this component performs no reads or sends. */
export function EmailUsageSummary({ used, allowance }: {
  used: number | null;
  allowance: number;
}) {
  return (
    <section aria-labelledby="email-usage-title" className="card mt-6 min-w-0 p-5 text-ink sm:p-6">
      <h2 id="email-usage-title" className="mb-3 text-lg font-semibold">List email this month</h2>
      <UsageMeter
        label="Emails counted toward your limit"
        used={used}
        limit={allowance}
        format={(value) => value.toLocaleString("en-US")}
        unavailable="Your email use could not be loaded. Reload this page to check it."
        description="One-off list emails and sequences share this limit. This is the count when this page loaded."
      />
    </section>
  );
}
