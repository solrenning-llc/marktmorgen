import { EmailField } from "@/components/email-field";
import { servedImageUrl, servedSrcSet } from "@/lib/picture-served";
import { packageSaving } from "@/lib/call-package-rules";
import { fromPrice, lengthList, listedLengths } from "@/lib/call-lengths";
import { saleClock, saleOff, salePrice } from "@/lib/store-sale";
import { activeIntro } from "@/lib/intro-price";
import { activeYearly, yearlySaving } from "@/lib/yearly-price";
import { fairOff } from "@/lib/fair-price";
import { endsLine, membershipLine, planLine, speech, worthLine } from "@/lib/buyer-words";
import Link from "next/link";
import { isFree, syncTakesBuyer, type Listing, type Store } from "@/lib/store";
import { canSellProduct, fromPriceCents, sellableOptions } from "@/lib/store-checkout";
import { canGiveProduct } from "@/lib/free";
import { activeBumps, activePlan, planFor } from "@/lib/product-extras";
import { activeShipping, shipsToWords } from "@/lib/shipping";
import { shippingWords } from "@/lib/buyer-words/shipping";
import { activePwyw } from "@/lib/pay-what-you-want";
import { IMAGE_SIZES } from "@/lib/product-image";
import type { PageAction } from "@/components/sales-blocks";
import { RatingLine } from "@/components/review-list";
import type { Summary } from "@/lib/review-summary";
import { MIN_BUNDLE_ITEMS, bundleReady, picks } from "@/lib/bundle-rules";
import { payPalPrice, paypalReady } from "@/lib/paypal-sales";
import { comparable, optionsInPickOrder } from "@/lib/product-option";
import { DEFAULT_PEOPLE, MAX_PEOPLE, MIN_PEOPLE } from "@/lib/group-rules";
import { givableOptions } from "@/lib/gift-rules";
import { productSegment } from "@/lib/product-slug";
import { membershipWords } from "@/lib/buyer-words/membership";
import { preorderWords } from "@/lib/buyer-words/preorder";
import { pickWords } from "@/lib/buyer-words/pick";
import { PickBundleForm } from "@/components/pick-bundle-form";
import { AddToCart } from "@/components/store-cart";
import { AssistReminderBox } from "@/components/assistant-reminder-box";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { WithdrawalWhere } from "@/components/withdrawal-where";
import { consentKind, deliversDigitally } from "@/lib/digital-consent";
import { assistReminderOffered } from "@/lib/assistant-reminder";
import { type AskWhen, isAskWhen } from "@/lib/ask-when";
import { type UnitLine, unitLines } from "@/lib/option-units";
import { hasDateOnSale } from "@/lib/call-on-sale";

/**
 * How many price options are drawn as cards before they become a list to pick
 * from. Six: two rows of three on a wide screen, and on a phone still a
 * scroll the buyer can take in, rather than fifty cards to swipe past.
 */
const LIST_ABOVE = 6;

/**
 * Where a product's own page is, under the store's address.
 *
 * Links from a card to this page, to a booking page or to a course are not
 * prefetched: every one of those pages is drawn fresh for its visitor, so a
 * prefetch is a request to the server, and a page of two dozen products
 * would send dozens of them from one visit that opens none.
 */
export function productPath(store: Store, product: Listing): string {
  return `/@${store.handle}/p/${productSegment(product)}`;
}

/** The figure on the price pill: "$27", "from €9 a month", "¥500+", "Free", in the store's currency and language. */
export function pricePill(store: Store, product: Listing): string {
  const { w, money } = speech(store);
  if (isFree(product)) return w.free;
  if (activePwyw(product)) return `${money(product.priceCents)}+`;
  const options = sellableOptions(product);
  const every = product.recurring ? ` ${w.every(product.recurring.interval)}` : "";
  // A call with several lengths (lib/call-lengths.ts): from the lowest of their prices.
  const lengths = product.call ? listedLengths(product.call, product.priceCents) : [];
  if (lengths.length) return w.fromPrice(money(fromPrice(lengths) as number));
  const price = `${money(fromPriceCents(product))}${every}`;
  return options.length > 1 ? w.fromPrice(price) : price;
}


/** "Subscribe — $5 the first month", for a membership with an introductory price (lib/intro-price.ts); null without one. */
export function introButton(store: Store, product: Listing): string | null {
  const intro = activeIntro(product, store.tiers);
  if (!intro || !product.recurring) return null;
  const { w, money } = speech(store);
  return w.subscribeFor(money(intro.cents), w.introFirst(intro.count, product.recurring.interval));
}

/** The percentage a running store-wide sale takes off this product now, or 0 (lib/store-sale.ts). */
export function saleNow(store: Store, product: Listing): number {
  return store.sale ? saleOff(store.sale, product, saleClock()) : 0;
}

/** The percentage this visitor's country takes off this product, or 0 (lib/fair-price.ts). */
export function fairNow(store: Store, product: Listing): number {
  return fairOff(store.fair, product, store.visitorCountry ?? "");
}

/**
 * The percentage off this product for this visitor now: a sale or a fair
 * price for their country, whichever is larger, never both. The checkout
 * takes off the same one (lib/store-checkout.ts).
 */
export function offNow(store: Store, product: Listing): number {
  return Math.max(saleNow(store, product), fairNow(store, product));
}

/**
 * The price pill, with the old price crossed out while a sale covers the
 * product. What is crossed out is the product's price, never a made-up one.
 */
export function PriceTag({ store, product }: { store: Store; product: Listing }) {
  const off = offNow(store, product);
  if (!off) return <>{pricePill(store, product)}</>;
  const { w, money } = speech(store);
  return (
    <>
      <s className="st-muted mr-1.5 font-normal">
        <span className="sr-only">{w.was}</span>
        {money(product.priceCents)}
      </s>
      <span className="sr-only">{w.now}</span>
      {money(salePrice(product.priceCents, off))}
    </>
  );
}

/** "Black Friday: 30% off · Ends in 2 days", under the buy button while a sale covers it. */
export function SaleNote({ store, product }: { store: Store; product: Listing }) {
  const sale = saleNow(store, product);
  const fair = fairNow(store, product);
  const { w, country, dateTime } = speech(store);
  // A fair price for the visitor's country, when it takes off more than the sale does.
  if (fair > sale) {
    return (
      <p className="mt-2 text-center text-sm font-semibold" style={{ color: "var(--st-accent-text)" }}>
        {w.fairHead(country(store.visitorCountry ?? ""), fair)}
        <span className="st-muted block text-xs font-normal">{w.fairNote(store.name, Boolean(activePlan(product)))}</span>
      </p>
    );
  }
  const off = sale;
  if (!off) return null;
  return (
    <p className="mt-2 text-center text-sm font-semibold" style={{ color: "var(--st-accent-text)" }}>
      {w.saleHead(store.sale.name, off, endsLine(store, store.sale.ends))}
      <span className="st-muted block text-xs font-normal">{w.saleNote(dateTime(store.sale.ends * 1000), Boolean(activePlan(product)))}</span>
    </p>
  );
}

/** What a card says about a call: one person, a group, or dated live sessions. */
function callLine(store: Store, call: NonNullable<Listing["call"]>, priceCents: number, now = Date.now()): string {
  const { w, lang } = speech(store);
  // In person (lib/call-place.ts): no call and nothing online; the address is on its booking page.
  const inPerson = Boolean(call.place);
  if (call.kind === "live") {
    const coming = call.sessions.filter((s) => s.start > now).length;
    if (coming === 0) return inPerson ? w.inPersonLiveNone : w.callLiveNone;
    return inPerson ? w.inPersonLive(coming) : w.callLive(coming);
  }
  if (call.seats > 1) return inPerson ? w.inPersonGroup(call.minutes, call.seats) : w.callGroup(call.minutes, call.seats);
  // Several lengths (lib/call-lengths.ts): each one said, "30 or 60 minutes".
  const lengths = listedLengths(call, priceCents);
  if (lengths.length) return inPerson ? w.inPersonLengths(lengthList(lengths, lang.locale)) : w.callLengths(lengthList(lengths, lang.locale));
  return inPerson ? w.inPersonOne(call.minutes) : w.callOne(call.minutes);
}

