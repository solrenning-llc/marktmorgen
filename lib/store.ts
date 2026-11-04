/**
 * A creator's store: the handle, and the few facts the public page shows.
 *
 * Two records in Redis, both plain and both small:
 *
 *   nl:store:handle:<handle>  -> the store's key (below), written with NX so a
 *                                handle can never be taken twice
 *   nl:store:owner:<hash>     -> the store itself, as JSON
 *
 * The handle record is the lock. It is written first and only if free, so two
 * people asking for the same name at the same moment cannot both win.
 *
 * One account may run up to five stores. Every store is found by its key:
 *
 *   - an account's first store by its owner's sign-in email, exactly as every
 *     store was before there could be more than one, so a store made then
 *     is read, written and moved the way it always was;
 *   - every other store by "#" and an id of its own, which no email can be,
 *     so the two kinds of key never meet. It does not change when the owner
 *     moves to another address, because nothing in it is the address.
 *
 * Three small records tie them together:
 *
 *   nl:account:stores:<hash>  -> the ids of an account's other stores (a set)
 *   nl:store:id:<id>          -> the key of the store with that id, so a store
 *                                can be named in a cookie or a link by an id
 *                                that says nothing about who owns it
 *
 * Each store keeps its own handle, its own Stripe account, its own plan and
 * its own folders of files; nothing is shared between two stores but the
 * person who owns them. Every function below that takes a store's key calls
 * it `email` for the first kind and works the same for the second.
 */
import { type PlanDispute, parsePlanDispute, parsePlanDisputes, withPlanDispute } from "@/lib/plan-dispute-rules";
import { MAX_NAME_LENGTH, MAX_BIO_LENGTH, MAX_ADDRESSES, isFree, type StoreJoin, MAX_JOIN_HEADING, MAX_JOIN_LINE, parseJoin } from "@/lib/store-field-rules";
export { MAX_NAME_LENGTH, MAX_BIO_LENGTH, MAX_ADDRESSES, isFree, type StoreJoin, MAX_JOIN_HEADING, MAX_JOIN_LINE, parseJoin } from "@/lib/store-field-rules";
import { MAX_LINKS, type NumbersLink, parseLinks } from "@/lib/numbers-links";
import { type ShipProblem, type Shipping, shipProblem, readShippingSku } from "@/lib/shipping";
import { type CartDeal, NO_DEAL, parseCartDeal } from "@/lib/cart-rules";
import { type Video, parseVideo } from "@/lib/sales-page";
import { type FaqItem, parseFaq } from "@/lib/store-faq";
import { type FaqAddRefusal, faqAddition } from "@/lib/faq-from-inbox";
import { type StoreQuote, parseQuotes } from "@/lib/store-quotes-rules";
import { type Social, parseSocials } from "@/lib/store-socials";
import type { CallPackage } from "@/lib/call-package-rules";
import type { PodcastRef } from "@/lib/podcast-rules";
import { cache } from "react";
import { pointDomain } from "@/lib/domains";
import { rememberListing } from "@/lib/directory-index";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Held, LockBusyError, holdLock, releaseLock, releaseLockStrict, setIfHeld, takeLock } from "@/lib/redis-lock";
import {CONTRACT_ADMISSION_COVERAGE,canonicalFinancialSnapshot} from "@/lib/contract-funding-rules";
import { type ProductFile } from "@/lib/product-file";
import {
  MAX_OPTIONS,
  MAX_OPTION_LABEL_LENGTH,
  MAX_STORE_OPTIONS,
  parseDetails,
  type ProductOption,
} from "@/lib/product-option";
import { type Recurring } from "@/lib/product-recurring";
import { type StoreLook, DEFAULT_LOOK, parseLook } from "@/lib/store-look";
import { PHOTO_ID_PATTERN } from "@/lib/photo-limits";
import { type CallSetup } from "@/lib/call-setup";
import { type Pixels, NO_PIXELS, parsePixels } from "@/lib/pixels";
import { type TaxSetting, NO_TAX, parseTax } from "@/lib/tax";
import { type RecoverySetting, NO_RECOVERY, parseRecovery } from "@/lib/recovery-setting";
import { type SaveOffer, NO_SAVE, parseSaveOffer } from "@/lib/save-offer";
import { parsePauseMonths } from "@/lib/membership-pause-rules";
import { type Dunning, DEFAULT_DUNNING, parseDunning } from "@/lib/dunning-rules";
import { type LeaveSetting, NO_LEAVE, parseLeave } from "@/lib/leave-rules";
import { NO_NUDGE, type Nudge, parseNudge } from "@/lib/member-health-rules";
import { NO_YEARLY_ASK, type YearlyAsk, parseYearlyAsk } from "@/lib/yearly-switch-rules";
import { type WinBack, NO_WINBACK, parseWinBack } from "@/lib/winback";
import { type WelcomeOffer, NO_WELCOME_OFFER, parseWelcomeOffer } from "@/lib/welcome-offer";
import { type InboxSetting, NO_INBOX, parseInboxSetting } from "@/lib/inbox-rules";
import { type PastSale, type StoreSale, NO_SALE, parsePastSales, parseSale, withPastSale } from "@/lib/store-sale";
import { parseTiers } from "@/lib/tier-rules";
import { type BillingPeriod, isPeriod } from "@/lib/allowance-window";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { SHARING_INDEX } from "@/lib/platform-share";
import { PAYING_INDEX } from "@/lib/free-pool-rules";
import { type Cycle, type Tier, parseCycle, parseTier } from "@/lib/plan";
import { COMMUNITY_ID } from "@/lib/community-text";
import { type Bump, MAX_BUMPS, type Plan, bumpTargets, canBeBumped, isOneOff, uncoveredOption } from "@/lib/product-extras";
import { type Funnel, type FunnelProblem, funnelProblem } from "@/lib/funnel";
import { type AffiliateSetting, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { type ReviewAsk, parseReviewAsk } from "@/lib/review-ask";
import { type PwywProblem, pwywProblem } from "@/lib/pay-what-you-want";
import { type CheckoutField } from "@/lib/checkout-fields";
import { type Currency, DEFAULT_CURRENCY, currencyRule, parseCurrency, priceBounds, priceInRange, readMoney } from "@/lib/money";
import { type Intro, type IntroProblem, introProblem } from "@/lib/intro-price";
import { type Yearly, type YearlyProblem, yearlyProblem } from "@/lib/yearly-price";
import { type KeySetup, canHaveKeys } from "@/lib/key-setup";
import { type BundleProblem, bundleProblem, isBundle, pickProblem } from "@/lib/bundle-rules";
import { offerableAfterPaying } from "@/lib/bundles";
import { type DisplayStyle, type ProductImage } from "@/lib/product-image";
import { type PagePart, USUAL_ORDER, parseOrder } from "@/lib/store-order";
import { NO_TIPS, type StoreTips, parseTips } from "@/lib/store-tips";
import { type StoreKit, nextKit, parseKit } from "@/lib/store-kit";

/** One piece of content taken down after a notice (lib/takedown.ts). */
export type Strike = { at: string; what: string; report: string };

/** The kept record of what was taken down, made safe; newest first, at most 50. */
export function parseStrikes(raw: unknown): Strike[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
    .map((s) => ({ at: typeof s.at === "string" ? s.at.slice(0, 30) : "", what: typeof s.what === "string" ? s.what.slice(0, 200) : "", report: typeof s.report === "string" ? s.report.slice(0, 40) : "" }))
    .filter((s) => s.at && s.what)
    .slice(0, 50);
}
import {
  MAX_LINK_TITLE_LENGTH,
  MAX_STORE_LINKS,
  type LinkImage,
  type StoreLink,
  parseStoreLinks,
} from "@/lib/store-link";
import {
  type Catalog,
  type CourseRef,
  type Item,
  type Listing,
  type Product,
  KIND,
  MAX_PRODUCTS,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  StoreFullError,
  buildHead,
  catalogRecord,
  emptyCatalog,
  headFrom,
  itemOf,
  listingOf,
  parseCatalog,
  productDrops,
  productCount,
  productIdFor,
  productIds,
  productWrites,
  productBytes,
  movedMark,
  movedCount,
  idsOfKind,
  readDelivery,
  readListing,
  readListings,
  readProduct,
  readProducts,
  runWrites,
  usedIds,
  hasProduct,
} from "@/lib/catalog";
import { type Announcement, type StoreSection, parseAnnouncement, parseSections, sectionsWithout } from "@/lib/store-sections";
import { type VisitUs, parseVisitUs, readVisitUs } from "@/lib/visit-us";
import { noteData, takeData } from "@/lib/store-data";
import { DEPTH_RECORD_BYTES } from "@/lib/page-depth-rules";
import { PRODUCT_SIDE_BYTES } from "@/lib/store-data-rules";

/** What a product keeps beside its own records: its page's reading and the rest (lib/store-data-rules.ts). */
const BESIDE_PRODUCT = DEPTH_RECORD_BYTES + PRODUCT_SIDE_BYTES;
import { type Collection, type CollectionsProblem, MAX_PAIRS, collectionsWithout, parseCollections, readCollectionsInput, readProductIds } from "@/lib/store-collections";
import { type SitePage, parseSitePages, MAX_SITE_PAGES, slugProblem } from "@/lib/site-page-rules";
import { type AnswersSetting, NO_ANSWERS, parseAnswers } from "@/lib/answers-rules";
import { type AssistantPlan, type AssistantSetting, NO_ASSISTANT, parseAssistant, parseAssistantPlan } from "@/lib/store-assistant-rules";
import { type NextOfferSetting, NO_NEXT_OFFER, parseNextOffer } from "@/lib/next-offer-rules";
import { type AssistReminderSetting, NO_ASSIST_REMINDER, parseAssistReminder } from "@/lib/assistant-reminder-rules";
import { DEFAULT_FAIR, type FairPricing, parseFair } from "@/lib/fair-price";
import { DEFAULT_LANGUAGE, type LanguageCode, parseLanguage } from "@/lib/store-language";
import { type AdsServerPlatform, parseAdsServer } from "@/lib/ad-consent";
import { ATTRIBUTION_DAYS, type AttributionDays, DEFAULT_ATTRIBUTION_DAYS, parseAttributionDays } from "@/lib/attribution-rules";
import { parseEmbedSites, readEmbedSites } from "@/lib/embed-sites";

// What the rest of the site has always imported from here.
export { MAX_PRODUCTS, MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH, StoreFullError };
export type { CourseRef, Listing, Product };

/**
 * What an address may look like: 3 to 24 characters, starting and ending with
 * a letter or a number, with dots, hyphens and underscores allowed in between.
 *
 * Those three are there on purpose. A creator whose name everywhere else is
 * maria.souza or maria_souza should be able to keep it here instead of
 * inventing a different one for this store alone.
 */
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";
export { HANDLE_PATTERN } from "@/lib/store-handle-pattern";



/** Names the site itself uses, or may use, so a store can never shadow one. */
const RESERVED = new Set([
  "about",
  "account",
  "admin",
  "api",
  "app",
  "blog",
  "contact",
  "creators",
  "demo",
  "docs",
  "for",
  "help",
  "home",
  "invite",
  "legal",
  "login",
  "marktmorgen",
  "mission",
  "new",
  "nimbus",
  "nimbuslabs",
  "platform",
  "pricing",
  "privacy",
  "proof",
  "refunds",
  "root",
  "settings",
  "signin",
  "signup",
  "solrenning",
  "store",
  "studio",
  "support",
  "terms",
  "www",
]);

/**
 * How many addresses one store may ever hold, counting the one it uses now.
 *
 * There is no waiting between changes: a creator who mistypes a name fixes it
 * a second later. The only limit is this one, and it exists because an old
 * address stays held by the store so its published links keep working —
 * without a ceiling, a single account could sit on every good name and leave
 * nothing for anyone else. It is a ceiling on what one store holds at once:
 * letting an address go frees the slot and hands the name back.
 */


/**
 * How long a released address stays dark before anyone may take it.
 *
 * Letting go of an address frees the slot at once, but the name does not go
 * straight back on the shelf. For a month it answers nothing at all, so a link
 * still printed somewhere leads to a dead end rather than to the store of a
 * stranger. The creator waits for nothing; only the next taker does.
 */
export const RELEASE_QUARANTINE_DAYS = 30;

/** Marks a name that was let go and is not owned by anyone yet. */
const RELEASED_PREFIX = "released:";

/*
 * Prices are held as whole numbers of the store's currency's smallest unit
 * (priceCents is cents for a store in dollars, yen for one in yen), so no
 * amount is ever a rounded float. What may be typed, and how it is written,
 * is the currency's own rule, in lib/money.ts.
 */

/**
 * A price of exactly nothing is the one amount below the minimum that is
 * allowed, and it means something different: the product is not sold, it is
 * given away for an email address. Nothing about it ever reaches Stripe.
 */


/** What a list id looks like: 32 hex characters, and nothing else. */
export const LIST_ID_PATTERN = /^[0-9a-f]{32}$/;

/** A fresh, unguessable id for a store's list of addresses. */
export function newListId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * The most one store's record may weigh, in bytes.
 *
 * The products live in records of their own (lib/catalog.ts), so the store
 * record carries only their index, a page of cards and the store's own
 * settings, and every limit keeps it far under this. It stays as the
 * backstop it always was: a change that would take the record past it, and
 * make it bigger than it was, is refused with a sentence the creator can act
 * on; a change that makes it smaller is never refused.
 */
export const MAX_STORE_BYTES = 1_000_000;

/** What every email to a creator's list carries, as the law asks. */
export type MailSettings = {
  /** The name the email is from. */
  fromName: string;
  /** A postal address where the creator can be reached. */
  address: string;
};

export const MAX_MAIL_NAME = 60;
export const MAX_MAIL_ADDRESS = 200;

function parseMail(raw: unknown): MailSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const fromName = typeof value.fromName === "string" ? value.fromName.trim().slice(0, MAX_MAIL_NAME) : "";
  const address = typeof value.address === "string" ? value.address.trim().slice(0, MAX_MAIL_ADDRESS) : "";
  return fromName && address ? { fromName, address } : null;
}

/** The creator's own domain, on Pro. */
export type StoreDomain = {
  /** The bare host name, like shop.theirname.com. */
  name: string;
  addedAt: string;
  /** When we last saw it serving the store; empty until then. */
  liveAt: string;
};

function parseDomain(raw: unknown): StoreDomain | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== "string" || !/^[a-z0-9.-]{4,253}$/.test(value.name)) return null;
  return {
    name: value.name,
    addedAt: typeof value.addedAt === "string" ? value.addedAt : "",
    liveAt: typeof value.liveAt === "string" ? value.liveAt : "",
  };
}

/**
 * The part of a store's community its record carries: where the community
 * is kept (lib/community.ts) and whether it is open. Everything else about it
 * lives in its own records, so the store page learns whether to show the way
 * in without reading any of them.
 */
export type CommunityRef = { id: string; on: boolean };

function parseCommunityRef(raw: unknown): CommunityRef | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !COMMUNITY_ID.test(value.id)) return null;
  return { id: value.id, on: value.on === true };
}

