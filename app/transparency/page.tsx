import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { type YearCounts, transparencyCounts } from "@/lib/transparency";

export const metadata: Metadata = {
  title: "Notices about content — Marktmorgen",
  description: "How many notices about content on Marktmorgen stores we received, and how many we acted on, year by year.",
  robots: { index: true, follow: true },
};

/** Read when the page is asked for: the counts change as notices come in. */
export const dynamic = "force-dynamic";

const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const n = (value: number) => value.toLocaleString("en-US");

/**
 * The transparency page (624 [SZ8](47)): notices about content on a store
 * that we received and that we acted on, counted as they happen
 * (lib/transparency.ts). Only real counts, from the day counting began.
 */
export default async function TransparencyPage() {
  // A read that failed, or answered in an unknown shape, is said as not read: never "nothing counted" or a zero.
  const read = await transparencyCounts().catch((error: unknown) => {
    console.error("the transparency counts could not be read", error);
    return null;
  });
  const since = read?.since ?? null;
  const years: YearCounts[] = read?.years ?? [];
  const oldest = years.at(-1)?.year;
  return (
    <LegalPage title="Notices about content" eyebrow="Transparency" effective={null} legalNav={false}>
      <p>
        Anybody can tell us that something on a Marktmorgen store infringes their copyright or is otherwise illegal, with the
        form at <Link href="/report" className="text-black underline underline-offset-2 hover:no-underline">Report content</Link>. These are the notices we received and the ones we acted on, counted as they happen. Nothing here says who sent a notice or which store it was about.
      </p>
      {!read ? (
        <p className="notice notice-info" role="status">
          The counts could not be read just now. This does not mean no notice was received. Try again in a moment.
        </p>
      ) : !since ? (
        <p>No notice has been counted yet. Counting begins with the first notice.</p>
      ) : (
        <>
          <p>{`Counted from ${DAY.format(new Date(`${since}T00:00:00Z`))}. Orders from courts or authorities are not counted on this page.`}</p>
          {oldest && Number(oldest) > Number(since.slice(0, 4)) ? (
            <p className="notice notice-info" role="status">
              {`Counts are kept for about six years, so the years before ${oldest} are no longer kept and are not shown.`}
            </p>
          ) : null}
          {years.map((y) => (
            <section key={y.year} aria-labelledby={`year-${y.year}`}>
              <h2 id={`year-${y.year}`}>{y.year}</h2>
              <table>
                <caption className="sr-only">{`Notices received and acted on in ${y.year}`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Notice</th>
                    <th scope="col">Received</th>
                    <th scope="col">Acted on</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Copyright</th>
                    <td>{n(y.notices.copyright)}</td>
                    <td>{n(y.acted.copyright)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Other illegal content</th>
                    <td>{n(y.notices.other)}</td>
                    <td>{n(y.acted.other)}</td>
                  </tr>
                </tbody>
              </table>
              <p>
                {`What was done: ${n(y.steps.link)} ${y.steps.link === 1 ? "link" : "links"} removed, ${n(y.steps.product)} ${y.steps.product === 1 ? "product" : "products"} unpublished, ${n(y.steps.kit)} media ${y.steps.kit === 1 ? "kit" : "kits"} unpublished, ${n(y.steps.store)} ${y.steps.store === 1 ? "store" : "stores"} switched off. A notice can lead to more than one step, or to none when nothing on the store broke the law or our rules.`}
              </p>
            </section>
          ))}
        </>
      )}
      <p>
        How notices are handled, and how a creator can answer one, is in our{" "}
        <Link href="/copyright" className="text-black underline underline-offset-2 hover:no-underline">Copyright and Takedown Policy</Link>.
      </p>
    </LegalPage>
  );
}
