import { SalesLevers } from "@/components/sales-levers";
import { costsPaused } from "@/lib/plan-standing";
import { INTEGRATION_PAUSED_WORDS, META_READ_PAUSED } from "@/lib/integration-pause";
import { PlanDisputeNotice } from "@/components/plan-dispute-notice";
import { planDisputed } from "@/lib/plan-dispute-rules";
import { RenewalUnpaidNotice } from "@/components/renewal-unpaid-notice";
import { funnelLaunchChecklist } from "@/lib/funnel-launch-checklist";
import { activationTiming } from "@/lib/store-activation";
import { PathStudioReminder } from "@/components/path-studio-reminder";
import { UsageMeter } from "@/components/usage-meter";
import { dataUsed } from "@/lib/store-data";
import { dataFullWords, dataWords } from "@/lib/store-data-rules";
import { isDiscordConfigured } from "@/lib/discord";
import { RecentSalesSwitch } from "@/components/recent-sales-switch";
import { firstSaleAt } from "@/lib/yearly-offer";
import { breakRunning, pauseView } from "@/lib/plan-pause";
import { PLAN_BREAKS_ENABLED, PAID_MONTHS_BEFORE_PAUSE, PAUSE_MONTHS, PAUSE_EVERY_DAYS } from "@/lib/plan-pause-rules";
import { MarkShipped } from "@/components/mark-shipped";
import { paypalSalesConfigured } from "@/lib/paypal-sales";
import { lowestPriceCents } from "@/lib/product-option";
import { SaleEditor } from "@/components/sale-editor";
import { FairPriceEditor } from "@/components/fair-price-editor";
import { CartDealEditor } from "@/components/cart-deal-editor";
import { offersCart } from "@/lib/cart-checkout";
import { allCountries, countryName } from "@/lib/fair-price";
import { TierEditor } from "@/components/tier-editor";
import { canTier } from "@/lib/tier-rules";
import { tierWords } from "@/lib/tier-switch";
import { saleClock, saleable } from "@/lib/store-sale";
import { waitlistViews } from "@/lib/waitlist";
import { preorderViews } from "@/lib/preorders";
import { freshCounts } from "@/lib/lesson-comments";
import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { Icon } from "@/components/icons";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  pricedProducts,
  ensureStatsId,
  imageFolder,
  isFree,
  setAdsServer,
  setSubscription,
  storeRef,
  storeFolder,
  type Listing,
  type Store,
} from "@/lib/store";
import { KIND, idsOfKind, productCount, readKind, readListings, sellsAny, studioShelf } from "@/lib/catalog";
import { HandleForm } from "@/components/handle-form";
import { prefillHandle } from "@/lib/handle-prefill";
import { RenameForm } from "@/components/rename-form";
import { OldAddresses } from "@/components/old-addresses";
import { DetailsForm } from "@/components/details-form";
import { SocialsEditor } from "@/components/socials-editor";
import { IntroEditor } from "@/components/intro-editor";
import { LookEditor } from "@/components/look-editor";
import { type PaidCall, catchUpBookings, paidCalls } from "@/lib/calls";
import { productsInStats, reachProducts, readAllTimeSales, readSales, readStats, studioStats } from "@/lib/stats";
import { StatsPanel } from "@/components/stats-panel";
import { readNotes } from "@/lib/stats-notes";
import { readSpends } from "@/lib/ad-spend";
import { metaView } from "@/lib/meta-ads";
import { readRanges, recordSample } from "@/lib/benchmarks";
import { compare, sampleFrom } from "@/lib/benchmark-rules";
import { heardOff } from "@/lib/heard";
import { weeklyTeam } from "@/lib/stats-report";
import { NO_SETUP, SERVER_PLATFORMS, serverSetup } from "@/lib/ad-events";
import { claimPathsRead, laterWords, pathsStale, readPaths } from "@/lib/next-bought";
import { BuyerPaths } from "@/components/buyer-paths";
import { canBeBumped, isOneOff } from "@/lib/product-extras";
import { whyNotInBundle } from "@/lib/bundle-rules";
import { hasPixels } from "@/lib/pixels";
import { readTrouble } from "@/lib/checkout-trouble";
import { readSalesGoal } from "@/lib/sales-goal";
import { chatSetup } from "@/lib/chat-summary";
import { NO_COUNT_COOKIE, isMarkedDevice } from "@/lib/no-count";
import { isOperator, searchConsoleStatus, storeSearches } from "@/lib/search-console";
import { GoogleSearches } from "@/components/google-searches";
import { ServerEventsEditor } from "@/components/server-events-editor";
import { CalendarEditor } from "@/components/calendar-editor";
import { WebhookEditor } from "@/components/webhook-editor";
import { calendarBusy, calendarView, ensureFeedToken, overlaps, slotRooms } from "@/lib/calendar-sync";
import { roomKind, roomLabel } from "@/lib/call-rooms";
import { type MeetView, meetView } from "@/lib/meet-connect";
import { cameForZoom, configuredProviders, isConfigured, offeredProviders } from "@/lib/meet-providers";
import { slotMeetings } from "@/lib/meet-links";
import type { MeetRecord } from "@/lib/meet-records";
import { keepHandle, webhooksView } from "@/lib/webhooks";
import { PixelEditor } from "@/components/pixel-editor";
import { ExitOfferEditor } from "@/components/exit-offer-editor";
import { StoreLayoutEditor } from "@/components/store-layout-editor";
import { CollectionsEditor } from "@/components/collections-editor";
import { BuyButtonEditor } from "@/components/buy-button-editor";
import { CheckoutScriptEditor } from "@/components/checkout-script-editor";
import { lookColours } from "@/lib/store-look";
import { AnswersEditor } from "@/components/answers-editor";
import { StoreAssistantEditor } from "@/components/store-assistant-editor";
import { assistantLeft, assistantMissed } from "@/lib/store-assistant";
import { assistantRefusal, syncAssistant } from "@/lib/assistant-billing";
import { assistantWindow } from "@/lib/store-assistant-rules";
import { STORE_PAGE, answersAllowance, answersUsed, missedQuestions } from "@/lib/answers";
import { readCards, readTitles } from "@/lib/catalog";
import { TaxEditor } from "@/components/tax-editor";
import { StoreLanguageEditor } from "@/components/store-language-editor";
import { RecoveryEditor } from "@/components/recovery-editor";
import { ApiKeyEditor } from "@/components/api-key-editor";
import { listKeys } from "@/lib/api-keys";
import { INVITE_SHARE_PERCENT, INVITE_PROGRAM_OPEN } from "@/lib/creator-invite-rules";
import { SaveOfferEditor } from "@/components/save-offer-editor";
import { PauseEditor } from "@/components/pause-editor";
import { DunningEditor } from "@/components/dunning-editor";
import { LeaveEditor } from "@/components/leave-editor";
import { NudgeEditor } from "@/components/nudge-editor";
import { nudgesThisMonth } from "@/lib/member-nudge";
import { YearlyAskEditor } from "@/components/yearly-ask-editor";
import { readVoice } from "@/lib/customer-voice";
import { readMarks } from "@/lib/auto-marks";
import { readsSales } from "@/lib/stats";
import { NumbersLinksEditor } from "@/components/numbers-links-editor";
import { yearlyAsksThisMonth } from "@/lib/yearly-ask";
import { activeYearly } from "@/lib/yearly-price";
import { WinBackEditor } from "@/components/winback-editor";
import { WelcomeOfferEditor } from "@/components/welcome-offer-editor";
import { welcomesOffered } from "@/lib/welcome-offer-send";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import { AiOn } from "@/components/ai-assist";
import { AiPosts } from "@/components/ai-posts";
import { winbacksSent } from "@/lib/winback-send";
import { sellsMemberships } from "@/lib/membership-manage";
import { taxStatus } from "@/lib/tax";
import { SITE_URL } from "@/lib/site-url";
import { MEET_NAMES, readableTime, roomFor, seatsAt, zoneName } from "@/lib/call-setup";
import { ProductEditor } from "@/components/product-editor";
import { PaymentsPanel } from "@/components/payments-panel";
import { chargeableCurrencies, readWaysToPay } from "@/lib/payment-methods";
import { formatMoney } from "@/lib/money";
import { LinkEditor } from "@/components/link-editor";
import { JoinBoxEditor } from "@/components/join-box-editor";
import { ContactBoxEditor } from "@/components/contact-box-editor";
import { FaqEditor } from "@/components/faq-editor";
import { StoreCoach } from "@/components/store-coach";
import { StoreAccessCheck } from "@/components/store-access-check";
import { StoreSearchCheck } from "@/components/store-search-check";
import { searchCheck } from "@/lib/store-search-check";
import { PageOrderEditor } from "@/components/page-order-editor";
import { tipsOpen } from "@/lib/store-tip-checkout";
import { TipsEditor } from "@/components/tips-editor";
import { KitEditor } from "@/components/kit-editor";
import { StoreSetupAi } from "@/components/store-setup-ai";
import { StudioHelp } from "@/components/studio-help";
import { joinOpen } from "@/lib/store-join";
import { contactOpen } from "@/lib/store-contact";
import { visibleCount } from "@/lib/catalog";
import { storeChecks } from "@/lib/store-coach";
import { accessCheck } from "@/lib/store-access-check";
import { isPaidUp } from "@/lib/billing";
import { allowanceWindow, calendarWindow, samePeriod } from "@/lib/allowance-window";
import { ALLOWANCE_KINDS, API_WRITE_UNITS, KIND_WORDS, allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsed } from "@/lib/store-allowance";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";

import { isSenderConfigured } from "@/lib/email";
import { DiscountEditor } from "@/components/discount-editor";
import { DomainEditor } from "@/components/domain-editor";
import { StudioTools } from "@/components/studio-tools";
import { StudioNav, StudioStart, type StartStep } from "@/components/studio-start";
import { domainStatus, isDomainsConfigured } from "@/lib/domains";
import {
  COUNTRIES,
  isConnectConfigured,
  isConnectInTestMode,
} from "@/lib/stripe-connect";
import { ORDERS_PAGE_SIZE, canSell, listSales } from "@/lib/store-checkout";
import { DELIVERY_ALLOWANCE_BYTES, FREE_PAUSE_ABOVE_BYTES, bytesWords, deliveredThisMonth } from "@/lib/delivery";
import { watchedForAdmission } from "@/lib/watch";
import { hoursWords } from "@/lib/watch-rules";
import { paidVideoSeconds, TRIAL_VIDEO_SECONDS } from "@/lib/video-admission-rules";
import { SETUP_STORAGE_BYTES, SETUP_VIDEO_SECONDS, standingOf, videoLimitFor } from "@/lib/plan-standing";
import { CLOSING_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS, closingOf } from "@/lib/plan-closing";
import { ENDED_STORE_EXPORTS, ERASE_WITHIN_DAYS, closesStore, keptRoomFor } from "@/lib/plan-closing-rules";
import { MAX_LEADS, listSize } from "@/lib/free";
import { readableSize } from "@/lib/product-file";
import {
  TRIAL_DAYS,
  isBillingConfigured,
  readSubscription,
  renewalInvoicePage,
  trialOffered,
} from "@/lib/billing";
import { STORAGE_BRAKE_BYTES, storageBrakeFor, storageUsed, storageWords } from "@/lib/storage-quota";
import { trafficForAdmission } from "@/lib/traffic";
import { CALL_ORDER_UNITS, TRIAL_ORDERS, ordersIncluded, ordersWords } from "@/lib/order-rules";
import { ordersIn } from "@/lib/orders";
import { BUYER_RESERVE_BPS, SETUP_VISITS, TRIAL_VISITS, countWords, publicVisitLimit, visitLimitFor, visitsIncluded, visitsWords } from "@/lib/traffic-rules";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { COMMISSION_LIVE, canUse, hasPro, PLAN_PRICES, PRO_MONTHLY_EMAILS, PRO_ON_SALE, REFUND_DAYS, SCALE_MONTHLY_EMAILS, priceWords, yearSaving } from "@/lib/plan";
import { ASSISTANT_ON_SALE, PLANS_ON_SALE } from "@/lib/opening";
import { studioPath, studioView } from "@/lib/studio-route";
import { unusedSummary } from "@/lib/closing-refunds";
import { holdCounts } from "@/lib/closing-holds";
import { CLOSING_CHECKOUT_SECONDS, lastPlanMoment } from "@/lib/closing-plan-guard";
import { type Permission, type Role, ROLE_NAMES, ROLE_SUMMARIES, can } from "@/lib/team-roles";
import { MAX_TEAM, readTeam } from "@/lib/team";
import { MAX_FUNNEL_STEPS } from "@/lib/funnel";
import { listPasskeys } from "@/lib/passkeys";
import { SESSION_COOKIE, isFreshSession } from "@/lib/auth";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { PasskeyManager } from "@/components/passkey-manager";
import { TwoStepManager } from "@/components/two-step-manager";
import { lockedUntil, twoStepStatus } from "@/lib/two-step";
import { RecoveryAddressManager } from "@/components/recovery-address-manager";
import { hideAddress, recoveryAddress } from "@/lib/recovery-address";
import { ResendPurchase } from "@/components/resend-purchase";
import { LeaveTeam } from "@/components/team-manager";
import { productSegment } from "@/lib/product-slug";
import { SharePanel } from "@/components/share-panel";
import { ShortLinks } from "@/components/short-links";
import { readLinks } from "@/lib/short-links";
import { storeBase } from "@/lib/purchase-email";
import { feeWords } from "@/lib/fee-words";
import { NewTab } from "@/components/new-tab";

/** "October 19": a day of a window, for the studio. */
const windowDay = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric" });

export const metadata: Metadata = {
  title: "Your account — Marktmorgen",
  robots: { index: false, follow: false },
};

const NEXT_WHEN_SELLING = [...(isDomainsConfigured() ? [] : ["Your own domain, on Pro"])];
/** One time on the creator's calendar, with everyone booked into it. */
type CallSlot = { key: string; product: Listing | undefined; start: number; people: PaidCall[] };

/**
 * Calls that have not ended yet, soonest first, one row per time: a group
 * call or a live session shows everyone booked into it together, and a
 * dated session nobody has booked yet is listed too, at nought seats.
 */
function upcoming(list: PaidCall[], products: Listing[]): CallSlot[] {
  const now = Date.now();
  const slots = new Map<string, CallSlot>();
  for (const call of list) {
    if (call.end <= now) continue;
    const key = `${call.product}|${call.start}`;
    const slot = slots.get(key) ?? { key, product: products.find((p) => p.id === call.product), start: call.start, people: [] };
    slot.people.push(call);
    slots.set(key, slot);
  }
  for (const product of products) {
    if (!product.call || product.call.kind !== "live") continue;
    for (const session of product.call.sessions) {
      const key = `${product.id}|${session.start}`;
      if (session.start + session.minutes * 60_000 > now && !slots.has(key)) {
        slots.set(key, { key, product, start: session.start, people: [] });
      }
    }
  }
  return [...slots.values()].sort((a, b) => a.start - b.start);
}

/** What went wrong with a booked time's Google Meet or Zoom meeting, in a sentence for the creator. */
function meetProblem(meeting: MeetRecord): string {
  const name = MEET_NAMES[meeting.provider];
  const what =
    meeting.todo === "patch"
      ? `The ${name} meeting could not be moved to the new time yet`
      : meeting.todo === "delete"
        ? `The ${name} meeting of this refunded booking could not be removed yet`
        : meeting.todo === "guests"
          ? `The ${name} guest list could not be updated yet`
          : `The ${name} link could not be made`;
  const who = meeting.group ? "Everyone booked was" : "They were";
  const fallback = roomKind(meeting.link) === "room" ? "a private video room" : "your own link";
  const given = meeting.made ? "" : meeting.link ? ` ${who} given ${fallback} instead.` : " Nobody was given a link: send one yourself.";
  const next = meeting.todo ? " We keep trying on our own for several hours." : "";
  return `${what}: ${meeting.error}.${given}${next}`;
}

const NEXT_WHEN_NOT = [
  "The checkout that pays into your account",
  "The list of what you have sold",
];

const PAYPAL_NOTICES: Record<string, { title: string; body: string }> = {
  ready: {
    title: "PayPal says your account can take payments",
    body: "Products PayPal can sell now show a PayPal button on your store, and the money goes straight to your PayPal account.",
  },
  forgotten: {
    title: "PayPal is off for your store",
    body: "Buyers can no longer pay with PayPal here. What was bought stays bought. To remove Marktmorgen's permissions from the account itself, do that in your PayPal settings.",
  },
  email: {
    title: "PayPal wants your email address confirmed first",
    body: "Open the email PayPal sent you, confirm your address, then connect again.",
  },
  receivable: {
    title: "PayPal says this account cannot receive payments yet",
    body: "Sign in to PayPal and finish what it asks for on your account, then connect again.",
  },
  permissions: {
    title: "The permissions were not granted",
    body: "PayPal did not record that you allowed Marktmorgen to take payments into your account. Connect again and accept on PayPal's page.",
  },
  id: {
    title: "PayPal did not finish connecting your account",
    body: "Nothing was changed. Connect again and go through every step on PayPal's page.",
  },
  unavailable: {
    title: "PayPal is not switched on here yet",
    body: "Nothing was changed.",
  },
  slow: {
    title: "That was a lot of tries in an hour",
    body: "Wait a while, then connect again.",
  },
  error: {
    title: "PayPal could not be reached",
    body: "Nothing was changed. Try again in a moment.",
  },
};

/** How connecting the store's Meta ad account went (lib/meta-routes.ts). */
const META_NOTICES: Record<string, { title: string; body: string }> = {
  paused_unpaid: {
    title: "Nothing was connected",
    body: `${INTEGRATION_PAUSED_WORDS.paused_unpaid} ${META_READ_PAUSED}`,
  },
  paused_disputed: {
    title: "Nothing was connected",
    body: `${INTEGRATION_PAUSED_WORDS.paused_disputed} ${META_READ_PAUSED}`,
  },
  connected: {
    title: "Your Meta ad account is connected",
    body: "Your numbers read what each campaign spent over the last 30 days, and read it again once a day. It is at the bottom of your numbers, under what you spent on ads.",
  },
  choose: {
    title: "Meta is connected: choose the ad account to read",
    body: "Your Meta login can read more than one ad account. Choose one at the bottom of your numbers, under what you spent on ads.",
  },
  disconnected: {
    title: "Meta ads are disconnected",
    body: "The permission was given back to Meta, and what was read from it was deleted. What you typed yourself stays.",
  },
  declined: {
    title: "Nothing was connected",
    body: "Meta's page was closed or canceled. Connect again when you are ready.",
  },
  permission: {
    title: "Meta did not give the permission to read your ads",
    body: "Nothing was kept. Connect again and leave “Read your ads” selected on Meta's page.",
  },
  accounts: {
    title: "Meta found no ad account to read",
    body: "The Facebook login you used cannot see any ad account. Nothing was kept. Connect again with the login that runs your ads.",
  },
  refused: {
    title: "Meta did not finish connecting",
    body: "Nothing was kept. Connect again in a moment.",
  },
  expired: {
    title: "That took too long",
    body: "For your safety a connection must be finished within ten minutes, in the same browser. Nothing was kept. Connect again.",
  },
  limited: {
    title: "That was a lot of tries",
    body: "Wait ten minutes, then connect again.",
  },
  busy: {
    title: "Meta could not be reached",
    body: "Nothing was kept. Try again in a moment.",
  },
  seal: {
    title: "Meta ads are not ready here yet",
    body: "Nothing was kept.",
  },
  error: {
    title: "Something went wrong",
    body: "Nothing was kept. Try again in a moment.",
  },
};

