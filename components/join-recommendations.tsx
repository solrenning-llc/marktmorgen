/**
 * 119 [F2-FREE-RECOMMENDATIONS]: the stores a creator recommends, under the
 * welcome after a sign-up is confirmed (app/[handle]/join/page.tsx). Plain
 * links to each store's own page, with nothing about the subscriber in them,
 * no form and no box to tick: joining another list is the subscriber's own
 * choice, made on that store's page. The stores come from lib/join-recommend.ts.
 */
import Link from "next/link";
import { joinWords } from "@/lib/buyer-words/join";
import type { Recommended } from "@/lib/join-recommend";

export function JoinRecommendations({ from, stores, language }: { from: string; stores: readonly Recommended[]; language: string }) {
  if (stores.length === 0) return null;
  const w = joinWords(language);
  return (
    <section aria-labelledby="join-recommended" className="mt-8 border-t border-current/15 pt-6">
      <h2 id="join-recommended" className="text-lg font-semibold">{w.recommendHeading(from)}</h2>
      <p className="st-muted mt-2 text-sm">{w.recommendNote}</p>
      <ul className="mt-4 grid gap-2">
        {stores.map((store) => (
          <li key={store.handle}>
            <Link href={`/@${store.handle}`} className="st-footer-link inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              {store.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
