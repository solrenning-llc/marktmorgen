/**
 * Every word an affiliate, a partner or a list subscriber meets that the
 * creator did not write, in each of the store's languages
 * (lib/store-language.ts): the store's affiliate page (app/[handle]/affiliates),
 * the emails an affiliate or an invited partner gets (lib/affiliates.ts), the
 * words a store adds around a creator's own email to their list
 * (lib/mail.ts, lib/winback-send.ts) and the page a reader stops those emails
 * from (app/unsubscribe).
 *
 * Amounts, dates and counts arrive already written in the store's language
 * (lib/buyer-words/index.ts, speech); a sentence here only places them.
 * Emails to the creator themselves stay in English, like their studio.
 *
 * A name that may be missing ("" when the store behind a link is not known)
 * is given as it is, and each language says "this store" its own way, so a
 * language that joins "de" and "este" into "deste" can.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** French singular for 0 and 1. */
const pluralFr = (n: number, one: string, many: string) => (n < 2 ? one : many);
/** A space that does not break: before "%" everywhere, and before French ":", "?", "!", ";". */
const S = " ";

/** "1st", "2nd", "23rd": the day as American English says it (lib/affiliate-setting.ts, ordinal). */
function ordinal(day: number): string {
  const rest = day % 100;
  if (rest >= 11 && rest <= 13) return `${day}th`;
  const last = day % 10;
  return `${day}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

const en = {
  // ---- The page ---------------------------------------------------------------
  pageTitle: "Affiliates",
  notices: {
    email: { title: "That does not look like an email address", body: "Check it and try again." },
    limited: {
      title: "Too many requests for now",
      body: "To keep this form from being used to flood somebody's inbox, it takes a limited number of requests an hour. Try again in an hour.",
    },
    unavailable: { title: "This store is not taking affiliates right now", body: "Nothing was sent." },
    owner: { title: "This is the store's own address", body: "A store cannot be its own affiliate." },
    full: {
      title: "This program is full",
      body: "It has as many affiliates as one store can hold. Write to the store if you would like to be considered.",
    },
    error: { title: "Something went wrong on our side", body: "Nothing was changed. Try again in a moment." },
    resting: { title: "This store can't take this right now", body: "Accepting checks the store's partners first, and the store can't take that many requests right now. Nothing was changed. Try again later, or write to the store." },
    expired: {
      title: "This link has expired",
      body: "An emailed link works once, within 24 hours. Ask for a new one below; it takes a few seconds.",
    },
    order: {
      title: "That order could not be read",
      body: "Open the link in your purchase email again, or apply below with the address you bought with.",
    },
    declined: {
      title: "You cannot join from your order",
      body: "This store decided on this address before. Write to the store if you think that should change.",
    },
    signedout: { title: "You are signed out on this browser", body: "To see your affiliate page again, ask for a new link below." },
  } as Record<string, { title: string; body: string }>,

  // ---- Applying -----------------------------------------------------------------
  whereShare: "Where you would share it",
  optional: "(optional)",
  notePlaceholder: "My newsletter, my YouTube channel…",
  emailMeLink: "Email me a link to apply",
  formNote:
    "No password. The link confirms the address is yours; opening it sends your application. Already an affiliate? The same form emails you the way back to your page.",
  continueAs: (email: string) => `Continue as ${email}`,
  continueBody: (store: string) =>
    `Press the button to open your affiliate page for ${store} on this browser. If you have not applied yet, this sends your application.`,
  openMyPage: "Open my affiliate page",
  checkInbox: "Check your inbox",
  sentBody: (store: string) =>
    `The link is on its way. It comes from ${store} via Marktmorgen and usually arrives within a minute. If it is not there, look in spam.`,

  // ---- Just arrived ---------------------------------------------------------------
  appliedTitle: "Your application is in",
  joinedTitle: "Your link is ready",
  welcomeTitle: "You are signed in on this browser",
  appliedBody: (store: string) => `${store} has been told. If they approve it, you get an email with your link.`,
  joinedBody: "Share it anywhere. You stay signed in on this browser for 30 days, and the same form below emails you the way back.",
  welcomeBody: "You stay signed in on this browser for 30 days.",

  // ---- Where they stand -------------------------------------------------------------
  badgeAffiliate: "Affiliate",
  badgePaused: "Program paused",
  badgePending: "Waiting for approval",
  badgeDeclined: "Not approved",
  badgeRemoved: "No longer an affiliate",
  yourPageFor: (store: string) => `Your affiliate page for ${store}`,
  pendingBody: (store: string) => `${store} decides on each application. If they approve yours, you get an email with your link.`,
  pausedBody: (store: string) => `${store} has paused the program, so links do not earn right now. What you already earned is below.`,
  declinedBody: (store: string) => `${store} did not approve this application.`,
  removedBody: (store: string) =>
    `${store} ended your place in the program, so your link no longer earns. What you earned before is below.`,

  // ---- Their link, codes and shares ---------------------------------------------------
  yourLink: "Your link",
  copy: "Copy",
  copied: "Copied",
  orAddVia: (code: string) => `Or add ?via=${code} to the address of any page of this store.`,
  recruitLabel: "Your invitation link",
  recruitNote: (percent: number, store: string) =>
    `Somebody who applies through this link and is approved by ${store} is yours: you earn ${percent}% of each sale they bring, on top of what they earn, which is not reduced. The share is fixed when they join, and does not reach the people they bring in turn.`,
  codesLabel: (count: number): string => (count === 1 ? "Your code" : "Your codes"),
  codeNoteOne:
    "Say it out loud, print it, put it in a caption. A buyer who types it at checkout earns you your share even if they never clicked your link — which is how a sale from a podcast, a stage or a video without links reaches you at all.",
  codeNoteMany:
    "Say them out loud, print them, put them in a caption. A buyer who types one at checkout earns you your share even if they never clicked your link.",
  percentOff: (percent: number) => `${percent}% off`,
  amountOff: (amount: string) => `${amount} off`,
  partnerShareLabel: "Your partner share",
  /** `products` is the titles, already joined, or sharedFallback. */
  partnerShare: (percent: number, products: string) =>
    `${percent}% of what a buyer pays before tax on every sale of ${products} — whoever brought the buyer, and whether or not they came through your link. A refunded sale earns nothing, a partly refunded one earns on what was kept, and your own purchases never earn.`,
  sharedFallback: "the products you share in",
  yourRate: (store: string, percent: number) =>
    `${store} set your share at ${percent}% of what a buyer pays before tax, on every one-time purchase through your link, except any product they took out of the program.`,

  // ---- Their numbers ----------------------------------------------------------------
  clicks: "Clicks",
  sales: "Sales",
  earned: "Earned",
  paidAhead: "Paid ahead",
  owedToYou: "Owed to you",
  paidSoFar: (amount: string, store: string) =>
    `Paid to you so far: ${amount}. ${store} pays you directly, out of their own account. Marktmorgen never holds this money, so there is no balance here to wait on and nothing to claim before a deadline.`,
  nextPayment: (date: string) => `Next payment: ${date}.`,
  waitingNote: (amount: string) => `${amount} of what you are owed is still inside that wait, and is not payable yet.`,
  refundsUnchecked:
    "Refunds and chargebacks could not all be checked just now, so a sale refunded or disputed recently may still show as earning. It is corrected when these figures next refresh.",
  /** When an affiliate's figures were worked out (lib/affiliate-book-snapshot.ts): `when` arrives written in the store's language, in UTC. Then figuresDaily, or figuresShort for an incomplete book worked out again sooner. */
  figuresAsOf: (when: string) => `Figures as of ${when}, Coordinated Universal Time (UTC).`,
  figuresDaily: "They refresh at most once a day.",
  figuresShort: "They can refresh again after 15 minutes.",
  /**
   * Shown while none are kept yet and none are being worked out for this load: another load is working them out,
   * or a recent refresh that kept nothing holds the next off (up to a day after a few incomplete ones), so no time is promised.
   */
  figuresSoon: "Your figures are not ready yet.",
  /** Shown when none are kept and working them out was refused because a limit on page views was reached: no time is promised, as it may take days. */
  figuresNoRoom: "Your figures cannot be updated right now because a limit on page views was reached. They will show again when there is room.",
  salesHead: "Sales through your link",
  noneYet: "None yet.",
  aProduct: "A product",
  /** "Oct 8, 2026 · $40 before tax · 20% · refunded"; `status` is "" for a sale that earns as it was. */
  tierLine: (date: string, amount: string, percent: number, status: string) =>
    `${date} · a sale by somebody you brought · ${amount} before tax · ${percent}%${status ? ` · ${status}` : ""}`,
  saleLine: (date: string, amount: string, percent: number, status: string) =>
    `${date} · ${amount} before tax · ${percent}%${status ? ` · ${status}` : ""}`,
  /** A sale's state (lib/affiliates.ts, settleLine), when it is not simply earned. */
  lineStatus: {
    "own purchase": "own purchase",
    refunded: "refunded",
    "partly refunded": "partly refunded",
  } as Record<string, string>,
  paidByHead: (store: string) => `Paid to you by ${store}`,

  // ---- Where they are paid -------------------------------------------------------------
  payPalLabel: "Where PayPal pays you",
  payPalNote: (store: string, email: string) =>
    `When ${store} pays you through PayPal, it goes to this address. Leave it empty to be paid at ${email}. We email ${email} whenever it changes.`,
  saved: "Saved.",
  payPalNotEmail: "That does not look like an email address. Nothing was changed.",
  payPalSlow: "Too many changes for now. Try again in an hour.",
  savePayPal: "Save my PayPal address",
  signOut: "Sign out on this browser",
  allPrograms: "All your affiliate programs on Marktmorgen, in one place",

  // ---- Joining from an order ---------------------------------------------------------------
  earnPercent: (percent: number, store: string) => `Earn ${percent}% by sharing ${store}`,
  buyerJoinBody: (store: string, days: number, percent: number) =>
    `You bought from ${store}, so you can have your own link now, without applying. A one-time purchase made through it within ${days} ${days === 1 ? "day" : "days"} of a click earns you ${percent}% of what the buyer paid before tax.`,
  getMyLink: "Get my link",
  /** `promise` is payoutPromise, already said. */
  buyerJoinNote: (promise: string, store: string) =>
    `${promise} ${store} pays you directly; Marktmorgen never holds this money. You join with the address you bought with.`,

  // ---- The program's terms ------------------------------------------------------------------
  earnBy: (store: string) => `Earn by sharing ${store}`,
  noProgram: (store: string) => `${store} has no affiliate program right now`,
  termShare: (percent: number, hasDifferent: boolean) =>
    `${percent}% of what a buyer pays before tax, on one-time purchases made through your link (memberships and payment plans do not earn)${hasDifferent ? "; some products differ, below" : ""}.`,
  /** Where memberships and plans earn (lib/affiliate-setting.ts recurring): "on purchases", with no exception. */
  termShareAll: (percent: number, hasDifferent: boolean) =>
    `${percent}% of what a buyer pays before tax, on purchases made through your link${hasDifferent ? "; some products differ, below" : ""}.`,
  /** `months`: 1, a number, or 1200 for as long as the member pays. */
  termRecurring: (months: number) =>
    months === 1
      ? "A membership earns on its first payment, and a payment plan on each of its payments."
      : months >= 1200
        ? "A membership earns on each of its payments for as long as the member keeps paying, and a payment plan on each of its payments."
        : `A membership earns on each of its payments in its first ${months} months, and a payment plan on each of its payments.`,
  termBonus: (sales: number, amount: string) =>
    `A bonus of ${amount} for any calendar month in which ${sales} ${plural(sales, "sale", "sales")} through your link earn.`,
  termNoPaidSearch: (store: string) =>
    `Paid search ads on ${store}'s name are not allowed: what you are owed is held until ${store} looks at a click that came from one.`,
  heldNote: (amount: string, store: string) => `${amount} of what you are owed is held until ${store} looks at it, and is not payable yet.`,
  bonusTitle: (sales: number, month: string) => `Bonus: ${sales} ${plural(sales, "sale", "sales")} in ${month}`,
  bonusLine: (date: string) => `${date} · bonus`,
  termRefunds: "A refunded sale earns nothing, a partly refunded one earns only on what was kept, and your own purchases never earn.",
  kit: {
    head: "Posts to share, drafted for you",
    intro: "Pick a product and get three short posts written from its page, with your link and a line saying you earn from it already in them. Read each one before you post it, and change anything that is not true for you.",
    product: "Product",
    note: "Who you share with, and how you know it (optional)",
    notePlaceholder: "For example: my followers bake at home; I have used the starter guide for a year",
    button: "Write three posts",
    working: "Writing…",
    left: (n: number) => (n === 1 ? "1 more today." : `${n} more today.`),
    labels: { x: "For X", instagram: "For Instagram", linkedin: "For LinkedIn" },
    errors: {
      day: "That is today's limit. Come back tomorrow.",
      month: "This store's posts for the month are used up. Write to the store if you need more.",
      failed: "Nothing came back this time. Try again in a moment.",
      other: "That could not be done. Reload the page and try again.",
    },
  },
  termDisclose: "Wherever you share your link, say that you earn from it, and promise only what the product does: no income or results it does not guarantee.",
  termBuyers: (store: string) =>
    `Anybody who bought from ${store} can join at once, from their order; everyone else applies and ${store} decides. ${store} pays you directly out of their own account: Marktmorgen never holds this money, so there is no minimum to reach and no deadline to claim it by.`,
  termApproves: (store: string) =>
    `${store} approves every affiliate, and pays you directly out of their own account: Marktmorgen never holds this money, so there is no minimum to reach and no deadline to claim it by.`,
  productRate: (title: string, percent: number) => `${title}: ${percent === 0 ? "not part of the program" : `${percent}%`}`,
  applyClosed: "Applications cannot be sent from here right now. Try again later.",
  whenOpens: (store: string) => `When ${store} opens one, this is where to apply.`,
  /**
   * Which link earns a sale (lib/affiliate-setting.ts, attributionWords): the
   * window is said as "up to", for as long as the browser keeps the cookie,
   * never as a flat promise.
   */
  attribution: (days: number, isFirst: boolean, isLifetime: boolean) => {
    const window = `up to ${days} ${days === 1 ? "day" : "days"}`;
    const kept = "for as long as the buyer's browser keeps the cookie — browsers set their own limit on that and shorten a long one without telling the site";
    const rule = isFirst
      ? `The first affiliate link a buyer follows earns the sale, ${window} after that first click and ${kept}, even if they follow somebody else's link later.`
      : `The last affiliate link a buyer follows earns the sale, ${window} after that click and ${kept}.`;
    return isLifetime
      ? `${rule} None of that applies once a sale has been credited: from then on the buyer stays with that affiliate, and everything the person buys afterward earns them, with no time limit, on any device, with no cookie involved at all.`
      : rule;
  },
  /** Added when the program credits its affiliates' confirmed leads (lib/affiliate-setting.ts, creditsContacts and CONTACTS_RULE). */
  contactsRule:
    "A one-off purchase not credited to an affiliate's link, an affiliate's code or an earlier purchase goes to the affiliate who brought the buyer as a confirmed lead before they bought, on any device and with no cookie involved.",
  /** When the creator pays (lib/affiliate-setting.ts, payoutPromise): `n` the day of the month, 0 for none; `days` the wait. */
  payoutPromise: (store: string, n: number, days: number) => {
    const wait = days > 0 ? ` A sale is payable ${days} ${days === 1 ? "day" : "days"} after it is made, so a refund in that time comes off it first.` : "";
    if (n < 1) return `${store} has not set a payment day, and pays when they choose.${wait}`;
    return `${store} pays on the ${ordinal(n)} of each month.${wait}`;
  },

  // ---- Emails to an affiliate ------------------------------------------------------------------
  payChangedSubject: (store: string) => `Where ${store} pays you changed`,
  payChangedLine: (store: string, address: string) => `The PayPal address ${store} pays your affiliate commissions to is now: ${address}.`,
  payChangedIfNot:
    "If you did not change it, open your affiliate page, change it back and sign out on every browser, then tell the store by replying to this email:",
  linkSubjectNew: (store: string) => `Confirm your affiliate application to ${store}`,
  linkIntroKnown: (store: string) => `Here is the way in to your affiliate page for ${store}:`,
  linkIntroNew: (store: string) => `You asked to become an affiliate of ${store}. Open this link and press the button to send your application:`,
  linkShowsKnown: "It shows your link, your clicks, your sales and what you have earned and been paid.",
  linkAboutNew: (store: string, days: number) =>
    `${store} decides on each application. Once you are approved, your page gives you your own link, and a one-time purchase made through it within ${days} ${days === 1 ? "day" : "days"} of a click earns you a share.`,
  paidByStore: (store: string) => `Commissions are paid to you by ${store} directly, not by Marktmorgen, which never holds the money.`,
  linkExpires: "The link works for 24 hours. If you did not ask for this, ignore this email; nothing happens unless the link is used.",
  approvedSubject: (store: string) => `You are an affiliate of ${store}`,
  approvedIntro: (store: string) => `${store} approved your application. Your link:`,
  approvedTerms: (days: number, percent: number, hasRates: boolean) =>
    `A one-time purchase made through it within ${days} ${days === 1 ? "day" : "days"} of a click earns you ${percent}% of what the buyer paid before tax${hasRates ? " (some products earn a different share; your page lists them)" : ""}. Memberships and payment plans do not earn, and a refunded sale earns nothing.`,
  approvedPage: (url: string) => `Your clicks, sales and earnings: ${url}`,
  /** Said on the affiliate page before anyone applies, when the program removes affiliates who bring nothing. */
  termIdle: (days: number, warn: number, withLeads: boolean) =>
    withLeads
      ? `An affiliate whose link brings no sale and no lead for ${days} days is removed from the program, after an email ${warn} days before with the date. One sale or one lead before then keeps them in.`
      : `An affiliate whose link brings no sale for ${days} days is removed from the program, after an email ${warn} days before with the date. One sale before then keeps them in.`,
  /** The warning before an affiliate who brings nothing is removed (630 [HN6](3), lib/affiliates.ts idleSweep). `date` is said in the store's language. */
  idleSubject: (store: string, date: string) => `Your affiliate link with ${store} ends on ${date}`,
  idleBody: (store: string, days: number, date: string, withLeads: boolean) =>
    withLeads
      ? `${store} removes affiliates whose link brings no sale and no lead for ${days} days. If yours brings neither before ${date}, you will be removed from the program on that day. One sale or one lead through your link before then keeps you in. Your record of clicks, sales and payments stays as it is.`
      : `${store} removes affiliates whose link brings no sale for ${days} days. If yours brings none before ${date}, you will be removed from the program on that day. One sale through your link before then keeps you in. Your record of clicks, sales and payments stays as it is.`,

  // ---- Emails to an invited partner ---------------------------------------------------------------
  partnerSubject: (store: string) => `${store} wants you as a partner`,
  partnerOffer: (store: string, percent: number) => `${store} is offering you ${percent}% of every sale of:`,
  someProduct: "a product",
  partnerInStudio: "It is waiting in your own studio, with the terms, to accept or decline:",
  partnerAnswer: "Nothing happens until you answer it. Declining tells them nothing beyond that you declined.",
  partnerTerms: (percent: number) =>
    `That is ${percent}% of what each buyer pays before tax, on every sale — not only the ones you send them. A refunded sale earns nothing, and a partly refunded one earns on what was kept.`,
  partnerOpen: "Open this link to accept and see your own page, which shows every sale you have earned on and what you have been paid:",
  partnerPays: (store: string) =>
    `${store} pays you directly, from their own account. Marktmorgen never holds this money, so there is no balance to wait on and nothing to claim by a deadline. You will be asked for the PayPal address to be paid at; you need no account with us.`,
  partnerExpires: "The link works for 24 hours. If this was not meant for you, ignore it; nothing happens unless the link is used.",

  // ---- Around a creator's email to their list (lib/mail.ts) -------------------------------------------
  listWhy: (name: string) => `You are getting this because you told ${name} you wanted to hear from them.`,
  footerUnsubscribe: "Unsubscribe",
  footerUnsubscribeAfter: (name: string) => `in one click, and ${name} will not email you again.`,
  unsubscribeText: (url: string) => `Unsubscribe in one click: ${url}`,
  /** The way out of an email that is not to the list, with its own words: "Remove my address: https://…". */
  doorText: (label: string, url: string) => `${label}: ${url}`,
  sentWith: "Sent with Marktmorgen.",

  // ---- The come-back offer (lib/winback-send.ts) --------------------------------------------------------
  winbackOffer: (percent: number, months: number) =>
    months === 1 ? `${percent}% off your first payment` : `${percent}% off your first ${months} payments`,
  winbackSubject: (title: string, offer: string) => `Come back to ${title}: ${offer}`,
  hi: "Hi,",
  winbackBody: (title: string, endedOn: string, offer: string, until: string) =>
    `Your membership for ${title} ended on ${endedOn}. If you'd like to come back, it's ${offer}, until ${until}:`,
  winbackLinkNote: "The link is for this email address only, and nothing is charged until you check out.",

  // ---- Stopping emails (app/unsubscribe) ------------------------------------------------------------------
  unknownLink: "This link is not one we know",
  unknownListBody: "Open the unsubscribe link from the email itself, or use your mail app's own unsubscribe button.",
  unknownOtherBody: "Open the link from the email itself, or use your mail app's own unsubscribe button.",
  onBehalfCreator: "Emails sent with Marktmorgen, on behalf of the creator who wrote them.",
  onBehalfStore: "Emails sent with Marktmorgen, on behalf of the store that sent them.",
  forEmail: (email: string) => `For ${email}. One press stops them for good.`,
  /** `who` is the creator's name, or "" when it is not known. */
  listDoneTitle: "You are unsubscribed",
  listDone: (email: string, who: string) => `${email} will not get emails from ${who || "this creator"} again. Nothing else is needed.`,
  listAsk: (who: string) => `Stop emails from ${who || "this creator"}?`,
  unsubscribeButton: "Unsubscribe",
  /** `where` is the community's name, or "" when it is not known. */
  communityDoneTitle: "No more emails from the community",
  communityDone: (email: string, who: string, where: string) =>
    `${email} will not be emailed ${who || "this creator"}'s announcements or live event reminders again. You are still in ${where || "the community"}, and can read them there. If an event you RSVP'd to is moved or canceled, you are still told, once.`,
  communityAsk: (who: string) => `Stop ${who || "this creator"}'s community emails?`,
  communityFor: (email: string, where: string) =>
    `Announcements and live event reminders, for ${email}. You stay in ${where || "the community"}, and keep your RSVPs; only the emails stop.`,
  stopEmails: "Stop the emails",
  remindersDoneTitle: "No more reminders",
  remindersDone: (email: string, who: string) => `${email} will not get checkout reminders from ${who || "this store"} again. Nothing else is needed.`,
  remindersAsk: (who: string) => `Stop checkout reminders from ${who || "this store"}?`,
  stopReminders: "Stop reminders",
  // A reader who allowed their link use in a sequence to be seen (lib/mail-clicks.ts).
  clicksOn: (name: string) => `You allowed ${name} to see which links in these emails you use.`,
  clicksStop: "Stop that",
  clicksStopText: (url: string) => `Stop that: ${url}`,
  clicksAsk: (name: string) => `Stop letting ${name || "this creator"} see which links you use?`,
  clicksFor: (email: string) => `For ${email}. You stay on the list; only the counting stops, and what was counted is deleted.`,
  clicksButton: "Stop counting my links",
  clicksDoneTitle: "Your links are no longer counted",
  clicksDone: (email: string, name: string) => `Which links ${email} uses in emails from ${name || "this creator"} is no longer counted, and what was counted has been deleted. You are still on the list.`,
  reviewsDoneTitle: "No more review requests",
  reviewsDone: (email: string, who: string) => `${email} will not be asked for a review by ${who || "this store"} again. Nothing else is needed.`,
  reviewsAsk: (who: string) => `Stop review requests from ${who || "this store"}?`,
  reviewsFor: (email: string) => `For ${email}. One press stops them for good. A review you already wrote stays as it is.`,
  stopReviews: "Stop review requests",
  /** Said on the stop page when the last press was not saved; the button is offered again. */
  reviewsNotSaved: "We could not save that just now. Please try again.",
};

