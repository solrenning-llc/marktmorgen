import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { ReportForm } from "@/components/report-form";

export const metadata: Metadata = {
  title: "Report content — Marktmorgen",
  description: "Tell us about content on a Marktmorgen store that infringes your copyright or is illegal.",
  robots: { index: false, follow: true },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** The notice form (lib/takedown.ts), reached from the foot of every store page with that page's address filled in. */
export default async function ReportPage({ searchParams }: Params) {
  const query = await searchParams;
  const url = typeof query.url === "string" && /^https?:\/\//.test(query.url) ? query.url.slice(0, 500) : "";
  return (
    <LegalPage title="Report content" eyebrow="Copyright and illegal content" effective={null} legalNav={false}>
      <p>
        Use this form to tell us that something on a Marktmorgen store infringes your copyright or is otherwise illegal.
        What happens next, and how a creator can answer, is in our{" "}
        <Link href="/copyright" className="text-black underline underline-offset-2 hover:no-underline">
          Copyright and Takedown Policy
        </Link>
        . Everything you write is sent to the creator in substance if we take their content down, and your name and email
        may be passed on with a counter-notice, as the law requires.
      </p>
      <p>
        To report a child being sexually exploited, or an intimate image of you shared without your consent, choose it below:
        a product reported for child sexual exploitation usually comes off the store at once, and when it does not we act on it
        by hand; an intimate image is removed within 48 hours; and you never need to send or describe the images. You can also report child sexual abuse
        material to the National Center for Missing &amp; Exploited Children at{" "}
        <a href="https://report.cybertip.org" className="text-black underline underline-offset-2 hover:no-underline">
          report.cybertip.org
        </a>
        .
      </p>
      <p>
        How many notices we received and acted on, year by year:{" "}
        <Link href="/transparency" className="text-black underline underline-offset-2 hover:no-underline">
          Notices about content
        </Link>
        .
      </p>
      <div className="not-prose mt-8">
        <ReportForm url={url} />
      </div>
    </LegalPage>
  );
}
