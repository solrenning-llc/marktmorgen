import type { Metadata } from "next";
import { NewTab } from "@/components/new-tab";
import { forVisitor } from "@/lib/visitor";
import { connection } from "next/server";
import { headers } from "next/headers";
import { SITE_URL } from "@/lib/site-url";
import { cache } from "react";
import { type Listing, type Store, normaliseHandle } from "@/lib/store";
import { storeForHandleExactly } from "@/lib/store-exact";
import { readListingExactly, readListings } from "@/lib/catalog";
import { canSell, canSellProduct } from "@/lib/store-checkout";
import { lookStyle } from "@/lib/store-look";
import { imageUrl } from "@/lib/product-image";
import { stockLeft } from "@/lib/stock";
import { outOfKeys } from "@/lib/licence-keys";
import { preorderDay, soonOne } from "@/lib/preorders";
import { sellsInTestMode } from "@/lib/stripe-connect";
import { summaryOf } from "@/lib/reviews";
import { bumpTargets } from "@/lib/product-extras";
import { CARD_COVER_FROM, CARD_HEIGHTS, placeFrom, tagged } from "@/lib/embed-rules";
import { PriceTag, pageAction, productPath } from "@/components/store-product";
import { RatingLine } from "@/components/review-list";
import { speech } from "@/lib/buyer-words";
import { scriptMode, withTags } from "@/lib/embed-sites";
import { type ScriptOpen, readScriptOpen } from "@/lib/embed-open";
import { EmbedMessenger } from "@/components/embed-messenger";
import { SlotPicker } from "@/components/slot-picker";
import { type CallListing, slotsForProduct } from "@/lib/calls";
import { bookingLength, offeredLengths } from "@/lib/call-lengths";
import { bookingWords } from "@/lib/buyer-words/booking";
import { chargeNow } from "@/lib/call-deposit";
import { slotWords } from "@/lib/slot-words";
import { placeLine } from "@/lib/call-place";
import { WhoAnswers, saysWhoAnswers } from "@/components/who-answers";