const STRIPE_NOTICES: Record<string, { title: string; body: string }> = {
  ready: {
    title: "Stripe says your account can take payments",
    body: "That is Stripe's answer, not ours. With your plan on, your store can take money now, and what you sell shows up further down this page.",
  },
  pending: {
    title: "Stripe still wants something from you",
    body: "Coming back here does not mean Stripe is satisfied. Open the connection again and finish what it asks for.",
  },
  forgotten: {
    title: "Disconnected on our side",
    body: "Your store cannot take payments until a Stripe account is connected again. Your Stripe account itself is untouched and still yours. To remove Marktmorgen from it as well, do that in your own Stripe dashboard.",
  },
  notstarted: {
    title: "There is no connection yet",
    body: "Start it below.",
  },
  nostore: {
    title: "Take your address first",
    body: "What you asked for belongs to a store, and there is no store yet. Nothing was changed.",
  },
  unavailable: {
    title: "Connecting is not switched on yet",
    body: "The platform side of Stripe is not configured, so nothing would happen. Nothing was changed.",
  },
  country: {
    title: "Stripe needs to know where you are",
    body: "Pick the country your bank account is in before connecting. It is fixed once the account is open, so it is worth a second's thought.",
  },
  "country-unsupported": {
    title: "Stripe will not open an account in that country from here",
    body: "Nothing was charged and nothing was created. This is a limit on our side, not a judgment on you: Stripe does not yet let a platform registered in our country open accounts in yours. Write to us and we will tell you honestly whether that is changing.",
  },
  error: {
    title: "Stripe did not answer as expected",
    body: "Nothing was changed. Try again in a moment.",
  },
};


/** Addresses made before the notices were spelled the American way, still understood. */
const BILLING_ALIASES: Record<string, string> = {
  cancelling: "canceling",
  cancelled: "canceled",
  "switch-cancelling": "switch-canceling",
};

const BILLING_NOTICES: Record<string, { title: string; body: string }> = {
  on: {
    title: "You are subscribed",
    body: "Your store can take money as soon as your Stripe account is connected and cleared, if it is not already. If your plan started with a free trial, nothing is charged until the trial ends. You can cancel on this page at any time.",
  },
  canceling: {
    title: "Canceled",
    body: "Nothing more will be charged. Your store keeps taking payments until the date below, and you can change your mind on this page until then.",
  },
  resumed: {
    title: "Your subscription continues",
    body: "The cancellation is undone. Nothing else changed.",
  },
  none: {
    title: "There is no subscription to change",
    body: "This store has not started one, so there is nothing to cancel.",
  },
  ended: {
    title: "This subscription has already ended",
    body: "Stripe says it is over, so there was nothing left to cancel and nothing was charged.",
  },
  "cancel-error": {
    title: "We could not confirm the change",
    body: "Check your billing status before trying again. The subscription may have changed.",
  },
  pending: {
    title: "Stripe has not confirmed the payment yet",
    body: "The subscription exists but is not in good standing yet. Reload this page in a moment; nothing here was lost.",
  },
  canceled: {
    title: "Nothing was started",
    body: "You closed the payment page. No card was charged and your store is exactly as you left it.",
  },
  unfinished: {
    title: "That did not finish",
    body: "Stripe has no completed subscription for this store, so nothing was written down. Start it again below.",
  },
  "switched-year": {
    title: "You now pay yearly",
    body: "The change is made at Stripe. The date below is when the next charge is due, and it is the only one for a year.",
  },
  "switched-tier-pro": {
    title: "You are on Pro",
    body: `Email to your list is on, up to ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} a month. Open Email, below your products, to write one.`,
  },
  "switched-tier-scale": {
    title: "You are on Scale",
    body: `Your list can now be sent up to ${SCALE_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month, from today. Nothing else in your store changed.`,
  },
  "switched-tier-creator": {
    title: "You are back on the Marktmorgen plan",
    body: "Email to your list is off from now, and so is your own domain if you set one up. What is left of what you paid for Pro is kept as credit on your account and pays your next charges until it runs out.",
  },
  "switched-month": {
    title: "You now pay monthly",
    body: "The change is made at Stripe. What was left of the year you paid for is kept as credit on your account, and it pays your monthly charges until it runs out.",
  },
  same: {
    title: "Nothing to change",
    body: "You are already billed that way.",
  },
  "switch-canceling": {
    title: "Your subscription is set to stop",
    body: "Keep it first, with the button below, and then choose how often to pay. Nothing was changed.",
  },
  "switch-standing": {
    title: "This subscription cannot be changed right now",
    body: "Stripe says it is not in good standing, so nothing was changed.",
  },
  "switch-pending": {
    title: "A change is already waiting on your bank",
    body: "Stripe is waiting for a payment to go through before it switches you. Nothing else was changed.",
  },
  "switch-error": {
    title: "Stripe did not answer",
    body: "Nothing changed and nothing was charged. Try again in a moment.",
  },
  paused: {
    title: "Your break is set",
    body: "Your store keeps taking payments until the date below, and then nothing is charged until your plan starts again by itself. We have emailed you the dates, and will write a week before.",
  },
  "pause-undone": {
    title: "The break is off",
    body: "Your plan goes on as before, and the break was not counted. Nothing was charged.",
  },
  "pause-dropped": {
    title: "Your plan will not start again by itself",
    body: "Start it below whenever you want to sell again. Nothing was charged.",
  },
  "pause-trial": {
    title: "A break comes after the trial",
    body: `It is for a plan that has been paid for at least ${PAID_MONTHS_BEFORE_PAUSE} months. Nothing was changed.`,
  },
  "pause-early": {
    title: "Not yet",
    body: `A break is for a plan that has been paid for at least ${PAID_MONTHS_BEFORE_PAUSE} months. Nothing was changed.`,
  },
  "pause-yearly": {
    title: "A yearly plan has no break",
    body: "The year is already paid for, so there is nothing to stop. Nothing was changed.",
  },
  "pause-canceling": {
    title: "Your subscription is already set to stop",
    body: "Keep it first, with the button below, and then choose a break. Nothing was changed.",
  },
  "pause-pending": {
    title: "A change is already waiting on your bank",
    body: "Take a break once it has gone through. Nothing was changed.",
  },
  "pause-recent": {
    title: "One break a year",
    body: "This store has taken its break in the last twelve months. You can still cancel. Nothing was changed.",
  },
  "pause-card": {
    title: "There is no card to start your plan again on",
    body: "Update your card at Stripe first, then take the break. Nothing was changed.",
  },
  "pause-standing": {
    title: "This subscription cannot take a break right now",
    body: "Stripe says it is not in good standing. Nothing was changed.",
  },
  "pause-unavailable": {
    title: "Plan breaks are not available",
    body: "No break or restart was requested. You can still cancel your subscription and keep access through the period you paid for.",
  },
  "pause-error": {
    title: "We could not confirm the break",
    body: "Check your billing status before trying again. The break or subscription may have changed.",
  },
  "pro-closed": {
    title: "That plan is not open yet",
    body: "Nothing was charged and nothing was changed.",
  },
  closing: {
    title: "Your store is closing today",
    body: "Its closing day has begun: its memberships have ended and it is being removed, so a plan can no longer be started for it. Nothing was charged. You can open a new store from your account.",
  },
  "closing-returned": {
    title: "Your store's closing day had begun, so your payment was returned",
    body: "The plan was paid for after your store's closing day began, so it could not keep the store. We ended the plan and returned the payment in full. Nothing else will be charged. We emailed you the same.",
  },
  "closing-returned-early": {
    title: "Your plan came too late to stop your store's closing, so your payment was returned",
    body: "The plan went through just before your store's closing day began, too late to stop the closing, which had already started. So it could not keep the store. We ended the plan and returned the payment in full. Nothing else will be charged. We emailed you the same.",
  },
  "closing-returning": {
    title: "Your plan came too late to keep your store, so your payment is being returned",
    body: "The plan reached us too late to stop your store's closing, so it could not keep the store. We are ending the plan and returning the payment in full, and we email you once it is done. Nothing else will be charged.",
  },
  "closing-late": {
    title: "It is too late to start a plan for this store",
    body: "A plan can keep a store only if it is started before the last moment shown under \"Your plan has ended\" below, so that its checkout ends before the closing day begins. That moment has passed. Nothing was charged. You can open a new store from your account.",
  },
  "not-open": {
    title: "Plans are not on sale yet",
    body: "Marktmorgen is still being built, so no plan can be started. Nothing was charged and nothing was changed.",
  },
  already: {
    title: "You already pay for this store",
    body: "There is nothing to start. One store, one subscription.",
  },
  unconfirmed: {
    title: "Stripe has not confirmed it yet",
    body: "Stripe did not answer as you came back. If you finished paying, it is written down here within a day, and pressing start again does not charge you twice: it finds the subscription you already have.",
  },
  unavailable: {
    title: "Paying is not switched on yet",
    body: "Our side of Stripe is not configured, so nothing would happen. Nothing was changed.",
  },
  error: {
    title: "Stripe did not answer as expected",
    body: "Nothing was charged. Try again in a moment.",
  },
};

const ADDRESS_NOTICES: Record<string, { title: string; body: string }> = {
  sent: {
    title: "Check the new address",
    body: "We sent a link there. Opening it and tapping the button finishes the move. Nothing has changed yet, and the old address stays in charge until it does.",
  },
  moved: {
    title: "Your account moved",
    body: "This address logs you in from now on. Every session the old one had open is closed.",
  },
  same: {
    title: "That is the address you already use",
    body: "Nothing to move.",
  },
  invalid: {
    title: "That does not look like an email address",
    body: "Check it and try again.",
  },
  locked: {
    title: "Your sign-in address cannot change yet",
    body: "You got in without your second step, so moving the account waits until two-step login turns off. The date is above.",
  },
  taken: {
    title: "That address already has a store",
    body: "An account cannot be moved on top of another one.",
  },
  none: {
    title: "There is no store to move yet",
    body: "Take your address first. Until then, simply log in with whichever email you prefer.",
  },
  reauth: {
    title: "Log in again first",
    body: "Moving your account needs a login from the last 15 minutes. Log out, log in again, and ask once more. Nothing was changed.",
  },
  limited: {
    title: "Too many attempts for that address",
    body: "Wait an hour and try again.",
  },
  unavailable: {
    title: "Moving is not available right now",
    body: "Sending is not configured. Nothing was changed.",
  },
  error: {
    title: "Something went wrong on our side",
    body: "Nothing was changed. Try again in a moment.",
  },
};

const TEAM_NOTICES: Record<string, { title: string; body: string }> = {
  forbidden: {
    title: "Your role on this store does not include that",
    body: "Nothing was changed. The store's owner decides each person's role, on the Team page.",
  },
  gone: {
    title: "That store is not one you can open",
    body: "It was deleted, or you are no longer on its team. Here is a store you can open.",
  },
  joined: {
    title: "You joined the team",
    body: "This store is open in your studio with your role. Switch between stores from the top of the page.",
  },
  left: {
    title: "You left that store's team",
    body: "It is no longer in your studio. The owner can invite you again.",
  },
};

const STORES_NOTICES: Record<string, { title: string; body: string }> = {
  deleted: {
    title: "The store was deleted",
    body: "Its addresses answer nothing for 30 days, and then anyone may take them. Your other stores are as they were.",
  },
  confirm: {
    title: "Type the store's address to delete it",
    body: "Nothing was deleted: the address typed did not match this store's.",
  },
  products: {
    title: "A store with products cannot be deleted",
    body: "Its buyers may come back to it. Remove its products first. Nothing was deleted.",
  },
  paying: {
    title: "This store still has a plan running",
    body: "Cancel its plan below, and delete it once the plan has ended. Nothing was deleted.",
  },
  domain: {
    title: "This store still has its own domain",
    body: "Remove the domain first. Nothing was deleted.",
  },
  first: {
    title: "An account's first store cannot be deleted",
    body: "It is the home of your account. Nothing was deleted.",
  },
  error: {
    title: "Something went wrong on our side",
    body: "Nothing was deleted. Try again in a moment.",
  },
};

/** Comments under each course's lessons since the creator last opened that course's studio page. */
async function newCommentsFor(products: { id: string; course?: { id: string } | null }[]): Promise<Record<string, number>> {
  const courses = products.filter((p) => p.course).map((p) => [p.id, p.course!.id] as const);
  if (!courses.length) return {};
  const counts = await freshCounts(courses.map(([, c]) => c)).catch(() => new Map<string, number>());
  return Object.fromEntries(courses.map(([product, c]) => [product, counts.get(c) ?? 0]));
}

/** The products a store-wide sale can cover (lib/store-sale.ts), by title, for the sale's picker. */
async function saleCandidates(store: Store): Promise<{ id: string; title: string }[]> {
  const ids = store.catalog.items
    .filter((item) => (item.kind & KIND.paid) !== 0 && (item.kind & (KIND.call | KIND.recurring | KIND.hidden)) === 0 && item.options.length === 0)
    .map((item) => item.id);
  if (!ids.length) return [];
  const listings = await readListings(store, ids).catch(() => []);
  return listings.filter(saleable).map((p) => ({ id: p.id, title: p.title }));
}

/**
 * The store's published products by name, in its order: what a product's
 * "Goes well with" can pick (lib/store-collections.ts). One read of the
 * cards, whatever the store's size (lib/catalog.ts, readCards).
 */
async function publishedChoices(store: Store): Promise<{ id: string; title: string }[]> {
  const cards = await readCards(store).catch(() => new Map<string, { title: string }>());
  return store.catalog.items
    .filter((item) => (item.kind & KIND.hidden) === 0)
    .map((item) => ({ id: item.id, title: cards.get(item.id)?.title ?? "" }))
    .filter((p) => p.title);
}

/** Memberships that can be tiers: running until canceled, at one price (lib/tier-rules.ts). */
async function tierCandidates(store: Store): Promise<{ id: string; title: string; words: string }[]> {
  const ids = store.catalog.items
    .filter((item) => (item.kind & KIND.recurring) !== 0 && (item.kind & KIND.hidden) === 0 && item.options.length === 0)
    .map((item) => item.id);
  if (!ids.length) return [];
  const listings = await readListings(store, ids).catch(() => []);
  return listings.filter(canTier).map((p) => ({ id: p.id, title: p.title, words: tierWords(store, p) }));
}

