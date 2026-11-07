/**
 * Every word a buyer meets on a store's pages that the creator did not write,
 * in English: the store's words when it speaks English, and the list every
 * other language must say in full (lib/buyer-words/index.ts, BuyerWords).
 *
 * Prices, dates and counts arrive already written in the store's language
 * (lib/buyer-words/index.ts, speak): a sentence here only places them.
 *
 * Words that change with a number are functions of it, so each language can
 * say "1 lesson" and "3 lessons" its own way, and put the number where its
 * own grammar puts it.
 */

type Interval = "day" | "week" | "month" | "year";
type Unit = "day" | "hour" | "minute";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const en = {
  // ---- Prices -------------------------------------------------------------
  free: "Free",
  fromPrice: (price: string) => `from ${price}`,
  /** Read aloud before a crossed-out price and before the new one. */
  was: "Was ",
  now: "now ",
  every: (interval: Interval) => ({ day: "a day", week: "a week", month: "a month", year: "a year" })[interval],
  /** "7-day free trial, then $9 a month", "12 monthly payments of $9". */
  membershipPrice: (trialDays: number, payments: number, interval: Interval, price: string) => {
    const trial = trialDays > 0 ? `${trialDays}-day free trial, then ` : "";
    if (payments > 0) {
      const adjective = { day: "daily", week: "weekly", month: "monthly", year: "yearly" }[interval];
      return `${trial}${payments} ${adjective} payments of ${price}`;
    }
    return `${trial}${price} ${en.every(interval)}`;
  },
  /** "the first month", or "a month for the first 3 months": how long an introductory price lasts (lib/intro-price.ts). */
  introFirst: (count: number, interval: Interval) => (count > 1 ? `a month for the first ${count} months` : `the first ${interval}`),
  /** "$5 the first month, then $20 a month". */
  introThen: (intro: string, count: number, interval: Interval, then: string) =>
    `${intro} ${count > 1 ? `a month for the first ${count} months` : `the first ${interval}`}, then ${then}`,
  /** "3 monthly payments of $110". */
  planWords: (payments: number, interval: "week" | "month", amount: string) =>
    `${payments} ${interval === "week" ? "weekly" : "monthly"} payments of ${amount}`,
  /** "3 monthly payments", where each price has its own amount. */
  planCount: (payments: number, interval: "week" | "month") => `${payments} ${interval === "week" ? "weekly" : "monthly"} payments`,
  endsIn: (unit: Unit, n: number) =>
    unit === "day" ? `Ends in ${n} days` : unit === "hour" ? `Ends in ${n} ${plural(n, "hour", "hours")}` : `Ends in ${n} ${plural(n, "minute", "minutes")}`,

  // ---- Sales and fair prices ----------------------------------------------
  fairHead: (country: string, percent: number) => `A fair price for ${country}: ${percent}% off`,
  fairNote: (store: string, plan: boolean) =>
    `${store} lowers prices where money buys less. This price was set automatically for you, from the country of your internet connection. Taken off on the payment page, no code needed${plan ? "; the lower price is for paying in full" : ""}.`,
  saleHead: (name: string, percent: number, ends: string) => `${name ? `${name}: ` : ""}${percent}% off · ${ends}`,
  saleNote: (until: string, plan: boolean) =>
    `Until ${until}. Taken off on the payment page, no code needed${plan ? "; the sale price is for paying in full" : ""}.`,
  saleBanner: (name: string, percent: number, ends: string) =>
    `${name ? `${name}: ` : ""}${percent}% off the products with the old price crossed out · ${ends}`,
  saleBannerNote: "Prices below already show it; no code needed.",

  // ---- What a product is ----------------------------------------------------
  callLiveNone: "Live session, online, no dates scheduled",
  callLive: (dates: number) => `Live session, online, ${dates} ${plural(dates, "date", "dates")} scheduled`,
  callGroup: (minutes: number, seats: number) => `Group call, ${minutes} minutes, up to ${seats} people, online`,
  callOne: (minutes: number) => `${minutes}-minute call, online`,
  /** A call with several lengths (lib/call-lengths.ts): "30 or 60", as the store's language lists them. */
  callLengths: (list: string) => `Call of ${list} minutes, online`,
  /** An in-person booking (lib/call-place.ts): no call, at the creator's address. */
  inPersonLive: (dates: number) => `Live session, in person, ${dates} ${plural(dates, "date", "dates")} scheduled`,
  inPersonGroup: (minutes: number, seats: number) => `${minutes} minutes, up to ${seats} people, in person`,
  inPersonOne: (minutes: number) => `${minutes} minutes, in person`,
  inPersonLengths: (list: string) => `${list} minutes, in person`,
  inPersonLiveNone: "Live session, in person, no dates scheduled",
  bundleOf: (count: number, worth: string | null) => `Bundle of ${count} products${worth ? ` · ${worth}` : ""}`,
  /** "$120 of products for $49". */
  worth: (worth: string, price: string) => `${worth} of products for ${price}`,
  podcast: (episodes: number) => `Private podcast, ${episodes} ${plural(episodes, "episode", "episodes")}, in your own podcast app`,
  fromCapital: "From ",
  pwywFact: (least: string, suggested: string) => `Pay what you want, from ${least}. Suggested: ${suggested}`,
  includes: (titles: string, more: number) => `Includes ${titles}${more > 0 ? ` and ${more} more` : ""}`,
  course: (lessons: number) => `Course · ${lessons} ${plural(lessons, "lesson", "lessons")}`,
  seeInside: "See what is inside",
  readMore: "Read more",
  soldOut: "Sold out",
  left: (count: number, written: string) => `${written} left`,
  bought: (count: string) => `Bought ${count} times`,
  orPlan: (plan: string) => `or ${plan}`,

  // ---- Call packages ----------------------------------------------------------
  buySessions: (sessions: number, price: string) => `Buy ${sessions} sessions — ${price}`,
  packageNote: (saving: string | null, sessions: number, limit: string) =>
    `${saving ? `${saving} less than ${sessions} booked one by one. ` : ""}Paid once, each booked when you like. ${limit}.`,
  packageLimit: (days: number) => (days ? `Use them within ${days} days` : "No time limit to use them"),

  // ---- Gifts and teams ------------------------------------------------------
  whichOne: "Which one",
  perPerson: " per person",
  giftSummary: "Buy it as a gift",
  theirEmail: "Their email",
  yourNameShown: "Your name, as they will see it",
  messageOptional: "A message (optional)",
  buyAsGift: "Buy as a gift",
  buyAsGiftFor: (price: string) => `Buy as a gift — ${price}`,
  giftNote: (store: string) =>
    `You pay on Stripe's page. After payment, the gift belongs to their address. If the one email from ${store} reaches them, it has your name, your message and a link to open it. You get the receipt, not a copy.`,
  giftProblems: {
    email: "That does not look like an email address. Check the recipient's address and try again.",
    option: "Choose which one to give, then try again. Nothing was charged.",
    product: "This can no longer be bought as a gift.",
    unavailable: "Gifts are not available right now. Nothing was charged.",
  } as Record<string, string>,
  teamSummary: "Buy it for a team",
  howManyPeople: "How many people",
  buyForTeam: "Buy for your team",
  buyForTeamEach: (each: string) => `Buy for your team — ${each} per person`,
  teamNote:
    "You pay once on Stripe's page, where the total is shown before you pay. Right after, you get one link to pass on: each person opens it, types their own email and has it on their own address. You take a place the same way.",
  teamProblems: (least: number, most: number): Record<string, string> => ({
    people: `Type how many people, from ${least} to ${most}. Nothing was charged.`,
    option: "Choose which one to buy for everyone, then try again. Nothing was charged.",
    amount: "That many at this price is more than one payment can carry. Try fewer people, or buy twice. Nothing was charged.",
    product: "This can no longer be bought for several people.",
    unavailable: "Buying for several people is not available right now. Nothing was charged.",
  }),

  // ---- Waitlists and free products -------------------------------------------
  leaveEmpty: "Leave this empty",
  comingSoon: "Coming soon",
  yourEmail: "Your email",
  emailPlaceholder: "you@example.com",
  friendPlaceholder: "friend@example.com",
  namePlaceholder: "Dana",
  alsoOtherEmails: (store: string) => `Also send me other emails from ${store}. I can unsubscribe whenever I like.`,
  alsoEmails: (store: string) => `Also send me emails from ${store}. I can unsubscribe whenever I like.`,
  alsoClicks: (store: string) => `Let ${store} see which links in their emails I use, to send me what fits. I can stop this from any email.`,
  tellMe: "Tell me when it is out",
  waitlistNote: (store: string) =>
    `You confirm from your inbox, then get one email when it goes on sale, and that is all. Your address goes to ${store} only if you checked the box.`,
  emailItToMe: "Email it to me",
  freeNote: (store: string) =>
    `A link to it is emailed to you. Once you use it, ${store} gets your address, marked with whether you checked the box. Marktmorgen uses it for nothing else.`,
  notAvailable: "Not available right now.",
  noDates: "No dates on sale right now.",
  notOnSale: "Not on sale yet.",
  soldOutStop: "Sold out.",
  cannotTakePayments: "This store cannot take payments yet.",
  joinWaitlist: "Join the waitlist",
  getItFree: "Get it free",

  // ---- The buy box ----------------------------------------------------------------
  pickSession: "Pick a session",
  pickTime: "Pick a time",
  priced: (label: string, price: string) => `${label} — ${price}`,
  /** The store's blog (lib/store-blog.ts; app/[handle]/blog). */
  blog: "Blog",
  blogOf: (store: string) => `The ${store} blog`,
  blogPastEnd: "No posts on this page",
  blogPastEndBody: "This page is past the last post.",
  blogMinutes: (n: number) => `${n} min read`,
  blogNewer: "Newer posts",
  blogOlder: "Older posts",
  blogAll: "All posts",
  blogPublished: (date: string) => `Published ${date}`,
  blogFrom: (store: string) => `From ${store}`,
  blogFeed: "Follow by RSS",
  /** What one unit costs within an option, when its name gives how many (lib/option-units.ts): "$7.80 per week". */
  perUnit: (price: string, unit: string) => `${price} per ${unit}`,
  /** How much less each unit costs than in the option of one. */
  unitSaving: (percent: number) => `save ${percent}%`,
  chooseOptionFor: (title: string) => `Choose an option for ${title}`,
  chooseOne: "Choose one",
  recommended: "Recommended",
  recommendedAfter: " (recommended)",
  howToPayFor: (title: string) => `How to pay for ${title}`,
  payInFull: "Pay in full",
  today: (amount: string) => `${amount} today`,
  addFor: (title: string, price: string) => `Add ${title} for ${price}`,
  bundleBox: (count: number) => `A bundle of ${count} products, each yours to open straight after paying.`,
  onItsOwn: (price: string) => `${price} on its own`,
  chooseYourPrice: "Choose your price",
  startTrial: (days: number) => `Start the ${days}-day free trial`,
  subscribe: "Subscribe",
  continueOption: "Continue with this option",
  subscribeFor: (price: string, every: string) => `Subscribe — ${price} ${every}`,
  buyFor: (price: string) => `Buy for ${price}`,
  startPlanToday: (amount: string) => `Start the plan: ${amount} today`,
  startPlanWith: (named: string, amount: string) => `Start the plan with ${named}: ${amount} today`,
  nAdded: (count: number) => `${count} added`,
  buyItWith: (named: string) => `Buy it with ${named}`,
  /** "Buy both for $40", "Buy all three for $55": the product and the boxes checked (1 to 3 of them). */
  buyAllFor: (boxes: number, price: string) => `Buy ${["it", "both", "all three", "all four"][boxes]} for ${price}`,
  pwywNote: (least: string, suggested: string) => `You type the amount on the payment page: ${least} or more, ${suggested} suggested.`,
  trialNote: (days: number, after: string, untilCancel: boolean) =>
    `You enter your card now, and nothing is charged for ${days} days. Then ${after}${untilCancel ? " until you cancel" : ""}. Cancel before the trial ends and you pay nothing.`,
  switchPlansNote: "You can switch to another of this store's plans later, up or down, and see the exact amount before anything is charged.",
  payPal: (alone: boolean, price: string) => `${alone ? "Buy" : "Or pay"} with PayPal — ${price}`,
  payPalNote: (store: string) => `Paid to ${store}'s own PayPal account. What you buy is sent to the email address of your PayPal account.`,
  chooseAndBuy: "Choose and buy",
  memberManage: "Already a member? Manage or cancel",
  memberSwitch: "Already a member? Switch plan, manage or cancel",

  // ---- Who takes the money ---------------------------------------------------------
  takenBy: (stripe: boolean, paypal: boolean): string => (stripe && paypal ? "Stripe or PayPal" : paypal ? "PayPal" : "Stripe"),
  testModeTitle: "This checkout is running in Stripe's test mode.",
  testModeBody: "No real money moves through it and no real card is charged, so do not put a card you own into it.",
  testModeLater: (store: string) =>
    `Once it goes live, payment is taken by Stripe on ${store}'s own account: Marktmorgen never holds the money and takes none of it.`,
  paidBy: (takers: string, store: string) =>
    `Payment is taken by ${takers} on ${store}'s own account. Marktmorgen never holds the money and takes none of it.`,
  noPaymentsTitle: "This store cannot take payments yet.",
  noPaymentsBody: (store: string) => `The prices above are real, but nothing here can charge a card. To buy, write to ${store} directly.`,
  noPaymentsBodyOne: (store: string) => `The price above is real, but nothing here can charge a card. To buy, write to ${store} directly.`,

  // ---- The store page ----------------------------------------------------------------
  notices: {
    soldout: { title: "That one just sold out", body: "The last one went a moment before you pressed buy. Nothing was charged." },
    busy: { title: "Someone else is buying that right now", body: "Nothing was charged. Press buy again in a moment." },
    slow: { title: "That was a lot of tries in a few minutes", body: "Nothing was charged. Wait a few minutes, then press buy again." },
    error: { title: "The payment page could not be opened", body: "Nothing was charged. Try again in a moment." },
    paused: { title: "This store isn't taking new orders right now", body: "Nothing was charged. New orders open again at the start of next month, or sooner." },
    "paypal-declined": {
      title: "PayPal did not take the payment",
      body: "Nothing was charged. Try again with another card or account in PayPal, or pay with a card here.",
    },
    "paypal-error": {
      title: "That PayPal payment could not be matched to this store",
      body: "Nothing was handed over for it. If PayPal shows money taken, write to the store by replying to PayPal's receipt.",
    },
  } as Record<string, { title: string; body: string }>,
  storeDescription: (store: string) => `The store of ${store} on Marktmorgen.`,
  nothingYet: "Nothing here yet",
  nothingYetBody: (store: string) => `This page is open but empty. When ${store} adds something, it shows up here.`,
  continued: " (continued)",
  pagesOfProducts: "Pages of products",
  previous: "Previous",
  next: "Next",
  pageOf: (page: number, pages: number) => `Page ${page} of ${pages}`,
  products: (count: number, written: string) => `${written} ${plural(count, "product", "products")}`,
  communityTitle: "Members' community",
  communityBody: "For people who have one of the products that open it. Come in with the email address you used to get it.",
  getAgain: "Bought something here? Get it again",
  affiliateProgram: (store: string) => `Earn by sharing ${store}: the affiliate program`,
  madeWith: "Made with Marktmorgen",

  // ---- A product's page ----------------------------------------------------------------
  productDescription: (title: string, store: string) => `${title}, from the store of ${store}.`,
  insideTitle: (count: number) => `What is inside: ${count} products`,
  insideCourse: (lessons: number) => `Course, ${lessons} ${plural(lessons, "lesson", "lessons")} · `,
  insideNote: "Each one is yours straight after paying, as if you had bought it on its own.",
  payInFullOr: (plan: string) => `Pay in full, or in ${plan}`,
  youChoose: (least: string) => `You choose the price: ${least} or more.`,
  readFirst: (pages: number) => `Read the first ${pages === 1 ? "page" : `${pages} pages`} free (PDF)`,
  everythingFrom: (store: string) => `Everything from ${store}`,
  getTitle: (title: string) => `Get ${title}`,
  moreFrom: (store: string) => `More from ${store}`,
  pairedWith: (title: string) => `Goes well with ${title}`,
  pickedBy: (store: string) => `Picked by ${store}`,
  collections: "Collections",
  inCollections: "Part of",
  productCount: (n: number) => `${n} ${plural(n, "product", "products")}`,
  alsoBought: (title: string) => `Buyers of ${title} also bought`,
  boughtBoth: (n: number) => `${n} buyers bought both`,
  billMonthly: "Monthly",
  billYearly: "Yearly",
  yearSave: (amount: string) => `Save ${amount}`,
  yearlyFact: (price: string, save: string) => `Or ${price} ${en.every("year")}, which saves ${save}`,

  // ---- Reviews ----------------------------------------------------------------------------
  reviews: "Reviews",
  verifiedReviews: (count: number, written: string) => `${written} verified ${plural(count, "review", "reviews")}`,
  ratedFrom: (average: string, reviews: string) => `Rated ${average} out of 5 from ${reviews}`,
  ratedOutOf5: (average: string) => `Rated ${average} out of 5`,
  starsOutOf5: (stars: number) => `${stars} out of 5 stars`,
  verifiedBuyer: "Verified buyer",
  verifiedPurchase: "Verified purchase",
  pickedByCreator: "Picked by the creator",
  refundedNotCounted: "Refunded, not counted",
  edited: (date: string) => ` · edited ${date}`,
  replyFrom: (store: string) => `Reply from ${store}`,
  starsSpread: "How the stars are spread",
  starLabel: (stars: number) => `${stars} ${plural(stars, "star", "stars")}`,
  reviewCount: (count: number) => `${count} ${plural(count, "review", "reviews")}`,
  reviewRules: (title: string, store: string) =>
    `Only people who bought ${title} here can review it, and every review is checked against its order. ${store} can reply and can hide a review, but cannot change one; hidden reviews still count in the average.`,
  hiddenByCreator: (count: number) => `${count} ${plural(count, "review", "reviews")} hidden by the creator`,
  refundedOrders: (count: number) => `${count} from refunded ${plural(count, "order", "orders")}, not counted`,
  noReviewsYet: "Buyers' reviews appear here once somebody who paid writes one.",
  seeAllReviews: (written: string) => `See all ${written} reviews`,

  // ---- Questions before buying ----------------------------------------------------------
  askAria: "Ask a question about this product",
  askLabel: "A question before you buy?",
  askPlaceholder: "Is it a PDF? How long do I have access?",
  askBusy: "Reading…",
  ask: "Ask",
  askClosed: (store: string) => `Questions are closed right now. Ask ${store} before you buy.`,
  askTypeFirst: "Type your question first.",
  askSlow: "Too many questions just now. Try again in a few minutes.",
  askFailed: "That could not be answered just now. Try again in a moment.",
  askNote: (store: string) =>
    `Answered automatically, only from what this page says. Your question may be shown to ${store}, without anything about who you are, so leave personal details out.`,

  // ---- The offer to a leaving visitor ----------------------------------------------------
  close: "Close",
  beforeYouGo: "Before you go — free",

  // ---- A sales page's blocks -----------------------------------------------------------------
  aboutStore: (store: string) => `About ${store}`,
  guarantee: "Guarantee",
  fullSize: (alt: string) => `${alt}, full size`,
  openFullSize: "Open this picture full size",
  countdownUnits: { days: "days", hours: "hours", min: "min", sec: "sec" },
  until: (when: string) => `Until ${when}`,

  // ---- A store that is resting -------------------------------------------------------------
  restingTitle: "This page is resting for now",
  restingBody: (store: string) =>
    `It will be open again at the start of next month, or sooner. Anything you already have from ${store} is still yours, and still open.`,
  restingBuyerBody: (store: string) =>
    `Your access is kept: nothing you have from ${store} is lost. This page opens again at the start of next month, or sooner.`,
  restingOwner: "Is this your store? Your studio says why, and how to open it again",

  // ---- Every review of a product ----------------------------------------------------
  reviewsOf: (title: string) => `Reviews of ${title}`,
  backTo: (title: string) => `Back to ${title}`,
  missingTitle: "This page isn't here",
  missingBody: (store: string) => `It may have been moved or taken down. Everything ${store} offers is on the store's front page.`,
  noReviewsToShow: "There are no reviews to show.",
  pagesOfReviews: "Pages of reviews",
  newer: "Newer",
  older: "Older",
  askUnknown: (store: string) => `This page does not say. Ask ${store} before you buy.`,
  askTermsCut: () => "I don't have the full terms here. Please ask the creator before you buy.",

  // ---- The card on the creator's own website ---------------------------------------------
  noLongerOnSale: "This product is no longer on sale.",
  seeStore: (store: string) => `See ${store}`,
  cardTestMode: "Test mode: no real card is charged.",
  cardCheckout: "Secure checkout by Stripe, in a new tab.",
  cardOpens: (store: string) => `Opens on ${store}'s store, in a new tab.`,

  // ---- Email cards (lib/mail-product-price.ts) -------------------------------------------
  orMore: (price: string) => `${price} or more`,
  plusTax: "+ tax where it applies",
  salePriceUntil: (price: string, when: string) => `Sale price: ${price}, until ${when}`,
};