/** Whether a call can still be booked (lib/call-on-sale.ts). */
export { hasDateOnSale };

/**
 * The line under the title that says what the pill cannot: the length of a
 * call, a course's lessons, a free trial, a set number of payments, a price
 * the buyer chooses. Every one of them is something the checkout will do.
 */
export function ProductFacts({
  store,
  product,
  linkCourse = true,
  bundleItems = null,
  videoLine = null,
}: {
  store: Store;
  product: Listing;
  linkCourse?: boolean;
  /** For a bundle: what it hands over now (lib/bundles.ts, offeredItems). */
  bundleItems?: Listing[] | null;
  /**
   * For a course: how long its video runs, worked out by the code
   * (lib/course-facts.ts, 292 [SQ3]); only the page that read it passes it,
   * and null when any video's length is unknown.
   */
  videoLine?: string | null;
}) {
  const pwyw = activePwyw(product);
  const options = sellableOptions(product);
  const { w, money } = speech(store);
  const facts: string[] = [];
  // A bundle: how many products, and — only when it is true — what they cost
  // on their own, from their prices today (lib/bundle-rules.ts).
  const inside = product.bundle && bundleItems && bundleItems.length >= MIN_BUNDLE_ITEMS ? bundleItems : null;
  const pick = picks(product);
  if (inside && pick) {
    // Chosen by the buyer: how many of how many, and no sum of the whole list.
    facts.push(pickWords(store.language).fact(pick, inside.length));
  } else if (inside) {
    facts.push(w.bundleOf(inside.length, worthLine(store, inside, product.priceCents)));
  }
  if (product.call) facts.push(callLine(store, product.call, product.priceCents));
  if (product.podcast && product.podcast.episodes > 0) {
    facts.push(w.podcast(product.podcast.episodes));
  }
  // A membership's introductory price (lib/intro-price.ts) is said wherever its price is.
  const intro = activeIntro(product, store.tiers);
  if (product.recurring && (product.recurring.trialDays > 0 || product.recurring.payments > 0 || intro)) {
    const price = money(fromPriceCents(product));
    facts.push(`${options.length > 1 ? w.fromCapital : ""}${membershipLine(store, product.recurring, price, intro)}`.replace(/^(\p{Ll})/u, (c) => c.toUpperCase()));
  }
  // And a yearly price beside the monthly one (lib/yearly-price.ts), with what it saves.
  const yearlyFact = activeYearly(product, store.tiers);
  if (yearlyFact) facts.push(w.yearlyFact(money(yearlyFact.cents), money(yearlySaving(product.priceCents, yearlyFact))));
  if (pwyw) {
    facts.push(w.pwywFact(money(product.priceCents), money(pwyw.suggestedCents)));
  }
  const course = product.course && product.course.lessons > 0 ? product.course : null;
  if (facts.length === 0 && !course) return null;
  return (
    <>
      {facts.map((fact) => (
        <p key={fact} className="st-muted mt-1 text-sm font-semibold">
          {fact}
        </p>
      ))}
      {inside && linkCourse ? (
        <p className="st-muted mt-1 text-sm">
          {w.includes(inside.slice(0, 4).map((p) => p.title).join(", "), Math.max(0, inside.length - 4))}
        </p>
      ) : null}
      {course ? (
        <p className="mt-1 text-sm font-semibold">
          <span className="st-muted">{w.course(course.lessons)}</span>
          {videoLine ? <span className="st-muted">{` · ${videoLine}`}</span> : null}
          {linkCourse ? (
            <>
              <span className="st-muted">{" · "}</span>
              <Link prefetch={false} href={`/@${store.handle}/course/${product.id}`} className="underline underline-offset-2" style={{ color: "var(--st-text)" }}>
                {w.seeInside}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

/**
 * A weekly call's package, beside its single price (lib/call-package-rules.ts):
 * several sessions paid at once and booked one at a time.
 */
export function PackageOffer({ store, product }: { store: Store; product: Listing }) {
  const pkg = product.callPackage;
  if (!pkg || product.call?.kind !== "weekly") return null;
  const saving = packageSaving(pkg, product.priceCents);
  const { w, money } = speech(store);
  return (
    <form action="/api/store/package" method="post" target="_top" className="mt-3" data-checkout="">
      <input type="hidden" name="handle" value={store.handle} />
      <input type="hidden" name="product" value={product.id} />
      <button type="submit" className="btn btn-block" style={{ border: "1px solid var(--st-line-strong)", color: "var(--st-text)", background: "var(--st-card)" }}>
        {w.buySessions(pkg.sessions, money(pkg.priceCents))}
      </button>
      <p className="st-muted mt-2 text-center text-xs">
        {w.packageNote(saving > 0 ? money(saving) : null, pkg.sessions, w.packageLimit(pkg.days))}
      </p>
    </form>
  );
}

/**
 * Which of a product's prices is being bought for somebody else: a list to
 * pick from, each with its price, the creator's pick listed first and none
 * chosen for the buyer (487 [IT4]): the form asks for a choice. Nothing for
 * a product sold at one price. The price charged is read on the server from
 * the option's id, never from this list.
 */
function GivenOptionPicker({ store, product, each = false }: { store: Store; product: Listing; each?: boolean }) {
  const options = optionsInPickOrder(givableOptions(product));
  if (options.length === 0) return null;
  const { w, money } = speech(store);
  return (
    <label className="block">
      <span className="st-label">{w.whichOne}</span>
      <select className="st-field mt-2" name="option" required defaultValue="">
        <option value="" disabled>
          {w.chooseOne}
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {w.priced(option.label, `${money(option.priceCents)}${each ? w.perPerson : ""}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Buying a product for somebody else: their address, the buyer's name and a
 * message, then Stripe's page as for anything else (lib/gifts.ts). Folded
 * away under the buy box, because most buyers buy for themselves.
 */
export function GiftBox({ store, product, problem = "", consentAgain = false }: { store: Store; product: Listing; problem?: string; consentAgain?: boolean }) {
  const { w, money } = speech(store);
  const problems = w.giftProblems;
  return (
    <details id="gift" className="mt-4 scroll-mt-24 rounded-2xl px-4 py-3" style={{ border: "1px solid var(--st-line)" }} open={Boolean(problem)}>
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold" style={{ color: "var(--st-text)" }}>
        {w.giftSummary}
      </summary>
      <form action="/api/store/checkout" method="post" target="_top" className="mt-2 space-y-3 pb-1" data-checkout="">
        <input type="hidden" name="handle" value={store.handle} />
        <input type="hidden" name="product" value={product.id} />
        {problem && problems[problem] ? (
          <p className="st-note text-sm" role="alert">{problems[problem]}</p>
        ) : null}
        <GivenOptionPicker store={store} product={product} />
        <div>
          <label htmlFor={`gift-to-${product.id}`} className="st-label">{w.theirEmail}</label>
          <EmailField id={`gift-to-${product.id}`} name="gift_to" className="st-field mt-2" required autoComplete="off" placeholder={w.friendPlaceholder} language={store.language} />
        </div>
        <label className="block">
          <span className="st-label">{w.yourNameShown}</span>
          <input className="st-field mt-2" name="gift_from" maxLength={60} autoComplete="name" placeholder={w.namePlaceholder} />
        </label>
        <label className="block">
          <span className="st-label">{w.messageOptional}</span>
          <textarea className="st-field mt-2" name="gift_message" rows={3} maxLength={500} />
        </label>
        {deliversDigitally(product) ? <DigitalConsentBox id={`dc-gift-${product.id}`} kind={consentKind(product)} lang={store.language} refused={consentAgain && problem === "consent"} /> : <WithdrawalWhere lang={store.language} />}
        <button type="submit" className="btn st-btn btn-block">
          {product.options.length > 0 ? w.buyAsGift : w.buyAsGiftFor(money(salePrice(product.priceCents, offNow(store, product))))}
        </button>
        <p className="st-muted text-xs">
          {w.giftNote(store.name)}
        </p>
      </form>
    </details>
  );
}

/**
 * Buying a product for several people at once: how many, then Stripe's page
 * as for anything else, and one link that hands out the places
 * (lib/group-buy.ts). Folded away under the buy box, like the gift, because
 * most buyers buy for themselves. The price shown is per person; the total
 * is on Stripe's page before anything is paid.
 */
/**
 * One reminder with the link, asked for on the product's own page (added 9
 * October 2026; lib/checkout-ask.ts): for the visitor who is not ready yet —
 * reading on a phone, buying later at a desk. In about an hour, tomorrow or
 * in three days; one email, on no list. What happened is said here after
 * the form, from `asked` in the address.
 */
export function RemindBox({ store, product, asked = "", when = "hour" }: { store: Store; product: Listing; asked?: string; when?: string }) {
  const { w } = speech(store);
  const m = membershipWords(store.language);
  const said = isAskWhen(when) ? when : "hour";
  const notice = asked && asked !== "asked" ? m.leftNotices[asked] ?? m.leftNotices.error : null;
  return (
    <details id="remind" className="mt-4 scroll-mt-24 rounded-2xl px-4 py-3" style={{ border: "1px solid var(--st-line)" }} open={Boolean(asked)}>
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold" style={{ color: "var(--st-text)" }}>
        {m.notReady}
      </summary>
      {asked === "asked" ? (
        <div className="mt-2 space-y-2 pb-1" role="status">
          <p className="font-semibold">{m.done}</p>
          <p className="st-muted text-sm">{m.pageAsked(store.name, product.title, m.askSaid[said])}</p>
          <p className="st-muted text-xs">{m.onlyEmail}</p>
        </div>
      ) : (
        <form action="/api/store/remind" method="post" className="mt-2 space-y-3 pb-1">
          {notice ? (
            <p className="st-note text-sm" role="alert">
              <span className="font-semibold">{notice.title}.</span> {notice.body}
            </p>
          ) : null}
          <p className="st-muted text-sm">{m.pageRemindNote(store.name)}</p>
          <input type="hidden" name="handle" value={store.handle} />
          <input type="hidden" name="product" value={product.id} />
          <input type="hidden" name="from" value="page" />
          {/* Left empty by a person; filled in by something that fills in every field. */}
          <div aria-hidden="true" className="hidden">
            <label>
              {w.leaveEmpty}
              <input type="text" name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          <div>
            <label htmlFor={`ask-email-${product.id}`} className="st-label">{w.yourEmail}</label>
            <EmailField id={`ask-email-${product.id}`} name="email" className="st-field mt-2" required autoComplete="email" placeholder={w.emailPlaceholder} language={store.language} />
          </div>
          <label className="block">
            <span className="st-label">{m.askWhen}</span>
            <select className="st-field mt-2" name="when" defaultValue={said}>
              {(Object.keys(m.askTimes) as AskWhen[]).map((key) => (
                <option key={key} value={key}>
                  {m.askTimes[key]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn st-btn-ghost btn-block">
            {m.remindMe}
          </button>
          <p className="st-muted text-xs">{m.addressUse(store.name)}</p>
        </form>
      )}
    </details>
  );
}

export function GroupBox({ store, product, problem = "", consentAgain = false }: { store: Store; product: Listing; problem?: string; consentAgain?: boolean }) {
  const { w, money } = speech(store);
  const each = money(salePrice(product.priceCents, offNow(store, product)));
  const problems = w.teamProblems(MIN_PEOPLE, MAX_PEOPLE);
  return (
    <details id="group" className="mt-4 scroll-mt-24 rounded-2xl px-4 py-3" style={{ border: "1px solid var(--st-line)" }} open={Boolean(problem)}>
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold" style={{ color: "var(--st-text)" }}>
        {w.teamSummary}
      </summary>
      <form action="/api/store/checkout" method="post" target="_top" className="mt-2 space-y-3 pb-1" data-checkout="">
        <input type="hidden" name="handle" value={store.handle} />
        <input type="hidden" name="product" value={product.id} />
        {problem && problems[problem] ? (
          <p className="st-note text-sm" role="alert">{problems[problem]}</p>
        ) : null}
        <GivenOptionPicker store={store} product={product} each />
        <label className="block">
          <span className="st-label">{w.howManyPeople}</span>
          <input
            className="st-field mt-2"
            type="number"
            name="people"
            required
            min={MIN_PEOPLE}
            max={MAX_PEOPLE}
            step={1}
            defaultValue={DEFAULT_PEOPLE}
            inputMode="numeric"
          />
        </label>
        {deliversDigitally(product) ? <DigitalConsentBox id={`dc-group-${product.id}`} kind={consentKind(product)} lang={store.language} refused={consentAgain && problem === "consent"} /> : <WithdrawalWhere lang={store.language} />}
        <button type="submit" className="btn st-btn btn-block">
          {product.options.length > 0 ? w.buyForTeam : w.buyForTeamEach(each)}
        </button>
        <p className="st-muted text-xs">
          {w.teamNote}
        </p>
      </form>
    </details>
  );
}

/**
 * A product coming soon: an address for its waitlist, confirmed from the
 * inbox before it counts. The box to hear more from the creator starts
 * empty, like every such box here.
 */
export function WaitlistForm({ store, product, writes = false }: { store: Store; product: Listing; writes?: boolean }) {
  const { w } = speech(store);
  return (
    <form id="waitlist" action="/api/store/waitlist/join" method="post" className="mt-4 scroll-mt-24 space-y-3">
      <input type="hidden" name="handle" value={store.handle} />
      <input type="hidden" name="product" value={product.id} />
      <div aria-hidden="true" className="hidden">
        <label>
          {w.leaveEmpty}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <p className="text-sm font-bold" style={{ color: "var(--st-accent-text)" }}>{w.comingSoon}</p>
      <label htmlFor={`w-${product.id}`} className="st-label">
        {w.yourEmail}
      </label>
      <EmailField id={`w-${product.id}`} name="email" className="st-field" required autoComplete="email" placeholder={w.emailPlaceholder} language={store.language} />
      <label htmlFor={`wc-${product.id}`} className="st-muted flex min-h-11 cursor-pointer items-start gap-3 text-sm">
        <input id={`wc-${product.id}`} type="checkbox" name="consent" value="yes" data-joins="" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{w.alsoOtherEmails(store.name)}</span>
      </label>
      {writes ? <ClicksBox id={`wk-${product.id}`} label={w.alsoClicks(store.mail?.fromName || store.name)} /> : null}
      <button type="submit" className="btn st-btn btn-block">
        {w.tellMe}
      </button>
      <p className="st-muted text-xs">{w.waitlistNote(store.name)}</p>
    </form>
  );
}

/**
 * A product coming soon that takes pre-orders (lib/preorders.ts): paid today
 * at its price, said plainly with the day it is expected and what happens if
 * it does not come out, and the waitlist still there for whoever would rather
 * wait. Plain HTML, like every form that opens a payment page.
 */
export function PreorderForm({ store, product, day, writes = false, consentAgain = false }: { store: Store; product: Listing; day: string; writes?: boolean; consentAgain?: boolean }) {
  const { money, date } = speech(store);
  const p = preorderWords(store.language);
  const price = money(salePrice(product.priceCents, offNow(store, product)));
  const expected = date(Date.parse(`${day}T00:00:00Z`));
  return (
    <div className="mt-4">
      <form id="preorder" action="/api/store/checkout" method="post" target="_top" className="scroll-mt-24 space-y-3" data-checkout="">
        <input type="hidden" name="handle" value={store.handle} />
        <input type="hidden" name="product" value={product.id} />
        <input type="hidden" name="preorder" value="yes" />
        <p className="text-sm font-bold" style={{ color: "var(--st-accent-text)" }}>{p.expected(expected)}</p>
        {deliversDigitally(product) ? <DigitalConsentBox id={`dc-pre-${product.id}`} lang={store.language} refused={consentAgain} /> : <WithdrawalWhere lang={store.language} />}
        <button type="submit" className="btn st-btn btn-block">
          {p.button(price)}
        </button>
        <p className="st-muted text-sm">{p.note}</p>
        <p className="st-muted text-xs">{p.refund(store.name)}</p>
      </form>
      <details className="mt-4">
        <summary className="st-footer-link cursor-pointer text-sm font-semibold">{p.orWait}</summary>
        <WaitlistForm store={store} product={product} writes={writes} />
      </details>
    </div>
  );
}

/**
 * The part of a product a buyer acts on: the form that gives it away, the
 * button that books a call, or the form that opens a checkout, with its
 * price options, plan, box for the product offered alongside and box for the
 * creator's emails.
 *
 * The same on the store page and on the product's own page, because a buyer
 * who read more before buying must not meet different terms there. Every
 * form is plain HTML: it works with JavaScript turned off, and nothing it
 * sends can set a price.
 */
/**
 * The second box, under the one that joins the list: allowing the creator to
 * see which links in a sequence's emails this person uses (lib/mail-clicks.ts).
 * Empty, and shown only once the first is ticked (globals.css, .ask-clicks);
 * the server counts it only with the first.
 */
export function ClicksBox({ id, label, className = "", always = false }: { id: string; label: string; className?: string; always?: boolean }) {
  return (
    <label htmlFor={id} className={`st-muted min-h-11 cursor-pointer items-start gap-3 text-sm ${always ? "flex" : "ask-clicks"} ${className}`} data-clicks-box="">
      <input id={id} type="checkbox" name="clicks" value="yes" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{label}</span>
    </label>
  );
}

export function BuyBox({
  store,
  product,
  remaining,
  writes,
  selling,
  related,
  ready = true,
  unread = false,
  soon = false,
  preorder = null,
  bundleItems = null,
  pickAgain = false,
  place = "",
  consentAgain = false,
  embed = null,
  stepped = false,
  chosenOption = null,
}: {
  store: Store;
  product: Listing;
  /** Other products read with this one: the one its order bump offers, when it has one. */
  related: Listing[];
  /** Units left of a limited product, or null when it is not limited. */
  remaining: number | null;
  /** Whether buyers may be asked to hear from the creator. */
  writes: boolean;
  /** Whether the store can take a payment at all right now. */
  selling: boolean;
  /** For a bundle: whether it holds enough to hand over right now. */
  ready?: boolean;
  /**
   * Whether it can be bought could not be read just now: its license keys left (lib/licence-keys.ts outOfKeys). Unknown
   * is never "keys left" (CX-123 rule 24): no way to buy is drawn, and the box says buying is not available just now,
   * as the card on the creator's own site does.
   */
  unread?: boolean;
  /** Coming soon: a waitlist instead of a way to pay (lib/waitlist.ts). */
  soon?: boolean;
  /** Coming soon and taking pre-orders: the day it is expected (lib/preorders.ts, preorderDay). */
  preorder?: string | null;
  /** For a bundle: what it hands over now, which a bundle its buyer builds is chosen from (lib/bundle-rules.ts). */
  bundleItems?: Listing[] | null;
  /** The page came back because the buyer's choice was not that many. */
  pickAgain?: boolean;
  /**
   * Set when the same box is drawn twice on one page — the offer to a leaving
   * visitor (components/exit-offer-slot.tsx) beside the product's own card —
   * so the two forms' fields keep ids of their own.
   */
  place?: string;
  /** The page came back because the box to start access at once was not checked (lib/digital-consent.ts). */
  consentAgain?: boolean;
  /** Opened from a card on one of the creator's listed sites: carried to the checkout, which checks it against the store's list. */
  embed?: { site: string; back: string } | null;
  /**
   * Drawn on a card in a list of products (the store page, a collection): where buying asks for the box to start
   * access at once (lib/digital-consent.ts), the card leads to the product's own buy step instead, so the box, its
   * note and the closing sentence are drawn once, directly above the Buy button they belong to (Encanto 3,
   * C4-20261106-0520-TODOS-19), not repeated on every card.
   */
  stepped?: boolean;
  /**
   * The price option a link to this page named (630 [HN6](27), lib/option-link-rules.ts linkedOption): drawn chosen,
   * and said so above the options, because the buyer clicked a link for it. Null chooses nothing, as always (487 [IT4]).
   */
  chosenOption?: string | null;
}) {
  // The card's way to the buy step: the words the product page's own buttons use (pageAction), and its name for a
  // screen reader, so the link says on its own what it is for (WCAG 2.4.9).
  const toStep = (anchor: string) => (
    <Link prefetch={false} href={`${productPath(store, product)}${anchor}`} className="btn st-btn btn-block mt-4" data-buy-step="">
      {pageAction(store, product, remaining, selling, related, soon, preorder).label}
      <span className="sr-only">{`: ${product.title}`}</span>
    </Link>
  );
  if (unread) return <p className="st-muted mt-4 text-sm">{speech(store).w.cardBuyUnread}</p>;
  if (soon && !isFree(product) && preorder && stepped) return toStep("#preorder");
  if (soon && !isFree(product)) return preorder ? <PreorderForm store={store} product={product} day={preorder} writes={writes} consentAgain={consentAgain} /> : <WaitlistForm store={store} product={product} writes={writes} />;
  const { w, money } = speech(store);
  const options = sellableOptions(product);
  // Only an option this box offers right now can be the one the link chose.
  const linked = chosenOption && options.some((option) => option.id === chosenOption) ? options.find((option) => option.id === chosenOption)! : null;
  const every = product.recurring ? ` ${w.every(product.recurring.interval)}` : "";
  // What one costs in each option whose name says how many (lib/option-units.ts); not for a membership's price.
  const units = product.recurring ? new Map<string, UnitLine>() : unitLines(options);
  const unitWords = (u: UnitLine) => [w.perUnit(money(u.perUnitCents), u.unit), u.savePercent ? w.unitSaving(u.savePercent) : ""].filter(Boolean).join(" · ");
  const soldOut = remaining === 0;
  // The boxes at checkout, each checked or not on its own (lib/product-extras.ts).
  const extras = activeBumps(related, product);
  const plan = activePlan(product);
  // On a product with several prices, each one's payments: "3 monthly payments of $13".
  const planAt = (optionId: string) => {
    const each = plan && options.length > 0 ? planFor(product, optionId) : null;
    return each ? planLine(store, each) : null;
  };
  const pwyw = activePwyw(product);
  // Shipped by the creator (lib/shipping.ts): said under the button.
  const shipping = activeShipping(product);
  const sw = shippingWords(store.language);
  const trial = product.recurring && product.recurring.trialDays > 0 ? product.recurring.trialDays : 0;
  // A membership's introductory price (lib/intro-price.ts): what the button and the line under it say.
  const intro = activeIntro(product, store.tiers);
  // Or a yearly price beside the monthly one (lib/yearly-price.ts): picked here, before paying.
  const yearly = activeYearly(product, store.tiers);
  // A store-wide sale on this product right now (lib/store-sale.ts): its price everywhere below.
  const off = offNow(store, product);

  if (isFree(product)) {
    return canGiveProduct(store, product) ? (
      /*
        Given away for an address, and the address is only kept once its owner
        uses the link we email. The box starts empty and stays the visitor's
        to tick: wanting the file is not agreeing to more email.
      */
      <form action="/api/store/free" method="post" className="mt-4 space-y-3">
        <input type="hidden" name="handle" value={store.handle} />
        <input type="hidden" name="product" value={product.id} />
        <div aria-hidden="true" className="hidden">
          <label>
            {w.leaveEmpty}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <label htmlFor={`e-${place}${product.id}`} className="st-label">
          {w.yourEmail}
        </label>
        <EmailField id={`e-${place}${product.id}`} name="email" className="st-field" required autoComplete="email" placeholder={w.emailPlaceholder} language={store.language} />
        <label htmlFor={`c-${place}${product.id}`} className="st-muted flex min-h-11 cursor-pointer items-start gap-3 text-sm">
          <input id={`c-${place}${product.id}`} type="checkbox" name="consent" value="yes" data-joins="" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{w.alsoEmails(store.name)}</span>
        </label>
        {writes ? <ClicksBox id={`k-${place}${product.id}`} label={w.alsoClicks(store.mail?.fromName || store.name)} /> : null}
        <button type="submit" className="btn st-btn btn-block">
          {w.emailItToMe}
        </button>
        <p className="st-muted text-xs">{w.freeNote(store.name)}</p>
      </form>
    ) : (
      <p className="st-muted mt-4 text-sm">{w.notAvailable}</p>
    );
  }

  if (product.call && canSellProduct(store, product)) {
    // Dated sessions with none left to book: said here, rather than a button
    // to a page with nothing on it.
    if (!hasDateOnSale(product.call)) {
      return <p className="st-muted mt-4 text-sm">{w.noDates}</p>;
    }
    return (
      <>
        <Link prefetch={false} href={`/@${store.handle}/book/${product.id}`} className="btn st-btn btn-block mt-4">
          {/* Several lengths (lib/call-lengths.ts): from the lowest of their prices, as the card says it. */}
          {w.priced(product.call.kind === "live" ? w.pickSession : w.pickTime, listedLengths(product.call, product.priceCents).length ? pricePill(store, product) : money(product.priceCents))}
        </Link>
        <PackageOffer store={store} product={product} />
      </>
    );
  }

  if (soldOut) return null;

  // The creator's own PayPal, as well as Stripe or instead of it (lib/paypal-sales.ts).
  const withPayPal = ready && paypalReady(store, product);
  if (!canSellProduct(store, product) || !ready) {
    if (withPayPal) return stepped ? toStep("#buy") : <PayPalButton store={store} product={product} alone consentAgain={consentAgain} />;
    /*
      Sellable store, but this one has nothing attached to hand over. Better to
      say so than to take the money and work out the delivery afterward.
    */
    return selling ? <p className="st-muted mt-4 text-sm">{w.notOnSale}</p> : null;
  }

  // A bundle its buyer builds: the products to choose from, and the button
  // that buys exactly those. Where the list is not at hand, the way to it.
  const pick = picks(product);
  if (pick) {
    if (!bundleItems || !bundleReady(product, bundleItems.length)) {
      return (
        <Link prefetch={false} href={`${productPath(store, product)}#buy`} className="btn st-btn btn-block mt-4">
          {pickWords(store.language).legend(pick)}
        </Link>
      );
    }
    return (
      <PickBundleForm
        handle={store.handle}
        productId={product.id}
        pick={pick}
        items={bundleItems.map((item) => ({ id: item.id, title: item.title, cents: item.priceCents }))}
        priceCents={salePrice(product.priceCents, off)}
        currency={store.currency}
        locale={speech(store).lang.locale}
        lang={store.language}
        again={pickAgain}
        place={place}
        consentAgain={consentAgain}
      />
    );
  }

  // The box to start during the cancellation period (lib/digital-consent.ts):
  // required where the product itself hands something over digitally, which
  // is the same for every option (a shipped product holds nothing digital on
  // any option, lib/shipping.ts), so the page and the server agree whichever
  // option is picked; offered, and asked for by the server only if one is
  // checked, where only an added product does (beside a shipped one). Its
  // form also carries the PayPal button, so one box serves both.
  const formId = `buy-${place}${product.id}`;
  const digitalHere = deliversDigitally(product, null);
  const digitalAdded = !digitalHere && extras.some((extra) => deliversDigitally(extra.target));
  if (stepped && (digitalHere || digitalAdded)) return toStep("#buy");
  return (
    <>
    <form id={formId} action="/api/store/checkout" method="post" target="_top" className="mt-4" data-checkout="">
      <input type="hidden" name="handle" value={store.handle} />
      <input type="hidden" name="product" value={product.id} />
      {embed?.site ? <input type="hidden" name="site" value={embed.site} /> : null}
      {embed?.back ? <input type="hidden" name="return" value={embed.back} /> : null}
      {/*
        target="_top", here and on every form that opens a payment page:
        Stripe and PayPal refuse to be drawn inside a frame, and the home
        page shows the demo store in one (components/home-parts.tsx). Without
        it the payment page lands in the frame and the buyer sees a blocked,
        empty panel. On a page that is not framed "_top" is the same window,
        so nothing changes. tests/demo-store.test.ts holds every such form.
      */}
      {/*
        Radio cards, and nothing else. The form sends the id of the option the
        buyer picked; what it costs is read from the creator's own record on
        the server, so the price cannot be sent from here. Plain radios also
        mean the choice works with JavaScript turned off.
      */}
      {options.length > LIST_ABOVE ? (
        /*
          Past a handful, a list to pick from rather than a wall of cards: a
          phone shows it as the system's own picker, and it still sends only
          the id. Each line carries its price, so nothing is hidden by it.
        */
        <div className="mb-4">
          <label htmlFor={`os-${product.id}`} className="st-label">{w.chooseOptionFor(product.title)}</label>
          {linked ? <p className="st-muted mt-1 text-sm" data-option-from-link="">{w.optionFromLink(linked.label)}</p> : null}
          <select id={`os-${product.id}`} name="option" required defaultValue={linked ? linked.id : ""} className="st-field mt-2">
            <option value="" disabled>
              {w.chooseOne}
            </option>
            {optionsInPickOrder(options).map((option) => (
              <option key={option.id} value={option.id}>
                {`${w.priced(option.label, `${money(option.priceCents)}${every}`)}${units.get(option.id) ? ` (${unitWords(units.get(option.id)!)})` : ""}${planAt(option.id) ? ` · ${w.orPlan(planAt(option.id)!)}` : ""}${option.best ? w.recommendedAfter : ""}`}
              </option>
            ))}
          </select>
        </div>
      ) : options.length > 0 ? (
        <fieldset className="mb-4">
          <legend className="sr-only">{w.chooseOptionFor(product.title)}</legend>
          {linked ? <p className="st-muted mb-2 text-sm" data-option-from-link="">{w.optionFromLink(linked.label)}</p> : null}
          {/*
            With what each includes written down, the cards stand side by side
            on a wide screen so the buyer can compare them; on a phone they
            stack. The creator's pick is listed first and says so, in the
            creator's voice: "Recommended", never a claim about other buyers;
            nothing is chosen for the buyer, and the form asks for a choice
            (487 [IT4]).
          */}
          <div className={comparable(options) ? `st-compare st-compare-${Math.min(options.length, 3)}` : "space-y-2"}>
            {optionsInPickOrder(options).map((option) => (
              <label key={option.id} htmlFor={`o-${option.id}`} className={comparable(options) ? "st-option st-option-card" : "st-option"}>
                <span className="flex items-center gap-3">
                  <input
                    id={`o-${option.id}`}
                    type="radio"
                    name="option"
                    value={option.id}
                    required
                    defaultChecked={linked?.id === option.id}
                    className="h-4 w-4"
                  />
                  <span className="font-bold">{option.label}</span>
                  {option.best ? <span className="st-pick">{w.recommended}</span> : null}
                </span>
                <span className="font-semibold tabular-nums">{`${money(option.priceCents)}${every}`}</span>
                {units.get(option.id) ? <span className="st-muted st-unit text-sm tabular-nums">{unitWords(units.get(option.id)!)}</span> : null}
                {/* With a payment plan, what each payment is at this price: the plan's radio below says how many. */}
                {planAt(option.id) ? <span className="st-muted st-unit text-sm tabular-nums">{w.orPlan(planAt(option.id)!)}</span> : null}
                {option.details.length > 0 ? (
                  <ul className="st-includes">
                    {option.details.map((line, at) => (
                      <li key={at}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {plan ? (
        <fieldset className="mb-4">
          <legend className="sr-only">{w.howToPayFor(product.title)}</legend>
          <div className="space-y-2">
            {/* With several prices, the amounts are written beside each price above, so these say only how. */}
            <label htmlFor={`pf-${place}${product.id}`} className="st-option">
              <span className="flex items-center gap-3">
                <input id={`pf-${place}${product.id}`} type="radio" name="pay" value="full" defaultChecked className="h-4 w-4" />
                <span className="font-bold">{w.payInFull}</span>
              </span>
              {options.length > 0 ? null : <span className="font-semibold tabular-nums">{money(salePrice(product.priceCents, off))}</span>}
            </label>
            <label htmlFor={`pp-${place}${product.id}`} className="st-option">
              <span className="flex items-center gap-3">
                <input id={`pp-${place}${product.id}`} type="radio" name="pay" value="plan" className="h-4 w-4" />
                <span className="font-bold">{planLine(store, plan)}</span>
              </span>
              {options.length > 0 ? null : <span className="font-semibold tabular-nums">{w.today(money(plan.amountCents))}</span>}
            </label>
          </div>
        </fieldset>
      ) : null}
      {yearly && product.recurring ? (
        <fieldset className="mb-4">
          <legend className="sr-only">{w.howToPayFor(product.title)}</legend>
          <div className="space-y-2">
            <label htmlFor={`bm-${place}${product.id}`} className="st-option">
              <span className="flex items-center gap-3">
                <input id={`bm-${place}${product.id}`} type="radio" name="billing" value="month" defaultChecked className="h-4 w-4" />
                <span className="font-bold">{w.billMonthly}</span>
              </span>
              <span className="font-semibold tabular-nums">{`${money(product.priceCents)} ${w.every("month")}`}</span>
            </label>
            <label htmlFor={`by-${place}${product.id}`} className="st-option">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <input id={`by-${place}${product.id}`} type="radio" name="billing" value="year" className="h-4 w-4" />
                <span className="font-bold">{w.billYearly}</span>
                <span className="st-pick">{w.yearSave(money(yearlySaving(product.priceCents, yearly)))}</span>
              </span>
              <span className="font-semibold tabular-nums">{`${money(yearly.cents)} ${w.every("year")}`}</span>
            </label>
          </div>
        </fieldset>
      ) : null}
      {extras.map((extra, slot) => (
        /*
          Never ticked for the buyer. The form sends which product the box
          offers and nothing else: what it costs is the creator's price for it
          here, read on the server.
        */
        <label key={extra.target.id} htmlFor={`b-${place}${product.id}-${slot}`} className={`st-option !items-start ${slot === extras.length - 1 ? "mb-4" : "mb-2"}`} style={{ borderStyle: "dashed" }}>
          <span className="flex items-start gap-3">
            <input id={`b-${place}${product.id}-${slot}`} type="checkbox" name="bump" value={extra.target.id} data-bump={slot} className="mt-1 h-4 w-4 shrink-0" />
            <span>
              <span className="block font-bold">{w.addFor(extra.target.title, money(salePrice(extra.bump.priceCents, off)))}</span>
              {extra.target.bundle ? (
                <span className="st-muted mt-0.5 block text-sm">{w.bundleBox(extra.target.bundle.length)}</span>
              ) : null}
              {extra.bump.pitch ? <span className="st-muted mt-0.5 block text-sm">{extra.bump.pitch}</span> : null}
              {extra.bump.priceCents < extra.target.priceCents ? (
                <span className="st-muted mt-0.5 block text-xs">{w.onItsOwn(money(extra.target.priceCents))}</span>
              ) : null}
            </span>
          </span>
        </label>
      ))}
      {writes || syncTakesBuyer(store, product.id) ? (
        /* Starts empty, like every box here: buying is not agreeing to more email.
           Offered where the creator writes to their list here, or sends this
           product's buyers to their own email platform (lib/email-sync.ts). */
        <>
          <label htmlFor={`n-${product.id}`} className="st-muted mb-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm">
            <input id={`n-${product.id}`} type="checkbox" name="news" value="yes" data-joins="" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{w.alsoEmails(store.mail?.fromName || store.name)}</span>
          </label>
          {writes ? <ClicksBox id={`k-${product.id}`} label={w.alsoClicks(store.mail?.fromName || store.name)} className="mb-4" /> : null}
        </>
      ) : null}
      {/* Starts unchecked: one reminder if this checkout is left unpaid, only when asked for here (lib/assistant-reminder.ts). */}
      {assistReminderOffered(store, product) ? <AssistReminderBox id={`r-${place}${product.id}`} lang={store.language} store={store.name} className="mb-4" /> : null}
      {digitalHere || digitalAdded ? <DigitalConsentBox id={`dc-${place}${product.id}`} kind={consentKind(product)} lang={store.language} refused={consentAgain} required={digitalHere} className="mb-4" /> : <WithdrawalWhere lang={store.language} className="mb-4" />}
      <button type="submit" className="btn st-btn btn-block">
        <span className="bump-off">
          {pwyw
            ? w.chooseYourPrice
            : trial
              ? w.startTrial(trial)
              : options.length > 0
                ? product.recurring
                  ? w.subscribe
                  : w.continueOption
                : product.recurring
                  ? intro
                    ? w.subscribeFor(money(intro.cents), w.introFirst(intro.count, product.recurring.interval))
                    : w.subscribeFor(money(product.priceCents), every.trim())
                  : w.buyFor(money(salePrice(product.priceCents, off)))}
        </span>
        {/*
          With boxes checked, the button says the new total. One line is
          written for every combination of boxes, and the stylesheet shows
          the one that matches what is checked (app/globals.css, "Boxes at
          checkout"), so it is right with scripts turned off too.
        */}
        {plan ? <span className="plan-on">{options.length > 0 ? w.continueOption : w.startPlanToday(money(plan.amountCents))}</span> : null}
        {/* Paid yearly: the button says the year's price (app/globals.css, "Boxes at checkout"). A trial says the trial either way. */}
        {yearly && !trial ? <span className="year-on">{w.subscribeFor(money(yearly.cents), w.every("year"))}</span> : null}
        {combinations(extras.length).map((picked) => {
          const chosen = extras.filter((_, slot) => picked.includes(slot));
          const added = chosen.reduce((sum, extra) => sum + salePrice(extra.bump.priceCents, off), 0);
          const code = [0, 1, 2].map((slot) => (picked.includes(slot) ? "1" : "0")).join("");
          const named = chosen.length === 1 ? chosen[0].target.title : w.nAdded(chosen.length);
          return (
            <span key={code}>
              {plan ? (
                <span className={`plan-bump-t pt-${code}`}>
                  {options.length > 0 ? w.buyItWith(named) : w.startPlanWith(named, money(plan.amountCents + chosen.reduce((sum, extra) => sum + extra.bump.priceCents, 0)))}
                </span>
              ) : null}
              <span className={`bump-t t-${code}`}>
                {options.length > 0
                  ? w.buyItWith(named)
                  : w.buyAllFor(chosen.length, money(salePrice(product.priceCents, off) + added))}
              </span>
            </span>
          );
        })}
      </button>
      {shipping ? (
        /* A product the creator ships (lib/shipping.ts): what shipping costs and where it goes, before anybody pays. */
        <p className="st-muted mt-2 text-center text-xs" data-shipping="">
          {[
            shipping.cents > 0 ? sw.cost(money(shipping.cents)) : sw.free,
            sw.shipsTo(shipsToWords(shipping, speech(store).lang.locale, sw)),
            shipping.note,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {pwyw ? (
        <p className="st-muted mt-2 text-center text-xs">
          {w.pwywNote(money(product.priceCents), money(pwyw.suggestedCents))}
        </p>
      ) : null}
      {trial && product.recurring ? (
        <p className={`st-muted mt-2 text-center text-xs ${yearly ? "year-off" : ""}`}>
          {w.trialNote(trial, membershipLine(store, { ...product.recurring, trialDays: 0 }, money(fromPriceCents(product))), product.recurring.payments === 0)}
        </p>
      ) : null}
      {trial && yearly ? (
        // Paid yearly, what follows the trial is the year's price (app/globals.css, "Boxes at checkout").
        <p className="year-on-block st-muted mt-2 text-center text-xs">{w.trialNote(trial, `${money(yearly.cents)} ${w.every("year")}`, true)}</p>
      ) : null}
      {intro && product.recurring ? (
        <p className="st-muted mt-2 text-center text-xs">
          {`${membershipLine(store, product.recurring, money(product.priceCents), intro)}.`.replace(/^(\p{Ll})/u, (c) => c.toUpperCase())}
        </p>
      ) : null}
      {product.recurring && store.tiers.includes(product.id) ? (
        <p className="st-muted mt-2 text-center text-xs">{w.switchPlansNote}</p>
      ) : null}
      <SaleNote store={store} product={product} />
    </form>
    {withPayPal ? <PayPalButton store={store} product={product} alone={false} formId={formId} /> : null}
    </>
  );
}

/**
 * Paying with PayPal, into the creator's own PayPal account: one product at
 * its one price, nothing added. A plain form; the price is read on the server.
 */
function PayPalButton({ store, product, alone, formId = "", consentAgain = false }: { store: Store; product: Listing; alone: boolean; formId?: string; consentAgain?: boolean }) {
  const { w, money } = speech(store);
  if (!alone && formId) {
    // Beside the card checkout: the same form, sent to PayPal instead, so the
    // box above it (lib/digital-consent.ts) is the one this payment needs too.
    // The PayPal route reads only the handle, the product and that box.
    return (
      <div className="mt-3">
        <button type="submit" form={formId} formAction="/api/store/paypal/checkout" formMethod="post" formTarget="_top" className="btn btn-block st-btn-ghost">
          {w.payPal(alone, money(payPalPrice(store, product)))}
        </button>
        <p className="st-muted mt-2 text-center text-xs">{w.payPalNote(store.name)}</p>
      </div>
    );
  }
  return (
    <form action="/api/store/paypal/checkout" method="post" target="_top" className={alone ? "mt-4" : "mt-3"}>
      <input type="hidden" name="handle" value={store.handle} />
      <input type="hidden" name="product" value={product.id} />
      {/* Everything PayPal sells here is handed over digitally (lib/paypal-sales.ts, sellsWithPayPal). */}
      <DigitalConsentBox id={`dc-pp-${product.id}`} lang={store.language} refused={consentAgain} className="mb-4" />
      <button type="submit" className={`btn btn-block ${alone ? "st-btn" : "st-btn-ghost"}`}>
        {w.payPal(alone, money(payPalPrice(store, product)))}
      </button>
      <p className="st-muted mt-2 text-center text-xs">{w.payPalNote(store.name)}</p>
      {alone ? <SaleNote store={store} product={product} /> : null}
    </form>
  );
}

/** Every set of boxes a buyer can check, the empty one left out: [[0], [1], [0, 1], …]. */
function combinations(count: number): number[][] {
  const out: number[][] = [];
  for (let mask = 1; mask < 1 << count; mask += 1) out.push([0, 1, 2].filter((slot) => mask & (1 << slot)));
  return out;
}

/**
 * Where a button on a product's page of blocks leads, by the same rules as
 * the buy box: straight to Stripe's checkout when there is nothing to choose
 * first, to the buy box when there is (a price option, a payment plan, the
 * product offered alongside), to the booking page for a call, to the sign-up
 * form for something free, and nowhere — with the reason said — when it
 * cannot be bought right now. The label is what the button says when the
 * creator left it empty.
 */
export function pageAction(
  store: Store,
  product: Listing,
  remaining: number | null,
  selling: boolean,
  /** What its order bump offers, read by the page (lib/catalog.ts), as the buy box is given it. */
  related: Listing[],
  /** Coming soon: the buttons lead to its waitlist (lib/waitlist.ts). */
  soon = false,
  /** Coming soon and taking pre-orders: the buttons lead to the pre-order (lib/preorders.ts). */
  preorder: string | null = null,
): { action: PageAction; label: string } {
  const { w, money } = speech(store);
  if (soon && !isFree(product) && preorder) {
    return { action: { kind: "link", href: "#preorder" }, label: preorderWords(store.language).button(money(salePrice(product.priceCents, offNow(store, product)))) };
  }
  if (soon && !isFree(product)) return { action: { kind: "link", href: "#waitlist" }, label: w.joinWaitlist };
  if (isFree(product)) {
    return canGiveProduct(store, product)
      ? { action: { kind: "link", href: "#get" }, label: w.getItFree }
      : { action: { kind: "none", text: w.notAvailable }, label: "" };
  }
  if (product.call) {
    return canSellProduct(store, product) && hasDateOnSale(product.call)
      ? { action: { kind: "link", href: `/@${store.handle}/book/${product.id}` }, label: product.call.kind === "live" ? w.pickSession : w.pickTime }
      : { action: { kind: "none", text: w.noDates }, label: "" };
  }
  if (remaining === 0) return { action: { kind: "none", text: w.soldOutStop }, label: "" };
  // A bundle its buyer builds is chosen in its buy box before it is bought.
  const pick = picks(product);
  if (pick && canSellProduct(store, product)) return { action: { kind: "link", href: "#buy" }, label: pickWords(store.language).legend(pick) };
  if (!canSellProduct(store, product)) {
    // Sold through the creator's PayPal only: the buttons lead to the buy box, where PayPal's is.
    if (paypalReady(store, product)) return { action: { kind: "link", href: "#buy" }, label: w.buyFor(money(payPalPrice(store, product))) };
    return { action: { kind: "none", text: selling ? w.notOnSale : w.cannotTakePayments }, label: "" };
  }
  const trial = product.recurring && product.recurring.trialDays > 0 ? product.recurring.trialDays : 0;
  if (sellableOptions(product).length > 0 || activePlan(product) || activeBumps(related, product).length > 0 || activeYearly(product, store.tiers)) {
    return { action: { kind: "link", href: "#buy" }, label: trial ? w.startTrial(trial) : w.chooseAndBuy };
  }
  // Handed over digitally: the buyer first checks the box to start access at
  // once (lib/digital-consent.ts), which is in the buy box, so the buttons
  // lead there, as they do for anything to choose before paying. Only a
  // product that is shipped with nothing digital goes straight to paying.
  const direct = !deliversDigitally(product);
  return {
    action: direct ? { kind: "checkout", handle: store.handle, product: product.id } : { kind: "link", href: "#buy" },
    label: activePwyw(product)
      ? w.chooseYourPrice
      : trial
        ? w.startTrial(trial)
        : product.recurring
          ? introButton(store, product) ?? w.subscribeFor(money(product.priceCents), w.every(product.recurring.interval))
          : w.buyFor(money(salePrice(product.priceCents, offNow(store, product)))),
  };
}

/**
 * One product on the store page, drawn in the style the creator picked.
 *
 *   Button   the card as it has always been, with a small picture beside the
 *            title when there is one;
 *   Callout  the picture beside the title, the summary and the price;
 *   Preview  the picture across the top of the card, then everything else.
 *
 * Every style carries the same facts and the same buy box. The title, and the
 * picture, lead to the product's own page, where the long description is.
 */
/**
 * A product's title on its card: a 44 × 44 px target (WCAG 2.5.5 AAA), wide enough even for a title of one letter.
 * The padding keeps the hover line under the words, drawn in the content box, not at the foot of the taller box.
 */
const TITLE_LINK = "st-title-link inline-flex min-h-11 min-w-11 items-center py-2.5 [background-clip:content-box] [background-origin:content-box]";

export function ProductCard({
  store,
  product,
  related,
  remaining,
  writes,
  selling,
  manageable,
  eager = false,
  first = false,
  rating = null,
  bundleItems = null,
  soon = false,
  preorder = null,
  cart = false,
  sold = null,
  grid = false,
  unread = false,
}: {
  store: Store;
  product: Listing;
  /** Other products read with this one: the one its order bump offers, when it has one. */
  related: Listing[];
  remaining: number | null;
  writes: boolean;
  selling: boolean;
  manageable: boolean;
  /** Coming soon: a waitlist instead of a way to pay (lib/waitlist.ts). */
  soon?: boolean;
  /** Coming soon and taking pre-orders: the day it is expected (lib/preorders.ts). */
  preorder?: string | null;
  /** It can go in the store's cart (lib/cart-rules.ts). */
  cart?: boolean;
  /** Near the top of the page: the picture is fetched right away. */
  eager?: boolean;
  /**
   * The first product on the page: its picture is usually the biggest thing
   * a phone draws first, so the browser is told to fetch it ahead of
   * everything else it has found. One picture a page, or the hint means nothing.
   */
  first?: boolean;
  /** Its buyers' reviews, shown only when lib/reviews.ts says a page may. */
  rating?: Summary | null;
  /** For a bundle: what it hands over now (lib/bundles.ts, offeredItems). */
  bundleItems?: Listing[] | null;
  /** "Bought N times", from the creator's own Stripe account, when they chose to show it (lib/sold-count.ts). */
  sold?: string | null;
  /** It stands in the store page's grid, two to a row on a computer (Encanto 3): its cover is described at that width. */
  grid?: boolean;
  /** Its license keys left could not be read just now (CX-123 rule 24): no way to buy it, and no count, is drawn. */
  unread?: boolean;
}) {
  const href = productPath(store, product);
  const { w, num } = speech(store);
  const image = product.image;
  const style = image ? product.display : "button";
  const plan = activePlan(product);
  const soldOut = remaining === 0;

  const picture = image ? (
    // A plain img: the picture was already sized in the creator's browser and
    // its address never changes, so there is nothing for an optimiser to add.
    // A phone is handed the smaller copy made beside it, when there is one,
    // and picks between the two itself (lib/product-image.ts, imageSrcSet).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={servedImageUrl(image)}
      srcSet={servedSrcSet(image)}
      sizes={image.small ? (style === "preview" ? (grid ? IMAGE_SIZES.grid : IMAGE_SIZES.cover) : IMAGE_SIZES.thumb) : undefined}
      alt={image.alt}
      width={image.width}
      height={image.height}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={first ? "high" : undefined}
      decoding="async"
      className={style === "preview" ? "st-cover" : style === "callout" ? "st-callout-img" : "st-thumb"}
      // The picture's color under it while it loads (Encanto 5b), when it has one.
      style={style === "preview" || image.tone ? { ...(style === "preview" ? { aspectRatio: `${image.width} / ${image.height}` } : {}), ...(image.tone ? { backgroundColor: image.tone } : {}) } : undefined}
    />
  ) : null;

  // "Read more" says, to a screen reader, which product it is for (WCAG 2.4.9), its visible words first (2.5.3); a
  // 44 px target like the title (2.5.5). The title's own words, not new ones, so every buyer language reads it.
  const readMore = (
    <Link prefetch={false} href={href} className="inline-flex min-h-11 items-center underline underline-offset-4" style={{ color: "var(--st-text)" }}>
      {w.readMore}
      <span className="sr-only">{`: ${product.title}`}</span>
    </Link>
  );

  const heading = (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <h2 className="font-display min-w-0 text-lg font-semibold leading-snug">
        <Link prefetch={false} href={href} className={TITLE_LINK}>
          {product.title}
        </Link>
      </h2>
      <p className="st-price text-base"><PriceTag store={store} product={product} /></p>
    </div>
  );

  const summary = product.summary ? <p className="st-muted mt-2 leading-relaxed">{product.summary}</p> : null;
  const stars = rating ? <RatingLine summary={rating} href={`${href}#reviews`} className="mt-1" lang={store.language} /> : null;
  const body = (
    <>
      {stars}
      {sold ? <p className="st-sold mt-1 text-sm font-semibold">{sold}</p> : null}
      <ProductFacts store={store} product={product} bundleItems={bundleItems} />
      {summary}
      {product.about || product.page ? <p className="mt-2 text-sm font-semibold">{readMore}</p> : null}
    </>
  );

  const rest = (
    <>
      {plan && canSellProduct(store, product) && !soon && !unread ? (
        <p className="st-muted mt-1 text-sm font-semibold">{w.orPlan(planLine(store, plan))}</p>
      ) : null}
      {remaining !== null && !soon && !unread ? (
        <p className="mt-2 text-sm font-bold" style={{ color: "var(--st-accent-text)" }}>
          {soldOut ? w.soldOut : w.left(remaining, num(remaining))}
        </p>
      ) : null}
      <BuyBox
        store={store}
        product={product}
        related={related}
        remaining={remaining}
        writes={writes}
        selling={selling}
        ready={!product.bundle || (bundleItems?.length ?? 0) >= MIN_BUNDLE_ITEMS}
        soon={soon}
        preorder={preorder}
        stepped
        unread={unread}
      />
      {cart && !unread ? <AddToCart handle={store.handle} productId={product.id} lang={store.language} deal={store.cartDeal.on ? store.cartDeal : null} /> : null}
      {product.recurring && manageable ? (
        <p className="mt-3 text-center text-sm">
          <Link href={`/@${store.handle}/manage`} className="st-footer-link font-semibold">
            {store.tiers.includes(product.id) ? w.memberSwitch : w.memberManage}
          </Link>
        </p>
      ) : null}
    </>
  );

  if (style === "preview" && picture) {
    return (
      <li id={`p-${product.id}`} data-item={`p:${product.id}`} className="st-card scroll-mt-6 overflow-hidden">
        <Link prefetch={false} href={href} className="st-cover-link" tabIndex={-1} aria-label={image?.alt ? undefined : product.title}>
          {picture}
        </Link>
        <div className="p-5 sm:p-6">
          {heading}
          {body}
          {rest}
        </div>
      </li>
    );
  }

  if (style === "callout" && picture) {
    return (
      <li id={`p-${product.id}`} data-item={`p:${product.id}`} className="st-card scroll-mt-6 p-5 sm:p-6">
        <div className="flex gap-4 sm:gap-5">
          <Link prefetch={false} href={href} className="st-callout-link shrink-0" tabIndex={-1} aria-label={image?.alt ? undefined : product.title}>
            {picture}
          </Link>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-semibold leading-snug">
              <Link prefetch={false} href={href} className={TITLE_LINK}>
                {product.title}
              </Link>
            </h2>
            <p className="st-price mt-2 text-sm"><PriceTag store={store} product={product} /></p>
            {stars ? <div>{stars}</div> : null}
            <ProductFacts store={store} product={product} bundleItems={bundleItems} />
            {/* Beside the picture on a wide screen, where there is room for it. */}
            <div className="hidden sm:block">{summary}</div>
          </div>
        </div>
        <div className="sm:hidden">{summary}</div>
        {product.about || product.page ? <p className="mt-2 text-sm font-semibold">{readMore}</p> : null}
        {rest}
      </li>
    );
  }

  return (
    <li id={`p-${product.id}`} data-item={`p:${product.id}`} className="st-card scroll-mt-6 p-5 sm:p-6">
      {picture ? (
        <div className="flex items-start gap-3">
          <Link prefetch={false} href={href} className="shrink-0" tabIndex={-1} aria-label={image?.alt ? undefined : product.title}>
            {picture}
          </Link>
          <div className="min-w-0 flex-1">{heading}</div>
        </div>
      ) : (
        heading
      )}
      {body}
      {rest}
    </li>
  );
}
