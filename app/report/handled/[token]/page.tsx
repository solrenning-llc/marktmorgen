import type { Metadata } from "next";
import { readAlert, utcTime } from "@/lib/child-safety-alerts";

export const metadata: Metadata = {
  title: "Mark a report handled — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { params: Promise<{ token: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Where the "mark this report handled" link in the owner's urgent email leads
 * (lib/child-safety-alerts.ts). Opening it changes nothing: only the button
 * closes the report, so a mail scanner that follows links stops no reminder.
 * It never shows the reported content or the reporter's words.
 */
export default async function ReportHandledPage({ params, searchParams }: Params) {
  const token = (await params).token.slice(0, 96);
  const query = await searchParams;
  if (query.done === "1") {
    return (
      <Frame>
        <h1 className="t-h3">This report is marked handled</h1>
        <p className="notice notice-info mt-3" role="status">
          No more reminders will be sent for it. Nothing else changed: anything that was held stays held, and nothing was deleted.
        </p>
      </Frame>
    );
  }
  const read = await readAlert(token).then(
    (alert) => ({ alert, unread: false }),
    (error: unknown) => {
      console.error("a child-safety report could not be read", error instanceof Error ? error.message : "unknown");
      return { alert: null, unread: true };
    },
  );
  const found = read.alert;
  const unread = read.unread;
  const notSaved =
    query.done === "0" ? (
      <p className="notice notice-error mt-3" role="alert">
        It was not marked handled just now, so the reminders go on. Press the button again in a moment.
      </p>
    ) : null;
  if (unread) {
    return (
      <Frame>
        <h1 className="t-h3">This report could not be read just now</h1>
        {notSaved}
        <p className="mt-3 text-ink-soft">Nothing was changed. You can still mark it handled below, or open the link again in a moment.</p>
        <HandledForm token={token} />
      </Frame>
    );
  }
  if (!found) {
    return (
      <Frame>
        <h1 className="t-h3">This link is not one of an open report</h1>
        <p className="mt-3 text-ink-soft">
          The report may already be marked handled, or its reminders ended after 30 days. Open the link from the email itself to be sure.
        </p>
      </Frame>
    );
  }
  const what = found.kind === "child_safety" ? "child safety report" : "request to remove an intimate image";
  return (
    <Frame>
      <h1 className="t-h3">Mark this report handled?</h1>
      {notSaved}
      <p className="mt-3 text-ink-soft">
        {`A ${what}${found.handle ? ` about @${found.handle}` : ""} has been open since ${utcTime(found.firstAt)}. While it is open, a reminder goes to the support inbox every 24 hours.`}
      </p>
      <p className="mt-3 text-ink-soft">
        Mark it handled only when the steps in docs/incident-response.md section 8 are done. The reminders then stop. Nothing else changes: anything that was held stays held, and nothing is deleted.
      </p>
      <HandledForm token={token} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main id="content" className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">{children}</div>
    </main>
  );
}

/** The one button that closes the report: a POST from this site (app/api/report/handled). */
function HandledForm({ token }: { token: string }) {
  return (
    <form action="/api/report/handled" method="post" className="mt-6">
      <input type="hidden" name="t" value={token} />
      <button type="submit" className="btn btn-primary btn-block">
        Mark this report handled
      </button>
    </form>
  );
}
