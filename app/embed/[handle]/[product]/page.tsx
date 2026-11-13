import type { Metadata } from "next";
import { forVisitor } from "@/lib/visitor";
import { connection } from "next/server";
import { headers } from "next/headers";
import { cache } from "react";
import { type Store } from "@/lib/store";
import { placeFrom } from "@/lib/embed-rules";
import { scriptMode } from "@/lib/embed-sites";
import { type ScriptOpen, admitOpen, readScriptOpen } from "@/lib/embed-open";
import { refererOrigin, siteMaySell } from "@/lib/embed-card-view";
import { CardRefused, drawEmbedCard, loadCard } from "@/components/embed-card";

type Params = {
  params: Promise<{ handle: string; product: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * One product as a card for the creator's own website, drawn for this one
 * request (components/embed-card.tsx has what it shows and why).
 *
 * This page is what the checkout script opens (lib/embed-sdk.ts), with
 * ?mm=overlay in a frame over the creator's page or ?mm=page as a page of its
 * own: a person who pressed a link, counted as a visit by the page's beacon,
 * resting with the store's pages (lib/embed-open.ts). The card pasted with the
 * frame code (no ?mm=) is not drawn here: proxy.ts sends each of its displays
 * to the copy the CDN keeps (app/embed/[handle]/[product]/card/[view],
 * lib/embed-card-view.ts, DONO-20261113-DEC-2), which reads nothing per
 * display. Reached here all the same, it is drawn as before.
 *
 * Every request is first held to what one connection gets for a store
 * (OPENS_PER_TEN_MINUTES, admitOpen), before the store or the product is
 * read; past it the card is a plain link to the product's page.
 */
const admitted = cache((handle: string): Promise<boolean> => admitOpen(handle));

/** The store and the product, read once a request for the title and the body, only once the connection was admitted. */
const load = cache(async (raw: string, id: string) => ((await admitted(raw)) ? loadCard(raw, id) : null));

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, product: id } = await params;
  const loaded = await load(handle, id);
  const { store, product, unread } = loaded ?? { store: null, product: null, unread: false };
  return {
    title: !loaded ? "See this product" : store && product ? `${product.title} — ${store.name}` : unread ? "Not available just now" : "Not on sale",
    robots: { index: false, follow: false },
  };
}

/** Whether a card pasted with the frame code is on a page that may show its buy button, read from this request's Referer. */
async function pastedAllowed(store: Store): Promise<boolean> {
  return siteMaySell(store.embedSites, refererOrigin((await headers()).get("referer")));
}

export default async function EmbedCard({ params, searchParams }: Params) {
  await connection();
  const { handle, product: id } = await params;
  const query = await searchParams;
  const place = placeFrom(query.utm_source);
  const mode = scriptMode(query.mm);
  const loaded = await load(handle, id);
  // Past what one connection gets for this store: nothing was read, and the card is a plain link.
  if (!loaded) return <CardRefused handle={handle} id={id} place={place} page={mode === "page"} />;
  // With the visitor's country, for a fair price for it (lib/fair-price.ts).
  const store = loaded.store ? await forVisitor(loaded.store) : null;
  // Opened by the checkout script: counted, and what it may show (lib/embed-open.ts); the connection was admitted above.
  const open: ScriptOpen | null = mode && store ? await readScriptOpen(store, mode, query, { admitted: true }) : null;
  return drawEmbedCard({ loaded, store, open, query, place, pastedAllowed, cached: false });
}
