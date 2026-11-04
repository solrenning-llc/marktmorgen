import Link from "next/link";
import { afterPurchaseLine } from "@/lib/buyer-words/reviews";
import { Stars } from "@/components/review-stars";
import { type Review, type Summary, average, showsRating } from "@/lib/review-summary";
import { speechFor } from "@/lib/buyer-words";
import { DEFAULT_LANGUAGE, type LanguageCode } from "@/lib/store-language";
import { imageUrl } from "@/lib/product-image";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { NewTab } from "@/components/new-tab";

/**
 * The store's words for its reviews, in its language (lib/store-language.ts).
 * Currency plays no part here, so any will do.
 */
const said = (lang: LanguageCode) => speechFor(lang, "usd");

/** "12 verified reviews". */
export function countWords(count: number, lang: LanguageCode = DEFAULT_LANGUAGE): string {
  const { w, num } = said(lang);
  return w.verifiedReviews(count, num(count));
}

/**
 * The small line a store card and the top of a product's page carry: the
 * stars, the average and how many — only when lib/reviews.ts says a page may
 * show them.
 */
export function RatingLine({
  summary,
  href,
  className = "",
  lang = DEFAULT_LANGUAGE,
}: {
  summary: Summary;
  href?: string;
  className?: string;
  lang?: LanguageCode;
}) {
  if (!showsRating(summary)) return null;
  const { w, num } = said(lang);
  const shown = average(summary).toLocaleString(said(lang).lang.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const body = (
    <>
      <Stars value={average(summary)} size={15} label={w.ratedFrom(shown, countWords(summary.count, lang))} />
      <span className="font-bold tabular-nums" aria-hidden="true">
        {shown}
      </span>
      <span className="st-muted" aria-hidden="true">
        {`(${num(summary.count)})`}
      </span>
    </>
  );
  return href ? (
    <a href={href} className={`rv-line ${className}`}>
      {body}
    </a>
  ) : (
    <span className={`rv-line ${className}`}>{body}</span>
  );
}

/** One review as the page shows it: stars, the name the buyer chose, what they wrote, and any answer. */
export function ReviewItem({
  review,
  storeName,
  lang = DEFAULT_LANGUAGE,
  picked = false,
}: {
  review: Review;
  storeName: string;
  lang?: LanguageCode;
  /** One the creator chose to show first: said so, never passed off as the newest. */
  picked?: boolean;
}) {
  const { w, date } = said(lang);
  return (
    <li className="rv-item">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Stars value={review.rating} size={16} label={w.starsOutOf5(review.rating)} />
        <span className="font-semibold">{review.name || w.verifiedBuyer}</span>
        <span className="rv-badge">
          <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {w.verifiedPurchase}
        </span>
        {review.refunded ? <span className="rv-badge rv-badge-muted">{w.refundedNotCounted}</span> : null}
        {picked ? <span className="rv-badge rv-badge-muted">{w.pickedByCreator}</span> : null}
      </div>
      <p className="st-muted mt-1 text-xs">
        {date(review.createdAt)}
        {review.editedAt ? w.edited(date(review.editedAt)) : ""}
        {/* How long after paying it was first written (606 [WP5]), when the order's time was kept. */}
        {review.paidAt ? (() => {
          const after = afterPurchaseLine(lang, review.paidAt, Math.floor(review.createdAt / 1000));
          return after ? ` · ${after}` : "";
        })() : ""}
      </p>
      {review.text ? <p className="mt-3 whitespace-pre-line leading-relaxed [overflow-wrap:anywhere]">{review.text}</p> : null}
      {/* The buyer's photo (lib/review-photo.ts), small here and whole when opened. */}
      {review.photo ? (
        <a href={imageUrl(review.photo)} target="_blank" rel="noopener" className="rv-photo mt-3 inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl(review.photo)}
            alt={GIVING_WORDS[lang].reviewPhotoAlt(review.name || w.verifiedBuyer)}
            width={review.photo.width}
            height={review.photo.height}
            loading="lazy"
            decoding="async"
            className="h-28 w-28 overflow-hidden rounded-xl bg-[var(--st-line)] object-cover text-[0px] sm:h-32 sm:w-32"
          />
        <NewTab /></a>
      ) : null}
      {review.reply ? (
        <div className="rv-reply">
          <p className="text-sm font-bold">{w.replyFrom(storeName)}</p>
          <p className="mt-1 whitespace-pre-line text-[0.9375rem] leading-relaxed [overflow-wrap:anywhere]">{review.reply.text}</p>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The reviews part of a product's page: the average and how the stars fall,
 * the rules in a sentence, how many the creator hid, and the newest reviews.
 */
export function ReviewsSection({
  heading,
  summary,
  reviews,
  storeName,
  productTitle,
  moreHref,
  preview = false,
  lang = DEFAULT_LANGUAGE,
  picked = [],
}: {
  heading: string;
  summary: Summary;
  reviews: Review[];
  storeName: string;
  productTitle: string;
  /** Where the rest are, when there are more than these. */
  moreHref: string | null;
  preview?: boolean;
  /** The store's language (lib/store-language.ts). */
  lang?: LanguageCode;
  /** The reviews the creator picked to show first, marked as such. */
  picked?: string[];
}) {
  const rated = showsRating(summary);
  const { w, num } = said(lang);
  const hidden = summary.hidden ? w.hiddenByCreator(summary.hidden) : "";
  const shown = average(summary).toLocaleString(said(lang).lang.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <div id="reviews" className="scroll-mt-6">
      <h2 className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-[1.75rem]">{heading || w.reviews}</h2>
      {rated ? (
        <div className="rv-summary mt-5">
          <div>
            <p className="font-display text-5xl font-semibold leading-none tabular-nums">{shown}</p>
            <div className="mt-2">
              <Stars value={average(summary)} size={18} label={w.ratedOutOf5(shown)} />
            </div>
            <p className="st-muted mt-2 text-sm font-semibold">{countWords(summary.count, lang)}</p>
          </div>
          <ul className="rv-dist" aria-label={w.starsSpread}>
            {[5, 4, 3, 2, 1].map((stars) => {
              const n = summary.dist[stars - 1];
              const share = summary.count ? Math.round((n / summary.count) * 100) : 0;
              return (
                <li key={stars} className="flex items-center gap-2 text-sm">
                  <span className="w-12 shrink-0 tabular-nums">{w.starLabel(stars)}</span>
                  <span className="rv-bar" aria-hidden="true">
                    <span style={{ width: `${share}%` }} />
                  </span>
                  <span className="st-muted w-10 shrink-0 text-right tabular-nums">{`${share}%`}</span>
                  <span className="sr-only">{w.reviewCount(n)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <p className="st-muted mt-4 text-sm">
        {w.reviewRules(productTitle, storeName)}
      </p>
      {hidden || summary.refunded ? (
        <p className="mt-2 text-sm font-semibold">
          {[hidden, summary.refunded ? w.refundedOrders(summary.refunded) : ""]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {reviews.length > 0 ? (
        <ul className="mt-6 space-y-3">
          {reviews.map((review) => (
            <ReviewItem key={review.id} review={review} storeName={storeName} lang={lang} picked={picked.includes(review.id)} />
          ))}
        </ul>
      ) : preview ? (
        <p className="st-note mt-6 text-sm">{w.noReviewsYet}</p>
      ) : null}
      {moreHref ? (
        <p className="mt-5">
          <Link prefetch={false} href={moreHref} className="st-footer-link text-sm font-semibold underline underline-offset-4">
            {w.seeAllReviews(num(summary.visible))}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