/** Now, in seconds: which links still work. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The first and last days the numbers' chart can show, in UTC: the 90 days up to today. */
function chartDays(): [string, string] {
  const now = Date.now();
  return [new Date(now - 89 * 86_400_000).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)];
}

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const cookieStore = await cookies();
  const params = await searchParams;
  // Which store, and in what role (lib/studio-route.ts): the one this page was
  // asked for, else the one last chosen, else the person's own first store.
  const found = await studioView(cookieStore, typeof params.store === "string" ? params.store : undefined, null);
  if (!found.ok && found.reason === "signed_out") redirect("/signin");
  const view = found.ok ? found.view : null;
  const email = view?.email ?? (found.ok ? "" : (found.email ?? ""));
  const role: Role = view?.role ?? "owner";
  /** Whether this person's role on this store has a permission (lib/team-roles.ts). */
  const may = (permission: Permission) => can(role, permission);
  const ref = view?.ref ?? "";

  const loaded = view?.store ?? null;
  // A store from before visits were counted gets its counter the first time
  // its studio is opened.
  const store = loaded && !loaded.statsId ? ((await ensureStatsId(ref)) ?? loaded) : loaded;
  const folder = store ? await storeFolder(ref) : "";
  const pictures = store ? await imageFolder(ref) : "";
  /** Carried on the forms below that post to the studio's routes, so each acts on this store. */
  const pin = store?.sid ? `?store=${store.sid}` : "";
  // The writing help, and what is left of it this month: read once for the whole studio page.
  const ai = store && aiAvailableFor(store) ? { on: true, left: await aiLeft(store).catch(() => 0) } : { on: false, left: 0 };
  const notice =
    ADDRESS_NOTICES[typeof params.address === "string" ? params.address : ""] ??
    STRIPE_NOTICES[typeof params.stripe === "string" ? params.stripe : ""] ??
    PAYPAL_NOTICES[typeof params.paypal === "string" ? params.paypal : ""] ??
    META_NOTICES[typeof params.metaads === "string" ? params.metaads : ""] ??
    BILLING_NOTICES[BILLING_ALIASES[String(params.billing)] ?? (typeof params.billing === "string" ? params.billing : "")] ??
    TEAM_NOTICES[typeof params.team === "string" ? params.team : ""] ??
    STORES_NOTICES[typeof params.stores === "string" ? params.stores : ""] ??
    (found.ok && found.fellBack ? TEAM_NOTICES.gone : undefined);
  // The snapshot the public store page trusts is refreshed here, because this
  // is the page the creator opens and therefore the moment they would notice
  // it being wrong. A store that never started a subscription is not asked
  // about, and neither is one on a deployment with no billing configured.
  const live =
    store?.subscriptionId && isBillingConfigured()
      ? await readSubscription(store.subscriptionId)
      : null;
  // "unknown" means Stripe could not be asked, which is not the same as not
  // paying. The snapshot stands rather than closing a paying creator's till
  // over a network blip.
  const paid =
    live && live.state !== "unknown"
      ? live.state === "active"
      : Boolean(store?.subscriptionActive);
  const plan =
    live?.state === "active"
      ? { tier: live.tier, cycle: live.cycle, trialEnds: live.trialing ? live.until : 0, shared: live.shared, period: live.period, renewalUnpaid: live.renewalUnpaid === true }
      : null;
  let written: Awaited<ReturnType<typeof setSubscription>> = null;
  if (
    store &&
    live &&
    live.state !== "unknown" &&
    (paid !== store.subscriptionActive ||
      (plan && (plan.tier !== store.tier || plan.cycle !== store.cycle || plan.trialEnds !== store.trialEnds || plan.shared !== store.shared || !samePeriod(plan.period, store.period ?? null) ||
        plan.renewalUnpaid !== (store.renewalUnpaidSince ?? 0) > 0)))
  ) {
    written = await setSubscription(ref, { active: paid, ...(plan ?? {}) });
  }
  // Everything below reads this, not the record we loaded, so one page never
  // shows two different answers to the same question. A renewal Stripe could
  // not collect is dated as the store's record dates it (lib/store.ts); on
  // this page it is unpaid even if that write did not go through.
  const recordedSince = (written ?? store)?.renewalUnpaidSince ?? 0;
  const unpaidSince = plan ? (plan.renewalUnpaid ? Math.max(1, recordedSince) : 0) : paid ? recordedSince : 0;
  const current = store ? { ...store, subscriptionActive: paid, ...(plan ?? {}), renewalUnpaidSince: unpaidSince } : null;
  // Stripe's own page that pays an unpaid renewal, read fresh on each load (232 [CA1] unit 4).
  const renewalPage = current && unpaidSince > 0 && store?.subscriptionId && isBillingConfigured() ? await renewalInvoicePage(store.subscriptionId) : null;
  const trialing = live?.state === "active" && live.trialing;
  // The trial is once per store. A store starting again is told, on every
  // button, that it pays from today — the same rule the checkout opens with.
  const withTrial = store ? trialOffered(store) : true;
  // One of an account's other stores that has never had a plan: it is not
  // "starting again", it starts for the first time, without the trial that
  // belongs to the account's first store (lib/billing.ts, trialOffered).
  const extraFirstPlan = Boolean(store?.extra && !store.stripeCustomerId && !store.subscriptionId);
  // Read from Stripe on this page load. When Stripe could not be asked, the
  // cancel button still shows: the route asks again before it does anything.
  const cancelling = live?.state === "active" && live.cancelsAtEnd;
  // How this creator is billed, and what the other way would cost them.
  const billedYearly = live?.state === "active" ? live.cycle === "year" : current?.cycle === "year";
  // A store that has sold sees the yearly plan offered open, not folded away
  // (lib/yearly-offer.ts). One read, and only for a monthly plan.
  const firstSale = store && paid && !billedYearly ? await firstSaleAt(store) : 0;
  // A break the creator chose (lib/plan-pause.ts): set and not yet begun on
  // this subscription, or begun, with the plan starting again on its day.
  const pauseObservation = store && isBillingConfigured() ? await pauseView(store) : { kind: "missing" as const };
  const pause = pauseObservation.kind === "known" ? pauseObservation.record : null;
  const pauseUnknown = pauseObservation.kind === "unknown";
  const pauseSet = Boolean(pause && store && pause.subscription === store.subscriptionId && paid);
  const onBreakNow = Boolean(pause && !paid && breakRunning(pause));
  const breakDay = (seconds: number) =>
    new Date(seconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const tier = current?.tier ?? "creator";
  // The store's own domain: shown where this deployment can add one, and its
  // records read from Vercel only while it is not yet live.
  const domainsOn = isDomainsConfigured();
  const domainNow =
    domainsOn && store?.domain && !store.domain.liveAt && paid && hasPro(tier)
      ? await domainStatus(store.domain.name, store).catch(() => null)
      : null;
  const billedNow =
    live?.state === "active" && live.amountCents > 0
      ? `$${live.amountCents % 100 ? (live.amountCents / 100).toFixed(2) : live.amountCents / 100} a ${live.cycle}`
      : priceWords(tier, billedYearly ? "year" : "month");
  const changePending = live?.state === "active" && live.changePending;
  // The way to the plan refund's review page (305 [SY1]): for the owner of a paid plan that may have one today, a
  // yearly plan or a period begun within the guarantee's days. The page itself reads the exact amount, or says why
  // there is none, before anything changes.
  const refundOffered = Boolean(store && paid && !trialing && role === "owner" && current?.period &&
    (billedYearly || nowSeconds() - current.period.start < REFUND_DAYS * 86_400));
  const refundLink = refundOffered && store ? (
    <p className="mt-4 text-sm text-ink-soft">
      <Link href={studioPath(store, "", "refund")} className="font-bold text-ink underline underline-offset-2">
        Refund my payment
      </Link>
      {" "}— see the exact amount and what happens to your store before anything changes.
    </p>
  ) : null;
  const endsOn =
    live?.state === "active" && live.until > 0
      ? new Date(live.until * 1000).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        })
      : null;

  // Only asked for when there is a store that can actually have sold
  // something, so a creator who has not connected Stripe never waits on a
  // request that could only come back empty.
  // What each part below reads is only read for a role that is shown it
  // (lib/team-roles.ts), so nothing a role may not see reaches the page.
  const sold =
    current && current.stripeAccountId && may("orders") ? await listSales(current) : null;

  // What this store has sent out this month, and how long its lesson video
  // was watched: the one thing here that is charged by use, visible to the
  // creator before it is visible on an invoice (lib/watch-rules.ts).
  // Counted in the store's window: its billing month when it pays us, the
  // calendar month otherwise (lib/allowance-window.ts). The page reads the
  // record as refreshed above, so a period just read from Stripe is used.
  const usageWindow = current ? allowanceWindow(current) : null;
  const usageId = usageWindow?.id ?? calendarWindow().id;
  const [delivery, watchedReading, trafficReading] = await Promise.all([
    store && may("settings") ? deliveredThisMonth(folder) : Promise.resolve(null),
    store && may("settings") ? watchedForAdmission(folder, usageId) : Promise.resolve(null),
    store && may("settings") ? trafficForAdmission(folder, usageId) : Promise.resolve(null),
  ]);
  const watched = watchedReading ?? 0;
  // Where the store stands with its plan decides how much it may keep and
  // how long its video may be watched (lib/plan-standing.ts).
  const standing = store ? standingOf(store) : "none";
  const videoLimit = store ? videoLimitFor(store) : null;
  const videoRoom = videoLimit ?? paidVideoSeconds();
  // The visits the store has had this month, the other thing charged by use
  // (lib/traffic-rules.ts): what the plan covers, and where the pages of a
  // store with no plan to charge rest.
  const traffic = trafficReading ?? { people: 0, parts: 0, visits: 0 };
  const visited = traffic.visits;
  // The part of the count that is the live room (lib/traffic-rules.ts), in whole visits.
  const roomVisits = traffic.visits - traffic.people;
  const visitLimit = store ? visitLimitFor(store) : null;
  const visitRoom = visitLimit ?? (store ? visitsIncluded(store.tier) : 0);
  // The orders counted this month, the third thing charged by use (lib/order-rules.ts).
  const ordered = store && may("settings") ? await ordersIn(folder, usageId) : 0;
  // What the store has taken of each of its other figures in the window (lib/store-allowance.ts).
  const figures = current && may("settings")
    ? await Promise.all(ALLOWANCE_KINDS.map(async (kind) => ({ kind, used: await allowanceUsed(current, kind), limit: allowanceFor(current, kind) })))
    : null;
  // How full the store's data room is (lib/store-data.ts), and what its orders keep of it.
  const data = current && may("settings") ? await dataUsed(current).catch(() => null) : null;
  const orderRoom = standing === "paid" && store ? ordersIncluded(store.tier) : TRIAL_ORDERS;
  // A store whose plan has ended and that keeps more than a store with no
  // plan may: the day what it keeps is removed, counted the way the daily
  // job counts it (lib/plan-closing.ts). Measured only for such a store.
  const closingAt = store && standing === "ended" && may("settings") ? await closingOf(store).catch(() => null) : null;
  const keptNow = closingAt ? (await storageUsed(folder, SETUP_STORAGE_BYTES)).bytes : 0;
  // What it may keep with no date: none for a plan ended from 18 October 2026 (lib/plan-closing-rules.ts).
  const keptRoom = closingAt ? keptRoomFor(closingAt.endedAt) : 0;
  // A plan ended from 18 October 2026 closes the whole store on that day, files or none (lib/plan-closing-rules.ts, closesStore).
  const closesWhole = closingAt ? closesStore(closingAt.endedAt) : false;
  const closing = closingAt && (closesWhole || keptNow > keptRoom) ? { ...closingAt, bytes: keptNow, room: keptRoom, whole: closesWhole } : null;
  // Queue item 307 [EC1]: what members paid for past the closing day, from what was written down when the plan ended (no call to Stripe).
  const unusedTime = closing?.whole ? await unusedSummary(store!, closing.day).catch(() => null) : null;
  const notPaused = closing?.whole ? await holdCounts(folder).catch(() => null) : null;
  const dayWords = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  /** A moment to the minute, in UTC, said so. */
  const momentWords = (ms: number) => `${new Date(ms).toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;
  // The list is shown once there is something that fills it, or once it holds
  // anybody — a creator who stops giving things away still owns what came in.
  const list = store && may("export") ? await listSize(store) : null;
  const givesAway = store ? sellsAny(store, "free") : false;
  // Booked calls are read from the creator's Stripe account, the ledger, and
  // only asked for when the store sells calls at all.
  const callProducts = store ? await readKind(store, "call") : [];
  const paidList =
    current && current.stripeAccountId && callProducts.length > 0 && may("orders")
      ? await paidCalls(current).catch(() => null)
      : null;
  const calls = paidList && store ? upcoming(paidList, callProducts) : null;
  // The room of each booked time: the one made for it, or the creator's own link.
  const callRooms =
    calls && store ? await slotRooms(store, calls.flatMap((slot) => slot.people), callProducts).catch(() => null) : null;
  // Google Calendar and Zoom (lib/meet-connect.ts): which accounts calls can
  // make meetings on, for the call editor, and what was made for each booked
  // time, for the list below. Nothing is read when the deployment has neither.
  // Read whenever the deployment has either app: an account connected while
  // it was offered stays in sight even once it is not (lib/meet-connect.ts).
  const meetOn = store ? configuredProviders().length > 0 : false;
  // Somebody who opened the link in Zoom's Marketplace listing before logging
  // in came to connect Zoom (lib/zoom-arrival.ts): it is offered here too,
  // and the way to it is said at the top of the studio.
  const arrivedZoom = cameForZoom(cookieStore) && isConfigured("zoom");
  const meet: MeetView | null =
    store && meetOn && (may("products") || may("orders")) ? await meetView(store.statsId, store, arrivedZoom).catch(() => null) : null;
  const meetAccounts = meet
    ? meet.providers.flatMap((p) => {
        const c = meet.connected[p];
        return c && !c.broken ? [{ provider: p, account: c.account }] : [];
      })
    : [];
  const callMeets: Map<string, MeetRecord> | null =
    calls && store && meetOn
      ? await slotMeetings(
          store.callsId,
          calls.map((slot) => ({
            key: slot.key,
            product: slot.key.split("|")[0],
            start: slot.start,
            session: slot.people.length === 1 ? slot.people[0].session : null,
          })),
        ).catch(() => null)
      : null;
  // The creator's calendars: the private subscription address is made the
  // first time there is a call to put in it, and the busy times are read (from
  // the ten-minute copy, usually) to point out a dated session that clashes.
  if (current && callProducts.length > 0 && may("settings")) await ensureFeedToken(current).catch(() => {});
  const apiKeys = current && may("export") ? await listKeys(current.sid).catch(() => []) : null;
  const [calendar, calendarBusyTimes, hooks] = current
    ? await Promise.all([
        callProducts.length > 0 && may("settings") ? calendarView(current).catch(() => null) : Promise.resolve(null),
        callProducts.some((p) => p.call?.kind === "live") && may("orders")
          ? calendarBusy(current).then((r) => r.busy, () => [])
          : Promise.resolve([]),
        may("settings") ? webhooksView(current).catch(() => null) : Promise.resolve(null),
      ])
    : [null, [], null];
  if (current) after(() => keepHandle(current));
  // A buyer who paid and never came back from Stripe still gets their email,
  // and so does the creator, the next time the creator looks.
  if (current && paidList && paidList.length) after(() => catchUpBookings(current, paidList, SITE_URL));
  // Visits from Redis and sales from the creator's Stripe, read side by side,
  // with the creator's own notes on the chart and what they spent on ads.
  const [visits, salesRead, statsNotes, adSpends, heardIsOff, trouble, autoMarks] = current && may("stats")
    ? await Promise.all([
        readStats(current).catch(() => null),
        readsSales(current)
          ? readSales(current).then(
              (value) => ({ state: "ok" as const, value }),
              () => ({ state: "error" as const, value: null }),
            )
          : Promise.resolve({ state: "none" as const, value: null }),
        readNotes(current.statsId).catch(() => []),
        readSpends(current.statsId).catch(() => []),
        heardOff(current.handle).catch(() => false),
        readTrouble(current.statsId).catch(() => ({ week: 0, last: null })),
        // What the store recorded on its own: emails sent, products added, sales (lib/auto-marks.ts).
        readMarks(current, ...chartDays()).catch(() => []),
      ])
    : [null, null, [], [], false, { week: 0, last: null }, []];
  const statListings = current && visits && salesRead ? await readListings(current, [...new Set([...productsInStats(current, visits, salesRead.value), ...reachProducts(visits)])]) : [];
  const counted =
    current && visits && salesRead
      ? studioStats(current, visits, salesRead.value, salesRead.state, statListings)
      : null;
  // Its rates beside those of stores its size (lib/benchmarks.ts): this page's numbers are kept as the
  // week's sample after it is sent, and the ranges, worked out once a day, are one read.
  if (current && counted) after(() => recordSample(current, counted));
  const beside = counted ? compare(sampleFrom(counted), (await readRanges().catch(() => null))?.ranges ?? null) : null;
  // The biggest buyers carry their addresses, so only whoever may read orders
  // with the buyer's address sees them (lib/team-roles.ts, "orders").
  const numbers = counted && may("orders") ? { ...counted, topBuyers: salesRead?.value?.buyers?.top ?? [] } : counted;
  // The list of products: all of a short one, a page of a long one, found by
  // name when the creator searched (lib/catalog.ts reads only that page in full).
  const shelf = store ? await studioShelf(store, params) : null;
  // Asked of Stripe each time, because the setup is the creator's and lives there.
  // Stripe's answers about the creator's own account, asked side by side: the
  // tax setup, the ways to pay it offers, and the currencies it can charge in.
  // All three are settings (lib/team-roles.ts): only read for a role that has them.
  const [tax, ways, currencies] = current?.stripeAccountId && may("settings")
    ? await Promise.all([
        taxStatus(current),
        readWaysToPay(current),
        chargeableCurrencies(current).catch(() => null),
      ])
    : [null, { state: "none" as const }, null];
  // The person's own passkeys, and — for the owner — how many are on the team.
  // Adding a passkey needs a login from the last fifteen minutes (lib/auth.ts).
  const [passkeys, team, freshLogin, lockedTill, twoStep, recoveryShown] = await Promise.all([
    email ? listPasskeys(email).catch(() => []) : Promise.resolve([]),
    store?.sid && may("team") ? readTeam(store.sid).catch(() => null) : Promise.resolve(null),
    isFreshSession(cookieStore.get(SESSION_COOKIE)?.value).catch(() => false),
    // Whether this browser got in without its second step, and until when what matters is locked (lib/two-step.ts).
    lockedUntil(cookieStore.get(SESSION_COOKIE)?.value).catch(() => 0),
    // The person's two-step login (lib/two-step.ts), beside their passkeys.
    email ? twoStepStatus(email).catch(() => ({ on: false, since: 0, codesLeft: 0, reset: 0, backup: "" })) : Promise.resolve({ on: false, since: 0, codesLeft: 0, reset: 0, backup: "" }),
    // The person's recovery address, partly hidden (lib/recovery-address.ts).
    email ? recoveryAddress(email).then((a) => (a ? hideAddress(a) : "")).catch(() => "") : Promise.resolve(""),
  ]);
  const connectReady = isConnectConfigured();
  const billingReadyForSteps = isBillingConfigured();
  // The first steps of a store, each ticked from what the store really has.
  const startSteps: StartStep[] = store
    ? [
        { key: "address", title: "Your address", hint: `marktmorgen.com/@${store.handle} is yours.`, done: true, href: "#details" },
        { key: "details", title: "Say what your store is", hint: "One line under your name tells a visitor why they are here.", done: Boolean(store.bio), href: "#details" },
        { key: "look", title: "Add your photo and color", hint: "A face and a color make the page yours.", done: Boolean(store.photoId), href: "#look" },
        { key: "product", title: "Prepare your first offer", hint: "Keep an AI draft or add one yourself; add the delivery and review its terms.", done: productCount(store) > 0, href: productCount(store) === 0 && ai.on ? "#setup-ai" : "#products" },
        { key: "publish", title: "Publish your first offer yourself", hint: "Review the product, delivery, price and buyer terms, then choose Publish. Publishing does not open paid selling while sales gates are closed.", done: visibleCount(store) > 0, href: "#products" },
        ...(connectReady
          ? [{ key: "stripe", title: "Connect your Stripe account", hint: "Where your buyers' money goes: yours, not ours.", done: store.stripeChargesEnabled, href: "#stripe" }]
          : []),
        ...(billingReadyForSteps && (PLANS_ON_SALE || paid)
          ? [{ key: "plan", title: "Turn on your checkout", hint: withTrial ? `Free for ${TRIAL_DAYS} days, and nothing is charged today.` : `${priceWords("creator", "month")}, from today.`, done: paid, href: "#billing" }]
          : []),
        ...(connectReady && store.stripeChargesEnabled
          ? [
              {
                key: "test",
                title: "Buy it once yourself",
                hint: "One purchase on your own page proves the whole path: the card, your Stripe account and the file.",
                done: sold?.state === "ok" && sold.sales.length > 0,
                href: `/@${store.handle}`,
              },
            ]
          : []),
        // A way back in that needs no email, for the day the sign-in inbox is lost (lib/recovery-address.ts).
        ...(role === "owner"
          ? [{ key: "recovery", title: "Keep a way back in", hint: "A recovery address or a passkey: if you ever cannot open your email, either lets you straight back in.", done: Boolean(recoveryShown) || passkeys.length > 0, href: "#account-recovery" }]
          : []),
        { key: "share", title: "Share your address", hint: "Put it in your bio. This checks itself off when your first visitor arrives.", done: (numbers?.totals.d30.visitors ?? 0) > 0, href: "#details" },
      ]
    : [];
  const connectTestMode = isConnectInTestMode();
  const billingReady = isBillingConfigured();
  const NEXT = connectReady ? NEXT_WHEN_SELLING : NEXT_WHEN_NOT;

  return (
    <div className="min-h-screen bg-paper text-ink">
      {store && view ? (
        <StudioHeader
          current={store}
          role={role}
          stores={view.stores}
          owned={view.owned}
          action={{ href: `/@${store.handle}`, label: role === "owner" ? "View my store" : "View the store", short: "Store", icon: "arrow-up-right" }}
        />
      ) : (
        <header className="sticky top-0 z-40 border-b border-line bg-white/90 backdrop-blur-xl">
          <div className="container-page flex h-16 items-center justify-between gap-2 sm:gap-3">
            <Link href="/" className="shrink-0 rounded-[10px]" aria-label="Marktmorgen, home">
              <Logo />
            </Link>
            <span className="hidden max-w-[16rem] truncate text-sm text-ink-mute md:inline">{email}</span>
          </div>
        </header>
      )}

      <StudioStorePin sid={store?.sid ?? ""}>
      <main id="content" className="container-page pb-20 pt-10 sm:pt-14 [overflow-wrap:anywhere] [&_details:not([open])>:not(summary)]:hidden">
        <p className="eyebrow">Studio</p>
        <h1 className="t-h2 mt-3 break-words">
          {!store ? "You are logged in" : role === "owner" ? (view && view.owned > 1 ? store.name : "Your store") : store.name}
        </h1>
        {store && role !== "owner" ? (
          <p className="mt-3 text-ink-soft">
            {"As "}
            <strong className="text-ink [overflow-wrap:anywhere]">{email}</strong>
            {`, ${ROLE_NAMES[role]} on this store. ${ROLE_SUMMARIES[role]}`}
          </p>
        ) : (
          <p className="mt-3 text-ink-soft">
            As <strong className="text-ink [overflow-wrap:anywhere]">{email}</strong>. No password was
            created, and none is stored.
          </p>
        )}

        {/* A request to turn two-step login off without a code (lib/two-step.ts askReset), shown to every logged-in browser. */}
        {lockedTill > 0 ? (
          <div className="notice notice-warn mt-6" role="status">
            <p className="font-bold text-ink">{`Some things are locked until ${new Date(lockedTill).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}`}</p>
            <p className="mt-1 text-sm text-ink-soft">
              You got in through your recovery address or without your second step, so payments, your plan, your team, exports, settings, sending to your list, your sign-in address, passkeys and two-step login wait until then. Everything else is open: your products, pages, buyers, numbers and drafts. On that day nothing is locked any more, and you can move your sign-in address to an inbox you have. Logging in with your sign-in email, a passkey or your app&apos;s code before then opens everything at once.
            </p>
          </div>
        ) : twoStep.reset > 0 ? (
          <div className="notice notice-warn mt-6" role="status">
            <p className="font-bold text-ink">Two-step login is set to turn off</p>
            <p className="mt-1 text-sm text-ink-soft">
              {`Somebody who opened a login link was let in without the second step, saying the phone, the recovery codes, the passkeys and the recovery address are all lost. What matters is locked for them, and two-step login turns off on ${new Date(twoStep.reset).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}. If that was not you, press Cancel under Two-step login: they are logged out at once. Then change your email password.`}
            </p>
            <a href="#two-step" className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-ink underline underline-offset-4">
              Go to Two-step login
            </a>
          </div>
        ) : null}

        {current && unpaidSince > 0 ? <RenewalUnpaidNotice payUrl={renewalPage} canPay={may("billing")} /> : null}
        {current && current.subscriptionActive && planDisputed(current) ? <PlanDisputeNotice /> : null}

        {notice ? (
          <div className="notice notice-warn mt-6">
            <p className="font-bold text-ink">{notice.title}</p>
            <p className="mt-1 text-sm text-ink-soft">{notice.body}</p>
          </div>
        ) : null}

        {store ? (
          <>
            {/* The bar jumps within this page only, in the page's own order;
                the parts with pages of their own are the tiles below it. */}
            <StudioNav
              items={[
                { href: "#details", label: "Store" },
                ...(numbers ? [{ href: "#numbers", label: "Numbers" }] : []),
                ...(may("page") ? [{ href: "#look", label: "Look" }] : []),
                ...(may("products") ? [{ href: "#products", label: "Products" }] : []),
                ...(calendar ? [{ href: "#calendar", label: "Calendar" }] : []),
                ...(hooks ? [{ href: "#webhooks", label: "Webhooks" }] : []),
              ...(apiKeys ? [{ href: "#api", label: "API" }] : []),
                ...(sold ? [{ href: "#sales", label: "Sales" }] : []),
                ...(may("payments") ? [{ href: "#stripe", label: "Payments" }] : []),
                ...(billingReady && may("billing") ? [{ href: "#billing", label: "Plan" }] : []),
                { href: "#account", label: "Account" },
              ]}
            />
            {arrivedZoom && may("settings") && !meet?.connected.zoom ? (
              <p className="notice notice-info mt-6" data-zoom-arrival="">
                {"You came here to connect Zoom. "}
                <Link href={studioPath(store, "", "meetings")} className="link font-semibold">
                  Open Video calls
                </Link>
                {" and click Connect Zoom."}
              </p>
            ) : null}
            {/* Switched off, or content taken down, after notices (lib/takedown.ts): said first, with where to answer. */}
            {store.suspended || store.strikes.length ? (
              <div role="status" className="mt-6 rounded-2xl bg-danger-soft px-5 py-4 text-ink">
                <p className="font-semibold">
                  {store.suspended
                    ? "Your store's pages and sales are switched off after notices about its content."
                    : `${store.strikes.length === 1 ? "A piece" : `${store.strikes.length} pieces`} of content ${store.strikes.length === 1 ? "was" : "were"} taken down from your store after notices.`}
                </p>
                <p className="mt-1 text-sm">
                  {store.strikes.length ? `Latest: ${store.strikes[0].what}. ` : ""}
                  We emailed you each time, with the notice and how to answer it. Reply to that email to send a counter-notice;
                  your buyers keep what they bought. <Link href="/copyright" className="underline underline-offset-2">Our policy</Link>.
                </p>
              </div>
            ) : null}
            {/* A store with nothing on it yet: its first draft, written with AI from a few sentences (lib/ai.ts, writeStoreSetup). */}
            {ai.on && may("page") && may("products") && productCount(store) === 0 ? (
              <StoreSetupAi currency={store.currency} left={ai.left} hasFaq={store.faq.length > 0} storeName={store.name} />
            ) : null}
            {role === "owner" ? <StudioStart steps={startSteps} activation={activationTiming(store)} launchChecklist={funnelLaunchChecklist(store.name, visibleCount(store) > 0, startSteps.map(step => ({title: step.title, open: step.done, product: step.key === "product" || step.key === "publish", free: false})), startSteps.filter(step => !step.done).map(step => ({title: step.title, detail: step.hint})), "store")} /> : null}
            {role === "owner" && !store.suspended ? <PathStudioReminder store={store} role={role} /> : null}
            {/* "How do I…?": answered from the help center's own answers (lib/help-ask.ts). */}
            {ai.on ? <StudioHelp left={ai.left} /> : null}
            {/* Once there is something on the store: what else it does to sell, with a score (lib/store-coach.ts). */}
            {may("page") ? (
              <StoreCoach checks={storeChecks(store, { path: (page) => studioPath(store, "", page) })} />
            ) : null}
            {/* 98 [D2-COMPLIANCE-REVIEW] unit 1: pictures with no description, and what every store gets (lib/store-access-check.ts). */}
            {may("products") ? <StoreAccessCheck check={accessCheck(store)} /> : null}
            {may("products") && accessCheck(store) ? <StoreSearchCheck check={searchCheck(store)} /> : null}
            <StudioTools
              tools={[
                // 491 [PP2]: payments, the domain, email and checkout, read now, each with where to fix it.
                ...(may("settings")
                  ? [{ href: studioPath(store, "", "checkup"), title: "Something not working?", text: "Check payments, your domain, email to your list and checkout, and see how to fix what is wrong.", icon: "target" as const, prefetch: false as const }]
                  : []),
                { href: studioPath(store, "", "growth")+"#template-library", title: "Template library", text: "Preview existing pages, funnels, email layouts and paused sequences.", icon: "layout" as const, prefetch: false },
                { href: studioPath(store, "", "growth"), title: "Growth", text: "Choose a goal and connect the tools for your next action.", icon: "chart" as const, prefetch: false },
                ...(may("products")
                  ? [
                      { href: studioPath(store, "", "pages"), title: "Sales pages", text: "Build each product's page from blocks, or a landing page for something free.", icon: "layout" as const, prefetch: false as const },
                      { href: studioPath(store, "", "funnels"), title: "Funnels", text: `Up to ${MAX_FUNNEL_STEPS} one-click offers after paying.`, icon: "ladder" as const },
                      { href: studioPath(store, "", "bundles"), title: "Bundles", text: "Several of your products for one price.", icon: "gift" as const },
                    ]
                  : []),
                ...(may("page")
                  ? [
                      { href: studioPath(store, "", "site"), title: "Your pages", text: "About, Start here, Work with me: pages of your own beside your products, linked from the top of your store.", icon: "layout" as const },
                      { href: studioPath(store, "", "blog"), title: "Blog", text: "Posts on your store's address that search engines find, each able to end on a product.", icon: "notebook" as const },
                      { href: studioPath(store, "", "forms"), title: "Forms", text: "Applications, surveys and quizzes on your own pages, with every answer kept for you.", icon: "list" as const },
                    ]
                  : []),
                ...(may("import")
                  ? [{ href: studioPath(store, "", "import"), title: "Moving from another platform", text: "Bring your list, products and past buyers.", icon: "door" as const }]
                  : []),
                ...(may("orders")
                  ? [{ href: studioPath(store, "", "inbox"), title: "Inbox", text: "A chat on your store and your contact form, answered in one place, with saved replies.", icon: "mail" as const }]
                  : []),
                ...(may("reviews")
                  ? [{ href: studioPath(store, "", "reviews"), title: "Reviews", text: "Verified reviews from buyers, and your replies.", icon: "star" as const, prefetch: false as const }]
                  : []),
                ...(may("settings")
                  ? [{ href: studioPath(store, "", "affiliates"), title: "Affiliates", text: "People who share your store, for a share you set.", icon: "handshake" as const }]
                  : []),
                ...(may("community")
                  ? [{ href: studioPath(store, "", "community"), title: "Community", text: "A members-only space for your buyers.", icon: "users" as const }]
                  : []),
                ...(may("settings")
                  ? [{ href: studioPath(store, "", "integrations"), title: "Email platforms", text: "Mailchimp, Kit, beehiiv or MailerLite, kept fed.", icon: "plug" as const }]
                  : []),
                // Only once the deployment has Discord's keys (lib/discord.ts).
                ...(may("settings") && isDiscordConfigured()
                  ? [{ href: studioPath(store, "", "discord"), title: "Discord", text: "Your own server, opened by what people buy, with roles taken back when access ends.", icon: "chat" as const }]
                  : []),
                // Only once the deployment has the Google or Zoom app's keys (lib/meet-providers.ts).
                ...(may("settings") && meetOn && (meet?.providers ?? offeredProviders(store, arrivedZoom)).length > 0
                  ? [{ href: studioPath(store, "", "meetings"), title: "Video calls", text: `${(meet?.providers ?? offeredProviders(store, arrivedZoom)).map((p) => MEET_NAMES[p]).join(" or ")} links, made for your bookings and live events.`, icon: "video" as const }]
                  : []),
                // Read from the creator's own Stripe account (lib/membership-numbers.ts).
                ...(may("stats") && sellsMemberships(store)
                  ? [{ href: studioPath(store, "", "memberships"), title: "Membership numbers", text: "Monthly recurring revenue, churn and trials that became paying.", icon: "chart" as const }]
                  : []),
                // One page per buyer, read from the creator's own Stripe account (lib/buyer-profile.ts).
                ...(may("orders")
                  ? [
                      { href: studioPath(store, "", "people"), title: "Buyers", text: "One page per buyer: what they paid, where they found you, their courses and your team's notes.", icon: "user" as const },
                      // Fields of the store's own and its deals (lib/crm-rules.ts).
                      { href: studioPath(store, "", "deals"), title: "Deals and fields", text: "Sales you are talking through, in pipelines and stages, and the fields you keep about each person.", icon: "chart" as const },
                      // A custom amount for one person, paid on the creator's own Stripe (lib/payment-requests.ts).
                      { href: studioPath(store, "", "requests"), title: "Payment requests", text: "Ask one person to pay a custom amount, with lines, a due date and a receipt, by email.", icon: "receipt" as const },
                      // A proposal or agreement for one person to sign, with the exact text recorded (lib/agreement-rules.ts).
                      { href: studioPath(store, "", "agreements"), title: "Agreements", text: "Send one person a proposal or agreement to read and sign, with each version's exact text recorded.", icon: "receipt" as const },
                    ]
                  : []),
                // The credit lands on the plan, so whoever may handle the plan (lib/creator-invites.ts).
                ...(billingReady && may("billing")
                  ? [{ href: studioPath(store, "", "invite"), title: INVITE_PROGRAM_OPEN ? "Invite creators" : "Invitation credits", text: INVITE_PROGRAM_OPEN ? `${INVITE_SHARE_PERCENT}% of every payment they make goes on your plan.` : "View existing credits. New invitations are paused.", icon: "percent" as const }]
                  : []),
                // Everyone on the store, for their own devices (lib/phone-alerts.ts).
                { href: studioPath(store, "", "phone"), title: "Phone notifications", text: "A buzz for sales, bookings, community reports, affiliate applications and live events, on your own devices.", icon: "phone" as const },
                // Everyone on the store, for their own calendar as a team host (lib/host-calendar.ts).
                ...(callProducts.length > 0
                  ? [{ href: studioPath(store, "", "calendar"), title: "Your calendar", text: "Your own busy times, kept out of the team calls you host.", icon: "calendar" as const }]
                  : []),
                ...(PRO_ON_SALE && may("draft")
                  ? [{ href: studioPath(store, "", "email"), title: "Email", text: "One-off emails and sequences to your list.", icon: "mail" as const, tag: "Pro" }]
                  : []),
                // One email to one business, opened in the creator's own mailbox (lib/outreach.ts).
                ...(may("draft")
                  ? [{ href: studioPath(store, "", "outreach"), title: "Outreach", text: "A short pitch to a sponsor, a partner or a business, for you to send.", icon: "target" as const }]
                  : []),
                ...(may("team")
                  ? [
                      {
                        href: studioPath(store, "", "team"),
                        title: "Team",
                        text: team && team.members.length
                          ? `${team.members.length} ${team.members.length === 1 ? "person helps" : "people help"} run this store.`
                          : `Invite up to ${MAX_TEAM} people, each with a role.`,
                        icon: "user" as const,
                      },
                    ]
                  : []),
              ]}
            />
            <div className="grid min-w-0 grid-cols-1 items-start gap-x-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="min-w-0">
            <div id="details" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
              <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
                {store.name}
              </p>
              {store.bio ? (
                <p className="mt-2 text-ink-soft">{store.bio}</p>
              ) : null}
              {may("page") ? (
                <div className="mt-3">
                  <DetailsForm name={store.name} bio={store.bio} ai={ai} />
                </div>
              ) : null}
              {may("page") ? (
                <div className="mt-5">
                  <IntroEditor intro={store.intro} />
                </div>
              ) : null}
              {may("page") ? (
                <div className="mt-5">
                  <p className="text-sm font-bold text-ink">Your profiles elsewhere</p>
                  <div className="mt-2">
                    <SocialsEditor socials={store.socials} />
                  </div>
                </div>
              ) : null}

              <p className="mt-5 text-sm font-bold text-ink">{role === "owner" ? "Your address" : "Its address"}</p>
              <p className="mt-1 break-all rounded-[8px] bg-paper px-3 py-2 font-mono text-[0.9375rem] text-violet-deep ring-1 ring-line">
                marktmorgen.com/@{store.handle}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-4">
                <Link
                  href={`/@${store.handle}`}
                  className="btn btn-primary"
                >
                  {role === "owner" ? "Open my store" : "Open the store"}
                </Link>
                {may("settings") ? <RenameForm current={store.handle} /> : null}
              </div>

              <details className="mt-5 rounded-2xl bg-paper p-4 ring-1 ring-line">
                <summary className="cursor-pointer text-sm font-semibold text-ink">Share the store: link, QR code, posts</summary>
                <div className="mt-4">
                  <SharePanel url={storeBase(store)} title={store.name} what="store" />
                  {may("page") && store.statsId ? (
                    <ShortLinks
                      links={await readLinks(store.statsId).catch(() => [])}
                      products={[...(await readTitles(store).catch(() => new Map<string, string>()))].map(([id, title]) => ({ id, title }))}
                      results={
                        numbers
                          ? (numbers.posts?.d90 ?? []).reduce<Record<string, { visits: number; sales: number; cents: number }>>((all, row) => {
                              const sum = all[row.campaign] ?? { visits: 0, sales: 0, cents: 0 };
                              all[row.campaign] = { visits: sum.visits + row.visits, sales: sum.sales + row.sales, cents: sum.cents + row.cents };
                              return all;
                            }, {})
                          : undefined
                      }
                      currency={store.currency}
                    />
                  ) : null}
                  {may("page") ? (
                    <AiOn value={ai}>
                      <AiPosts url={storeBase(store)} what="store" />
                    </AiOn>
                  ) : null}
                </div>
              </details>

              {may("settings") ? <OldAddresses handles={store.previousHandles} /> : null}
            </div>

            {may("stats") ? <SalesLevers store={store} reading={salesRead?.state === "ok" ? salesRead.value?.levers ?? null : null} canConfigure={may("products") && may("settings")} /> : null}
            {numbers ? (
              <div id="numbers" className="scroll-mt-32">
                {trouble.week > 0 && trouble.last ? (
                  <div className="notice notice-warn mt-8" role="status">
                    <p className="font-bold text-ink">
                      {`Stripe would not open a checkout ${trouble.week === 1 ? "once" : `${trouble.week} times`} in the last 7 days`}
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">
                      {`Those buyers could not pay. The last time, ${new Date(trouble.last.at).toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })}, Stripe said: “${trouble.last.message}” If it mentions your account, open your Stripe dashboard; if it mentions a price, save the product again.`}
                    </p>
                  </div>
                ) : null}
                <StatsPanel
                  data={numbers}
                  canExport={may("export")}
                  notes={statsNotes}
                  marks={autoMarks}
                  spends={adSpends}
                  beside={beside}
                  meta={await metaView(store.statsId, store.currency).then((view) => (view ? { ...view, readPaused: costsPaused(store) } : view)).catch(() => null)}
                  canConnectMeta={may("settings")}
                  pin={pin}
                  askHeard={!heardIsOff}
                  canSetHeard={may("settings")}
                  canSetAttribution={may("settings")}
                  canAsk={aiAvailableFor(store)}
                  voice={store ? await readVoice(store).catch(() => null) : undefined}
                  insightContext={{
                    storeUrl: current ? storeBase(current) : undefined,
                    reminders: current ? current.recovery.enabled : undefined,
                    may: { settings: may("settings"), page: may("page"), draft: may("draft") },
                    pages: statListings.filter((l) => l.page).map((l) => l.id),
                    promotionProducts: current && (may("page") || may("draft"))
                      ? statListings.filter((product) => !product.hidden).map((product) => ({ id: product.id, title: product.title, url: `${storeBase(current)}/p/${productSegment(product)}` }))
                      : [],
                  }}
                  weeklyAi={may("settings") && aiAvailableFor(store) && store ? store.weeklyAi : undefined}
                  weeklyTeam={
                    team && store
                      ? {
                          members: team.members.filter((m) => can(m.role, "stats")).map((m) => m.email.toLowerCase()),
                          chosen: await weeklyTeam(store.handle).catch(() => []),
                        }
                      : null
                  }
                  goal={(await readSalesGoal(store.statsId, store.currency).catch(() => ({ cents: 0 }))).cents}
                  chat={may("settings") ? await chatSetup(store.statsId).catch(() => null) : undefined}
                  chatSales={store.chatSales}
                  deviceMarked={isMarkedDevice((await cookies()).get(NO_COUNT_COOKIE)?.value, store.sid)}
                />
                {await (async () => {
                  // What buyers get next (lib/next-bought.ts): read from the week's
                  // record, and read again in the background after six hours.
                  if (!store.stripeAccountId) return null;
                  const paths = await readPaths(store.statsId).catch(() => null);
                  if (pathsStale(paths) && (await claimPathsRead(store.statsId).catch(() => false))) {
                    after(() => readAllTimeSales(store).then(() => undefined).catch(() => undefined));
                  }
                  if (!paths) return null;
                  const pairs = Object.entries(paths.next)
                    .flatMap(([from, steps]) => steps.map((step) => ({ from, ...step })))
                    .sort((a, b) => b.buyers - a.buyers || a.days - b.days)
                    .slice(0, 12);
                  const firstOnes = Object.entries(paths.starts).sort((a, b) => b[1] - a[1]).slice(0, 3);
                  const ids = [...new Set([...pairs.flatMap((p) => [p.from, p.id]), ...firstOnes.map(([id]) => id)])];
                  const listed = new Map((ids.length ? await readListings(store, ids).catch(() => []) : []).map((p) => [p.id, p]));
                  const withOffers = new Set(idsOfKind(store, "funnel"));
                  const rows = pairs
                    .map((p) => ({ p, a: listed.get(p.from), b: listed.get(p.id) }))
                    .filter((x): x is { p: (typeof pairs)[number]; a: Listing; b: Listing } => Boolean(x.a && x.b))
                    .map(({ p, a, b }) => ({
                      from: { id: a.id, title: a.title },
                      to: { id: b.id, title: b.title, price: formatMoney(b.priceCents, store.currency) },
                      buyers: p.buyers,
                      when: laterWords(p.days),
                      offer: isOneOff(a) && canBeBumped(b) ? (withOffers.has(a.id) ? ("change" as const) : ("offer" as const)) : null,
                      bundle: whyNotInBundle(a) === null && whyNotInBundle(b) === null,
                    }));
                  const starts = firstOnes.flatMap(([id, buyers]) => (listed.get(id) && buyers >= 3 ? [{ title: listed.get(id)!.title, buyers }] : []));
                  return <BuyerPaths rows={rows} starts={starts} canEdit={may("products")} />;
                })()}
                <GoogleSearches
                  searches={await storeSearches(store).catch(() => null)}
                  operator={isOperator(email) ? await searchConsoleStatus().catch(() => ({ connected: false, account: "" })) : null}
                  result={typeof params.gsc === "string" ? params.gsc : ""}
                />
              </div>
            ) : null}

            {may("page") ? (
              <div id="look" className="scroll-mt-32">
                <LookEditor
                  look={store.look}
                  photoId={store.photoId}
                  name={store.name}
                  handle={store.handle}
                  currency={store.currency}
                  canHideBadge={canUse(store, "branding")}
                  sample={(() => {
                    // The first product a visitor sees, as the preview shows it (lib/catalog.ts, head).
                    const first = store.catalog.head.find((p) => !p.hidden);
                    return first ? { title: first.title, priceCents: lowestPriceCents(first.options, first.priceCents), free: isFree(first) } : null;
                  })()}
                  linkTitle={store.links.find((link) => !link.header)?.title ?? null}
                />
              </div>
            ) : null}

            {/* The store's latest real purchases on its pages (lib/recent-sales.ts): something visitors see, so a setting. */}
            {may("settings") ? <RecentSalesSwitch on={store.recentSales} live={Boolean(store.stripeAccountId)} /> : null}

            {may("page") ? (
              <PageOrderEditor
                order={store.order}
                on={{
                  products: visibleCount(store) > 0,
                  quotes: store.quotes.length > 0,
                  links: store.links.some((link) => !link.header),
                  tips: tipsOpen(store),
                  signup: joinOpen(store),
                  faq: store.faq.length > 0,
                  contact: contactOpen(store),
                  community: store.community?.on === true,
                }}
              />
            ) : null}

            {may("products") ? (
              <div id="products" className="scroll-mt-32">
                <ProductEditor
                  products={shelf?.products ?? []}
                  total={productCount(store)}
                  positions={shelf?.positions}
                  paging={shelf?.paging ?? null}
                  choices={shelf?.choices}
                  named={shelf?.named}
                  notes={shelf?.notes}
                  folder={folder}
                  imageFolder={pictures}
                  handle={store.handle}
                  selling={current ? canSell(current) : false}
                  testMode={isConnectInTestMode()}
                  email={store.email}
                  currency={store.currency}
                  meetings={meetAccounts}
                  ai={ai}
                  newComments={await newCommentsFor(shelf?.products ?? [])}
                  waitlists={await waitlistViews(store, (shelf?.products ?? []).map((p) => p.id)).catch(() => ({}))}
                  preorders={await preorderViews(store, (shelf?.products ?? []).map((p) => p.id)).catch(() => ({}))}
                  mailAddress={store.mail?.address ?? store.winback?.address ?? ""}
                  cover={{ accent: store.look.accent, font: store.look.font, name: store.name, language: store.language }}
                  look={store.look}
                  ownHosts={store.domain?.name ? [store.domain.name] : []}
                  pairChoices={await publishedChoices(store)}
                />
              </div>
            ) : (
              <section className="card mt-8 p-6 sm:p-8" aria-labelledby="catalogue-title">
                <h2 id="catalogue-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                  What the store sells
                </h2>
                <p className="mt-2 text-sm text-ink-soft">For answering buyers. Your role reads the products; it does not edit them.</p>
                {productCount(store) === 0 ? (
                  <p className="mt-4 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">Nothing listed yet.</p>
                ) : (
                  <>
                    <ul className="mt-4 divide-y divide-line">
                      {(shelf?.products ?? []).map((product) => (
                        <li key={product.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
                          <Link href={`/@${store.handle}/p/${productSegment(product)}`} className="min-w-0 break-words font-semibold text-ink underline-offset-4 hover:underline">
                            {product.title}
                          </Link>
                          <span className="shrink-0 text-sm tabular-nums text-ink-soft">
                            {isFree(product) ? "Free" : `${formatMoney(product.priceCents, store.currency)}${product.recurring ? " · membership" : product.call ? " · call" : product.course ? " · course" : ""}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {shelf?.paging && shelf.paging.pages > 1 ? (
                      <nav aria-label="Pages of products" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-ink-soft">
                        <span>{`${(shelf.paging.from + 1).toLocaleString("en-US")}–${(shelf.paging.from + shelf.products.length).toLocaleString("en-US")} of ${shelf.paging.matches.toLocaleString("en-US")}`}</span>
                        {shelf.paging.page > 1 ? (
                          <Link href={studioPath(store, `pp=${shelf.paging.page - 1}`)} className="font-bold underline underline-offset-4 hover:text-violet-deep">Previous</Link>
                        ) : null}
                        {shelf.paging.page < shelf.paging.pages ? (
                          <Link href={studioPath(store, `pp=${shelf.paging.page + 1}`)} className="font-bold underline underline-offset-4 hover:text-violet-deep">Next</Link>
                        ) : null}
                      </nav>
                    ) : null}
                  </>
                )}
              </section>
            )}

            {callProducts.length > 0 && may("orders") ? (
              <section className="card mt-8 p-6 sm:p-8" aria-labelledby="calls-title">
                <h2 id="calls-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                  Upcoming calls
                </h2>
                {!current?.stripeAccountId ? (
                  <p className="mt-2 text-ink-soft">
                    Calls can be booked once your Stripe account is connected and your store can take payments.
                  </p>
                ) : calls === null ? (
                  <p className="mt-2 text-ink-soft">
                    Your calls could not be read from Stripe just now. Nothing is lost; reload the page in a moment.
                  </p>
                ) : calls.length === 0 ? (
                  <p className="mt-2 text-ink-soft">
                    Nothing booked yet. When someone books, it shows up here. The buyer gets an email with a calendar file. You get one too, or the host does on a team call. If the call is already in that person&apos;s Google Calendar, their email has no file. You and the buyer get reminders a day and an hour before. A reminder that would come less than an hour after the booking is skipped. On a team call, your reminders still come to you.
                  </p>
                ) : (
                  <ul className="mt-4 divide-y divide-line">
                    {calls.map((slot) => {
                      const product = slot.product;
                      const setup = product?.call ?? null;
                      const tz = setup?.tz ?? callProducts[0].call?.tz ?? "UTC";
                      const room =
                        callRooms?.get(slot.key) ?? (setup && !setup.video ? roomFor(setup, slot.start) : null);
                      const seats = setup ? seatsAt(setup, slot.start) : 1;
                      const group = setup !== null && (setup.kind === "live" || seats > 1);
                      const emails = slot.people.map((c) => c.email).filter((e): e is string => Boolean(e));
                      // A dated session keeps its date whatever the creator's
                      // calendar says; a clash is pointed out rather than hidden.
                      const meeting = callMeets?.get(slot.key) ?? null;
                      const clash =
                        setup?.kind === "live" &&
                        overlaps(calendarBusyTimes, slot.start, slot.start + (setup.sessions.find((s) => s.start === slot.start)?.minutes ?? setup.minutes) * 60_000);
                      return (
                        <li key={slot.key} className="py-3">
                          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                            <span className="min-w-0">
                              <span className="block font-semibold text-ink">
                                {`${readableTime(slot.start, tz)} ${zoneName(slot.start, tz)}`}
                              </span>
                              <span className="block text-sm text-ink-soft">
                                {product ? product.title : "A call that is no longer listed"}
                                {group ? (
                                  <>
                                    {" \u00b7 "}
                                    <span className="font-semibold text-ink">{`${slot.people.length} of ${seats} ${seats === 1 ? "seat" : "seats"} booked`}</span>
                                  </>
                                ) : slot.people[0]?.email ? (
                                  <>
                                    {" \u00b7 "}
                                    <a href={`mailto:${slot.people[0].email}`} className="link break-all">{slot.people[0].email}</a>
                                  </>
                                ) : null}
                              </span>
                            </span>
                            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                              {/* The host's own way in: a fresh start link asked of Zoom on the click, never kept. */}
                              {meeting && meeting.provider === "zoom" && meeting.made && !meeting.gone && may("settings") ? (
                                <a
                                  href={`/api/integrations/zoom/host?${new URLSearchParams({ scope: meeting.scope, ...(store.sid ? { store: store.sid } : {}) })}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex min-h-11 -my-2.5 items-center text-sm font-semibold text-violet-deep underline underline-offset-4"
                                >
                                  Start in Zoom
                                <NewTab /></a>
                              ) : null}
                              {room ? (
                                <a href={room} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 -my-2.5 items-center text-sm font-semibold text-violet-deep underline underline-offset-4">
                                  {roomLabel(room) === "Join the call" ? "Join" : roomLabel(room)}
                                <NewTab /></a>
                              ) : null}
                            </span>
                          </div>
                          {meeting && meeting.error && (!meeting.made || meeting.todo) ? (
                            <p className="mt-2 flex items-start gap-2 rounded-[10px] bg-amber-brand/10 px-3 py-2 text-sm text-ink">
                              <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
                              <span className="min-w-0 break-words">
                                {meetProblem(meeting)}
                              </span>
                            </p>
                          ) : null}
                          {clash ? (
                            <p className="mt-2 flex items-start gap-2 rounded-[10px] bg-amber-brand/10 px-3 py-2 text-sm text-ink">
                              <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
                              <span>Your calendar shows you busy during this session. It stays on sale as you set it: dated sessions are never hidden by your calendar.</span>
                            </p>
                          ) : null}
                          {group && slot.people.length > 0 ? (
                            <details className="group mt-2 rounded-[10px] bg-paper px-3 py-2">
                              <summary className="cursor-pointer text-sm font-semibold text-ink-soft transition hover:text-violet-deep">
                                {`Who is booked (${slot.people.length})`}
                              </summary>
                              <ul className="mt-2 space-y-1 text-sm">
                                {slot.people.map((person) => (
                                  <li key={person.session} className="break-all">
                                    {person.email ? (
                                      <a href={`mailto:${person.email}`} className="link">{person.email}</a>
                                    ) : (
                                      <span className="text-ink-mute">A buyer who gave no address</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                              {emails.length > 1 ? (
                                <a
                                  href={`mailto:?bcc=${emails.map(encodeURIComponent).join(",")}`}
                                  className="mt-2 inline-flex min-h-11 -my-2.5 items-center text-sm font-semibold text-violet-deep underline underline-offset-4"
                                >
                                  Email everyone (in blind copy)
                                </a>
                              ) : null}
                            </details>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ) : null}

            {calendar ? <CalendarEditor view={calendar} weekly={callProducts.some((p) => p.call?.kind === "weekly")} /> : null}

            {may("page") ? <div id="links" className="scroll-mt-32"><LinkEditor links={store.links} folder={pictures} /></div> : null}

            {may("page") ? <FaqEditor faq={store.faq} ai={ai} /> : null}

            {may("page") ? (
              <KitEditor
                kit={store.kit}
                handle={store.handle}
                currency={store.currency}
                socials={store.socials.map((social) => social.network)}
                ai={ai}
                contact={contactOpen(store)}
              />
            ) : null}

            {may("settings") ? (
              <NumbersLinksEditor
                now={nowSeconds()}
                links={store.numbersLinks.map((l) => ({ id: l.id, label: l.label, expires: l.expires, money: l.money, url: `${SITE_URL}/numbers/${l.id}` }))}
              />
            ) : null}

            {may("page") ? (
              <TipsEditor
                tips={store.tips}
                storeName={store.name}
                language={store.language}
                currency={store.currency}
                blocked={canSell(store) ? "" : "stripe"}
              />
            ) : null}
            {may("page") ? (
              <ContactBoxEditor
                contact={store.contact}
                storeName={store.name}
                language={store.language}
                blocked={!isSenderConfigured() ? "mail" : ""}
              />
            ) : null}
            {may("page") ? (
              <JoinBoxEditor
                join={store.join}
                storeName={store.name}
                language={store.language}
                blocked={!isSenderConfigured() ? "mail" : !isPaidUp(store) ? "plan" : ""}
              />
            ) : null}

            {may("settings") ? (
              <>
                <DiscountEditor selling={current ? canSell(current) : false} currency={store.currency} address={`${SITE_URL}/@${store.handle}`} />

                <SaleEditor
                  initial={store.sale}
                  products={await saleCandidates(store)}
                  connected={Boolean(current?.stripeAccountId)}
                  now={saleClock()}
                />

                <FairPriceEditor
                  initial={store.fair}
                  currency={store.currency}
                  examplePrice={2700}
                  products={await saleCandidates(store)}
                  names={Object.fromEntries(allCountries().map((code) => [code, countryName(code)]))}
                />

                <CartDealEditor initial={store.cartDeal} currency={store.currency} offered={offersCart(store)} />

                {await (async () => {
                  const tiers = await tierCandidates(store);
                  return tiers.length ? <TierEditor initial={store.tiers} memberships={tiers} /> : null;
                })()}

                <PixelEditor pixels={store.pixels} canViewAttribution={may("stats")} />
                {hasPixels(store.pixels) ? (
                  <ServerEventsEditor
                    setup={await (async () => {
                      const setup = await serverSetup(store.statsId).catch(() => NO_SETUP);
                      // A token saved before the store kept its own list of platforms is written there now, once.
                      const on = SERVER_PLATFORMS.filter((p) => setup.on[p]);
                      if (on.join() !== store.adsServer.join()) await setAdsServer(storeRef(store), on).catch(() => null);
                      return setup;
                    })()}
                    pixels={{
                      meta: Boolean(store.pixels.meta),
                      tiktok: Boolean(store.pixels.tiktok),
                      google: Boolean(store.pixels.google),
                      pinterest: Boolean(store.pixels.pinterest),
                    }}
                    googleId={store.pixels.google ?? ""}
                  />
                ) : null}

                {await (async () => {
                  // The free, published products, by name: what can be offered to a leaving visitor.
                  const cards = await readCards(store).catch(() => new Map());
                  const free = store.catalog.items
                    .filter((item) => (item.kind & KIND.free) !== 0 && (item.kind & KIND.hidden) === 0)
                    .map((item) => ({ id: item.id, title: cards.get(item.id)?.title ?? "" }))
                    .filter((p) => p.title);
                  // The published products, in the store's own order: where a section can start, and what the news can lead to.
                  const published = store.catalog.items
                    .filter((item) => (item.kind & KIND.hidden) === 0)
                    .map((item) => ({ id: item.id, title: cards.get(item.id)?.title ?? "" }))
                    .filter((p) => p.title);
                  return (
                    <>
                      <ExitOfferEditor current={store.exitOffer} free={free} />
                      {may("page") ? <StoreLayoutEditor sections={store.sections} announcement={store.announcement} products={published} /> : null}
                      {may("page") ? <CollectionsEditor collections={store.collections ?? []} products={published} handle={store.handle} /> : null}
                      {may("page") ? (
                        <BuyButtonEditor
                          handle={store.handle}
                          products={published}
                          fill={lookColours(store.look).accent}
                          onFill={lookColours(store.look).onAccent}
                        />
                      ) : null}
                      {may("page") ? (
                        <CheckoutScriptEditor
                          handle={store.handle}
                          products={published}
                          fill={lookColours(store.look).accent}
                          onFill={lookColours(store.look).onAccent}
                          sites={store.embedSites}
                          signup={joinOpen(store)}
                        />
                      ) : null}
                      {may("page") && aiAvailableFor(store) ? (
                        <AnswersEditor
                          setting={store.answers}
                          used={await answersUsed(store).catch(() => 0)}
                          allowance={answersAllowance(store)}
                          missed={(await missedQuestions(store).catch(() => [])).map((row) => ({
                            title:
                              row.productId === STORE_PAGE
                                ? "Looked for on your store page, and nothing fit"
                                : cards.get(row.productId)?.title ?? "A product that is no longer listed",
                            question: row.question,
                            at: row.at,
                          }))}
                        />
                      ) : null}
                      {may("page")
                        ? await (async () => {
                            // The add-on's month as Stripe has it, read again when the snapshot has run out (lib/assistant-billing.ts).
                            const own = store.assistantPlan && !assistantWindow(store.assistantPlan) && isBillingConfigured() ? await syncAssistant(store).catch(() => store) : store;
                            return (
                              <StoreAssistantEditor
                                setting={own.assistant}
                                next={own.nextOffer}
                                remind={own.assistReminder}
                                postal={own.recovery.address !== ""}
                                plan={own.assistantPlan}
                                onSale={ASSISTANT_ON_SALE}
                                canBill={may("billing")}
                                refusal={assistantRefusal(own)}
                                usage={await assistantLeft(own).catch(() => null)}
                                missed={await assistantMissed(own).catch(() => [])}
                                notice={typeof params.assistant === "string" ? params.assistant : ""}
                                pin={pin}
                              />
                            );
                          })()
                        : null}
                    </>
                  );
                })()}

                <TaxEditor tax={store.tax} status={tax ? tax.state : "unknown"} connected={Boolean(current?.stripeAccountId)} />

                {may("settings") ? <StoreLanguageEditor language={store.language} handle={store.handle} /> : null}

                {givesAway && may("settings") ? (
                  <WelcomeOfferEditor
                    offer={store.welcomeOffer}
                    products={[...(await readCards(store).catch(() => new Map()))].map(([, c]) => c).filter((c) => c.priceCents > 0).map((c) => ({ id: c.id, title: c.title }))}
                    connected={Boolean(current?.stripeAccountId)}
                    suggestedAddress={store.winback.address || store.recovery.address || store.mail?.address || ""}
                    offered={await welcomesOffered(store).catch(() => 0)}
                  />
                ) : null}

                <RecoveryEditor
                  recovery={store.recovery}
                  suggestedAddress={store.mail?.address ?? ""}
                  connected={Boolean(current?.stripeAccountId)}
                />

                {/* Only where there is a membership to cancel: an offer on a
                    store that sells nothing that renews would be a setting
                    that can never do anything. */}
                {sellsMemberships(store) ? (
                  <>
                    <DunningEditor dunning={store.dunning} connected={Boolean(current?.stripeAccountId)} />
                    <LeaveEditor leaving={store.leaving} pause={store.pause} tiers={store.tiers.length} />
                    <NudgeEditor
                      nudge={store.nudge}
                      suggestedAddress={store.mail?.address || store.winback.address || store.recovery.address || ""}
                      sent={await nudgesThisMonth(store).catch(() => 0)}
                    />
                    <YearlyAskEditor
                      ask={store.yearlyAsk}
                      suggestedAddress={store.nudge.address || store.mail?.address || store.winback.address || store.recovery.address || ""}
                      sent={await yearlyAsksThisMonth(store).catch(() => 0)}
                      offersYearly={(await readKind(store, "recurring").catch(() => [])).some((p) => activeYearly(p, store.tiers) !== null)}
                    />
                    <SaveOfferEditor save={store.save} connected={Boolean(current?.stripeAccountId)} />
                    <PauseEditor months={store.pause} />
                    <WinBackEditor
                      winback={store.winback}
                      connected={Boolean(current?.stripeAccountId)}
                      suggestedAddress={store.recovery.address || store.mail?.address || ""}
                      sent={await winbacksSent(store).catch(() => 0)}
                    />
                  </>
                ) : null}
              </>
            ) : null}

            {hooks ? <WebhookEditor view={hooks} /> : null}

            {/* The keys a creator's own tools read the store with. The same
                people who may take the list away as a file may hand one out. */}
            {apiKeys ? <ApiKeyEditor keys={apiKeys} /> : null}

            {list && (givesAway || list.total > 0) ? (
              <div className="card mt-8 p-6 sm:p-8">
                <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
                  Your list
                </p>
                <p className="mt-2 text-ink-soft">
                  {`${list.total.toLocaleString("en-US")} ${
                    list.total === 1 ? "address" : "addresses"
                  } from what you give away. ${list.agreed.toLocaleString("en-US")} of them agreed to hear from you.`}
                </p>
                <p className="mt-2 text-sm text-ink-soft">
                  Every address on it was confirmed by the person who owns it,
                  by using the link we emailed them. None of them is a typo, and
                  none was typed in by somebody else.
                </p>

                {/* Plain GET forms rather than links: a link to a download
                    is a link something may prefetch, and each prefetch would
                    read the whole list. A form is only sent when pressed. */}
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <form action="/api/store/leads" method="get" className="max-w-full">
                    <input type="hidden" name="store" value={store.sid} />
                    <input type="hidden" name="who" value="agreed" />
                    <button
                      type="submit"
                      className="btn btn-primary btn-wrap"
                    >
                      Download the ones who agreed
                    </button>
                  </form>
                  <form action="/api/store/leads" method="get" className="max-w-full">
                    <input type="hidden" name="store" value={store.sid} />
                    <input type="hidden" name="who" value="everyone" />
                    <button
                      type="submit"
                      className="btn btn-secondary"
                    >
                      Download everyone
                    </button>
                  </form>
                </div>
                <p className="mt-4 text-sm text-ink-soft">
                  A CSV file, which Mailchimp, Kit, beehiiv and most other email
                  tools import. The ones who agreed checked a box that starts
                  empty. The rest asked for one thing and said no more — writing
                  to them about something else is what spam laws, in Europe
                  especially, are about, so the first file is the one for your
                  newsletter. The list is yours: take it whenever you like, with
                  nothing to ask for, and it goes with you if you leave.
                </p>
                {list.full ? (
                  <p className="mt-4 notice notice-warn">
                    {`Your list has reached ${MAX_LEADS.toLocaleString("en-US")} addresses, which is as many as one store holds. New people still get what they ask for; their addresses are not added. Download the list and write to us.`}
                  </p>
                ) : null}
                {givesAway && !paid ? (
                  <p className="mt-4 rounded-2xl bg-sand px-4 py-3 text-sm text-ink-soft">
                    Free products are handed out while your subscription or
                    trial is on. Until then your page shows them as not
                    available, and nobody is asked for an address.
                  </p>
                ) : null}
              </div>
            ) : null}

            {domainsOn && may("settings") ? (
              <div id="domain" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Your own domain</p>
                  <span className="tag tag-brand">Pro</span>
                </div>
                {paid && hasPro(tier) ? (
                  <DomainEditor
                    handle={store.handle}
                    domain={store.domain?.name ?? null}
                    live={Boolean(store.domain?.liveAt)}
                    initial={domainNow}
                  />
                ) : (
                  <>
                    <p className="mt-2 text-ink-soft">
                      {`Your store on a domain of your own, like shop.yourname.com, with its certificate handled for you. Part of Pro, at ${priceWords("pro", "month")}.`}
                    </p>
                    {store.domain ? (
                      <p className="mt-3 rounded-2xl bg-sand px-4 py-3 text-sm text-ink-soft">
                        {`${store.domain.name} is resting while your store is not on Pro: visitors are sent to marktmorgen.com/@${store.handle}. It opens your store again the moment Pro is back.`}
                      </p>
                    ) : null}
                    <a href="#billing" className="btn btn-secondary mt-5">See Pro</a>
                  </>
                )}
              </div>
            ) : null}

            {PRO_ON_SALE && may("draft") ? (
              <div className="card mt-8 p-6 sm:p-8">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Email your list</p>
                  <span className="tag tag-brand">Pro</span>
                </div>
                <p className="mt-2 text-ink-soft">
                  {paid && hasPro(tier)
                    ? "Write to the people who agreed to hear from you: one-off emails, emails scheduled for later, and sequences that go out by themselves after someone joins or buys."
                    : `One-off emails, emails scheduled for later, and sequences that go out by themselves after someone joins or buys. Part of Pro, at ${priceWords("pro", "month")}.`}
                </p>
                <Link href={studioPath(store, "", "email")} className="btn btn-primary mt-5">
                  {paid && hasPro(tier) ? "Open Email" : "See what it does"}
                </Link>
              </div>
            ) : null}

            </div>
            <div className="min-w-0">
            {may("payments") ? (
            <div id="stripe" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
              <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
                Where the money goes
              </p>
              <p className="mt-2 text-ink-soft">
                Buyers pay into a Stripe account that is yours, not ours. You
                sign Stripe&apos;s agreement, you log into their dashboard, and
                the payouts go to your bank. We keep the account&apos;s
                identifier and nothing else — no key to it, and never the money
                in it.
              </p>

              {!connectReady ? (
                <p className="mt-5 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">
                  Connecting is not switched on yet on our side, so there is
                  nothing here to press. This says so instead of showing you a
                  button that would do nothing.
                </p>
              ) : !store.stripeAccountId ? (
                <>
                  <form action={`/api/stripe/connect${pin}`} method="post" className="mt-5">
                    <label
                      htmlFor="stripe-country"
                      className="field-label"
                    >
                      Which country is your bank account in?
                    </label>
                    <select
                      id="stripe-country"
                      name="country"
                      required
                      defaultValue=""
                      className="field mt-2 max-w-xs"
                    >
                      <option value="" disabled>
                        Choose a country
                      </option>
                      <optgroup label="Most chosen">
                        {COUNTRIES.filter((country) => country.top).map((country) => (
                          <option key={country.code} value={country.code}>
                            {country.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="More countries, A to Z">
                        {COUNTRIES.filter((country) => !country.top).map((country) => (
                          <option key={country.code} value={country.code}>
                            {country.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    <p className="mt-2 max-w-md text-sm text-ink-soft">
                      Stripe fixes this when the account is opened and it cannot
                      be changed afterward, so pick the country your bank
                      account is really in.
                    </p>
                    <button
                      type="submit"
                      className="btn btn-primary mt-4"
                    >
                      Connect your Stripe account
                    </button>
                  </form>
                  <p className="mt-4 text-sm text-ink-soft">
                    Stripe will ask for the details it needs to pay you. If you
                    already have a Stripe account, you can log in to it there
                    instead of opening a new one.
                  </p>
                </>
              ) : (
                <>
                  <div
                    className={`mt-5 rounded-3xl p-5 ${
                      store.stripeChargesEnabled
                        ? "bg-mint-brand/15"
                        : "bg-amber-brand/10"
                    }`}
                  >
                    <p className="font-bold text-ink">
                      {store.stripeChargesEnabled
                        ? "Stripe says this account can take payments"
                        : "Stripe is not finished with this account"}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-ink-soft">
                      {store.stripeAccountId}
                    </p>
                    {store.stripeCheckedAt ? (
                      <p className="mt-2 text-sm text-ink-soft">
                        Last asked on{" "}
                        {new Date(store.stripeCheckedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}.
                        Stripe can change its mind, so this is what it said
                        then, not a promise about this moment.
                      </p>
                    ) : null}
                  </div>

                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    {!store.stripeChargesEnabled ? (
                      <form action={`/api/stripe/connect${pin}`} method="post">
                        <button
                          type="submit"
                          className="btn btn-primary"
                        >
                          Finish it in Stripe
                        </button>
                      </form>
                    ) : null}
                    <form action={`/api/stripe/check${pin}`} method="post">
                      <button
                        type="submit"
                        className="btn btn-secondary"
                      >
                        Ask Stripe again
                      </button>
                    </form>
                    {/* 568 [GD2] (h): asked first, natively, so it works without scripts too. */}
                    <details className="group" data-confirm-disconnect="stripe">
                      <summary className="btn btn-ghost cursor-pointer list-none [&::-webkit-details-marker]:hidden">Disconnect it here</summary>
                      <form action={`/api/stripe/disconnect${pin}`} method="post" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-semibold text-ink">Disconnect Stripe? Your store stops taking payments until you connect it again.</span>
                        <button type="submit" className="btn btn-danger btn-sm">Yes, disconnect</button>
                      </form>
                    </details>
                  </div>
                </>
              )}

              {connectReady && connectTestMode ? (
                <p className="mt-4 text-sm text-ink-soft">
                  This is running against Stripe in test mode, so no real money
                  can move through it yet.
                </p>
              ) : null}
            </div>
            ) : null}

            {may("payments") && paypalSalesConfigured() ? (
            <div id="paypal" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
              <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
                Sell with PayPal too
              </p>
              <p className="mt-2 text-ink-soft">
                Buyers who would rather pay with PayPal pay your own PayPal
                Business account directly, alongside Stripe or without it. You
                connect it through PayPal&apos;s own page and grant us two things
                only: taking payments into your account, and refunding them. We
                keep the account&apos;s identifier, never your password or the money.
              </p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                <li>For one-time products at one price that hand over a file, a link, a course, a bundle or a podcast.</li>
                <li>Not for memberships, payment plans, calls, price options, pay what you want, license keys or limited stock, and no add-on, gift or discount code is offered with it.</li>
                <li>What a buyer gets is sent to the email address of their PayPal account. A refund in full in your PayPal takes it back.</li>
                <li>Counted in your numbers, your sales file, your affiliates&apos; and partners&apos; book and your webhooks like a Stripe sale, with the channel the buyer came from. A refund in full in your PayPal is counted as a refund.</li>
              </ul>
              {store.paypalSeller ? (
                <>
                  <div className="mt-5 rounded-3xl bg-mint-brand/15 p-5">
                    <p className="font-bold text-ink">PayPal says this account can take payments</p>
                    <p className="mt-1 break-all font-mono text-xs text-ink-soft">{store.paypalSeller.merchant}</p>
                    {store.paypalSeller.at ? (
                      <p className="mt-2 text-sm text-ink-soft">
                        {`Connected on ${new Date(store.paypalSeller.at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}.`}
                      </p>
                    ) : null}
                  </div>
                  <details className="group mt-5" data-confirm-disconnect="paypal">
                    <summary className="btn btn-ghost cursor-pointer list-none [&::-webkit-details-marker]:hidden">Stop selling with PayPal</summary>
                    <form action={`/api/store/paypal/disconnect${pin}`} method="post" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold text-ink">Stop selling with PayPal? Buyers can no longer pay you with PayPal until you connect it again.</span>
                      <button type="submit" className="btn btn-danger btn-sm">Yes, stop</button>
                    </form>
                  </details>
                </>
              ) : (
                <form action={`/api/store/paypal/connect${pin}`} method="post" className="mt-5">
                  <button type="submit" className="btn btn-primary">
                    Connect your PayPal account
                  </button>
                  <p className="mt-3 text-sm text-ink-soft">
                    PayPal asks you to sign in to your Business account, or open
                    one, and to confirm what Marktmorgen may do. Then it sends you back here.
                  </p>
                </form>
              )}
            </div>
            ) : null}

            {may("settings") ? (
              <PaymentsPanel
                ways={ways}
                currency={store.currency}
                allowed={currencies}
                priced={pricedProducts(store)}
              />
            ) : null}

            {!closing && may("export") && standing !== "ended" && standing !== "none" ? (
              <div className="card mt-8 p-6 sm:p-8">
                <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Your whole store, as one file</p>
                <p className="mt-2 text-ink-soft">
                  Your products and their pages, posts, courses with every lesson&rsquo;s text, forms and their answers,
                  contacts and a summary of your orders. It is counted from your studio&rsquo;s requests by its size.
                  Files and videos download from their own pages.
                </p>
                <form action="/api/store/export" method="get" className="mt-4 max-w-full">
                  <input type="hidden" name="store" value={store.sid} />
                  <input type="hidden" name="what" value="store" />
                  <button type="submit" className="btn btn-secondary">
                    Download everything
                  </button>
                </form>
              </div>
            ) : null}

            {closing && closing.whole ? (
              <div id="closing" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
                <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
                  {closing.today ? "Your store is closing today" : `Your plan has ended, and your store closes on ${dayWords(closing.day)}`}
                </p>
                {closing.today ? (
                  <p className="mt-4 notice notice-warn">
                    Its closing day has begun: every membership and payment plan sold through it has ended, and it is being removed. A plan can no longer be started for it, and nothing will be charged for one. You can open a new store from your account.
                  </p>
                ) : null}
                <p className="mt-4 notice notice-warn">
                  {`Your plan ended on ${dayWords(closing.endedAt)}. `}
                  <strong>{`On ${dayWords(closing.day)} your store closes`}</strong>
                  {`: its files are removed (the files your products hand over, your lessons' videos and downloads, your podcast's episodes, the files your students handed in and the pictures in your community's posts), every membership and payment plan you sold through it ends that day on your Stripe account, and within ${ERASE_WITHIN_DAYS} days, usually the same day, everything else it keeps with us is deleted: its page, products, pages, posts, courses and the certificates they gave, community, contacts, forms, numbers and your buyers' access to what they bought.`}
                </p>
                <p className="mt-4 text-ink-soft">
                  Since your plan ended, none of your members is charged again, and they keep their access until that day.
                </p>
                {closing.buyers ? (
                  <p className="mt-4 text-ink-soft">
                    {closing.buyers.done
                      ? `Everyone who bought from your store was emailed on ${dayWords(closing.buyers.by)}, once, from Marktmorgen: the day it closes, and to download what they can before then.`
                      : `By ${dayWords(closing.buyers.by)}, at least 7 days before your store closes, we email everyone who bought from it, once, from Marktmorgen: the day it closes, and to download what they can before then.`}
                    {closing.buyers.untold > 0
                      ? ` ${closing.buyers.untold} ${closing.buyers.untold === 1 ? "address was" : "addresses were"} not covered by your store's closing emails: please tell ${closing.buyers.untold === 1 ? "that buyer" : "those buyers"} yourself.`
                      : ""}
                  </p>
                ) : null}
                {notPaused && notPaused.failed + notPaused.over > 0 ? (
                  <p className="mt-4 notice notice-warn">
                    {`${notPaused.failed + notPaused.over} ${notPaused.failed + notPaused.over === 1 ? "membership's payments are" : "memberships' payments are"} not paused${notPaused.failed ? " yet: we try again every day" : ""}${notPaused.over ? `${notPaused.failed ? ", and some are" : ":"} past this closing's limit` : ""}. Every one of them ends on ${dayWords(closing.day)}. If a member is charged before then, please refund them from Stripe.`}
                  </p>
                ) : null}
                {unusedTime && unusedTime.members > 0 ? (
                  <div className="mt-4">
                    <p className="text-ink">
                      {`${unusedTime.members} ${unusedTime.members === 1 ? "member has" : "members have"} paid for time after ${dayWords(closing.day)}: ${unusedTime.totals.map((t) => formatMoney(t.amount, t.cur)).join(" and ")} in all. On that day each is refunded the unused part of their last payment from your own Stripe account, if its balance covers it. Marktmorgen never pays it and never takes it.`}
                    </p>
                    <p className="mt-3">
                      <a href={studioPath(store!, "", "closing-refunds")} className="btn btn-secondary">
                        Review and refund unused time now
                      </a>
                    </p>
                  </div>
                ) : null}
                <p className="mt-4 text-ink-soft">
                  {`We keep no copy of your sales: every sale, refund and payout is on your own Stripe account, and stays there. Your account and sign-in stay. Tell your students to download their course certificates before that day: they can until then, and not after. Starting a plan again before that day keeps your store: everything stays as it is, your members' payments go on as they were with nothing charged for the days in between, and nothing is refunded.`}
                </p>
                {closing.today ? null : (
                  <p className="mt-4 text-ink" data-last-plan-moment="">
                    {nowSeconds() * 1000 < lastPlanMoment(closing.day)
                      ? <>{"To keep your store, start a plan before "}<strong>{momentWords(lastPlanMoment(closing.day))}</strong>{`. A plan's checkout started then lasts ${CLOSING_CHECKOUT_SECONDS / 60} minutes, so it ends before the closing day begins.`}</>
                      : <>{"The last moment to start a plan and keep this store was "}<strong>{momentWords(lastPlanMoment(closing.day))}</strong>{". It has passed, so a plan can no longer be started for it."}</>}
                  </p>
                )}
                {/* A GET form, not a link: a link may be prefetched, and each prefetch would read the whole store. */}
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <form action="/api/store/export" method="get" className="max-w-full">
                    <input type="hidden" name="store" value={store.sid} />
                    <input type="hidden" name="what" value="store" />
                    <button type="submit" className="btn btn-primary">
                      Download everything
                    </button>
                  </form>
                  <span className="text-sm text-ink-soft">
                    {`One file: your products and their pages, posts, courses with every lesson's text, forms and their answers, contacts and your orders as a spreadsheet. ${ENDED_STORE_EXPORTS === 1 ? "Once" : `${ENDED_STORE_EXPORTS} times`} now that your plan has ended, whatever your store's size, so download it when you are ready to keep it. Files and videos download from their own pages.`}
                  </span>
                </div>
                <p className="mt-3 text-sm text-ink-soft">
                  {`We email you ${WARN_MONTH_DAYS} days before that day and ${WARN_WEEK_DAYS} days before it, and nothing is removed sooner than a week after the last of those emails.`}
                </p>
              </div>
            ) : closing ? (
              <div id="closing" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
                <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
                  Your plan has ended, and what your store keeps has a date
                </p>
                <p className="mt-4 notice notice-warn">
                  {closing.room > 0
                    ? `Your plan ended on ${dayWords(closing.endedAt)}. Your store keeps ${
                        storageWords(closing.bytes) === storageWords(closing.room) ? `a little over ${storageWords(closing.room)}` : storageWords(closing.bytes)
                      } of files and lesson videos, and a store with no plan may keep ${storageWords(closing.room)}. `
                    : `Your plan ended on ${dayWords(closing.endedAt)}. Your store keeps ${storageWords(closing.bytes)} of files and lesson videos, and a store whose plan has ended keeps them until a set day. `}
                  <strong>{`On ${dayWords(closing.day)}, what it keeps will be removed`}</strong>
                  : the files your products hand over, your lessons&rsquo; videos and downloads, your
                  podcast&rsquo;s episodes, the files your students handed in and the pictures in your community&rsquo;s
                  posts. From that day your buyers can no longer download those files or watch those videos.
                </p>
                <p className="mt-4 text-ink-soft">
                  {closing.room > 0
                    ? `Two things stop it, either one: start a plan again, or delete files or lessons you no longer need until your store keeps ${storageWords(closing.room)} or less. `
                    : "Starting a plan again stops it. If you would rather not, download what you want to keep before then. "}
                  Your store and its page, your products and their prices, your lessons&rsquo; text and quizzes, your
                  contacts and your orders stay either way.
                </p>
                <p className="mt-3 text-sm text-ink-soft">
                  {`We email you ${WARN_MONTH_DAYS} days before that day and ${WARN_WEEK_DAYS} days before it, and nothing is removed sooner than a week after the last of those emails.`}
                </p>
              </div>
            ) : null}

            {delivery ? (
              <div className="card mt-8 p-6 sm:p-8">
                <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
                  What you have sent out this month
                </p>
                <p className="mt-2 text-ink-soft">
                  {`${readableSize(delivery.bytes)} of the ${readableSize(
                    delivery.allowance,
                  )} of downloads your plan covers. Counted when a download starts, including the ones you open yourself to check.`}
                </p>
                <div
                  className="mt-4 h-2 w-full overflow-hidden rounded-full bg-sand"
                  role="progressbar"
                  aria-valuenow={Math.min(
                    100,
                    Math.round((delivery.bytes / delivery.allowance) * 100),
                  )}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Delivery used this month"
                >
                  <div
                    className={`h-full rounded-full ${
                      delivery.over
                        ? "bg-amber-brand"
                        : "bg-gradient-to-r from-violet-brand to-sky-brand"
                    }`}
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          1,
                          Math.round(
                            (delivery.bytes / delivery.allowance) * 100,
                          ),
                        ),
                      )}%`,
                    }}
                  />
                </div>
                {delivery.over ? (
                  <p className="mt-4 notice notice-warn">
                    You are past what the plan covers this month.{" "}
                    <strong>Nothing has been cut off and nothing will be.</strong>{" "}
                    A buyer who paid always gets what they paid for, and your
                    store keeps selling as usual.
                  </p>
                ) : null}
                {/*
                  The two figures that act on their own, said before they act.

                  Section 5 of the Terms promises that every limit is one you
                  can see while you use the Services, and that none of them is
                  discovered by being enforced against you. These two were
                  built and shown nowhere, which made that sentence untrue the
                  day it was written. They are far above any real store — a
                  storefront holds two to five gigabytes, not two hundred —
                  and they are here so that the promise is kept rather than
                  merely made.
                */}
                <dl className="mt-5 grid gap-3 border-t border-line pt-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold text-ink">Free downloads this month</dt>
                    <dd className="text-ink-soft">
                      {`${bytesWords(Math.min(delivery.bytes, FREE_PAUSE_ABOVE_BYTES))} of ${bytesWords(FREE_PAUSE_ABOVE_BYTES)}. `}
                      Past that, copies you give away pause until the month turns. Anything anyone has bought is never
                      affected.
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-ink">Past the allowance</dt>
                    <dd className="text-ink-soft">
                      {`Nothing is charged for downloads above ${bytesWords(DELIVERY_ALLOWANCE_BYTES)}, and nothing is ever cut off: `}
                      a buyer who paid always gets what they paid for, however much you send. We email you the morning
                      after you pass it.
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-ink">Files stored</dt>
                    <dd className="text-ink-soft">
                      {`Up to ${storageWords(storageBrakeFor(standing, store.tier))} for your store${
                        standing === "paid"
                          ? ""
                          : standing === "trial"
                            ? ` during the free trial, and ${storageWords(storageBrakeFor("paid", store.tier))} from your first payment`
                            : `, and ${storageWords(storageBrakeFor("trial", store.tier))} once a plan's free trial starts`
                      }. `}
                      {standing === "ended"
                        ? `Past that you are asked to delete something before adding more. A store that keeps more than ${storageWords(SETUP_STORAGE_BYTES)} after its plan has ended has ${CLOSING_DAYS} days from the end of the plan, and three emails, before what it keeps is removed.`
                        : "Past that you are asked to delete something before adding more. Nothing already there stops working, and nothing already sold is touched."}
                    </dd>
                  </div>
                </dl>

                {/*
                  Lesson video: the one thing here that is charged by use
                  (lib/watch-rules.ts). The figure, what it covers and what
                  an hour past it costs are said here, before any of it is
                  ever on an invoice, from the same numbers the invoice is
                  made from.
                */}
                {/*
                  The window every figure below is counted in (lib/allowance-window.ts):
                  the billing month of a store that pays, its trial, or the calendar month.
                */}
                <p className="mt-4 rounded-[12px] bg-paper px-4 py-3 text-sm text-ink-soft ring-1 ring-line">
                  {usageWindow
                    ? usageWindow.billing
                      ? `Your billing month: ${windowDay(usageWindow.start)} to ${windowDay(usageWindow.end)} (UTC). Every figure here is counted in it and starts again on ${windowDay(usageWindow.end)}, with your plan\u2019s next month.`
                      : standing === "trial"
                        ? `Your free trial: ${windowDay(usageWindow.start)} to ${windowDay(usageWindow.end)} (UTC). Every figure here is counted for the whole trial.`
                        : `This calendar month: ${windowDay(usageWindow.start)} to ${windowDay(usageWindow.end)} (UTC). Every figure here starts again on the 1st.`
                    : "Your plan\u2019s billing month has not been read from Stripe yet, so what costs us money waits. It is read when this page opens and once a day; reload in a minute."}
                </p>
                <div className="mt-6 border-t border-line pt-5">
                  <UsageMeter label="Video watched this month" used={watchedReading} limit={videoRoom} format={hoursWords}
                    unavailable="Usage measurement is temporarily unavailable. New stream playback is paused until it can be verified."
                    description="The player counts recorded watched time, read about once an hour. Existing player links may remain valid until they expire." />
                  {watchedReading !== null && videoLimit !== null && watched >= videoLimit ? (
                    <p className="mt-4 notice notice-warn">
                      <strong>Your lesson videos are paused.</strong>
                      {` They have been watched for the ${hoursWords(videoLimit)} ${
                        standing === "paid" || standing === "trial" ? "your plan covers" : "a store without a paid plan has"
                      } this month. New playback resumes when capacity is available again. Existing player links may remain valid until they expire. Everything else in your courses is open as usual.`}
                    </p>
                  ) : null}
                  <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="font-semibold text-ink">{`At ${hoursWords(videoRoom)} watched`}</dt>
                      <dd className="text-ink-soft">
                        New stream playback pauses at the recorded monthly threshold. The meter is read about once an hour; existing player links may remain valid until they expire.
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-ink">Without a paid plan</dt>
                      <dd className="text-ink-soft">
                        {`In the free trial, lesson videos play for ${hoursWords(TRIAL_VIDEO_SECONDS)} a month; before a plan starts and after one ends, for ${hoursWords(SETUP_VIDEO_SECONDS)}. Past that they pause `}
                        until the plan is paid (for a store with no plan, until the month turns). Nothing is charged for those hours.
                      </dd>
                    </div>
                  </dl>
                </div>

                {/*
                  Visits (lib/traffic-rules.ts): never billed since 17 October
                  2026. Public pages rest at 95% of the month's figure; buyers'
                  own pages go on to the whole figure.
                */}
                <div className="mt-6 border-t border-line pt-5">
                  <UsageMeter label="Visits this month" used={trafficReading?.visits ?? null} limit={visitRoom} format={visitsWords}
                    unavailable="Usage measurement is temporarily unavailable. Public pages are paused until it can be verified."
                    description="A counted visit is one person opening your store on one day. Community room activity also contributes to this count." />
                  {trafficReading !== null && visitLimit !== null && visited >= publicVisitLimit(visitLimit) ? (
                    <p className="mt-4 notice notice-warn">
                      <strong>{visited >= visitLimit ? "Your store\u2019s pages, and your buyers\u2019 pages, are resting." : "Your store\u2019s public pages are resting."}</strong>
                      {visited >= visitLimit
                        ? ` It has used all ${countWords(visitLimit)} counted visits this month, so courses, the community and podcasts rest too, with a page that tells your buyers their access is kept. Everything opens again ${standing === "paid" ? "with your next billing month, or on a larger plan" : standing === "trial" ? "as soon as your plan is paid" : "when the month turns"}.`
                        : ` It has reached ${countWords(publicVisitLimit(visitLimit))} of its ${countWords(visitLimit)} counted visits this month. Your buyers\u2019 courses, community and podcasts stay open for the last ${countWords(visitLimit - publicVisitLimit(visitLimit))}. Public pages open again ${standing === "paid" ? "with your next billing month, or on a larger plan" : standing === "trial" ? "as soon as your plan is paid" : "when the month turns"}.`}
                    </p>
                  ) : null}
                  <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="font-semibold text-ink">Where a month&rsquo;s visits stop</dt>
                      <dd className="text-ink-soft">
                        {`Your page, products, blog and collections rest at ${(10_000 - BUYER_RESERVE_BPS) / 100}% of the month\u2019s visits; the last ${BUYER_RESERVE_BPS / 100}% are kept for your buyers\u2019 courses, community and podcasts. Visits are never billed. A checkout already open always finishes. A failed or unreadable measurement also pauses new public-page admission.`}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-ink">Without a paid plan</dt>
                      <dd className="text-ink-soft">
                        {`In the free trial a store has ${countWords(TRIAL_VISITS)} visits for the whole trial; before a plan starts and after one ends, ${countWords(SETUP_VISITS)} a month. They stop the same way, `}
                        until the plan is paid (for a store with no plan, until the month turns). Nothing is charged for visits.
                      </dd>
                    </div>
                  </dl>
                </div>
                {/*
                  Orders (lib/order-rules.ts): never billed since 17 October
                  2026; a paid store's new orders stop at its plan's figure
                  (lib/order-admission.ts).
                */}
                {standing === "paid" || standing === "trial" ? (
                <div className="mt-6 border-t border-line pt-5">
                  <p className="font-semibold text-ink">Orders this month</p>
                  <p className="mt-1 text-ink-soft">
                    {`${ordersWords(ordered)} counted of the ${countWords(orderRoom)} ${
                      standing === "paid" ? "your plan covers" : "a free trial has"
                    }. An order is a purchase confirmed, an offer taken after paying, a PayPal order, a place in a purchase for several people, a package of calls, or a free copy sent; a call booked counts as ${countWords(CALL_ORDER_UNITS)}.${feeWords(COMMISSION_LIVE && store.shared).ordersShared}`}
                  </p>
                  {standing === "paid" && store && ordered >= orderRoom ? (
                    <p className="mt-4 notice notice-warn">
                      <strong>New orders are paused for the month.</strong>
                      {` Your store has had the ${countWords(orderRoom)} orders your plan covers. A buyer who presses buy is told the store is not taking new orders right now, and nothing is charged; anybody already paying finishes. Orders open again with your next billing month, or on a larger plan.`}
                    </p>
                  ) : null}
                  {standing === "trial" && ordered >= TRIAL_ORDERS ? (
                    <p className="mt-4 notice notice-warn">
                      <strong>New orders are paused for the trial.</strong>
                      {` Your store has had the ${countWords(TRIAL_ORDERS)} orders a free trial has, paid ones and free copies together. They start again as soon as your plan is paid; anybody already paying finishes.`}
                    </p>
                  ) : null}
                  <p className="mt-3 text-sm text-ink-soft">
                    {"Orders are never billed. At your plan\u2019s figure new orders pause until your next billing month, and we email you the first time a month reaches it. A checkout opened in the last day counts toward the figure until it is paid or closes, so nobody is stopped while paying."}
                  </p>
                </div>
                ) : null}
                {/*
                  The figures added on 17 October 2026 (lib/store-allowance-rules.ts):
                  each refused, with a plain message, once its window's figure is used.
                */}
                {figures ? (
                  <div className="mt-6 border-t border-line pt-5">
                    <p className="font-semibold text-ink">Your other figures this month</p>
                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                      {figures.map((figure) => (
                        <div key={figure.kind}>
                          <dt className="font-semibold text-ink">{KIND_WORDS[figure.kind].what}</dt>
                          <dd className="text-ink-soft">{`${figure.used.toLocaleString("en-US")} of ${figure.limit.toLocaleString("en-US")} ${KIND_WORDS[figure.kind].many} used`}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-3 text-sm text-ink-soft">
                      {`A page of the studio counts as ${STUDIO_PAGE_UNITS} studio requests, and a contact added or a product given through the API as ${API_WRITE_UNITS} API requests. Past a figure, that use waits for the next month or a larger plan, with a plain message; nothing is billed. Changing or canceling your plan, deleting your store and downloading your sales always work.`}
                    </p>
                  </div>
                ) : null}
                {data ? (
                  <div className="mt-6 border-t border-line pt-5">
                    <p className="font-semibold text-ink">Your data room</p>
                    <p className="mt-2 text-sm text-ink-soft">{`${dataWords(data.used)} of ${dataWords(data.room)} used, ${dataWords(data.orders)} of it kept for your orders.`}</p>
                    {data.used >= data.room * 0.9 ? (
                      <p className="mt-3 notice notice-warn">
                        {data.used >= data.room ? dataFullWords(data.used, data.room) : "Your data room is nearly full. Delete something you no longer need, such as old posts, drafts, pages or contacts, or move to a larger plan, before it is."}
                      </p>
                    ) : null}
                    <p className="mt-3 text-sm text-ink-soft">
                      {"It holds your products, pages, posts, courses, contacts, forms and their answers, and what each order keeps. When it is full, what you or your buyers would add is refused until you delete something or move to a larger plan; deleting is never refused, and an order already paid for is never refused."}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {billingReady && may("billing") ? (
              <div id="billing" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
                <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
                  What you pay us
                </p>
                <p className="mt-2 text-ink-soft">
                  {feeWords(COMMISSION_LIVE && store.shared).studioPay} Visits and lesson video have finite monthly thresholds, shown above. Public pages and new video playback pause at their respective thresholds.
                </p>

                {!PLAN_BREAKS_ENABLED && (pauseSet || onBreakNow) ? (
                  <form action={`/api/billing/cancel${pin}`} method="post" className="mt-4">
                    <input type="hidden" name="intent" value="cancel" />
                    <button type="submit" className="btn btn-secondary btn-sm">Cancel the subscription</button>
                  </form>
                ) : null}
                {pauseUnknown ? (
                  <p className="mt-5 notice notice-warn" role="status" data-pause-unconfirmed="">
                    We could not confirm your break status. Check your billing status before changing or starting a plan.
                  </p>
                ) : null}
                {paid && cancelling && pauseUnknown ? (
                  <p className="mt-3 text-ink-soft">
                    Your subscription is set to stop at the end of its paid period. We could not confirm whether a break is scheduled after that.
                  </p>
                ) : paid && cancelling && pauseSet && pause && !PLAN_BREAKS_ENABLED ? (
                  <p className="mt-5 notice notice-warn" role="status">
                    A previous break is recorded for your store. Automatic restart is unavailable. Your content and buyer access are preserved. You can cancel the subscription below.
                  </p>
                ) : paid && cancelling && pauseSet && pause ? (
                  <>
                    <p className="mt-5 notice notice-success font-semibold">
                      {`Break set. Your store keeps taking payments until ${breakDay(pause.from)}. From then until ${breakDay(pause.until)} nothing is charged and your checkout is closed, and on ${breakDay(pause.until)} your plan starts again by itself at ${priceWords(pause.tier, "month")}.`}
                    </p>
                    <form action={`/api/billing/pause${pin}`} method="post" className="mt-4">
                      <input type="hidden" name="intent" value="undo" />
                      <button type="submit" className="btn btn-primary">
                        Take the break back
                      </button>
                    </form>
                    <p className="mt-3 text-sm text-ink-soft">
                      Your plan then goes on as before, and the break is not counted.
                    </p>
                  </>
                ) : paid && cancelling ? (
                  <>
                    <p className="mt-5 notice notice-warn font-semibold">
                      {trialing
                        ? `Canceled during the trial. Your card will not be charged, and your store keeps taking payments until ${endsOn ?? "the trial ends"}.`
                        : `Canceled. Nothing more will be charged, and your store keeps taking payments until ${endsOn ?? "the end of the period you paid for"}.`}
                    </p>
                    <form action={`/api/billing/cancel${pin}`} method="post" className="mt-4">
                      <input type="hidden" name="intent" value="resume" />
                      <button
                        type="submit"
                        className="btn btn-primary"
                      >
                        Keep my subscription
                      </button>
                    </form>
                    {refundLink}
                  </>
                ) : paid ? (
                  <>
                    <p className="mt-5 notice notice-success font-semibold">
                      {trialing
                        ? `You are in the ${TRIAL_DAYS}-day trial. No card has been charged yet. After it: ${billedNow}${endsOn ? `, first charged on ${endsOn}` : ""}.`
                        : `Subscribed at ${billedNow}.${endsOn ? ` Next charge on ${endsOn}.` : ""}`}
                    </p>
                    {changePending ? (
                      <p className="mt-3 notice notice-warn">
                        A change of billing is waiting for your bank to let the
                        payment through. Until it does, nothing has changed.
                      </p>
                    ) : billedYearly ? (
                      <details className="mt-4">
                        <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                          Pay monthly instead
                        </summary>
                        <p className="mt-3 text-sm text-ink-soft">
                          {trialing
                            ? `Nothing is charged now. When the trial ends you pay ${priceWords(tier, "month")} instead of ${priceWords(tier, "year")}.`
                            : `From today you pay ${priceWords(tier, "month")}. What is left of the year you paid for is kept as credit on your account and pays the months until it runs out, so nothing is charged until then. Monthly costs $${(yearSaving(tier) / 100).toLocaleString("en-US")} more over a year.`}
                        </p>
                        <form action={`/api/billing/switch${pin}`} method="post" className="mt-3">
                          <input type="hidden" name="cycle" value="month" />
                          <button type="submit" className="btn btn-secondary btn-sm">
                            Switch to monthly
                          </button>
                        </form>
                      </details>
                    ) : (
                      <details className="mt-4" open={firstSale > 0}>
                        <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                          {`Pay yearly and save $${(yearSaving(tier) / 100).toLocaleString("en-US")}`}
                        </summary>
                        {firstSale > 0 ? (
                          <p className="mt-3 text-sm font-semibold text-ink-soft">
                            {`Your store made its first sale on ${new Date(firstSale * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}. If you plan to keep selling, the yearly plan costs $${(yearSaving(tier) / 100).toLocaleString("en-US")} less than twelve monthly payments.`}
                          </p>
                        ) : null}
                        <p className="mt-3 text-sm text-ink-soft">
                          {trialing
                            ? `Nothing is charged now. When the trial ends you pay $${(PLAN_PRICES[tier].year / 100).toLocaleString("en-US")} for the year, instead of ${priceWords(tier, "month")} — $${(yearSaving(tier) / 100).toLocaleString("en-US")} less over the year.`
                            : `You are charged $${(PLAN_PRICES[tier].year / 100).toLocaleString("en-US")} today, less what is left of the month you already paid for, and the year starts today. That is $${(yearSaving(tier) / 100).toLocaleString("en-US")} less than twelve monthly payments. If your bank asks you to confirm, you are sent to confirm it, and nothing changes until it is paid.`}
                        </p>
                        <form action={`/api/billing/switch${pin}`} method="post" className="mt-3">
                          <input type="hidden" name="cycle" value="year" />
                          <button type="submit" className="btn btn-primary btn-sm">
                            Switch to yearly
                          </button>
                        </form>
                      </details>
                    )}
                    {!changePending && PRO_ON_SALE && tier === "creator" ? (
                      <details className="mt-4">
                        <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                          {`Move up to Pro: ${priceWords("pro", billedYearly ? "year" : "month")}`}
                        </summary>
                        <p className="mt-3 text-sm text-ink-soft">
                          {`Pro adds email to your list: one-off emails, emails scheduled for later and automatic sequences, up to ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} a month${domainsOn ? ", and your own domain" : ""}. `}
                          {trialing
                            ? "Nothing is charged now. When the trial ends you pay the Pro price instead."
                            : "Today you are charged only the difference for the rest of the period you already paid for, and the Pro price from your next charge on. If your bank asks you to confirm, you are sent to confirm it, and nothing changes until it is paid."}
                        </p>
                        <form action={`/api/billing/switch${pin}`} method="post" className="mt-3">
                          <input type="hidden" name="tier" value="pro" />
                          <input type="hidden" name="cycle" value={billedYearly ? "year" : "month"} />
                          <button type="submit" className="btn btn-primary btn-sm">
                            Move up to Pro
                          </button>
                        </form>
                      </details>
                    ) : null}
                    {/*
                      The way up from Pro, for a list that has outgrown it.
                      Shown where the plan is managed and beside the month's
                      count on the Email page, and nowhere as a nag: a store
                      that never reaches its emails is never asked.
                    */}
                    {!changePending && PRO_ON_SALE && tier === "pro" ? (
                      <details className="mt-4">
                        <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                          {`Move up to Scale: ${priceWords("scale", billedYearly ? "year" : "month")}`}
                        </summary>
                        <p className="mt-3 text-sm text-ink-soft">
                          {`Scale is Pro with room for a bigger list: up to ${SCALE_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month instead of ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")}, and ${AI_MONTHLY.scale.toLocaleString("en-US")} AI drafts instead of ${AI_MONTHLY.pro}. Stored capacity is ${storageWords(storageBrakeFor("paid", "scale"))} instead of ${storageWords(storageBrakeFor("paid", "pro"))}. `}
                          {trialing
                            ? "Nothing is charged now. When the trial ends you pay the Scale price instead."
                            : "Today you are charged only the difference for the rest of the period you already paid for, and the Scale price from your next charge on. If your bank asks you to confirm, you are sent to confirm it, and nothing changes until it is paid."}
                        </p>
                        <form action={`/api/billing/switch${pin}`} method="post" className="mt-3">
                          <input type="hidden" name="tier" value="scale" />
                          <input type="hidden" name="cycle" value={billedYearly ? "year" : "month"} />
                          <button type="submit" className="btn btn-primary btn-sm">
                            Move up to Scale
                          </button>
                        </form>
                      </details>
                    ) : null}
                    {!changePending && tier === "scale" ? (
                      <details className="mt-4">
                        <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                          {`Go back to Pro: ${priceWords("pro", billedYearly ? "year" : "month")}`}
                        </summary>
                        <p className="mt-3 text-sm text-ink-soft">
                          {trialing
                            ? `Nothing is charged now. Your list goes back to ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month.`
                            : `From today your list goes back to ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month; an email already going out waits for next month if this one is used up. What is left of what you paid for Scale is kept as credit on your account and pays your next charges until it runs out.`}
                        </p>
                        <form action={`/api/billing/switch${pin}`} method="post" className="mt-3">
                          <input type="hidden" name="tier" value="pro" />
                          <input type="hidden" name="cycle" value={billedYearly ? "year" : "month"} />
                          <button type="submit" className="btn btn-secondary btn-sm">
                            Go back to Pro
                          </button>
                        </form>
                      </details>
                    ) : null}
                    {!changePending && tier === "pro" ? (
                      <details className="mt-4">
                        <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                          {`Go back to the ${priceWords("creator", billedYearly ? "year" : "month")} plan`}
                        </summary>
                        <p className="mt-3 text-sm text-ink-soft">
                          {trialing
                            ? `Nothing is charged now, and ${domainsOn ? "email to your list and your own domain switch" : "email to your list switches"} off.`
                            : `${domainsOn ? "Email to your list and your own domain switch" : "Email to your list switches"} off from today. What is left of what you paid for Pro is kept as credit on your account and pays your next charges until it runs out.`}
                        </p>
                        <form action={`/api/billing/switch${pin}`} method="post" className="mt-3">
                          <input type="hidden" name="tier" value="creator" />
                          <input type="hidden" name="cycle" value={billedYearly ? "year" : "month"} />
                          <button type="submit" className="btn btn-secondary btn-sm">
                            Go back
                          </button>
                        </form>
                      </details>
                    ) : null}
                    {/*
                      A break before the way out (lib/plan-pause.ts): a
                      creator who is stopping for a season keeps everything
                      and is started again by itself, instead of leaving.
                    */}
                    {PLAN_BREAKS_ENABLED && !pauseUnknown && !trialing && !billedYearly && !changePending ? (
                      <details className="mt-4">
                        <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                          Take a break instead
                        </summary>
                        <p className="mt-3 text-sm text-ink-soft">
                          {`Your store keeps taking payments until ${endsOn ?? "the end of the period you already paid for"}. Then, for the months you choose, nothing is charged and your checkout is closed. Your page stays up, everything you put up is kept, and buyers can still download what they bought. On the last day your plan starts again by itself, at ${priceWords(tier, "month")} on the card you pay with now, and we write a week before. One break every ${PAUSE_EVERY_DAYS === 365 ? "year" : `${PAUSE_EVERY_DAYS} days`}, once your plan has been paid for ${PAID_MONTHS_BEFORE_PAUSE} months.`}
                        </p>
                        <form action={`/api/billing/pause${pin}`} method="post" className="mt-3 flex flex-wrap gap-2">
                          <input type="hidden" name="intent" value="pause" />
                          {PAUSE_MONTHS.map((months) => (
                            <button key={months} type="submit" name="months" value={String(months)} className="btn btn-secondary btn-sm">
                              {months === 1 ? "Pause for 1 month" : `Pause for ${months} months`}
                            </button>
                          ))}
                        </form>
                      </details>
                    ) : null}
                    <details className="mt-4">
                      <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                        Cancel the subscription
                      </summary>
                      <p className="mt-3 text-sm text-ink-soft">
                        {trialing
                          ? `Your store keeps taking payments until ${endsOn ?? "the trial ends"}, and your card is never charged.`
                          : `Your store keeps taking payments until ${endsOn ?? "the end of the period you already paid for"}, and nothing more is charged.`}
                      </p>
                      <form action={`/api/billing/cancel${pin}`} method="post" className="mt-3">
                        <input type="hidden" name="intent" value="cancel" />
                        <button
                          type="submit"
                          className="btn btn-secondary btn-sm"
                        >
                          Yes, cancel it
                        </button>
                      </form>
                    </details>
                    <p className="mt-3 text-sm text-ink-soft">
                      No email to us, no chat, no second request. This button
                      is the whole of it, and you can change your mind until
                      the day it stops.
                    </p>
                    {refundLink}
                  </>
                ) : pauseUnknown ? (
                  <p className="mt-3 text-ink-soft">Your store and its content stay as they are while your break status is unconfirmed.</p>
                ) : !PLANS_ON_SALE ? (
                  <>
                    <p className="mt-5 text-ink-soft">
                      Your address, your page, the editor and connecting Stripe
                      are free and stay free. What a plan switches on is your
                      checkout: taking a card for what you sell, and handing
                      out what you give away for an email address.
                      {` Without a plan, your page is shown for ${countWords(publicVisitLimit(SETUP_VISITS))} visits a month.`}
                    </p>
                    {/* Not open yet (lib/opening.ts): no button that the
                        checkout would refuse, and the reason in its place. */}
                    <p className="notice notice-info mt-5" data-plans-closed="">
                      {`Plans are not on sale yet. Marktmorgen is still being built, and we take no card until it opens. Your store and everything you set up in it stay as they are. When plans open, they are ${priceWords("creator", "month")} or ${priceWords("creator", "year")}${PRO_ON_SALE ? `, and ${priceWords("pro", "month")} or ${priceWords("pro", "year")} with email to your list, and ${priceWords("scale", "month")} or ${priceWords("scale", "year")} for a list that sends up to ${SCALE_MONTHLY_EMAILS.toLocaleString("en-US")} a month` : ""}.`}
                    </p>
                  </>
                ) : (
                  <>
                    {PLAN_BREAKS_ENABLED && onBreakNow && pause ? (
                      <div className="mt-5">
                        <p className="notice notice-info font-semibold">
                          {`Your store is on a break until ${breakDay(pause.until)}. Nothing is charged, your checkout is closed, and everything you put up is kept. On ${breakDay(pause.until)} your plan starts again by itself at ${priceWords(pause.tier, "month")}. To sell sooner, start it below today.`}
                        </p>
                        <form action={`/api/billing/pause${pin}`} method="post" className="mt-3">
                          <input type="hidden" name="intent" value="undo" />
                          <button type="submit" className="btn btn-secondary btn-sm">
                            Do not start it again
                          </button>
                        </form>
                      </div>
                    ) : null}
                    <p className="mt-5 text-ink-soft">
                      Your address, your page, the editor and connecting Stripe
                      are free and stay free. What the subscription switches on
                      is your checkout: taking a card for what you sell, and handing
                      out what you give away for an email address.
                      {` Without a plan, your page is shown for ${countWords(publicVisitLimit(SETUP_VISITS))} visits a month.`}
                    </p>
                    <form action={`/api/billing/checkout${pin}`} method="post" className="mt-5 flex flex-col items-start gap-3">
                      <button
                        type="submit"
                        name="cycle"
                        value="month"
                        className="btn btn-primary btn-wrap"
                      >
                        {/* One string, not three. Split across JSX nodes it
                            comes out of the server with markers in the middle,
                            which is invisible to a reader and a lie to anything
                            that searches the page for the sentence. */}
                        {withTrial
                          ? `Start the ${TRIAL_DAYS}-day trial \u2014 ${priceWords("creator", "month")} after that`
                          : extraFirstPlan
                            ? `Start this store's plan \u2014 ${priceWords("creator", "month")}, from today`
                            : `Start again \u2014 ${priceWords("creator", "month")}, from today`}
                      </button>
                      <button
                        type="submit"
                        name="cycle"
                        value="year"
                        className="btn btn-secondary btn-wrap"
                      >
                        {withTrial
                          ? `Or pay yearly: ${priceWords("creator", "year")} after the trial, $${(yearSaving("creator") / 100).toLocaleString("en-US")} less`
                          : `Or pay yearly: ${priceWords("creator", "year")}, $${(yearSaving("creator") / 100).toLocaleString("en-US")} less`}
                      </button>
                    </form>
                    {withTrial ? (
                      <p className="mt-3 text-sm text-ink-soft">
                        Nothing is charged today. The card is taken now and first
                        billed in {TRIAL_DAYS} days, so you can open a store, sell
                        something real and decide with an answer instead of a
                        guess. We email you a week before that first charge.
                      </p>
                    ) : extraFirstPlan ? (
                      <p className="mt-3 text-sm text-ink-soft">
                        {`Each store is a subscription of its own. The ${TRIAL_DAYS}-day free trial is for an account's first store, so this one's first payment is taken at checkout, today. Canceling takes two clicks on this page, touches no other store, and nothing more is charged after the period you paid for.`}
                      </p>
                    ) : (
                      <p className="mt-3 text-sm text-ink-soft">
                        This store has had its free trial, so this time the first
                        payment is taken at checkout, today. Canceling still takes
                        two clicks on this page, and nothing more is charged after
                        the period you paid for.
                      </p>
                    )}
                    {PRO_ON_SALE ? (
                      <div className="mt-6 rounded-[var(--r-md)] bg-sand p-5">
                        <p className="font-semibold text-ink">Pro</p>
                        <p className="mt-1 text-sm text-ink-soft">
                          {`Everything above, plus email to your list: one-off emails, emails scheduled for later and automatic sequences, up to ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} a month${domainsOn ? ", and your own domain" : ""}.${withTrial ? ` The same ${TRIAL_DAYS}-day trial.` : ""}`}
                        </p>
                        <form action={`/api/billing/checkout${pin}`} method="post" className="mt-4 flex flex-col items-start gap-3">
                          <input type="hidden" name="tier" value="pro" />
                          <button type="submit" name="cycle" value="month" className="btn btn-secondary btn-wrap">
                            {withTrial
                              ? `Start the trial on Pro \u2014 ${priceWords("pro", "month")} after that`
                              : `Start Pro \u2014 ${priceWords("pro", "month")}, from today`}
                          </button>
                          <button type="submit" name="cycle" value="year" className="btn btn-secondary btn-wrap">
                            {`Or Pro yearly: ${priceWords("pro", "year")}, $${(yearSaving("pro") / 100).toLocaleString("en-US")} less`}
                          </button>
                        </form>
                        {/* Said, not sold: almost nobody starts with a list this
                            size, and whoever has one can start here or move up
                            from Pro the day the month runs out. */}
                        <details className="mt-4">
                          <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                            {`Already have a big list? Scale: ${priceWords("scale", "month")}`}
                          </summary>
                          <p className="mt-3 text-sm text-ink-soft">
                            {`Pro with room for a bigger list: up to ${SCALE_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month instead of ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")}, and ${AI_MONTHLY.scale.toLocaleString("en-US")} AI drafts instead of ${AI_MONTHLY.pro}. You can also start on Pro and move up from this page whenever you need it.${withTrial ? ` The same ${TRIAL_DAYS}-day trial.` : ""}`}
                          </p>
                          <form action={`/api/billing/checkout${pin}`} method="post" className="mt-3 flex flex-col items-start gap-3">
                            <input type="hidden" name="tier" value="scale" />
                            <button type="submit" name="cycle" value="month" className="btn btn-secondary btn-wrap">
                              {withTrial
                                ? `Start the trial on Scale \u2014 ${priceWords("scale", "month")} after that`
                                : `Start Scale \u2014 ${priceWords("scale", "month")}, from today`}
                            </button>
                            <button type="submit" name="cycle" value="year" className="btn btn-secondary btn-wrap">
                              {`Or Scale yearly: ${priceWords("scale", "year")}, $${(yearSaving("scale") / 100).toLocaleString("en-US")} less`}
                            </button>
                          </form>
                        </details>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            {sold ? (
              <section id="sales" aria-labelledby="sales-title" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
                <h2 id="sales-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                  {role === "owner" ? "What you have sold" : "What the store has sold"}
                </h2>
                <p className="mt-2 text-ink-soft">
                  A recent view from your Stripe account, refreshed when you
                  open this page. Your Stripe dashboard holds the full sales history.
                </p>

                {sold.state === "error" ? (
                  <p className="mt-5 notice notice-warn">
                    This recent order history could not be verified. Check your
                    Stripe dashboard before acting on an order.
                  </p>
                ) : sold.state === "unavailable" ? (
                  <p className="mt-5 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">
                    Order history is unavailable with this store’s current payment
                    setup. Earlier sales may still be on your Stripe account.
                  </p>
                ) : sold.sales.length === 0 ? (
                  <p className="mt-5 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">
                    No orders are available in this recent view. Check your Stripe
                    dashboard for the full history.
                  </p>
                ) : (
                  <>
                    <ul className="mt-5 space-y-3">
                      {sold.sales.map((sale) => (
                        <li
                          key={sale.reference}
                          className="rounded-[var(--r-md)] bg-sand p-5"
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <p className="font-bold text-ink">{sale.title}</p>
                            <p className="font-display font-semibold text-ink">
                              {formatMoney(sale.amount, sale.currency)}
                            </p>
                          </div>
                          <p className="mt-1 text-sm text-ink-soft">
                            {sale.email ? (
                              <>
                                {sale.isTip ? "Given by" : "Bought by"}{" "}
                                <a
                                  href={`mailto:${sale.email}`}
                                  className="underline underline-offset-2"
                                >
                                  {sale.email}
                                </a>
                              </>
                            ) : (
                              "Bought without an email address on the receipt"
                            )}{" "}
                            on{" "}
                            {new Date(sale.paidAt * 1000).toLocaleDateString(
                              "en-US",
                              { day: "numeric", month: "long", year: "numeric" },
                            )}
                          </p>
                          {sale.shipTo !== undefined && sale.shipTo !== null ? (
                            <MarkShipped session={sale.reference} to={sale.shipTo} shipped={sale.shipped ?? null} />
                          ) : null}
                          {sale.answers.length > 0 ? (
                            <dl className="mt-3 space-y-2 rounded-xl bg-white px-4 py-3 text-sm">
                              {sale.answers.map((answer) => (
                                <div key={answer.label}>
                                  <dt className="text-xs font-semibold text-ink-soft">{answer.label}</dt>
                                  <dd className="mt-0.5 break-words font-semibold text-ink">{answer.value}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                          {sale.trial ? (
                            <p className="mt-2 text-sm text-ink-soft">
                              Started with a free trial, so nothing was charged at checkout. The first payment shows up in
                              your Stripe dashboard when the trial ends.
                            </p>
                          ) : null}
                          <p className="mt-1 text-xs text-ink-soft">
                            {sale.isTip
                              ? "Support from your store page: nothing was bought, so there is nothing to send."
                              : sale.isCall
                              ? "A booked call: you were both emailed its time."
                              : sale.stillDownloadable
                                ? "Their download link still works."
                                : "Their download link has expired — send them the file yourself if they ask."}{" "}
                            Stripe reference {sale.reference}
                          </p>
                          {sale.email && store ? (
                            <p className="mt-2 text-sm">
                              <Link
                                href={studioPath(store, `sale=${sale.reference}`, "people")}
                                className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4"
                              >
                                {sale.isTip ? "See this supporter's page" : "See this buyer's page"}
                              </Link>
                            </p>
                          ) : null}
                          {/* A booked call has its own confirmation, and a one-click extra is part of its checkout's. */}
                          {!sale.isCall && !sale.isTip && sale.email && sale.reference.startsWith("cs_") ? (
                            <p className="mt-2">
                              <ResendPurchase reference={sale.reference} email={sale.email} />
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-4 text-sm text-ink-soft">
                      Up to {ORDERS_PAGE_SIZE} matching recent orders. For the full
                      history, open your Stripe dashboard.
                    </p>
                  </>
                )}
              </section>
            ) : null}

            <div id="account" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
              <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
                The email that logs you in
              </p>
              {view && view.owned === 0 ? (
                <p className="mt-2 text-ink-soft">
                  {"You log in as "}
                  <strong className="text-ink [overflow-wrap:anywhere]">{email}</strong>
                  {". It is your own address, not this store's: the store's owner never sees a password of yours, because there is none."}
                </p>
              ) : (
              <>
              <p className="mt-2 text-ink-soft">
                {view && view.owned > 1
                  ? "Your stores live behind this address, so losing the inbox would mean losing them. Move it to another one while you still can — when you change jobs, or leave a provider behind. All your stores move with it."
                  : "Your store lives behind this address, so losing the inbox would mean losing the store. Move it to another one while you still can — when you change jobs, or leave a provider behind."}
              </p>
              <form
                action="/api/store/address"
                method="post"
                className="mt-5 flex flex-wrap items-end gap-3"
              >
                <label className="flex-1 basis-64 text-sm font-bold text-ink">
                  Move to
                  <input
                    type="email"
                    name="email"
                    autoComplete="off"
                    required
                    maxLength={254}
                    placeholder="you@somewhere-else.com"
                    className="field mt-1"
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn-primary"
                >
                  Send the link there
                </button>
              </form>
              <p className="mt-4 text-sm text-ink-soft">
                The link goes to the new address, because holding that inbox is
                the proof. The old one gets a plain notice, with no link, so
                that a move you did not ask for reaches you while the account is
                still yours.
              </p>
              </>
              )}

              <PasskeyManager
                initial={passkeys.map(({ id, name, createdAt, lastUsedAt, synced }) => ({ id, name, createdAt, lastUsedAt, synced }))}
                fresh={freshLogin}
              />
              <RecoveryAddressManager shown={recoveryShown} />
              <TwoStepManager on={twoStep.on} codesLeft={twoStep.codesLeft} reset={lockedTill > 0 ? 0 : twoStep.reset} backup={twoStep.backup || recoveryShown} fresh={freshLogin} locked={lockedTill > 0} />

              {role !== "owner" ? (
                <section aria-labelledby="leave-title" className="mt-8 border-t border-line pt-6">
                  <h3 id="leave-title" className="font-semibold text-ink">Leaving this store</h3>
                  <p className="mt-2 text-sm text-ink-soft">
                    {`You help run ${store.name} as ${ROLE_NAMES[role]}. Leaving takes it out of your studio; its owner can invite you again.`}
                  </p>
                  <div className="mt-3">
                    <LeaveTeam store={store.name} />
                  </div>
                </section>
              ) : null}

              {role === "owner" && view && view.owned > 1 ? (
                <section aria-labelledby="copy-store-title" className="mt-8 border-t border-line pt-6">
                  <h3 id="copy-store-title" className="font-semibold text-ink">Copy this store</h3>
                  <p className="mt-2 text-sm text-ink-soft">
                    Its products, pages, forms and funnels, and its store page&apos;s setup if you choose, into another of your stores as drafts. Never its customers, orders, contacts, emails, payments, files or pictures.
                  </p>
                  <Link href={studioPath(store, "", "copy")} className="link mt-3 inline-block text-sm font-semibold">
                    Copy it into another store
                  </Link>
                </section>
              ) : null}

              {store.extra && may("delete") ? (
                <details className="mt-8 border-t border-line pt-6">
                  <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                    Delete this store
                  </summary>
                  <p className="mt-3 text-sm text-ink-soft">
                    {productCount(store) > 0 || paid || store.domain
                      ? "A store can be deleted only while it has no products, no plan running and no domain of its own, so nothing a buyer paid for is lost with it. Remove those first."
                      : `Its address, marktmorgen.com/@${store.handle}, answers nothing for 30 days, and then anyone may take it. Your other stores are not touched. This cannot be undone.`}
                  </p>
                  {productCount(store) === 0 && !paid && !store.domain ? (
                    <form action={`/api/store/stores${pin}`} method="post" className="mt-4 flex flex-wrap items-end gap-3">
                      <input type="hidden" name="action" value="delete" />
                      <label className="flex-1 basis-56 text-sm font-bold text-ink">
                        {`Type ${store.handle} to confirm`}
                        <input name="confirm" required autoComplete="off" spellCheck={false} className="field mt-1" />
                      </label>
                      <button type="submit" className="btn btn-danger">
                        Delete it
                      </button>
                    </form>
                  ) : null}
                </details>
              ) : null}
            </div>
            </div>
            </div>
          </>
        ) : (
          <div className="card mt-8 p-6 sm:p-8">
            <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Take your address
            </p>
            <p className="mt-2 mb-6 text-ink-soft">
              This is the link you put in your bio. Pick one now without
              agonizing over it: you can change it later, and the old address
              keeps working and sends people to the new one.
            </p>
            <HandleForm initial={prefillHandle(params.handle)} />
          </div>
        )}

        {NEXT.length > 0 && role === "owner" ? (
        <div className="card mt-8 p-6 sm:p-8">
          <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
            What is not switched on here yet
          </p>
          <p className="mt-2 text-ink-soft">
            These pieces are not switched on for your store yet:
          </p>
          <ol className="mt-5 space-y-3">
            {NEXT.map((item, index) => (
              <li key={item} className="flex gap-3 text-ink-soft">
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-lilac text-xs font-semibold text-violet-deep"
                >
                  {index + 1}
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ol>
          {current && canSell(current) ? null : (
            <p className="mt-5 text-sm text-ink-soft">
              Until selling works, the working proof is the demo store, and it is
              open to anyone.
            </p>
          )}
        </div>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            prefetch={false}
            href="/demo"
            className="btn btn-primary"
          >
            Open the demo store
          </Link>
          <Link
            href="/mission"
            className="btn btn-secondary"
          >
            What is built so far
          </Link>
          <form action="/api/auth/signout" method="post" className="ml-auto">
            <button
              type="submit"
              className="btn btn-ghost"
            >
              Log out
            </button>
          </form>
          <form action="/api/auth/signout-all" method="post">
            <button
              type="submit"
              className="btn btn-ghost"
            >
              Log out of all devices
            </button>
          </form>
        </div>
      </main>
      </StudioStorePin>
    </div>
  );
}
