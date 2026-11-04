import { Fragment } from "react";
import Link from "next/link";
import { NewTab } from "@/components/new-tab";
import { LicenceKeyBox, type LicenceKeyWords } from "@/components/licence-key-box";
import { OrdersBundle, type OrdersBundleWords } from "@/components/orders-bundle";

/** A way to open what was bought: its address and what its button says. */
export type CardLink = { href: string; label: string };

/** A file to download, or a link kept elsewhere with the address said as text. */
export type CardDelivery = { href: string; label: string; external: boolean; keptOn: string | null };

/** A license key on the card, already in the store's language. */
export type CardKey = { slot: string; title?: string; label: string; value: string | null; revoked: boolean; waiting: boolean };

/**
 * One purchase on the buyer's list, as lib/purchase-cards.ts (cardOf) reads it:
 * only words, addresses and yes-or-no, so the same card is drawn by the page
 * and by the batch of older purchases the buyer asks to check
 * (components/older-purchases.tsx), whichever draws it.
 */
export type PurchaseCardModel = {
  reference: string;
  title: string;
  meta: string;
  preorderLine: string | null;
  ended: { note: string; renew: CardLink } | null;
  course: CardLink | null;
  package: CardLink | { text: string } | null;
  podcast: CardLink | null;
  alsoIn: string | null;
  main: CardDelivery | null;
  added: { key: string; course: CardLink | null; delivery: CardDelivery | null }[];
  importedNote: string | null;
  bundles: { key: string; address: string; heading: string; show: string; hide: string }[];
  keys: CardKey[];
  review: CardLink | null;
  /** The words every bundle and key box on the card shares. */
  shared: Pick<OrdersBundleWords, "loading" | "failed" | "bundle" | "key">;
};

function Delivery({ delivery, language }: { delivery: CardDelivery; language: unknown }) {
  if (delivery.external) {
    return (
      <span className="block">
        <a href={delivery.href} rel="noopener noreferrer" target="_blank" className="btn st-btn btn-block">
          {delivery.label}
        <NewTab language={language} /></a>
        {/* The address as text, cut to LINK_SHOWN characters: the whole of it is the button's, one click away (C3-80). */}
        {delivery.keptOn ? <span className="st-muted mt-2 block break-all text-xs">{delivery.keptOn}</span> : null}
      </span>
    );
  }
  return (
    <a href={delivery.href} className="btn st-btn btn-block">
      {delivery.label}
    </a>
  );
}

/** One purchase on the list: what it is, when it was bought, and every way to open it again. */
export function PurchaseCard({ card, storeName, language, titleRef }: { card: PurchaseCardModel; storeName: string; language: unknown; titleRef?: (node: HTMLParagraphElement | null) => void }) {
  const key = (found: CardKey) => (
    <LicenceKeyBox
      key={found.slot}
      title={found.title}
      storeName={storeName}
      value={found.value}
      revoked={found.revoked}
      waiting={found.waiting}
      words={{ ...(card.shared.key as Omit<LicenceKeyWords, "label">), label: found.label }}
    />
  );
  return (
    <li className="rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
      <p className="font-semibold" ref={titleRef} tabIndex={titleRef ? -1 : undefined}>{card.title}</p>
      <p className="st-muted mt-1 text-sm">{card.meta}</p>
      <div className="mt-4 space-y-3">
        {card.preorderLine ? <p className="st-muted text-sm">{card.preorderLine}</p> : null}
        {card.ended ? (
          <>
            <p className="st-muted text-sm">{card.ended.note}</p>
            <Link href={card.ended.renew.href} className="btn st-btn btn-block">
              {card.ended.renew.label}
            </Link>
          </>
        ) : null}
        {card.course ? (
          <Link href={card.course.href} className="btn st-btn btn-block">
            {card.course.label}
          </Link>
        ) : null}
        {card.package ? (
          "href" in card.package ? (
            <Link href={card.package.href} className="btn st-btn btn-block">
              {card.package.label}
            </Link>
          ) : (
            <p className="st-muted text-sm">{card.package.text}</p>
          )
        ) : null}
        {card.podcast ? (
          <Link href={card.podcast.href} className="btn st-btn btn-block">
            {card.podcast.label}
          </Link>
        ) : null}
        {/* A course or podcast bought at one of several prices: what that price includes besides the way in. */}
        {card.alsoIn ? <p className="st-label">{card.alsoIn}</p> : null}
        {card.main ? <Delivery delivery={card.main} language={language} /> : null}
        {card.added.map((added) => (
          <Fragment key={added.key}>
            {/* A course anywhere in a cart opens on its own page, named, as the first one does (lib/order-courses.ts). */}
            {added.course ? (
              <Link href={added.course.href} className="btn st-btn btn-block">
                {added.course.label}
              </Link>
            ) : null}
            {added.delivery ? <Delivery delivery={added.delivery} language={language} /> : null}
          </Fragment>
        ))}
      </div>
      {card.importedNote ? <p className="st-muted mt-3 text-xs leading-relaxed">{card.importedNote}</p> : null}
      {card.bundles.map((bundle) => (
        <OrdersBundle
          key={bundle.key}
          address={bundle.address}
          storeName={storeName}
          words={{ heading: bundle.heading, show: bundle.show, hide: bundle.hide, ...card.shared }}
        />
      ))}
      {card.keys.map(key)}
      {card.review ? (
        <p className="mt-4 text-sm">
          <Link prefetch={false} href={card.review.href} className="st-footer-link font-semibold underline underline-offset-4">
            {card.review.label}
          </Link>
        </p>
      ) : null}
    </li>
  );
}