export type AffiliatesWords = typeof en;

// ---- Spanish ---------------------------------------------------------------------------------------
const es: AffiliatesWords = {
  pageTitle: "Afiliados",
  notices: {
    email: { title: "Eso no parece una dirección de email", body: "Revísala e inténtalo de nuevo." },
    limited: {
      title: "Demasiadas solicitudes por ahora",
      body: "Para que nadie use este formulario para inundar la bandeja de entrada de otra persona, acepta un número limitado de solicitudes por hora. Inténtalo de nuevo dentro de una hora.",
    },
    unavailable: { title: "Esta tienda no está aceptando afiliados en este momento", body: "No se envió nada." },
    owner: { title: "Esta es la propia dirección de la tienda", body: "Una tienda no puede ser su propio afiliado." },
    full: {
      title: "Este programa está completo",
      body: "Tiene tantos afiliados como puede tener una tienda. Escribe a la tienda si quieres que te tengan en cuenta.",
    },
    error: { title: "Algo salió mal por nuestra parte", body: "No se cambió nada. Inténtalo de nuevo en un momento." },
    resting: { title: "Esta tienda no puede atender esto ahora", body: "Para aceptar, primero se comprueban los socios de la tienda, y la tienda no puede atender tantas solicitudes en este momento. No se cambió nada. Inténtalo más tarde o escribe a la tienda." },
    expired: {
      title: "Este enlace ha caducado",
      body: "Un enlace enviado por email funciona una sola vez, dentro de las 24 horas. Pide uno nuevo abajo; solo tarda unos segundos.",
    },
    order: {
      title: "No se pudo leer ese pedido",
      body: "Vuelve a abrir el enlace de tu email de compra, o envía tu solicitud abajo con la dirección con la que compraste.",
    },
    declined: {
      title: "No puedes unirte desde tu pedido",
      body: "Esta tienda ya tomó una decisión sobre esta dirección. Escribe a la tienda si crees que debería cambiar.",
    },
    signedout: { title: "Has cerrado sesión en este navegador", body: "Para volver a ver tu página de afiliado, pide un enlace nuevo abajo." },
  },

  whereShare: "Dónde lo compartirías",
  optional: "(opcional)",
  notePlaceholder: "Mi newsletter, mi canal de YouTube…",
  emailMeLink: "Envíame un enlace para presentar mi solicitud",
  formNote:
    "Sin contraseña. El enlace confirma que la dirección es tuya; al abrirlo se envía tu solicitud. ¿Ya eres afiliado? El mismo formulario te envía por email el acceso de vuelta a tu página.",
  continueAs: (email) => `Continuar como ${email}`,
  continueBody: (store) =>
    `Pulsa el botón para abrir tu página de afiliado de ${store} en este navegador. Si aún no has enviado tu solicitud, esto la envía.`,
  openMyPage: "Abrir mi página de afiliado",
  checkInbox: "Revisa tu bandeja de entrada",
  sentBody: (store) =>
    `El enlace va en camino. Llega de ${store} a través de Marktmorgen y suele tardar menos de un minuto. Si no está, mira en spam.`,

  appliedTitle: "Tu solicitud está enviada",
  joinedTitle: "Tu enlace está listo",
  welcomeTitle: "Has iniciado sesión en este navegador",
  appliedBody: (store) => `Ya se ha avisado a ${store}. Si aprueba tu solicitud, recibirás un email con tu enlace.`,
  joinedBody:
    "Compártelo donde quieras. Sigues con la sesión iniciada en este navegador durante 30 días, y el mismo formulario de abajo te envía por email el acceso de vuelta.",
  welcomeBody: "Sigues con la sesión iniciada en este navegador durante 30 días.",

  badgeAffiliate: "Afiliado",
  badgePaused: "Programa en pausa",
  badgePending: "Pendiente de aprobación",
  badgeDeclined: "No aprobado",
  badgeRemoved: "Ya no eres afiliado",
  yourPageFor: (store) => `Tu página de afiliado de ${store}`,
  pendingBody: (store) => `${store} decide sobre cada solicitud. Si aprueba la tuya, recibirás un email con tu enlace.`,
  pausedBody: (store) => `${store} ha pausado el programa, así que los enlaces no generan ganancias por ahora. Lo que ya ganaste está abajo.`,
  declinedBody: (store) => `${store} no aprobó esta solicitud.`,
  removedBody: (store) =>
    `${store} puso fin a tu lugar en el programa, así que tu enlace ya no genera ganancias. Lo que ganaste antes está abajo.`,

  yourLink: "Tu enlace",
  copy: "Copiar",
  copied: "Copiado",
  orAddVia: (code) => `O añade ?via=${code} a la dirección de cualquier página de esta tienda.`,
  recruitLabel: "Tu enlace de invitación",
  recruitNote: (percent, store) =>
    `Quien solicite unirse con este enlace y sea aprobado por ${store} queda contigo: ganas el ${percent}${S}% de cada venta que traiga, además de lo que gana esa persona, que no se reduce. La parte queda fija cuando se une, y no alcanza a las personas que traiga a su vez.`,
  codesLabel: (count) => (count === 1 ? "Tu código" : "Tus códigos"),
  codeNoteOne:
    "Dilo en voz alta, imprímelo, ponlo en un pie de foto. Un comprador que lo escriba al pagar te hace ganar tu parte aunque nunca haya hecho clic en tu enlace — es la única forma de que te llegue una venta desde un podcast, un escenario o un video sin enlaces.",
  codeNoteMany:
    "Dilos en voz alta, imprímelos, ponlos en un pie de foto. Un comprador que escriba uno al pagar te hace ganar tu parte aunque nunca haya hecho clic en tu enlace.",
  percentOff: (percent) => `${percent}${S}% de descuento`,
  amountOff: (amount) => `${amount} de descuento`,
  partnerShareLabel: "Tu participación como socio",
  partnerShare: (percent, products) =>
    `${percent}${S}% de lo que paga un comprador antes de impuestos en cada venta de ${products} — sin importar quién trajo al comprador, ni si llegó o no por tu enlace. Una venta reembolsada no genera nada, una reembolsada en parte genera sobre lo que se conservó, y tus propias compras nunca generan nada.`,
  sharedFallback: "los productos en los que participas",
  yourRate: (store, percent) =>
    `${store} fijó tu parte en el ${percent}${S}% de lo que paga un comprador antes de impuestos, en cada compra única hecha a través de tu enlace, excepto los productos que haya retirado del programa.`,

  clicks: "Clics",
  sales: "Ventas",
  earned: "Ganado",
  paidAhead: "Pagado por adelantado",
  owedToYou: "Se te debe",
  paidSoFar: (amount, store) =>
    `Pagado hasta ahora: ${amount}. ${store} te paga directamente, desde su propia cuenta. Marktmorgen nunca retiene este dinero, así que aquí no hay saldo que esperar ni nada que reclamar antes de una fecha límite.`,
  nextPayment: (date) => `Próximo pago: ${date}.`,
  waitingNote: (amount) => `${amount} de lo que se te debe aún está dentro de ese plazo de espera, y todavía no se puede pagar.`,
  refundsUnchecked:
    "No se pudieron comprobar todos los reembolsos ahora mismo, así que una venta reembolsada hace poco puede seguir apareciendo como si generara ganancias. Se corrige cuando estas cifras se actualicen de nuevo.",
  figuresAsOf: (when: string) => `Cifras del ${when}, tiempo universal coordinado (UTC).`,
  figuresDaily: "Se actualizan como máximo una vez al día.",
  figuresShort: "Pueden actualizarse de nuevo pasados 15 minutos.",
  figuresSoon: "Tus cifras todavía no están listas.",
  figuresNoRoom: "Tus cifras no se pueden actualizar ahora porque se alcanzó un límite de visitas a páginas. Volverán a mostrarse cuando haya margen.",
  salesHead: "Ventas a través de tu enlace",
  noneYet: "Ninguna todavía.",
  aProduct: "Un producto",
  tierLine: (date, amount, percent, status) =>
    `${date} · una venta de alguien que trajiste · ${amount} antes de impuestos · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  saleLine: (date, amount, percent, status) =>
    `${date} · ${amount} antes de impuestos · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  lineStatus: { "own purchase": "compra propia", refunded: "reembolsada", "partly refunded": "reembolsada en parte" },
  paidByHead: (store) => `Lo que te ha pagado ${store}`,

  payPalLabel: "Dónde te paga PayPal",
  payPalNote: (store, email) =>
    `Cuando ${store} te paga por PayPal, el pago va a esta dirección. Déjala vacía para cobrar en ${email}. Enviamos un email a ${email} cada vez que cambia.`,
  saved: "Guardado.",
  payPalNotEmail: "Eso no parece una dirección de email. No se cambió nada.",
  payPalSlow: "Demasiados cambios por ahora. Inténtalo de nuevo dentro de una hora.",
  savePayPal: "Guardar mi dirección de PayPal",
  signOut: "Cerrar sesión en este navegador",
  allPrograms: "Todos tus programas de afiliados en Marktmorgen, en un solo lugar",

  earnPercent: (percent, store) => `Gana un ${percent}${S}% compartiendo ${store}`,
  buyerJoinBody: (store, days, percent) =>
    `Compraste en ${store}, así que puedes tener tu propio enlace ahora, sin enviar solicitud. Una compra única hecha a través de él dentro de ${days} ${plural(days, "día", "días")} desde un clic te hace ganar el ${percent}${S}% de lo que pagó el comprador antes de impuestos.`,
  getMyLink: "Obtener mi enlace",
  buyerJoinNote: (promise, store) =>
    `${promise} ${store} te paga directamente; Marktmorgen nunca retiene este dinero. Te unes con la dirección con la que compraste.`,

  earnBy: (store) => `Gana compartiendo ${store}`,
  noProgram: (store) => `${store} no tiene programa de afiliados por ahora`,
  termShare: (percent, hasDifferent) =>
    `${percent}${S}% de lo que paga un comprador antes de impuestos, en compras únicas hechas a través de tu enlace (las membresías y los pagos a plazos no generan nada)${hasDifferent ? "; algunos productos son distintos, abajo" : ""}.`,
  termShareAll: (percent, hasDifferent) =>
    `${percent}${S}% de lo que paga un comprador antes de impuestos, en compras hechas a través de tu enlace${hasDifferent ? "; algunos productos son distintos, abajo" : ""}.`,
  termRecurring: (months) =>
    months === 1
      ? "Una membresía genera comisión en su primer pago, y un pago a plazos en cada uno de sus pagos."
      : months >= 1200
        ? "Una membresía genera comisión en cada uno de sus pagos mientras el miembro siga pagando, y un pago a plazos en cada uno de sus pagos."
        : `Una membresía genera comisión en cada uno de sus pagos durante sus primeros ${months} meses, y un pago a plazos en cada uno de sus pagos.`,
  termBonus: (sales, amount) =>
    `Un bono de ${amount} en cada mes natural en el que ${sales} ${plural(sales, "venta", "ventas")} a través de tu enlace ${plural(sales, "genere", "generen")} comisión.`,
  termNoPaidSearch: (store) =>
    `No se permiten anuncios de búsqueda pagados con el nombre de ${store}: lo que se te debe queda retenido hasta que ${store} revise un clic que venga de uno.`,
  heldNote: (amount, store) => `${amount} de lo que se te debe está retenido hasta que ${store} lo revise, y todavía no se puede pagar.`,
  bonusTitle: (sales, month) => `Bono: ${sales} ${plural(sales, "venta", "ventas")} en ${month}`,
  bonusLine: (date) => `${date} · bono`,
  termRefunds:
    "Una venta reembolsada no genera nada, una reembolsada en parte genera solo sobre lo que se conservó, y tus propias compras nunca generan nada.",
  kit: {
    head: "Publicaciones para compartir, redactadas para ti",
    intro: "Elige un producto y recibe tres publicaciones cortas escritas a partir de su página, con tu enlace y una línea que dice que ganas una comisión ya incluidos. Lee cada una antes de publicarla y cambia lo que no sea cierto para ti.",
    product: "Producto",
    note: "Con quién compartes y cómo lo conoces (opcional)",
    notePlaceholder: "Por ejemplo: mis seguidores hornean en casa; uso la guía de masa madre desde hace un año",
    button: "Escribir tres publicaciones",
    working: "Escribiendo…",
    left: (n) => (n === 1 ? "Te queda 1 hoy." : `Te quedan ${n} hoy.`),
    labels: { x: "Para X", instagram: "Para Instagram", linkedin: "Para LinkedIn" },
    errors: {
      day: "Llegaste al límite de hoy. Vuelve mañana.",
      month: "Las publicaciones de esta tienda para este mes se agotaron. Escribe a la tienda si necesitas más.",
      failed: "Esta vez no llegó nada. Inténtalo de nuevo en un momento.",
      other: "No se pudo hacer. Recarga la página e inténtalo de nuevo.",
    },
  },
  termDisclose: "Dondequiera que compartas tu enlace, di que ganas una comisión con él, y promete solo lo que el producto hace: ni ingresos ni resultados que no garantice.",
  termBuyers: (store) =>
    `Quien haya comprado en ${store} puede unirse al instante, desde su pedido; los demás envían una solicitud y ${store} decide. ${store} te paga directamente desde su propia cuenta: Marktmorgen nunca retiene este dinero, así que no hay mínimo que alcanzar ni fecha límite para reclamarlo.`,
  termApproves: (store) =>
    `${store} aprueba a cada afiliado y te paga directamente desde su propia cuenta: Marktmorgen nunca retiene este dinero, así que no hay mínimo que alcanzar ni fecha límite para reclamarlo.`,
  productRate: (title, percent) => `${title}: ${percent === 0 ? "no forma parte del programa" : `${percent}${S}%`}`,
  applyClosed: "Ahora mismo no se pueden enviar solicitudes desde aquí. Inténtalo más tarde.",
  whenOpens: (store) => `Cuando ${store} abra uno, aquí es donde podrás enviar tu solicitud.`,
  attribution: (days, isFirst, isLifetime) => {
    const window = `hasta ${days} ${plural(days, "día", "días")}`;
    const kept = "mientras el navegador del comprador conserve la cookie — los navegadores fijan su propio límite para eso y acortan uno largo sin avisar al sitio";
    const rule = isFirst
      ? `El primer enlace de afiliado que sigue un comprador se lleva la venta, ${window} después de ese primer clic y ${kept}, aunque más tarde siga el enlace de otra persona.`
      : `El último enlace de afiliado que sigue un comprador se lleva la venta, ${window} después de ese clic y ${kept}.`;
    return isLifetime
      ? `${rule} Nada de eso se aplica una vez que se ha acreditado una venta: desde entonces el comprador se queda con ese afiliado, y todo lo que esa persona compre después le hace ganar, sin límite de tiempo, en cualquier dispositivo y sin ninguna cookie de por medio.`
      : rule;
  },
  contactsRule:
    "Una compra única que no se atribuye a ningún enlace ni código de afiliado ni a una compra anterior va al afiliado que trajo al comprador como lead confirmado antes de que comprara, en cualquier dispositivo y sin ninguna cookie de por medio.",
  payoutPromise: (store, n, days) => {
    const wait = days > 0 ? ` Una venta se puede pagar ${days} ${plural(days, "día", "días")} después de hacerse, así que un reembolso en ese tiempo se descuenta primero.` : "";
    if (n < 1) return `${store} no ha fijado un día de pago, y paga cuando decide.${wait}`;
    return `${store} paga el día ${n} de cada mes.${wait}`;
  },

  payChangedSubject: (store) => `Cambió la dirección donde ${store} te paga`,
  payChangedLine: (store, address) => `La dirección de PayPal a la que ${store} paga tus comisiones de afiliado es ahora: ${address}.`,
  payChangedIfNot:
    "Si no la cambiaste tú, abre tu página de afiliado, vuelve a dejarla como estaba y cierra sesión en todos los navegadores; después avisa a la tienda respondiendo a este email:",
  linkSubjectNew: (store) => `Confirma tu solicitud de afiliado a ${store}`,
  linkIntroKnown: (store) => `Este es el acceso a tu página de afiliado de ${store}:`,
  linkIntroNew: (store) => `Pediste ser afiliado de ${store}. Abre este enlace y pulsa el botón para enviar tu solicitud:`,
  linkShowsKnown: "Muestra tu enlace, tus clics, tus ventas y lo que has ganado y cobrado.",
  linkAboutNew: (store, days) =>
    `${store} decide sobre cada solicitud. Una vez aprobado, tu página te da tu propio enlace, y una compra única hecha a través de él dentro de ${days} ${plural(days, "día", "días")} desde un clic te hace ganar una parte.`,
  paidByStore: (store) => `Las comisiones te las paga ${store} directamente, no Marktmorgen, que nunca retiene el dinero.`,
  linkExpires: "El enlace funciona durante 24 horas. Si no lo pediste, ignora este email; no pasa nada a menos que se use el enlace.",
  approvedSubject: (store) => `Ya eres afiliado de ${store}`,
  approvedIntro: (store) => `${store} aprobó tu solicitud. Tu enlace:`,
  approvedTerms: (days, percent, hasRates) =>
    `Una compra única hecha a través de él dentro de ${days} ${plural(days, "día", "días")} desde un clic te hace ganar el ${percent}${S}% de lo que pagó el comprador antes de impuestos${hasRates ? " (algunos productos generan una parte distinta; tu página los indica)" : ""}. Las membresías y los pagos a plazos no generan nada, y una venta reembolsada no genera nada.`,
  approvedPage: (url) => `Tus clics, ventas y ganancias: ${url}`,
  termIdle: (days, warn, withLeads) =>
    withLeads
      ? `Un afiliado cuyo enlace no trae ninguna venta ni ningún lead durante ${days} días sale del programa, tras un correo ${warn} días antes con la fecha. Una venta o un lead antes de esa fecha lo mantiene dentro.`
      : `Un afiliado cuyo enlace no trae ninguna venta durante ${days} días sale del programa, tras un correo ${warn} días antes con la fecha. Una venta antes de esa fecha lo mantiene dentro.`,
  idleSubject: (store, date) => `Tu enlace de afiliado de ${store} termina el ${date}`,
  idleBody: (store, days, date, withLeads) =>
    withLeads
      ? `${store} retira a los afiliados cuyo enlace no trae ninguna venta ni ningún lead durante ${days} días. Si el tuyo no trae ninguno antes del ${date}, saldrás del programa ese día. Una venta o un lead a través de tu enlace antes de esa fecha te mantiene dentro. Tu historial de clics, ventas y pagos se conserva tal como está.`
      : `${store} retira a los afiliados cuyo enlace no trae ninguna venta durante ${days} días. Si el tuyo no trae ninguna antes del ${date}, saldrás del programa ese día. Una venta a través de tu enlace antes de esa fecha te mantiene dentro. Tu historial de clics, ventas y pagos se conserva tal como está.`,

  partnerSubject: (store) => `${store} te quiere como socio`,
  partnerOffer: (store, percent) => `${store} te ofrece el ${percent}${S}% de cada venta de:`,
  someProduct: "un producto",
  partnerInStudio: "Te espera en tu propio estudio, con las condiciones, para que la aceptes o la rechaces:",
  partnerAnswer: "No pasa nada hasta que respondas. Si la rechazas, solo sabrán que la rechazaste.",
  partnerTerms: (percent) =>
    `Es el ${percent}${S}% de lo que paga cada comprador antes de impuestos, en cada venta — no solo en las que tú les envíes. Una venta reembolsada no genera nada, y una reembolsada en parte genera sobre lo que se conservó.`,
  partnerOpen: "Abre este enlace para aceptar y ver tu propia página, que muestra cada venta por la que has ganado y lo que se te ha pagado:",
  partnerPays: (store) =>
    `${store} te paga directamente, desde su propia cuenta. Marktmorgen nunca retiene este dinero, así que no hay saldo que esperar ni nada que reclamar antes de una fecha límite. Se te pedirá la dirección de PayPal en la que quieres cobrar; no necesitas una cuenta con nosotros.`,
  partnerExpires: "El enlace funciona durante 24 horas. Si esto no era para ti, ignóralo; no pasa nada a menos que se use el enlace.",

  listWhy: (name) => `Recibes esto porque le dijiste a ${name} que querías recibir sus noticias.`,
  footerUnsubscribe: "Date de baja",
  footerUnsubscribeAfter: (name) => `con un clic, y ${name} no te volverá a escribir.`,
  unsubscribeText: (url) => `Date de baja con un clic: ${url}`,
  doorText: (label, url) => `${label}: ${url}`,
  sentWith: "Enviado con Marktmorgen.",

  winbackOffer: (percent, months) =>
    months === 1 ? `${percent}${S}% de descuento en tu primer pago` : `${percent}${S}% de descuento en tus primeros ${months} pagos`,
  winbackSubject: (title, offer) => `Vuelve a ${title}: ${offer}`,
  hi: "Hola:",
  winbackBody: (title, endedOn, offer, until) =>
    `Tu membresía de ${title} terminó el ${endedOn}. Si quieres volver, tienes ${offer}, hasta el ${until}:`,
  winbackLinkNote: "El enlace es solo para esta dirección de email, y no se cobra nada hasta que completes el pago.",

  unknownLink: "No reconocemos este enlace",
  unknownListBody: "Abre el enlace para darte de baja desde el propio email, o usa el botón para darte de baja de tu app de correo.",
  unknownOtherBody: "Abre el enlace desde el propio email, o usa el botón para darte de baja de tu app de correo.",
  onBehalfCreator: "Emails enviados con Marktmorgen, en nombre del creador que los escribió.",
  onBehalfStore: "Emails enviados con Marktmorgen, en nombre de la tienda que los envió.",
  forEmail: (email) => `Para ${email}. Con una sola pulsación dejan de llegar para siempre.`,
  listDoneTitle: "Te has dado de baja",
  listDone: (email, who) => `${email} no volverá a recibir emails de ${who || "este creador"}. No hace falta nada más.`,
  listAsk: (who) => `¿Dejar de recibir emails de ${who || "este creador"}?`,
  unsubscribeButton: "Darme de baja",
  communityDoneTitle: "No más emails de la comunidad",
  communityDone: (email, who, where) =>
    `${email} no volverá a recibir por email los anuncios de ${who || "este creador"} ni los recordatorios de eventos en vivo. Sigues en ${where || "la comunidad"} y puedes leerlos allí. Si un evento al que confirmaste asistencia se cambia o se cancela, se te avisa igualmente, una vez.`,
  communityAsk: (who) => `¿Dejar de recibir los emails de la comunidad de ${who || "este creador"}?`,
  communityFor: (email, where) =>
    `Anuncios y recordatorios de eventos en vivo, para ${email}. Sigues en ${where || "la comunidad"} y conservas tus confirmaciones de asistencia; solo dejan de llegar los emails.`,
  stopEmails: "Dejar de recibir los emails",
  remindersDoneTitle: "No más recordatorios",
  remindersDone: (email, who) =>
    `${email} no volverá a recibir recordatorios de compras sin terminar de ${who || "esta tienda"}. No hace falta nada más.`,
  remindersAsk: (who) => `¿Dejar de recibir recordatorios de compras sin terminar de ${who || "esta tienda"}?`,
  stopReminders: "Dejar de recibir recordatorios",
  clicksOn: (name) => `Permitiste que ${name} vea qué enlaces de estos emails usas.`,
  clicksStop: "Dejar de permitirlo",
  clicksStopText: (url) => `Dejar de permitirlo: ${url}`,
  clicksAsk: (name) => `¿Dejar de permitir que ${name || "este creador"} vea qué enlaces usas?`,
  clicksFor: (email) => `Para ${email}. Sigues en la lista; solo deja de contarse, y lo contado se borra.`,
  clicksButton: "Dejar de contar mis enlaces",
  clicksDoneTitle: "Tus enlaces ya no se cuentan",
  clicksDone: (email, name) => `Ya no se cuenta qué enlaces usa ${email} en los emails de ${name || "este creador"}, y lo contado se ha borrado. Sigues en la lista.`,
  reviewsDoneTitle: "No más solicitudes de reseña",
  reviewsDone: (email, who) => `${email} no recibirá más solicitudes de reseña de ${who || "esta tienda"}. No hace falta nada más.`,
  reviewsAsk: (who) => `¿Dejar de recibir solicitudes de reseña de ${who || "esta tienda"}?`,
  reviewsFor: (email) => `Para ${email}. Con una sola pulsación dejan de llegar para siempre. Una reseña que ya escribiste se queda como está.`,
  stopReviews: "Dejar de recibir solicitudes de reseña",
  reviewsNotSaved: "No pudimos guardarlo ahora. Inténtalo de nuevo.",
};

