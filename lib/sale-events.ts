/**
 * A sale, noticed once, told to whoever the creator asked to be told: their
 * phone (lib/phone-alerts.ts) and their email platform (lib/email-sync.ts).
 *
 * A paid checkout is noticed in two places, like the buyer's confirmation
 * email (lib/purchase-email.ts): the thanks page, the moment the buyer lands
 * on it, and the five-minute job's pass over each store's checkouts of the
 * last day (lib/checkout-sweep.ts), for a buyer who never came back from
 * Stripe. Either may see the same checkout many times; each checkout is told
 * once, marked here when it has been, and each of the two listeners keeps its
 * own mark as well, so two places noticing it at the same moment still send
 * one notification and one contact.
 *
 * Only stores with a listener are looked at (listensToSales), so a store that
 * connected nothing costs nothing extra on either path.
 *
 * What goes where:
 *   - the phone gets the amount and what was bought, for every paid order
 *     except a booked call, which is told as a booking when it is confirmed
 *     (lib/calls.ts); a one-click offer taken after paying is a sale of its own
 *     (noteOfferSale);
 *   - the email platform gets the buyer, with the product and the one added
 *     at checkout, when the creator's settings take them — and only if the
 *     buyer agreed to hear from the creator, which lib/email-sync.ts decides;
 *   - the team's Slack or Discord channel gets one line, where the creator
 *     asked for each sale there: the amount, what was bought and the channel
 *     it came from, never the buyer;
 *   - the store's own pages, where the creator shows its latest purchases:
 *     what was bought, when and the billing country (lib/recent-sales.ts).
 */
import { saleHandles } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark } from "@/lib/claim-mark";
import { isSettled } from "@/lib/instant-pay";
import { alertCreator } from "@/lib/phone-alerts";
import { queuePerson } from "@/lib/email-sync";
import type { Listing, Store } from "@/lib/store";
import { readListing, readListings } from "@/lib/catalog";
import { bumpsFromMeta, bundleFromMeta } from "@/lib/bundle-rules";
import { formatMoney } from "@/lib/money";
import { chatAddress, postToChat } from "@/lib/chat-summary";
import { channelName } from "@/lib/channel-names";
import { rememberSale } from "@/lib/recent-sales";

/** How long a told sale is remembered: past the day the job looks back over. */
const TOLD_SECONDS = 40 * 86400;
const toldKey = (session: string) => `nl:sale:told:${session}`;

/** A checkout as Stripe returns or lists it, with only the fields read here. */
export type SaleRecord = {
  id?: unknown;
  status?: unknown;
  payment_status?: unknown;
  created?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  customer_email?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown; name?: unknown; address?: { country?: unknown } | null } | null;
  consent?: { promotions?: unknown } | null;
  mode?: unknown;
  payment_intent?: unknown;
};

/** Whether anything listens for this store's sales. */
export function listensToSales(store: Store): boolean {
  return Boolean(store.stripeAccountId) && (store.phoneSales || store.emailSync !== null || store.chatSales || store.recentSales);
}

/** An amount as the checkout charged it: in its own currency, the store's when Stripe did not say. */
function money(amount: number, currency: unknown, store: Store): string {
  return formatMoney(amount, typeof currency === "string" && currency ? currency : store.currency);
}

/**
 * Where a notification opens: the studio of this very store (lib/studio-route.ts,
 * `?store=`), so a phone of someone who runs several stores opens the right one.
 */
function studioAt(store: Store, hash: string): string {
  return `/studio${store.sid ? `?store=${store.sid}` : ""}${hash}`;
}

/** Whether the buyer agreed to hear from the creator, by the store's box or by Stripe's. */
export function buyerAgreed(record: SaleRecord): boolean {
  return record.metadata?.news === "yes" || record.consent?.promotions === "opt_in";
}

