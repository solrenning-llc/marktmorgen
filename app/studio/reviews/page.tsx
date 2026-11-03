import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { productIds, readListings } from "@/lib/catalog";
import { studioPath, studioView } from "@/lib/studio-route";
import { can } from "@/lib/team-roles";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { canWrite } from "@/lib/mail";
import { HIDDEN_RULE, OVERVIEW_READ_MAX, type StudioRow, averageText, reviewsSince, showsRating, studioReviews, summaries } from "@/lib/reviews";
import { OVERVIEW_MONTHS, byMonth, monthAverage, monthStart } from "@/lib/review-overview";
import { ReviewAskEditor, ReviewRow, SeenAllButton, type StudioReview } from "@/components/review-studio";
import { ReviewQr } from "@/components/review-qr";
import { ReviewThemes } from "@/components/review-themes";
import { readVoice } from "@/lib/customer-voice";
import { canRecover } from "@/lib/buyer-orders";
import { storeBase } from "@/lib/purchase-email";
import { AiOn } from "@/components/ai-assist";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import { Stars } from "@/components/review-stars";
import { imageUrl } from "@/lib/product-image";

export const metadata: Metadata = {
  title: "Reviews — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const PAGE_SIZE = 20;
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The buyers' reviews of a store: the queue of what arrived since the
 * creator last looked, every review, the numbers per product, and the one
 * email that asks for them. On every plan; the email is Pro, like all email.
 */
export default async function StudioReviewsPage({ searchParams }: Params) {
  const query = await searchParams;
  // Which store, and whether this person's role there has "reviews" (lib/studio-route.ts):
  // the owner, Admins, Editors and Support all answer buyers.
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "reviews");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;

  // The writing help, for a reply drafted from a review (lib/ai.ts, replyToReview).
  const ai = aiAvailableFor(store) ? { on: true, left: await aiLeft(store).catch(() => 0) } : { on: false, left: 0 };
  const queue = query.view !== "all";
  const asked = Number(typeof query.page === "string" ? query.page : "1");
  const page = Number.isInteger(asked) && asked >= 1 ? asked : 1;
  // The request's own time, read once on the server, for the months below (636 [GL4](c)).
  const now = new Date().getTime();
  const [list, numbers, recent] = await Promise.all([
    studioReviews(store.statsId, { queue, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }).catch(() => null),
    summaries(store.statsId),
    reviewsSince(store.statsId, monthStart(now, OVERVIEW_MONTHS - 1)).catch(() => null),
  ]);
  const months = recent ? byMonth(recent.reviews, now) : null;
  const listKnown = list !== null;
  const current = list ?? { rows: [], total: 0, unseen: 0 };
  // Only the products that have reviews, or are on this page of them, are
  // read (lib/catalog.ts), in the store's own order.
  const wanted = new Set([...numbers.keys(), ...current.rows.map((r: StudioRow) => r.productId)]);
  const named = await readListings(store, productIds(store).filter((id) => wanted.has(id)));
  const titles = new Map(named.map((p) => [p.id, p.title]));
  const rows: StudioReview[] = current.rows.map((r: StudioRow) => ({
    id: r.id,
    productId: r.productId,
    productTitle: titles.get(r.productId) ?? "A product no longer in the store",
    reference: r.reference,
    rating: r.rating,
    text: r.text,
    name: r.name,
    date: DATE.format(new Date(r.createdAt)),
    edited: r.editedAt ? DATE.format(new Date(r.editedAt)) : "",
    hidden: r.hidden,
    hiddenReason: r.hiddenReason ?? "",
    refunded: r.refunded,
    reply: r.reply?.text ?? "",
    unseen: r.unseen,
    photo: r.photo ? imageUrl(r.photo) : null,
  }));
  const pages = Math.max(1, Math.ceil(current.total / PAGE_SIZE));
  const reviewed = named.filter((p) => (numbers.get(p.id)?.visible ?? 0) + (numbers.get(p.id)?.hidden ?? 0) > 0);
  const tab = (view: "new" | "all", label: string) => (
    <Link
      href={studioPath(store, view === "new" ? "" : "view=all", "reviews")}
      aria-current={(view === "new") === queue ? "page" : undefined}
      className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold ${
        (view === "new") === queue ? "bg-white text-ink shadow-sm ring-1 ring-line" : "text-ink-soft hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={view.role}
        stores={view.stores}
        owned={view.owned}
        action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>
      <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
        <p className="eyebrow">Reviews</p>
        <h1 className="t-h2 mt-3">What your buyers say</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          Only people who paid can review, from their thank-you page, their list of purchases or the one email that asks. Each
          review is checked against its order with Stripe and keeps that order, so you can find the payment behind it. Reviews
          go on your product&apos;s page and store card as they arrive; a refund in full takes a review&apos;s stars out of
          the average.
        </p>

        <div className="mt-8 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <section aria-labelledby="queue-title" className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="queue-title" className="sr-only">
                {queue ? "New reviews" : "Every review"}
              </h2>
              <div className="inline-flex rounded-full bg-sand/60 p-1 ring-1 ring-line">
                {tab("new", current.unseen ? `New (${current.unseen})` : "New")}
                {tab("all", "Every review")}
              </div>
              {queue && listKnown ? <SeenAllButton count={current.unseen} /> : null}
            </div>

            {!listKnown ? (
              <div role="status" className="card mt-5 p-6 sm:p-8">
                <p className="text-lg font-semibold text-ink">Reviews could not be verified</p>
                <p className="mt-2 text-ink-soft">Reload to check your reviews. An unavailable list does not mean there are no reviews or that every review has been seen.</p>
              </div>
            ) : rows.length === 0 ? (
              <div className="card mt-5 p-6 sm:p-8">
                <p className="text-lg font-semibold tracking-[-0.02em] text-ink">{current.total > 0 ? "No reviews on this page" : queue ? "Nothing new" : "No reviews yet"}</p>
                <p className="mt-2 text-ink-soft">
                  {current.total > 0
                    ? "Choose an earlier page to see the reviews in this list."
                    : queue
                    ? "Every review has been seen. New ones, and reviews their buyers change, come back here."
                    : "When a buyer reviews something, it appears here and on the product's page at the same moment."}
                </p>
                {/* Only when the store has no review at all, on either tab, and only for a role that can switch the requests on. */}
                {current.total === 0 && numbers.size === 0 && can(view.role, "settings") ? (
                  <a href="#asking-for-reviews" className="mt-3 inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-4">
                    Ask buyers for a review
                  </a>
                ) : null}
              </div>
            ) : (
              <AiOn value={ai}>
                <ul className="mt-5 space-y-3">
                  {rows.map((review) => (
                    <ReviewRow key={`${review.productId}|${review.id}`} review={review} />
                  ))}
                </ul>
              </AiOn>
            )}

            {listKnown && pages > 1 ? (
              <nav aria-label="Pages" className="mt-6 flex items-center justify-between gap-3 text-sm font-semibold">
                {page > 1 ? (
                  <Link href={studioPath(store, new URLSearchParams({ ...(queue ? {} : { view: "all" }), page: String(page - 1) }).toString(), "reviews")} className="btn btn-secondary btn-sm">
                    Newer
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-ink-soft">{`Page ${page} of ${pages}`}</span>
                {page < pages ? (
                  <Link href={studioPath(store, new URLSearchParams({ ...(queue ? {} : { view: "all" }), page: String(page + 1) }).toString(), "reviews")} className="btn btn-secondary btn-sm">
                    Older
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            ) : null}
          </section>

          <aside className="min-w-0 space-y-6 lg:sticky lg:top-24">
            <div className="card p-5 sm:p-6">
              <p className="font-semibold text-ink">Hiding, honestly</p>
              <p className="mt-2 text-sm text-ink-soft">{HIDDEN_RULE}</p>
              <p className="mt-2 text-sm text-ink-soft">
                You can reply in public, with a draft written by AI if you like, and hide a review. You cannot change a word of it or delete it: only its buyer can.
              </p>
            </div>

            <div className="card p-5 sm:p-6">
              <p className="font-semibold text-ink">By product</p>
              {reviewed.length === 0 ? (
                <p className="mt-2 text-sm text-ink-soft">No product review totals are available in this view.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {reviewed.map((p) => {
                    const n = numbers.get(p.id)!;
                    return (
                      <li key={p.id} className="text-sm">
                        <p className="truncate font-semibold text-ink">{p.title}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-ink-soft">
                          {showsRating(n) ? (
                            <>
                              <span className="text-violet-deep">
                                <Stars value={n.stars / n.count} size={13} />
                              </span>
                              <span className="font-semibold text-ink">{averageText(n)}</span>
                            </>
                          ) : null}
                          <span>{`${n.count} counted`}</span>
                          {n.hidden ? <span>{`· ${n.hidden} hidden`}</span> : null}
                          {n.refunded ? <span>{`· ${n.refunded} refunded`}</span> : null}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Only where the purchases page works for buyers (lib/buyer-orders.ts): otherwise the code would open a dead end. */}
            {canRecover(store) ? (
              <section aria-labelledby="in-person-title" className="card p-5 sm:p-6">
                <h2 id="in-person-title" className="font-semibold text-ink">Buyers you meet in person</h2>
                <div className="mt-2">
                  <ReviewQr url={`${storeBase(store)}/orders`} storeName={store.name} />
                </div>
              </section>
            ) : null}

            <section aria-labelledby="by-month-title" className="card p-5 sm:p-6">
              <h2 id="by-month-title" className="font-semibold text-ink">By month</h2>
              {!months ? (
                <p className="mt-2 text-sm text-ink-soft" role="status">The months could not be read just now. Reload to try again; this does not mean there were no reviews.</p>
              ) : months.every((m) => m.count === 0 && m.refunded === 0) ? (
                <p className="mt-2 text-sm text-ink-soft">No reviews in the last {OVERVIEW_MONTHS} months.</p>
              ) : (
                <>
                  <table className="mt-3 w-full text-left text-sm">
                    <caption className="sr-only">Reviews and their average stars in each of the last {OVERVIEW_MONTHS} months, newest first</caption>
                    <thead>
                      <tr className="text-ink-soft">
                        <th scope="col" className="py-1 pr-2 font-semibold">Month</th>
                        <th scope="col" className="py-1 pr-2 text-right font-semibold">Reviews</th>
                        <th scope="col" className="py-1 text-right font-semibold">Average</th>
                      </tr>
                    </thead>
                    <tbody>
                      {months.map((m) => {
                        const avg = monthAverage(m);
                        return (
                          <tr key={m.month} className="border-t border-line">
                            <th scope="row" className="py-1.5 pr-2 font-normal text-ink">{m.label}</th>
                            <td className="py-1.5 pr-2 text-right tabular-nums text-ink">
                              {m.count}
                              {m.refunded ? <span className="text-ink-soft">{` + ${m.refunded} refunded`}</span> : null}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-ink">{avg === null ? <span aria-label="none">–</span> : `${avg.toFixed(1)} of 5`}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-ink-soft">
                    Every review counts the same, one star as much as five; a hidden review still counts, and a refunded one is shown apart and left out of the average, as on your product pages. Months in UTC.
                    {recent && !recent.complete ? ` Only the newest ${OVERVIEW_READ_MAX.toLocaleString("en-US")} reviews are counted here, so the oldest months may show fewer.` : ""}
                  </p>
                </>
              )}
            </section>

            <ReviewThemes voice={await readVoice(store).catch(() => null)} studioHome={studioPath(store)} />

            <div className="card p-5 sm:p-6">
              <h2 id="asking-for-reviews" tabIndex={-1} className="font-semibold text-ink">Asking for reviews</h2>
              <div className="mt-3">
                {/* The email is a store setting (lib/team-roles.ts): the owner and Admins switch it. */}
                {can(view.role, "settings") ? (
                  <ReviewAskEditor days={store.reviewAsk.days} canEmail={canWrite(store)} elsewhere={store.reviewAsk.elsewhere?.url ?? ""} />
                ) : (
                  <p className="text-sm text-ink-soft">
                    {store.reviewAsk.days > 0
                      ? `Buyers are emailed once, ${store.reviewAsk.days} days after buying, to ask for a review. The store's owner or an Admin changes this.`
                      : "Buyers are not emailed to ask for a review. The store's owner or an Admin can switch it on."}
                  </p>
                )}
              </div>
            </div>
          </aside>
        </div>
      </main>
      </StudioStorePin>
    </div>
  );
}
