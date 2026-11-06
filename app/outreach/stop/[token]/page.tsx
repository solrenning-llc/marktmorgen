import type { Metadata } from "next";
import Link from "next/link";
import { readStopLink } from "@/lib/outreach";
import { STOP_LINK } from "@/lib/outreach-rules";

export const metadata: Metadata = {
  title: "Stop these emails — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { params: Promise<{ token: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Where the stop link in an Outreach email leads (lib/outreach.ts). Two
 * buttons and the answer: nobody is asked why, and nothing is asked for.
 * The link is opened by hand, so nothing happens until one is pressed — a
 * mail scanner that follows links closes nothing by accident.
 */
export default async function OutreachStopPage({ params, searchParams }: Params) {
  const token = (await params).token.slice(0, 40);
  const query = await searchParams;
  // A read that failed or answered in an unknown shape is said as such, never as a link we do not know (CX-123 rule 24).
  let unchecked = false;
  const found = STOP_LINK.test(token)
    ? await readStopLink(token).catch((error: unknown) => {
        console.error("an outreach stop link could not be read", error);
        unchecked = true;
        return null;
      })
    : null;
  const who = found?.storeName || "this creator";

  return (
    <main id="content" className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">
        {unchecked ? (
          <>
            <h1 className="t-h3">We could not check this link just now</h1>
            <p className="mt-3 text-ink-soft" role="status">
              Nothing was changed. Open the link again in a moment. Or reply to the email and say you would rather not hear from them:
              they are asked to stop at that, too.
            </p>
          </>
        ) : !found ? (
          <>
            <h1 className="t-h3">This link is not one we know</h1>
            <p className="mt-3 text-ink-soft">
              Open the link from the email itself. Or reply to the email and say you would rather not hear from them: they are
              asked to stop at that, too.
            </p>
          </>
        ) : found.everyone ? (
          <>
            <h1 className="t-h3">Nobody here can write to you</h1>
            <p className="mt-3 text-ink-soft">{`No store on Marktmorgen can prepare an email to ${found.domain} again. Nothing else is needed.`}</p>
          </>
        ) : (
          <>
            <h1 className="t-h3">{found.stopped || query.done === "1" ? `${who} cannot write to you again` : `Stop emails from ${who}?`}</h1>
            <p className="mt-3 text-ink-soft">
              {found.stopped || query.done === "1"
                ? `Their store can no longer prepare an email to ${found.domain}. You can also close ${found.domain} to every store here.`
                : `${who} wrote to ${found.domain} from their own mailbox, with a draft prepared here. One press and their store can never prepare another.`}
            </p>
            {found.stopped || query.done === "1" ? null : (
              <form action="/api/outreach/stop" method="post" className="mt-6">
                <input type="hidden" name="p" value={token} />
                <input type="hidden" name="scope" value="store" />
                <button type="submit" className="btn btn-primary btn-block">{`Stop emails from ${who}`}</button>
              </form>
            )}
            <form action="/api/outreach/stop" method="post" className="mt-3">
              <input type="hidden" name="p" value={token} />
              <input type="hidden" name="scope" value="all" />
              <button type="submit" className="btn btn-secondary btn-block">Stop emails from every Marktmorgen store</button>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-ink-mute">
          Marktmorgen sends none of these emails: a creator writes to a business from their own mailbox, at an address the
          business published on its own website. To keep our reader off your site altogether, see{" "}
          <Link href="/help#outreach" className="link">
            how Outreach works
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