// ---- French ------------------------------------------------------------------------------------------
const fr: AffiliatesWords = {
  pageTitle: "Affiliation",
  notices: {
    email: { title: "Cela ne ressemble pas à une adresse e-mail", body: "Vérifiez-la et réessayez." },
    limited: {
      title: "Trop de demandes pour le moment",
      body: "Pour éviter que ce formulaire serve à inonder la boîte de réception de quelqu'un, il n'accepte qu'un nombre limité de demandes par heure. Réessayez dans une heure.",
    },
    unavailable: { title: "Cette boutique n'accepte pas d'affiliés pour le moment", body: "Rien n'a été envoyé." },
    owner: { title: "C'est l'adresse de la boutique elle-même", body: "Une boutique ne peut pas être son propre affilié." },
    full: {
      title: "Ce programme est complet",
      body: "Il compte autant d'affiliés qu'une boutique peut en avoir. Écrivez à la boutique si vous souhaitez être pris en considération.",
    },
    error: { title: "Un problème est survenu de notre côté", body: "Rien n'a été modifié. Réessayez dans un instant." },
    resting: { title: "Cette boutique ne peut pas traiter cela pour le moment", body: "Accepter vérifie d'abord les partenaires de la boutique, et la boutique ne peut pas traiter autant de requêtes pour le moment. Rien n'a été modifié. Réessayez plus tard ou écrivez à la boutique." },
    expired: {
      title: "Ce lien a expiré",
      body: `Un lien envoyé par e-mail ne fonctionne qu'une fois, dans les 24${S}heures. Demandez-en un nouveau ci-dessous${S}; cela ne prend que quelques secondes.`,
    },
    order: {
      title: "Cette commande n'a pas pu être lue",
      body: "Rouvrez le lien de votre e-mail d'achat, ou postulez ci-dessous avec l'adresse utilisée pour l'achat.",
    },
    declined: {
      title: "Vous ne pouvez pas rejoindre le programme depuis votre commande",
      body: "Cette boutique a déjà pris une décision sur cette adresse. Écrivez à la boutique si vous pensez que cela devrait changer.",
    },
    signedout: { title: "Vous êtes déconnecté sur ce navigateur", body: "Pour revoir votre page d'affilié, demandez un nouveau lien ci-dessous." },
  },

  whereShare: "Où vous le partageriez",
  optional: "(facultatif)",
  notePlaceholder: "Ma newsletter, ma chaîne YouTube…",
  emailMeLink: "M'envoyer un lien pour postuler",
  formNote: `Pas de mot de passe. Le lien confirme que l'adresse est bien la vôtre${S}; l'ouvrir envoie votre candidature. Déjà affilié${S}? Le même formulaire vous envoie par e-mail le chemin du retour vers votre page.`,
  continueAs: (email) => `Continuer en tant que ${email}`,
  continueBody: (store) =>
    `Appuyez sur le bouton pour ouvrir votre page d'affilié de ${store} sur ce navigateur. Si vous n'avez pas encore postulé, cela envoie votre candidature.`,
  openMyPage: "Ouvrir ma page d'affilié",
  checkInbox: "Consultez votre boîte de réception",
  sentBody: (store) =>
    `Le lien est en route. Il vient de ${store} via Marktmorgen et arrive généralement en moins d'une minute. S'il n'est pas là, regardez dans les spams.`,

  appliedTitle: "Votre candidature est envoyée",
  joinedTitle: "Votre lien est prêt",
  welcomeTitle: "Vous êtes connecté sur ce navigateur",
  appliedBody: (store) => `Nous avons prévenu ${store}. Si votre candidature est approuvée, vous recevrez un e-mail avec votre lien.`,
  joinedBody: `Partagez-le où vous voulez. Vous restez connecté sur ce navigateur pendant 30${S}jours, et le même formulaire ci-dessous vous envoie par e-mail le chemin du retour.`,
  welcomeBody: `Vous restez connecté sur ce navigateur pendant 30${S}jours.`,

  badgeAffiliate: "Affilié",
  badgePaused: "Programme en pause",
  badgePending: "En attente d'approbation",
  badgeDeclined: "Non approuvé",
  badgeRemoved: "Vous n'êtes plus affilié",
  yourPageFor: (store) => `Votre page d'affilié pour ${store}`,
  pendingBody: (store) => `${store} décide de chaque candidature. Si la vôtre est approuvée, vous recevrez un e-mail avec votre lien.`,
  pausedBody: (store) =>
    `${store} a mis le programme en pause${S}: les liens ne rapportent rien pour le moment. Ce que vous avez déjà gagné figure ci-dessous.`,
  declinedBody: (store) => `${store} n'a pas approuvé cette candidature.`,
  removedBody: (store) =>
    `${store} a mis fin à votre participation au programme${S}: votre lien ne rapporte plus rien. Ce que vous avez gagné auparavant figure ci-dessous.`,

  yourLink: "Votre lien",
  copy: "Copier",
  copied: "Copié",
  orAddVia: (code) => `Ou ajoutez ?via=${code} à l'adresse de n'importe quelle page de cette boutique.`,
  recruitLabel: "Votre lien d'invitation",
  recruitNote: (percent, store) =>
    `Une personne qui postule par ce lien et que ${store} approuve est la vôtre${S}: vous gagnez ${percent}${S}% de chaque vente qu'elle apporte, en plus de ce qu'elle gagne, qui n'est pas réduit. La part est fixée à son arrivée, et ne s'applique pas aux personnes qu'elle amène à son tour.`,
  codesLabel: (count) => (count < 2 ? "Votre code" : "Vos codes"),
  codeNoteOne:
    "Dites-le à voix haute, imprimez-le, mettez-le dans une légende. Un acheteur qui le saisit au paiement vous rapporte votre part même s'il n'a jamais cliqué sur votre lien — c'est la seule façon pour qu'une vente venue d'un podcast, d'une scène ou d'une vidéo sans liens vous revienne.",
  codeNoteMany:
    "Dites-les à voix haute, imprimez-les, mettez-les dans une légende. Un acheteur qui en saisit un au paiement vous rapporte votre part même s'il n'a jamais cliqué sur votre lien.",
  percentOff: (percent) => `${percent}${S}% de réduction`,
  amountOff: (amount) => `${amount} de réduction`,
  partnerShareLabel: "Votre part de partenaire",
  partnerShare: (percent, products) =>
    `${percent}${S}% de ce qu'un acheteur paie hors taxes sur chaque vente de ${products} — quelle que soit la personne qui a amené l'acheteur, et qu'il soit passé ou non par votre lien. Une vente remboursée ne rapporte rien, une vente partiellement remboursée rapporte sur ce qui a été conservé, et vos propres achats ne rapportent jamais rien.`,
  sharedFallback: "les produits dont vous partagez les ventes",
  yourRate: (store, percent) =>
    `${store} a fixé votre part à ${percent}${S}% de ce qu'un acheteur paie hors taxes, sur chaque achat unique effectué via votre lien, sauf pour les produits retirés du programme.`,

  clicks: "Clics",
  sales: "Ventes",
  earned: "Gagné",
  paidAhead: "Payé d'avance",
  owedToYou: "À vous verser",
  paidSoFar: (amount, store) =>
    `Déjà versé${S}: ${amount}. ${store} vous paie directement, depuis son propre compte. Marktmorgen ne détient jamais cet argent${S}: il n'y a donc ici aucun solde à attendre ni rien à réclamer avant une date limite.`,
  nextPayment: (date) => `Prochain paiement${S}: ${date}.`,
  waitingNote: (amount) => `${amount} de ce qui vous est dû est encore dans ce délai d'attente et n'est pas encore payable.`,
  refundsUnchecked: `Tous les remboursements n'ont pas pu être vérifiés à l'instant${S}: une vente remboursée récemment peut donc encore apparaître comme rapportant de l'argent. C'est corrigé à la prochaine mise à jour de ces chiffres.`,
  figuresAsOf: (when: string) => `Chiffres du ${when}, temps universel coordonné (UTC).`,
  figuresDaily: "Ils sont mis à jour au plus une fois par jour.",
  figuresShort: "Ils peuvent être mis à jour à nouveau après 15 minutes.",
  figuresSoon: "Vos chiffres ne sont pas encore prêts.",
  figuresNoRoom: "Vos chiffres ne peuvent pas être mis à jour pour l'instant, car une limite de pages vues a été atteinte. Ils réapparaîtront quand il y aura de nouveau de la marge.",
  salesHead: "Ventes via votre lien",
  noneYet: "Aucune pour l'instant.",
  aProduct: "Un produit",
  tierLine: (date, amount, percent, status) =>
    `${date} · une vente d'une personne que vous avez amenée · ${amount} hors taxes · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  saleLine: (date, amount, percent, status) => `${date} · ${amount} hors taxes · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  lineStatus: { "own purchase": "achat personnel", refunded: "remboursée", "partly refunded": "partiellement remboursée" },
  paidByHead: (store) => `Ce que ${store} vous a versé`,

  payPalLabel: "Où PayPal vous paie",
  payPalNote: (store, email) =>
    `Quand ${store} vous paie par PayPal, le paiement va à cette adresse. Laissez-la vide pour être payé à ${email}. Nous écrivons à ${email} chaque fois qu'elle change.`,
  saved: "Enregistré.",
  payPalNotEmail: "Cela ne ressemble pas à une adresse e-mail. Rien n'a été modifié.",
  payPalSlow: "Trop de modifications pour le moment. Réessayez dans une heure.",
  savePayPal: "Enregistrer mon adresse PayPal",
  signOut: "Se déconnecter sur ce navigateur",
  allPrograms: "Tous vos programmes d'affiliation sur Marktmorgen, au même endroit",

  earnPercent: (percent, store) => `Gagnez ${percent}${S}% en partageant ${store}`,
  buyerJoinBody: (store, days, percent) =>
    `Vous avez acheté chez ${store}, vous pouvez donc avoir votre propre lien dès maintenant, sans postuler. Un achat unique effectué via ce lien au plus ${days}${S}${pluralFr(days, "jour", "jours")} après un clic vous rapporte ${percent}${S}% de ce que l'acheteur a payé hors taxes.`,
  getMyLink: "Obtenir mon lien",
  buyerJoinNote: (promise, store) =>
    `${promise} ${store} vous paie directement${S}; Marktmorgen ne détient jamais cet argent. Vous rejoignez le programme avec l'adresse utilisée pour l'achat.`,

  earnBy: (store) => `Gagnez de l'argent en partageant ${store}`,
  noProgram: (store) => `${store} n'a pas de programme d'affiliation pour le moment`,
  termShare: (percent, hasDifferent) =>
    `${percent}${S}% de ce qu'un acheteur paie hors taxes, sur les achats uniques effectués via votre lien (les abonnements et les paiements échelonnés ne rapportent rien)${hasDifferent ? `${S}; certains produits diffèrent, voir ci-dessous` : ""}.`,
  termShareAll: (percent, hasDifferent) =>
    `${percent}${S}% de ce qu'un acheteur paie hors taxes, sur les achats effectués via votre lien${hasDifferent ? `${S}; certains produits diffèrent, voir ci-dessous` : ""}.`,
  termRecurring: (months) =>
    months === 1
      ? "Un abonnement rapporte sur son premier paiement, et un paiement échelonné sur chacun de ses paiements."
      : months >= 1200
        ? "Un abonnement rapporte sur chacun de ses paiements tant que le membre continue de payer, et un paiement échelonné sur chacun de ses paiements."
        : `Un abonnement rapporte sur chacun de ses paiements pendant ses ${months} premiers mois, et un paiement échelonné sur chacun de ses paiements.`,
  termBonus: (sales, amount) =>
    `Une prime de ${amount} pour chaque mois civil où ${sales} ${pluralFr(sales, "vente", "ventes")} via votre lien ${pluralFr(sales, "rapporte", "rapportent")} une commission.`,
  termNoPaidSearch: (store) =>
    `Les annonces payantes sur les moteurs de recherche au nom de ${store} ne sont pas autorisées${S}: ce qui vous est dû est retenu jusqu'à ce que ${store} examine un clic venu de l'une d'elles.`,
  heldNote: (amount, store) => `${amount} de ce qui vous est dû est retenu jusqu'à ce que ${store} l'examine, et n'est pas encore payable.`,
  bonusTitle: (sales, month) => `Prime${S}: ${sales} ${pluralFr(sales, "vente", "ventes")} en ${month}`,
  bonusLine: (date) => `${date} · prime`,
  termRefunds:
    "Une vente remboursée ne rapporte rien, une vente partiellement remboursée ne rapporte que sur ce qui a été conservé, et vos propres achats ne rapportent jamais rien.",
  kit: {
    head: "Des publications à partager, rédigées pour vous",
    intro: "Choisissez un produit et recevez trois courtes publications écrites à partir de sa page, avec votre lien et une ligne indiquant que vous touchez une commission, déjà intégrés. Relisez chacune avant de la publier et modifiez ce qui n'est pas vrai pour vous.",
    product: "Produit",
    note: "Avec qui vous partagez, et comment vous le connaissez (facultatif)",
    notePlaceholder: `Par exemple${S}: mes abonnés font leur pain${S}; j'utilise le guide du levain depuis un an`,
    button: "Écrire trois publications",
    working: "Rédaction…",
    left: (n) => `Encore ${n} aujourd'hui.`,
    labels: { x: "Pour X", instagram: "Pour Instagram", linkedin: "Pour LinkedIn" },
    errors: {
      day: "C'est la limite d'aujourd'hui. Revenez demain.",
      month: "Les publications de cette boutique pour ce mois sont épuisées. Écrivez à la boutique s'il vous en faut d'autres.",
      failed: "Rien n'est revenu cette fois. Réessayez dans un instant.",
      other: "Cela n'a pas pu être fait. Rechargez la page et réessayez.",
    },
  },
  termDisclose: `Partout où vous partagez votre lien, indiquez que vous touchez une commission, et ne promettez que ce que le produit fait${S}: ni revenus ni résultats qu'il ne garantit pas.`,
  termBuyers: (store) =>
    `Toute personne ayant acheté chez ${store} peut rejoindre le programme tout de suite, depuis sa commande${S}; les autres postulent et ${store} décide. ${store} vous paie directement depuis son propre compte${S}: Marktmorgen ne détient jamais cet argent, il n'y a donc aucun minimum à atteindre ni aucune date limite pour le réclamer.`,
  termApproves: (store) =>
    `${store} approuve chaque affilié et vous paie directement depuis son propre compte${S}: Marktmorgen ne détient jamais cet argent, il n'y a donc aucun minimum à atteindre ni aucune date limite pour le réclamer.`,
  productRate: (title, percent) => `${title}${S}: ${percent === 0 ? "ne fait pas partie du programme" : `${percent}${S}%`}`,
  applyClosed: "Les candidatures ne peuvent pas être envoyées d'ici pour le moment. Réessayez plus tard.",
  whenOpens: (store) => `Quand ${store} en ouvrira un, c'est ici qu'il faudra postuler.`,
  attribution: (days, isFirst, isLifetime) => {
    const window = `jusqu'à ${days}${S}${pluralFr(days, "jour", "jours")}`;
    const kept = "tant que le navigateur de l'acheteur conserve le cookie — les navigateurs fixent leur propre limite et raccourcissent une durée longue sans prévenir le site";
    const rule = isFirst
      ? `Le premier lien d'affilié que suit un acheteur remporte la vente, ${window} après ce premier clic et ${kept}, même s'il suit plus tard le lien de quelqu'un d'autre.`
      : `Le dernier lien d'affilié que suit un acheteur remporte la vente, ${window} après ce clic et ${kept}.`;
    return isLifetime
      ? `${rule} Rien de tout cela ne s'applique une fois qu'une vente a été attribuée${S}: dès lors, l'acheteur reste lié à cet affilié, et tout ce que cette personne achète ensuite lui rapporte, sans limite de durée, sur n'importe quel appareil, sans aucun cookie.`
      : rule;
  },
  contactsRule:
    "Un achat unique qui n'est attribué à aucun lien ni code d'affilié ni à un achat précédent revient à l'affilié qui a amené l'acheteur comme lead confirmé avant son achat, sur n'importe quel appareil et sans aucun cookie.",
  payoutPromise: (store, n, days) => {
    const wait =
      days > 0
        ? ` Une vente devient payable ${days}${S}${pluralFr(days, "jour", "jours")} après avoir été réalisée, afin qu'un remboursement intervenu entre-temps soit d'abord déduit.`
        : "";
    if (n < 1) return `${store} n'a pas fixé de jour de paiement et paie au moment de son choix.${wait}`;
    return `${store} paie le ${n === 1 ? "1er" : n} de chaque mois.${wait}`;
  },

  payChangedSubject: (store) => `L'adresse où ${store} vous paie a changé`,
  payChangedLine: (store, address) => `L'adresse PayPal à laquelle ${store} verse vos commissions d'affilié est désormais${S}: ${address}.`,
  payChangedIfNot: `Si ce n'est pas vous qui l'avez modifiée, ouvrez votre page d'affilié, remettez l'ancienne adresse et déconnectez-vous sur tous les navigateurs, puis prévenez la boutique en répondant à cet e-mail${S}:`,
  linkSubjectNew: (store) => `Confirmez votre candidature d'affilié auprès de ${store}`,
  linkIntroKnown: (store) => `Voici l'accès à votre page d'affilié pour ${store}${S}:`,
  linkIntroNew: (store) =>
    `Vous avez demandé à devenir affilié de ${store}. Ouvrez ce lien et appuyez sur le bouton pour envoyer votre candidature${S}:`,
  linkShowsKnown: "Elle affiche votre lien, vos clics, vos ventes, ce que vous avez gagné et ce qui vous a été versé.",
  linkAboutNew: (store, days) =>
    `${store} décide de chaque candidature. Une fois approuvé, votre page vous donne votre propre lien, et un achat unique effectué via ce lien au plus ${days}${S}${pluralFr(days, "jour", "jours")} après un clic vous rapporte une part.`,
  paidByStore: (store) => `Les commissions vous sont versées directement par ${store}, et non par Marktmorgen, qui ne détient jamais l'argent.`,
  linkExpires: `Le lien fonctionne pendant 24${S}heures. Si vous n'avez rien demandé, ignorez cet e-mail${S}; rien ne se passe tant que le lien n'est pas utilisé.`,
  approvedSubject: (store) => `Vous êtes affilié de ${store}`,
  approvedIntro: (store) => `${store} a approuvé votre candidature. Votre lien${S}:`,
  approvedTerms: (days, percent, hasRates) =>
    `Un achat unique effectué via ce lien au plus ${days}${S}${pluralFr(days, "jour", "jours")} après un clic vous rapporte ${percent}${S}% de ce que l'acheteur a payé hors taxes${hasRates ? ` (certains produits rapportent une part différente${S}; votre page les indique)` : ""}. Les abonnements et les paiements échelonnés ne rapportent rien, et une vente remboursée ne rapporte rien.`,
  approvedPage: (url) => `Vos clics, ventes et gains${S}: ${url}`,
  termIdle: (days, warn, withLeads) =>
    withLeads
      ? `Un affilié dont le lien n'apporte aucune vente ni aucun lead pendant ${days} jours est retiré du programme, après un e-mail envoyé ${warn} jours avant avec la date. Une vente ou un lead d'ici là le maintient.`
      : `Un affilié dont le lien n'apporte aucune vente pendant ${days} jours est retiré du programme, après un e-mail envoyé ${warn} jours avant avec la date. Une vente d'ici là le maintient.`,
  idleSubject: (store, date) => `Votre lien d'affilié de ${store} prend fin le ${date}`,
  idleBody: (store, days, date, withLeads) =>
    withLeads
      ? `${store} retire les affiliés dont le lien n'apporte aucune vente ni aucun lead pendant ${days} jours. Si le vôtre n'en apporte aucun avant le ${date}, vous quitterez le programme ce jour-là. Une vente ou un lead par votre lien d'ici là vous y maintient. Votre historique de clics, de ventes et de paiements reste tel quel.`
      : `${store} retire les affiliés dont le lien n'apporte aucune vente pendant ${days} jours. Si le vôtre n'en apporte aucune avant le ${date}, vous quitterez le programme ce jour-là. Une vente par votre lien d'ici là vous y maintient. Votre historique de clics, de ventes et de paiements reste tel quel.`,

  partnerSubject: (store) => `${store} vous propose de devenir partenaire`,
  partnerOffer: (store, percent) => `${store} vous propose ${percent}${S}% de chaque vente de${S}:`,
  someProduct: "un produit",
  partnerInStudio: `Elle vous attend dans votre propre studio, avec les conditions, pour l'accepter ou la refuser${S}:`,
  partnerAnswer: "Rien ne se passe tant que vous n'avez pas répondu. Si vous refusez, la boutique saura seulement que vous avez refusé.",
  partnerTerms: (percent) =>
    `Soit ${percent}${S}% de ce que chaque acheteur paie hors taxes, sur chaque vente — pas seulement celles que vous apportez. Une vente remboursée ne rapporte rien, et une vente partiellement remboursée rapporte sur ce qui a été conservé.`,
  partnerOpen: `Ouvrez ce lien pour accepter et voir votre propre page, qui affiche chaque vente qui vous a rapporté et ce qui vous a été versé${S}:`,
  partnerPays: (store) =>
    `${store} vous paie directement, depuis son propre compte. Marktmorgen ne détient jamais cet argent${S}: il n'y a donc aucun solde à attendre ni rien à réclamer avant une date limite. On vous demandera l'adresse PayPal à laquelle être payé${S}; vous n'avez besoin d'aucun compte chez nous.`,
  partnerExpires: `Le lien fonctionne pendant 24${S}heures. Si ce message ne vous était pas destiné, ignorez-le${S}; rien ne se passe tant que le lien n'est pas utilisé.`,

  listWhy: (name) => `Vous recevez ce message parce que vous avez indiqué à ${name} vouloir recevoir de ses nouvelles.`,
  footerUnsubscribe: "Se désabonner",
  footerUnsubscribeAfter: (name) => `en un clic, et ${name} ne vous écrira plus.`,
  unsubscribeText: (url) => `Se désabonner en un clic${S}: ${url}`,
  doorText: (label, url) => `${label}${S}: ${url}`,
  sentWith: "Envoyé avec Marktmorgen.",

  winbackOffer: (percent, months) =>
    months === 1 ? `${percent}${S}% de réduction sur votre premier paiement` : `${percent}${S}% de réduction sur vos ${months}${S}premiers paiements`,
  winbackSubject: (title, offer) => `Revenez à ${title}${S}: ${offer}`,
  hi: "Bonjour,",
  winbackBody: (title, endedOn, offer, until) =>
    `Votre abonnement à ${title} a pris fin le ${endedOn}. Si vous souhaitez revenir, vous bénéficiez de ${offer}, jusqu'au ${until}${S}:`,
  winbackLinkNote: "Le lien est réservé à cette adresse e-mail, et rien n'est débité avant que vous ne validiez le paiement.",

  unknownLink: "Nous ne reconnaissons pas ce lien",
  unknownListBody: "Ouvrez le lien de désabonnement depuis l'e-mail lui-même, ou utilisez le bouton de désabonnement de votre messagerie.",
  unknownOtherBody: "Ouvrez le lien depuis l'e-mail lui-même, ou utilisez le bouton de désabonnement de votre messagerie.",
  onBehalfCreator: "E-mails envoyés avec Marktmorgen, au nom du créateur qui les a écrits.",
  onBehalfStore: "E-mails envoyés avec Marktmorgen, au nom de la boutique qui les a envoyés.",
  forEmail: (email) => `Pour ${email}. Une seule pression les arrête définitivement.`,
  listDoneTitle: "Vous êtes désabonné",
  listDone: (email, who) => `${email} ne recevra plus d'e-mails de ${who || "ce créateur"}. Vous n'avez rien d'autre à faire.`,
  listAsk: (who) => `Ne plus recevoir d'e-mails de ${who || "ce créateur"}${S}?`,
  unsubscribeButton: "Me désabonner",
  communityDoneTitle: "Plus d'e-mails de la communauté",
  communityDone: (email, who, where) =>
    `${email} ne recevra plus par e-mail les annonces de ${who || "ce créateur"} ni les rappels d'événements en direct. Vous faites toujours partie de ${where || "la communauté"} et pouvez les y lire. Si un événement auquel vous avez répondu présent est déplacé ou annulé, vous en êtes tout de même informé, une fois.`,
  communityAsk: (who) => `Ne plus recevoir les e-mails de la communauté de ${who || "ce créateur"}${S}?`,
  communityFor: (email, where) =>
    `Annonces et rappels d'événements en direct, pour ${email}. Vous restez dans ${where || "la communauté"} et gardez vos réponses aux événements${S}; seuls les e-mails s'arrêtent.`,
  stopEmails: "Arrêter les e-mails",
  remindersDoneTitle: "Plus de rappels",
  remindersDone: (email, who) =>
    `${email} ne recevra plus de rappels de commande non finalisée de ${who || "cette boutique"}. Vous n'avez rien d'autre à faire.`,
  remindersAsk: (who) => `Ne plus recevoir de rappels de commande non finalisée de ${who || "cette boutique"}${S}?`,
  stopReminders: "Arrêter les rappels",
  clicksOn: (name) => `Vous avez permis à ${name} de voir quels liens de ces e-mails vous utilisez.`,
  clicksStop: "Ne plus le permettre",
  clicksStopText: (url) => `Ne plus le permettre${S}: ${url}`,
  clicksAsk: (name) => `Ne plus permettre à ${name || "ce créateur"} de voir quels liens vous utilisez${S}?`,
  clicksFor: (email) => `Pour ${email}. Vous restez sur la liste${S}; seul le comptage s'arrête, et ce qui a été compté est supprimé.`,
  clicksButton: "Ne plus compter mes liens",
  clicksDoneTitle: "Vos liens ne sont plus comptés",
  clicksDone: (email, name) => `Les liens que ${email} utilise dans les e-mails de ${name || "ce créateur"} ne sont plus comptés, et ce qui avait été compté a été supprimé. Vous restez sur la liste.`,
  reviewsDoneTitle: "Plus de demandes d'avis",
  reviewsDone: (email, who) => `${email} ne recevra plus de demandes d'avis de ${who || "cette boutique"}. Vous n'avez rien d'autre à faire.`,
  reviewsAsk: (who) => `Ne plus recevoir de demandes d'avis de ${who || "cette boutique"}${S}?`,
  reviewsFor: (email) => `Pour ${email}. Une seule pression les arrête définitivement. Un avis que vous avez déjà écrit reste tel quel.`,
  stopReviews: "Arrêter les demandes d'avis",
  reviewsNotSaved: "Nous n'avons pas pu l'enregistrer pour le moment. Veuillez réessayer.",
};