export type Store = {
  handle: string;
  name: string;
  bio: string;
  /** The owner's sign-in address, whichever of their stores this is. */
  email: string;
  /**
   * The store's own id: 32 hex characters. What names it in a cookie, a link
   * or a team record. A store made before there were several has none until
   * its owner next opens the studio (ensureStoreId), and needs none till then.
   */
  sid: string;
  /**
   * Whether this is one of an account's other stores, kept under "#<sid>"
   * rather than under the owner's address (see the top of this file).
   */
  extra: boolean;
  createdAt: string;
  /** First explicit draft publication observed after activation tracking began; absent for older stores. */
  firstOfferPublishedAt?: string;
  /** True only for stores registered after activation tracking was installed. */
  activationTracked?: boolean;
  /** Addresses this store used before. They lead here until it lets them go. */
  previousHandles: string[];
  /**
   * Addresses this store let go of. They no longer lead here, but sales made
   * under them still carry them in Stripe, so every lookup of a store's sales
   * reads them too (saleHandles). Never pruned.
   */
  releasedHandles: string[];
  renamedAt: string;
  /**
   * The creator's own Stripe account, once they have connected it.
   *
   * We keep the identifier and nothing else. The account belongs to them, the
   * money lands in it, and disconnecting is theirs to do at any time.
   */
  stripeAccountId: string | null;
  /**
   * Whether Stripe last told us that account can take a payment, and when we
   * asked. Kept as a snapshot so the studio does not have to call Stripe on
   * every page load, and shown with its date so it is never read as a promise
   * about this exact moment.
   */
  stripeChargesEnabled: boolean;
  stripeCheckedAt: string;
  /**
   * What the creator pays us, on our own Stripe account — the other side of
   * the two above, which are about their account.
   *
   * The identifiers are kept so the studio can ask Stripe the current state,
   * and `subscriptionActive` is the snapshot of that answer, so a buyer
   * opening a store page never waits on a call to Stripe.
   */
  stripeCustomerId: string | null;
  subscriptionId: string | null;
  subscriptionActive: boolean;
  subscriptionCheckedAt: string;
  /**
   * Which plan, and how often it is billed, as Stripe last said. A snapshot
   * like the one above, so a Pro feature can be switched on or off without a
   * call to Stripe.
   */
  tier: Tier;
  cycle: Cycle;
  /** When the free trial ends, in seconds; 0 when not in one. A snapshot too. */
  trialEnds: number;
  /**
   * The billing period Stripe last said this store paid for, in seconds, and
   * whether it renews (added 17 October 2026). Every monthly allowance is
   * counted in the store's own billing month (lib/allowance-window.ts); a
   * store that pays and has none written down has no window, so nothing that
   * costs money starts until the studio or the daily job reads it. Absent
   * from records written before.
   */
  period?: BillingPeriod | null;
  /**
   * Whether the plan is at the prices that go with a share of each sale
   * (lib/plan.ts isSharedPrice), as Stripe last said. False for a store that
   * subscribed before them, which keeps its price and pays no share
   * (lib/platform-share.ts).
   */
  shared: boolean;
  /**
   * When this store's plan was first seen to be over, as a date; empty while
   * a plan runs, and for a store that never started one. What a store may
   * keep and play goes by this (lib/plan-standing.ts).
   */
  planEndedAt: string;
  /**
   * When the renewal of the plan now running was first seen unpaid (Stripe's
   * `past_due`), in seconds; 0 while it is paid up (232 [CA1] unit 4). The
   * plan has not ended: what costs us to run stops (lib/plan-standing.ts,
   * costStandingOf; lib/billing.ts, isPaidUp) and starts again the moment
   * Stripe says it is paid. Absent from records written before.
   */
  renewalUnpaidSince?: number;
  /**
   * Disputes of payments the creator made to us for the plan, as the daily
   * job read them from Stripe (lib/plan-disputes.ts, 232 [CA1] unit 5). An
   * open one, or one decided for the creator until the period it paid for
   * ends, pauses what costs us to run (lib/plan-standing.ts, costsPaused).
   * Absent from records written before.
   */
  planDisputes?: PlanDispute[];
  /** How the creator's emails to their list are signed. Null until set up. */
  mail: MailSettings | null;
  /** The creator's own domain for the store, when they added one. */
  domain: StoreDomain | null;
  /**
   * What the store lists, in the order the creator put them in: an index and
   * the first page, with each product in records of its own
   * (lib/catalog.ts). Read them with readListings and readProducts there.
   */
  catalog: Catalog;
  /**
   * Links that are not for sale: the rest of the creator's life, in the order
   * they chose. Shown under what is for sale, because somebody who came to
   * buy should reach the thing they came for first.
   */
  links: StoreLink[];
  /**
   * Whether this store had a live discount code the last time we looked.
   *
   * The codes themselves live on the creator's Stripe account and are read
   * from there; this is only the answer to "should the checkout show a box to
   * type one into". It is a snapshot so that a buyer clicking buy never waits
   * on a call to Stripe, and being wrong costs nothing worse than an empty
   * box or a hidden one — never a wrong price, because the discount itself
   * is Stripe's arithmetic and not ours.
   */
  hasDiscounts: boolean;
  /**
   * Where the addresses collected by free products are kept.
   *
   * An id of its own rather than anything derived from the sign-in address,
   * because that address can move and the list has to move with the store
   * without being copied. Null until the store first gives something away.
   */
  listId: string | null;
  /**
   * The theme and the colour of the public page. Stores written before either
   * existed read back as the default look, which is the page they had.
   */
  look: StoreLook;
  /**
   * The creator's photo, when there is one. The picture itself is kept under
   * this id and served from an address that never changes for it, so a
   * browser may keep it for good; a new photo gets a new id.
   */
  photoId: string | null;
  /**
   * Where this store's booked and held call times are kept. An id of its own,
   * made the first time a call is set up, so neither a new address nor a new
   * sign-in email moves anybody's booking.
   */
  callsId: string | null;
  /**
   * Where the counts of this store's visits are kept: an id of its own, so a
   * new address or a new sign-in email carries the history along.
   */
  statsId: string | null;
  /** The creator's own ad pixels, each null until they add it. */
  pixels: Pixels;
  /** Whether Stripe Tax adds sales tax at checkout, and whether prices include it. */
  tax: TaxSetting;
  /**
   * Whether a buyer who agreed at checkout to hear from the creator, and then
   * left without paying, gets one reminder (lib/checkout-recovery.ts). Off
   * for every store until its creator switches it on.
   */
  recovery: RecoverySetting;
  /**
   * The offer made once to a member on their way out of a membership
   * (lib/save-offer.ts). Off for every store until its creator sets one.
   */
  save: SaveOffer;
  /**
   * How many months a member may pause their membership for, instead of
   * cancelling it, from the page they manage it on (lib/membership-pause.ts):
   * 1, 2 or 3; 0 is off, which every store starts as.
   */
  pause: number;
  /**
   * What members are told when a payment fails, and before their card stops
   * working (lib/dunning-rules.ts): one email per failed payment and the card
   * notice, for every store until its creator chooses otherwise.
   */
  dunning: Dunning;
  /**
   * Whether the store's own page asks a member why before they cancel, and
   * answers with a pause, a cheaper plan or a way to write (lib/leave-rules.ts).
   * Off for every store until its creator turns it on.
   */
  leaving: LeaveSetting;
  /**
   * The come-back email to members who stopped coming (lib/member-health-rules.ts).
   * Off for every store until its creator turns it on, with a postal address.
   */
  nudge: Nudge;
  /**
   * The one email that offers monthly members the same membership's yearly
   * price (lib/yearly-ask.ts). Off until its creator turns it on, with a postal address.
   */
  yearlyAsk: YearlyAsk;
  /** Whether the weekly email opens with a few sentences written by AI from the week's numbers (lib/numbers-ask.ts). Off until turned on. */
  weeklyAi: boolean;
  /**
   * The ad platforms this store sends conversions to from the server, each
   * with an access token kept sealed apart (lib/ad-events.ts). Only which
   * ones, never a token, so a checkout knows without asking Redis.
   */
  adsServer: AdsServerPlatform[];
  /**
   * How many days after a visit a sale is still credited to where that visit
   * came from (lib/attribution-rules.ts): 7, 30, 60 or 90; 30 until changed.
   */
  attributionDays: AttributionDays;
  /** Whether each sale, and each alert (lib/store-alerts.ts), is posted to the store's Slack or Discord channel (lib/chat-summary.ts). Off until turned on. */
  chatSales: boolean;
  /**
   * The creator's own websites that may open the store's checkout card and
   * sign-up form over their pages with the checkout script, and be told what
   * happened (lib/embed-sites.ts): https origins, at most ten. None until added.
   */
  embedSites: string[];
  /**
   * The come-back offer emailed to somebody whose membership ended
   * (lib/winback.ts). Off for every store until its creator sets one.
   */
  winback: WinBack;
  /**
   * The welcome offer, with a deadline of each person's own, to whoever asks
   * for a free product (lib/welcome-offer.ts). Off until the creator sets one.
   */
  welcomeOffer: WelcomeOffer;
  /** The chat on the store's pages and the inbox's saved replies (lib/inbox-rules.ts). The chat is off until turned on. */
  inbox: InboxSetting;
  /** A sale across the store, with its start and end (lib/store-sale.ts). None until the creator sets one. */
  sale: StoreSale;
  /** Sales that ran before the one set now, for the marks on the numbers (lib/auto-marks.ts). */
  pastSales: PastSale[];
  /** Memberships a member can switch between, 2 to 6 product ids, or none (lib/tier-rules.ts). */
  tiers: string[];
  /** The store's community, once the creator has made one (lib/community.ts). */
  community: CommunityRef | null;
  /**
   * The store's affiliate programme: whether it is on, what it pays and for
   * how long a click counts (lib/affiliates.ts). Off until the creator
   * switches it on. The money itself never passes through here.
   */
  affiliates: AffiliateSetting;
  /**
   * What every price in the store is written and charged in (lib/money.ts).
   * Stores written before there was a choice read back as US dollars, which
   * is what they always charged in.
   */
  currency: Currency;
  /**
   * Whether buyers are emailed once, some days after buying, to ask for a
   * review (lib/review-requests.ts). Off until the creator switches it on.
   */
  reviewAsk: ReviewAsk;
  /**
   * Whether a buyer has ever reviewed anything here (lib/reviews.ts). Set once,
   * by the first review, so the store page reads the ratings only for a store
   * that has some, and a store without any keeps the store page's round trips
   * of lib/catalog.ts exactly as they were.
   */
  reviewed: boolean;
  /**
   * How many posts the store's blog has published (lib/store-blog.ts), so the
   * store page links to the blog without asking. 0 on every store written
   * before blogs existed.
   */
  posts: number;
  /** The creator's profiles elsewhere, under their name (lib/store-socials.ts). None on stores written before. */
  socials: Social[];
  /**
   * The sign-up box on the store page (lib/store-join.ts): whether it shows,
   * and the creator's own heading and line for it ("" means the store
   * language's words, lib/buyer-words/join.ts). Off on stores written before.
   */
  join: StoreJoin;
  /** The newest reviews with words, for "What buyers say" on the store page (lib/store-quotes.ts). */
  quotes: StoreQuote[];
  /** The contact form on the store page (lib/store-contact.ts), with the same shape as the sign-up box's settings. */
  contact: StoreJoin;
  /** "Support my work" on the store page (lib/store-tips.ts). Off on every store written before it existed. */
  tips: StoreTips;
  /** The media kit at /@handle/media-kit (lib/store-kit.ts). Off on every store written before it existed. */
  kit: StoreKit;
  /** Read-only links to the store's counted numbers, each with a password and an end (lib/numbers-links.ts). */
  numbersLinks: NumbersLink[];
  /**
   * Taken down after notices (lib/takedown.ts): the day the store's pages and
   * sales were switched off ("" while they are on), and every piece of
   * content taken down, newest first — the record a repeat infringer is
   * judged by.
   */
  suspended: string;
  strikes: Strike[];
  /** The store's own questions and answers, on its page (lib/store-faq.ts). */
  faq: FaqItem[];
  /**
   * A welcome video under the store's name (added 9 October 2026): YouTube,
   * Vimeo or Loom, played on the page only when a visitor presses play
   * (components/video-embed.tsx). None on stores written before.
   */
  intro: Video | null;
  /**
   * The order of the parts of the page under the creator's name
   * (lib/store-order.ts), always whole. The usual order on every store
   * written before it could be changed.
   */
  order: PagePart[];
  /**
   * The free product offered once to a visitor about to leave (lib/exit-offer.ts),
   * or null for none. Off on every store written before it existed.
   */
  exitOffer: string | null;
  /**
   * Headings among the products on the store page, each starting at one
   * product (lib/store-sections.ts). Empty on every store written before
   * they existed, which is one unbroken list as it always was.
   */
  sections: StoreSection[];
  /**
   * Named groups of the store's products, each with a page of its own
   * (lib/store-collections.ts). Absent or empty on every store written before
   * they existed.
   */
  collections?: Collection[];
  /**
   * The store's own pages — About, Start here, Work with me — beside its
   * products (lib/site-page-rules.ts). Empty on every store written before
   * they existed.
   */
  sitePages: SitePage[];
  /** One line of the creator's own news across the top of the store page, or null. */
  announcement: Announcement | null;
  /**
   * "Visit us" under the products, for a business with an address (521
   * [LB2], lib/visit-us.ts): its address, opening hours and phone, as the
   * creator typed them; null on every store until its creator writes one.
   */
  visitUs: VisitUs | null;
  /**
   * Whether visitors' questions about a product are answered from its page
   * (lib/answers-rules.ts), and the creator's notes for those answers. Off on
   * every store until its creator switches it on.
   */
  answers: AnswersSetting;
  /**
   * The Store assistant (lib/store-assistant-rules.ts): whether its chat is
   * on, and the creator's notes for it. Off on every store until its creator
   * switches it on, and it answers only while the add-on is paid for.
   */
  assistant: AssistantSetting;
  /** What Stripe last said about the add-on's own subscription, or null when the store never had one. */
  assistantPlan: AssistantPlan | null;
  /**
   * The Store assistant's next product after a purchase (lib/next-offer-rules.ts):
   * whether it is suggested on the page after paying, and in the order's
   * confirmation email too. Off on every store until its creator switches it on.
   */
  nextOffer: NextOfferSetting;
  /**
   * The Store assistant's checkout reminder (lib/assistant-reminder-rules.ts):
   * whether its box is offered at checkout. Off on every store until its
   * creator switches it on.
   */
  assistReminder: AssistReminderSetting;
  /**
   * A lower price for buyers in countries where money buys less
   * (lib/fair-price.ts), and the deepest discount the creator accepts. Off
   * on every store until its creator switches it on.
   */
  fair: FairPricing;
  /** Every product in a cart cheaper once it holds a few (lib/cart-rules.ts). Off on every store until switched on. */
  cartDeal: CartDeal;
  /**
   * The language the store speaks to its buyers in (lib/store-language.ts):
   * every word on its pages the creator did not write, and Stripe's payment
   * page. English on every store until its creator picks another.
   */
  language: LanguageCode;
  /**
   * The country the visitor's connection is in, for the page drawn for them
   * now (lib/fair-price.ts, readCountry). Set by the store's pages from the
   * request, never stored: a record read from the database has none.
   */
  visitorCountry?: string;
  /**
   * Whether buyers who agree to hear from the creator are sent on to the
   * creator's own email platform (lib/email-sync.ts), and for which products.
   * Only this much is kept here, so a store page can offer the box without
   * reading anything else; the platform, its key and the rest of the settings
   * live in their own record. Null when no platform takes buyers.
   */
  emailSync: EmailSyncRef | null;
  /**
   * Whether some device of someone who runs this store wants a notification
   * for each sale (lib/phone-alerts.ts), so the five-minute job looks for
   * sales on this store even when nothing else would have it look.
   */
  phoneSales: boolean;
  /**
   * Whether a sales page asks a visitor about to go without buying what is
   * stopping them (components/page-depth.tsx, added 11 October 2026). Off
   * until the creator turns it on, because it is something their visitors see.
   */
  askWhyNot: boolean;
  /**
   * Whether the store's front page and product pages show its latest real
   * purchases, one at a time, without names (lib/recent-sales.ts, added
   * 13 October 2026). Off until the creator turns it on.
   */
  recentSales: boolean;
  /**
   * Whether the creator brought past buyers over from another platform
   * (lib/imported-purchases.ts). Set once, by the first such import, so the
   * list of purchases knows to look for them without reading anything.
   */
  pastBuyers: boolean;
  /**
   * The creator's own PayPal Business account, connected through PayPal's
   * onboarding for platforms (lib/paypal-sales.ts), so buyers can pay it
   * directly. Null when PayPal is not connected.
   */
  paypalSeller: PayPalSeller | null;
};

/** A PayPal account a store sells through: PayPal's id for it, and when it was connected. */
export type PayPalSeller = { merchant: string; at: number };

function parsePayPalSeller(raw: unknown): PayPalSeller | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.merchant !== "string" || !/^[A-Z0-9]{8,20}$/.test(value.merchant)) return null;
  return { merchant: value.merchant, at: typeof value.at === "number" ? value.at : 0 };
}

/** The part of the email platform settings a store record carries. */
export type EmailSyncRef = { buyers: "all" | "some"; products: string[] };

function parseEmailSyncRef(raw: unknown): EmailSyncRef | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.buyers !== "all" && value.buyers !== "some") return null;
  const products = Array.isArray(value.products)
    ? value.products.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(id)).slice(0, MAX_PRODUCTS)
    : [];
  return { buyers: value.buyers, products };
}

/**
 * Whether a buyer of this product who ticks the box to hear from the creator
 * is sent on to the creator's email platform. The checkout offers the box
 * when this is true, as it does when the creator writes to their list here.
 */
export function syncTakesBuyer(store: Pick<Store, "emailSync">, productId: string): boolean {
  const ref = store.emailSync;
  return ref !== null && (ref.buyers === "all" || ref.products.includes(productId));
}

/** The shape Stripe gives a connected account: acct_ and then base62. */
export const STRIPE_ACCOUNT_PATTERN = /^acct_[A-Za-z0-9]{8,64}$/;

/** The same, for the customer and subscription that pay us. */
export const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;
export const SUBSCRIPTION_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;

export function normaliseHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

export type HandleProblem = "shape" | "reserved" | null;

export function handleProblem(handle: string): HandleProblem {
  if (!HANDLE_PATTERN.test(handle)) return "shape";
  if (RESERVED.has(handle)) return "reserved";
  return null;
}

/**
 * Addresses that could pass for Marktmorgen's own (568 [GD2] (j)): never claimed, never taken in a rename. Only
 * taking an address is refused here; a store that already holds one keeps working (storeForHandle reads
 * handleProblem), so no creator's store goes dark.
 */
const IMPERSONATING = new Set([
  "official", "security", "secure", "billing", "payments", "checkout", "staff", "team", "moderator", "verify",
  "verified", "trust", "safety", "abuse", "press", "status", "noreply", "no-reply", "helpdesk",
]);

/** What stops an address from being claimed or taken: its shape, the site's own names, or passing for ours. */
export function newAddressProblem(handle: string): HandleProblem {
  const problem = handleProblem(handle);
  if (problem) return problem;
  if (IMPERSONATING.has(handle) || handle.includes("marktmorgen") || handle.includes("solrenning")) return "reserved";
  return null;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const ownerKey = async (email: string) =>
  `nl:store:owner:${(await sha256Hex(`nimbus-store:${email.toLowerCase()}`)).slice(0, 40)}`;

const handleKey = (handle: string) => `nl:store:handle:${handle}`;

/** The ids of an account's other stores. Deliberately not under nl:store:owner:. */
const accountKey = async (email: string) =>
  `nl:account:stores:${(await sha256Hex(`nimbus-account-stores:${email.toLowerCase()}`)).slice(0, 40)}`;

const storeIdKey = (sid: string) => `nl:store:id:${sid}`;

/** A store's own id: the same shape as the other ids a store carries. */
export const STORE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * How many stores one account may run, the first one included.
 *
 * Each is a subscription of its own, so the ceiling is not about money. It
 * is about what one person can look after: a sixth store is usually a store
 * nobody is answering buyers for.
 */
export const MAX_STORES_PER_ACCOUNT = 5;

/** What an account's other stores are kept under: "#" and the store's id. */
function extraRef(sid: string): string {
  return `#${sid}`;
}

/**
 * The key a store is kept under (see the top of this file): its owner's
 * address for an account's first store, "#<id>" for any other.
 */
export function storeRef(store: Pick<Store, "email" | "sid" | "extra">): string {
  return store.extra && STORE_ID_PATTERN.test(store.sid) ? extraRef(store.sid) : store.email;
}

/**
 * The folder in the file store that belongs to one store.
 *
 * Derived from the store's key — the owner's email for an account's first
 * store, "#<id>" for its others — so it cannot be guessed from a store
 * address, two stores of one owner never share a folder, and it is salted
 * differently from the Redis key so that seeing one never gives the other.
 */
export async function storeFolder(email: string): Promise<string> {
  return (await sha256Hex(`nimbus-files:${email.toLowerCase()}`)).slice(0, 32);
}

/**
 * The folder a store's product pictures live in.
 *
 * Salted differently again from the folder its paid files live in, because a
 * picture's address is public and must say nothing about where the files
 * that are paid for are kept.
 */
export async function imageFolder(email: string): Promise<string> {
  return (await sha256Hex(`nimbus-images:${email.toLowerCase()}`)).slice(0, 24);
}

function parseStore(raw: unknown): Store | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Store>;
    if (!value.handle || !value.name || !value.email) return null;
    // Stores from before there could be several have neither: each of them
    // is its owner's first store, kept under the owner's address.
    const sid = typeof value.sid === "string" && STORE_ID_PATTERN.test(value.sid) ? value.sid : "";
    return {
      handle: value.handle,
      name: value.name,
      bio: value.bio ?? "",
      email: value.email,
      sid,
      extra: value.extra === true && sid !== "",
      createdAt: value.createdAt ?? "",
      activationTracked: value.activationTracked === true,
      ...(typeof value.firstOfferPublishedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value.firstOfferPublishedAt) && Number.isFinite(Date.parse(value.firstOfferPublishedAt)) ? { firstOfferPublishedAt: value.firstOfferPublishedAt.slice(0, 30) } : {}),
      previousHandles: Array.isArray(value.previousHandles)
        ? value.previousHandles.filter((h) => typeof h === "string")
        : [],
      releasedHandles: Array.isArray(value.releasedHandles)
        ? value.releasedHandles.filter((h) => typeof h === "string")
        : [],
      renamedAt: value.renamedAt ?? "",
      stripeAccountId:
        typeof value.stripeAccountId === "string" &&
        STRIPE_ACCOUNT_PATTERN.test(value.stripeAccountId)
          ? value.stripeAccountId
          : null,
      stripeChargesEnabled: value.stripeChargesEnabled === true,
      stripeCheckedAt: value.stripeCheckedAt ?? "",
      stripeCustomerId:
        typeof value.stripeCustomerId === "string" &&
        CUSTOMER_PATTERN.test(value.stripeCustomerId)
          ? value.stripeCustomerId
          : null,
      subscriptionId:
        typeof value.subscriptionId === "string" &&
        SUBSCRIPTION_PATTERN.test(value.subscriptionId)
          ? value.subscriptionId
          : null,
      subscriptionActive: value.subscriptionActive === true,
      subscriptionCheckedAt: value.subscriptionCheckedAt ?? "",
      // Every store from before there were two plans is on the one there was.
      tier: parseTier(value.tier) ?? "creator",
      cycle: parseCycle(value.cycle) ?? "month",
      trialEnds: typeof value.trialEnds === "number" && value.trialEnds > 0 ? value.trialEnds : 0,
      // Records from before the period was kept have none: no billing month is known.
      period: isPeriod((value as { period?: unknown }).period) ? { ...((value as { period: BillingPeriod }).period) } : null,
      // Every store from before there was a share pays none.
      shared: value.shared === true,
      // Stores written before this was kept have none: read as never ended.
      planEndedAt: typeof value.planEndedAt === "string" && !Number.isNaN(Date.parse(value.planEndedAt)) ? value.planEndedAt : "",
      // Records from before this was kept have none: read as paid up.
      renewalUnpaidSince: Number.isSafeInteger((value as { renewalUnpaidSince?: unknown }).renewalUnpaidSince) && ((value as { renewalUnpaidSince: number }).renewalUnpaidSince) > 0 ? (value as { renewalUnpaidSince: number }).renewalUnpaidSince : 0,
      // Records from before this was kept have none.
      planDisputes: parsePlanDisputes((value as { planDisputes?: unknown }).planDisputes),
      mail: parseMail(value.mail),
      domain: parseDomain(value.domain),
      // A record from before products had records of their own still
      // carries them itself, and is read from them until it is moved.
      catalog: parseCatalog((value as { catalog?: unknown }).catalog, (value as { products?: unknown }).products),
      // Stores written before links existed simply have none, which is the
      // same as a store nobody has added one to yet.
      links: parseStoreLinks(value.links),
      hasDiscounts: value.hasDiscounts === true,
      listId:
        typeof value.listId === "string" && LIST_ID_PATTERN.test(value.listId)
          ? value.listId
          : null,
      look: parseLook(value.look),
      photoId:
        typeof value.photoId === "string" && PHOTO_ID_PATTERN.test(value.photoId)
          ? value.photoId
          : null,
      callsId:
        typeof value.callsId === "string" && LIST_ID_PATTERN.test(value.callsId)
          ? value.callsId
          : null,
      statsId:
        typeof value.statsId === "string" && LIST_ID_PATTERN.test(value.statsId)
          ? value.statsId
          : null,
      pixels: parsePixels(value.pixels),
      tax: parseTax(value.tax),
      // Stores written before reminders existed have them off, as every
      // store does until its creator says otherwise.
      recovery: parseRecovery(value.recovery),
      // Stores written before the offer existed have none, as every store
      // does until its creator sets one.
      save: parseSaveOffer(value.save),
      pause: parsePauseMonths(value.pause),
      dunning: parseDunning(value.dunning),
      leaving: parseLeave(value.leaving),
      nudge: parseNudge(value.nudge),
      yearlyAsk: parseYearlyAsk(value.yearlyAsk),
      weeklyAi: value.weeklyAi === true,
      adsServer: parseAdsServer(value.adsServer),
      attributionDays: parseAttributionDays(value.attributionDays),
      chatSales: value.chatSales === true,
      embedSites: parseEmbedSites(value.embedSites),
      winback: parseWinBack(value.winback),
      welcomeOffer: parseWelcomeOffer(value.welcomeOffer),
      inbox: parseInboxSetting(value.inbox),
      sale: parseSale(value.sale),
      pastSales: parsePastSales(value.pastSales),
      tiers: parseTiers(value.tiers),
      // Stores written before communities existed simply have none.
      community: parseCommunityRef(value.community),
      affiliates: parseAffiliateSetting(value.affiliates),
      currency: parseCurrency(value.currency),
      // Stores written before review requests existed do not send them.
      reviewAsk: parseReviewAsk(value.reviewAsk),
      // Stores written before reviews existed have none.
      reviewed: value.reviewed === true,
      socials: parseSocials(value.socials),
      join: parseJoin(value.join),
      quotes: parseQuotes(value.quotes),
      contact: parseJoin(value.contact),
      tips: parseTips(value.tips),
      kit: parseKit(value.kit),
      numbersLinks: parseLinks(value.numbersLinks),
      suspended: typeof value.suspended === "string" && /^\d{4}-\d{2}-\d{2}/.test(value.suspended) ? value.suspended : "",
      strikes: parseStrikes(value.strikes),
      faq: parseFaq(value.faq),
      intro: parseVideo(value.intro),
      order: parseOrder(value.order),
      posts: typeof value.posts === "number" && Number.isInteger(value.posts) && value.posts > 0 ? Math.min(value.posts, 10_000) : 0,
      exitOffer: typeof value.exitOffer === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value.exitOffer) ? value.exitOffer : null,
      sections: parseSections(value.sections),
      collections: parseCollections(value.collections),
      sitePages: parseSitePages(value.sitePages),
      announcement: parseAnnouncement(value.announcement),
      visitUs: parseVisitUs(value.visitUs),
      answers: parseAnswers(value.answers),
      assistant: parseAssistant(value.assistant),
      assistantPlan: parseAssistantPlan(value.assistantPlan),
      nextOffer: parseNextOffer(value.nextOffer),
      assistReminder: parseAssistReminder(value.assistReminder),
      fair: parseFair(value.fair),
      cartDeal: parseCartDeal(value.cartDeal),
      // Stores written before a store could pick its language speak English.
      language: parseLanguage(value.language),
      // Stores written before either existed send nothing anywhere.
      emailSync: parseEmailSyncRef(value.emailSync),
      phoneSales: value.phoneSales === true,
      askWhyNot: value.askWhyNot === true,
      recentSales: value.recentSales === true,
      // Stores written before imports existed brought nobody over.
      pastBuyers: value.pastBuyers === true,
      // Stores written before PayPal selling existed sell through Stripe only.
      paypalSeller: parsePayPalSeller(value.paypalSeller),
    };
  } catch {
    return null;
  }
}

/**
 * The store kept under one key (see the top of this file): an account's first
 * store when given the owner's address, any store when given "#<id>".
 */
export async function storeForEmail(
  email: string | null,
): Promise<Store | null> {
  if (!email || !isRedisConfigured()) return null;
  const reply = await redisPipeline([["GET", await ownerKey(email)]]);
  if (!Array.isArray(reply) || reply.length !== 1) return null;
  const store = parseStore(reply[0]);
  // A readable record must belong to this exact owner key. Preserve legacy
  // first-store records and case-insensitive email lookup; extra stores must
  // still be addressed by their own persistent id.
  if (!store || typeof store.email !== "string" ||
      storeRef(store).toLowerCase() !== email.toLowerCase()) return null;
  return store;
}

