import { Fragment } from "react";
import { MAX_REVIEW_NAME, MAX_REVIEW_TEXT, type Review } from "@/lib/review-summary";
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";
import { wordsIn } from "@/lib/buyer-words";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { ReviewPhotoField } from "@/components/review-photo-field";
import { imageUrl } from "@/lib/product-image";

/** Notices that report something done, rather than something that went wrong. */
const DONE = new Set(["saved", "updated", "deleted", "photoPaused"]);

/**
 * What happened to the last thing sent, in the buyer's words: the notices a
 * page may name in its address, in English. Each language's text for them is
 * in lib/buyer-words/giving.ts (reviewNotices), under the same names.
 */
export const REVIEW_NOTICES: Record<string, { text: string; alert?: boolean }> = Object.fromEntries(
  Object.entries(GIVING_WORDS.en.reviewNotices).map(([key, text]) => [key, DONE.has(key) ? { text } : { text, alert: true }]),
);

/**
 * The form a buyer reviews one product with: stars, a few words, a photo if
 * they like (components/review-photo-field.tsx), the name to show. Plain HTML that works without JavaScript, posting to
 * /api/store/review with whatever proves the order (lib/review-proof.ts) in
 * hidden fields; nothing sent here can say who the buyer is.
 *
 * The stars are five radio buttons, so a keyboard moves through them with
 * the arrow keys and a screen reader hears "4 stars, 4 of 5". Every star up
 * to the one chosen is coloured by CSS alone (app/globals.css, .rv-rate).
 */
export function ReviewForm({
  handle,
  door,
  product,
  existing,
  storeName,
  back,
  notice,
  lang = "en",
}: {
  handle: string;
  /** The hidden fields that prove the order. */
  door: Record<string, string>;
  product: { id: string; title: string };
  existing: Review | null;
  storeName: string;
  /** Which page the answer comes back to. */
  back: "thanks" | "review";
  notice: string | null;
  /** The store's language (lib/store-language.ts); English when left out. */
  lang?: LanguageCode;
}) {
  const code = parseLanguage(lang);
  const g = GIVING_WORDS[code];
  const w = wordsIn(code);
  const base = `rv-${product.id}`;
  const known = notice ? REVIEW_NOTICES[notice] ?? null : null;
  const said = known && notice ? { text: g.reviewNotices[notice] ?? known.text, alert: known.alert } : null;
  const hidden = (
    <>
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="product" value={product.id} />
      <input type="hidden" name="back" value={back} />
      {Object.entries(door).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
  return (
    <div id={`r-${product.id}`} className="scroll-mt-6">
      {said ? (
        <p className={said.alert ? "st-note mb-4 text-sm" : "rv-done mb-4 text-sm font-semibold"} role={said.alert ? "alert" : "status"}>
          {said.text}
        </p>
      ) : null}
      <form action="/api/store/review" method="post" className="space-y-4">
        {hidden}
        <input type="hidden" name="action" value="save" />
        <div aria-hidden="true" className="hidden">
          <label>
            {w.leaveEmpty}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <fieldset>
          <legend className="st-label">{g.yourRating(product.title)}</legend>
          <div className="rv-rate mt-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <Fragment key={n}>
                <input
                  id={`${base}-${n}`}
                  type="radio"
                  name="rating"
                  value={n}
                  required
                  defaultChecked={existing?.rating === n}
                  className="rv-rate-input"
                />
                <label htmlFor={`${base}-${n}`} className="rv-rate-star">
                  <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path
                      d="m12 3.8 2.5 5.1 5.6.8-4.05 3.95.96 5.6L12 16.6l-5.01 2.65.96-5.6L3.9 9.7l5.6-.8L12 3.8Z"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="sr-only">{w.starLabel(n)}</span>
                </label>
              </Fragment>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor={`${base}-text`} className="st-label">
            {g.whatYouThink}
          </label>
          <textarea
            id={`${base}-text`}
            name="text"
            rows={4}
            maxLength={MAX_REVIEW_TEXT}
            defaultValue={existing?.text ?? ""}
            className="st-field mt-1"
            aria-describedby={`${base}-text-hint`}
          />
          <p id={`${base}-text-hint`} className="st-muted mt-1 text-xs">
            {g.upTo(MAX_REVIEW_TEXT.toLocaleString(LANGUAGES[code].locale))}
          </p>
        </div>
        <ReviewPhotoField
          id={`${base}-photo`}
          existing={existing?.photo ? imageUrl(existing.photo) : null}
          words={{ label: g.reviewPhoto, hint: g.reviewPhotoHint, remove: g.reviewPhotoRemove, yours: g.reviewPhotoYours, problem: g.reviewNotices.photo }}
        />
        <div>
          <label htmlFor={`${base}-name`} className="st-label">
            {g.nameToShow}
          </label>
          <input
            id={`${base}-name`}
            type="text"
            name="name"
            maxLength={MAX_REVIEW_NAME}
            autoComplete="given-name"
            placeholder={w.verifiedBuyer}
            defaultValue={existing?.name ?? ""}
            className="st-field mt-1"
          />
        </div>
        <button type="submit" className="btn st-btn">
          {existing ? g.updateReview : g.postReview}
        </button>
        <p className="st-muted text-xs leading-relaxed">{g.reviewPublic(storeName)}</p>
      </form>
      {existing ? (
        <form action="/api/store/review" method="post" className="mt-3">
          {hidden}
          <input type="hidden" name="action" value="delete" />
          <button type="submit" className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4">
            {g.deleteReview}
          </button>
        </form>
      ) : null}
    </div>
  );
}