// ---- German ------------------------------------------------------------------------------------------
const de: AffiliatesWords = {
  pageTitle: "Partnerprogramm",
  notices: {
    email: { title: "Das sieht nicht nach einer E-Mail-Adresse aus", body: "Bitte prüfen Sie sie und versuchen Sie es erneut." },
    limited: {
      title: "Zu viele Anfragen für den Moment",
      body: "Damit dieses Formular nicht benutzt werden kann, um jemandes Posteingang zu überfluten, nimmt es nur eine begrenzte Zahl von Anfragen pro Stunde an. Versuchen Sie es in einer Stunde erneut.",
    },
    unavailable: { title: "Dieser Shop nimmt gerade keine Affiliates auf", body: "Es wurde nichts gesendet." },
    owner: { title: "Das ist die eigene Adresse des Shops", body: "Ein Shop kann nicht sein eigener Affiliate sein." },
    full: {
      title: "Dieses Programm ist voll",
      body: "Es hat so viele Affiliates, wie ein Shop haben kann. Schreiben Sie dem Shop, wenn Sie berücksichtigt werden möchten.",
    },
    error: { title: "Bei uns ist etwas schiefgelaufen", body: "Es wurde nichts geändert. Versuchen Sie es gleich noch einmal." },
    resting: { title: "Dieser Shop kann das gerade nicht bearbeiten", body: "Beim Annehmen werden zuerst die Partner des Shops geprüft, und der Shop kann gerade nicht so viele Anfragen bearbeiten. Es wurde nichts geändert. Versuchen Sie es später erneut oder schreiben Sie dem Shop." },
    expired: {
      title: "Dieser Link ist abgelaufen",
      body: "Ein per E-Mail gesendeter Link funktioniert einmal, innerhalb von 24 Stunden. Fordern Sie unten einen neuen an; das dauert nur ein paar Sekunden.",
    },
    order: {
      title: "Diese Bestellung konnte nicht gelesen werden",
      body: "Öffnen Sie den Link in Ihrer Kauf-E-Mail erneut, oder bewerben Sie sich unten mit der Adresse, mit der Sie gekauft haben.",
    },
    declined: {
      title: "Sie können nicht über Ihre Bestellung beitreten",
      body: "Dieser Shop hat über diese Adresse bereits entschieden. Schreiben Sie dem Shop, wenn Sie meinen, dass sich das ändern sollte.",
    },
    signedout: { title: "Sie sind in diesem Browser abgemeldet", body: "Um Ihre Affiliate-Seite wieder zu sehen, fordern Sie unten einen neuen Link an." },
  },

  whereShare: "Wo Sie es teilen würden",
  optional: "(freiwillig)",
  notePlaceholder: "Mein Newsletter, mein YouTube-Kanal…",
  emailMeLink: "Link zur Bewerbung per E-Mail senden",
  formNote:
    "Kein Passwort. Der Link bestätigt, dass die Adresse Ihnen gehört; wenn Sie ihn öffnen, wird Ihre Bewerbung gesendet. Schon Affiliate? Dasselbe Formular schickt Ihnen per E-Mail den Weg zurück zu Ihrer Seite.",
  continueAs: (email) => `Weiter als ${email}`,
  continueBody: (store) =>
    `Drücken Sie die Schaltfläche, um Ihre Affiliate-Seite für ${store} in diesem Browser zu öffnen. Wenn Sie sich noch nicht beworben haben, wird damit Ihre Bewerbung gesendet.`,
  openMyPage: "Meine Affiliate-Seite öffnen",
  checkInbox: "Sehen Sie in Ihren Posteingang",
  sentBody: (store) =>
    `Der Link ist unterwegs. Er kommt von ${store} über Marktmorgen und ist meist innerhalb einer Minute da. Wenn nicht, sehen Sie im Spam-Ordner nach.`,

  appliedTitle: "Ihre Bewerbung ist eingegangen",
  joinedTitle: "Ihr Link ist bereit",
  welcomeTitle: "Sie sind in diesem Browser angemeldet",
  appliedBody: (store) => `${store} wurde benachrichtigt. Wird Ihre Bewerbung angenommen, erhalten Sie eine E-Mail mit Ihrem Link.`,
  joinedBody:
    "Teilen Sie ihn überall. Sie bleiben 30 Tage lang in diesem Browser angemeldet, und dasselbe Formular unten schickt Ihnen per E-Mail den Weg zurück.",
  welcomeBody: "Sie bleiben 30 Tage lang in diesem Browser angemeldet.",

  badgeAffiliate: "Zugelassener Affiliate",
  badgePaused: "Programm pausiert",
  badgePending: "Wartet auf Freigabe",
  badgeDeclined: "Nicht angenommen",
  badgeRemoved: "Nicht mehr Affiliate",
  yourPageFor: (store) => `Ihre Affiliate-Seite für ${store}`,
  pendingBody: (store) => `${store} entscheidet über jede Bewerbung. Wird Ihre angenommen, erhalten Sie eine E-Mail mit Ihrem Link.`,
  pausedBody: (store) =>
    `${store} hat das Programm pausiert, daher bringen Links gerade nichts ein. Was Sie bereits verdient haben, steht unten.`,
  declinedBody: (store) => `${store} hat diese Bewerbung nicht angenommen.`,
  removedBody: (store) =>
    `${store} hat Ihre Teilnahme am Programm beendet, daher bringt Ihr Link nichts mehr ein. Was Sie vorher verdient haben, steht unten.`,

  yourLink: "Ihr Link",
  copy: "Kopieren",
  copied: "Kopiert",
  orAddVia: (code) => `Oder hängen Sie ?via=${code} an die Adresse einer beliebigen Seite dieses Shops an.`,
  recruitLabel: "Ihr Einladungslink",
  recruitNote: (percent, store) =>
    `Wer sich über diesen Link bewirbt und von ${store} angenommen wird, gehört zu Ihnen: Sie verdienen ${percent}${S}% an jedem Verkauf, den diese Person bringt, zusätzlich zu dem, was sie selbst verdient, und das wird nicht gekürzt. Der Anteil steht fest, sobald sie beitritt, und gilt nicht für die Personen, die sie ihrerseits bringt.`,
  codesLabel: (count) => (count === 1 ? "Ihr Code" : "Ihre Codes"),
  codeNoteOne:
    "Sagen Sie ihn laut, drucken Sie ihn, schreiben Sie ihn in eine Bildunterschrift. Wer ihn beim Bezahlen eingibt, bringt Ihnen Ihren Anteil ein, auch ohne je auf Ihren Link geklickt zu haben — nur so erreicht Sie überhaupt ein Verkauf aus einem Podcast, von einer Bühne oder aus einem Video ohne Links.",
  codeNoteMany:
    "Sagen Sie sie laut, drucken Sie sie, schreiben Sie sie in eine Bildunterschrift. Wer einen davon beim Bezahlen eingibt, bringt Ihnen Ihren Anteil ein, auch ohne je auf Ihren Link geklickt zu haben.",
  percentOff: (percent) => `${percent}${S}% Rabatt`,
  amountOff: (amount) => `${amount} Rabatt`,
  partnerShareLabel: "Ihre Partnerbeteiligung",
  partnerShare: (percent, products) =>
    `${percent}${S}% dessen, was ein Käufer vor Steuern zahlt, bei jedem Verkauf von ${products} — egal, wer den Käufer gebracht hat und ob er über Ihren Link kam oder nicht. Ein erstatteter Verkauf bringt nichts ein, ein teilweise erstatteter bringt auf das ein, was behalten wurde, und Ihre eigenen Käufe bringen nie etwas ein.`,
  sharedFallback: "die Produkte, an denen Sie beteiligt sind",
  yourRate: (store, percent) =>
    `${store} hat Ihren Anteil auf ${percent}${S}% dessen festgelegt, was ein Käufer vor Steuern zahlt, bei jedem Einmalkauf über Ihren Link, außer bei Produkten, die aus dem Programm genommen wurden.`,

  clicks: "Klicks",
  sales: "Verkäufe",
  earned: "Verdient",
  paidAhead: "Im Voraus bezahlt",
  owedToYou: "Ihnen geschuldet",
  paidSoFar: (amount, store) =>
    `Bisher an Sie gezahlt: ${amount}. ${store} bezahlt Sie direkt vom eigenen Konto. Marktmorgen hält dieses Geld nie, daher gibt es hier kein Guthaben, auf das Sie warten müssten, und nichts, was Sie vor einer Frist einfordern müssten.`,
  nextPayment: (date) => `Nächste Zahlung: ${date}.`,
  waitingNote: (amount) => `${amount} von dem, was Ihnen zusteht, liegt noch in dieser Wartezeit und ist noch nicht auszahlbar.`,
  refundsUnchecked:
    "Nicht alle Erstattungen konnten gerade geprüft werden, daher kann ein kürzlich erstatteter Verkauf noch so erscheinen, als bringe er etwas ein. Das wird bei der nächsten Aktualisierung dieser Zahlen korrigiert.",
  figuresAsOf: (when: string) => `Zahlen vom ${when}, koordinierte Weltzeit (UTC).`,
  figuresDaily: "Sie werden höchstens einmal am Tag aktualisiert.",
  figuresShort: "Sie können nach 15 Minuten erneut aktualisiert werden.",
  figuresSoon: "Ihre Zahlen sind noch nicht fertig.",
  figuresNoRoom: "Ihre Zahlen können gerade nicht aktualisiert werden, weil ein Limit für Seitenaufrufe erreicht wurde. Sie erscheinen wieder, sobald wieder Spielraum besteht.",
  salesHead: "Verkäufe über Ihren Link",
  noneYet: "Noch keine.",
  aProduct: "Ein Produkt",
  tierLine: (date, amount, percent, status) =>
    `${date} · ein Verkauf von jemandem, den Sie geworben haben · ${amount} vor Steuern · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  saleLine: (date, amount, percent, status) => `${date} · ${amount} vor Steuern · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  lineStatus: { "own purchase": "eigener Kauf", refunded: "erstattet", "partly refunded": "teilweise erstattet" },
  paidByHead: (store) => `Von ${store} an Sie gezahlt`,

  payPalLabel: "Wohin PayPal Sie bezahlt",
  payPalNote: (store, email) =>
    `Wenn ${store} Sie über PayPal bezahlt, geht die Zahlung an diese Adresse. Lassen Sie das Feld leer, um an ${email} bezahlt zu werden. Wir schreiben ${email} jedes Mal, wenn sie sich ändert.`,
  saved: "Gespeichert.",
  payPalNotEmail: "Das sieht nicht nach einer E-Mail-Adresse aus. Es wurde nichts geändert.",
  payPalSlow: "Zu viele Änderungen für den Moment. Versuchen Sie es in einer Stunde erneut.",
  savePayPal: "Meine PayPal-Adresse speichern",
  signOut: "In diesem Browser abmelden",
  allPrograms: "Alle Ihre Partnerprogramme auf Marktmorgen an einem Ort",

  earnPercent: (percent, store) => `Verdienen Sie ${percent}${S}% durch Empfehlen von ${store}`,
  buyerJoinBody: (store, days, percent) =>
    `Sie haben bei ${store} gekauft, deshalb können Sie jetzt Ihren eigenen Link bekommen, ohne sich zu bewerben. Ein Einmalkauf, der innerhalb von ${days} ${plural(days, "Tag", "Tagen")} nach einem Klick darüber getätigt wird, bringt Ihnen ${percent}${S}% dessen ein, was der Käufer vor Steuern gezahlt hat.`,
  getMyLink: "Meinen Link holen",
  buyerJoinNote: (promise, store) =>
    `${promise} ${store} bezahlt Sie direkt; Marktmorgen hält dieses Geld nie. Sie treten mit der Adresse bei, mit der Sie gekauft haben.`,

  earnBy: (store) => `Verdienen Sie durch Empfehlen von ${store}`,
  noProgram: (store) => `${store} hat derzeit kein Partnerprogramm`,
  termShare: (percent, hasDifferent) =>
    `${percent}${S}% dessen, was ein Käufer vor Steuern zahlt, bei Einmalkäufen über Ihren Link (Mitgliedschaften und Ratenzahlungen bringen nichts ein)${hasDifferent ? "; einige Produkte weichen ab, siehe unten" : ""}.`,
  termShareAll: (percent, hasDifferent) =>
    `${percent}${S}% dessen, was ein Käufer vor Steuern zahlt, bei Käufen über Ihren Link${hasDifferent ? "; einige Produkte weichen ab, siehe unten" : ""}.`,
  termRecurring: (months) =>
    months === 1
      ? "Eine Mitgliedschaft bringt bei ihrer ersten Zahlung Provision ein, eine Ratenzahlung bei jeder ihrer Raten."
      : months >= 1200
        ? "Eine Mitgliedschaft bringt bei jeder ihrer Zahlungen Provision ein, solange das Mitglied weiter zahlt, eine Ratenzahlung bei jeder ihrer Raten."
        : `Eine Mitgliedschaft bringt bei jeder ihrer Zahlungen in den ersten ${months} Monaten Provision ein, eine Ratenzahlung bei jeder ihrer Raten.`,
  termBonus: (sales, amount) =>
    `Ein Bonus von ${amount} für jeden Kalendermonat, in dem ${sales} ${plural(sales, "Verkauf", "Verkäufe")} über Ihren Link Provision ${plural(sales, "einbringt", "einbringen")}.`,
  termNoPaidSearch: (store) =>
    `Bezahlte Suchanzeigen auf den Namen ${store} sind nicht erlaubt: Was Ihnen zusteht, wird zurückgehalten, bis ${store} sich einen Klick ansieht, der von einer solchen Anzeige kam.`,
  heldNote: (amount, store) => `${amount} von dem, was Ihnen zusteht, wird zurückgehalten, bis ${store} es sich ansieht, und ist noch nicht auszahlbar.`,
  bonusTitle: (sales, month) => `Bonus: ${sales} ${plural(sales, "Verkauf", "Verkäufe")} im ${month}`,
  bonusLine: (date) => `${date} · Bonus`,
  termRefunds:
    "Ein erstatteter Verkauf bringt nichts ein, ein teilweise erstatteter nur auf das, was behalten wurde, und Ihre eigenen Käufe bringen nie etwas ein.",
  kit: {
    head: "Beiträge zum Teilen, für Sie entworfen",
    intro: "Wählen Sie ein Produkt und erhalten Sie drei kurze Beiträge, geschrieben aus seiner Seite, mit Ihrem Link und einer Zeile, dass Sie daran verdienen, schon darin. Lesen Sie jeden vor dem Posten und ändern Sie, was für Sie nicht stimmt.",
    product: "Produkt",
    note: "Mit wem Sie teilen und woher Sie es kennen (optional)",
    notePlaceholder: "Zum Beispiel: Meine Follower backen zu Hause; ich nutze den Sauerteig-Leitfaden seit einem Jahr",
    button: "Drei Beiträge schreiben",
    working: "Wird geschrieben…",
    left: (n) => `Heute noch ${n}.`,
    labels: { x: "Für X", instagram: "Für Instagram", linkedin: "Für LinkedIn" },
    errors: {
      day: "Das Tageslimit ist erreicht. Kommen Sie morgen wieder.",
      month: "Die Beiträge dieses Shops für diesen Monat sind aufgebraucht. Schreiben Sie dem Shop, wenn Sie mehr brauchen.",
      failed: "Diesmal kam nichts zurück. Versuchen Sie es gleich noch einmal.",
      other: "Das ging nicht. Laden Sie die Seite neu und versuchen Sie es erneut.",
    },
  },
  termDisclose: "Sagen Sie überall, wo Sie Ihren Link teilen, dass Sie daran verdienen, und versprechen Sie nur, was das Produkt leistet: keine Einnahmen oder Ergebnisse, die es nicht garantiert.",
  termBuyers: (store) =>
    `Wer bei ${store} gekauft hat, kann sofort beitreten, direkt aus der Bestellung; alle anderen bewerben sich, und ${store} entscheidet. ${store} bezahlt Sie direkt vom eigenen Konto: Marktmorgen hält dieses Geld nie, daher gibt es keinen Mindestbetrag und keine Frist, bis zu der Sie es einfordern müssten.`,
  termApproves: (store) =>
    `${store} nimmt jeden Affiliate selbst an und bezahlt Sie direkt vom eigenen Konto: Marktmorgen hält dieses Geld nie, daher gibt es keinen Mindestbetrag und keine Frist, bis zu der Sie es einfordern müssten.`,
  productRate: (title, percent) => `${title}: ${percent === 0 ? "nicht Teil des Programms" : `${percent}${S}%`}`,
  applyClosed: "Bewerbungen können gerade nicht von hier gesendet werden. Versuchen Sie es später erneut.",
  whenOpens: (store) => `Wenn ${store} eines eröffnet, bewerben Sie sich hier.`,
  attribution: (days, isFirst, isLifetime) => {
    const window = `bis zu ${days} ${plural(days, "Tag", "Tage")}`;
    const kept = "solange der Browser des Käufers das Cookie behält — Browser setzen dafür ihre eigene Grenze und kürzen eine lange Dauer, ohne der Website Bescheid zu geben";
    const rule = isFirst
      ? `Der erste Affiliate-Link, dem ein Käufer folgt, erhält den Verkauf, ${window} nach diesem ersten Klick und ${kept}, auch wenn er später dem Link einer anderen Person folgt.`
      : `Der letzte Affiliate-Link, dem ein Käufer folgt, erhält den Verkauf, ${window} nach diesem Klick und ${kept}.`;
    return isLifetime
      ? `${rule} Nichts davon gilt mehr, sobald ein Verkauf gutgeschrieben wurde: Ab dann bleibt der Käufer diesem Affiliate zugeordnet, und alles, was die Person danach kauft, bringt ihm etwas ein, ohne Zeitlimit, auf jedem Gerät und ganz ohne Cookie.`
      : rule;
  },
  contactsRule:
    "Ein einmaliger Kauf, der keinem Affiliate-Link, keinem Affiliate-Code und keinem früheren Kauf zugeordnet ist, geht an den Affiliate, der den Käufer vor dem Kauf als bestätigten Lead gebracht hat, auf jedem Gerät und ganz ohne Cookie.",
  payoutPromise: (store, n, days) => {
    const wait =
      days > 0
        ? ` Ein Verkauf ist ${days} ${plural(days, "Tag", "Tage")} nach dem Kauf auszahlbar, damit eine Erstattung in dieser Zeit zuerst abgezogen wird.`
        : "";
    if (n < 1) return `${store} hat keinen Zahltag festgelegt und zahlt nach eigenem Ermessen.${wait}`;
    return `${store} zahlt am ${n}. jedes Monats.${wait}`;
  },

  payChangedSubject: (store) => `Die Adresse, an die ${store} Sie bezahlt, hat sich geändert`,
  payChangedLine: (store, address) => `Die PayPal-Adresse, an die ${store} Ihre Affiliate-Provisionen zahlt, lautet jetzt: ${address}.`,
  payChangedIfNot:
    "Wenn Sie sie nicht geändert haben, öffnen Sie Ihre Affiliate-Seite, ändern Sie sie zurück und melden Sie sich in jedem Browser ab; sagen Sie dann dem Shop Bescheid, indem Sie auf diese E-Mail antworten:",
  linkSubjectNew: (store) => `Bestätigen Sie Ihre Affiliate-Bewerbung bei ${store}`,
  linkIntroKnown: (store) => `Hier ist der Zugang zu Ihrer Affiliate-Seite für ${store}:`,
  linkIntroNew: (store) =>
    `Sie möchten Affiliate von ${store} werden. Öffnen Sie diesen Link und drücken Sie die Schaltfläche, um Ihre Bewerbung zu senden:`,
  linkShowsKnown: "Sie zeigt Ihren Link, Ihre Klicks, Ihre Verkäufe und was Sie verdient haben und ausgezahlt bekommen haben.",
  linkAboutNew: (store, days) =>
    `${store} entscheidet über jede Bewerbung. Sobald Sie angenommen sind, erhalten Sie auf Ihrer Seite Ihren eigenen Link, und ein Einmalkauf, der innerhalb von ${days} ${plural(days, "Tag", "Tagen")} nach einem Klick darüber getätigt wird, bringt Ihnen einen Anteil ein.`,
  paidByStore: (store) => `Die Provisionen zahlt Ihnen ${store} direkt, nicht Marktmorgen, das das Geld nie hält.`,
  linkExpires:
    "Der Link funktioniert 24 Stunden lang. Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail; es passiert nichts, solange der Link nicht benutzt wird.",
  approvedSubject: (store) => `Sie sind Affiliate von ${store}`,
  approvedIntro: (store) => `${store} hat Ihre Bewerbung angenommen. Ihr Link:`,
  approvedTerms: (days, percent, hasRates) =>
    `Ein Einmalkauf, der innerhalb von ${days} ${plural(days, "Tag", "Tagen")} nach einem Klick darüber getätigt wird, bringt Ihnen ${percent}${S}% dessen ein, was der Käufer vor Steuern gezahlt hat${hasRates ? " (einige Produkte bringen einen anderen Anteil; Ihre Seite listet sie auf)" : ""}. Mitgliedschaften und Ratenzahlungen bringen nichts ein, und ein erstatteter Verkauf bringt nichts ein.`,
  approvedPage: (url) => `Ihre Klicks, Verkäufe und Einnahmen: ${url}`,
  termIdle: (days, warn, withLeads) =>
    withLeads
      ? `Ein Affiliate, dessen Link ${days} Tage lang keinen Verkauf und keinen Lead bringt, wird aus dem Programm entfernt, nach einer E-Mail ${warn} Tage vorher mit dem Datum. Ein Verkauf oder ein Lead bis dahin hält ihn im Programm.`
      : `Ein Affiliate, dessen Link ${days} Tage lang keinen Verkauf bringt, wird aus dem Programm entfernt, nach einer E-Mail ${warn} Tage vorher mit dem Datum. Ein Verkauf bis dahin hält ihn im Programm.`,
  idleSubject: (store, date) => `Ihr Affiliate-Link für ${store} endet am ${date}`,
  idleBody: (store, days, date, withLeads) =>
    withLeads
      ? `${store} entfernt Affiliates, deren Link ${days} Tage lang keinen Verkauf und keinen Lead bringt. Wenn Ihrer bis zum ${date} weder einen Verkauf noch einen Lead bringt, werden Sie an diesem Tag aus dem Programm entfernt. Ein Verkauf oder ein Lead über Ihren Link vor diesem Datum hält Sie im Programm. Ihre Klicks, Verkäufe und Zahlungen bleiben unverändert gespeichert.`
      : `${store} entfernt Affiliates, deren Link ${days} Tage lang keinen Verkauf bringt. Wenn Ihrer bis zum ${date} keinen Verkauf bringt, werden Sie an diesem Tag aus dem Programm entfernt. Ein Verkauf über Ihren Link vor diesem Datum hält Sie im Programm. Ihre Klicks, Verkäufe und Zahlungen bleiben unverändert gespeichert.`,

  partnerSubject: (store) => `${store} möchte Sie als Partner`,
  partnerOffer: (store, percent) => `${store} bietet Ihnen ${percent}${S}% jedes Verkaufs von:`,
  someProduct: "ein Produkt",
  partnerInStudio: "Das Angebot wartet in Ihrem eigenen Studio, mit den Bedingungen, darauf, dass Sie es annehmen oder ablehnen:",
  partnerAnswer: "Es passiert nichts, bis Sie antworten. Wenn Sie ablehnen, erfährt der Shop nur, dass Sie abgelehnt haben.",
  partnerTerms: (percent) =>
    `Das sind ${percent}${S}% dessen, was jeder Käufer vor Steuern zahlt, bei jedem Verkauf — nicht nur bei denen, die Sie vermitteln. Ein erstatteter Verkauf bringt nichts ein, und ein teilweise erstatteter bringt auf das ein, was behalten wurde.`,
  partnerOpen:
    "Öffnen Sie diesen Link, um anzunehmen und Ihre eigene Seite zu sehen, die jeden Verkauf zeigt, an dem Sie verdient haben, und was Ihnen ausgezahlt wurde:",
  partnerPays: (store) =>
    `${store} bezahlt Sie direkt vom eigenen Konto. Marktmorgen hält dieses Geld nie, daher gibt es kein Guthaben, auf das Sie warten müssten, und nichts, was Sie bis zu einer Frist einfordern müssten. Sie werden nach der PayPal-Adresse gefragt, an die gezahlt werden soll; ein Konto bei uns brauchen Sie nicht.`,
  partnerExpires:
    "Der Link funktioniert 24 Stunden lang. Wenn das nicht für Sie bestimmt war, ignorieren Sie es; es passiert nichts, solange der Link nicht benutzt wird.",

  listWhy: (name) => `Sie erhalten diese E-Mail, weil Sie ${name} mitgeteilt haben, dass Sie Nachrichten erhalten möchten.`,
  footerUnsubscribe: "Abmelden",
  footerUnsubscribeAfter: (name) => `mit einem Klick, und ${name} schreibt Ihnen nicht mehr.`,
  unsubscribeText: (url) => `Mit einem Klick abmelden: ${url}`,
  doorText: (label, url) => `${label}: ${url}`,
  sentWith: "Gesendet mit Marktmorgen.",

  winbackOffer: (percent, months) =>
    months === 1 ? `${percent}${S}% Rabatt auf Ihre erste Zahlung` : `${percent}${S}% Rabatt auf Ihre ersten ${months} Zahlungen`,
  winbackSubject: (title, offer) => `Kommen Sie zurück zu ${title}: ${offer}`,
  hi: "Hallo,",
  winbackBody: (title, endedOn, offer, until) =>
    `Ihre Mitgliedschaft für ${title} ist am ${endedOn} ausgelaufen. Wenn Sie zurückkommen möchten, erhalten Sie ${offer}, bis zum ${until}:`,
  winbackLinkNote: "Der Link gilt nur für diese E-Mail-Adresse, und es wird nichts berechnet, bis Sie den Kauf abschließen.",

  unknownLink: "Diesen Link kennen wir nicht",
  unknownListBody: "Öffnen Sie den Abmeldelink direkt aus der E-Mail, oder nutzen Sie die Abmeldeschaltfläche Ihres E-Mail-Programms.",
  unknownOtherBody: "Öffnen Sie den Link direkt aus der E-Mail, oder nutzen Sie die Abmeldeschaltfläche Ihres E-Mail-Programms.",
  onBehalfCreator: "E-Mails, die mit Marktmorgen im Auftrag des Creators gesendet werden, der sie geschrieben hat.",
  onBehalfStore: "E-Mails, die mit Marktmorgen im Auftrag des Shops gesendet werden, der sie verschickt hat.",
  forEmail: (email) => `Für ${email}. Ein Klick beendet sie endgültig.`,
  listDoneTitle: "Sie sind abgemeldet",
  listDone: (email, who) => `${email} erhält keine E-Mails mehr von ${who || "diesem Creator"}. Sonst ist nichts nötig.`,
  listAsk: (who) => `Keine E-Mails mehr von ${who || "diesem Creator"}?`,
  unsubscribeButton: "Abmelden",
  communityDoneTitle: "Keine E-Mails mehr aus der Community",
  communityDone: (email, who, where) =>
    `An ${email} werden keine Ankündigungen oder Erinnerungen an Live-Events von ${who || "diesem Creator"} mehr gesendet. Sie bleiben in ${where || "der Community"} und können sie dort lesen. Wird ein Event, für das Sie zugesagt haben, verschoben oder abgesagt, werden Sie trotzdem informiert, einmal.`,
  communityAsk: (who) => `Keine Community-E-Mails mehr von ${who || "diesem Creator"}?`,
  communityFor: (email, where) =>
    `Ankündigungen und Erinnerungen an Live-Events, für ${email}. Sie bleiben in ${where || "der Community"} und behalten Ihre Zusagen; nur die E-Mails hören auf.`,
  stopEmails: "E-Mails stoppen",
  remindersDoneTitle: "Keine Erinnerungen mehr",
  remindersDone: (email, who) =>
    `${email} erhält keine Erinnerungen an nicht abgeschlossene Käufe mehr von ${who || "diesem Shop"}. Sonst ist nichts nötig.`,
  remindersAsk: (who) => `Keine Erinnerungen an nicht abgeschlossene Käufe mehr von ${who || "diesem Shop"}?`,
  stopReminders: "Erinnerungen stoppen",
  clicksOn: (name) => `Sie haben ${name} erlaubt zu sehen, welche Links in diesen E-Mails Sie nutzen.`,
  clicksStop: "Nicht mehr erlauben",
  clicksStopText: (url) => `Nicht mehr erlauben: ${url}`,
  clicksAsk: (name) => `${name || "Diesen Creator"} nicht mehr sehen lassen, welche Links Sie nutzen?`,
  clicksFor: (email) => `Für ${email}. Sie bleiben auf der Liste; nur das Zählen endet, und das Gezählte wird gelöscht.`,
  clicksButton: "Meine Links nicht mehr zählen",
  clicksDoneTitle: "Ihre Links werden nicht mehr gezählt",
  clicksDone: (email, name) => `Welche Links ${email} in E-Mails von ${name || "diesem Creator"} nutzt, wird nicht mehr gezählt, und das bisher Gezählte wurde gelöscht. Sie bleiben auf der Liste.`,
  reviewsDoneTitle: "Keine Bewertungsanfragen mehr",
  reviewsDone: (email, who) => `${email} wird von ${who || "diesem Shop"} nicht mehr um eine Bewertung gebeten. Sonst ist nichts nötig.`,
  reviewsAsk: (who) => `Keine Bewertungsanfragen mehr von ${who || "diesem Shop"}?`,
  reviewsFor: (email) =>
    `Für ${email}. Ein Klick beendet sie endgültig. Eine Bewertung, die Sie bereits geschrieben haben, bleibt, wie sie ist.`,
  stopReviews: "Bewertungsanfragen stoppen",
  reviewsNotSaved: "Das konnten wir gerade nicht speichern. Bitte versuchen Sie es erneut.",
};