async function tell(store: Store, record: SaleRecord, session: string): Promise<void> {
  const meta = record.metadata ?? {};
  // Read by id (lib/catalog.ts), however many products the store has.
  const ticked = bumpsFromMeta(meta);
  const inside = [...bundleFromMeta(meta, "bundle"), ...ticked.flatMap((added) => bundleFromMeta(meta, `${added.key}_bundle`))];
  const [product, bumps, items] = await Promise.all([
    readListing(store, meta.product),
    ticked.length ? readListings(store, ticked.map((added) => added.id)) : Promise.resolve([] as Listing[]),
    // A bundle's products go to the email platform as if each were bought on its own.
    inside.length ? readListings(store, inside) : Promise.resolve([] as Listing[]),
  ]);
  const title = product?.title ?? meta.title ?? "A product";
  const amount = typeof record.amount_total === "number" ? record.amount_total : 0;
  const at = typeof record.created === "number" ? record.created * 1000 : Date.now();

  // The store's own pages, where the creator shows its latest purchases (lib/recent-sales.ts).
  await rememberSale(store, record).catch((error) => console.error("remembering a recent purchase failed", error));

  if (meta.kind !== "call") {
    await alertCreator(
      store,
      "sale",
      {
        title: `${meta.kind === "tip" ? "New support" : "New sale"}: ${money(amount, record.currency, store)}`,
        body: [title, ...bumps.map((added) => added.title)].join(" + "),
        url: studioAt(store, "#numbers"),
      },
      { seed: session, at },
    ).catch((error) => console.error("a sale notification failed", error));
  }

  // The team's Slack or Discord channel, where the creator asked for each sale
  // there (lib/chat-summary.ts): the amount, what was bought and the channel it
  // came from, never who bought it.
  if (store.chatSales) {
    const url = await chatAddress(store.statsId).catch(() => null);
    if (url) {
      const what = meta.kind === "call" ? "New booking" : meta.kind === "tip" ? "New support" : "New sale";
      const channel = meta.utm_source || (meta.channel && meta.channel !== "direct" ? meta.channel : "");
      const line = `${what} on ${store.name}: ${money(amount, record.currency, store)}, ${[title, ...bumps.map((added) => added.title)].join(" + ")}${channel ? ` (from ${channelName(channel)})` : ""}`;
      await postToChat(url, line).catch(() => false);
    }
  }

  const details = record.customer_details ?? {};
  const email = typeof details.email === "string" && details.email ? details.email : typeof record.customer_email === "string" ? record.customer_email : null;
  await queuePerson(store, {
    source: "purchase",
    email,
    name: typeof details.name === "string" ? details.name : null,
    products: [
      { id: meta.product ?? "", title },
      ...bumps.map((added) => ({ id: added.id, title: added.title })),
      ...items.map((item) => ({ id: item.id, title: item.title })),
    ],
    consent: buyerAgreed(record),
    seed: session,
    at,
  }).catch((error) => console.error("sending a buyer to an email platform failed", error));
}

/**
 * Tells the listeners about each paid checkout of this store among `records`
 * that has not been told yet. Returns how many were told.
 */
export async function noteSales(store: Store, records: SaleRecord[]): Promise<number> {
  if (!listensToSales(store) || !isRedisConfigured()) return 0;
  const handles = saleHandles(store);
  const paid = records.filter(
    (r): r is SaleRecord & { id: string } => typeof r.id === "string" && isSettled(r) && handles.has(r.metadata?.store ?? ""),
  );
  if (!paid.length) return 0;
  // One round trip for which of them were told already.
  const marks = await redisPipeline(paid.map((r) => ["EXISTS", toldKey(r.id)]));
  let told = 0;
  for (let i = 0; i < paid.length; i += 1) {
    if (Number(marks[i]) === 1) continue;
    await tell(store, paid[i], paid[i].id);
    await redisPipeline([["SET", toldKey(paid[i].id), "1", "EX", TOLD_SECONDS]]);
    told += 1;
  }
  return told;
}

/** One checkout, from the thanks page. */
export async function noteSale(store: Store, record: SaleRecord): Promise<number> {
  return noteSales(store, [record]);
}

/** A one-click offer paid after checkout (lib/upsell.ts): a sale of its own, for the phone. */
export async function noteOfferSale(store: Store, product: Listing, payment: Record<string, unknown>): Promise<void> {
  if (!store.phoneSales && !store.chatSales) return;
  const id = typeof payment.id === "string" ? payment.id : "";
  if (!id) return;
  const amount = typeof payment.amount === "number" ? payment.amount : 0;
  if (store.chatSales && isRedisConfigured()) {
    // Once, like the phone's: the payment's own mark.
    // Ours only on an exact claim (lib/claim-mark.ts): an unknown answer posts nothing.
    const fresh = await claimMark(toldKey(id), TOLD_SECONDS);
    const url = fresh === "ours" ? await chatAddress(store.statsId).catch(() => null) : null;
    if (url) await postToChat(url, `New sale on ${store.name}: ${money(amount, payment.currency, store)}, ${product.title} (one-click offer)`).catch(() => false);
  }
  if (!store.phoneSales) return;
  await alertCreator(
    store,
    "sale",
    { title: `New sale: ${money(amount, payment.currency, store)}`, body: `${product.title} (one-click offer)`, url: studioAt(store, "#numbers") },
    { seed: id, at: typeof payment.created === "number" ? payment.created * 1000 : Date.now() },
  );
}
