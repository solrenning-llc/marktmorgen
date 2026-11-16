import { withinStore } from "@/lib/metered-limits";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { clientAddress } from "@/lib/request-guard";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { imageUrl } from "@/lib/product-image";
import { canRecover } from "@/lib/buyer-orders";
import { doorFields, openDoor, readDoor } from "@/lib/review-proof";
import { type Review, readReview, reviewId } from "@/lib/reviews";
import { REVIEW_NOTICES, ReviewForm } from "@/components/review-form";
import { productPath } from "@/components/store-product";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${givingWords(store?.language).reviewMetaTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * Openings of this page with an order in it, from one connection to one
 * store, in ten minutes. Each asks the creator's Stripe account about the
 * order, so a script trying order numbers here would be spending the
 * creator's allowance with Stripe; a buyer reviewing needs a handful.
 */
const VIEWS_PER_TEN_MINUTES = 60;

/**
 * Where a buyer reviews what one order bought: reached from the list of
 * purchases or from the link in the email asking for a review.
 *
 * The order is read from the creator's Stripe account as the page opens
 * (lib/review-proof.ts), so a link to an order that was refunded, or that is
 * not this store's, shows no form at all. Each product in the order gets its
 * own form, filled in with the buyer's review when they already wrote one.
 */
export default async function ReviewPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();

  const query = await searchParams;
  const get = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : "");
  const door = readDoor(get);
  const status = get("status");
  const statusProduct = get("product");
  const allowed = door ? await withinStore("review-view", `${clientAddress({ headers: await headers() })}|${store.handle}`, VIEWS_PER_TEN_MINUTES, 600, store) : true;
  const opened = door && allowed ? await openDoor(store, door) : ({ state: allowed ? "no" : "slow" } as const);

  // A review of theirs that could not be read is unknown (CX-123 rule 24, inventory R24 item 13): its place says so,
  // never a blank form that would post over the review they already wrote, and never the error page.
  let existing = new Map<string, Review | null | "unknown">();
  if (opened.state === "ok" && store.statsId) {
    const statsId = store.statsId;
    const rows = await Promise.all(
      opened.proof.products.map(
        async (p) => [p.id, await readReview(statsId, p.id, reviewId(statsId, p.id, opened.proof.email)).catch(() => "unknown" as const)] as const,
      ),
    );
    existing = new Map(rows);
  }
  const existingKnown = (id: string): Review | null => {
    const review = existing.get(id);
    return review === "unknown" ? null : (review ?? null);
  };

  const said = speech(store);
  const g = givingWords(store.language);
  const problem =
    opened.state === "ok"
      ? opened.proof.refunded
        ? { title: g.orderRefundedTitle, body: g.orderRefundedBody(store.name) }
        : null
      : opened.state === "expired"
        ? {
            title: g.linkExpired,
            body: canRecover(store) ? g.expiredRecover : g.expiredReply(store.name),
          }
        : opened.state === "error"
          ? { title: g.wrongTitle, body: g.nothingChanged }
          : opened.state === "slow"
            ? { title: g.tooManyTries, body: g.tooManyBody }
            : { title: g.cannotReviewTitle, body: g.cannotReviewBody };

  return (
    <div
      lang={said.lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <div className="text-center">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={72} height={72} className="st-avatar" style={{ width: 72, height: 72 }} />
          ) : (
            <p aria-hidden="true" className="st-avatar st-avatar-initial" style={{ width: 72, height: 72, fontSize: "1.75rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </p>
          )}
          <p className="st-muted mt-4 text-sm font-semibold">{store.name}</p>
        </div>

        <div className="st-card mt-6 p-6 sm:p-9">
          {problem || opened.state !== "ok" ? (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{problem?.title}</h1>
              <p className="st-muted mt-4 text-lg leading-relaxed">{problem?.body}</p>
              {opened.state === "expired" && canRecover(store) ? (
                <Link href={`/@${store.handle}/orders`} className="btn st-btn btn-lg mt-7">
                  {g.getMyPurchases}
                </Link>
              ) : null}
            </>
          ) : (
            <>
              <p className="st-price text-sm">{said.w.verifiedPurchase}</p>
              <h1 className="font-display mt-5 text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {opened.proof.products.length === 1 ? g.reviewOne(opened.proof.products[0].title) : g.reviewAll}
              </h1>
              <p className="st-muted mt-3 leading-relaxed">
                {g.boughtFromOn(store.name, opened.proof.paidAt ? said.date(opened.proof.paidAt * 1000) : "")}
              </p>
              <div className="mt-8 space-y-10">
                {opened.proof.products.map((product) => (
                  <section key={product.id} aria-label={product.title} className="space-y-4">
                    {opened.proof.products.length > 1 || product.image ? (
                      <div className="flex items-center gap-3">
                        {product.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={imageUrl(product.image)} alt="" width={48} height={48} className="st-thumb" />
                        ) : null}
                        <Link href={productPath(store, product)} className="st-title-link font-semibold">
                          {product.title}
                        </Link>
                      </div>
                    ) : null}
                    {existing.get(product.id) === "unknown" ? (
                      <p role="status" className="st-note text-sm">
                        {g.reviewUnread(product.title)}
                      </p>
                    ) : (
                      <ReviewForm
                        handle={store.handle}
                        door={door ? doorFields(door) : {}}
                        product={{ id: product.id, title: product.title }}
                        existing={existingKnown(product.id)}
                        storeName={store.name}
                        back="review"
                        notice={statusProduct === product.id && REVIEW_NOTICES[status] ? status : null}
                        lang={said.lang.code}
                      />
                    )}
                  </section>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="mt-8 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {said.w.backTo(store.name)}
          </Link>
        </div>
      </main>
    </div>
  );
}