// ---- Italian -----------------------------------------------------------------------------------------
const it: AffiliatesWords = {
  pageTitle: "Affiliati",
  notices: {
    email: { title: "Non sembra un indirizzo email", body: "Controllalo e riprova." },
    limited: {
      title: "Troppe richieste per ora",
      body: "Per evitare che questo modulo venga usato per inondare la casella di posta di qualcuno, accetta un numero limitato di richieste all'ora. Riprova tra un'ora.",
    },
    unavailable: { title: "Questo negozio non accetta affiliati in questo momento", body: "Non è stato inviato nulla." },
    owner: { title: "Questo è l'indirizzo del negozio stesso", body: "Un negozio non può essere affiliato di sé stesso." },
    full: {
      title: "Questo programma è al completo",
      body: "Ha tutti gli affiliati che un negozio può avere. Scrivi al negozio se vuoi essere preso in considerazione.",
    },
    error: { title: "Qualcosa è andato storto da parte nostra", body: "Non è stato cambiato nulla. Riprova tra un momento." },
    resting: { title: "Questo negozio non può gestirlo in questo momento", body: "Per accettare si controllano prima i partner del negozio, e il negozio non può gestire così tante richieste in questo momento. Non è stato cambiato nulla. Riprova più tardi o scrivi al negozio." },
    expired: {
      title: "Questo link è scaduto",
      body: "Un link inviato per email funziona una sola volta, entro 24 ore. Chiedine uno nuovo qui sotto; ci vogliono pochi secondi.",
    },
    order: {
      title: "Non è stato possibile leggere quell'ordine",
      body: "Apri di nuovo il link nell'email di acquisto, oppure candidati qui sotto con l'indirizzo con cui hai acquistato.",
    },
    declined: {
      title: "Non puoi unirti dal tuo ordine",
      body: "Questo negozio ha già deciso su questo indirizzo. Scrivi al negozio se pensi che debba cambiare.",
    },
    signedout: { title: "Sei disconnesso su questo browser", body: "Per rivedere la tua pagina di affiliato, chiedi un nuovo link qui sotto." },
  },

  whereShare: "Dove lo condivideresti",
  optional: "(facoltativo)",
  notePlaceholder: "La mia newsletter, il mio canale YouTube…",
  emailMeLink: "Inviami un link per candidarmi",
  formNote:
    "Nessuna password. Il link conferma che l'indirizzo è tuo; aprirlo invia la tua candidatura. Sei già affiliato? Lo stesso modulo ti invia per email il modo per tornare alla tua pagina.",
  continueAs: (email) => `Continua come ${email}`,
  continueBody: (store) =>
    `Premi il pulsante per aprire la tua pagina di affiliato di ${store} su questo browser. Se non ti sei ancora candidato, questo invia la tua candidatura.`,
  openMyPage: "Apri la mia pagina di affiliato",
  checkInbox: "Controlla la tua casella di posta",
  sentBody: (store) =>
    `Il link è in arrivo. Viene da ${store} tramite Marktmorgen e di solito arriva entro un minuto. Se non c'è, guarda nello spam.`,

  appliedTitle: "La tua candidatura è stata inviata",
  joinedTitle: "Il tuo link è pronto",
  welcomeTitle: "Hai effettuato l'accesso su questo browser",
  appliedBody: (store) => `Abbiamo avvisato ${store}. Se approva la candidatura, ricevi un'email con il tuo link.`,
  joinedBody: "Condividilo ovunque. Resti connesso su questo browser per 30 giorni, e lo stesso modulo qui sotto ti invia per email il modo per tornare.",
  welcomeBody: "Resti connesso su questo browser per 30 giorni.",

  badgeAffiliate: "Affiliato",
  badgePaused: "Programma in pausa",
  badgePending: "In attesa di approvazione",
  badgeDeclined: "Non approvato",
  badgeRemoved: "Non sei più affiliato",
  yourPageFor: (store) => `La tua pagina di affiliato per ${store}`,
  pendingBody: (store) => `${store} decide su ogni candidatura. Se approva la tua, ricevi un'email con il tuo link.`,
  pausedBody: (store) => `${store} ha messo in pausa il programma, quindi per ora i link non fanno guadagnare. Quanto hai già guadagnato è qui sotto.`,
  declinedBody: (store) => `${store} non ha approvato questa candidatura.`,
  removedBody: (store) =>
    `${store} ha chiuso il tuo posto nel programma, quindi il tuo link non fa più guadagnare. Quanto hai guadagnato prima è qui sotto.`,

  yourLink: "Il tuo link",
  copy: "Copia",
  copied: "Copiato",
  orAddVia: (code) => `Oppure aggiungi ?via=${code} all'indirizzo di qualsiasi pagina di questo negozio.`,
  recruitLabel: "Il tuo link di invito",
  recruitNote: (percent, store) =>
    `Chi si candida con questo link e viene approvato da ${store} è tuo: guadagni il ${percent}${S}% di ogni vendita che porta, in più di quanto guadagna, che non viene ridotto. La quota è fissata quando entra e non vale per le persone che porta a sua volta.`,
  codesLabel: (count) => (count === 1 ? "Il tuo codice" : "I tuoi codici"),
  codeNoteOne:
    "Dillo ad alta voce, stampalo, mettilo in una didascalia. Un acquirente che lo digita al pagamento ti fa guadagnare la tua quota anche se non ha mai cliccato sul tuo link — ed è l'unico modo in cui una vendita da un podcast, da un palco o da un video senza link può arrivare fino a te.",
  codeNoteMany:
    "Dilli ad alta voce, stampali, mettili in una didascalia. Un acquirente che ne digita uno al pagamento ti fa guadagnare la tua quota anche se non ha mai cliccato sul tuo link.",
  percentOff: (percent) => `${percent}${S}% di sconto`,
  amountOff: (amount) => `${amount} di sconto`,
  partnerShareLabel: "La tua quota da partner",
  partnerShare: (percent, products) =>
    `${percent}${S}% di quanto un acquirente paga al netto delle tasse su ogni vendita di ${products} — chiunque abbia portato l'acquirente, e che sia arrivato o no tramite il tuo link. Una vendita rimborsata non fa guadagnare nulla, una rimborsata in parte fa guadagnare su quanto è stato trattenuto, e i tuoi acquisti non fanno mai guadagnare.`,
  sharedFallback: "i prodotti a cui partecipi",
  yourRate: (store, percent) =>
    `${store} ha fissato la tua quota al ${percent}${S}% di quanto un acquirente paga al netto delle tasse, su ogni acquisto singolo fatto tramite il tuo link, tranne i prodotti che ha escluso dal programma.`,

  clicks: "Clic",
  sales: "Vendite",
  earned: "Guadagnato",
  paidAhead: "Pagato in anticipo",
  owedToYou: "Ti spetta",
  paidSoFar: (amount, store) =>
    `Pagato finora: ${amount}. ${store} ti paga direttamente, dal proprio conto. Marktmorgen non detiene mai questo denaro, quindi qui non c'è nessun saldo da aspettare e niente da richiedere entro una scadenza.`,
  nextPayment: (date) => `Prossimo pagamento: ${date}.`,
  waitingNote: (amount) => `${amount} di quanto ti spetta è ancora in questo periodo di attesa, e non è ancora pagabile.`,
  refundsUnchecked:
    "Non è stato possibile controllare subito tutti i rimborsi, quindi una vendita rimborsata di recente potrebbe ancora risultare come guadagno. Viene corretto al prossimo aggiornamento di questi dati.",
  figuresAsOf: (when: string) => `Dati del ${when}, tempo coordinato universale (UTC).`,
  figuresDaily: "Si aggiornano al massimo una volta al giorno.",
  figuresShort: "Possono aggiornarsi di nuovo dopo 15 minuti.",
  figuresSoon: "I tuoi dati non sono ancora pronti.",
  figuresNoRoom: "I tuoi dati non possono essere aggiornati ora perché è stato raggiunto un limite di pagine visualizzate. Torneranno visibili quando ci sarà di nuovo margine.",
  salesHead: "Vendite tramite il tuo link",
  noneYet: "Ancora nessuna.",
  aProduct: "Un prodotto",
  tierLine: (date, amount, percent, status) =>
    `${date} · una vendita di una persona che hai portato · ${amount} al netto delle tasse · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  saleLine: (date, amount, percent, status) =>
    `${date} · ${amount} al netto delle tasse · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  lineStatus: { "own purchase": "acquisto tuo", refunded: "rimborsata", "partly refunded": "rimborsata in parte" },
  paidByHead: (store) => `Pagato a te da ${store}`,

  payPalLabel: "Dove ti paga PayPal",
  payPalNote: (store, email) =>
    `Quando ${store} ti paga tramite PayPal, il pagamento va a questo indirizzo. Lascialo vuoto per essere pagato su ${email}. Scriviamo a ${email} ogni volta che cambia.`,
  saved: "Salvato.",
  payPalNotEmail: "Non sembra un indirizzo email. Non è stato cambiato nulla.",
  payPalSlow: "Troppe modifiche per ora. Riprova tra un'ora.",
  savePayPal: "Salva il mio indirizzo PayPal",
  signOut: "Esci da questo browser",
  allPrograms: "Tutti i tuoi programmi di affiliazione su Marktmorgen, in un unico posto",

  earnPercent: (percent, store) => `Guadagna il ${percent}${S}% condividendo ${store}`,
  buyerJoinBody: (store, days, percent) =>
    `Hai acquistato da ${store}, quindi puoi avere subito il tuo link, senza candidarti. Un acquisto singolo fatto tramite il link entro ${days} ${plural(days, "giorno", "giorni")} da un clic ti fa guadagnare il ${percent}${S}% di quanto l'acquirente ha pagato al netto delle tasse.`,
  getMyLink: "Ottieni il mio link",
  buyerJoinNote: (promise, store) =>
    `${promise} ${store} ti paga direttamente; Marktmorgen non detiene mai questo denaro. Ti unisci con l'indirizzo con cui hai acquistato.`,

  earnBy: (store) => `Guadagna condividendo ${store}`,
  noProgram: (store) => `${store} non ha un programma di affiliazione al momento`,
  termShare: (percent, hasDifferent) =>
    `${percent}${S}% di quanto un acquirente paga al netto delle tasse, sugli acquisti singoli fatti tramite il tuo link (abbonamenti e pagamenti rateali non fanno guadagnare)${hasDifferent ? "; alcuni prodotti fanno eccezione, qui sotto" : ""}.`,
  termShareAll: (percent, hasDifferent) =>
    `${percent}${S}% di quanto un acquirente paga al netto delle tasse, sugli acquisti fatti tramite il tuo link${hasDifferent ? "; alcuni prodotti fanno eccezione, qui sotto" : ""}.`,
  termRecurring: (months) =>
    months === 1
      ? "Un abbonamento fa guadagnare sul suo primo pagamento, e un pagamento rateale su ciascuna delle sue rate."
      : months >= 1200
        ? "Un abbonamento fa guadagnare su ciascuno dei suoi pagamenti finché il membro continua a pagare, e un pagamento rateale su ciascuna delle sue rate."
        : `Un abbonamento fa guadagnare su ciascuno dei suoi pagamenti nei primi ${months} mesi, e un pagamento rateale su ciascuna delle sue rate.`,
  termBonus: (sales, amount) =>
    `Un premio di ${amount} per ogni mese di calendario in cui ${sales} ${plural(sales, "vendita", "vendite")} tramite il tuo link ${plural(sales, "fa", "fanno")} guadagnare.`,
  termNoPaidSearch: (store) =>
    `Non sono ammessi annunci a pagamento nei motori di ricerca sul nome di ${store}: quanto ti spetta resta trattenuto finché ${store} non esamina un clic arrivato da uno di essi.`,
  heldNote: (amount, store) => `${amount} di quanto ti spetta è trattenuto finché ${store} non lo esamina, e non è ancora pagabile.`,
  bonusTitle: (sales, month) => `Premio: ${sales} ${plural(sales, "vendita", "vendite")} a ${month}`,
  bonusLine: (date) => `${date} · premio`,
  termRefunds:
    "Una vendita rimborsata non fa guadagnare nulla, una rimborsata in parte fa guadagnare solo su quanto è stato trattenuto, e i tuoi acquisti non fanno mai guadagnare.",
  kit: {
    head: "Post da condividere, scritti per te",
    intro: "Scegli un prodotto e ricevi tre brevi post scritti a partire dalla sua pagina, con il tuo link e una riga che dice che guadagni una commissione già inclusi. Leggi ognuno prima di pubblicarlo e cambia ciò che per te non è vero.",
    product: "Prodotto",
    note: "Con chi condividi e come lo conosci (facoltativo)",
    notePlaceholder: "Per esempio: chi mi segue fa il pane in casa; uso la guida al lievito madre da un anno",
    button: "Scrivi tre post",
    working: "Scrittura in corso…",
    left: (n) => (n === 1 ? "Ancora 1 oggi." : `Ancora ${n} oggi.`),
    labels: { x: "Per X", instagram: "Per Instagram", linkedin: "Per LinkedIn" },
    errors: {
      day: "Hai raggiunto il limite di oggi. Torna domani.",
      month: "I post di questo negozio per questo mese sono finiti. Scrivi al negozio se te ne servono altri.",
      failed: "Questa volta non è arrivato nulla. Riprova tra un momento.",
      other: "Non è stato possibile. Ricarica la pagina e riprova.",
    },
  },
  termDisclose: "Ovunque condividi il tuo link, di' che ci guadagni una commissione, e prometti solo ciò che il prodotto fa: niente guadagni né risultati che non garantisce.",
  termBuyers: (store) =>
    `Chiunque abbia acquistato da ${store} può unirsi subito, dal proprio ordine; tutti gli altri si candidano e ${store} decide. ${store} ti paga direttamente dal proprio conto: Marktmorgen non detiene mai questo denaro, quindi non c'è un minimo da raggiungere né una scadenza entro cui richiederlo.`,
  termApproves: (store) =>
    `${store} approva ogni affiliato e ti paga direttamente dal proprio conto: Marktmorgen non detiene mai questo denaro, quindi non c'è un minimo da raggiungere né una scadenza entro cui richiederlo.`,
  productRate: (title, percent) => `${title}: ${percent === 0 ? "non fa parte del programma" : `${percent}${S}%`}`,
  applyClosed: "Al momento non è possibile inviare candidature da qui. Riprova più tardi.",
  whenOpens: (store) => `Quando ${store} ne aprirà uno, è qui che potrai candidarti.`,
  attribution: (days, isFirst, isLifetime) => {
    const window = `fino a ${days} ${plural(days, "giorno", "giorni")}`;
    const kept = "finché il browser dell'acquirente conserva il cookie — i browser fissano un proprio limite e accorciano una durata lunga senza avvisare il sito";
    const rule = isFirst
      ? `Il primo link di affiliazione che un acquirente segue si aggiudica la vendita, ${window} dopo quel primo clic e ${kept}, anche se in seguito segue il link di qualcun altro.`
      : `L'ultimo link di affiliazione che un acquirente segue si aggiudica la vendita, ${window} dopo quel clic e ${kept}.`;
    return isLifetime
      ? `${rule} Niente di tutto questo vale più una volta che una vendita è stata accreditata: da quel momento l'acquirente resta legato a quell'affiliato, e tutto ciò che la persona acquista in seguito gli fa guadagnare, senza limiti di tempo, su qualsiasi dispositivo, senza alcun cookie.`
      : rule;
  },
  contactsRule:
    "Un acquisto singolo non attribuito a nessun link né codice di affiliato né a un acquisto precedente va all'affiliato che ha portato l'acquirente come lead confermato prima dell'acquisto, su qualsiasi dispositivo e senza alcun cookie.",
  payoutPromise: (store, n, days) => {
    const wait =
      days > 0
        ? ` Una vendita diventa pagabile ${days} ${plural(days, "giorno", "giorni")} dopo essere stata fatta, così un rimborso in quel periodo viene detratto prima.`
        : "";
    if (n < 1) return `${store} non ha fissato un giorno di pagamento, e paga quando decide.${wait}`;
    return `${store} paga il giorno ${n} di ogni mese.${wait}`;
  },

  payChangedSubject: (store) => `È cambiato l'indirizzo su cui ${store} ti paga`,
  payChangedLine: (store, address) => `L'indirizzo PayPal su cui ${store} paga le tue commissioni di affiliato ora è: ${address}.`,
  payChangedIfNot:
    "Se non l'hai cambiato tu, apri la tua pagina di affiliato, rimettilo com'era ed esci da tutti i browser, poi avvisa il negozio rispondendo a questa email:",
  linkSubjectNew: (store) => `Conferma la tua candidatura come affiliato di ${store}`,
  linkIntroKnown: (store) => `Ecco l'accesso alla tua pagina di affiliato per ${store}:`,
  linkIntroNew: (store) => `Hai chiesto di diventare affiliato di ${store}. Apri questo link e premi il pulsante per inviare la tua candidatura:`,
  linkShowsKnown: "Mostra il tuo link, i tuoi clic, le tue vendite e quanto hai guadagnato e ricevuto.",
  linkAboutNew: (store, days) =>
    `${store} decide su ogni candidatura. Una volta approvato, la tua pagina ti dà il tuo link, e un acquisto singolo fatto tramite il link entro ${days} ${plural(days, "giorno", "giorni")} da un clic ti fa guadagnare una quota.`,
  paidByStore: (store) => `Le commissioni te le paga direttamente ${store}, non Marktmorgen, che non detiene mai il denaro.`,
  linkExpires: "Il link funziona per 24 ore. Se non l'hai chiesto tu, ignora questa email; non succede nulla se il link non viene usato.",
  approvedSubject: (store) => `Sei un affiliato di ${store}`,
  approvedIntro: (store) => `${store} ha approvato la tua candidatura. Il tuo link:`,
  approvedTerms: (days, percent, hasRates) =>
    `Un acquisto singolo fatto tramite il link entro ${days} ${plural(days, "giorno", "giorni")} da un clic ti fa guadagnare il ${percent}${S}% di quanto l'acquirente ha pagato al netto delle tasse${hasRates ? " (alcuni prodotti fanno guadagnare una quota diversa; la tua pagina li elenca)" : ""}. Abbonamenti e pagamenti rateali non fanno guadagnare, e una vendita rimborsata non fa guadagnare nulla.`,
  approvedPage: (url) => `I tuoi clic, vendite e guadagni: ${url}`,
  termIdle: (days, warn, withLeads) =>
    withLeads
      ? `Un affiliato il cui link non porta alcuna vendita né alcun lead per ${days} giorni viene rimosso dal programma, dopo un'email inviata ${warn} giorni prima con la data. Una vendita o un lead prima di allora lo mantiene nel programma.`
      : `Un affiliato il cui link non porta alcuna vendita per ${days} giorni viene rimosso dal programma, dopo un'email inviata ${warn} giorni prima con la data. Una vendita prima di allora lo mantiene nel programma.`,
  idleSubject: (store, date) => `Il tuo link di affiliato di ${store} termina il ${date}`,
  idleBody: (store, days, date, withLeads) =>
    withLeads
      ? `${store} rimuove gli affiliati il cui link non porta alcuna vendita né alcun lead per ${days} giorni. Se il tuo non ne porta prima del ${date}, uscirai dal programma quel giorno. Una vendita o un lead tramite il tuo link prima di quella data ti mantiene nel programma. Il tuo storico di clic, vendite e pagamenti resta com'è.`
      : `${store} rimuove gli affiliati il cui link non porta alcuna vendita per ${days} giorni. Se il tuo non ne porta prima del ${date}, uscirai dal programma quel giorno. Una vendita tramite il tuo link prima di quella data ti mantiene nel programma. Il tuo storico di clic, vendite e pagamenti resta com'è.`,

  partnerSubject: (store) => `${store} ti vuole come partner`,
  partnerOffer: (store, percent) => `${store} ti offre il ${percent}${S}% di ogni vendita di:`,
  someProduct: "un prodotto",
  partnerInStudio: "Ti aspetta nel tuo studio, con le condizioni, per accettarla o rifiutarla:",
  partnerAnswer: "Non succede nulla finché non rispondi. Se rifiuti, sapranno solo che hai rifiutato.",
  partnerTerms: (percent) =>
    `È il ${percent}${S}% di quanto ogni acquirente paga al netto delle tasse, su ogni vendita — non solo quelle che porti tu. Una vendita rimborsata non fa guadagnare nulla, e una rimborsata in parte fa guadagnare su quanto è stato trattenuto.`,
  partnerOpen: "Apri questo link per accettare e vedere la tua pagina, che mostra ogni vendita su cui hai guadagnato e quanto ti è stato pagato:",
  partnerPays: (store) =>
    `${store} ti paga direttamente, dal proprio conto. Marktmorgen non detiene mai questo denaro, quindi non c'è nessun saldo da aspettare e niente da richiedere entro una scadenza. Ti verrà chiesto l'indirizzo PayPal su cui essere pagato; non ti serve un account da noi.`,
  partnerExpires: "Il link funziona per 24 ore. Se non era per te, ignoralo; non succede nulla se il link non viene usato.",

  listWhy: (name) => `Ricevi questa email perché hai detto a ${name} che volevi ricevere sue notizie.`,
  footerUnsubscribe: "Annulla l'iscrizione",
  footerUnsubscribeAfter: (name) => `con un clic, e ${name} non ti scriverà più.`,
  unsubscribeText: (url) => `Annulla l'iscrizione con un clic: ${url}`,
  doorText: (label, url) => `${label}: ${url}`,
  sentWith: "Inviato con Marktmorgen.",

  winbackOffer: (percent, months) =>
    months === 1 ? `${percent}${S}% di sconto sul tuo primo pagamento` : `${percent}${S}% di sconto sui tuoi primi ${months} pagamenti`,
  winbackSubject: (title, offer) => `Torna a ${title}: ${offer}`,
  hi: "Ciao,",
  winbackBody: (title, endedOn, offer, until) =>
    `Il tuo abbonamento a ${title} è terminato il ${endedOn}. Se vuoi tornare, hai diritto a ${offer}, fino al ${until}:`,
  winbackLinkNote: "Il link vale solo per questo indirizzo email, e non viene addebitato nulla finché non completi il pagamento.",

  unknownLink: "Non riconosciamo questo link",
  unknownListBody: "Apri il link per annullare l'iscrizione dall'email stessa, oppure usa il pulsante per annullare l'iscrizione della tua app di posta.",
  unknownOtherBody: "Apri il link dall'email stessa, oppure usa il pulsante per annullare l'iscrizione della tua app di posta.",
  onBehalfCreator: "Email inviate con Marktmorgen, per conto del creator che le ha scritte.",
  onBehalfStore: "Email inviate con Marktmorgen, per conto del negozio che le ha inviate.",
  forEmail: (email) => `Per ${email}. Basta un clic per fermarle per sempre.`,
  listDoneTitle: "Iscrizione annullata",
  listDone: (email, who) => `${email} non riceverà più email da ${who || "questo creator"}. Non serve altro.`,
  listAsk: (who) => `Non ricevere più email da ${who || "questo creator"}?`,
  unsubscribeButton: "Annulla l'iscrizione",
  communityDoneTitle: "Niente più email dalla community",
  communityDone: (email, who, where) =>
    `${email} non riceverà più via email gli annunci di ${who || "questo creator"} né i promemoria degli eventi dal vivo. Resti membro di ${where || "questa community"} e puoi leggerli lì. Se un evento a cui hai confermato la partecipazione viene spostato o annullato, vieni comunque avvisato, una volta.`,
  communityAsk: (who) => `Non ricevere più le email della community di ${who || "questo creator"}?`,
  communityFor: (email, where) =>
    `Annunci e promemoria degli eventi dal vivo, per ${email}. Resti membro di ${where || "questa community"} e mantieni le tue conferme di partecipazione; si fermano solo le email.`,
  stopEmails: "Interrompi le email",
  remindersDoneTitle: "Niente più promemoria",
  remindersDone: (email, who) =>
    `${email} non riceverà più promemoria sugli acquisti non completati da ${who || "questo negozio"}. Non serve altro.`,
  remindersAsk: (who) => `Non ricevere più promemoria sugli acquisti non completati da ${who || "questo negozio"}?`,
  stopReminders: "Interrompi i promemoria",
  clicksOn: (name) => `Hai permesso a ${name} di vedere quali link di queste email usi.`,
  clicksStop: "Non permetterlo più",
  clicksStopText: (url) => `Non permetterlo più: ${url}`,
  clicksAsk: (name) => `Non permettere più a ${name || "questo creator"} di vedere quali link usi?`,
  clicksFor: (email) => `Per ${email}. Resti nella lista; smette solo il conteggio, e quanto contato viene cancellato.`,
  clicksButton: "Smetti di contare i miei link",
  clicksDoneTitle: "I tuoi link non vengono più contati",
  clicksDone: (email, name) => `Quali link ${email} usa nelle email di ${name || "questo creator"} non viene più contato, e quanto contato è stato cancellato. Resti nella lista.`,
  reviewsDoneTitle: "Niente più richieste di recensione",
  reviewsDone: (email, who) => `${email} non riceverà più richieste di recensione da ${who || "questo negozio"}. Non serve altro.`,
  reviewsAsk: (who) => `Non ricevere più richieste di recensione da ${who || "questo negozio"}?`,
  reviewsFor: (email) => `Per ${email}. Basta un clic per fermarle per sempre. Una recensione che hai già scritto resta com'è.`,
  stopReviews: "Interrompi le richieste di recensione",
  reviewsNotSaved: "Non siamo riusciti a salvarlo ora. Riprova.",
};

