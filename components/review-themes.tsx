import Link from "next/link";
import type { VoiceSummary } from "@/lib/customer-voice";

/**
 * What reviewers keep saying (636 [GL4](c)): the themes of the store's
 * customer voice (lib/customer-voice.ts) that reviews are part of, with up to
 * three reviews in their writers' own words under each. AI only names a
 * theme; the count and the words are the reviewers'. Every rating counts the
 * same, one star as five (16 CFR Part 465): nothing here is filtered by stars.
 * Read from the month's summary already made: no AI job of its own.
 */
export function ReviewThemes({ voice, studioHome }: { voice: VoiceSummary | null; studioHome: string }) {
  const themes = (voice?.themes ?? [])
    .map((theme) => ({ ...theme, reviews: theme.sources.review ?? 0, said: theme.examples.filter((e) => e.source === "review") }))
    .filter((theme) => theme.reviews > 0);
  return (
    <section aria-labelledby="review-themes-title" className="card p-5 sm:p-6">
      <h2 id="review-themes-title" className="font-semibold text-ink">What reviewers keep saying</h2>
      {!voice ? (
        <p className="mt-2 text-sm text-ink-soft">
          Made once a month with your customer voice, from reviews and the other things customers write.{" "}
          <Link href={studioHome} className="underline underline-offset-4">Make it on your studio&apos;s home page</Link>.
        </p>
      ) : themes.length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">No theme was repeated in reviews in the last 90 days.</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-ink-soft">AI named each theme; the counts and the words are your reviewers&apos;. Every rating counts the same.</p>
          <ul className="mt-3 space-y-4">
            {themes.map((theme) => (
              <li key={theme.title} className="text-sm">
                <p className="font-semibold text-ink">
                  <span className="sr-only">Theme named by AI: </span>
                  {theme.title}
                  <span className="font-normal text-ink-soft">{` · ${theme.reviews} ${theme.reviews === 1 ? "review" : "reviews"}`}</span>
                </p>
                {theme.said.length ? (
                  <ul className="mt-1 space-y-1">
                    {theme.said.map((e, i) => (
                      <li key={i} className="text-ink-soft">
                        <q>{e.text}</q>
                        {typeof e.stars === "number" ? <span>{` · ${e.stars} ${e.stars === 1 ? "star" : "stars"}`}</span> : null}
                        {e.product ? <span>{` · ${e.product}`}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