/** One bounded read for the funded restart's final source check.
 * It cannot migrate, save, infer absence from an oversized/partial answer,
 * or turn a current-source observation into permission for another POST. */
export async function storeForRestartSource(ref: string): Promise<Store | null> {
  if (!ref || !isRedisConfigured()) return null;
  const reply = await redisPipeline([["GETRANGE", await ownerKey(ref), 0, MAX_STORE_BYTES]]);
  if (!Array.isArray(reply) || reply.length !== 1) return null;
  const entry = Object.getOwnPropertyDescriptor(reply, "0");
  if (!entry || !Object.hasOwn(entry, "value") || typeof entry.value !== "string" ||
      new TextEncoder().encode(entry.value).byteLength > MAX_STORE_BYTES) return null;
  // Financial source observations must not inherit parseStore's legacy defaults.
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(entry.value); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const strings = ["handle", "statsId", "subscriptionId", "stripeCustomerId", "tier", "cycle", "email", "sid"] as const;
  if (strings.some(key => !Object.hasOwn(raw, key) || typeof raw[key] !== "string") ||
      !Object.hasOwn(raw, "subscriptionActive") || typeof raw.subscriptionActive !== "boolean" ||
      !Object.hasOwn(raw, "extra") || typeof raw.extra !== "boolean") return null;
  const store = parseStore(entry.value);
  if (!store || strings.some(key => store[key] !== raw[key]) ||
      store.subscriptionActive !== raw.subscriptionActive || store.extra !== raw.extra) return null;
  return storeRef(store).toLowerCase() === ref.toLowerCase() ? store : null;
}


export type RestartPublicationGoal={
 handle:string;statsId:string;sourceSubscriptionId:string;customerId:string;tier:Tier;
 subscriptionId:string;periodStartSeconds:number;periodEndSeconds:number;renews:boolean;shared:boolean;
};
export type RestartPublicationRecord={expected:string;next:string;store:Store};
/** Pure raw-preserving preparation; never financial authorization or a write. */
export function restartPublicationRecord(raw:unknown,ref:string,goal:RestartPublicationGoal,observedAtSeconds=Math.floor(Date.now()/1000)):RestartPublicationRecord|null{
 if(typeof raw!=="string"||!raw||byteLength(raw)>MAX_STORE_BYTES)return null;
 const snapshot=canonicalFinancialSnapshot({ref,goal,observedAtSeconds});if(!snapshot)return null;
 ({ref,goal,observedAtSeconds}=JSON.parse(snapshot));
 if(typeof raw!=="string"||!raw||byteLength(raw)>MAX_STORE_BYTES||typeof ref!=="string"||!ref||ref.length>320||
    !goal||Object.keys(goal).length!==10||["handle","statsId","sourceSubscriptionId","customerId","tier","subscriptionId"].some(key=>typeof (goal as unknown as Record<string,unknown>)[key]!=="string")||typeof goal.renews!=="boolean"||typeof goal.shared!=="boolean"||!Number.isSafeInteger(observedAtSeconds)||
    !Number.isSafeInteger(goal.periodStartSeconds)||!Number.isSafeInteger(goal.periodEndSeconds)||goal.periodStartSeconds<=0||
    goal.periodStartSeconds>observedAtSeconds||goal.periodEndSeconds<=observedAtSeconds||goal.periodEndSeconds-goal.periodStartSeconds>31*86400||
    !CUSTOMER_PATTERN.test(goal.customerId)||!SUBSCRIPTION_PATTERN.test(goal.sourceSubscriptionId)||
    !SUBSCRIPTION_PATTERN.test(goal.subscriptionId)||goal.subscriptionId===goal.sourceSubscriptionId||
    !["creator","pro","scale"].includes(goal.tier))return null;
 try{
  const value=JSON.parse(raw) as Record<string,unknown>;
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const strings=["handle","statsId","subscriptionId","stripeCustomerId","tier","cycle","email","sid"] as const;
  if(strings.some(key=>!Object.hasOwn(value,key)||typeof value[key]!=="string")||
     !Object.hasOwn(value,"subscriptionActive")||value.subscriptionActive!==false||
     !Object.hasOwn(value,"extra")||typeof value.extra!=="boolean")return null;
  const store=parseStore(raw);
  if(!store||strings.some(key=>store[key]!==value[key])||store.extra!==value.extra||storeRef(store)!==ref||
     store.handle!==goal.handle||store.statsId!==goal.statsId||store.subscriptionId!==goal.sourceSubscriptionId||
     store.stripeCustomerId!==goal.customerId||store.tier!==goal.tier||store.cycle!=="month"||!store.catalog.id)return null;
  const catalog=value.catalog as Record<string,unknown>|null;
  if(!catalog||typeof catalog!=="object"||Array.isArray(catalog)||catalog.id!==store.catalog.id)return null;
  const nextRaw={...value,stripeCustomerId:goal.customerId,subscriptionId:goal.subscriptionId,subscriptionActive:true,
   subscriptionCheckedAt:new Date(goal.periodStartSeconds*1000).toISOString(),tier:goal.tier,cycle:"month",trialEnds:0,
   shared:goal.shared,period:{start:goal.periodStartSeconds,end:goal.periodEndSeconds,renews:goal.renews,funded:true},planEndedAt:""};
  const json=JSON.stringify(nextRaw);if(byteLength(json)>MAX_STORE_BYTES)return null;
  const saved=parseStore(json);if(!saved)return null;
  guardRecord(store,saved);
  return {expected:raw,next:json,store:saved};
 }catch{return null;}
}
/** One lock attempt and one bounded raw read, without migration/product IO.
 * Only the coupled financial publisher may use the callback as write authority.
 */
export async function withRestartPublicationRecord<T>(
 ref:string,goal:RestartPublicationGoal,
 work:(record:RestartPublicationRecord&{owner:string;held:Held})=>Promise<T>,
):Promise<T|null>{
 if(!Boolean(CONTRACT_ADMISSION_COVERAGE.pauseRestart)||!isRedisConfigured())return null;
 const snapshot=canonicalFinancialSnapshot({ref,goal});if(!snapshot)return null;
 ({ref,goal}=JSON.parse(snapshot));
 if(typeof ref!=="string"||!ref||ref.length>320)return null;
 const owner=await ownerKey(ref),held:Held={key:lockKeyOf(owner),token:"restart_"+crypto.randomUUID(),ttlSeconds:LOCK_SECONDS};
 try{
  const locked=await redisPipeline([["SET",held.key,held.token,"NX","EX",LOCK_SECONDS]]);
  if(!Array.isArray(locked)||locked.length!==1)return null;
  const ack=Object.getOwnPropertyDescriptor(locked,"0");
  if(!ack||!Object.hasOwn(ack,"value")||ack.value!=="OK")return null;
  const reply=await redisPipeline([["GETRANGE",owner,0,MAX_STORE_BYTES]]);
  if(!Array.isArray(reply)||reply.length!==1)return null;
  const entry=Object.getOwnPropertyDescriptor(reply,"0");
  if(!entry||!Object.hasOwn(entry,"value"))return null;
  const record=restartPublicationRecord(entry.value,ref,goal);if(!record)return null;
  return await work({...record,owner,held});
 }catch{return null;}
 finally{await releaseLockStrict(held);}
}

/** The store behind a public address, or null if that handle is free. */
export async function storeForHandle(handle: string): Promise<Store | null> {
  if (!isRedisConfigured()) return null;
  if (handleProblem(handle)) return null;
  const [email] = await redisPipeline([["GET", handleKey(handle)]]);
  if (typeof email !== "string" || !email) return null;
  // A name that was let go is held, not owned: it leads nowhere on purpose.
  if (email.startsWith(RELEASED_PREFIX)) return null;
  const [raw] = await redisPipeline([["GET", await ownerKey(email)]]);
  return parseStore(raw);
}

/**
 * The store behind a public address, read once per page view: the layout,
 * the page's head and the page itself ask for it, and all three are given
 * the one answer. Only for pages; anything that writes reads afresh.
 */
export const storeForPage = cache(storeForHandle);

/**
 * Whether a store with this id still exists: one command, the id's own key,
 * which deleting the store removes first (deleteStore, closeStoreRecord) and
 * moving its owner rewrites in place. For a write that must not outlive its
 * store (the tasks, lib/crm.ts), without reading the whole store record.
 */
export async function storeIdExists(sid: string): Promise<boolean> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return false;
  const [n] = await redisPipeline([["EXISTS", storeIdKey(sid)]]);
  return Number(n) === 1;
}

/**
 * The store with this id, or null. The id comes from a cookie, a link or a
 * team record, so the store found is checked to carry that very id.
 */
export async function storeForId(sid: string): Promise<Store | null> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return null;
  const [ref] = await redisPipeline([["GET", storeIdKey(sid)]]);
  if (typeof ref !== "string" || !ref) return null;
  const store = await storeForEmail(ref);
  return store && store.sid === sid ? store : null;
}

/**
 * Every store an account owns, its first store first and the others in the
 * order they were made. A store whose record says it belongs to someone
 * else — which only a half-finished move could leave — is not listed.
 */
export async function accountStores(email: string): Promise<Store[]> {
  if (!isRedisConfigured()) return [];
  const address = email.toLowerCase();
  const [first, members] = await redisPipeline([
    ["GET", await ownerKey(address)],
    ["SMEMBERS", await accountKey(address)],
  ]);
  const ids = Array.isArray(members)
    ? members.filter((id): id is string => typeof id === "string" && STORE_ID_PATTERN.test(id))
    : [];
  const others = ids.length
    ? (await redisPipeline(await Promise.all(ids.map(async (id) => ["GET", await ownerKey(extraRef(id))]))))
        .map(parseStore)
        .filter((store): store is Store => store !== null && store.extra && store.email.toLowerCase() === address)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const main = parseStore(first);
  return main ? [main, ...others] : others;
}

/**
 * Gives a store its own id, if it has none yet, and returns it. Called from
 * the owner's own studio and before a store is first named anywhere by id,
 * so a store made before there could be several gets one the first time it
 * needs one and never a second.
 */
export async function ensureStoreId(email: string): Promise<Store | null> {
  const store = await storeForEmail(email);
  if (!store || store.sid) return store;
  return withStore(email, async (current, save) => {
    // Another request may have named it while this one waited for the lock.
    if (current.sid) return current;
    const next = await save({ ...current, sid: newListId() });
    await redisPipeline([["SET", storeIdKey(next.sid), storeRef(next)]]);
    return next;
  });
}

/**
 * One store at no setting at all: what a new store is before its creator
 * touches anything. The first store of an account and every other one start
 * from exactly the same place.
 */
async function freshStore(fields: {
  handle: string;
  name: string;
  bio: string;
  email: string;
  sid: string;
  extra: boolean;
}): Promise<Store> {
  const createdAt = new Date().toISOString();
  // Where its product records go (lib/catalog.ts), derived from the key the
  // store is kept under, so an account's stores never share one.
  const ref = fields.extra ? extraRef(fields.sid) : fields.email;
  return {
    handle: fields.handle,
    name: fields.name.trim().slice(0, MAX_NAME_LENGTH) || fields.handle,
    bio: fields.bio.trim().slice(0, MAX_BIO_LENGTH),
    email: fields.email.toLowerCase(),
    sid: fields.sid,
    extra: fields.extra,
    createdAt,
    activationTracked: true,
    previousHandles: [],
    releasedHandles: [],
    renamedAt: "",
    stripeAccountId: null,
    stripeChargesEnabled: false,
    stripeCheckedAt: "",
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionActive: false,
    subscriptionCheckedAt: "",
    tier: "creator",
    cycle: "month",
    trialEnds: 0,
    period: null,
    shared: false,
    planEndedAt: "",
    mail: null,
    domain: null,
    // A new store starts in the layout of lib/catalog.ts: nothing to move.
    catalog: emptyCatalog(await catalogIdFor(ref, createdAt)),
    links: [],
    hasDiscounts: false,
    listId: newListId(),
    look: { ...DEFAULT_LOOK },
    photoId: null,
    callsId: null,
    statsId: newListId(),
    pixels: { ...NO_PIXELS },
    tax: { ...NO_TAX },
    recovery: { ...NO_RECOVERY },
    save: { ...NO_SAVE },
    pause: 0,
    dunning: { ...DEFAULT_DUNNING },
    leaving: { ...NO_LEAVE, reasons: [...NO_LEAVE.reasons] },
    nudge: { ...NO_NUDGE },
    yearlyAsk: { ...NO_YEARLY_ASK },
    weeklyAi: false,
    adsServer: [],
    attributionDays: DEFAULT_ATTRIBUTION_DAYS,
    chatSales: false,
    embedSites: [],
    winback: { ...NO_WINBACK },
    welcomeOffer: { ...NO_WELCOME_OFFER },
    inbox: { ...NO_INBOX, saved: [] },
    sale: { ...NO_SALE },
    pastSales: [],
    tiers: [],
    community: null,
    affiliates: parseAffiliateSetting(null),
    currency: DEFAULT_CURRENCY,
    reviewAsk: parseReviewAsk(null),
    reviewed: false,
    posts: 0,
    socials: [],
    join: { on: false, heading: "", line: "" },
    quotes: [],
    contact: { on: false, heading: "", line: "" },
    tips: { ...NO_TIPS },
    kit: parseKit(null),
    numbersLinks: [],
    suspended: "",
    strikes: [],
    faq: [],
    intro: null,
    order: [...USUAL_ORDER],
    exitOffer: null,
    sections: [],
    collections: [],
    sitePages: [],
    announcement: null,
    visitUs: null,
    answers: { ...NO_ANSWERS },
    assistant: { ...NO_ASSISTANT },
    assistantPlan: null,
    nextOffer: { ...NO_NEXT_OFFER },
    assistReminder: { ...NO_ASSIST_REMINDER },
    fair: { ...DEFAULT_FAIR },
    cartDeal: { ...NO_DEAL },
    language: DEFAULT_LANGUAGE,
    emailSync: null,
    phoneSales: false,
    askWhyNot: false,
    recentSales: false,
    pastBuyers: false,
    paypalSeller: null,
  };
}

/**
 * One step through every store, for a scheduled job that has to look at all
 * of them. `cursor` is Redis's own: "0" to begin, and "0" comes back once the
 * last store has been read. A store can be seen twice while it moves between
 * addresses, so whatever is done with each one has to be safe to repeat.
 */
export async function storesAfter(cursor: string): Promise<{ stores: Store[]; next: string }> {
  if (!isRedisConfigured()) return { stores: [], next: "0" };
  const [reply] = await redisPipeline([["SCAN", cursor, "MATCH", "nl:store:owner:*", "COUNT", 200]]);
  if (!Array.isArray(reply) || reply.length < 2) return { stores: [], next: "0" };
  const next = String(reply[0]);
  const keys = Array.isArray(reply[1]) ? (reply[1] as unknown[]).map(String) : [];
  if (keys.length === 0) return { stores: [], next };
  const values = await redisPipeline(keys.map((key) => ["GET", key]));
  const stores = values.map(parseStore).filter((store): store is Store => store !== null);
  return { stores, next };
}

// ---- Writing a store, one writer at a time ---------------------------------

/**
 * How long one write may hold its store, and how long another waits for it.
 *
 * Every write below reads the store, changes it and writes it back, and now
 * that a product's change touches its own records as well as the store's,
 * two writes at the same instant — two tabs, or an upload finishing while a
 * price is saved — must not interleave. Each takes the store's lock first;
 * the next one waits its turn rather than overwriting the first. A lock left
 * by a request that died is gone after LOCK_SECONDS.
 */
const LOCK_SECONDS = 15;
const LOCK_WAIT_MS = 8_000;

/**
 * Thrown when a store stayed locked by another write for longer than we
 * wait, or when this write's lock ran out before it could land (a write held
 * up past LOCK_SECONDS is refused rather than written over a newer one).
 */
export class StoreBusyError extends Error {
  constructor() {
    super("store_busy");
  }
}

/**
 * Thrown instead of writing a store record whose product index would lose
 * products nobody asked to remove — an empty index over a full one, above
 * all. A store record is the only list of what a store sells; nothing may
 * shrink it but an explicit removal (ProductChange.drop).
 */
export class CatalogGuardError extends Error {
  constructor(message: string) {
    super(`catalog_guard: ${message}`);
  }
}

/** How long the record a store had before its move to product records is kept. */
const BEFORE_MOVE_SECONDS = 30 * 24 * 60 * 60;

const lockKeyOf = (owner: string) => owner.replace("nl:store:owner:", "nl:store:lock:");
const beforeMoveKeyOf = (owner: string) => owner.replace("nl:store:owner:", "nl:store:before-catalog:");

/** Where a store's product records are kept: derived, so moving it twice writes the same records. */
async function catalogIdFor(email: string, createdAt: string): Promise<string> {
  return (await sha256Hex(`nimbus-catalog:${email.toLowerCase()}:${createdAt}`)).slice(0, 32);
}

