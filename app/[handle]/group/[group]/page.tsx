import { EmailField } from "@/components/email-field";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { readListing } from "@/lib/catalog";
import { GROUP_ID, PLACE_TOKEN, placesWords } from "@/lib/group-rules";
import { type Taken, groupTitle, placesTaken, readGroup, takePlace } from "@/lib/group-buy";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { recordEnrollment } from "@/lib/learn";
import { storeBase } from "@/lib/purchase-email";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";

type Params = {
  params: Promise<{ handle: string; group: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${givingWords(store?.language).groupMetaTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/** A sentence with the title in bold where the words put it. */
function withTitle(sentence: (title: string) => string, title: string): React.ReactNode {
  const mark = "\u0001";
  const [before, after = ""] = sentence(mark).split(mark);
  return (
    <>
      {before}
      <strong style={{ color: "var(--st-text)" }}>{title}</strong>
      {after}
    </>
  );
}

/**
 * The page the link of a purchase for several people opens (lib/group-buy.ts).
 * Anybody holding the link can ask for a place: they type their own address
 * and are emailed a link, and the place is taken when that link is opened
 * (?take=…, the same page), so a mistyped address takes nothing. Who else
 * took a place is never shown here, only how many are left.
 */
export default async function GroupPage({ params, searchParams }: Params) {
  const { handle: raw, group: id } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@") || !GROUP_ID.test(id)) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const group = await readGroup(id);
  // Not this store's, or never paid for: there is nothing here to describe.
  if (!group || !store.statsId || group.s !== store.statsId || !group.paid) notFound();
  const product = await readListing(store, group.p);
  if (!product) notFound();

  // Bought at one of the product's prices: named with it everywhere here.
  const title = groupTitle(product, group);
  const said = speech(store);
  const g = givingWords(store.language);

  const query = await searchParams;
  const read = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : "");
  const status = read("status");
  const token = read("take");
  const base = storeBase(store);
  const shell = (body: React.ReactNode) => (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          {body}
          <div className="mt-8">
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {said.w.seeStore(store.name)}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );

  if (group.revoked) {
    return shell(
      <>
        <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{g.groupRefundedTitle}</h1>
        <p className="st-muted mt-4 text-lg">{g.groupRefundedBody(title, group.people)}</p>
      </>,
    );
  }

  // The link from a place's email: the place is taken now, once.
  let taken: Taken | null = null;
  if (PLACE_TOKEN.test(token)) {
    taken = await takePlace({
      store,
      token,
      recordStart: async (email, productId, start) => {
        const course = productId === product.id ? product : await readListing(store, productId);
        if (course?.course) await recordEnrollment(store, email, productId, start);
      },
    }).catch((error) => {
      console.error("taking a place failed", error);
      return null;
    });
    if (taken && taken.outcome !== "gone" && taken.outcome !== "full" && taken.outcome !== "resting") {
      const link = (await ordersLinkFor(store, taken.email, base).catch(() => null)) ?? `${base}/orders`;
      const email = taken.email;
      return shell(
        <>
          <p className="st-price text-sm">{taken.outcome === "has" ? g.alreadyYours : g.done}</p>
          <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">
            {taken.outcome === "has" ? g.hasItTitle : g.placeYours}
          </h1>
          <p className="st-muted mt-4 text-lg">
            {withTitle((t) => (taken?.outcome === "has" ? g.placeHas(t, email) : g.placeTaken(t, email)), title)}
          </p>
          <div className="mt-7">
            <a href={link} className="btn st-btn btn-lg">{g.openIt}</a>
          </div>
          <p className="st-muted mt-5 text-sm">{g.laterOrders(base.replace(/^https?:\/\//, ""))}</p>
        </>,
      );
    }
  }

  const count = await placesTaken(group.id).catch(() => 0);
  const left = Math.max(0, group.people - count);
  const notice =
    taken?.outcome === "full"
      ? g.groupNotices.full
      : taken?.outcome === "resting"
        ? g.groupNotices.resting
      : taken?.outcome === "gone" || (token && !taken)
        ? g.groupNotices.expired
        : status !== "expired" ? g.groupNotices[status] ?? null : null;

  return shell(
    <>
      {notice ? (
        <div className="st-note mb-7 text-sm" role="status">
          <p className="font-semibold">{notice.title}</p>
          <p className="mt-1">{notice.body}</p>
        </div>
      ) : null}
      <p className="st-price text-sm">{g.paidForYou}</p>
      <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{title}</h1>
      <p className="st-muted mt-4 text-lg">
        {g.boughtForPeople(store.name, group.people, placesWords(group.people, count, store.language))}
      </p>
      {left > 0 ? (
        <form action="/api/store/group" method="post" className="mt-8 space-y-3">
          <input type="hidden" name="handle" value={store.handle} />
          <input type="hidden" name="group" value={group.id} />
          {/* Left empty by a person; filled in by something that fills in every field. */}
          <div aria-hidden="true" className="hidden">
            <label>
              {said.w.leaveEmpty}
              <input type="text" name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          <label htmlFor="place-email" className="st-label">
            {said.w.yourEmail}
          </label>
          <EmailField id="place-email" name="email" className="st-field" required autoComplete="email" placeholder={said.w.emailPlaceholder} language={store.language} />
          <button type="submit" className="btn st-btn btn-block">{g.sendPlaceLink}</button>
          <p className="st-muted text-xs">{g.placeNote(title)}</p>
        </form>
      ) : null}
      <p className="st-muted mt-6 text-sm">
        {`${g.alreadyTook} `}
        <Link href={`/@${store.handle}/orders`} className="st-footer-link font-semibold">
          {g.openAgain}
        </Link>
      </p>
    </>,
  );
}