// ---- Dutch -------------------------------------------------------------------------------------------
const nl: AffiliatesWords = {
  pageTitle: "Partnerprogramma",
  notices: {
    email: { title: "Dat lijkt geen e-mailadres", body: "Controleer het en probeer het opnieuw." },
    limited: {
      title: "Te veel verzoeken voor nu",
      body: "Om te voorkomen dat dit formulier wordt gebruikt om iemands inbox te overspoelen, neemt het maar een beperkt aantal verzoeken per uur aan. Probeer het over een uur opnieuw.",
    },
    unavailable: { title: "Deze winkel neemt op dit moment geen affiliates aan", body: "Er is niets verstuurd." },
    owner: { title: "Dit is het eigen adres van de winkel", body: "Een winkel kan niet zijn eigen affiliate zijn." },
    full: {
      title: "Dit programma is vol",
      body: "Het heeft zoveel affiliates als één winkel kan hebben. Schrijf de winkel als je in aanmerking wilt komen.",
    },
    error: { title: "Er ging iets mis aan onze kant", body: "Er is niets gewijzigd. Probeer het zo meteen opnieuw." },
    resting: { title: "Deze winkel kan dit nu niet verwerken", body: "Bij het accepteren worden eerst de partners van de winkel gecontroleerd, en de winkel kan nu niet zoveel aanvragen verwerken. Er is niets gewijzigd. Probeer het later opnieuw of schrijf de winkel." },
    expired: {
      title: "Deze link is verlopen",
      body: "Een gemailde link werkt één keer, binnen 24 uur. Vraag hieronder een nieuwe aan; dat duurt een paar seconden.",
    },
    order: {
      title: "Die bestelling kon niet worden gelezen",
      body: "Open de link in je aankoopmail opnieuw, of meld je hieronder aan met het adres waarmee je hebt gekocht.",
    },
    declined: {
      title: "Je kunt niet meedoen vanuit je bestelling",
      body: "Deze winkel heeft eerder over dit adres beslist. Schrijf de winkel als je vindt dat dat moet veranderen.",
    },
    signedout: { title: "Je bent uitgelogd in deze browser", body: "Vraag hieronder een nieuwe link aan om je affiliatepagina weer te zien." },
  },

  whereShare: "Waar je het zou delen",
  optional: "(optioneel)",
  notePlaceholder: "Mijn nieuwsbrief, mijn YouTube-kanaal…",
  emailMeLink: "Mail me een link om me aan te melden",
  formNote:
    "Geen wachtwoord. De link bevestigt dat het adres van jou is; als je hem opent, wordt je aanmelding verstuurd. Al affiliate? Hetzelfde formulier mailt je de weg terug naar je pagina.",
  continueAs: (email) => `Doorgaan als ${email}`,
  continueBody: (store) =>
    `Druk op de knop om je affiliatepagina voor ${store} in deze browser te openen. Als je je nog niet hebt aangemeld, wordt hiermee je aanmelding verstuurd.`,
  openMyPage: "Mijn affiliatepagina openen",
  checkInbox: "Kijk in je inbox",
  sentBody: (store) =>
    `De link is onderweg. Hij komt van ${store} via Marktmorgen en is er meestal binnen een minuut. Staat hij er niet, kijk dan in je spam.`,

  appliedTitle: "Je aanmelding is binnen",
  joinedTitle: "Je link staat klaar",
  welcomeTitle: "Je bent ingelogd in deze browser",
  appliedBody: (store) => `${store} is op de hoogte gebracht. Als je aanmelding wordt goedgekeurd, krijg je een e-mail met je link.`,
  joinedBody: "Deel hem overal. Je blijft 30 dagen ingelogd in deze browser, en hetzelfde formulier hieronder mailt je de weg terug.",
  welcomeBody: "Je blijft 30 dagen ingelogd in deze browser.",

  badgeAffiliate: "Goedgekeurde affiliate",
  badgePaused: "Programma gepauzeerd",
  badgePending: "Wacht op goedkeuring",
  badgeDeclined: "Niet goedgekeurd",
  badgeRemoved: "Geen affiliate meer",
  yourPageFor: (store) => `Je affiliatepagina voor ${store}`,
  pendingBody: (store) => `${store} beslist over elke aanmelding. Als die van jou wordt goedgekeurd, krijg je een e-mail met je link.`,
  pausedBody: (store) => `${store} heeft het programma gepauzeerd, dus links leveren nu niets op. Wat je al hebt verdiend, staat hieronder.`,
  declinedBody: (store) => `${store} heeft deze aanmelding niet goedgekeurd.`,
  removedBody: (store) =>
    `${store} heeft je plek in het programma beëindigd, dus je link levert niets meer op. Wat je eerder hebt verdiend, staat hieronder.`,

  yourLink: "Je link",
  copy: "Kopiëren",
  copied: "Gekopieerd",
  orAddVia: (code) => `Of voeg ?via=${code} toe aan het adres van elke pagina van deze winkel.`,
  recruitLabel: "Je uitnodigingslink",
  recruitNote: (percent, store) =>
    `Wie zich via deze link aanmeldt en door ${store} wordt goedgekeurd, hoort bij jou: je verdient ${percent}${S}% van elke verkoop die die persoon brengt, bovenop wat die zelf verdient, dat niet minder wordt. Het deel staat vast zodra die persoon instapt, en geldt niet voor de mensen die die op zijn beurt brengt.`,
  codesLabel: (count) => (count === 1 ? "Je code" : "Je codes"),
  codeNoteOne:
    "Zeg hem hardop, print hem, zet hem in een bijschrift. Een koper die hem bij het afrekenen invult, levert je je aandeel op, ook als die nooit op je link heeft geklikt — alleen zo bereikt een verkoop via een podcast, een podium of een video zonder links je überhaupt.",
  codeNoteMany:
    "Zeg ze hardop, print ze, zet ze in een bijschrift. Een koper die er een bij het afrekenen invult, levert je je aandeel op, ook als die nooit op je link heeft geklikt.",
  percentOff: (percent) => `${percent}${S}% korting`,
  amountOff: (amount) => `${amount} korting`,
  partnerShareLabel: "Je partneraandeel",
  partnerShare: (percent, products) =>
    `${percent}${S}% van wat een koper vóór belasting betaalt, bij elke verkoop van ${products} — wie de koper ook heeft gebracht, en of die nu via je link kwam of niet. Een terugbetaalde verkoop levert niets op, een gedeeltelijk terugbetaalde levert op over wat is behouden, en je eigen aankopen leveren nooit iets op.`,
  sharedFallback: "de producten waarin je deelt",
  yourRate: (store, percent) =>
    `${store} heeft je aandeel vastgesteld op ${percent}${S}% van wat een koper vóór belasting betaalt, bij elke eenmalige aankoop via je link, behalve producten die uit het programma zijn gehaald.`,

  clicks: "Klikken",
  sales: "Verkopen",
  earned: "Verdiend",
  paidAhead: "Vooruitbetaald",
  owedToYou: "Te ontvangen",
  paidSoFar: (amount, store) =>
    `Tot nu toe aan je betaald: ${amount}. ${store} betaalt je rechtstreeks, vanaf de eigen rekening. Marktmorgen houdt dit geld nooit vast, dus er is hier geen saldo om op te wachten en niets om vóór een deadline op te eisen.`,
  nextPayment: (date) => `Volgende betaling: ${date}.`,
  waitingNote: (amount) => `${amount} van wat je tegoed hebt, valt nog binnen die wachttijd en kan nog niet worden uitbetaald.`,
  refundsUnchecked:
    "Niet alle terugbetalingen konden zojuist worden gecontroleerd, dus een onlangs terugbetaalde verkoop kan nog als opbrengst worden getoond. Dat wordt rechtgezet bij de volgende bijwerking van deze cijfers.",
  figuresAsOf: (when: string) => `Cijfers van ${when}, gecoördineerde wereldtijd (UTC).`,
  figuresDaily: "Ze worden hoogstens één keer per dag bijgewerkt.",
  figuresShort: "Ze kunnen na 15 minuten opnieuw worden bijgewerkt.",
  figuresSoon: "Je cijfers zijn nog niet klaar.",
  figuresNoRoom: "Je cijfers kunnen nu niet worden bijgewerkt, omdat een limiet voor paginaweergaven is bereikt. Ze verschijnen weer zodra er weer ruimte is.",
  salesHead: "Verkopen via je link",
  noneYet: "Nog geen.",
  aProduct: "Een product",
  tierLine: (date, amount, percent, status) =>
    `${date} · een verkoop van iemand die jij bracht · ${amount} vóór belasting · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  saleLine: (date, amount, percent, status) => `${date} · ${amount} vóór belasting · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  lineStatus: { "own purchase": "eigen aankoop", refunded: "terugbetaald", "partly refunded": "deels terugbetaald" },
  paidByHead: (store) => `Door ${store} aan je betaald`,

  payPalLabel: "Waar PayPal je uitbetaalt",
  payPalNote: (store, email) =>
    `Als ${store} je via PayPal betaalt, gaat het naar dit adres. Laat het leeg om op ${email} te worden betaald. We mailen ${email} telkens als het verandert.`,
  saved: "Opgeslagen.",
  payPalNotEmail: "Dat lijkt geen e-mailadres. Er is niets gewijzigd.",
  payPalSlow: "Te veel wijzigingen voor nu. Probeer het over een uur opnieuw.",
  savePayPal: "Mijn PayPal-adres opslaan",
  signOut: "Uitloggen in deze browser",
  allPrograms: "Al je affiliateprogramma's op Marktmorgen op één plek",

  earnPercent: (percent, store) => `Verdien ${percent}${S}% door ${store} te delen`,
  buyerJoinBody: (store, days, percent) =>
    `Je hebt bij ${store} gekocht, dus je kunt nu meteen je eigen link krijgen, zonder je aan te melden. Een eenmalige aankoop via die link binnen ${days} ${plural(days, "dag", "dagen")} na een klik levert je ${percent}${S}% op van wat de koper vóór belasting betaalde.`,
  getMyLink: "Mijn link ophalen",
  buyerJoinNote: (promise, store) =>
    `${promise} ${store} betaalt je rechtstreeks; Marktmorgen houdt dit geld nooit vast. Je doet mee met het adres waarmee je hebt gekocht.`,

  earnBy: (store) => `Verdien door ${store} te delen`,
  noProgram: (store) => `${store} heeft op dit moment geen partnerprogramma`,
  termShare: (percent, hasDifferent) =>
    `${percent}${S}% van wat een koper vóór belasting betaalt, bij eenmalige aankopen via je link (lidmaatschappen en betalingen in termijnen leveren niets op)${hasDifferent ? "; sommige producten wijken af, zie hieronder" : ""}.`,
  termShareAll: (percent, hasDifferent) =>
    `${percent}${S}% van wat een koper vóór belasting betaalt, bij aankopen via je link${hasDifferent ? "; sommige producten wijken af, zie hieronder" : ""}.`,
  termRecurring: (months) =>
    months === 1
      ? "Een lidmaatschap levert iets op bij de eerste betaling, en een betaling in termijnen bij elke termijn."
      : months >= 1200
        ? "Een lidmaatschap levert iets op bij elke betaling zolang het lid blijft betalen, en een betaling in termijnen bij elke termijn."
        : `Een lidmaatschap levert iets op bij elke betaling in de eerste ${months} maanden, en een betaling in termijnen bij elke termijn.`,
  termBonus: (sales, amount) =>
    `Een premie van ${amount} voor elke kalendermaand waarin ${sales} ${plural(sales, "verkoop", "verkopen")} via je link iets ${plural(sales, "oplevert", "opleveren")}.`,
  termNoPaidSearch: (store) =>
    `Betaalde zoekadvertenties op de naam van ${store} zijn niet toegestaan: wat je toekomt wordt vastgehouden tot ${store} een klik bekijkt die van zo'n advertentie kwam.`,
  heldNote: (amount, store) => `${amount} van wat je toekomt wordt vastgehouden tot ${store} ernaar kijkt, en is nog niet uit te betalen.`,
  bonusTitle: (sales, month) => `Premie: ${sales} ${plural(sales, "verkoop", "verkopen")} in ${month}`,
  bonusLine: (date) => `${date} · premie`,
  termRefunds:
    "Een terugbetaalde verkoop levert niets op, een gedeeltelijk terugbetaalde alleen over wat is behouden, en je eigen aankopen leveren nooit iets op.",
  kit: {
    head: "Berichten om te delen, voor je geschreven",
    intro: "Kies een product en krijg drie korte berichten, geschreven vanuit de pagina ervan, met je link en een regel dat je eraan verdient er al in. Lees ze voordat je ze plaatst en pas aan wat voor jou niet klopt.",
    product: "Product",
    note: "Met wie je deelt en hoe je het kent (optioneel)",
    notePlaceholder: "Bijvoorbeeld: mijn volgers bakken thuis; ik gebruik de zuurdesemgids al een jaar",
    button: "Schrijf drie berichten",
    working: "Bezig met schrijven…",
    left: (n) => `Vandaag nog ${n}.`,
    labels: { x: "Voor X", instagram: "Voor Instagram", linkedin: "Voor LinkedIn" },
    errors: {
      day: "Je hebt de limiet van vandaag bereikt. Kom morgen terug.",
      month: "De berichten van deze winkel voor deze maand zijn op. Schrijf de winkel als je er meer nodig hebt.",
      failed: "Er kwam deze keer niets terug. Probeer het zo opnieuw.",
      other: "Dat lukte niet. Laad de pagina opnieuw en probeer het nog eens.",
    },
  },
  termDisclose: "Zeg overal waar je je link deelt dat je eraan verdient, en beloof alleen wat het product doet: geen inkomsten of resultaten die het niet garandeert.",
  termBuyers: (store) =>
    `Iedereen die bij ${store} heeft gekocht, kan meteen meedoen, vanuit de eigen bestelling; alle anderen melden zich aan en ${store} beslist. ${store} betaalt je rechtstreeks vanaf de eigen rekening: Marktmorgen houdt dit geld nooit vast, dus er is geen minimum om te halen en geen deadline om het op te eisen.`,
  termApproves: (store) =>
    `${store} keurt elke affiliate zelf goed en betaalt je rechtstreeks vanaf de eigen rekening: Marktmorgen houdt dit geld nooit vast, dus er is geen minimum om te halen en geen deadline om het op te eisen.`,
  productRate: (title, percent) => `${title}: ${percent === 0 ? "maakt geen deel uit van het programma" : `${percent}${S}%`}`,
  applyClosed: "Aanmeldingen kunnen op dit moment niet vanaf hier worden verstuurd. Probeer het later opnieuw.",
  whenOpens: (store) => `Als ${store} er een opent, meld je je hier aan.`,
  attribution: (days, isFirst, isLifetime) => {
    const window = `tot ${days} ${plural(days, "dag", "dagen")}`;
    const kept = "zolang de browser van de koper de cookie bewaart — browsers stellen daar hun eigen grens voor en korten een lange termijn in zonder de site in te lichten";
    const rule = isFirst
      ? `De eerste affiliatelink die een koper volgt, krijgt de verkoop, ${window} na die eerste klik en ${kept}, ook als die koper later de link van iemand anders volgt.`
      : `De laatste affiliatelink die een koper volgt, krijgt de verkoop, ${window} na die klik en ${kept}.`;
    return isLifetime
      ? `${rule} Niets daarvan geldt meer zodra een verkoop is toegekend: vanaf dan blijft de koper bij die affiliate, en alles wat die persoon daarna koopt, levert die affiliate iets op, zonder tijdslimiet, op elk apparaat, helemaal zonder cookie.`
      : rule;
  },
  contactsRule:
    "Een eenmalige aankoop die niet aan een affiliatelink, een affiliatecode of een eerdere aankoop is toegekend, gaat naar de affiliate die de koper vóór de aankoop als bevestigde lead heeft aangebracht, op elk apparaat en helemaal zonder cookie.",
  payoutPromise: (store, n, days) => {
    const wait =
      days > 0
        ? ` Een verkoop kan ${days} ${plural(days, "dag", "dagen")} na de aankoop worden uitbetaald, zodat een terugbetaling in die tijd er eerst van af gaat.`
        : "";
    if (n < 1) return `${store} heeft geen betaaldag vastgesteld en betaalt op een zelfgekozen moment.${wait}`;
    return `${store} betaalt op de ${n}e van elke maand.${wait}`;
  },

  payChangedSubject: (store) => `Het adres waarop ${store} je betaalt is gewijzigd`,
  payChangedLine: (store, address) => `Het PayPal-adres waarop ${store} je affiliatecommissies betaalt, is nu: ${address}.`,
  payChangedIfNot:
    "Heb je het niet zelf gewijzigd, open dan je affiliatepagina, zet het terug en log in elke browser uit; laat het daarna de winkel weten door op deze e-mail te antwoorden:",
  linkSubjectNew: (store) => `Bevestig je aanmelding als affiliate bij ${store}`,
  linkIntroKnown: (store) => `Hier is de toegang tot je affiliatepagina voor ${store}:`,
  linkIntroNew: (store) =>
    `Je hebt gevraagd om affiliate van ${store} te worden. Open deze link en druk op de knop om je aanmelding te versturen:`,
  linkShowsKnown: "Je ziet er je link, je klikken, je verkopen en wat je hebt verdiend en uitbetaald gekregen.",
  linkAboutNew: (store, days) =>
    `${store} beslist over elke aanmelding. Zodra je bent goedgekeurd, geeft je pagina je je eigen link, en een eenmalige aankoop via die link binnen ${days} ${plural(days, "dag", "dagen")} na een klik levert je een aandeel op.`,
  paidByStore: (store) => `Commissies worden rechtstreeks door ${store} aan je betaald, niet door Marktmorgen, dat het geld nooit vasthoudt.`,
  linkExpires: "De link werkt 24 uur. Heb je hier niet om gevraagd, negeer deze e-mail dan; er gebeurt niets zolang de link niet wordt gebruikt.",
  approvedSubject: (store) => `Je bent affiliate van ${store}`,
  approvedIntro: (store) => `${store} heeft je aanmelding goedgekeurd. Je link:`,
  approvedTerms: (days, percent, hasRates) =>
    `Een eenmalige aankoop via die link binnen ${days} ${plural(days, "dag", "dagen")} na een klik levert je ${percent}${S}% op van wat de koper vóór belasting betaalde${hasRates ? " (sommige producten leveren een ander aandeel op; je pagina noemt ze)" : ""}. Lidmaatschappen en betalingen in termijnen leveren niets op, en een terugbetaalde verkoop levert niets op.`,
  approvedPage: (url) => `Je klikken, verkopen en verdiensten: ${url}`,
  termIdle: (days, warn, withLeads) =>
    withLeads
      ? `Een affiliate van wie de link ${days} dagen lang geen verkoop en geen lead oplevert, wordt uit het programma verwijderd, na een e-mail ${warn} dagen vooraf met de datum. Eén verkoop of één lead vóór die tijd houdt hem erin.`
      : `Een affiliate van wie de link ${days} dagen lang geen verkoop oplevert, wordt uit het programma verwijderd, na een e-mail ${warn} dagen vooraf met de datum. Eén verkoop vóór die tijd houdt hem erin.`,
  idleSubject: (store, date) => `Je affiliatelink bij ${store} stopt op ${date}`,
  idleBody: (store, days, date, withLeads) =>
    withLeads
      ? `${store} verwijdert affiliates van wie de link ${days} dagen lang geen verkoop en geen lead oplevert. Als die van jou vóór ${date} niets oplevert, word je die dag uit het programma verwijderd. Eén verkoop of één lead via je link vóór die datum houdt je erin. Je overzicht van klikken, verkopen en betalingen blijft zoals het is.`
      : `${store} verwijdert affiliates van wie de link ${days} dagen lang geen verkoop oplevert. Als die van jou vóór ${date} geen verkoop oplevert, word je die dag uit het programma verwijderd. Eén verkoop via je link vóór die datum houdt je erin. Je overzicht van klikken, verkopen en betalingen blijft zoals het is.`,

  partnerSubject: (store) => `${store} wil je als partner`,
  partnerOffer: (store, percent) => `${store} biedt je ${percent}${S}% van elke verkoop van:`,
  someProduct: "een product",
  partnerInStudio: "Het aanbod wacht in je eigen studio, met de voorwaarden, om te accepteren of af te wijzen:",
  partnerAnswer: "Er gebeurt niets tot je antwoordt. Als je afwijst, horen ze alleen dat je hebt afgewezen.",
  partnerTerms: (percent) =>
    `Dat is ${percent}${S}% van wat elke koper vóór belasting betaalt, bij elke verkoop — niet alleen de verkopen die jij aanbrengt. Een terugbetaalde verkoop levert niets op, en een gedeeltelijk terugbetaalde levert op over wat is behouden.`,
  partnerOpen: "Open deze link om te accepteren en je eigen pagina te zien, met elke verkoop waaraan je hebt verdiend en wat je is uitbetaald:",
  partnerPays: (store) =>
    `${store} betaalt je rechtstreeks, vanaf de eigen rekening. Marktmorgen houdt dit geld nooit vast, dus er is geen saldo om op te wachten en niets om vóór een deadline op te eisen. Je wordt gevraagd naar het PayPal-adres waarop je betaald wilt worden; je hebt geen account bij ons nodig.`,
  partnerExpires: "De link werkt 24 uur. Was dit niet voor jou bedoeld, negeer het dan; er gebeurt niets zolang de link niet wordt gebruikt.",

  listWhy: (name) => `Je krijgt dit omdat je ${name} hebt laten weten dat je berichten wilde ontvangen.`,
  footerUnsubscribe: "Afmelden",
  footerUnsubscribeAfter: (name) => `met één klik, en ${name} mailt je niet meer.`,
  unsubscribeText: (url) => `Afmelden met één klik: ${url}`,
  doorText: (label, url) => `${label}: ${url}`,
  sentWith: "Verzonden met Marktmorgen.",

  winbackOffer: (percent, months) =>
    months === 1 ? `${percent}${S}% korting op je eerste betaling` : `${percent}${S}% korting op je eerste ${months} betalingen`,
  winbackSubject: (title, offer) => `Kom terug bij ${title}: ${offer}`,
  hi: "Hoi,",
  winbackBody: (title, endedOn, offer, until) =>
    `Je lidmaatschap van ${title} is op ${endedOn} geëindigd. Als je terug wilt komen, krijg je ${offer}, tot ${until}:`,
  winbackLinkNote: "De link is alleen voor dit e-mailadres, en er wordt niets afgeschreven tot je afrekent.",

  unknownLink: "Deze link kennen we niet",
  unknownListBody: "Open de afmeldlink vanuit de e-mail zelf, of gebruik de afmeldknop van je mailapp.",
  unknownOtherBody: "Open de link vanuit de e-mail zelf, of gebruik de afmeldknop van je mailapp.",
  onBehalfCreator: "E-mails verzonden met Marktmorgen, namens de maker die ze heeft geschreven.",
  onBehalfStore: "E-mails verzonden met Marktmorgen, namens de winkel die ze heeft verstuurd.",
  forEmail: (email) => `Voor ${email}. Eén klik stopt ze voorgoed.`,
  listDoneTitle: "Je bent afgemeld",
  listDone: (email, who) => `${email} krijgt geen e-mails meer van ${who || "deze maker"}. Verder hoef je niets te doen.`,
  listAsk: (who) => `Geen e-mails meer van ${who || "deze maker"}?`,
  unsubscribeButton: "Afmelden",
  communityDoneTitle: "Geen e-mails meer van de community",
  communityDone: (email, who, where) =>
    `${email} krijgt geen aankondigingen of herinneringen aan live-evenementen van ${who || "deze maker"} meer per e-mail. Je blijft in ${where || "de community"} en kunt ze daar lezen. Wordt een evenement waarvoor je je hebt aangemeld verplaatst of geannuleerd, dan hoor je dat toch, één keer.`,
  communityAsk: (who) => `Geen community-e-mails meer van ${who || "deze maker"}?`,
  communityFor: (email, where) =>
    `Aankondigingen en herinneringen aan live-evenementen, voor ${email}. Je blijft in ${where || "de community"} en houdt je aanmeldingen; alleen de e-mails stoppen.`,
  stopEmails: "Stop de e-mails",
  remindersDoneTitle: "Geen herinneringen meer",
  remindersDone: (email, who) =>
    `${email} krijgt geen herinneringen aan onafgemaakte bestellingen meer van ${who || "deze winkel"}. Verder hoef je niets te doen.`,
  remindersAsk: (who) => `Geen herinneringen aan onafgemaakte bestellingen meer van ${who || "deze winkel"}?`,
  stopReminders: "Stop de herinneringen",
  clicksOn: (name) => `Je hebt ${name} toegestaan te zien welke links in deze e-mails je gebruikt.`,
  clicksStop: "Niet meer toestaan",
  clicksStopText: (url) => `Niet meer toestaan: ${url}`,
  clicksAsk: (name) => `${name || "Deze maker"} niet meer laten zien welke links je gebruikt?`,
  clicksFor: (email) => `Voor ${email}. Je blijft op de lijst; alleen het tellen stopt, en wat geteld is wordt verwijderd.`,
  clicksButton: "Mijn links niet meer tellen",
  clicksDoneTitle: "Je links worden niet meer geteld",
  clicksDone: (email, name) => `Welke links ${email} gebruikt in e-mails van ${name || "deze maker"} wordt niet meer geteld, en wat geteld was is verwijderd. Je blijft op de lijst.`,
  reviewsDoneTitle: "Geen beoordelingsverzoeken meer",
  reviewsDone: (email, who) =>
    `${email} krijgt geen verzoeken om een beoordeling meer van ${who || "deze winkel"}. Verder hoef je niets te doen.`,
  reviewsAsk: (who) => `Geen beoordelingsverzoeken meer van ${who || "deze winkel"}?`,
  reviewsFor: (email) => `Voor ${email}. Eén klik stopt ze voorgoed. Een beoordeling die je al hebt geschreven, blijft zoals hij is.`,
  stopReviews: "Stop de beoordelingsverzoeken",
  reviewsNotSaved: "We konden dat nu niet opslaan. Probeer het opnieuw.",
};