/** The store record as it is written: the catalog as its index and head, never inline. */
function recordJson(store: Store): string {
  return JSON.stringify({ ...store, catalog: catalogRecord(store.catalog) });
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** What a write did to the products, besides the store record itself. */
type ProductChange = {
  /** Products added or changed, written in full. A new one goes to the end. */
  put?: Product[];
  /** Products taken off. Their records are forgotten once the store no longer lists them. */
  drop?: string[];
};

type Save = (next: Store, change?: ProductChange) => Promise<Store>;

/**
 * The checks every store record passes before it is written over `before`:
 * the same catalog, and no product gone from its index unless it was named
 * in `drop`. So no path — a bug in a setter, a record read half, a move to
 * another address — can write an empty index over a full one.
 */
function guardRecord(before: Store, next: Store, drop: Set<string> = new Set()): void {
  const id = before.catalog.id;
  if (!id) throw new Error("the store has not been moved to product records");
  if (next.catalog.id !== id) throw new CatalogGuardError("another catalog");
  const kept = new Set(next.catalog.items.map((item) => item.id));
  const lost = before.catalog.items.filter((item) => !kept.has(item.id) && !drop.has(item.id));
  if (lost.length > 0) {
    console.error("refused a store write that would drop products from its index", { catalog: id, lost: lost.length });
    throw new CatalogGuardError(`${lost.length} product(s) would leave the index`);
  }
}

/**
 * Moves a store written before products had records of their own to the
 * layout of lib/catalog.ts. Called with the store's lock held.
 *
 * Nothing is lost at any step. The product records are written first, then
 * the old record is kept aside for thirty days, and only then is the store
 * record replaced, in a single write. A failure before that last write
 * leaves the old record exactly as it was, still the whole store, and the
 * next attempt writes the same records again under the same id.
 */
async function moveToRecords(owner: string, store: Store, raw: string, held: Held): Promise<Store> {
  const inline = store.catalog.inline ?? [];
  const id = await catalogIdFor(storeRef(store), store.createdAt);
  // A store that was moved once already and now reads as one from before has
  // lost its index: its record was written back by code that does not know
  // product records (a rollback to an earlier deployment). Moving it "again"
  // would write an index of only what that record still lists — usually
  // nothing — over the products it has. Refused, loudly, when it lists fewer
  // than the index did, for a person to restore from the product records.
  const listed = await movedCount(id);
  if (listed !== null && inline.length < listed) {
    console.error("a store moved to product records has lost its index; refusing to write it", { catalog: id, listed, found: inline.length });
    throw new CatalogGuardError("lost index");
  }
  if (!(await holdLock(held))) throw new StoreBusyError();
  await runWrites(inline.flatMap((product) => productWrites(id, product)));
  // Counted in the store's data room as they now are: what it already kept is
  // never refused for moving (lib/store-data.ts).
  await noteData(store, inline.map((product) => ({ slot: `p:${product.id}`, bytes: productBytes(product) + BESIDE_PRODUCT, set: true })));
  const items = inline.map(itemOf);
  const head = headFrom(items, new Map(inline.map((product) => [product.id, listingOf(product)])));
  const moved: Store = { ...store, catalog: { id, items, head, inline: null } };
  await redisPipeline([["SET", beforeMoveKeyOf(owner), raw, "EX", BEFORE_MOVE_SECONDS]]);
  if (!(await setIfHeld(held, owner, recordJson(moved)))) throw new StoreBusyError();
  await redisPipeline([movedMark(id, items.length)]);
  return moved;
}

/**
 * Writes one change: the products it touches, then the store record with its
 * index and head brought up to date — the record only while the store's lock
 * is still this write's (lib/redis-lock.ts), and never with an index that
 * lost a product nobody removed.
 */
async function commit(owner: string, held: Held, before: Store, next: Store, change: ProductChange): Promise<Store> {
  const id = before.catalog.id;
  if (!id) throw new Error("the store has not been moved to product records");
  if (next.catalog.id && next.catalog.id !== id) throw new CatalogGuardError("another catalog");
  const put = change.put ?? [];
  const drop = new Set(change.drop ?? []);
  // Refused before anything is written, like the record's own ceiling below.
  const writes = put.flatMap((product) => productWrites(id, product));

  const items: Item[] = next.catalog.items.filter((item) => !drop.has(item.id));
  for (const product of put) {
    const at = items.findIndex((item) => item.id === product.id);
    if (at >= 0) items[at] = itemOf(product);
    else items.push(itemOf(product));
  }
  // Nothing leaves the index unless it was asked to (guardRecord).
  guardRecord(before, { ...next, catalog: { ...next.catalog, id, items } }, drop);
  // The head is built from what was just written and, for the rest of the
  // first page, from the records themselves, so it can never keep a stale
  // card from an earlier write.
  const head = await buildHead(id, items, new Map(put.map((product) => [product.id, listingOf(product)])));
  const saved: Store = { ...next, catalog: { id, items, head, inline: null } };
  const json = recordJson(saved);
  // Only a write that makes the record bigger is weighed, so a store at the
  // ceiling can always remove, shorten and reorder.
  if (byteLength(json) > MAX_STORE_BYTES && byteLength(json) > byteLength(recordJson(before))) {
    throw new StoreFullError();
  }
  // Each product's records take their room in the store's data room before
  // they are written (lib/store-data.ts): a product that grows past it is
  // refused like a record past its ceiling, and one removed gives its room
  // back, all but what is kept beside it (its page's reading, which a page
  // already drawn can still write to, and its side records), which stays
  // counted (lib/store-data-rules.ts, PRODUCT_SIDE_BYTES). The record itself
  // is bounded by MAX_STORE_BYTES.
  const gone = [...drop].filter((id) => !put.some((product) => product.id === id));
  const room = [
    ...put.map((product) => ({ slot: `p:${product.id}`, bytes: productBytes(product) + BESIDE_PRODUCT, set: true })),
    ...gone.map((id) => ({ slot: `p:${id}`, bytes: 0, set: true })),
    ...(gone.length ? [{ slot: "dp", bytes: gone.length * BESIDE_PRODUCT }] : []),
  ];
  if (room.length) {
    const taken = await takeData(before, room);
    if (!taken.ok) throw taken.reason === "full" ? new StoreFullError() : new StoreBusyError();
  }
  // The lock is made to last another term before anything is written, and
  // the record is written only while it is still ours: a write held up past
  // its lock is refused rather than landed over whatever came after it.
  if (!(await holdLock(held))) throw new StoreBusyError();
  await runWrites(writes);
  if (!(await setIfHeld(held, owner, json))) throw new StoreBusyError();
  if (items.length !== before.catalog.items.length) await redisPipeline([movedMark(id, items.length)]);
  // Forgotten once nothing lists them; a failure here leaves records nobody reads.
  if (drop.size) await runWrites([...drop].flatMap((gone) => productDrops(id, gone))).catch(() => {});
  return saved;
}

/**
 * Runs one write on a store, with its lock held: reads the store, moves it
 * to product records first if it has not been yet, and hands `work` the store
 * and the way to save it. Returns null when the address has no store.
 */
async function withStore<T>(email: string, work: (store: Store, save: Save, held: Held) => Promise<T>): Promise<T | null> {
  if (!email || !isRedisConfigured()) return null;
  const owner = await ownerKey(email);
  let held: Held;
  try {
    held = await takeLock(lockKeyOf(owner), LOCK_SECONDS, LOCK_WAIT_MS);
  } catch (error) {
    if (error instanceof LockBusyError) throw new StoreBusyError();
    throw error;
  }
  try {
    const [raw] = await redisPipeline([["GET", owner]]);
    let store = parseStore(raw);
    if (!store) return null;
    if (!store.catalog.id) store = await moveToRecords(owner, store, raw as string, held);
    let current = store;
    const save: Save = async (next, change = {}) => {
      current = await commit(owner, held, current, next, change);
      return current;
    };
    return await work(store, save, held);
  } finally {
    // Let go only of our own lock, in one step (lib/redis-lock.ts): one that
    // ran out and was taken by the next write is theirs.
    await releaseLock(held);
  }
}

/**
 * Holds the locks of several stores at once, one inside the other, and hands
 * `work` the stores as they are with all of them held. A key with no store
 * behind it is left out. Only for a change that has to write several stores
 * in one go: moving an account's stores to a new address.
 */
async function withStores<T>(
  refs: string[],
  work: (stores: { store: Store; held: Held }[]) => Promise<T>,
  taken: { store: Store; held: Held }[] = [],
): Promise<T> {
  if (refs.length === 0) return work(taken);
  const [first, ...rest] = refs;
  const inner = await withStore(first, (store, _save, held) => withStores(rest, work, [...taken, { store, held }]));
  return inner === null ? withStores(rest, work, taken) : inner;
}

/** A write that changes the store record only. */
async function patchStore(email: string, change: (store: Store) => Partial<Store> | null): Promise<Store | null> {
  return withStore(email, async (store, save) => {
    const patch = change(store);
    return patch === null ? store : save({ ...store, ...patch });
  });
}

/**
 * Moves a store to product records now, if it has not been moved yet. Safe
 * to call again and again: a store already moved is left as it is. Returns
 * whether this call moved it.
 */
export async function moveStoreToRecords(email: string): Promise<boolean> {
  const before = await storeForEmail(email);
  if (!before || before.catalog.id) return false;
  await withStore(email, async (store) => store);
  return true;
}

/** Where the daily job's walk through the stores stopped, when its time ran out. */
const MOVE_CURSOR_KEY = "nl:catalog:move:cursor";

export type MoveCounts = { seen: number; moved: number; failed: number; complete: boolean };

/**
 * The one-time move of every store to product records, a step of which runs
 * with the daily job (app/api/cron/plans). Each store is also moved the
 * first time it is written, so this only reaches the ones nobody touches.
 * Stops at `deadline` and carries on from there the next day; a store seen
 * twice, or already moved, is left alone.
 */
export async function moveAllStores(deadline: number): Promise<MoveCounts> {
  const counts: MoveCounts = { seen: 0, moved: 0, failed: 0, complete: false };
  if (!isRedisConfigured()) return counts;
  const [saved] = await redisPipeline([["GET", MOVE_CURSOR_KEY]]);
  let cursor = typeof saved === "string" && /^\d+$/.test(saved) ? saved : "0";
  for (let step = 0; step < 10_000; step += 1) {
    if (Date.now() >= deadline) {
      await redisPipeline([["SET", MOVE_CURSOR_KEY, cursor, "EX", 7 * 86_400]]);
      return counts;
    }
    const { stores, next } = await storesAfter(cursor);
    for (const store of stores) {
      counts.seen += 1;
      if (store.catalog.id) continue;
      try {
        // An account's other stores are kept under "#<id>", not the address.
        if (await moveStoreToRecords(storeRef(store))) counts.moved += 1;
      } catch (error) {
        counts.failed += 1;
        console.error("moving a store to product records failed", error);
      }
    }
    cursor = next;
    if (cursor === "0") break;
  }
  await redisPipeline([["DEL", MOVE_CURSOR_KEY]]);
  counts.complete = true;
  return counts;
}

export type ClaimResult =
  | { ok: true; store: Store }
  | { ok: false; reason: "taken" | "reserved" | "shape" | "already" };

/**
 * Reserves a handle for a creator and creates their first store.
 *
 * The handle is the address other people will bookmark, so it is never handed
 * out twice. An account that already has its first store makes the others
 * with createStore, below.
 */
export async function claimHandle(
  email: string,
  rawHandle: string,
  rawName: string,
  rawBio: string,
): Promise<ClaimResult> {
  const handle = normaliseHandle(rawHandle);
  const problem = newAddressProblem(handle);
  if (problem) return { ok: false, reason: problem };

  const existing = await storeForEmail(email);
  if (existing) return { ok: false, reason: "already" };

  const [taken] = await redisPipeline([
    ["SET", handleKey(handle), email.toLowerCase(), "NX"],
  ]);
  if (taken === null) return { ok: false, reason: "taken" };

  const store = await freshStore({ handle, name: rawName, bio: rawBio, email, sid: newListId(), extra: false });

  try {
    await redisPipeline([
      ["SET", await ownerKey(email), recordJson(store)],
      ["SET", storeIdKey(store.sid), email.toLowerCase()],
    ]);
  } catch (error) {
    // Give the name back rather than leaving it locked to a store that does
    // not exist.
    await redisPipeline([["DEL", handleKey(handle)]]).catch(() => {});
    throw error;
  }

  return { ok: true, store };
}

export type CreateResult =
  | { ok: true; store: Store }
  | { ok: false; reason: "taken" | "reserved" | "shape" | "first" | "too_many"; limit?: number };

/**
 * Makes another store for an account that already has its first.
 *
 * It starts as empty as a first store does, with a handle, a folder, a list
 * and a subscription of its own; nothing is copied from the other stores.
 * The count is taken after the new id is added, so two stores made at the
 * same instant cannot both slip under the ceiling.
 */
export async function createStore(
  email: string,
  rawHandle: string,
  rawName: string,
  rawBio: string,
): Promise<CreateResult> {
  const handle = normaliseHandle(rawHandle);
  const problem = newAddressProblem(handle);
  if (problem) return { ok: false, reason: problem };
  if (!(await storeForEmail(email))) return { ok: false, reason: "first" };

  const sid = newListId();
  const ref = extraRef(sid);
  const account = await accountKey(email);
  const [, count] = await redisPipeline([
    ["SADD", account, sid],
    ["SCARD", account],
  ]);
  if (Number(count) + 1 > MAX_STORES_PER_ACCOUNT) {
    await redisPipeline([["SREM", account, sid]]);
    return { ok: false, reason: "too_many", limit: MAX_STORES_PER_ACCOUNT };
  }

  const [taken] = await redisPipeline([["SET", handleKey(handle), ref, "NX"]]);
  if (taken === null) {
    await redisPipeline([["SREM", account, sid]]);
    return { ok: false, reason: "taken" };
  }

  const store = await freshStore({ handle, name: rawName, bio: rawBio, email, sid, extra: true });
  try {
    await redisPipeline([
      ["SET", await ownerKey(ref), recordJson(store)],
      ["SET", storeIdKey(sid), ref],
    ]);
  } catch (error) {
    await redisPipeline([
      ["DEL", handleKey(handle)],
      ["SREM", account, sid],
    ]).catch(() => {});
    throw error;
  }
  return { ok: true, store };
}

export type DeleteResult =
  | { ok: true; store: Store }
  | { ok: false; reason: "none" | "first" | "products" | "paying" | "domain" };

/**
 * Deletes one of an account's other stores, while there is nothing in it to
 * lose.
 *
 * Only a store with no products, no subscription in good standing and no
 * domain of its own can go: a store that has sold something has buyers who
 * will come back to it, and a store that is paying would be deleted with
 * money still running. Its addresses are let go the way a released address
 * is — dark for a month before anyone else may take them — so a link
 * already shared leads nowhere rather than to a stranger. An account's first
 * store is its home, and is never deleted here.
 */
export async function deleteStore(email: string): Promise<DeleteResult> {
  // Under the store's lock, so a product added in the same instant is either
  // seen here or never written.
  const result = await withStore<DeleteResult>(email, async (store) => {
    if (!store.extra) return { ok: false, reason: "first" };
    if (productCount(store) > 0) return { ok: false, reason: "products" };
    if (store.subscriptionActive) return { ok: false, reason: "paying" };
    if (store.domain) return { ok: false, reason: "domain" };

    const released = `${RELEASED_PREFIX}${new Date().toISOString()}`;
    const handles = [store.handle, ...store.previousHandles];
    await redisPipeline([
      ...handles.map((handle) => ["SET", handleKey(handle), released, "EX", RELEASE_QUARANTINE_DAYS * 24 * 60 * 60]),
      ["DEL", await ownerKey(storeRef(store))],
      ["DEL", storeIdKey(store.sid)],
      ["SREM", await accountKey(store.email), store.sid],
      ["ZREM", ENDED_INDEX, storeRef(store)],
      ["SREM", SHARING_INDEX, storeRef(store)],
    ]);
    return { ok: true, store };
  });
  return result ?? { ok: false, reason: "none" };
}

/**
 * The store record of a store that closed (lib/closed-store-data.ts, added
 * 18 October 2026): its addresses are held back from anybody else for
 * RELEASE_QUARANTINE_DAYS, as a deleted store's are, so a link already
 * shared leads nowhere rather than to a stranger; then the record, its id,
 * its place among its account's stores and in the company's lists go. Its
 * owner's account and sign-in stay, and may make a store again. Run after
 * everything that needed the record has read it.
 */
export async function closeStoreRecord(store: Store, extraKeys: string[] = []): Promise<void> {
  const released = `${RELEASED_PREFIX}${new Date().toISOString()}`;
  const owner = await ownerKey(storeRef(store));
  await redisPipeline([
    ...[store.handle, ...store.previousHandles].map((handle) => ["SET", handleKey(handle), released, "EX", RELEASE_QUARANTINE_DAYS * 24 * 60 * 60]),
    ["DEL", owner, beforeMoveKeyOf(owner), ...extraKeys],
    ...(STORE_ID_PATTERN.test(store.sid) ? [["DEL", storeIdKey(store.sid)], ["SREM", await accountKey(store.email), store.sid]] : []),
    ["ZREM", ENDED_INDEX, storeRef(store)],
    ["SREM", SHARING_INDEX, storeRef(store)],
  ]);
}

export type RenameResult =
  | { ok: true; store: Store }
  | {
      ok: false;
      reason: "taken" | "reserved" | "shape" | "none" | "same" | "too_many";
      limit?: number;
    };

/**
 * Moves a store to a new address without breaking the old one.
 *
 * The first address a creator picks is usually picked in a hurry, and by then
 * it is already in their bio, in old posts and in messages other people sent.
 * So the old address is never handed to anyone else and never stops working:
 * it keeps pointing at this store, and the page sends visitors on to the new
 * address by itself. Nothing published has to be redone.
 *
 * Nobody has to be asked, and nothing has to be waited for. The creator does
 * it alone, and it takes effect on the spot.
 */
export async function renameHandle(
  email: string,
  rawHandle: string,
): Promise<RenameResult> {
  const handle = normaliseHandle(rawHandle);
  const problem = newAddressProblem(handle);
  if (problem) return { ok: false, reason: problem };

  const result = await withStore<RenameResult>(email, async (store, save) => {
    if (store.handle === handle) return { ok: false, reason: "same" };
    let claimed = false;

    // Going back to an address this store already owns costs nothing: no new
    // lock, and no room on the shelf, because it never stopped being theirs.
    if (!store.previousHandles.includes(handle)) {
      if (store.previousHandles.length + 2 > MAX_ADDRESSES) {
        return { ok: false, reason: "too_many", limit: MAX_ADDRESSES };
      }
      const [taken] = await redisPipeline([
        ["SET", handleKey(handle), email.toLowerCase(), "NX"],
      ]);
      if (taken === null) return { ok: false, reason: "taken" };
      claimed = true;
    }

    let next: Store;
    try {
      next = await save({
        ...store,
        handle,
        previousHandles: [
          ...store.previousHandles.filter((old) => old !== handle),
          store.handle,
        ].slice(-20),
        renamedAt: new Date().toISOString(),
      });
    } catch (error) {
      // The store was not moved: give the address back, or it would stay
      // claimed by a store that never took it, for this creator and everyone.
      if (claimed) {
        const [holder] = await redisPipeline([["GET", handleKey(handle)]]);
        if (holder === email.toLowerCase()) await redisPipeline([["DEL", handleKey(handle)]]);
      }
      throw error;
    }
    // The store's own domain follows it to the new address.
    if (next.domain) await pointDomain(next.domain.name, [store.handle, ...store.previousHandles], handle);
    return { ok: true, store: next };
  });
  return result ?? { ok: false, reason: "none" };
}

export type StripeAccountResult =
  | { ok: true; store: Store }
  | { ok: false; reason: "none" | "shape" };

/**
 * Writes down which Stripe account a creator connected.
 *
 * Only the identifier is kept. Marktmorgen never holds a key to that account and
 * never holds the money that lands in it.
 */
export async function setStripeAccount(
  email: string,
  accountId: string,
  chargesEnabled = false,
): Promise<StripeAccountResult> {
  if (!STRIPE_ACCOUNT_PATTERN.test(accountId)) {
    return { ok: false, reason: "shape" };
  }
  const next = await patchStore(email, () => ({
    stripeAccountId: accountId,
    stripeChargesEnabled: chargesEnabled,
    stripeCheckedAt: new Date().toISOString(),
  }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/**
 * Writes down who is paying us, and whether that payment is in good standing.
 *
 * Called on the way back from checkout and every time the studio is opened,
 * so the snapshot the public store page trusts is refreshed at the moment the
 * creator would notice it being wrong.
 */
export async function setSubscription(
  email: string,
  fields: {
    customerId?: string | null;
    subscriptionId?: string | null;
    active: boolean;
    tier?: Tier;
    cycle?: Cycle;
    trialEnds?: number;
    shared?: boolean;
    /** The period paid for; null forgets it (a plan not running, a trial). Left as it is when not given. */
    period?: BillingPeriod | null;
    /**
     * Whether Stripe says the renewal now running is unpaid (232 [CA1] unit 4).
     * Not given: kept for the same subscription, cleared for another one.
     */
    renewalUnpaid?: boolean;
  },
  expected?: Pick<Store, "sid" | "statsId" | "stripeCustomerId" | "subscriptionId" | "subscriptionActive" | "tier" | "cycle">,
): Promise<Store | null> {
  // Capture the source before waiting for the writer lock. Ordinary callers
  // keep their existing behavior; a restart can refuse an intervening change.
  const source = expected ? { sid: expected.sid, statsId: expected.statsId,
    stripeCustomerId: expected.stripeCustomerId, subscriptionId: expected.subscriptionId,
    subscriptionActive: expected.subscriptionActive, tier: expected.tier, cycle: expected.cycle } : null;
  const result = await withStore<Store | null>(email, async (store, save) => {
    if (source && (store.sid !== source.sid || store.statsId !== source.statsId ||
        store.stripeCustomerId !== source.stripeCustomerId || store.subscriptionId !== source.subscriptionId ||
        store.subscriptionActive !== source.subscriptionActive || store.tier !== source.tier || store.cycle !== source.cycle)) return null;
    const customerId =
      fields.customerId === undefined ? store.stripeCustomerId : fields.customerId;
    const subscriptionId =
      fields.subscriptionId === undefined
        ? store.subscriptionId
        : fields.subscriptionId;

    // A malformed id is refused rather than written down, for the same reason a
    // malformed account id is: a bad id here means every later question about
    // this store's subscription asks Stripe about something that is not it.
    if (customerId !== null && !CUSTOMER_PATTERN.test(customerId)) return null;
    if (subscriptionId !== null && !SUBSCRIPTION_PATTERN.test(subscriptionId)) {
      return null;
    }

    // A proved period never becomes an inferred renewal through a writer
    // that omitted its marker. New identities/plans/periods need fresh proof.
    if(fields.period!==undefined&&fields.period!==null&&!isPeriod(fields.period))return null;
    let period=!fields.active?null:fields.period===undefined?store.period??null:fields.period;
    if(fields.active&&store.period?.funded===true){
      const changed=subscriptionId!==store.subscriptionId||(fields.tier??store.tier)!==store.tier||(fields.cycle??store.cycle)!==store.cycle;
      if(changed&&fields.period?.funded!==true)return null;
      if(period?.funded!==true){
        if(!period||period.start!==store.period.start||period.end!==store.period.end)return null;
        period={...period,funded:true};
      }
    }

    // The day a plan is first seen to be over is written down once, and
    // wiped when a plan runs again. A store that never started one has none.
    const had = store.subscriptionActive || store.subscriptionId !== null || subscriptionId !== null;
    const planEndedAt = fields.active ? "" : store.planEndedAt || (had ? new Date(Date.now()).toISOString() : "");
    // The day a renewal was first seen unpaid is written down once and kept
    // while it stays unpaid; paying it, a plan not running, or another
    // subscription clears it.
    const unpaidBefore = store.subscriptionId === subscriptionId ? store.renewalUnpaidSince ?? 0 : 0;
    const unpaid = fields.active && (fields.renewalUnpaid ?? unpaidBefore > 0);
    const renewalUnpaidSince = unpaid ? unpaidBefore || Math.floor(Date.now() / 1000) : 0;

    const saved = await save({
      ...store,
      stripeCustomerId: customerId,
      subscriptionId,
      subscriptionActive: fields.active,
      subscriptionCheckedAt: new Date().toISOString(),
      tier: fields.tier ?? store.tier,
      cycle: fields.cycle ?? store.cycle,
      trialEnds: fields.trialEnds ?? store.trialEnds,
      shared: fields.shared ?? store.shared,
      // A plan that is not running has no period to follow.
      period,
      planEndedAt,
      renewalUnpaidSince,
    });
    // Kept in line by the day its plan ended, for the daily job that looks
    // at what such a store still keeps (lib/plan-closing.ts), and taken out
    // of line the moment a plan runs again. Only when it changes: this is
    // written every time a studio is opened.
    if (planEndedAt !== store.planEndedAt) {
      await redisPipeline([
        planEndedAt ? ["ZADD", ENDED_INDEX, Date.parse(planEndedAt), storeRef(saved)] : ["ZREM", ENDED_INDEX, storeRef(saved)],
      ]).catch((error) => console.error("could not keep the line of ended plans", error));
    }
    // The stores that pay us, for the shared ceiling on stores that do not
    // (lib/free-pool-rules.ts): it grows only with them. A trial pays
    // nothing yet, and a plan with no subscription behind it pays nothing.
    const nowSeconds = Date.now() / 1000;
    // A renewal Stripe could not collect pays nothing until it is paid.
    const paysNow = (record: Store) => record.subscriptionActive && Boolean(record.subscriptionId) && !(record.trialEnds > nowSeconds) && !((record.renewalUnpaidSince ?? 0) > 0);
    await redisPipeline([[paysNow(saved) ? "SADD" : "SREM", PAYING_INDEX, storeRef(saved)]]).catch((error) =>
      console.error("could not keep the list of stores that pay", error),
    );
    // The stores whose sales pay a share, for the daily job that keeps what
    // was taken to what is owed (lib/share-settle.ts). Only when it changes.
    const sharing = saved.shared && saved.subscriptionActive;
    if (sharing !== (store.shared && store.subscriptionActive)) {
      await redisPipeline([[sharing ? "SADD" : "SREM", SHARING_INDEX, storeRef(saved)]]).catch((error) =>
        console.error("could not keep the list of stores that pay a share", error),
      );
    }
    return saved;
  });
  return result ?? null;
}

/** Forgets the connection here. Returns the account that was let go. */
export async function clearStripeAccount(
  email: string,
): Promise<{ store: Store; was: string | null } | null> {
  return withStore(email, async (store, save) => {
    const was = store.stripeAccountId;
    const next = await save({
      ...store,
      stripeAccountId: null,
      stripeChargesEnabled: false,
      stripeCheckedAt: "",
    });
    return { store: next, was };
  });
}

export type MoveResult =
  | { ok: true; store: Store }
  | { ok: false; reason: "none" | "same" | "taken" };

/**
 * Moves a store from one sign-in address to another.
 *
 * The address is the key to everything here, which is kind right up until the
 * day a creator loses that inbox. This is the door out, and it only opens from
 * the inside: they move the store while they can still sign in.
 *
 * The new record is written before the old one is deleted, so an interrupted
 * move leaves the store findable rather than gone. The products stay where
 * they are: their records are filed under the catalog's own id, which the
 * record carries along.
 *
 * Files already attached keep working. Their paths were written down when they
 * were uploaded and are read back as written, so they stay reachable in the
 * folder of the old address; only new uploads land in the new one. The
 * account's other stores keep their folders as they are, because their keys
 * never held the address.
 */
export async function moveAccount(
  fromEmail: string,
  toEmail: string,
): Promise<MoveResult> {
  const from = fromEmail.toLowerCase();
  const to = toEmail.toLowerCase();
  if (from === to) return { ok: false, reason: "same" };
  if (!isRedisConfigured()) return { ok: false, reason: "none" };

  const result = await withStore<MoveResult>(from, async (store, _save, held) => {
    // The address it is moving to must not already own a store of its own.
    const [existing, theirs] = await redisPipeline([
      ["GET", await ownerKey(to)],
      ["SCARD", await accountKey(to)],
    ]);
    if ((typeof existing === "string" && existing) || Number(theirs) > 0) {
      return { ok: false, reason: "taken" };
    }

    // The account's other stores go with it. Their keys do not contain the
    // address, so only the owner written inside each one changes — each read
    // and written under its own lock, taken inside this one, so a change
    // made to one of them in the same instant is neither lost nor undone.
    const refs = (await accountStores(from)).filter((other) => other.extra).map(storeRef);
    return withStores(refs, async (others) => {
      const next: Store = { ...store, email: to };
      const moved = others.map(({ store: other, held: lock }) => ({ before: other, next: { ...other, email: to }, lock }));
      // The same checks as every other write (guardRecord), before anything is
      // written: each record keeps its catalog and every product in it.
      guardRecord(store, next);
      for (const one of moved) guardRecord(one.before, one.next);
      // Every lock made to last another term, then each record written only
      // while its lock is still ours (lib/redis-lock.ts). The new address's
      // record only where there is none: a store made there in the meantime
      // is never written over. A write refused here leaves the old records
      // as they were, still the account, at its old address.
      for (const lock of [held, ...moved.map((one) => one.lock)]) {
        if (!(await holdLock(lock))) throw new StoreBusyError();
      }
      if (!(await setIfHeld(held, await ownerKey(to), recordJson(next), { absent: true }))) {
        return { ok: false, reason: "taken" };
      }
      const written: typeof moved = [];
      for (const one of moved) {
        if (!(await setIfHeld(one.lock, await ownerKey(storeRef(one.before)), recordJson(one.next)))) {
          // Everything written so far is taken back, so the account is not
          // left half at each address.
          for (const done of written) {
            await setIfHeld(done.lock, await ownerKey(storeRef(done.before)), recordJson(done.before)).catch(() => false);
          }
          await redisPipeline([["DEL", await ownerKey(to)]]).catch(() => {});
          throw new StoreBusyError();
        }
        written.push(one);
      }
      const handles = [store.handle, ...store.previousHandles];
      await redisPipeline([
        ...handles.map((handle) => ["SET", handleKey(handle), to]),
        ...(store.sid ? [["SET", storeIdKey(store.sid), to]] : []),
        ...(moved.length ? [["SADD", await accountKey(to), ...moved.map((one) => one.before.sid)]] : []),
        ["DEL", await accountKey(from)],
        ["DEL", await ownerKey(from)],
      ]);
      return { ok: true, store: next };
    });
  });
  return result ?? { ok: false, reason: "none" };
}

export type ReleaseResult =
  | { ok: true; store: Store }
  | { ok: false; reason: "none" | "current" | "unknown" };

/**
 * Lets go of an address the store used before.
 *
 * This is the one destructive thing a creator can do to their own audience,
 * so it is never automatic and never implied: a link still printed under that
 * name stops working the moment it is released, and a month later the name
 * may belong to somebody else. It exists because the opposite is worse. An
 * address mistyped and abandoned a minute later, never published anywhere,
 * would otherwise sit on a slot for good.
 *
 * Freeing the slot costs the name: it goes back on the shelf rather than
 * staying quietly in this account. That is what keeps the ceiling honest —
 * nobody can pile up names by releasing them.
 */
export async function releaseHandle(
  email: string,
  rawHandle: string,
): Promise<ReleaseResult> {
  const handle = normaliseHandle(rawHandle);

  const result = await withStore<ReleaseResult>(email, async (store, save) => {
    if (store.handle === handle) return { ok: false, reason: "current" };
    if (!store.previousHandles.includes(handle)) {
      return { ok: false, reason: "unknown" };
    }

    await redisPipeline([
      [
        "SET",
        handleKey(handle),
        `${RELEASED_PREFIX}${new Date().toISOString()}`,
        "EX",
        RELEASE_QUARANTINE_DAYS * 24 * 60 * 60,
      ],
    ]);

    const next = await save({
      ...store,
      previousHandles: store.previousHandles.filter((old) => old !== handle),
      releasedHandles: [...store.releasedHandles.filter((old) => old !== handle), handle],
    });
    return { ok: true, store: next };
  });
  return result ?? { ok: false, reason: "none" };
}

/**
 * Every address this store's sales may be recorded under in Stripe: the one
 * it has, the ones that still lead here, and the ones it let go of.
 */
export function saleHandles(store: Pick<Store, "handle" | "previousHandles" | "releasedHandles">): Set<string> {
  return new Set([store.handle, ...store.previousHandles, ...(store.releasedHandles ?? [])]);
}

export type DetailsResult =
  | { ok: true; store: Store }
  | { ok: false; reason: "none" | "name" };

/**
 * Changes the name and the description the public page shows.
 *
 * The address is deliberately not touched here: it is the part other people
 * have written down, so it has a door of its own with its own warnings.
 */
export async function updateDetails(
  email: string,
  rawName: string,
  rawBio: string,
): Promise<DetailsResult> {
  const name = rawName.trim().slice(0, MAX_NAME_LENGTH);
  if (!name) return { ok: false, reason: "name" };
  const next = await patchStore(email, () => ({ name, bio: rawBio.trim().slice(0, MAX_BIO_LENGTH) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

// ---- Changing one product ---------------------------------------------------

type Refusal<R extends string> = { ok: false; reason: R };

function refused<R extends string>(value: unknown): value is Refusal<R> {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

/**
 * Reads one product in full under the store's lock, lets `change` rewrite it
 * or refuse, and saves it. `extra` changes the store record in the same
 * write. What comes back is the store and the product as saved, and the
 * product as it was.
 */
async function onProduct<R extends string>(
  email: string,
  id: string,
  change: (product: Product, store: Store) => Product | Refusal<R> | Promise<Product | Refusal<R>>,
  extra: (store: Store, product: Product) => Partial<Store> = () => ({}),
): Promise<{ ok: true; store: Store; product: Product; before: Product } | Refusal<R | "none" | "unknown">> {
  const result = await withStore(email, async (store, save) => {
    const product = await readProduct(store, id);
    if (!product) return { ok: false as const, reason: "unknown" as const };
    const changed = await change(product, store);
    if (refused<R>(changed)) return changed;
    const saved = await save({ ...store, ...extra(store, changed) }, { put: [changed] });
    return { ok: true as const, store: saved, product: changed, before: product };
  });
  return result ?? { ok: false, reason: "none" };
}

export type CallResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | "free" | "recurring" | "options" | "delivery" | "course" | "pwyw" | "bundle" | "lengths_package" | "lengths_price" };

/**
 * Makes a product a paid call, changes when it can be booked, or turns it
 * back into an ordinary product.
 *
 * A product can become a call only when nothing else is attached to it: no
 * file, no link, no price options and no schedule of payments. Those would
 * all be things the buyer is promised and never sent.
 */
export async function setProductCall(
  email: string,
  id: string,
  setup: CallSetup | null,
): Promise<CallResult> {
  return onProduct<"free" | "recurring" | "options" | "delivery" | "course" | "pwyw" | "bundle" | "lengths_package" | "lengths_price">(
    email,
    id,
    (product) => {
      // Several lengths (lib/call-lengths.ts), read again on the record as it is now, under its write: never with a package,
      // whose sessions are free once bought, and only while the first is still at the product's price.
      if (setup?.lengths?.length) {
        if (product.callPackage) return { ok: false, reason: "lengths_package" };
        if (setup.lengths[0].cents !== product.priceCents) return { ok: false, reason: "lengths_price" };
      }
      if (setup) {
        if (isFree(product)) return { ok: false, reason: "free" };
        // A bundle hands over its products; a time in a calendar is not one.
        if (isBundle(product)) return { ok: false, reason: "bundle" };
        if (product.recurring) return { ok: false, reason: "recurring" };
        if (product.options.length > 0) return { ok: false, reason: "options" };
        if (product.file || product.link || product.shipping) return { ok: false, reason: "delivery" };
        if (product.course || product.podcast) return { ok: false, reason: "course" };
        if (product.pwyw) return { ok: false, reason: "pwyw" };
      }
      return { ...product, call: setup };
    },
    (store) => ({ callsId: store.callsId ?? (setup ? newListId() : null) }),
  );
}

export type CourseResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | "free" | "options" | "delivery" | "call" | "not_empty" | "bundle" };

/**
 * Makes a product a course, or turns an empty course back into an ordinary
 * product.
 *
 * Like a call, a course can only be made from a product with nothing else
 * attached, because it delivers its own lessons. It can only be turned back
 * once its lessons are gone, so a course full of work is never lost to one
 * press; the course record itself is the caller's to create and drop.
 */
export async function setProductCourse(
  email: string,
  id: string,
  course: CourseRef | null,
): Promise<CourseResult> {
  return onProduct<"free" | "options" | "delivery" | "call" | "not_empty" | "bundle">(email, id, (product) => {
    if (course) {
      if (isFree(product)) return { ok: false, reason: "free" };
      if (isBundle(product)) return { ok: false, reason: "bundle" };
      if (product.options.length > 0) return { ok: false, reason: "options" };
      if (product.file || product.link) return { ok: false, reason: "delivery" };
      if (product.call) return { ok: false, reason: "call" };
      if (product.podcast) return { ok: false, reason: "call" };
      // A physical product delivers what is shipped (lib/shipping.ts).
      if (product.shipping) return { ok: false, reason: "delivery" };
    } else if (product.course && product.course.lessons > 0) {
      return { ok: false, reason: "not_empty" };
    }
    return { ...product, course };
  });
}

export type PodcastResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | "free" | "options" | "delivery" | "call" | "course" | "not_empty" | "bundle" };

/**
 * Makes a product a private podcast, or turns an empty one back into an
 * ordinary product. The same rules as a course: it delivers its own
 * episodes, so nothing else may be attached, and one with episodes is never
 * turned back by one press. A podcast may be sold once or as a membership.
 */
export async function setProductPodcast(email: string, id: string, podcast: PodcastRef | null): Promise<PodcastResult> {
  return onProduct<"free" | "options" | "delivery" | "call" | "course" | "not_empty" | "bundle">(email, id, (product) => {
    if (podcast) {
      if (isFree(product)) return { ok: false, reason: "free" };
      if (isBundle(product)) return { ok: false, reason: "bundle" };
      if (product.options.length > 0) return { ok: false, reason: "options" };
      if (product.file || product.link) return { ok: false, reason: "delivery" };
      if (product.call) return { ok: false, reason: "call" };
      if (product.course) return { ok: false, reason: "course" };
      if (product.shipping) return { ok: false, reason: "delivery" };
    } else if (product.podcast && product.podcast.episodes > 0) {
      return { ok: false, reason: "not_empty" };
    }
    return { ...product, podcast };
  });
}

/** Keeps the episode count a product carries in step with its podcast. */
export async function setPodcastEpisodes(email: string, id: string, episodes: number): Promise<void> {
  const store = await storeForEmail(email);
  if (!store) return;
  const current = await readListing(store, id);
  if (!current?.podcast || current.podcast.episodes === episodes) return;
  await onProduct<never>(email, id, (product) =>
    product.podcast ? { ...product, podcast: { id: product.podcast.id, episodes } } : product,
  );
}

/**
 * Offers a weekly call as a package of sessions too, or stops offering it
 * (null). Only a call booked in weekly hours: dated live sessions are bought
 * one date at a time.
 */
export async function setCallPackage(email: string, id: string, pkg: CallPackage | null): Promise<{ ok: true; store: Store; product: Product } | { ok: false; reason: "none" | "unknown" | "call" | "lengths" }> {
  return onProduct<"call" | "lengths">(email, id, (product) => {
    if (pkg && product.call?.kind !== "weekly") return { ok: false, reason: "call" };
    // A package's sessions are free once bought, so a call with several lengths (lib/call-lengths.ts) has none: a long one would be had at a short one's price.
    if (pkg && product.call?.lengths?.length) return { ok: false, reason: "lengths" };
    return { ...product, callPackage: pkg };
  });
}

/** Keeps the lesson count a product carries in step with its course. */
export async function setCourseLessons(email: string, id: string, lessons: number): Promise<void> {
  const store = await storeForEmail(email);
  if (!store) return;
  const current = await readListing(store, id);
  if (!current?.course || current.course.lessons === lessons) return;
  await onProduct<never>(email, id, (product) =>
    product.course ? { ...product, course: { id: product.course.id, lessons } } : product,
  );
}

/**
 * Gives the store its community, or switches it on or off. The id is made
 * once and kept, so switching off and on again finds every post where it was.
 */
export async function setCommunity(email: string, on: boolean): Promise<Store | null> {
  return patchStore(email, (store) => ({
    community: { id: store.community?.id ?? crypto.randomUUID().replace(/-/g, ""), on },
  }));
}

/** Saves how the creator's emails are signed. */
export async function setMailSettings(email: string, mail: MailSettings): Promise<Store | null> {
  return patchStore(email, (store) => ({ mail, listId: store.listId ?? newListId() }));
}

/** Records the store's own domain, or takes it off (null). */
export async function setDomain(email: string, domain: StoreDomain | null): Promise<Store | null> {
  return patchStore(email, () => ({ domain }));
}

/** Gives a store its list, the first time something needs one. */
export async function ensureListId(email: string): Promise<Store | null> {
  const store = await storeForEmail(email);
  if (!store || store.listId) return store;
  return patchStore(email, (current) => (current.listId ? null : { listId: newListId() }));
}

export type ExtrasResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | "kind" | "target" | "price" | "plan_price" | "sold_with" | "twice" | "full" | "slot" };

/**
 * Sets or clears a product's limited quantity and its order bump.
 *
 * Both apply to one-off paid products only. The product offered in the box
 * must be another one-off of the same store with one price and one delivery,
 * and it can never cost more that way than on its own.
 */
/** Whether a product is also sold inside a bundle, in a checkout box or as an offer after paying. */
async function soldWithOthers(store: Store, id: string): Promise<boolean> {
  const others = (await readListings(store)).filter((p) => p.id !== id);
  if (others.some((p) => (p.bundle ?? []).includes(id) || bumpTargets(p).includes(id))) return true;
  const withFunnel = await readProducts(store, idsOfKind(store, "funnel").filter((other) => other !== id));
  return withFunnel.some((p) => (p.funnel?.steps ?? []).some((step) => step.productId === id));
}

export async function setProductExtras(
  email: string,
  id: string,
  /**
   * `bump` sets the box at `slot` (0 for the first; one past the last adds a
   * box), or takes it away when null, moving the ones after it up.
   */
  change: { stock?: number | null; bump?: Bump | null; slot?: number; plan?: Plan | null },
): Promise<ExtrasResult> {
  return onProduct<"kind" | "target" | "price" | "plan_price" | "sold_with" | "twice" | "full" | "slot">(
    email,
    id,
    async (product, store) => {
      const next: Product = { ...product };
      if (change.stock !== undefined) {
        if (change.stock !== null && !isOneOff(product)) return { ok: false, reason: "kind" };
        // Only a checkout of its own counts a sale against the number: a
        // product also sold inside a bundle, in a checkout box or as an offer
        // after paying would be sold past it.
        if (change.stock !== null && product.stock === null && (await soldWithOthers(store, product.id))) {
          return { ok: false, reason: "sold_with" };
        }
        next.stock = change.stock;
      }
      if (change.bump !== undefined) {
        const slot = change.slot ?? 0;
        if (!Number.isInteger(slot) || slot < 0 || slot > product.bumps.length) return { ok: false, reason: "slot" };
        if (change.bump !== null) {
          // The amount a buyer chooses has to be the checkout's only line.
          if (!isOneOff(product) || product.pwyw) return { ok: false, reason: "kind" };
          if (slot >= MAX_BUMPS) return { ok: false, reason: "full" };
          const target = await readListing(store, change.bump.productId);
          if (!target || target.id === product.id || !canBeBumped(target)) return { ok: false, reason: "target" };
          // One product, one box: the same thing offered twice is one offer.
          if (product.bumps.some((other, at) => at !== slot && other.productId === target.id)) return { ok: false, reason: "twice" };
          if (change.bump.priceCents > target.priceCents) return { ok: false, reason: "price" };
          // Stripe's smallest charge in the store's currency (lib/money.ts).
          if (change.bump.priceCents < currencyRule(store.currency).minCharge) return { ok: false, reason: "price" };
          const bumps = [...product.bumps];
          bumps[slot] = change.bump;
          next.bumps = bumps;
        } else {
          if (slot >= product.bumps.length) return { ok: false, reason: "slot" };
          next.bumps = product.bumps.filter((_, at) => at !== slot);
        }
      }
      if (change.plan !== undefined) {
        let plan = change.plan;
        if (plan !== null) {
          // A physical product is paid in full (lib/shipping.ts).
          if (!isOneOff(product) || product.pwyw || product.shipping) return { ok: false, reason: "kind" };
          if (product.options.length > 0) {
            // Several prices: a payment for each, kept only for prices the
            // product has, every one the buyer can pick covered in full.
            const ids = new Set(product.options.map((option) => option.id));
            const options = Object.fromEntries(Object.entries(plan.options ?? {}).filter(([id]) => ids.has(id)));
            const each = Object.values(options);
            if (each.length === 0) return { ok: false, reason: "plan_price" };
            plan = { payments: plan.payments, interval: plan.interval, amountCents: Math.min(...each), options };
            if (uncoveredOption(product, plan)) return { ok: false, reason: "plan_price" };
          } else {
            plan = { payments: plan.payments, interval: plan.interval, amountCents: plan.amountCents };
            if (plan.payments * plan.amountCents < product.priceCents) return { ok: false, reason: "price" };
          }
          // Stripe's smallest charge in the store's currency (lib/money.ts); amountCents is the smallest payment.
          if (plan.amountCents < currencyRule(store.currency).minCharge) return { ok: false, reason: "price" };
        }
        next.plan = plan;
      }
      return next;
    },
    (store) => ({ statsId: store.statsId ?? newListId() }),
  );
}

/** Switches sales tax on or off for the store's checkouts. */
export async function setTax(
  email: string,
  tax: TaxSetting,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, () => ({ tax: parseTax(tax) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/**
 * Switches the abandoned-checkout reminder on or off. The store is also given
 * the id its reminders are counted and stopped under, if it has none yet.
 */
export async function setRecovery(
  email: string,
  recovery: RecoverySetting,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, (store) => ({ recovery: parseRecovery(recovery), statsId: store.statsId ?? newListId() }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Saves the offer made to members on their way out, or takes it away. */
export async function setSaveOffer(
  email: string,
  save: SaveOffer,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, () => ({ save: parseSaveOffer(save) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Saves how many months members may pause for, 0 to switch it off. */
export async function setPauseMonths(email: string, months: unknown): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" | "months" }> {
  const pause = parsePauseMonths(months);
  if (pause !== months) return { ok: false, reason: "months" };
  const next = await patchStore(email, () => ({ pause }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/**
 * Saves the question asked before a member cancels (lib/leave-rules.ts). A
 * reason of the creator's own keeps its id while its words stay, so its
 * answers keep adding up; a new one is given an id here.
 */
export async function setLeaving(email: string, raw: unknown): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" | "leaving" }> {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const own = (Array.isArray(value.own) ? value.own : []).map((item) => {
    const o = item && typeof item === "object" ? (item as { id?: unknown; text?: unknown }) : {};
    return { id: typeof o.id === "string" && o.id ? o.id : `own_${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`, text: o.text };
  });
  const leaving = parseLeave({ ...value, own });
  if (own.filter((o) => typeof o.text === "string" && o.text.trim()).length !== leaving.own.length) return { ok: false, reason: "leaving" };
  const next = await patchStore(email, () => ({ leaving }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Whether each sale and each alert is posted to the store's chat (lib/chat-summary.ts). */
export async function setChatSales(email: string, on: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ chatSales: on === true }));
}

/** The sites that may open the store's checkout with the checkout script (lib/embed-sites.ts): the whole list, as typed. */
export async function setEmbedSites(email: string, value: unknown): Promise<{ ok: true; store: Store } | { ok: false; reason: "invalid" | "too_many" | "none"; line?: string }> {
  const read = readEmbedSites(value);
  if (!read.ok) return read;
  const next = await patchStore(email, () => ({ embedSites: read.sites }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** How long after a visit a sale is still credited to it (lib/attribution-rules.ts). */
export async function setAttributionDays(email: string, days: unknown): Promise<{ ok: true; store: Store } | { ok: false; reason: "invalid" | "none" }> {
  const n = typeof days === "string" ? Number(days) : days;
  if (!(ATTRIBUTION_DAYS as readonly unknown[]).includes(n)) return { ok: false, reason: "invalid" };
  const next = await patchStore(email, () => ({ attributionDays: parseAttributionDays(n) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Which ad platforms get conversions from the server (lib/ad-events.ts): set when a token is saved or removed. */
export async function setAdsServer(email: string, platforms: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ adsServer: parseAdsServer(platforms) }));
}

/** Whether the weekly email opens with a summary written by AI (lib/numbers-ask.ts). */
export async function setWeeklyAi(email: string, on: unknown): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, () => ({ weeklyAi: on === true }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Saves the come-back email to members who stopped coming (lib/member-health-rules.ts). */
export async function setNudge(email: string, raw: unknown): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" | "address" }> {
  const nudge = parseNudge(raw);
  const asked = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (asked.on === true && !nudge.on) return { ok: false, reason: "address" };
  const next = await patchStore(email, () => ({ nudge }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Saves the one email offering monthly members the yearly price (lib/yearly-ask.ts). */
export async function setYearlyAsk(email: string, raw: unknown): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" | "address" }> {
  const yearlyAsk = parseYearlyAsk(raw);
  const asked = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (asked.on === true && !yearlyAsk.on) return { ok: false, reason: "address" };
  const next = await patchStore(email, () => ({ yearlyAsk }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Saves what members are told when a payment fails (lib/dunning-rules.ts). */
export async function setDunning(email: string, raw: unknown): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" | "dunning" }> {
  const dunning = parseDunning(raw);
  const asked = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (dunning.reminders !== asked.reminders || dunning.cardNotice !== asked.cardNotice) return { ok: false, reason: "dunning" };
  const next = await patchStore(email, () => ({ dunning }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

export async function setWinBack(
  email: string,
  winback: WinBack,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, () => ({ winback: parseWinBack(winback) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

export async function setWelcomeOffer(
  email: string,
  offer: WelcomeOffer,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, () => ({ welcomeOffer: parseWelcomeOffer(offer) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

export async function setInboxSetting(
  email: string,
  inbox: InboxSetting,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, () => ({ inbox: parseInboxSetting(inbox) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

export async function setStoreSale(
  email: string,
  sale: StoreSale,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, (current) => {
    const parsed = parseSale(sale);
    return { sale: parsed, pastSales: withPastSale(current.pastSales ?? [], current.sale, parsed, Math.floor(Date.now() / 1000)) };
  });
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Sets the memberships members can switch between; fewer than two is none. */
export async function setStoreTiers(email: string, tiers: string[]): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, () => ({ tiers: parseTiers(tiers) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

export type FunnelResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | FunnelProblem };

/**
 * Sets or clears what is offered after paying for one product. Checked
 * against the store as it is now (lib/funnel.ts), so a funnel that could not
 * be shown to a buyer is refused here rather than skipped on the thanks page.
 */
export async function setProductFunnel(email: string, id: string, funnel: Funnel | null): Promise<FunnelResult> {
  return onProduct<FunnelProblem>(email, id, async (product, store) => {
    if (funnel) {
      // A bundle holding a course is not offered in one click (lib/bundles.ts).
      const offered = await offerableAfterPaying(store, await readListings(store, funnel.steps.map((step) => step.productId)));
      const problem = funnelProblem(funnel, offered, product);
      if (problem) return { ok: false, reason: problem };
      // Each offer is a charge of its own: not under Stripe's smallest one in
      // the store's currency (lib/money.ts).
      const least = currencyRule(store.currency).minCharge;
      if (funnel.steps.some((step) => step.priceCents < least)) return { ok: false, reason: "price" };
    }
    return { ...product, funnel };
  });
}

/**
 * How many products have a price. Everything else that carries an amount —
 * a price option, an offer at checkout or after paying, a plan's payment, a
 * suggested price — is only live on a product with a price, so a free
 * product counts for nothing. Answered from the store record's index
 * (lib/catalog.ts): a product with price options is always a paid one.
 */
export function pricedProducts(store: Store): number {
  return store.catalog.items.filter((item) => (item.kind & KIND.paid) !== 0 || item.options.length > 0).length;
}

/** One amount that would fall below the smallest charge of the currency a store is moving to. */
export type CurrencyShortfall = {
  productId: string;
  /** The product it is on. */
  title: string;
  /**
   * What it is: the product's price, the floor of a price the buyer chooses,
   * a price option, the offer at checkout, an offer after paying, one
   * payment of a payment plan, or the deposit on an in-person booking
   * (lib/call-deposit.ts).
   */
  what: "price" | "minimum" | "option" | "bump" | "offer" | "plan" | "deposit" | "length";
  /** The option's label, or the title of the product offered; "" otherwise. */
  label: string;
  /** In the smallest unit, the same number in either currency. */
  amount: number;
};

/**
 * Every amount of these products that would be a charge Stripe refuses in
 * `currency` (lib/money.ts, minCharge): a price, a pay-what-you-want floor
 * (the product's price), a price option, the offer at checkout, each offer
 * after paying and each payment of a plan. Free products and free options
 * are not charges and are left out.
 */
export function chargesBelow(products: Product[], currency: Currency): CurrencyShortfall[] {
  const least = currencyRule(currency).minCharge;
  const titles = new Map(products.map((p) => [p.id, p.title]));
  const out: CurrencyShortfall[] = [];
  for (const p of products) {
    const on = (what: CurrencyShortfall["what"], label: string, amount: number) =>
      out.push({ productId: p.id, title: p.title, what, label, amount });
    if (p.priceCents > 0 && p.priceCents < least) on(p.pwyw ? "minimum" : "price", "", p.priceCents);
    for (const option of p.options) if (option.priceCents > 0 && option.priceCents < least) on("option", option.label, option.priceCents);
    for (const bump of p.bumps) if (bump.priceCents < least) on("bump", titles.get(bump.productId) ?? "", bump.priceCents);
    for (const step of p.funnel?.steps ?? []) if (step.priceCents < least) on("offer", titles.get(step.productId) ?? "", step.priceCents);
    if (p.plan && p.plan.amountCents < least) on("plan", "", p.plan.amountCents);
    // A deposit below the smallest charge would quietly become the whole price (lib/call-deposit.ts, chargeNow): said instead.
    if (p.call?.deposit && p.call.deposit < least) on("deposit", "", p.call.deposit);
    // A call's other lengths (lib/call-lengths.ts) are charged at their own prices: each one below the smallest charge is said too.
    for (const length of (p.call?.lengths ?? []).slice(1)) if (length.cents < least) on("length", `${length.minutes} minutes`, length.cents);
  }
  return out;
}

export type CurrencyResult =
  | { ok: true; store: Store }
  | { ok: false; reason: "none" | "decimals" }
  | { ok: false; reason: "minimum"; items: CurrencyShortfall[] };

/**
 * Changes what the store charges in.
 *
 * Every saved amount keeps its number: a product at 49 is 49 in the new
 * currency, which the studio says in plain words before the creator agrees.
 * That only holds between two currencies written with the same decimals. A
 * price of 49.99 has no meaning in yen, and 4999 yen read back as dollars
 * would be a price a hundred times what was meant, so a store with prices
 * cannot move between the yen and a two-decimal currency: it is refused
 * rather than rounded behind the creator's back. A free product may still
 * hold an offer, a plan or a suggested price from when it had one; on such a
 * move they are dropped, so none comes back to life in the wrong scale — each
 * such product read and written in its own record, under the store's lock.
 * Between two currencies with the same decimals, a move is refused while any
 * amount would fall below the new currency's smallest charge (chargesBelow):
 * 5.00 is a fine price in dollars and a charge Stripe refuses in kronor, and
 * the creator fixes those first rather than meeting it at a buyer's checkout.
 * The route asks the rest — the creator's agreement, and that no membership
 * or plan is running on Stripe in the old currency (app/api/store/currency).
 */
export async function setCurrency(email: string, currency: Currency): Promise<CurrencyResult> {
  const result = await withStore<CurrencyResult>(email, async (store, save) => {
    if (store.currency === currency) return { ok: true, store };
    const rescaled = currencyRule(store.currency).decimals !== currencyRule(currency).decimals;
    if (rescaled && pricedProducts(store) > 0) return { ok: false, reason: "decimals" };
    if (!rescaled && pricedProducts(store) > 0) {
      const items = chargesBelow(await readProducts(store), currency);
      if (items.length) return { ok: false, reason: "minimum", items };
    }
    const put = rescaled
      ? (await readProducts(store))
          .filter((p) => p.bumps.length || p.plan || p.funnel || p.pwyw)
          .map((p) => ({ ...p, bumps: [], plan: null, funnel: null, pwyw: null }))
      : [];
    return { ok: true, store: await save({ ...store, currency }, { put }) };
  });
  return result ?? { ok: false, reason: "none" };
}

/**
 * Saves the affiliate programme's terms. The store is also given the id its
 * affiliates, clicks and sales are kept under, if it has none yet.
 */
export async function setAffiliateSetting(
  email: string,
  setting: AffiliateSetting,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, (store) => {
    const known = new Set(productIds(store));
    const parsed = parseAffiliateSetting(setting);
    const rates = Object.fromEntries(Object.entries(parsed.rates).filter(([id]) => known.has(id)));
    return { affiliates: { ...parsed, rates }, statsId: store.statsId ?? newListId() };
  });
  // Whether this creator's program is listed in the affiliate directory, kept
  // in step on the save rather than reconstructed by walking every store
  // (lib/directory-index.ts); the save also drops the directory's kept rows.
  if (next) {
    await rememberListing(next).catch((error) => console.error("remembering a directory listing failed", error));
  }
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Saves the creator's ad pixels. */
export async function setPixels(
  email: string,
  pixels: Pixels,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, () => ({ pixels: parsePixels(pixels) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Keeps the store's copy of which buyers go to its email platform (lib/email-sync.ts). */
export async function setEmailSyncRef(email: string, ref: EmailSyncRef | null): Promise<Store | null> {
  return patchStore(email, (store) => {
    const emailSync = parseEmailSyncRef(ref);
    return JSON.stringify(emailSync) === JSON.stringify(store.emailSync) ? null : { emailSync };
  });
}

/** Whether the store shows its latest real purchases (lib/recent-sales.ts). */
export async function setRecentSales(email: string, on: boolean): Promise<Store | null> {
  return patchStore(email, (store) => (store.recentSales === on ? null : { recentSales: on }));
}

/** Keeps the store's note of whether a device wants each sale (lib/phone-alerts.ts). */
export async function setAskWhyNot(email: string, on: boolean): Promise<Store | null> {
  return patchStore(email, (store) => (store.askWhyNot === on ? null : { askWhyNot: on }));
}

export async function setPhoneSales(email: string, on: boolean): Promise<Store | null> {
  return patchStore(email, (store) => (store.phoneSales === on ? null : { phoneSales: on }));
}

/**
 * Gives a store written before visits were counted the id they are counted
 * under. Called from the owner's own studio, so it never races a visitor.
 */
export async function ensureStatsId(email: string): Promise<Store | null> {
  const store = await storeForEmail(email);
  if (!store) return null;
  if (store.statsId) return store;
  return patchStore(email, (current) => (current.statsId ? null : { statsId: newListId() }));
}

/** Changes the theme and the colour of the public page. */
export async function updateLook(
  email: string,
  look: StoreLook,
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, () => ({ look: parseLook(look) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/**
 * Points the store at a photo, or at none, and says which one it replaced so
 * the caller can delete the old picture once nothing refers to it.
 */
export async function setPhotoId(
  email: string,
  photoId: string | null,
): Promise<{ ok: true; store: Store; was: string | null } | { ok: false; reason: "none" }> {
  const result = await withStore(email, async (store, save) => {
    const next = await save({ ...store, photoId });
    return { ok: true as const, store: next, was: store.photoId };
  });
  return result ?? { ok: false, reason: "none" };
}

export type ProductResult =
  | { ok: true; store: Store; product: Product }
  | {
      ok: false;
      reason: "none" | "title" | "price" | "free" | "too_many" | "unknown" | "call" | "course" | "pwyw" | "bundle" | "shipped";
      limit?: number;
      /** When the choose-your-price setting was refused: why. */
      pwyw?: PwywProblem;
    };

/** An id nothing else in this store is using. */
function freshId(store: Store): string {
  // Products and links are separate lists, but an id is read from a form and
  // an id shared between the two is an accident waiting to be found by
  // somebody else. Products, their options and links are all counted.
  const taken = usedIds(store);
  for (const link of store.links) taken.add(link.id);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    if (!taken.has(id)) return id;
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Checks a title and a typed price, and returns the price in the smallest
 * unit of the store's currency.
 */
function readFields(
  rawTitle: string,
  rawPrice: string,
  currency: Currency,
): { title: string; priceCents: number } | "title" | "price" {
  const title = rawTitle.trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) return "title";
  const priceCents = readMoney(rawPrice, currency);
  if (priceCents === null) return "price";
  // Zero is allowed and means free. Anything between zero and the minimum is
  // not: Stripe will not charge it, and a buyer would meet a card form that
  // cannot work.
  if (priceCents === 0) return { title, priceCents };
  if (!priceInRange(priceCents, currency)) return "price";
  return { title, priceCents };
}

/**
 * The suggested price of a product whose buyer chooses what to pay, as
 * typed, read in the store's currency. Null when nothing was sent.
 */
function readSuggested(raw: string | null, currency: Currency): number | null | "bad" {
  if (raw === null) return null;
  const amount = readMoney(raw, currency);
  return amount === null ? "bad" : amount;
}

/** Adds something to the store, at the end of the list. */
export async function addProduct(
  email: string,
  rawTitle: string,
  rawSummary: string,
  rawPrice: string,
  recurring: Recurring | null = null,
  /** The suggested price as typed, when the buyer chooses what to pay. */
  rawSuggested: string | null = null,
  /** AI setup can create a draft atomically, with no briefly public intermediate product. */
  asDraft = false,
): Promise<ProductResult> {
  const result = await withStore<ProductResult>(email, async (store, save) => {
    // Read in the store's own currency, as the store is under the lock:
    // "27.50" is cents for dollars, and not a price at all for yen.
    const fields = readFields(rawTitle, rawPrice, store.currency);
    if (typeof fields === "string") return { ok: false, reason: fields };
    // Something given away is given once. A membership that charges nothing
    // would be a subscription to nothing, so the two cannot be combined.
    if (fields.priceCents === 0 && recurring) return { ok: false, reason: "free" };
    const pwywCents = readSuggested(rawSuggested, store.currency);
    if (pwywCents === "bad") return { ok: false, reason: "pwyw", pwyw: "suggested" };

    if (store.catalog.items.length >= MAX_PRODUCTS) {
      return { ok: false, reason: "too_many", limit: MAX_PRODUCTS };
    }

    const product: Product = {
      id: freshId(store),
      title: fields.title,
      summary: rawSummary.trim().slice(0, MAX_SUMMARY_LENGTH),
      priceCents: fields.priceCents,
      createdAt: new Date().toISOString(),
      file: null,
      link: null,
      recurring,
      options: [],
      call: null,
      stock: null,
      bumps: [],
      funnel: null,
      plan: null,
      course: null,
      image: null,
      display: "button",
      fields: [],
      pwyw: null,
      about: false,
      keys: null,
      stamp: false,
      preview: 0,
      page: false,
      bundle: null,
      hidden: asDraft,
    };
    if (pwywCents !== null) {
      const problem = pwywProblem(product, pwywCents, store.currency);
      if (problem) return { ok: false, reason: "pwyw", pwyw: problem };
      product.pwyw = { suggestedCents: pwywCents };
    }

    const next = await save(
      {
        ...store,
        // Stores opened before free products existed get their list the first
        // time they give something away, in the creator's own write, so no
        // visitor's request ever has to write the store record.
        listId: store.listId ?? (fields.priceCents === 0 ? newListId() : null),
        ...(!asDraft && store.activationTracked && !store.firstOfferPublishedAt && !store.catalog.items.some(item => (item.kind & KIND.hidden) === 0) ? { firstOfferPublishedAt: product.createdAt } : {}),
      },
      { put: [product] },
    );
    return { ok: true, store: next, product };
  });
  return result ?? { ok: false, reason: "none" };
}

/** Changes something already on the store, keeping its place in the list. */
export async function editProduct(
  email: string,
  id: string,
  rawTitle: string,
  rawSummary: string,
  rawPrice: string,
  recurring: Recurring | null = null,
  rawSuggested: string | null = null,
): Promise<ProductResult> {
  let pwywWhy: PwywProblem | undefined;
  let refusal: "title" | "price" | null = null;
  // Written only when the product is changed, so the store's own list id is
  // what a free product gets (below) whatever the price turned out to be.
  let freeNow = false;
  const result = await onProduct<"free" | "call" | "course" | "pwyw" | "title" | "price" | "bundle" | "shipped">(
    email,
    id,
    (product, store) => {
      // Read in the store's own currency, as the store is under the lock.
      const fields = readFields(rawTitle, rawPrice, store.currency);
      if (typeof fields === "string") {
        refusal = fields;
        return { ok: false, reason: fields };
      }
      if (fields.priceCents === 0 && recurring) return { ok: false, reason: "free" };
      const pwywCents = readSuggested(rawSuggested, store.currency);
      if (pwywCents === "bad") {
        pwywWhy = "suggested";
        return { ok: false, reason: "pwyw" };
      }
      freeNow = fields.priceCents === 0;
      // A product with several prices cannot become free: the buyer would be
      // shown prices for a thing the page says costs nothing. Take the options
      // off first, and the choice is the creator's rather than ours.
      if (fields.priceCents === 0 && product.options.length > 0) return { ok: false, reason: "free" };
      // A call is one paid booking. It cannot be given away or charged monthly.
      if (product.call && (fields.priceCents === 0 || recurring)) return { ok: false, reason: "call" };
      // A course is sold. Giving lessons away for an email address is not built.
      if ((product.course || product.podcast) && fields.priceCents === 0) return { ok: false, reason: "course" };
      // A bundle is one sale of several things at one price: never free, never
      // charged again and again, never priced by its buyer (lib/bundle-rules.ts).
      if (isBundle(product) && (fields.priceCents === 0 || recurring || pwywCents !== null)) return { ok: false, reason: "bundle" };
      // A physical product is sold once, at a price (lib/shipping.ts): shipped by the creator.
      if (product.shipping && (fields.priceCents === 0 || recurring || pwywCents !== null)) return { ok: false, reason: "shipped" };
      const next: Product = {
        ...product,
        title: fields.title,
        summary: rawSummary.trim().slice(0, MAX_SUMMARY_LENGTH),
        priceCents: fields.priceCents,
        recurring,
        pwyw: null,
      };
      if (pwywCents !== null) {
        const problem = pwywProblem(next, pwywCents, store.currency);
        if (problem) {
          pwywWhy = problem;
          return { ok: false, reason: "pwyw" };
        }
        next.pwyw = { suggestedCents: pwywCents };
      }
      return next;
    },
    (store) => ({ listId: store.listId ?? (freeNow ? newListId() : null) }),
  );
  if (!result.ok) {
    if (result.reason === "pwyw") return { ok: false, reason: "pwyw", pwyw: pwywWhy };
    if (refusal) return { ok: false, reason: refusal };
    return result;
  }
  return { ok: true, store: result.store, product: result.product };
}

/** Takes something off the store. Returns the product as it was, for its files. */
export async function removeProduct(
  email: string,
  id: string,
): Promise<{ ok: true; store: Store; product: Product } | { ok: false; reason: "none" | "unknown" }> {
  const result = await withStore(email, async (store, save) => {
    const product = await readProduct(store, id);
    if (!product) return { ok: false as const, reason: "unknown" as const };
    // A bundle that held it holds it no more, in the same write, so no bundle
    // goes on promising a product the store no longer has. Whoever bought the
    // bundle before kept its list on their order (lib/bundle-rules.ts).
    const holders = (await readProducts(store, idsOfKind(store, "bundle"))).filter((p) => p.bundle?.includes(id));
    const put = holders.map((p) => {
      const left = (p.bundle ?? []).filter((item) => item !== id);
      return { ...p, bundle: left.length ? left : null };
    });
    // A section that started at it starts at the next product now, and a line
    // of news that led to it leads nowhere (lib/store-sections.ts).
    const tidied: Store = {
      ...store,
      sections: sectionsWithout(store.sections, productIds(store), id),
      // Taken out of every collection it was in; one left empty goes (lib/store-collections.ts).
      collections: collectionsWithout(store.collections ?? [], id),
      announcement: store.announcement?.product === id ? { ...store.announcement, product: null } : store.announcement,
      // A page of the store's own whose buttons led to it leads to the store now (lib/site-page-rules.ts).
      sitePages: store.sitePages.map((page) => (page.target === id ? { ...page, target: "" } : page)),
    };
    const next = await save(tidied, { drop: [id], put });
    return { ok: true as const, store: next, product };
  });
  return result ?? { ok: false, reason: "none" };
}

/**
 * Moves something one place up or down, or straight to the top or the end.
 *
 * The order is the creator's, not ours: the first thing on the page is the
 * thing they want read first, so nothing here sorts by price or by date.
 */
export async function moveProduct(
  email: string,
  id: string,
  direction: "up" | "down" | "top" | "bottom",
): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" | "unknown" }> {
  const result = await withStore(email, async (store, save) => {
    const items = store.catalog.items;
    const at = items.findIndex((item) => item.id === id);
    if (at < 0) return { ok: false as const, reason: "unknown" as const };

    // With a long list, one place at a time is a lot of presses to reach the
    // top, so the two ends are one press each.
    const to =
      direction === "top" ? 0 : direction === "bottom" ? items.length - 1 : direction === "up" ? at - 1 : at + 1;
    if (to < 0 || to >= items.length || to === at) return { ok: true as const, store };

    const moved = [...items];
    const [moving] = moved.splice(at, 1);
    moved.splice(to, 0, moving);
    const next = await save({ ...store, catalog: { ...store.catalog, items: moved } });
    return { ok: true as const, store: next };
  });
  return result ?? { ok: false, reason: "none" };
}

export type FileResult =
  | { ok: true; store: Store; removed: ProductFile | null }
  | { ok: false; reason: "none" | "unknown" | "invalid" | "call" | "course" | "bundle" | "shipped" };

/** What is handed over when something is paid for. One or the other. */
export type Delivery = { file: ProductFile | null; link: string | null };

/**
 * Whether this store owns that id, asked before any upload is signed.
 *
 * Option ids are unique across the whole store, so one id is enough to find
 * either a product or one of its options, and the store record's index
 * answers without reading either.
 */
export function ownsDeliveryId(store: Store, id: string): boolean {
  return productIdFor(store, id) !== null;
}

/**
 * Rewrites the delivery an id names on its product: the product's own, or
 * one of its options'. Returns the product as changed and what was there
 * before, so the caller can release the storage the old file used once the
 * record that replaced it is safely written.
 */
function rewriteDelivery(
  product: Product,
  id: string,
  change: (current: Delivery) => Delivery,
): { product: Product; previous: Delivery } | null {
  if (product.id === id) {
    const previous: Delivery = { file: product.file, link: product.link };
    return { product: { ...product, ...change(previous) }, previous };
  }
  const at = product.options.findIndex((option) => option.id === id);
  if (at < 0) return null;
  const option = product.options[at];
  const previous: Delivery = { file: option.file, link: option.link };
  const options = [...product.options];
  options[at] = { ...option, ...change(previous) };
  return { product: { ...product, options }, previous };
}

/** Changes the delivery an id names, under the lock, with the rules both setters share. */
async function changeDelivery(
  email: string,
  id: string,
  giving: boolean,
  change: (current: Delivery) => Delivery,
): Promise<{ ok: true; store: Store; previous: Delivery } | { ok: false; reason: "none" | "unknown" | "call" | "course" | "bundle" | "shipped" }> {
  const result = await withStore(email, async (store, save) => {
    const owner = productIdFor(store, id);
    const product = owner ? await readProduct(store, owner) : null;
    if (!product) return { ok: false as const, reason: "unknown" as const };
    // A call delivers a booking, a course its lessons and a bundle its
    // products, not a file or a link of their own.
    if (giving && product.id === id && product.call) return { ok: false as const, reason: "call" as const };
    if (giving && product.id === id && (product.course || product.podcast)) return { ok: false as const, reason: "course" as const };
    if (giving && product.id === id && isBundle(product)) return { ok: false as const, reason: "bundle" as const };
    // A physical product delivers what the creator ships (lib/shipping.ts).
    // Nor on one of its sizes or versions: each ships the same way.
    if (giving && product.shipping) return { ok: false as const, reason: "shipped" as const };
    const done = rewriteDelivery(product, id, change);
    if (!done) return { ok: false as const, reason: "unknown" as const };
    const next = await save(store, { put: [done.product] });
    return { ok: true as const, store: next, previous: done.previous };
  });
  return result ?? { ok: false, reason: "none" };
}

/**
 * Puts a file on a product or on one of its price options, or takes it off.
 *
 * The blob itself is written and deleted by the route, because that talks to
 * the file store over the network and this does not. What comes back is the
 * file that was displaced, so the caller can delete it once the record that
 * pointed at it is safely written. Deleting it first would risk a product
 * pointing at nothing if the write then failed.
 */
export async function setProductFile(
  email: string,
  id: string,
  file: ProductFile | null,
): Promise<FileResult> {
  // A file replaces a link. One thing is delivered, never two.
  const done = await changeDelivery(email, id, file !== null, (current) => ({
    file,
    link: file ? null : current.link,
  }));
  if (!done.ok) return done;
  return { ok: true, store: done.store, removed: done.previous.file };
}

/**
 * Points a product or option at a link instead of a file, or takes it away.
 *
 * Mirrors setProductFile, including the part that matters: setting one clears
 * the other. It returns the file that was displaced so the caller can release
 * the storage it used, once the record that pointed at it is safely written.
 */
export async function setProductLink(
  email: string,
  id: string,
  link: string | null,
): Promise<FileResult> {
  const done = await changeDelivery(email, id, link !== null, (current) => ({
    link,
    file: link ? null : current.file,
  }));
  if (!done.ok) return done;
  // Taking a link off displaces nothing; putting one on displaces the file.
  return { ok: true, store: done.store, removed: link ? done.previous.file : null };
}

/**
 * The file an id names, or null. Used before serving a download.
 *
 * Reaches an option's file as readily as a product's, so a creator can open
 * each price option and check that the right thing is behind it.
 */
export async function productFile(
  email: string,
  id: string,
): Promise<{ product: Listing; file: ProductFile } | null> {
  const store = await storeForEmail(email);
  if (!store) return null;
  const found = await readDelivery(store, id);
  if (!found) return null;
  const file = found.option ? found.option.file : found.product.file;
  return file ? { product: found.product, file } : null;
}

/** Every file a product holds, its options included. Read before removing it. */
export function filesOnProduct(product: Listing): ProductFile[] {
  const files = product.file ? [product.file] : [];
  for (const option of product.options) {
    if (option.file) files.push(option.file);
  }
  return files;
}

export type LinkResult =
  | { ok: true; store: Store; removed?: LinkImage | null }
  | {
      ok: false;
      reason: "none" | "title" | "too_many" | "unknown";
      limit?: number;
    };

/**
 * Adds a link to the page, at the end of the list.
 *
 * The address arrives already checked and normalised by readLink, because the
 * route that took it from the creator is the place that knows how to tell them
 * which way it was wrong. What is left to check here is the title, which is
 * the only thing a visitor reads before deciding to follow it.
 */
export async function addStoreLink(
  email: string,
  rawTitle: string,
  url: string,
  extras: Pick<StoreLink, "spotlight" | "from" | "until" | "play" | "header"> = {},
): Promise<LinkResult> {
  const title = rawTitle.trim().slice(0, MAX_LINK_TITLE_LENGTH);
  if (!title) return { ok: false, reason: "title" };

  const result = await withStore<LinkResult>(email, async (store, save) => {
    if (store.links.length >= MAX_STORE_LINKS) {
      return { ok: false, reason: "too_many", limit: MAX_STORE_LINKS };
    }
    const link: StoreLink = {
      id: freshId(store),
      title,
      url,
      addedAt: new Date().toISOString(),
      ...extras,
    };
    return { ok: true, store: await save({ ...store, links: [...store.links, link] }) };
  });
  return result ?? { ok: false, reason: "none" };
}

/** Changes a link already on the page, keeping its place in the list. */
export async function editStoreLink(
  email: string,
  id: string,
  rawTitle: string,
  url: string,
  extras: Pick<StoreLink, "spotlight" | "from" | "until" | "play" | "header"> = {},
): Promise<LinkResult> {
  const title = rawTitle.trim().slice(0, MAX_LINK_TITLE_LENGTH);
  if (!title) return { ok: false, reason: "title" };

  const result = await withStore<LinkResult>(email, async (store, save) => {
    const at = store.links.findIndex((link) => link.id === id);
    if (at < 0) return { ok: false, reason: "unknown" };
    const links = [...store.links];
    // Its picture stays through an edit; a link turned into a heading gives it up.
    const image = extras.header ? undefined : links[at].image;
    links[at] = { id: links[at].id, addedAt: links[at].addedAt, title, url, ...extras, ...(image ? { image } : {}) };
    return { ok: true, store: await save({ ...store, links }), removed: extras.header ? (store.links[at].image ?? null) : null };
  });
  return result ?? { ok: false, reason: "none" };
}

/** Takes a link off the page. Nothing else changes. */
export async function removeStoreLink(
  email: string,
  id: string,
): Promise<LinkResult> {
  const result = await withStore<LinkResult>(email, async (store, save) => {
    const going = store.links.find((link) => link.id === id);
    if (!going) return { ok: false, reason: "unknown" };
    // Its picture is returned for the caller to delete once this is written.
    return { ok: true, store: await save({ ...store, links: store.links.filter((link) => link.id !== id) }), removed: going.image ?? null };
  });
  return result ?? { ok: false, reason: "none" };
}

/**
 * Puts a picture on a link, or takes it off (null). What comes back is the
 * picture it displaced, for the caller to delete once this is written —
 * deleting it first would leave the page pointing at nothing if the write
 * then failed. A heading takes no picture.
 */
export async function setLinkImage(email: string, id: string, image: LinkImage | null): Promise<LinkResult> {
  const result = await withStore<LinkResult>(email, async (store, save) => {
    const at = store.links.findIndex((link) => link.id === id);
    if (at < 0 || store.links[at].header) return { ok: false, reason: "unknown" };
    const links = [...store.links];
    const { image: was, ...rest } = links[at];
    links[at] = image ? { ...rest, image } : rest;
    return { ok: true, store: await save({ ...store, links }), removed: was ?? null };
  });
  return result ?? { ok: false, reason: "none" };
}

/** Moves a link one place up or down, the way a product moves. */
export async function moveStoreLink(
  email: string,
  id: string,
  direction: "up" | "down",
): Promise<LinkResult> {
  const result = await withStore<LinkResult>(email, async (store, save) => {
    const at = store.links.findIndex((link) => link.id === id);
    if (at < 0) return { ok: false, reason: "unknown" };
    const to = direction === "up" ? at - 1 : at + 1;
    if (to < 0 || to >= store.links.length) return { ok: true, store };
    const links = [...store.links];
    [links[at], links[to]] = [links[to], links[at]];
    return { ok: true, store: await save({ ...store, links }) };
  });
  return result ?? { ok: false, reason: "none" };
}

export type OptionResult =
  | { ok: true; store: Store; removed: ProductFile[] }
  | {
      ok: false;
      reason: "none" | "label" | "price" | "free" | "too_many" | "store_too_many" | "unknown" | "call" | "course" | "pwyw" | "bundle" | "sku" | "sku_kind";
      limit?: number;
    };

/** Checks a label and a typed price for one option, in the store's currency. */
function readOption(
  rawLabel: string,
  rawPrice: string,
  currency: Currency,
): { label: string; priceCents: number } | "label" | "price" {
  const label = rawLabel.trim().slice(0, MAX_OPTION_LABEL_LENGTH);
  if (!label) return "label";
  const priceCents = readMoney(rawPrice, currency);
  if (priceCents === null) return "price";
  if (!priceInRange(priceCents, currency)) return "price";
  return { label, priceCents };
}

/** Adds a price option to a product, at the end of its list. */
export async function addOption(
  email: string,
  productId: string,
  rawLabel: string,
  rawPrice: string,
  more: { details?: unknown; best?: boolean; sku?: unknown } = {},
): Promise<OptionResult> {
  const result = await withStore<OptionResult>(email, async (store, save) => {
    const fields = readOption(rawLabel, rawPrice, store.currency);
    if (typeof fields === "string") return { ok: false, reason: fields };
    const product = await readProduct(store, productId);
    if (!product) return { ok: false, reason: "unknown" };
    // Several prices on something given away would put a price on it.
    if (isFree(product)) return { ok: false, reason: "free" };
    if (product.call) return { ok: false, reason: "call" };
    // A course or a private podcast may be sold at several prices (7 October
    // 2026): each option opens the same lessons or feed, and a file or link
    // on one is what that one adds. A membership course stays at one price,
    // because what a member pays each month is what the course is.
    if ((product.course || product.podcast) && product.recurring) return { ok: false, reason: "course" };
    // A bundle has one price for everything in it.
    if (isBundle(product)) return { ok: false, reason: "bundle" };
    // The buyer would be choosing a price twice.
    if (product.pwyw) return { ok: false, reason: "pwyw" };
    if (product.options.length >= MAX_OPTIONS) {
      return { ok: false, reason: "too_many", limit: MAX_OPTIONS };
    }
    // Counted across the store, because that is what the index weighs
    // (lib/product-option.ts, MAX_STORE_OPTIONS).
    const held = store.catalog.items.reduce((sum, item) => sum + item.options.length, 0);
    if (held >= MAX_STORE_OPTIONS) {
      return { ok: false, reason: "store_too_many", limit: MAX_STORE_OPTIONS };
    }
    const sku = readShippingSku(more.sku);
    if (sku === null) return { ok: false, reason: "sku" };
    if (sku && !product.shipping) return { ok: false, reason: "sku_kind" };
    const option: ProductOption = {
      id: freshId(store),
      label: fields.label,
      priceCents: fields.priceCents,
      ...(sku ? { sku } : {}),
      file: null,
      link: null,
      details: parseDetails(more.details),
      best: more.best === true,
    };
    // One pick per product: a new pick un-picks the one before it.
    const kept = option.best ? product.options.map((entry) => (entry.best ? { ...entry, best: false } : entry)) : product.options;
    const next = await save(store, { put: [{ ...product, options: [...kept, option] }] });
    return { ok: true, store: next, removed: [] };
  });
  return result ?? { ok: false, reason: "none" };
}

/** Reads the product an option id belongs to, under the lock, with the option. */
async function onOption(
  email: string,
  id: string,
  change: (product: Product, at: number, store: Store) => { product: Product; removed: ProductFile[] } | OptionResult | null,
): Promise<OptionResult> {
  const result = await withStore<OptionResult>(email, async (store, save) => {
    const owner = productIdFor(store, id);
    const product = owner && owner !== id ? await readProduct(store, owner) : null;
    const at = product ? product.options.findIndex((option) => option.id === id) : -1;
    if (!product || at < 0) return { ok: false, reason: "unknown" };
    const done = change(product, at, store);
    if (!done) return { ok: true, store, removed: [] };
    if ("ok" in done) return done;
    const next = await save(store, { put: [done.product] });
    return { ok: true, store: next, removed: done.removed };
  });
  return result ?? { ok: false, reason: "none" };
}

/**
 * Changes an option's label, price, what it includes and whether it is the
 * creator's pick, keeping its place and its delivery.
 *
 * `details` and `best` are left as they are when not sent, so an older
 * screen that only knows label and price cannot wipe them by saving.
 */
export async function editOption(
  email: string,
  id: string,
  rawLabel: string,
  rawPrice: string,
  more: { details?: unknown; best?: boolean; sku?: unknown } = {},
): Promise<OptionResult> {
  return onOption(email, id, (product, at, store) => {
    // Read in the store's own currency, as the store is under the lock.
    const fields = readOption(rawLabel, rawPrice, store.currency);
    if (typeof fields === "string") return { ok: false, reason: fields };
    const sku = more.sku === undefined ? product.options[at].sku : readShippingSku(more.sku);
    if (sku === null) return { ok: false, reason: "sku" };
    if (more.sku !== undefined && sku && !product.shipping) return { ok: false, reason: "sku_kind" };
    const best = more.best ?? product.options[at].best;
    const options = product.options.map((option, index) =>
      index === at
        ? {
            ...option,
            label: fields.label,
            sku: sku || undefined,
            priceCents: fields.priceCents,
            details: more.details === undefined ? option.details : parseDetails(more.details),
            best,
          }
        : // One pick per product: choosing this one un-picks the other.
          best && option.best
          ? { ...option, best: false }
          : option,
    );
    return { product: { ...product, options }, removed: [] };
  });
}

/**
 * Takes an option off a product.
 *
 * The file it held is handed back rather than deleted here, for the same
 * reason every other delivery change works that way: the record stops
 * pointing at it first, and only then is the storage released.
 */
export async function removeOption(
  email: string,
  id: string,
): Promise<OptionResult> {
  return onOption(email, id, (product, at) => {
    const option = product.options[at];
    return {
      product: { ...product, options: product.options.filter((entry) => entry.id !== id) },
      removed: option.file ? [option.file] : [],
    };
  });
}

/** Moves an option one place up or down within its own product. */
export async function moveOption(
  email: string,
  id: string,
  direction: "up" | "down",
): Promise<OptionResult> {
  return onOption(email, id, (product, at) => {
    const to = direction === "up" ? at - 1 : at + 1;
    if (to < 0 || to >= product.options.length) return null;
    const options = [...product.options];
    [options[at], options[to]] = [options[to], options[at]];
    return { product: { ...product, options }, removed: [] };
  });
}

/**
 * Records whether this store has a live discount code.
 *
 * Only a snapshot of an answer that lives on the creator's Stripe account, so
 * the buyer's checkout does not have to ask Stripe on every click. It is
 * written whenever the creator's own screen has just read the real list.
 */
export async function setHasDiscounts(
  email: string,
  hasDiscounts: boolean,
): Promise<Store | null> {
  const store = await storeForEmail(email);
  if (!store) return null;
  if (store.hasDiscounts === hasDiscounts) return store;
  return patchStore(email, (current) => (current.hasDiscounts === hasDiscounts ? null : { hasDiscounts }));
}

export type ProductPartResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" };

/** Changes one product in place with `change`, and saves the store. */
async function changeProduct(
  email: string,
  id: string,
  change: (product: Product) => Product,
  extra: (store: Store) => Partial<Store> = () => ({}),
): Promise<ProductPartResult> {
  const done = await onProduct<never>(email, id, (product) => change(product), (store) => extra(store));
  return done.ok ? { ok: true, store: done.store, product: done.product } : done;
}

/**
 * Puts a picture on a product, or takes it off. Returns the picture it
 * replaced, so the caller can delete it from the file store once the record
 * that pointed at it is safely written.
 */
export async function setProductImage(
  email: string,
  id: string,
  image: ProductImage | null,
): Promise<{ ok: true; store: Store; removed: ProductImage | null } | { ok: false; reason: "none" | "unknown" }> {
  const done = await onProduct<never>(email, id, (product) => ({
    ...product,
    image,
    // A picture added to a product still drawn as a plain card shows as a
    // callout, which is where a picture earns its place. Taking the picture
    // off puts the plain card back.
    display: image && !product.image && product.display === "button" ? "callout" : image ? product.display : "button",
  }));
  if (!done.ok) return done;
  return { ok: true, store: done.store, removed: done.before.image };
}

/** Changes the words a screen reader says instead of the picture. */
export async function setImageAlt(email: string, id: string, alt: string): Promise<ProductPartResult> {
  return changeProduct(email, id, (product) =>
    product.image ? { ...product, image: { ...product.image, alt } } : product,
  );
}

/** Changes how the product's card is drawn on the store page. */
export async function setProductDisplay(email: string, id: string, display: DisplayStyle): Promise<ProductPartResult> {
  return changeProduct(email, id, (product) => ({ ...product, display }));
}

/** Replaces the questions asked at checkout. An empty list asks none. */
export async function setProductFields(email: string, id: string, fields: CheckoutField[]): Promise<ProductPartResult> {
  return changeProduct(email, id, (product) => ({ ...product, fields }));
}

/**
 * Marks whether a product has a long description. The text itself is written
 * by lib/product-about.ts under the store's statsId, which is made here for a
 * store written before it had one.
 */
export async function setProductAbout(email: string, id: string, has: boolean): Promise<ProductPartResult> {
  return changeProduct(
    email,
    id,
    (product) => ({ ...product, about: has }),
    (store) => ({ statsId: store.statsId ?? newListId() }),
  );
}

export type KeysResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | "kind" };

/**
 * Switches license keys on for a product, changes how they are made, or
 * switches them off (null). Only a paid product sold once can have them. The
 * store is given the id its keys are kept under, if it has none yet.
 */
export async function setProductKeys(email: string, id: string, keys: KeySetup | null): Promise<KeysResult> {
  const done = await onProduct<"kind">(
    email,
    id,
    (product) => (keys && !canHaveKeys(product) ? { ok: false, reason: "kind" } : { ...product, keys }),
    (store) => ({ statsId: store.statsId ?? newListId() }),
  );
  return done.ok ? { ok: true, store: done.store, product: done.product } : done;
}

/**
 * Marks whether a product's page is built from blocks. The blocks themselves
 * are written by lib/sales-page-store.ts under the store's statsId, which is
 * made here for a store written before it had one.
 */
export async function setProductPage(email: string, id: string, has: boolean): Promise<ProductPartResult> {
  return changeProduct(
    email,
    id,
    (product) => ({ ...product, page: has }),
    (store) => ({ statsId: store.statsId ?? newListId() }),
  );
}

/**
 * Switches the review-request email on (3 to 30 days after buying) or off
 * (0). The store is given the id its reviews are kept under, if it has none.
 */
export async function setReviewAsk(email: string, ask: ReviewAsk): Promise<Store | null> {
  return patchStore(email, (store) => ({ reviewAsk: parseReviewAsk(ask), statsId: store.statsId ?? newListId() }));
}

/**
 * Notes that the store has a review, the first time one is written. A buyer's
 * request writes the store record here, once in the store's life, under its
 * lock; every later review finds it set and writes nothing.
 */
export async function setReviewed(email: string): Promise<Store | null> {
  return patchStore(email, (store) => (store.reviewed ? null : { reviewed: true }));
}

/** Saves the welcome video under the store's name, or takes it away (null). */
export async function setIntro(email: string, video: Video | null): Promise<Store | null> {
  return patchStore(email, () => ({ intro: video }));
}

/** Saves the order of the parts of the store page (lib/store-order.ts), made whole first. */
export async function setOrder(email: string, order: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ order: parseOrder(order) }));
}

/** Saves the store's own questions and answers (lib/store-faq.ts). */
export async function setFaq(email: string, raw: unknown): Promise<Store | null> {
  const faq = parseFaq(raw);
  return patchStore(email, () => ({ faq }));
}

/** Adds one question and its answer at the end of the store's own (lib/faq-from-inbox.ts), read and written as one change. */
export async function addFaq(email: string, raw: unknown): Promise<{ ok: true; faq: FaqItem[] } | { ok: false; reason: FaqAddRefusal | "none" }> {
  let refused: FaqAddRefusal | null = null;
  const store = await patchStore(email, (current) => {
    const added = faqAddition(current.faq, raw);
    refused = added.ok ? null : added.reason;
    return added.ok ? { faq: added.faq } : null;
  });
  if (!store) return { ok: false, reason: "none" };
  return refused ? { ok: false, reason: refused } : { ok: true, faq: store.faq };
}

/** Switches the store page's contact form and saves its words (lib/store-contact.ts). */
export async function setContact(email: string, raw: unknown): Promise<Store | null> {
  const contact = parseJoin(raw);
  return patchStore(email, () => ({ contact }));
}

/** Switches "Support my work" on the store page and saves its words and amounts (lib/store-tips.ts). */
export async function setTips(email: string, tips: StoreTips): Promise<Store | null> {
  return patchStore(email, () => ({ tips: parseTips(tips) }));
}

/** Saves the media kit (lib/store-kit.ts), dated today when any of its numbers changed. */
/**
 * Adds a read-only link to the store's numbers (lib/numbers-links.ts): links
 * that have ended are let go first; no more than MAX_LINKS at once.
 */
export async function addNumbersLink(email: string, link: NumbersLink, now = Date.now()): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" | "full" }> {
  let full = false;
  const next = await patchStore(email, (store) => {
    const live = (store.numbersLinks ?? []).filter((l) => l.expires > Math.floor(now / 1000));
    if (live.length >= MAX_LINKS) {
      full = true;
      return null;
    }
    return { numbersLinks: [...live, link] };
  });
  if (full) return { ok: false, reason: "full" };
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** Takes a link back: it stops opening at once. */
export async function removeNumbersLink(email: string, id: string): Promise<{ ok: true; store: Store } | { ok: false; reason: "none" }> {
  const next = await patchStore(email, (store) => ({ numbersLinks: (store.numbersLinks ?? []).filter((l) => l.id !== id) }));
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

export async function setKit(email: string, sent: unknown, today = new Date().toISOString().slice(0, 10)): Promise<Store | null> {
  return patchStore(email, (store) => ({ kit: nextKit(sent, store.kit, today) }));
}

/** Writes down a piece of content taken down after a notice, and switches the store off or on when asked (lib/takedown.ts). */
export async function noteTakedown(email: string, strike: Strike | null, suspended?: boolean): Promise<Store | null> {
  return patchStore(email, (store) => ({
    ...(strike ? { strikes: [strike, ...store.strikes].slice(0, 50) } : {}),
    ...(suspended === undefined ? {} : { suspended: suspended ? new Date().toISOString() : "" }),
  }));
}

/** Keeps the newest reviews to quote on the store page (lib/store-quotes.ts). */
export async function setQuotes(email: string, raw: unknown): Promise<Store | null> {
  const quotes = parseQuotes(raw);
  return patchStore(email, (store) => (JSON.stringify(store.quotes) === JSON.stringify(quotes) ? null : { quotes }));
}

/** Switches the store page's sign-up box and saves its words. */
export async function setJoin(email: string, raw: unknown): Promise<Store | null> {
  const join = parseJoin(raw);
  return patchStore(email, () => ({ join }));
}

/** Saves the creator's profiles elsewhere (lib/store-socials.ts), made safe; says how many were kept. */




/** The sign-up box's settings, as kept or as sent, made safe. */


export async function setSocials(email: string, raw: unknown): Promise<Store | null> {
  const socials = parseSocials(raw);
  return patchStore(email, () => ({ socials }));
}

/** Keeps how many blog posts are published (lib/store-blog.ts) on the store's record; writes nothing when it is already so. */
export async function setPostCount(email: string, count: number): Promise<Store | null> {
  const posts = Math.max(0, Math.min(Math.floor(count), 10_000));
  return patchStore(email, (store) => (store.posts === posts ? null : { posts }));
}

/** Switches stamping the buyer's email into a product's PDFs on or off. */
export async function setProductStamp(email: string, id: string, on: boolean): Promise<ProductPartResult> {
  return changeProduct(email, id, (product) => ({ ...product, stamp: on }));
}

/** How many first pages of a product's PDF anyone may read before buying (lib/pdf-preview.ts); 0 switches it off. */
export async function setProductPreview(email: string, id: string, pages: number): Promise<ProductPartResult> {
  const kept = Number.isInteger(pages) && pages > 0 ? Math.min(pages, 10) : 0;
  return changeProduct(email, id, (product) => ({ ...product, preview: kept }));
}


// ---- Bundles and drafts -------------------------------------------------------

export type BundleResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | BundleProblem };

/**
 * Makes a product a bundle of other products of this store, changes what is
 * in it, or turns it back into an ordinary product (null). Checked under the
 * store's lock against the products as they are (lib/bundle-rules.ts), so a
 * bundle can never be saved holding something that cannot be handed over.
 * Buyers who already paid keep the list that was on their order.
 */
export async function setProductBundle(email: string, id: string, items: string[] | null, pick: number | null = null): Promise<BundleResult> {
  return onProduct<BundleProblem>(email, id, async (product, store) => {
    if (items === null) return { ...product, bundle: null, pick: null };
    const listed = await readListings(store, items);
    const problem = bundleProblem(items, listed, product);
    if (problem) return { ok: false, reason: problem };
    // Buyers choose from the list: fewer than it holds (lib/bundle-rules.ts).
    if (pickProblem(pick, items.length)) return { ok: false, reason: "pick" };
    return { ...product, bundle: [...items], pick };
  });
}

export type IntroResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | `intro_${IntroProblem}` };

/**
 * Gives a membership an introductory price (lib/intro-price.ts), changes it,
 * or takes it off (null). Checked under the store's lock against the product
 * as it is, in the store's own currency.
 */
export async function setProductIntro(email: string, id: string, intro: Intro | null): Promise<IntroResult> {
  const done = await onProduct<`intro_${IntroProblem}`>(email, id, (product, store) => {
    if (intro === null) return { ...product, intro: null };
    const problem = introProblem(product, intro, priceBounds(store.currency).min, store.tiers);
    if (problem) return { ok: false, reason: `intro_${problem}` };
    return { ...product, intro: { cents: intro.cents, count: intro.count } };
  });
  return done.ok ? { ok: true, store: done.store, product: done.product } : done;
}

export type YearlyResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | `yearly_${YearlyProblem}` };

/** Gives a monthly membership a yearly price beside it (lib/yearly-price.ts), changes it, or takes it off (null). */
export async function setProductYearly(email: string, id: string, yearly: Yearly | null): Promise<YearlyResult> {
  const done = await onProduct<`yearly_${YearlyProblem}`>(email, id, (product, store) => {
    if (yearly === null) return { ...product, yearly: null };
    const problem = yearlyProblem(product, yearly, priceBounds(store.currency).min, store.tiers);
    if (problem) return { ok: false, reason: `yearly_${problem}` };
    return { ...product, yearly: { cents: yearly.cents } };
  });
  return done.ok ? { ok: true, store: done.store, product: done.product } : done;
}

export type ShippingResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | `ship_${ShipProblem}` | "ship_price" | "ship_sku" };

/**
 * Makes a product a physical one the creator ships (lib/shipping.ts), changes
 * where to and what shipping costs, or makes it an ordinary product again
 * (null). Checked under the store's lock against the product as it is.
 */
export async function setProductShipping(email: string, id: string, shipping: Shipping | null): Promise<ShippingResult> {
  const done = await onProduct<`ship_${ShipProblem}` | "ship_price" | "ship_sku">(email, id, (product, store) => {
    if (shipping === null) return { ...product, shipping: null };
    const problem = shipProblem(product);
    if (problem) return { ok: false, reason: `ship_${problem}` };
    // Free, or at least what Stripe charges in the store's currency.
    if (shipping.cents > 0 && shipping.cents < currencyRule(store.currency).minCharge) return { ok: false, reason: "ship_price" };
    const sku = readShippingSku(shipping.sku);
    if (sku === null) return { ok: false, reason: "ship_sku" };
    // Older clients changing shipping omit this field; preserve their existing reference.
    const keptSku = shipping.sku === undefined ? product.shipping?.sku : sku;
    return { ...product, shipping: { cents: shipping.cents, region: shipping.region, countries: [...shipping.countries], note: shipping.note, ...(keptSku ? { sku: keptSku } : {}) } };
  });
  return done.ok ? { ok: true, store: done.store, product: done.product } : done;
}

/** Marks whether a product has a note for after paying (lib/thanks-note.ts); the note itself is kept apart. */
export async function setProductNote(email: string, id: string, note: boolean): Promise<{ ok: true; store: Store; product: Product } | { ok: false; reason: "none" | "unknown" }> {
  const done = await onProduct<never>(email, id, (product) => ({ ...product, note }));
  return done.ok ? { ok: true, store: done.store, product: done.product } : done;
}

export type HiddenResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" };

/**
 * Publishes a draft, or takes a product off the store without removing it.
 * A hidden product keeps everything it has, its buyers keep what they bought,
 * and a bundle that holds it still hands it over.
 */
export async function setProductHidden(email: string, id: string, hidden: boolean): Promise<HiddenResult> {
  const done = await onProduct<never>(email, id, (product) => ({ ...product, hidden }), (store) => {
    // Same existing bounded store write: no event table, extra command or provider call.
    // Older stores with a visible offer have unknown historical timing, never backfilled as now.
    if (!store.activationTracked || hidden || store.firstOfferPublishedAt || store.catalog.items.some(item => (item.kind & KIND.hidden) === 0)) return {};
    return { firstOfferPublishedAt: new Date().toISOString() };
  });
  return done.ok ? { ok: true, store: done.store, product: done.product } : done;
}

/** One product an import makes, already checked (lib/imports.ts). */
export type DraftProduct = {
  title: string;
  summary: string;
  /** In the store currency's smallest unit; 0 for free. */
  priceCents: number;
  /** Where the buyer is sent, already read by lib/product-link.ts; null for none yet. */
  link: string | null;
  /** Whether a long description is written for it, in its own record, by the caller. */
  about?: boolean;
};

export type DraftsResult =
  | { ok: true; store: Store; ids: string[] }
  | { ok: false; reason: "none" | "too_many"; limit: number; room: number };

/**
 * Adds several products at once, each a draft the store does not show until
 * the creator publishes it, at the end of the list, in one write under the
 * store's lock. All of them or none: when they would take the store past its
 * ceiling nothing is added, and the answer says how much room there is.
 */
export async function addDraftProducts(email: string, drafts: DraftProduct[]): Promise<DraftsResult> {
  const result = await withStore<DraftsResult>(email, async (store, save) => {
    const room = MAX_PRODUCTS - store.catalog.items.length;
    if (drafts.length > room) return { ok: false, reason: "too_many", limit: MAX_PRODUCTS, room: Math.max(0, room) };
    const createdAt = new Date().toISOString();
    const taken = usedIds(store);
    for (const link of store.links) taken.add(link.id);
    const made: Product[] = [];
    for (const draft of drafts) {
      let id = "";
      for (let attempt = 0; attempt < 50 && (!id || taken.has(id)); attempt += 1) {
        id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      }
      taken.add(id);
      made.push({
        id,
        title: draft.title.trim().slice(0, MAX_TITLE_LENGTH),
        summary: draft.summary.trim().slice(0, MAX_SUMMARY_LENGTH),
        priceCents: draft.priceCents,
        createdAt,
        file: null,
        link: draft.link,
        recurring: null,
        options: [],
        call: null,
        stock: null,
        bumps: [],
        funnel: null,
        plan: null,
        course: null,
        image: null,
        display: "button",
        fields: [],
        pwyw: null,
        about: draft.about === true,
        keys: null,
        stamp: false,
      preview: 0,
        page: false,
        bundle: null,
        hidden: true,
      });
    }
    const anyFree = made.some((p) => p.priceCents === 0);
    const next = await save(
      { ...store, listId: store.listId ?? (anyFree ? newListId() : null), statsId: store.statsId ?? newListId() },
      { put: made },
    );
    return { ok: true, store: next, ids: made.map((p) => p.id) };
  });
  return result ?? { ok: false, reason: "none", limit: MAX_PRODUCTS, room: 0 };
}

export type CopiedResult =
  | { ok: true; store: Store; made: string[]; held: string[] }
  | { ok: false; reason: "none" | "too_many"; limit: number; room: number };

/**
 * Adds products copied from another store of the same account
 * (lib/store-copy.ts), each already a draft with the id the copy gave it, at
 * the end of the list, in one write under the store's lock. A product whose
 * id the store already has is one this same copy already wrote, and is left
 * as it is: so writing the same step again adds nothing. All of the rest or
 * none: past the store's ceiling nothing is added. Each one's records take
 * their room in the data room before they are written, as every product's do.
 */
export async function addCopiedProducts(email: string, products: Product[]): Promise<CopiedResult> {
  const result = await withStore<CopiedResult>(email, async (store, save) => {
    const have = usedIds(store);
    for (const link of store.links) have.add(link.id);
    const held = products.filter((p) => have.has(p.id)).map((p) => p.id);
    const fresh = products.filter((p) => !have.has(p.id));
    const room = MAX_PRODUCTS - store.catalog.items.length;
    if (fresh.length > room) return { ok: false, reason: "too_many", limit: MAX_PRODUCTS, room: Math.max(0, room) };
    if (!fresh.length) return { ok: true, store, made: [], held };
    const anyFree = fresh.some((p) => p.priceCents === 0);
    const next = await save(
      { ...store, listId: store.listId ?? (anyFree ? newListId() : null), statsId: store.statsId ?? newListId() },
      { put: fresh.map((p) => ({ ...p, hidden: true })) },
    );
    return { ok: true, store: next, made: fresh.map((p) => p.id), held };
  });
  return result ?? { ok: false, reason: "none", limit: MAX_PRODUCTS, room: 0 };
}

/** The store page's setup a copy brings, already mapped to this store's products (lib/store-copy-rules.ts, copiedSetup). */
export type SetupCopy = {
  bio: string;
  look: { theme: string; accent: string; font: string; backdrop: string };
  links: StoreLink[];
  socials: Social[];
  faq: FaqItem[];
  order: PagePart[];
  sections: StoreSection[];
  announcement: Announcement | null;
};

/**
 * Puts a copied setup on this store, in one write under its lock: each part
 * read through the same rules the studio's own setters use, a section only
 * when this store has its product, the line of news only with a product it
 * has, the colors and letters without touching whether the store shows its
 * badge or its counts (those go with the plan, and with this store's own
 * choice), and the links with ids of their own.
 */
export async function applyCopiedSetup(email: string, setup: SetupCopy): Promise<Store | null> {
  return withStore(email, async (store, save) => {
    const look = parseLook({ ...store.look, theme: setup.look.theme, accent: setup.look.accent, font: setup.look.font, backdrop: setup.look.backdrop });
    const taken = usedIds(store);
    const links = parseStoreLinks(
      setup.links.map((link, i) => {
        let id = link.id;
        if (taken.has(id)) id = `${link.id.slice(0, 6)}${i.toString(36).padStart(4, "0")}`;
        taken.add(id);
        return { ...link, id };
      }),
    );
    const sections = parseSections(setup.sections).filter((section) => hasProduct(store, section.at));
    const read = parseAnnouncement(setup.announcement);
    const announcement = read ? { text: read.text, product: read.product && hasProduct(store, read.product) ? read.product : null } : null;
    return save({
      ...store,
      bio: setup.bio.slice(0, MAX_BIO_LENGTH),
      look: { ...look, badge: store.look.badge, sold: store.look.sold },
      links,
      socials: parseSocials(setup.socials),
      faq: parseFaq(setup.faq),
      order: parseOrder(setup.order),
      sections,
      announcement,
    });
  });
}

/**
 * Notes that some buyers were brought over from another platform
 * (lib/imported-purchases.ts), so the store's list of purchases answers them
 * even before — or without — a Stripe account. Set once, like `reviewed`.
 */
export async function setPastBuyers(email: string): Promise<Store | null> {
  return patchStore(email, (store) => (store.pastBuyers ? null : { pastBuyers: true }));
}

/** Connects (or, with null, disconnects) the PayPal account a store sells through. */
export async function setPayPalSeller(email: string, merchant: string | null): Promise<Store | null> {
  const seller = merchant ? parsePayPalSeller({ merchant, at: Date.now() }) : null;
  if (merchant && !seller) return null;
  return patchStore(email, () => ({ paypalSeller: seller }));
}

export type ExitOfferResult = { ok: true; store: Store } | { ok: false; reason: "none" | "unknown" | "not_free" };

export type SectionsResult = { ok: true; store: Store } | { ok: false; reason: "none" | "unknown" };

/**
 * Sets the store's own pages: all of them, in the order sent (lib/site-page-rules.ts).
 * A page whose buttons lead to a product the store no longer has is refused
 * by name. The store is given the id its pages' blocks are kept under, if it
 * has none yet.
 */
export async function setSitePages(email: string, raw: unknown): Promise<SectionsResult> {
  const result = await withStore<SectionsResult>(email, async (store, save) => {
    const sitePages = parseSitePages(raw);
    if (sitePages.some((page) => page.target && !hasProduct(store, page.target))) return { ok: false, reason: "unknown" };
    return { ok: true, store: await save({ ...store, sitePages, statsId: store.statsId ?? newListId() }) };
  });
  return result ?? { ok: false, reason: "none" };
}

/** Adds pages to the latest store under its existing fenced write lock.
 * Never replaces pages with a request's older snapshot or silently drops an addition.
 */
export async function appendSitePages(email: string, raw: unknown): Promise<SectionsResult> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SITE_PAGES) return { ok: false, reason: "unknown" };
  const added = parseSitePages(raw);
  if (added.length !== raw.length) return { ok: false, reason: "unknown" };
  const result = await withStore<SectionsResult>(email, async (store, save) => {
    if (store.sitePages.length + added.length > MAX_SITE_PAGES) return { ok: false, reason: "unknown" };
    const pages = [...store.sitePages];
    for (const page of added) {
      if (pages.some(held => held.id === page.id) || slugProblem(page.slug, pages) !== null
        || (page.target && !hasProduct(store, page.target))) return { ok: false, reason: "unknown" };
      pages.push(page);
    }
    return { ok: true, store: await save({ ...store, sitePages: pages, statsId: store.statsId ?? newListId() }) };
  });
  return result ?? { ok: false, reason: "none" };
}

/**
 * Sets the store page's sections: all of them at once, in the order sent.
 * Each has to start at a product this store still has; one that does not is
 * refused by name rather than quietly dropped, so the studio never says
 * "saved" about a heading that was not kept.
 */
export async function setSections(email: string, raw: unknown): Promise<SectionsResult> {
  const result = await withStore<SectionsResult>(email, async (store, save) => {
    const sections = parseSections(raw);
    if (sections.some((section) => !hasProduct(store, section.at))) return { ok: false, reason: "unknown" };
    return { ok: true, store: await save({ ...store, sections }) };
  });
  return result ?? { ok: false, reason: "none" };
}

export type CollectionsResult = { ok: true; store: Store } | { ok: false; reason: "none" | CollectionsProblem };

/**
 * Sets the store's collections (lib/store-collections.ts): all of them at
 * once, in the order sent. Each product named has to be one this store has;
 * anything else is refused as a whole, never quietly dropped.
 */
export async function setCollections(email: string, raw: unknown): Promise<CollectionsResult> {
  const result = await withStore<CollectionsResult>(email, async (store, save) => {
    const read = readCollectionsInput(raw, store.collections ?? [], (id) => hasProduct(store, id));
    if (!read.ok) return read;
    return { ok: true, store: await save({ ...store, collections: read.collections }) };
  });
  return result ?? { ok: false, reason: "none" };
}

export type PairsResult =
  | { ok: true; store: Store; product: Product }
  | { ok: false; reason: "none" | "unknown" | "target" | "too_many" };

/**
 * Sets the products that go well with a product (lib/store-collections.ts),
 * up to MAX_PAIRS, in the order sent; an empty list for none. Each has to be
 * another product of this store.
 */
export async function setProductPairs(email: string, id: string, raw: unknown): Promise<PairsResult> {
  if (!Array.isArray(raw)) return { ok: false, reason: "target" };
  if (raw.length > MAX_PAIRS) return { ok: false, reason: "too_many" };
  const pairs = readProductIds(raw, MAX_PAIRS, id);
  if (pairs.length !== raw.length) return { ok: false, reason: "target" };
  const done = await onProduct<"target">(email, id, (product, store) => {
    if (pairs.some((other) => !hasProduct(store, other))) return { ok: false, reason: "target" };
    return { ...product, pairs };
  });
  return done.ok ? { ok: true, store: done.store, product: done.product } : done;
}

/** Switches the answers to visitors' questions on or off, and keeps the creator's notes for them (lib/answers-rules.ts). */
export async function setAnswers(email: string, raw: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ answers: parseAnswers(raw) }));
}

/** Switches the Store assistant's chat on or off, and keeps the creator's notes for it (lib/store-assistant-rules.ts). */
export async function setAssistant(email: string, raw: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ assistant: parseAssistant(raw) }));
}

/** Switches the Store assistant's next product after a purchase on or off, and its line in the confirmation email (lib/next-offer-rules.ts). */
export async function setNextOffer(email: string, raw: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ nextOffer: parseNextOffer(raw) }));
}

/** Switches the Store assistant's checkout reminder box on or off (lib/assistant-reminder-rules.ts). */
export async function setAssistReminder(email: string, raw: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ assistReminder: parseAssistReminder(raw) }));
}

/** Writes down what Stripe says about the store's add-on subscription (lib/assistant-billing.ts); null forgets it. */
export async function setAssistantPlan(email: string, plan: AssistantPlan | null): Promise<Store | null> {
  return patchStore(email, (store) => {
    const next = plan === null ? null : parseAssistantPlan(plan);
    if (plan !== null && next === null) return null;
    // A dispute, once written down, stays: the add-on is not sold to that store again.
    if (next && store.assistantPlan?.disputedAt && !next.disputedAt) next.disputedAt = store.assistantPlan.disputedAt;
    return { assistantPlan: next };
  });
}

/**
 * Writes one dispute of a plan payment on the store's record (232 [CA1]
 * unit 5, lib/plan-disputes.ts): a new one is added, a known one takes its
 * new status. Answers the store as it is now, or null when it is gone.
 */
export async function recordPlanDispute(email: string, entry: PlanDispute, nowSeconds = Date.now() / 1000): Promise<Store | null> {
  const parsed = parsePlanDispute(entry);
  if (!parsed) return null;
  return patchStore(email, (store) => {
    const before = store.planDisputes ?? [];
    const next = withPlanDispute(before, parsed, nowSeconds);
    return JSON.stringify(next) === JSON.stringify(before) ? null : { planDisputes: next };
  });
}

/** Switches fair prices by country on or off, with the deepest discount the creator accepts (lib/fair-price.ts). */
/** Saves the store's deal for buying more in one cart (lib/cart-rules.ts). */
export async function setCartDeal(email: string, raw: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ cartDeal: parseCartDeal(raw) }));
}

export async function setFair(email: string, raw: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ fair: parseFair(raw) }));
}

/** Sets the language the store speaks to its buyers in (lib/store-language.ts). */
export async function setLanguage(email: string, raw: unknown): Promise<Store | null> {
  return patchStore(email, () => ({ language: parseLanguage(raw) }));
}

/**
 * Sets the "Visit us" block (lib/visit-us.ts), or takes it away when
 * nothing is in it. Says which part cannot be kept, and changes nothing then.
 */
export async function setVisitUs(email: string, raw: unknown): Promise<{ ok: true; store: Store } | { ok: false; reason: "place" | "hours" | "phone" | "none" }> {
  const read = readVisitUs(raw);
  if (typeof read === "string") return { ok: false, reason: read };
  const store = await patchStore(email, () => ({ visitUs: read }));
  return store ? { ok: true, store } : { ok: false, reason: "none" };
}

/** Sets the line of news across the top of the store page, or takes it away (null or empty). */
export async function setAnnouncement(email: string, raw: unknown): Promise<SectionsResult> {
  const result = await withStore<SectionsResult>(email, async (store, save) => {
    const announcement = parseAnnouncement(raw);
    if (announcement?.product && !hasProduct(store, announcement.product)) return { ok: false, reason: "unknown" };
    return { ok: true, store: await save({ ...store, announcement }) };
  });
  return result ?? { ok: false, reason: "none" };
}

/**
 * Chooses the free product offered to a visitor about to leave, or none
 * (null). Only something the store can give away for an address: a paid
 * product here would be an offer to pay on the way out, which is not what
 * this is for (lib/exit-offer.ts).
 */
export async function setExitOffer(email: string, productId: string | null): Promise<ExitOfferResult> {
  const result = await withStore<ExitOfferResult>(email, async (store, save) => {
    if (productId === null) return { ok: true, store: store.exitOffer === null ? store : await save({ ...store, exitOffer: null }) };
    const product = await readListing(store, productId);
    if (!product) return { ok: false, reason: "unknown" };
    if (!isFree(product) || product.hidden) return { ok: false, reason: "not_free" };
    return { ok: true, store: await save({ ...store, exitOffer: product.id }) };
  });
  return result ?? { ok: false, reason: "none" };
}