type Params = {
  params: Promise<{ handle: string; product: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * One product as a card for the creator's own website (lib/embed-rules.ts):
 * its picture, title, price, rating and the buy button, filling whatever
 * frame it is pasted in, with the button kept at the bottom.
 *
 * Everything on it decides what it does by the rules the product's own page
 * follows (pageAction in components/store-product.tsx): straight to Stripe's
 * checkout when there is nothing to choose first, to the product's page when
 * there is (a price option, a plan, a time to book, an email for something
 * free), and a plain sentence when it cannot be bought. Every way out opens a
 * new tab, so the creator's page stays where it was.
 *
 * It sets no cookie, counts no visit and asks for no session: it is drawn on
 * every page of the creator's site that holds it, read or not.
 *
 * The same card is what the checkout script opens (lib/embed-sdk.ts), with
 * ?mm=overlay in a frame over the creator's page or ?mm=page as a page of its
 * own. That is a person who pressed a link, so it is counted as a visit and
 * may rest like the store's pages (lib/embed-open.ts); in a frame it shows its
 * buy button, and tells the page what happened, only on a site the creator
 * listed (lib/embed-sites.ts), and a plain link to the product's page on any
 * other. As a page, its buy button goes to Stripe in the same tab.
 *
 * Once a creator lists their sites, a card pasted anywhere else shows the
 * plain link too; with no list it is drawn wherever it is pasted, as before.
 */
/**
 * The store and the product, or null for one that is not there. A read that
 * failed is `unread`, never "not there" (CX-123 rule 24): the card then says
 * it could not be loaded just now, never that the product is no longer on sale. The store is read exactly
 * (lib/store-exact.ts), so an address that answered out of shape is unread too (Codex J on #2910), and so is the
 * product's own record (readListingExactly; Claude 3 on #2910).
 */
const load = cache(async (raw: string, id: string): Promise<{ store: Store | null; product: Listing | null; unread: boolean }> => {
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { store: null, product: null, unread: false };
  }
  let found: Awaited<ReturnType<typeof storeForHandleExactly>>;
  try {
    found = await storeForHandleExactly(normaliseHandle(decoded.replace(/^@/, "")));
  } catch {
    return { store: null, product: null, unread: true };
  }
  if (found === "unknown") return { store: null, product: null, unread: true };
  const store = found === "none" ? null : found;
  // A store switched off after notices (lib/takedown.ts) shows no card.
  if (!store || store.suspended) return { store: null, product: null, unread: false };
  // A draft is not on sale, and its card says so as its page would.
  let product: Listing | null;
  try {
    const read = await readListingExactly(store, id);
    if (read === "unknown") return { store, product: null, unread: true };
    product = read;
  } catch {
    return { store, product: null, unread: true };
  }
  return { store, product: product && !product.hidden ? product : null, unread: false };
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, product: id } = await params;
  const { store, product, unread } = await load(handle, id);
  return {
    title: store && product ? `${product.title} — ${store.name}` : unread ? "Not available just now" : "Not on sale",
    robots: { index: false, follow: false },
  };
}

/**
 * The page under the frame shows through; the card is the only thing drawn.
 * Its picture runs across the top in a frame tall enough for it, and sits
 * beside the title in one that is not (lib/embed-rules.ts, CARD_HEIGHTS).
 */
const CARD_RULES =
  `.em-cover{display:none}@media (min-height:${CARD_COVER_FROM}px){.em-cover{display:block}.em-thumb{display:none}}` +
  // The summary gets whole lines only: as many as the card has room for
  // under its title, never one cut through the middle.
  ".em-sum{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:var(--lines,2)}" +
  `@media (max-height:${CARD_COVER_FROM - 1}px){.em-sum[data-picture]{-webkit-line-clamp:1}}`;
const SEE_THROUGH = `html,body{background:transparent!important;min-height:0!important;height:100%;margin:0}${CARD_RULES}`;
/** As a page of its own (?mm=page) the card sits in a box of its own height, the picture across its top. */
const ON_A_PAGE = ".em-cover{display:block}.em-thumb{display:none}.em-sum{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:var(--lines,2)}";

/** How tall the frame is asked to be for a call's times (the script takes 160 to 800 pixels): room for a week of times, scrolled inside past that. */
const TIMES_HEIGHT = 640;

/** Past about this many characters a title takes two lines on the card, and the summary gives one up. */
const LONG_TITLE = 30;

/** Whether a card pasted with the frame code (not the script) is on a page that may show it: anywhere until the creator lists sites, then those (and this site's own studio preview). */
async function pastedAllowed(store: Store): Promise<boolean> {
  if (!store.embedSites.length) return true;
  const referer = (await headers()).get("referer");
  if (!referer) return false;
  try {
    const origin = new URL(referer).origin.toLowerCase();
    return origin === new URL(SITE_URL).origin || store.embedSites.includes(origin);
  } catch {
    return false;
  }
}

export default async function EmbedCard({ params, searchParams }: Params) {
  await connection();
  const { handle, product: id } = await params;
  const query = await searchParams;
  const place = placeFrom(query.utm_source);
  const mode = scriptMode(query.mm);
  const loaded = await load(handle, id);
  const product = loaded.product;
  // With the visitor's country, for a fair price for it (lib/fair-price.ts).
  const store = loaded.store ? await forVisitor(loaded.store) : null;
  // Opened by the checkout script: counted, and what it may show (lib/embed-open.ts).
  const open: ScriptOpen | null = mode && store ? await readScriptOpen(store, mode, query) : null;
  // The card's own links, tagged as the code that opened it was.
  const tag = (url: string) => (open ? withTags(url, open.tags, { via: open.via }) : tagged(url, place));
  // As a page of its own, links stay in the tab; in a frame, they open a new one.
  const aside = open?.mode === "page" ? { target: "_top" } : { target: "_blank", rel: "noopener" };

  if (!store || !product) {
    return (
      <div className="flex h-screen items-center justify-center p-4" style={{ background: "transparent" }}>
        <style>{SEE_THROUGH}</style>
        {/* With a store, the sentence is in its language and says so (3.1.2); without one, it is English, as the page. */}
        <p lang={store ? speech(store).lang.locale : undefined} className="rounded-3xl bg-white px-5 py-4 text-center text-sm text-ink-soft ring-1 ring-line">
          {store ? (
            <>
              {`${loaded.unread ? speech(store).w.cardUnread : speech(store).w.noLongerOnSale} `}
              <a href={tag(`/@${store.handle}`)} {...aside} className="font-semibold underline underline-offset-4">
                {speech(store).w.seeStore(store.name)}
              </a>
            </>
          ) : loaded.unread ? (
            // The store could not be read, so neither could its language: in English, as below.
            "This product could not be loaded just now. Try again in a moment."
          ) : (
            "This product is no longer on sale."
          )}
        </p>
      </div>
    );
  }

  const selling = canSell(store);
  const [coming, stock, noKeys, related, summary] = await Promise.all([
    // Unknown is null, never "not coming soon" (CX-123 rule 24): the card then draws no buy button.
    soonOne(store, product.id).catch(() => null),
    stockLeft(store, product).catch(() => null),
    // Unknown is null, never "keys left" (CX-123 rule 24; Claude 4 on #2910): the card then draws no buy button.
    outOfKeys(store, product).catch(() => null),
    product.bumps.length ? readListings(store, bumpTargets(product)).catch(() => []) : Promise.resolve([]),
    summaryOf(store.statsId, product.id).catch(() => null),
  ]);
  const soon = coming?.soon ?? false;
  // With the key count unknown, how many are left is not said either.
  const count = noKeys === null ? null : noKeys ? 0 : stock;
  const remaining = count !== null && canSellProduct(store, product) ? count : null;
  // Whether it is coming soon, or whether a key is left, could not be read: buying, the waitlist or the pre-order cannot
  // be told apart, or the product may be sold out, so the card says buying is not available just now, and its title
  // still leads to the product's page.
  const computed = coming && noKeys !== null
    ? pageAction(store, product, remaining, selling, related, soon, preorderDay(store, product, coming.soon, coming.day))
    : { action: { kind: "none" as const, text: speech(store).w.cardBuyUnread }, label: "" };
  const page = tag(productPath(store, product));
  // A card the script opened on a site the creator did not list, past the
  // store's visits or past the opens one connection gets, and one pasted
  // somewhere its creator's list leaves out, buys nothing here: its button is
  // a plain link to the product's own page. So is a card with an affiliate's
  // code, which the product's page takes under the store's consent rules.
  const plain = open ? !open.live || Boolean(open.via) : !(await pastedAllowed(store));
  const { action, label } = plain && computed.action.kind === "checkout" ? { action: { kind: "link" as const, href: productPath(store, product) }, label: computed.label } : computed;
  // A product page link with the place on it, and the part of the page it was meant for.
  const into = (href: string) => (href.startsWith("#") ? `${page.split("#")[0]}${href}` : tag(href));
  // Something handed over digitally is paid for from the product's buy box,
  // where the buyer first checks the box to start access at once
  // (lib/digital-consent.ts), which this card has no room to hold. A live card
  // on a listed site passes that site and the way back on, so the sale still
  // names the site and returns the buyer to it; the checkout checks both
  // against the store's list again (app/api/store/checkout).
  const toBuyBox = (href: string) => {
    if (plain || !open?.live || !(open.site || open.back)) return href;
    const [path, hash] = href.split("#");
    const extra = new URLSearchParams({ ...(open.site ? { site: open.site } : {}), ...(open.back ? { return: open.back } : {}) }).toString();
    return `${path}${path.includes("?") ? "&" : "?"}${extra}${hash ? `#${hash}` : ""}`;
  };
  // The calendar embedded in the creator's own site (637 [GL5], unit 6): a call the checkout script opened in a frame, on a
  // site the creator listed, while it may sell there and with no affiliate's code, shows its times in the frame. Anywhere
  // else the card stays a link to the booking page in a new tab, as before, so the calendar never opens on a site off the list.
  const calendar =
    !plain && open?.mode === "overlay" && open.live && Boolean(open.site) && !open.via && !soon &&
    action.kind === "link" && action.href === `/@${store.handle}/book/${product.id}` &&
    product.call?.kind === "weekly" && canSellProduct(store, product);
  // Every parameter the script put on the frame's address is kept, and the listed site with them: a frame that moves on inside
  // itself is sent by this site's own page, so the site is read again from here, and checked against the list again
  // (lib/embed-open.ts), as the sign-up form's answer carries it.
  // `to` is the part of the page it lands on, so focus follows the change (2.4.3).
  const here = (extra: Record<string, string>, drop: string[] = [], to?: string) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (typeof value === "string" && !drop.includes(key)) next.set(key, value);
    if (open?.site) next.set("site", open.site);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `?${next.toString()}${to ? `#${to}` : ""}`;
  };
  if (calendar && query.view === "times") {
    const call = product as CallListing;
    const b = bookingWords(store.language);
    const say = speech(store);
    // One of a call's lengths, by its link, as on the booking page; read at it, and offered only where it can be booked (holdAndCheckout).
    const asked = typeof query.length === "string" ? query.length : undefined;
    // Read at the length asked for only where lengths are offered at all (offeredLengths): with a deposit, for one, the
    // frame books the call's own length, so it shows that length's times, as the booking page does.
    const offerable = offeredLengths(call.call, product.priceCents, { pkg: false, team: false }).length > 0;
    const askedLength = offerable ? bookingLength(call.call, product.priceCents, asked) : null;
    const read = await slotsForProduct(store, call, null, askedLength?.minutes ?? null);
    const choices = read ? offeredLengths(call.call, product.priceCents, { pkg: false, team: read.team }) : [];
    const chosen = choices.length ? askedLength ?? choices[0] : null;
    const cents = chosen ? chosen.cents : product.priceCents;
    const due = chargeNow({ priceCents: cents, currency: store.currency, deposit: call.call.deposit ?? null, inPerson: Boolean(call.call.place) });
    const payNow = say.money(due.rest > 0 ? due.cents : cents);
    const code = due.rest > 0 && store.hasDiscounts ? { label: b.codeLabel, help: b.codeHelp } : undefined;
    const starts = read ? read.days.flatMap((day) => day.starts) : [];
    // A team that lets the buyer choose who they book with: the choice is on the booking page, never dropped here.
    const chooses = Boolean(read && "hosts" in read && read.hosts && read.hosts.length);
    const where = call.call.place ? b.inPersonLine(chosen ? chosen.minutes : call.call.minutes, placeLine(call.call.place)) : null;
    return (
      <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} h-screen overflow-y-auto`} style={lookStyle(store.look) as React.CSSProperties} data-embed-times="">
        <main id="content" className="p-4">
          {/* Where focus starts once the times open in the frame (2.4.3): the frame's address names it. */}
          <h1 id="times-title" tabIndex={-1} className="font-display text-[1.0625rem] font-semibold leading-snug">{product.title}</h1>
          <p className="st-price mt-1 text-sm">{say.money(cents)}</p>
          {where ? <p className="st-muted mt-1 text-sm font-semibold">{where}</p> : null}
          {due.rest > 0 ? <p className="mt-1 text-sm">{b.depositRest(say.money(due.rest), store.name)}</p> : null}
          {/* The creator's cancellation deadline and summary, before paying, as the booking page says them. */}
          {call.call.cancelHours ? <p className="mt-1 text-sm">{b.cancelPolicy(call.call.cancelHours, store.name)}</p> : null}
          {product.summary ? <p className="st-muted mt-2 text-sm leading-relaxed">{product.summary}</p> : null}
          {chosen ? (
            <div className="mt-4" role="group" aria-labelledby={`length-${product.id}`}>
              <p id={`length-${product.id}`} className="font-bold" style={{ color: "var(--st-text)" }}>{b.lengthPick}</p>
              <ul className="mt-2 grid gap-2">
                {choices.map((l) => (
                  <li key={l.minutes}>
                    <a
                      href={here({ length: String(l.minutes) }, [], "times")}
                      aria-current={l.minutes === chosen.minutes ? "true" : undefined}
                      className={`btn ${l.minutes === chosen.minutes ? "btn-primary" : "btn-secondary"} w-full justify-start`}
                    >
                      {b.lengthOption(l.minutes, say.money(l.cents))}
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm">{b.lengthChosen(b.lengthOption(chosen.minutes, say.money(chosen.cents)))}</p>
            </div>
          ) : null}
          {chooses ? (
            <p className="mt-4">
              {/* A team the buyer picks from opens the booking page in a new tab, and says so (G201). */}
              <a href={tag(`/@${store.handle}/book/${product.id}`)} {...aside} className="btn st-btn btn-block">
                {label}
                <NewTab language={store.language} />
              </a>
            </p>
          ) : read === null ? (
            <div className="st-note mt-4">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{b.timesUnread}</p>
              <p className="mt-1 text-sm">{b.timesUnreadBody}</p>
            </div>
          ) : (
            <>
            {/* A length's link lands here, on the times it changed (2.4.3). */}
            <span id="times" />
            <SlotPicker
              starts={starts}
              creatorTz={call.call.tz}
              handle={store.handle}
              productId={product.id}
              minutes={chosen ? chosen.minutes : undefined}
              shownCents={chosen ? chosen.cents : undefined}
              newTab
              embed={open.site ? { site: open.site, back: open.back ?? null } : null}
              words={{ ...slotWords(store, b, chosen ? chosen.minutes : call.call.minutes, payNow, false, false), code }}
            />
            </>
          )}
          {/* Before the buyer picks a time and pays (components/who-answers.tsx). */}
          {chooses || read === null ? null : <WhoAnswers store={store} className="st-muted mt-3 text-sm" />}
          <p className="mt-4 text-center text-sm">
            <a href={here({}, ["view", "length"], "calendar-button")} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">{b.backToCard(product.title)}</a>
          </p>
        </main>
        {/* Told what happened on the listed site the frame is on, as the card itself tells it. */}
        {open.site ? <EmbedMessenger to={open.site} height={TIMES_HEIGHT} /> : null}
      </div>
    );
  }
  const testMode = selling && sellsInTestMode(store);
  const { w, num, lang } = speech(store);
  // The calendar opens its times in this same frame, so it says nothing of a new tab.
  const note = testMode
    ? w.cardTestMode
    : calendar
      ? ""
      : action.kind === "checkout"
      ? open?.mode === "page" ? "" : w.cardCheckout
      : action.kind === "link" && open?.mode !== "page"
        ? w.cardOpens(store.name)
        : "";
  const image = product.image;
  const height = image ? CARD_HEIGHTS.picture : CARD_HEIGHTS.plain;
  // In a frame, a button that goes straight to paying (a shipped product) leaves no room for the whole sentence on who
  // answers for the sale (components/who-answers.tsx), so the line under the title says a short one of its own, wrapped,
  // never cut: the card then grows past the frame and scrolls inside it rather than clip anything. The title leads to the
  // product's page, where the whole sentence is; as a page of its own, the card has the whole one under it.
  const soldBy = action.kind === "checkout" && open?.mode !== "page" && saysWhoAnswers(store);
  // Told what happened only on a listed site, and only while it may buy here.
  const messaging = open?.mode === "overlay" && open.live && open.site ? open.site : null;
  // Which product, never a price; and, from the script, the listed site it
  // was bought on and where to send the buyer back to, which the checkout
  // checks against the store's list again (app/api/store/checkout).
  const fields =
    action.kind === "checkout" ? (
      <>
        <input type="hidden" name="handle" value={action.handle} />
        <input type="hidden" name="product" value={action.product} />
        {open?.site ? <input type="hidden" name="site" value={open.site} /> : null}
        {open?.back ? <input type="hidden" name="return" value={open.back} /> : null}
        <button type="submit" className="btn st-btn btn-block">
          {label}
        </button>
      </>
    ) : null;

  const card = (
      <article className={`st-card flex ${soldBy ? "min-h-full" : "h-full"} flex-col overflow-hidden p-4`} style={{ boxShadow: "none" }}>
        {image ? (
          <a href={page} {...aside} tabIndex={-1} className="em-cover -mx-4 -mt-4 mb-4 h-[160px] shrink-0 overflow-hidden" style={{ background: "var(--st-item)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl(image)} alt={image.alt} width={image.width} height={image.height} className="h-full w-full object-cover" decoding="async" />
          </a>
        ) : null}
        <div className="flex items-start gap-3">
          {image ? (
            <a href={page} {...aside} tabIndex={-1} className="em-thumb shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl(image)} alt={image.alt} width={64} height={64} className="h-16 w-16 rounded-2xl object-cover" decoding="async" />
            </a>
          ) : null}
          <div className="min-w-0 flex-1">
            <h1 className="font-display line-clamp-2 text-[1.0625rem] font-semibold leading-snug">
              <a href={page} {...aside} className="st-title-link">
                {product.title}
              </a>
            </h1>
            {soldBy ? <p className="st-muted text-sm break-words">{w.cardSoldBy(store.name)}</p> : <p className="st-muted truncate text-sm">{store.name}</p>}
          </div>
        </div>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <p className="st-price text-sm">
            <PriceTag store={store} product={product} />
          </p>
          {summary ? <RatingLine summary={summary} className="text-sm" lang={store.language} /> : null}
          {remaining !== null && remaining > 0 && !soon ? (
            <p className="text-sm font-bold" style={{ color: "var(--st-accent-text)" }}>{w.left(remaining, num(remaining))}</p>
          ) : null}
        </div>
        <div className="mt-2 min-h-0 flex-1 overflow-hidden">
          {product.summary ? (
            <p
              className="em-sum st-muted text-sm leading-relaxed"
              data-picture={image ? "" : undefined}
              style={{ "--lines": product.title.length > LONG_TITLE || soldBy ? 1 : 2 } as React.CSSProperties}
            >
              {product.summary}
            </p>
          ) : null}
        </div>
        {action.kind === "checkout" ? (
          // As a page, Stripe's checkout opens in the same tab; in a frame, in a
          // new one (Stripe's page is never drawn inside a frame).
          open?.mode === "page" ? (
            <form action="/api/store/checkout" method="post" target="_top" className="mt-3" data-checkout="">
              {fields}
            </form>
          ) : (
            <form action="/api/store/checkout" method="post" target="_blank" rel="noopener" className="mt-3" data-checkout="">
              {fields}
            </form>
          )
        ) : calendar ? (
          // The call's times, drawn in this same frame (unit 6), never a new tab.
          <a href={here({ view: "times" }, [], "times-title")} id="calendar-button" className="btn st-btn btn-block mt-3" data-embed-calendar="">
            {label}
          </a>
        ) : action.kind === "link" ? (
          <a href={action.href === "#buy" ? toBuyBox(into(action.href)) : into(action.href)} {...aside} className="btn st-btn btn-block mt-3">
            {label}
          </a>
        ) : (
          <p className="st-muted mt-3 text-center text-sm font-semibold">{action.text}</p>
        )}
        {note ? <p className="st-muted mt-2 break-words text-center text-xs">{note}</p> : null}
      </article>
  );

  if (open?.mode === "page") {
    return (
      <div lang={lang.locale} className={`st-page st-theme-${store.look.theme} flex min-h-screen flex-col items-center justify-center px-4 py-10`} style={lookStyle(store.look) as React.CSSProperties}>
        <style>{ON_A_PAGE}</style>
        <main id="content" className="w-full max-w-[400px]" style={{ height }}>
          {card}
        </main>
        {/* Under the card, which keeps its height, wherever the card can take a payment (components/who-answers.tsx). */}
        {action.kind === "checkout" ? <WhoAnswers store={store} className="st-muted mt-4 w-full max-w-[400px] text-center text-sm" /> : null}
      </div>
    );
  }

  return (
    <div
      lang={lang.locale}
      className={`st-page st-theme-${store.look.theme} h-screen${soldBy ? " overflow-y-auto" : ""}`}
      style={{ ...(lookStyle(store.look) as React.CSSProperties), background: "transparent" }}
      data-card-height={height}
    >
      <style>{SEE_THROUGH}</style>
      {/* One main landmark around the card, as on every page (1.3.1); it fills the frame as the card did. */}
      <main id="content" className="h-full">
        {card}
      </main>
      {messaging ? <EmbedMessenger to={messaging} height={height} /> : null}
    </div>
  );
}