// ---- European Portuguese -------------------------------------------------------------------------------
/** "de" before a name, or "deste criador" / "desta loja" when there is none: Portuguese joins them. */
const deCriador = (who: string) => (who ? `de ${who}` : "deste criador");
const deLoja = (who: string) => (who ? `de ${who}` : "desta loja");

const pt: AffiliatesWords = {
  pageTitle: "Afiliados",
  notices: {
    email: { title: "Isso não parece um endereço de email", body: "Verifique-o e tente novamente." },
    limited: {
      title: "Demasiados pedidos por agora",
      body: "Para evitar que este formulário seja usado para inundar a caixa de entrada de alguém, aceita um número limitado de pedidos por hora. Tente novamente dentro de uma hora.",
    },
    unavailable: { title: "Esta loja não está a aceitar afiliados neste momento", body: "Nada foi enviado." },
    owner: { title: "Este é o próprio endereço da loja", body: "Uma loja não pode ser afiliada de si própria." },
    full: {
      title: "Este programa está completo",
      body: "Tem tantos afiliados quantos uma loja pode ter. Escreva à loja se quiser ser considerado.",
    },
    error: { title: "Algo correu mal do nosso lado", body: "Nada foi alterado. Tente novamente daqui a pouco." },
    resting: { title: "Esta loja não pode tratar disto agora", body: "Para aceitar, verificam-se primeiro os parceiros da loja, e a loja não consegue tratar tantos pedidos neste momento. Nada foi alterado. Tente novamente mais tarde ou escreva à loja." },
    expired: {
      title: "Esta ligação expirou",
      body: "Uma ligação enviada por email funciona uma vez, no prazo de 24 horas. Peça uma nova abaixo; demora poucos segundos.",
    },
    order: {
      title: "Não foi possível ler essa encomenda",
      body: "Abra novamente a ligação no seu email de compra, ou candidate-se abaixo com o endereço com que comprou.",
    },
    declined: {
      title: "Não pode aderir a partir da sua encomenda",
      body: "Esta loja já decidiu sobre este endereço. Escreva à loja se achar que isso deve mudar.",
    },
    signedout: { title: "Terminou a sessão neste navegador", body: "Para voltar a ver a sua página de afiliado, peça uma nova ligação abaixo." },
  },

  whereShare: "Onde o partilharia",
  optional: "(opcional)",
  notePlaceholder: "A minha newsletter, o meu canal de YouTube…",
  emailMeLink: "Enviar-me uma ligação para me candidatar",
  formNote:
    "Sem palavra-passe. A ligação confirma que o endereço é seu; ao abri-la, a sua candidatura é enviada. Já é afiliado? O mesmo formulário envia-lhe por email o caminho de volta para a sua página.",
  continueAs: (email) => `Continuar como ${email}`,
  continueBody: (store) =>
    `Carregue no botão para abrir a sua página de afiliado de ${store} neste navegador. Se ainda não se candidatou, isto envia a sua candidatura.`,
  openMyPage: "Abrir a minha página de afiliado",
  checkInbox: "Verifique a sua caixa de entrada",
  sentBody: (store) =>
    `A ligação está a caminho. Vem de ${store} através da Marktmorgen e costuma chegar em menos de um minuto. Se não estiver lá, veja no spam.`,

  appliedTitle: "A sua candidatura foi enviada",
  joinedTitle: "A sua ligação está pronta",
  welcomeTitle: "Tem sessão iniciada neste navegador",
  appliedBody: (store) => `Já avisámos ${store}. Se a sua candidatura for aprovada, recebe um email com a sua ligação.`,
  joinedBody:
    "Partilhe-a onde quiser. Mantém a sessão iniciada neste navegador durante 30 dias, e o mesmo formulário abaixo envia-lhe por email o caminho de volta.",
  welcomeBody: "Mantém a sessão iniciada neste navegador durante 30 dias.",

  badgeAffiliate: "Afiliado",
  badgePaused: "Programa em pausa",
  badgePending: "A aguardar aprovação",
  badgeDeclined: "Não aprovado",
  badgeRemoved: "Já não é afiliado",
  yourPageFor: (store) => `A sua página de afiliado de ${store}`,
  pendingBody: (store) => `${store} decide sobre cada candidatura. Se aprovar a sua, recebe um email com a sua ligação.`,
  pausedBody: (store) => `${store} pôs o programa em pausa, por isso as ligações não geram ganhos neste momento. O que já ganhou está abaixo.`,
  declinedBody: (store) => `${store} não aprovou esta candidatura.`,
  removedBody: (store) =>
    `${store} terminou a sua participação no programa, por isso a sua ligação já não gera ganhos. O que ganhou antes está abaixo.`,

  yourLink: "A sua ligação",
  copy: "Copiar",
  copied: "Copiado",
  orAddVia: (code) => `Ou acrescente ?via=${code} ao endereço de qualquer página desta loja.`,
  recruitLabel: "A sua ligação de convite",
  recruitNote: (percent, store) =>
    `Quem se candidatar por esta ligação e for aprovado por ${store} fica consigo: ganha ${percent}${S}% de cada venda que essa pessoa trouxer, além do que ela ganha, que não diminui. A parte fica fixa quando ela entra e não se aplica às pessoas que ela trouxer por sua vez.`,
  codesLabel: (count) => (count === 1 ? "O seu código" : "Os seus códigos"),
  codeNoteOne:
    "Diga-o em voz alta, imprima-o, coloque-o numa legenda. Um comprador que o introduza no pagamento faz-lhe ganhar a sua parte mesmo que nunca tenha clicado na sua ligação — é a única forma de lhe chegar uma venda vinda de um podcast, de um palco ou de um vídeo sem ligações.",
  codeNoteMany:
    "Diga-os em voz alta, imprima-os, coloque-os numa legenda. Um comprador que introduza um deles no pagamento faz-lhe ganhar a sua parte mesmo que nunca tenha clicado na sua ligação.",
  percentOff: (percent) => `${percent}${S}% de desconto`,
  amountOff: (amount) => `${amount} de desconto`,
  partnerShareLabel: "A sua participação como parceiro",
  partnerShare: (percent, products) =>
    `${percent}${S}% do que um comprador paga antes de impostos em cada venda de ${products} — seja quem for que trouxe o comprador, e quer tenha vindo ou não pela sua ligação. Uma venda reembolsada não gera nada, uma parcialmente reembolsada gera sobre o que foi mantido, e as suas próprias compras nunca geram nada.`,
  sharedFallback: "os produtos em que participa",
  yourRate: (store, percent) =>
    `${store} fixou a sua parte em ${percent}${S}% do que um comprador paga antes de impostos, em cada compra única feita através da sua ligação, exceto os produtos que retirou do programa.`,

  clicks: "Cliques",
  sales: "Vendas",
  earned: "Ganho",
  paidAhead: "Pago antecipadamente",
  owedToYou: "A receber",
  paidSoFar: (amount, store) =>
    `Pago até agora: ${amount}. ${store} paga-lhe diretamente, a partir da própria conta. A Marktmorgen nunca detém este dinheiro, por isso não há aqui saldo de que esteja à espera nem nada a reclamar antes de um prazo.`,
  nextPayment: (date) => `Próximo pagamento: ${date}.`,
  waitingNote: (amount) => `${amount} do que lhe é devido ainda está dentro desse prazo de espera e ainda não pode ser pago.`,
  refundsUnchecked:
    "Não foi possível verificar agora todos os reembolsos, por isso uma venda reembolsada recentemente pode ainda aparecer como se gerasse ganhos. Fica corrigido na próxima atualização destes números.",
  figuresAsOf: (when: string) => `Números de ${when}, tempo universal coordenado (UTC).`,
  figuresDaily: "São atualizados no máximo uma vez por dia.",
  figuresShort: "Podem ser atualizados de novo após 15 minutos.",
  figuresSoon: "Os seus números ainda não estão prontos.",
  figuresNoRoom: "Os seus números não podem ser atualizados agora, porque foi atingido um limite de visualizações de páginas. Voltam a aparecer quando houver margem de novo.",
  salesHead: "Vendas através da sua ligação",
  noneYet: "Ainda nenhuma.",
  aProduct: "Um produto",
  tierLine: (date, amount, percent, status) =>
    `${date} · uma venda de alguém que trouxe · ${amount} antes de impostos · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  saleLine: (date, amount, percent, status) =>
    `${date} · ${amount} antes de impostos · ${percent}${S}%${status ? ` · ${status}` : ""}`,
  lineStatus: { "own purchase": "compra própria", refunded: "reembolsada", "partly refunded": "parcialmente reembolsada" },
  paidByHead: (store) => `Pago a si por ${store}`,

  payPalLabel: "Onde o PayPal lhe paga",
  payPalNote: (store, email) =>
    `Quando ${store} lhe paga pelo PayPal, o pagamento vai para este endereço. Deixe-o vazio para receber em ${email}. Enviamos um email para ${email} sempre que mudar.`,
  saved: "Guardado.",
  payPalNotEmail: "Isso não parece um endereço de email. Nada foi alterado.",
  payPalSlow: "Demasiadas alterações por agora. Tente novamente dentro de uma hora.",
  savePayPal: "Guardar o meu endereço PayPal",
  signOut: "Terminar sessão neste navegador",
  allPrograms: "Todos os seus programas de afiliados na Marktmorgen, num só lugar",

  earnPercent: (percent, store) => `Ganhe ${percent}${S}% ao partilhar ${store}`,
  buyerJoinBody: (store, days, percent) =>
    `Comprou em ${store}, por isso pode ter já a sua própria ligação, sem se candidatar. Uma compra única feita através dela no prazo de ${days} ${plural(days, "dia", "dias")} após um clique dá-lhe ${percent}${S}% do que o comprador pagou antes de impostos.`,
  getMyLink: "Obter a minha ligação",
  buyerJoinNote: (promise, store) =>
    `${promise} ${store} paga-lhe diretamente; a Marktmorgen nunca detém este dinheiro. Adere com o endereço com que comprou.`,

  earnBy: (store) => `Ganhe ao partilhar ${store}`,
  noProgram: (store) => `${store} não tem programa de afiliados neste momento`,
  termShare: (percent, hasDifferent) =>
    `${percent}${S}% do que um comprador paga antes de impostos, em compras únicas feitas através da sua ligação (subscrições e pagamentos em prestações não geram nada)${hasDifferent ? "; alguns produtos são diferentes, abaixo" : ""}.`,
  termShareAll: (percent, hasDifferent) =>
    `${percent}${S}% do que um comprador paga antes de impostos, em compras feitas através da sua ligação${hasDifferent ? "; alguns produtos são diferentes, abaixo" : ""}.`,
  termRecurring: (months) =>
    months === 1
      ? "Uma subscrição gera comissão no primeiro pagamento, e um pagamento em prestações em cada uma das suas prestações."
      : months >= 1200
        ? "Uma subscrição gera comissão em cada um dos seus pagamentos enquanto o membro continuar a pagar, e um pagamento em prestações em cada uma das suas prestações."
        : `Uma subscrição gera comissão em cada um dos seus pagamentos nos primeiros ${months} meses, e um pagamento em prestações em cada uma das suas prestações.`,
  termBonus: (sales, amount) =>
    `Um bónus de ${amount} em cada mês do calendário em que ${sales} ${plural(sales, "venda", "vendas")} através da sua ligação ${plural(sales, "gere", "gerem")} comissão.`,
  termNoPaidSearch: (store) =>
    `Não são permitidos anúncios pagos em motores de pesquisa com o nome ${deLoja(store)}: o que lhe é devido fica retido até que ${store} analise um clique vindo de um deles.`,
  heldNote: (amount, store) => `${amount} do que lhe é devido está retido até que ${store} o analise, e ainda não pode ser pago.`,
  bonusTitle: (sales, month) => `Bónus: ${sales} ${plural(sales, "venda", "vendas")} em ${month}`,
  bonusLine: (date) => `${date} · bónus`,
  termRefunds:
    "Uma venda reembolsada não gera nada, uma parcialmente reembolsada gera apenas sobre o que foi mantido, e as suas próprias compras nunca geram nada.",
  kit: {
    head: "Publicações para partilhar, redigidas para si",
    intro: "Escolha um produto e receba três publicações curtas escritas a partir da página dele, já com a sua ligação e uma linha a dizer que recebe uma comissão. Leia cada uma antes de a publicar e altere o que não for verdade para si.",
    product: "Produto",
    note: "Com quem partilha e como conhece o produto (opcional)",
    notePlaceholder: "Por exemplo: quem me segue faz pão em casa; uso o guia de massa-mãe há um ano",
    button: "Escrever três publicações",
    working: "A escrever…",
    left: (n) => (n === 1 ? "Resta 1 hoje." : `Restam ${n} hoje.`),
    labels: { x: "Para X", instagram: "Para Instagram", linkedin: "Para LinkedIn" },
    errors: {
      day: "Atingiu o limite de hoje. Volte amanhã.",
      month: "As publicações desta loja para este mês esgotaram. Escreva à loja se precisar de mais.",
      failed: "Desta vez não veio nada. Tente de novo dentro de momentos.",
      other: "Não foi possível. Recarregue a página e tente de novo.",
    },
  },
  termDisclose: "Sempre que partilhar a sua ligação, diga que recebe uma comissão por ela e prometa apenas o que o produto faz: nem rendimentos nem resultados que ele não garanta.",
  termBuyers: (store) =>
    `Quem comprou em ${store} pode aderir de imediato, a partir da sua encomenda; os restantes candidatam-se e ${store} decide. ${store} paga-lhe diretamente a partir da própria conta: a Marktmorgen nunca detém este dinheiro, por isso não há mínimo a atingir nem prazo para o reclamar.`,
  termApproves: (store) =>
    `${store} aprova cada afiliado e paga-lhe diretamente a partir da própria conta: a Marktmorgen nunca detém este dinheiro, por isso não há mínimo a atingir nem prazo para o reclamar.`,
  productRate: (title, percent) => `${title}: ${percent === 0 ? "não faz parte do programa" : `${percent}${S}%`}`,
  applyClosed: "Neste momento não é possível enviar candidaturas a partir daqui. Tente novamente mais tarde.",
  whenOpens: (store) => `Quando ${store} abrir um, é aqui que se pode candidatar.`,
  attribution: (days, isFirst, isLifetime) => {
    const window = `até ${days} ${plural(days, "dia", "dias")}`;
    const kept = "enquanto o navegador do comprador guardar o cookie — os navegadores definem o seu próprio limite para isso e encurtam um prazo longo sem avisar o site";
    const rule = isFirst
      ? `A primeira ligação de afiliado que um comprador segue fica com a venda, ${window} após esse primeiro clique e ${kept}, mesmo que mais tarde siga a ligação de outra pessoa.`
      : `A última ligação de afiliado que um comprador segue fica com a venda, ${window} após esse clique e ${kept}.`;
    return isLifetime
      ? `${rule} Nada disso se aplica depois de uma venda ser creditada: a partir daí, o comprador fica associado a esse afiliado, e tudo o que essa pessoa comprar depois gera ganhos para ele, sem limite de tempo, em qualquer dispositivo, sem nenhum cookie envolvido.`
      : rule;
  },
  contactsRule:
    "Uma compra avulsa não atribuída a nenhuma ligação nem código de afiliado nem a uma compra anterior vai para o afiliado que trouxe o comprador como lead confirmado antes de comprar, em qualquer dispositivo e sem nenhum cookie.",
  payoutPromise: (store, n, days) => {
    const wait =
      days > 0
        ? ` Uma venda pode ser paga ${days} ${plural(days, "dia", "dias")} depois de feita, para que um reembolso nesse período seja descontado primeiro.`
        : "";
    if (n < 1) return `${store} não definiu um dia de pagamento e paga quando entender.${wait}`;
    return `${store} paga no dia ${n} de cada mês.${wait}`;
  },

  payChangedSubject: (store) => `Mudou o endereço onde ${store} lhe paga`,
  payChangedLine: (store, address) => `O endereço PayPal para onde ${store} paga as suas comissões de afiliado é agora: ${address}.`,
  payChangedIfNot:
    "Se não o alterou, abra a sua página de afiliado, reponha o endereço anterior e termine a sessão em todos os navegadores; depois avise a loja respondendo a este email:",
  linkSubjectNew: (store) => `Confirme a sua candidatura a afiliado de ${store}`,
  linkIntroKnown: (store) => `Eis o acesso à sua página de afiliado de ${store}:`,
  linkIntroNew: (store) => `Pediu para se tornar afiliado de ${store}. Abra esta ligação e carregue no botão para enviar a sua candidatura:`,
  linkShowsKnown: "Mostra a sua ligação, os seus cliques, as suas vendas e o que ganhou e lhe foi pago.",
  linkAboutNew: (store, days) =>
    `${store} decide sobre cada candidatura. Depois de aprovado, a sua página dá-lhe a sua própria ligação, e uma compra única feita através dela no prazo de ${days} ${plural(days, "dia", "dias")} após um clique dá-lhe uma parte.`,
  paidByStore: (store) => `As comissões são-lhe pagas diretamente por ${store}, não pela Marktmorgen, que nunca detém o dinheiro.`,
  linkExpires: "A ligação funciona durante 24 horas. Se não pediu isto, ignore este email; nada acontece a menos que a ligação seja usada.",
  approvedSubject: (store) => `É afiliado de ${store}`,
  approvedIntro: (store) => `${store} aprovou a sua candidatura. A sua ligação:`,
  approvedTerms: (days, percent, hasRates) =>
    `Uma compra única feita através dela no prazo de ${days} ${plural(days, "dia", "dias")} após um clique dá-lhe ${percent}${S}% do que o comprador pagou antes de impostos${hasRates ? " (alguns produtos geram uma parte diferente; a sua página indica-os)" : ""}. Subscrições e pagamentos em prestações não geram nada, e uma venda reembolsada não gera nada.`,
  approvedPage: (url) => `Os seus cliques, vendas e ganhos: ${url}`,
  termIdle: (days, warn, withLeads) =>
    withLeads
      ? `Um afiliado cuja ligação não traz nenhuma venda nem nenhum lead durante ${days} dias sai do programa, depois de um e-mail enviado ${warn} dias antes com a data. Uma venda ou um lead antes disso mantém-no no programa.`
      : `Um afiliado cuja ligação não traz nenhuma venda durante ${days} dias sai do programa, depois de um e-mail enviado ${warn} dias antes com a data. Uma venda antes disso mantém-no no programa.`,
  idleSubject: (store, date) => `A sua ligação de afiliado de ${store} termina em ${date}`,
  idleBody: (store, days, date, withLeads) =>
    withLeads
      ? `${store} retira os afiliados cuja ligação não traz nenhuma venda nem nenhum lead durante ${days} dias. Se a sua não trouxer nenhum antes de ${date}, sairá do programa nesse dia. Uma venda ou um lead através da sua ligação antes dessa data mantém-no no programa. O seu histórico de cliques, vendas e pagamentos fica como está.`
      : `${store} retira os afiliados cuja ligação não traz nenhuma venda durante ${days} dias. Se a sua não trouxer nenhuma antes de ${date}, sairá do programa nesse dia. Uma venda através da sua ligação antes dessa data mantém-no no programa. O seu histórico de cliques, vendas e pagamentos fica como está.`,

  partnerSubject: (store) => `${store} quer tê-lo como parceiro`,
  partnerOffer: (store, percent) => `${store} oferece-lhe ${percent}${S}% de cada venda de:`,
  someProduct: "um produto",
  partnerInStudio: "A proposta está à sua espera no seu próprio estúdio, com as condições, para aceitar ou recusar:",
  partnerAnswer: "Nada acontece até responder. Se recusar, só ficam a saber que recusou.",
  partnerTerms: (percent) =>
    `Ou seja, ${percent}${S}% do que cada comprador paga antes de impostos, em cada venda — não apenas nas que lhes trouxer. Uma venda reembolsada não gera nada, e uma parcialmente reembolsada gera sobre o que foi mantido.`,
  partnerOpen: "Abra esta ligação para aceitar e ver a sua própria página, que mostra cada venda com que ganhou e o que lhe foi pago:",
  partnerPays: (store) =>
    `${store} paga-lhe diretamente, a partir da própria conta. A Marktmorgen nunca detém este dinheiro, por isso não há saldo de que esteja à espera nem nada a reclamar até um prazo. Ser-lhe-á pedido o endereço PayPal onde quer receber; não precisa de conta connosco.`,
  partnerExpires: "A ligação funciona durante 24 horas. Se isto não era para si, ignore-o; nada acontece a menos que a ligação seja usada.",

  listWhy: (name) => `Recebe isto porque pediu para receber notícias de ${name}.`,
  footerUnsubscribe: "Cancelar a subscrição",
  footerUnsubscribeAfter: (name) => `com um clique, e ${name} não lhe voltará a escrever.`,
  unsubscribeText: (url) => `Cancelar a subscrição com um clique: ${url}`,
  doorText: (label, url) => `${label}: ${url}`,
  sentWith: "Enviado com Marktmorgen.",

  winbackOffer: (percent, months) =>
    months === 1 ? `${percent}${S}% de desconto no seu primeiro pagamento` : `${percent}${S}% de desconto nos seus primeiros ${months} pagamentos`,
  winbackSubject: (title, offer) => `Volte a ${title}: ${offer}`,
  hi: "Olá,",
  winbackBody: (title, endedOn, offer, until) =>
    `A sua subscrição de ${title} terminou a ${endedOn}. Se quiser voltar, tem ${offer}, até ${until}:`,
  winbackLinkNote: "A ligação é apenas para este endereço de email, e nada é cobrado até concluir o pagamento.",

  unknownLink: "Não reconhecemos esta ligação",
  unknownListBody:
    "Abra a ligação para cancelar a subscrição a partir do próprio email, ou use o botão de cancelamento de subscrição da sua aplicação de email.",
  unknownOtherBody: "Abra a ligação a partir do próprio email, ou use o botão de cancelamento de subscrição da sua aplicação de email.",
  onBehalfCreator: "Emails enviados com Marktmorgen, em nome do criador que os escreveu.",
  onBehalfStore: "Emails enviados com Marktmorgen, em nome da loja que os enviou.",
  forEmail: (email) => `Para ${email}. Basta um clique para os parar de vez.`,
  listDoneTitle: "A sua subscrição foi cancelada",
  listDone: (email, who) => `${email} não voltará a receber emails ${deCriador(who)}. Não é preciso mais nada.`,
  listAsk: (who) => `Deixar de receber emails ${deCriador(who)}?`,
  unsubscribeButton: "Cancelar a subscrição",
  communityDoneTitle: "Sem mais emails da comunidade",
  communityDone: (email, who, where) =>
    `${email} deixará de receber por email os anúncios ${deCriador(who)} e os lembretes de eventos em direto. Continua ${where ? `em ${where}` : "na comunidade"} e pode lê-los lá. Se um evento a que confirmou presença for alterado ou cancelado, continua a ser avisado, uma vez.`,
  communityAsk: (who) => `Deixar de receber os emails da comunidade ${deCriador(who)}?`,
  communityFor: (email, where) =>
    `Anúncios e lembretes de eventos em direto, para ${email}. Continua ${where ? `em ${where}` : "na comunidade"} e mantém as suas confirmações de presença; só os emails param.`,
  stopEmails: "Parar os emails",
  remindersDoneTitle: "Sem mais lembretes",
  remindersDone: (email, who) => `${email} não voltará a receber lembretes de compras por concluir ${deLoja(who)}. Não é preciso mais nada.`,
  remindersAsk: (who) => `Deixar de receber lembretes de compras por concluir ${deLoja(who)}?`,
  stopReminders: "Parar os lembretes",
  clicksOn: (name) => `Permitiu que ${name} veja que ligações destes emails utiliza.`,
  clicksStop: "Deixar de permitir",
  clicksStopText: (url) => `Deixar de permitir: ${url}`,
  clicksAsk: (name) => `Deixar de permitir que ${name || "este criador"} veja que ligações utiliza?`,
  clicksFor: (email) => `Para ${email}. Continua na lista; apenas deixa de haver contagem, e o que foi contado é apagado.`,
  clicksButton: "Deixar de contar as minhas ligações",
  clicksDoneTitle: "As suas ligações já não são contadas",
  clicksDone: (email, name) => `As ligações que ${email} utiliza nos emails de ${name || "este criador"} já não são contadas, e o que tinha sido contado foi apagado. Continua na lista.`,
  reviewsDoneTitle: "Sem mais pedidos de avaliação",
  reviewsDone: (email, who) => `${email} não voltará a receber pedidos de avaliação ${deLoja(who)}. Não é preciso mais nada.`,
  reviewsAsk: (who) => `Deixar de receber pedidos de avaliação ${deLoja(who)}?`,
  reviewsFor: (email) => `Para ${email}. Basta um clique para os parar de vez. Uma avaliação que já escreveu fica como está.`,
  stopReviews: "Parar os pedidos de avaliação",
  reviewsNotSaved: "Não conseguimos guardar isso agora. Tente novamente.",
};

export const AFFILIATES_WORDS: Record<LanguageCode, AffiliatesWords> = { en, es, fr, de, it, nl, pt };

/** The affiliate page's, its emails' and the list's words, in a store's language. */
export function affiliatesWords(language: unknown): AffiliatesWords {
  return AFFILIATES_WORDS[parseLanguage(language)];
}
