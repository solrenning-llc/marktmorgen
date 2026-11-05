import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";
import {
  STATUS_STALE_HOURS, STATUS_WINDOW_DAYS, type StatusSummary, describeStatus, readStatus, statusDate, statusTime,
} from "@/lib/status-page";

export const metadata: Metadata = {
  title: "Status — Marktmorgen",
  description: "The results of the checks Marktmorgen runs on itself: email delivery, checkout in Stripe's test mode and the database, with what they do not measure.",
  robots: { index: true, follow: true },
};

/**
 * Put together ahead of time and again at most once an hour, whoever opens
 * it (247 [SP4] unit 2): its reads are bounded by that schedule, not by its
 * visitors (lib/status-page.ts, tests/status-page.test.ts). It shows the time
 * it was put together, so an older copy is never taken for a newer one.
 */
export const dynamic = "force-static";
export const revalidate = 3600;

const link = "text-black underline underline-offset-2 hover:no-underline";

function History({ name, summary }: { name: string; summary: StatusSummary }) {
  if (summary.runs === 0) return <p>{`${name}: no run recorded in the last ${STATUS_WINDOW_DAYS} days.`}</p>;
  return (
    <>
      <p>
        {`${name}, from ${statusDate(summary.since!)}: ${summary.runs} ${summary.runs === 1 ? "run" : "runs"} recorded, ${summary.passed} passed, ${summary.failed} failed. Days with no recorded run: ${summary.daysWithoutRun}.`}
      </p>
      {summary.failures.length === 0 ? (
        <p>{`${name}: no failed run recorded in these days.`}</p>
      ) : (
        <>
          <p>{`${name}: failed runs, newest first:`}</p>
          <ul>
            {summary.failures.map((at) => <li key={at}>{statusTime(at)}</li>)}
          </ul>
        </>
      )}
    </>
  );
}

export default async function StatusPage() {
  const reading = await readStatus();
  const view = describeStatus(reading);
  return (
    <LegalPage title="Status" eyebrow="How the site is doing" effective={null} legalNav={false}>
      <p>
        This page shows the results of checks the site runs on itself. It shows only what was measured. When a check has
        no recent result, it says &ldquo;Unknown&rdquo;, not &ldquo;Passed&rdquo;.
      </p>
      <p>
        {`This page was put together on ${view.builtAt}. UTC is Coordinated Universal Time. The page is put together again at most once an hour, when someone opens it, so it can be older than that.`}
      </p>

      <LegalSection title="Results" id="results">
        <table>
          <caption className="sr-only">The latest result of each check</caption>
          <thead>
            <tr>
              <th scope="col">What is checked</th>
              <th scope="col">Result</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.what}>
                <th scope="row">{row.what}</th>
                <td>{row.result}</td>
                <td>{row.when}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </LegalSection>

      <LegalSection title="What each check does" id="checks">
        <p>
          <strong>Database.</strong> When this page is put together, the site reads the check results below from its
          database. &ldquo;Answered&rdquo; means the database answered at that time.
        </p>
        <p>
          <strong>Email delivery.</strong> Once a day, the site sends test list emails through each email service it has
          set up, to test addresses those services keep for this. It checks that each service reports a bounce (a message
          that says an email could not be delivered) and a spam report (a reader marking an email as spam) back to the
          site, and that the test address then comes off the list. It also checks how the site signs in to Amazon&rsquo;s
          email service. The run passes only when every step works.
        </p>
        <p>
          <strong>Checkout.</strong> Once a day, the site runs checkouts in Stripe&rsquo;s test mode: session packages,
          membership tiers, tax documents and a cart that ships. Stripe&rsquo;s test mode is a copy of Stripe for trying
          payments with test cards. No real card is charged.
        </p>
        <p>
          {`A check is “Unknown” when it has no result in the last ${STATUS_STALE_HOURS} hours. A failed run means at least one step did not work as expected. It does not always mean that emails or payments were lost.`}
        </p>
      </LegalSection>

      <LegalSection title={`The last ${STATUS_WINDOW_DAYS} days`} id="history">
        <p>Every recorded run is counted. Nothing is rounded.</p>
        {reading.checks.map((check) => <History key={check.id} name={check.name} summary={check.summary} />)}
      </LegalSection>

      <LegalSection title="What this page does not measure" id="not-measured">
        <ul>
          <li>Whether the site can be reached from the outside. No outside service watches it. This page runs on the same servers as the site, so if the site is down, this page is down too.</li>
          <li>How long the site has been up. We do not show an uptime percentage, because we do not measure one.</li>
          <li>Real buyers&rsquo; payments, and the systems of Stripe or of the email services themselves.</li>
          <li>Stores&rsquo; own domains, videos, files and the other parts of the site.</li>
          <li>Problems that people found and wrote up. Only automatic checks are listed here.</li>
        </ul>
        <p>
          How we protect accounts and data is on the{" "}
          <Link href="/platform/security" className={link}>security page</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
