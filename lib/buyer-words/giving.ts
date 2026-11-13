/**
 * The words of what a store gives, hands out and asks after the sale, in the
 * store's language (lib/store-language.ts): a free copy and its email, a
 * waitlist and its emails, the places of a purchase for several people, a
 * gift's emails, leaving a review and the email asking for one, the reminder
 * to a buyer who left the payment page, a license key, and the email after a
 * PayPal purchase.
 *
 * Every language says everything English says, and nothing more. Prices,
 * dates and counts arrive already written (lib/buyer-words/index.ts, speech);
 * a sentence here only places them.
 *
 * Browser-safe: no server code, so lib/waitlist-rules.ts and lib/group-rules.ts
 * can read it too. Client components are handed the strings already said
 * (licenceKeyBoxWords, groupLinkBoxWords), never this file.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** French takes the singular for 0 and 1. */
const pluralFr = (n: number, one: string, many: string) => (n < 2 ? one : many);
/** "A, B and C" in a language's own "and": the things a deleted review takes with it (deleteReviewWhat). */
const andList = (parts: string[], and: string) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} ${and} ${parts[parts.length - 1]}`);
/** A non-breaking space, before the signs French spaces from the word before them. */
const S = " ";

type Notice = { title: string; body: string };

const en = {
  // ---- Shared by several pages and emails -------------------------------------------
  checkInbox: "Check your inbox",
  linkExpired: "This link has expired",
  emailTitle: "That does not look like an email address",
  openIt: "Open it",
  openHere: "Open it here:",
  sentBy: (store: string) => `Sent by Marktmorgen on behalf of ${store}.`,
  sentWith: "Sent with Marktmorgen.",
  orderRef: (reference: string) => `Order reference: ${reference}`,
  paidLine: (amount: string) => `Paid: ${amount}`,
  thanksReceipt: (store: string) => `Thank you for buying from ${store}. This is your receipt.`,
  chargedBy: (store: string) => `Charged by ${store} on their own Stripe account. Questions go to ${store} by replying to this email.`,
  /** `orders` is the whole address of the store's list of purchases. */
  link24: (orders: string) => `That link works for 24 hours. After that, go to ${orders}, type this address, and a new one comes right away.`,
  ignoreThis: "If you did not ask for this, ignore this email.",
  sentByNothing: (store: string) => `Sent by Marktmorgen on behalf of ${store}. Nothing was charged to you.`,

  // ---- The free copy: its page ------------------------------------------------------
  freeMetaTitle: "Your free copy",
  freeNotices: {
    email: {
      title: "That does not look like an email address",
      body: "Check it and try again. The copy goes to the address you type, so it has to be one you can open.",
    },
    limited: {
      title: "Too many requests for now",
      body: "To keep this form from being used to flood somebody's inbox, it takes a limited number of requests an hour. Try again in an hour.",
    },
    unavailable: {
      title: "This is not available right now",
      body: "Nothing was sent and nothing was kept. The store may still be setting it up.",
    },
    error: {
      title: "We could not send it just now",
      body: "Nothing was kept. Try again in a moment.",
    },
  } as Record<string, Notice>,
  alsoFrom: (store: string) => `Also from ${store}`,
  freeFrom: (store: string) => `From ${store}. Press the button and it is yours.`,
  downloadIt: "Download it",
  keptOn: (host: string, store: string) => `It is kept on ${host} by ${store}, not here, so the button takes you there.`,
  freeLinkWorks: "The link in your email works for 7 days, so you can come back for it on another device.",
  noLongerFree: "This is no longer free",
  changedSince: (store: string) => `${store} has changed it since the email was sent, so it is not handed out from this link.`,
  freeLinkDays: "A free copy's link works for 7 days. Ask the store for a new one — it takes a few seconds.",
  sent: "Sent",
  emailedLinkTo: (title: string) => `We emailed you a link to ${title}.`,
  emailedLink: "We emailed you a link.",
  comesFrom: (store: string) => `It comes from ${store} via Marktmorgen. If it is not there, look in spam.`,
  joinsOnUse: (store: string) => `Your address joins ${store}'s list only once you use that link, so a mistyped address never ends up on it.`,
  freeGone: "This is no longer offered for free.",
  freeNothing: "There is nothing on this yet. Ask the store about it.",

  // ---- The free copy: its email -------------------------------------------------------
  freeSubject: (title: string) => `Your copy of ${title}`,
  freeAsked: (store: string, title: string) => `You asked ${store} for ${title}. Here it is:`,
  freeOpen: "Open the link and press the button. It works for 7 days.",
  freeConsented: (store: string) => `You also said ${store} may send you emails. You can unsubscribe from any of them.`,
  freeNotConsented: (store: string) =>
    `You did not check the box to hear from ${store}, so your address reaches them marked as having asked for this one thing, and nothing more.`,
  freeIgnore: "If you did not ask for this, ignore this email. Nothing happens unless the link is used.",
  /** The way to write to the creator, when the store page's contact form is open (lib/store-contact.ts): replies to the free copy's email do not reach them (755 [STN2]). */
  freeContact: (store: string, link: string) => `To write to ${store}, use the contact form on their page: ${link}`,
  freeSentBy: (store: string) =>
    `Sent by Marktmorgen on behalf of ${store}. Marktmorgen uses your address for nothing else, and replies to this email do not reach ${store}.`,

  // ---- The waitlist: its page ----------------------------------------------------------
  waitlist: "Waitlist",
  waitNotices: {
    email: {
      title: "That does not look like an email address",
      body: "Check it and try again. The confirmation goes to the address you type, so it has to be one you can open.",
    },
    limited: {
      title: "Too many sign-ups for now",
      body: "To keep this form from being used to flood somebody's inbox, it takes a limited number an hour. Try again in an hour.",
    },
    full: {
      title: "This waitlist is full",
      body: "It holds as many people as it can. Nothing was kept.",
    },
    closed: {
      title: "This is not coming soon any more",
      body: "It may already be on sale. Nothing was kept.",
    },
    error: {
      title: "We could not send it just now",
      body: "Try again in a moment.",
    },
    expired: {
      title: "This link has expired",
      body: "A confirmation link works for 7 days. Join again from the product's page; it takes a few seconds.",
    },
  } as Record<string, Notice>,
  confirmSpotTitle: "Confirm your spot",
  /** `title` is empty when the product is gone. */
  confirmSpotBody: (store: string, title: string) => `Press the button and ${store} emails you once, when ${title || "it"} goes on sale.`,
  confirmSpotButton: "Confirm my spot",
  removeTitle: "Remove your address?",
  notTold: (title: string) => `You will not be told when ${title || "it"} goes on sale.`,
  removeButton: "Remove my address",
  notOnListTitle: "Your address is not on this waitlist",
  notOnListBody: "It was removed already, or the waitlist has done its job and its addresses are gone.",
  almostThere: "Almost there",
  waitSentBody: (title: string, store: string) =>
    `We emailed you a button to confirm your spot on the waitlist for ${title || "it"}. It comes from ${store} via Marktmorgen. If it is not there, look in spam.`,
  waitSentNote: "Your spot counts once you press it, so a mistyped address is never told anything.",
  onTheList: "You are on the list",
  tellWhenOut: (title: string) => `We will tell you when ${title || "it"} is out`,
  oneEmailDay: "One email, the day it goes on sale, with its link. That is all this waitlist sends.",
  removedTitle: "Your address is removed",

  // ---- The waitlist: its emails ------------------------------------------------------------
  waitSubject: (title: string) => `Confirm your spot: ${title}`,
  waitAsked: (store: string, title: string) => `You asked ${store} to tell you when ${title} comes out.`,
  waitOpen: "Open this link and press the button to confirm it was you:",
  waitWorks: "It works for 7 days. When it comes out you get one email with its link, and that is the only email this waitlist sends.",
  waitConsented: (store: string) =>
    `You also said ${store} may send you other emails; once you confirm, you are on their list and can unsubscribe from any of them.`,
  waitNotConsented: (store: string) => `You did not check the box to hear from ${store} otherwise, so you will not.`,
  waitIgnore: "If you did not ask for this, ignore this email. Nothing happens unless the button is pressed.",
  waitLeave: (link: string) => `To take your address off this waitlist at any time: ${link}`,
  launchSubject: (title: string) => `${title} is out`,
  /** `price` is empty for a product with no price to say. */
  launchLead: (store: string, title: string, price: string) =>
    `You asked ${store} to tell you when ${title} came out. It is out now${price ? `, at ${price}` : ""}:`,
  launchWhy: (title: string) =>
    `You are getting this because you joined the waitlist for ${title} and confirmed your address. It is the only email the waitlist sends.`,
  /** The link at the bottom of the launch email, and the words after it. */
  launchLabel: "Remove my address",
  launchAfter: "from this waitlist.",
  launchLine: (link: string) => `Remove my address: ${link}`,

  // ---- A purchase for several people: its page ----------------------------------------------
  groupMetaTitle: "Take your place",
  groupNotices: {
    sent: {
      title: "Check your inbox",
      body: "We sent a link to the address you typed. Open it and the place is yours. It works for 24 hours; if nothing arrives in a few minutes, look in spam, then type the address again below.",
    },
    email: {
      title: "That does not look like an email address",
      body: "Check it and try again. The link goes to the address you type, so it has to be one you can open.",
    },
    full: {
      title: "Every place has been taken",
      body: "Whoever bought this paid for a set number of people, and each place is now on somebody's address. Ask them whether they can buy one more.",
    },
    slow: {
      title: "Too many links asked for just now",
      body: "To keep this page from being used to fill somebody's inbox, it sends a limited number a day. Try again later; no place was taken or lost.",
    },
    unavailable: {
      title: "We could not send that just now",
      body: "No place was taken or lost. Try again in a moment.",
    },
    opening: {
      title: "We could not finish opening your place",
      body: "Open the link again in a moment. If it was already yours, nothing changes.",
    },
    expired: {
      title: "That link has expired",
      body: "It works for 24 hours. Type your address again below and a new one comes right away.",
    },
    resting: {
      title: "This store is resting for now",
      body: "No place was taken or lost. The store hands out places again when its next month begins, or sooner: come back then and type your address below for a new link.",
    },
  } as Record<string, Notice>,
  groupRefundedTitle: "This purchase was refunded",
  groupRefundedBody: (title: string, people: number) =>
    `${title} was bought for ${people} people and the payment was later refunded in full, so its places are closed.`,
  alreadyYours: "Already yours",
  done: "Done",
  hasItTitle: "This address already has it",
  placeYours: "The place is yours",
  placeHas: (title: string, email: string) => `${title} was already on ${email}, so no place was used.`,
  placeTaken: (title: string, email: string) => `${title} is now on ${email}, as if you had bought it. Nothing was charged to you.`,
  /** `address` is the store's address without "https://". */
  laterOrders: (address: string) => `Later, go to ${address}/orders and type this address: a link to everything on it comes right away.`,
  paidForYou: "Paid for you",
  boughtForPeople: (store: string, people: number, open: string) =>
    `Somebody bought this from ${store} for ${people} people and passed this link on. ${open}`,
  /** "3 of 5 places are still open". */
  placesLeft: (people: number, left: number): string =>
    left === 0 ? `All ${people} places have been taken.` : `${left} of ${people} places ${left === 1 ? "is" : "are"} still open.`,
  sendPlaceLink: "Send me the link to my place",
  placeNote: (title: string) =>
    `A link goes to that address, and opening it takes one place and puts ${title} on it. Nothing is charged to you. Your address is used to hand this over and to open it again later, and it is not added to any list.`,
  alreadyTook: "Already took yours?",
  openAgain: "Open it again",
  /** The box with the link to pass on (components/group-link-box.tsx). */
  linkToPass: "The link to pass on",
  copyLink: "Copy the link",
  copied: "Copied",

  // ---- A purchase for several people: its emails --------------------------------------------
  /** "5 people". */
  people: (people: number): string => `${people} ${people === 1 ? "person" : "people"}`,
  groupReceiptSubject: (people: number, title: string) => `Your ${people} places: ${title}`,
  resentReceipt: (store: string) => `${store} asked us to send you this again. It is a copy of your receipt.`,
  /** `who` is already said: "5 people". */
  forWho: (title: string, who: string) => `${title}, for ${who}`,
  passLinkOn: "Pass this link on to the people it is for:",
  eachPerson: (title: string, people: number) =>
    `Each person opens it and types their own email address. They get a link in their inbox, and opening it puts ${title} on that address, as if they had bought it. Take a place yourself the same way: you paid for ${people}, and you are one of them only if you take one.`,
  keepEmail:
    "Keep this email: the link is how the places are handed out, and the page it opens shows how many are left. A full refund takes every place back.",
  placeAgainSubject: (title: string) => `Your place in ${title}`,
  placeAgainLead: (title: string, store: string) => `You already took your place in ${title} from ${store}. Open it here:`,
  takePlaceSubject: (title: string) => `Take your place in ${title}`,
  takePlaceLead: (title: string, store: string, who: string) =>
    `Somebody bought ${title} from ${store} for ${who} and passed the link on. This address was typed on it to take one of the places.`,
  openToTake: "Open this link to take it:",
  takePlaceNote: (title: string) =>
    `It puts ${title} on this email address, as if you had bought it. Nothing is charged to you. The link works for 24 hours, and the place is yours once it is opened, while one is still free.`,
  ignoreUnlessOpened: "If you did not ask for this, ignore this email: nothing happens unless the link is opened.",

  // ---- A gift: its emails ---------------------------------------------------------------------
  someone: "Someone",
  giftSubject: (who: string, title: string) => `${who} sent you a gift: ${title}`,
  giftLead: (who: string, title: string, store: string) => `${who} bought you ${title} from ${store}.`,
  theirMessage: "Their message:",
  giftYours: "It is yours, on this email address. Open it here:",
  giftReceiptSubject: (title: string) => `Your gift is on its way: ${title}`,
  aGift: (title: string) => `A gift: ${title}`,
  giftFor: (email: string) => `For: ${email}`,
  weEmailed: (email: string, withMessage: boolean) =>
    `We emailed ${email} just now, with your name${withMessage ? " and your message" : ""} and a link to open it. It is theirs, on their address; you do not get a copy.`,

  // ---- Leaving a review: its page --------------------------------------------------------------
  reviewMetaTitle: "Your review",
  orderRefundedTitle: "This order was refunded",
  orderRefundedBody: (store: string) =>
    `An order ${store} refunded in full cannot be reviewed. If you wrote a review from it, its stars no longer count.`,
  expiredRecover: "Ask for your purchases again: a new link usually arrives by email within a minute, and you can review from there.",
  expiredReply: (store: string) => `Reply to the order confirmation ${store} emailed you, and it reaches them.`,
  wrongTitle: "Something went wrong on our side",
  nothingChanged: "Nothing was changed. Try again in a moment.",
  tooManyTries: "Too many tries",
  tooManyBody: "This page was opened many times in a few minutes. Wait a little, then open your link again.",
  cannotReviewTitle: "This order cannot be reviewed here",
  cannotReviewBody: "Open the link from your email or from your list of purchases.",
  getMyPurchases: "Get my purchases",
  reviewOne: (title: string) => `Review ${title}`,
  reviewAll: "Review what you bought",
  /** `date` is empty when the order's date is not known. */
  boughtFromOn: (store: string, date: string) =>
    `Bought from ${store}${date ? ` on ${date}` : ""}. An honest review is what helps the next buyer, and ${store}.`,

  // ---- Leaving a review: the form (components/review-form.tsx) ------------------------------
  reviewNotices: {
    saved: "Thank you. Your review is on the page now.",
    updated: "Your review has been updated.",
    deleted: "Your review has been deleted. Its stars no longer count in the average.",
    rating: "Pick from one to five stars.",
    refunded: "This order was refunded, so it cannot be reviewed.",
    expired: "This link has expired. Ask for your purchases again from the store and review from there.",
    no: "This order cannot be reviewed here.",
    full: "This product cannot take more reviews.",
    noroom: "This store has no room for more reviews right now, so yours was not saved. Try again later.",
    slow: "That was a lot of tries in a short time. Wait a few minutes and send it again.",
    busy: "Someone else was saving at the same moment. Send it again.",
    error: "Something went wrong on our side. Nothing was changed. Try again in a moment.",
    photo: "That photo could not be added. Try another one, as a JPEG or straight from your camera.",
    photoPaused: "Your review was saved, but the new photo was not added: this store is not taking new photos right now.",
    photoLimit: "Your review was saved, but the new photo was not added: a review can take 3 new photos in all, and yours has had 3.",
    photoFailed: "Your review was saved, but the new photo was not added because of a problem on our side. That try still counts as 1 of the 3 new photos a review can take.",
    confirmDelete: "There is no review of yours here to delete.",
    kept: "Your review was not deleted. Nothing was changed.",
  } as Record<string, string>,
  yourRating: (title: string) => `Your rating for ${title}`,
  whatYouThink: "What you think (optional)",
  /** `written` is the number already written: "2,000". */
  upTo: (written: string) => `Up to ${written} characters.`,
  nameToShow: "Name to show (optional)",
  updateReview: "Update my review",
  postReview: "Post my review",
  /** A review of theirs that could not be read: never a blank form that would post over it. */
  reviewUnread: (title: string) => `Your review of ${title} could not be loaded just now. Refresh this page in a moment to see or change it.`,
  reviewPublic: (store: string) =>
    `Your review is public on ${store}'s page, marked as a verified purchase. Your email address is never shown. ${store} can reply and can hide it, but cannot change it.`,
  deleteReview: "Delete my review",
  /** The question the first press of "Delete my review" opens (WCAG 3.3.4, 3.3.6): nothing is deleted until its yes. */
  deleteReviewAsk: (title: string) => `Delete your review of ${title}?`,
  /** Exactly what goes: the rating with its stars, the words when there are any, the photo when there is one. */
  deleteReviewWhat: (stars: number, hasWords: boolean, hasPhoto: boolean, store: string) =>
    `This deletes ${andList([`your ${stars}-star rating`, ...(hasWords ? ["your words"] : []), ...(hasPhoto ? ["your photo"] : [])], "and")} from ${store}'s page. It cannot be brought back.`,
  deleteReviewYes: "Yes, delete my review",
  deleteReviewKeep: "Keep my review",
  reviewPhoto: "Add a photo (optional)",
  reviewPhotoHint: "A photo of what you made with it, or of it in use. It shows with your review.",
  reviewPhotoRemove: "Remove my photo",
  reviewPhotoYours: "Your photo",
  reviewPhotoAlt: (name: string) => `Photo from ${name}`,

  // ---- Asking for a review: its email ----------------------------------------------------------
  askSubject: (title: string) => `How is ${title}?`,
  /** "A, B and C": `list` is the titles before the last, already joined with ", ". */
  listAnd: (list: string, last: string) => `${list} and ${last}`,
  askLead: (what: string, store: string, date: string) =>
    `You bought ${what} from ${store} on ${date}. If you have a minute, ${store} would like to know what you think, good or bad.`,
  askHow: "Give it one to five stars and a few words here:",
  askElsewhere: (store: string, site: string) => `If you would also like to, you can review ${store} on ${site}. It is the same for everyone asked, and entirely up to you:`,
  askShows: (store: string) =>
    `Your review appears on ${store}'s page marked as a verified purchase, under the name you choose. Your email address is never shown. The same link lets you change or delete it for 60 days.`,
  askOnly: "This is the only email about reviewing this order.",
  /** With the one reminder on (636 [GL4](a)): said in the first email instead of askOnly. */
  askOneMore: (days: number) => `If you have not reviewed it ${days} days from now, you get one reminder, and that is the last email about it.`,
  againSubject: (title: string) => `A reminder: how is ${title}?`,
  againLead: (what: string, store: string, date: string) =>
    `A few days ago ${store} asked what you think of ${what}, bought on ${date}. If you have a minute, a few words are welcome, good or bad.`,
  againOnly: "This is the last email about reviewing this order.",
  askWhy: (store: string) => `You are getting this because you bought from ${store}.`,
  askStopLabel: "Stop review requests",
  askStopAfter: (store: string) => `from ${store} in one click.`,
  askStopLine: (link: string) => `Stop review requests: ${link}`,

  // ---- The reminder to a buyer who left the payment page --------------------------------------
  recoverSubject: (title: string) => `You left ${title} at checkout`,
  recoverLead: (title: string, store: string) => `You started buying ${title} from ${store} and did not finish, so nothing was charged.`,
  recoverHere: "If you still want it, it is here:",
  recoverPrice: (price: string) => `The price: ${price}. The checkout opens at today's price.`,
  youChoosePrice: (price: string) => `you choose it, from ${price}`,
  recoverOnly: (why: string) => `This is the only reminder about that checkout. ${why}`,
  recoverWhyCheckout: (store: string) => `It reached you because you agreed, on the checkout page, to hear from ${store}.`,
  recoverWhyAsked: (store: string) => `It reached you because you asked for it on ${store}'s store.`,
  recoverStop: (store: string, link: string) => `Stop these reminders from ${store}: ${link}`,
  /** The email for a reminder asked for on a product's page (lib/checkout-ask.ts). */
  pageAskSubject: (title: string) => `A reminder about ${title}`,
  pageAskLead: (title: string, store: string) => `You asked ${store} to remind you about ${title}.`,
  pageAskOnly: (why: string) => `This is the only reminder about it. ${why}`,
  /** A call whose checkout was left (lib/checkout-recovery.ts): the time was not kept, so the buyer picks one again. */
  callSubject: (title: string) => `Your time for ${title} is not booked yet`,
  callLead: (title: string, when: string, store: string) =>
    `You picked ${when} for ${title} with ${store} and did not finish paying, so nothing was charged and the time was not kept for you.`,
  callHere: "To book it, pick a time here:",

  // ---- A license key ---------------------------------------------------------------------------
  keyLabel: "Your license key",
  keyLabelFor: (title: string) => `Your license key for ${title}`,
  keyReady: (title: string) => `Your license key for ${title} is ready:`,
  keyThanks: (link: string) => `Thank you for waiting. It is also on your list of purchases: ${link}`,
  keyQuestions: (store: string) => `Questions? Reply to this email and it reaches ${store}.`,
  copy: "Copy",
  keyYours: "It is yours alone: nobody else is given this key. It is also in your confirmation email and on your list of purchases.",
  keyRevoked: (store: string) =>
    `${store} has marked this key as no longer valid. If you think that is a mistake, reply to your order confirmation email and it reaches them.`,
  keyWaiting: (store: string) =>
    `Your payment went through just as ${store}'s keys ran out, so yours is not ready yet. They have been told, and it is emailed to you the moment they add more. It also appears here and on your list of purchases.`,
  keyFailed: "Your key could not be shown just now. Refresh the page in a moment; it is kept for you.",

  // ---- After a PayPal purchase: its email ------------------------------------------------------
  ppSubject: (title: string) => `Your purchase: ${title}`,
  ppThanks: (store: string) => `Thank you for buying from ${store}. This is your confirmation.`,
  ppWhat: (title: string) => `What you bought: ${title}`,
  ppPaid: (amount: string) => `Paid with PayPal: ${amount}`,
  ppTransaction: (id: string) => `PayPal transaction: ${id}`,
  ppPaidTo: (store: string) => `Paid to ${store}'s own PayPal account. Questions go to ${store} by replying to this email.`,
};

export type GivingWords = typeof en;

// =====================================================================================
// Spanish, for any Spanish-speaking buyer: "tú".

const esSentBy = (store: string) => `Enviado por Marktmorgen en nombre de ${store}.`;

const es: GivingWords = {
  checkInbox: "Revisa tu bandeja de entrada",
  linkExpired: "Este enlace ha caducado",
  emailTitle: "Eso no parece una dirección de email",
  openIt: "Abrirlo",
  openHere: "Ábrelo aquí:",
  sentBy: esSentBy,
  sentWith: "Enviado con Marktmorgen.",
  orderRef: (reference) => `Referencia del pedido: ${reference}`,
  paidLine: (amount) => `Pagado: ${amount}`,
  thanksReceipt: (store) => `Gracias por comprar en ${store}. Este es tu recibo.`,
  chargedBy: (store) => `Cobrado por ${store} en su propia cuenta de Stripe. Si tienes preguntas, responde a este email y le llegarán a ${store}.`,
  link24: (orders) => `Ese enlace funciona durante 24 horas. Después, ve a ${orders}, escribe esta dirección y te llegará uno nuevo enseguida.`,
  ignoreThis: "Si no lo pediste, ignora este email.",
  sentByNothing: (store) => `${esSentBy(store)} No se te ha cobrado nada.`,

  freeMetaTitle: "Tu copia gratis",
  freeNotices: {
    email: {
      title: "Eso no parece una dirección de email",
      body: "Revísala y vuelve a intentarlo. La copia se envía a la dirección que escribas, así que tiene que ser una que puedas abrir.",
    },
    limited: {
      title: "Demasiadas solicitudes por ahora",
      body: "Para que nadie use este formulario para inundar la bandeja de entrada de otra persona, acepta un número limitado de solicitudes por hora. Vuelve a intentarlo dentro de una hora.",
    },
    unavailable: {
      title: "Esto no está disponible ahora mismo",
      body: "No se ha enviado ni guardado nada. Puede que la tienda todavía lo esté preparando.",
    },
    error: {
      title: "No hemos podido enviarlo ahora mismo",
      body: "No se ha guardado nada. Vuelve a intentarlo en un momento.",
    },
  },
  alsoFrom: (store) => `También de ${store}`,
  freeFrom: (store) => `De ${store}. Pulsa el botón y es tuyo.`,
  downloadIt: "Descargarlo",
  keptOn: (host, store) => `${store} lo guarda en ${host}, no aquí, así que el botón te lleva allí.`,
  freeLinkWorks: "El enlace de tu email funciona durante 7 días, así que puedes volver a usarlo desde otro dispositivo.",
  noLongerFree: "Esto ya no es gratis",
  changedSince: (store) => `${store} lo ha cambiado desde que se envió el email, así que ya no se entrega desde este enlace.`,
  freeLinkDays: "El enlace de una copia gratis funciona durante 7 días. Pide uno nuevo a la tienda: solo tarda unos segundos.",
  sent: "Enviado",
  emailedLinkTo: (title) => `Te hemos enviado por email un enlace a ${title}.`,
  emailedLink: "Te hemos enviado un enlace por email.",
  comesFrom: (store) => `Llega de ${store} a través de Marktmorgen. Si no está, mira en spam.`,
  joinsOnUse: (store) => `Tu dirección solo entra en la lista de ${store} cuando usas ese enlace, así que una dirección mal escrita nunca acaba en ella.`,
  freeGone: "Esto ya no se ofrece gratis.",
  freeNothing: "Todavía no hay nada aquí. Pregunta a la tienda.",

  freeSubject: (title) => `Tu copia de ${title}`,
  freeAsked: (store, title) => `Le pediste ${title} a ${store}. Aquí lo tienes:`,
  freeOpen: "Abre el enlace y pulsa el botón. Funciona durante 7 días.",
  freeConsented: (store) => `También dijiste que ${store} puede enviarte emails. Puedes darte de baja desde cualquiera de ellos.`,
  freeNotConsented: (store) =>
    `No marcaste la casilla para recibir noticias de ${store}, así que tu dirección le llega indicando que pediste solo esto, y nada más.`,
  freeIgnore: "Si no lo pediste, ignora este email. No pasa nada a menos que se use el enlace.",
  freeContact: (store, link) => `Para escribir a ${store}, usa el formulario de contacto de su página: ${link}`,
  freeSentBy: (store) =>
    `Enviado por Marktmorgen en nombre de ${store}. Marktmorgen no usa tu dirección para nada más, y las respuestas a este email no llegan a ${store}.`,

  waitlist: "Lista de espera",
  waitNotices: {
    email: {
      title: "Eso no parece una dirección de email",
      body: "Revísala y vuelve a intentarlo. La confirmación se envía a la dirección que escribas, así que tiene que ser una que puedas abrir.",
    },
    limited: {
      title: "Demasiadas inscripciones por ahora",
      body: "Para que nadie use este formulario para inundar la bandeja de entrada de otra persona, acepta un número limitado por hora. Vuelve a intentarlo dentro de una hora.",
    },
    full: {
      title: "Esta lista de espera está llena",
      body: "Ya tiene a todas las personas que puede admitir. No se ha guardado nada.",
    },
    closed: {
      title: "Esto ya no está marcado como próximamente",
      body: "Puede que ya esté a la venta. No se ha guardado nada.",
    },
    error: {
      title: "No hemos podido enviarlo ahora mismo",
      body: "Vuelve a intentarlo en un momento.",
    },
    expired: {
      title: "Este enlace ha caducado",
      body: "Un enlace de confirmación funciona durante 7 días. Vuelve a apuntarte desde la página del producto; solo tarda unos segundos.",
    },
  },
  confirmSpotTitle: "Confirma tu plaza",
  confirmSpotBody: (store, title) =>
    `Pulsa el botón y ${store} te enviará un único email cuando ${title ? `${title} salga` : "salga"} a la venta.`,
  confirmSpotButton: "Confirmar mi plaza",
  removeTitle: "¿Quitar tu dirección?",
  notTold: (title) => `No se te avisará cuando ${title ? `${title} salga` : "salga"} a la venta.`,
  removeButton: "Quitar mi dirección",
  notOnListTitle: "Tu dirección no está en esta lista de espera",
  notOnListBody: "Ya se quitó, o la lista de espera ya cumplió su función y sus direcciones se han borrado.",
  almostThere: "Ya casi está",
  waitSentBody: (title, store) =>
    `Te hemos enviado por email un botón para confirmar tu plaza en la lista de espera${title ? ` de ${title}` : ""}. Llega de ${store} a través de Marktmorgen. Si no está, mira en spam.`,
  waitSentNote: "Tu plaza cuenta cuando lo pulsas, así que a una dirección mal escrita nunca se le avisa de nada.",
  onTheList: "Estás en la lista",
  tellWhenOut: (title) => (title ? `Te avisaremos cuando salga ${title}` : "Te avisaremos cuando salga"),
  oneEmailDay: "Un email, el día que salga a la venta, con su enlace. Es todo lo que envía esta lista de espera.",
  removedTitle: "Tu dirección se ha quitado",

  waitSubject: (title) => `Confirma tu plaza: ${title}`,
  waitAsked: (store, title) => `Pediste a ${store} que te avisara cuando salga ${title}.`,
  waitOpen: "Abre este enlace y pulsa el botón para confirmar que fuiste tú:",
  waitWorks: "Funciona durante 7 días. Cuando salga, recibirás un email con su enlace, y es el único email que envía esta lista de espera.",
  waitConsented: (store) =>
    `También dijiste que ${store} puede enviarte otros emails; cuando confirmes, estarás en su lista y podrás darte de baja desde cualquiera de ellos.`,
  waitNotConsented: (store) => `No marcaste la casilla para recibir otras noticias de ${store}, así que no las recibirás.`,
  waitIgnore: "Si no lo pediste, ignora este email. No pasa nada a menos que se pulse el botón.",
  waitLeave: (link) => `Para quitar tu dirección de esta lista de espera en cualquier momento: ${link}`,
  launchSubject: (title) => `${title} ya está disponible`,
  launchLead: (store, title, price) =>
    `Pediste a ${store} que te avisara cuando saliera ${title}. Ya está disponible${price ? `, por ${price}` : ""}:`,
  launchWhy: (title) =>
    `Recibes esto porque te apuntaste a la lista de espera de ${title} y confirmaste tu dirección. Es el único email que envía la lista de espera.`,
  launchLabel: "Quitar mi dirección",
  launchAfter: "de esta lista de espera.",
  launchLine: (link) => `Quitar mi dirección: ${link}`,

  groupMetaTitle: "Ocupa tu plaza",
  groupNotices: {
    sent: {
      title: "Revisa tu bandeja de entrada",
      body: "Hemos enviado un enlace a la dirección que escribiste. Ábrelo y la plaza es tuya. Funciona durante 24 horas; si no llega nada en unos minutos, mira en spam y luego vuelve a escribir la dirección abajo.",
    },
    email: {
      title: "Eso no parece una dirección de email",
      body: "Revísala y vuelve a intentarlo. El enlace se envía a la dirección que escribas, así que tiene que ser una que puedas abrir.",
    },
    full: {
      title: "Todas las plazas están ocupadas",
      body: "Quien compró esto pagó por un número fijo de personas, y cada plaza ya está en la dirección de alguien. Pregúntale si puede comprar una más.",
    },
    slow: {
      title: "Se han pedido demasiados enlaces ahora mismo",
      body: "Para que nadie use esta página para llenar la bandeja de entrada de otra persona, envía un número limitado al día. Vuelve a intentarlo más tarde; no se ha ocupado ni perdido ninguna plaza.",
    },
    unavailable: {
      title: "No hemos podido enviarlo ahora mismo",
      body: "No se ha ocupado ni perdido ninguna plaza. Vuelve a intentarlo en un momento.",
    },
    opening: {
      title: "No hemos podido terminar de abrir tu plaza",
      body: "Vuelve a abrir el enlace en un momento. Si ya era tuya, no cambia nada.",
    },
    expired: {
      title: "Ese enlace ha caducado",
      body: "Funciona durante 24 horas. Vuelve a escribir tu dirección abajo y te llegará uno nuevo enseguida.",
    },
    resting: {
      title: "Esta tienda está en pausa por ahora",
      body: "No se ha ocupado ni perdido ninguna plaza. La tienda vuelve a repartir plazas cuando empieza su próximo mes, o antes: vuelve entonces y escribe tu dirección abajo para recibir un enlace nuevo.",
    },
  },
  groupRefundedTitle: "Esta compra se reembolsó",
  groupRefundedBody: (title, people) =>
    `${title} se compró para ${people} personas y el pago se reembolsó después por completo, así que sus plazas están cerradas.`,
  alreadyYours: "Ya es tuyo",
  done: "Hecho",
  hasItTitle: "Esta dirección ya lo tiene",
  placeYours: "La plaza es tuya",
  placeHas: (title, email) => `${title} ya estaba en ${email}, así que no se ha usado ninguna plaza.`,
  placeTaken: (title, email) => `${title} ya está en ${email}, como si lo hubieras comprado. No se te ha cobrado nada.`,
  laterOrders: (address) => `Más adelante, ve a ${address}/orders y escribe esta dirección: te llegará enseguida un enlace a todo lo que tiene.`,
  paidForYou: "Pagado para ti",
  boughtForPeople: (store, people, open) => `Alguien compró esto en ${store} para ${people} personas y compartió este enlace. ${open}`,
  placesLeft: (people, left) =>
    left === 0
      ? `Las ${people} plazas están ocupadas.`
      : left === 1
        ? `Queda ${left} plaza libre de ${people}.`
        : `Quedan ${left} plazas libres de ${people}.`,
  sendPlaceLink: "Envíame el enlace a mi plaza",
  placeNote: (title) =>
    `Se envía un enlace a esa dirección, y al abrirlo se ocupa una plaza y ${title} queda en ella. No se te cobra nada. Tu dirección se usa para entregártelo y para volver a abrirlo más adelante, y no se añade a ninguna lista.`,
  alreadyTook: "¿Ya ocupaste la tuya?",
  openAgain: "Vuelve a abrirlo",
  linkToPass: "El enlace para compartir",
  copyLink: "Copiar el enlace",
  copied: "Copiado",

  people: (people) => `${people} ${plural(people, "persona", "personas")}`,
  groupReceiptSubject: (people, title) => `Tus ${people} plazas: ${title}`,
  resentReceipt: (store) => `${store} nos pidió que te lo enviáramos de nuevo. Es una copia de tu recibo.`,
  forWho: (title, who) => `${title}, para ${who}`,
  passLinkOn: "Comparte este enlace con las personas para las que es:",
  eachPerson: (title, people) =>
    `Cada persona lo abre y escribe su propia dirección de email. Recibe un enlace en su bandeja de entrada, y al abrirlo ${title} queda en esa dirección, como si lo hubiera comprado. Tú ocupas una plaza de la misma forma: pagaste por ${people}, y solo eres una de ellas si ocupas una.`,
  keepEmail:
    "Guarda este email: el enlace es la forma de repartir las plazas, y la página que abre muestra cuántas quedan. Un reembolso completo retira todas las plazas.",
  placeAgainSubject: (title) => `Tu plaza en ${title}`,
  placeAgainLead: (title, store) => `Ya ocupaste tu plaza en ${title} de ${store}. Ábrelo aquí:`,
  takePlaceSubject: (title) => `Ocupa tu plaza en ${title}`,
  takePlaceLead: (title, store, who) =>
    `Alguien compró ${title} en ${store} para ${who} y compartió el enlace. Esta dirección se escribió en él para ocupar una de las plazas.`,
  openToTake: "Abre este enlace para ocuparla:",
  takePlaceNote: (title) =>
    `Así ${title} queda en esta dirección de email, como si lo hubieras comprado. No se te cobra nada. El enlace funciona durante 24 horas, y la plaza es tuya en cuanto lo abras, mientras quede alguna libre.`,
  ignoreUnlessOpened: "Si no lo pediste, ignora este email: no pasa nada a menos que se abra el enlace.",

  someone: "Alguien",
  giftSubject: (who, title) => `${who} te ha enviado un regalo: ${title}`,
  giftLead: (who, title, store) => `${who} te ha comprado ${title} en ${store}.`,
  theirMessage: "Su mensaje:",
  giftYours: "Es tuyo, en esta dirección de email. Ábrelo aquí:",
  giftReceiptSubject: (title) => `Tu regalo va en camino: ${title}`,
  aGift: (title) => `Un regalo: ${title}`,
  giftFor: (email) => `Para: ${email}`,
  weEmailed: (email, withMessage) =>
    `Acabamos de enviar un email a ${email} con tu nombre${withMessage ? ", tu mensaje" : ""} y un enlace para abrirlo. Es suyo, en su dirección; tú no recibes una copia.`,

  reviewMetaTitle: "Tu reseña",
  orderRefundedTitle: "Este pedido se reembolsó",
  orderRefundedBody: (store) =>
    `Un pedido que ${store} reembolsó por completo no se puede reseñar. Si escribiste una reseña desde él, sus estrellas ya no cuentan.`,
  expiredRecover: "Vuelve a pedir tus compras: suele llegar un enlace nuevo por email en menos de un minuto, y desde ahí puedes dejar tu reseña.",
  expiredReply: (store) => `Responde a la confirmación de pedido que ${store} te envió por email, y le llegará.`,
  wrongTitle: "Algo ha fallado por nuestra parte",
  nothingChanged: "No se ha cambiado nada. Vuelve a intentarlo en un momento.",
  tooManyTries: "Demasiados intentos",
  tooManyBody: "Esta página se abrió muchas veces en pocos minutos. Espera un poco y vuelve a abrir tu enlace.",
  cannotReviewTitle: "Este pedido no se puede reseñar aquí",
  cannotReviewBody: "Abre el enlace de tu email o de tu lista de compras.",
  getMyPurchases: "Recuperar mis compras",
  reviewOne: (title) => `Escribe una reseña de ${title}`,
  reviewAll: "Escribe una reseña de lo que compraste",
  boughtFromOn: (store, date) =>
    `Comprado en ${store}${date ? ` el ${date}` : ""}. Una reseña sincera es lo que ayuda al próximo comprador, y a ${store}.`,

  reviewNotices: {
    saved: "Gracias. Tu reseña ya está en la página.",
    updated: "Tu reseña se ha actualizado.",
    deleted: "Tu reseña se ha eliminado. Sus estrellas ya no cuentan en la media.",
    rating: "Elige de una a cinco estrellas.",
    refunded: "Este pedido se reembolsó, así que no se puede reseñar.",
    expired: "Este enlace ha caducado. Vuelve a pedir tus compras desde la tienda y deja tu reseña desde ahí.",
    no: "Este pedido no se puede reseñar aquí.",
    full: "Este producto no admite más reseñas.",
    noroom: "Esta tienda no tiene espacio para más reseñas ahora mismo, así que la tuya no se guardó. Inténtalo más tarde.",
    slow: "Han sido muchos intentos en poco tiempo. Espera unos minutos y vuelve a enviarla.",
    busy: "Alguien más estaba guardando en ese mismo momento. Vuelve a enviarla.",
    error: "Algo ha fallado por nuestra parte. No se ha cambiado nada. Vuelve a intentarlo en un momento.",
    photo: "No se pudo añadir esa foto. Prueba con otra, en JPEG o directamente de tu cámara.",
    photoPaused: "Su reseña se guardó, pero la foto nueva no se añadió: esta tienda no acepta fotos nuevas en este momento.",
    photoLimit: "Su reseña se guardó, pero la foto nueva no se añadió: una reseña puede recibir 3 fotos nuevas en total, y la suya ya ha recibido 3.",
    photoFailed: "Su reseña se guardó, pero la foto nueva no se añadió por un problema de nuestra parte. Ese intento cuenta igualmente como 1 de las 3 fotos nuevas que puede recibir una reseña.",
    confirmDelete: "Aquí no hay ninguna reseña tuya que eliminar.",
    kept: "Tu reseña no se ha eliminado. No se ha cambiado nada.",
  },
  yourRating: (title) => `Tu valoración de ${title}`,
  whatYouThink: "Qué te parece (opcional)",
  upTo: (written) => `Hasta ${written} caracteres.`,
  nameToShow: "Nombre que se mostrará (opcional)",
  updateReview: "Actualizar mi reseña",
  postReview: "Publicar mi reseña",
  reviewUnread: (title) => `No pudimos cargar tu reseña de ${title} en este momento. Actualiza esta página en un momento para verla o cambiarla.`,
  reviewPublic: (store) =>
    `Tu reseña es pública en la página de ${store}, marcada como compra verificada. Tu dirección de email nunca se muestra. ${store} puede responder y ocultarla, pero no puede cambiarla.`,
  deleteReview: "Eliminar mi reseña",
  deleteReviewAsk: (title) => `¿Eliminar tu reseña de ${title}?`,
  deleteReviewWhat: (stars, hasWords, hasPhoto, store) =>
    `Esto elimina ${andList([`tu valoración de ${stars} ${plural(stars, "estrella", "estrellas")}`, ...(hasWords ? ["tus palabras"] : []), ...(hasPhoto ? ["tu foto"] : [])], "y")} de la página de ${store}. No se puede recuperar.`,
  deleteReviewYes: "Sí, eliminar mi reseña",
  deleteReviewKeep: "Conservar mi reseña",
  reviewPhoto: "Añade una foto (opcional)",
  reviewPhotoHint: "Una foto de lo que hiciste con él o de cómo lo usas. Se muestra con tu reseña.",
  reviewPhotoRemove: "Quitar mi foto",
  reviewPhotoYours: "Tu foto",
  reviewPhotoAlt: (name) => `Foto de ${name}`,

  askSubject: (title) => `¿Qué tal ${title}?`,
  listAnd: (list, last) => `${list} y ${last}`,
  askLead: (what, store, date) =>
    `Compraste ${what} en ${store} el ${date}. Si tienes un minuto, a ${store} le gustaría saber qué te parece, para bien o para mal.`,
  askHow: "Dale de una a cinco estrellas y unas palabras aquí:",
  askElsewhere: (store, site) => `Si además quieres, puedes reseñar ${store} en ${site}. Se lo pedimos igual a todos y es totalmente opcional:`,
  askShows: (store) =>
    `Tu reseña aparece en la página de ${store} marcada como compra verificada, con el nombre que elijas. Tu dirección de email nunca se muestra. El mismo enlace te permite cambiarla o eliminarla durante 60 días.`,
  askOnly: "Este es el único email sobre la reseña de este pedido.",
  askOneMore: (days) => `Si dentro de ${days} días aún no lo has reseñado, recibirás un recordatorio, y será el último email sobre esto.`,
  againSubject: (title) => `Un recordatorio: ¿qué tal ${title}?`,
  againLead: (what, store, date) =>
    `Hace unos días, ${store} te preguntó qué te parece ${what}, comprado el ${date}. Si tienes un minuto, unas palabras son bienvenidas, para bien o para mal.`,
  againOnly: "Este es el último email sobre la reseña de este pedido.",
  askWhy: (store) => `Recibes esto porque compraste en ${store}.`,
  askStopLabel: "Dejar de recibir solicitudes de reseña",
  askStopAfter: (store) => `de ${store} con un clic.`,
  askStopLine: (link) => `Dejar de recibir solicitudes de reseña: ${link}`,

  recoverSubject: (title) => `Dejaste ${title} sin terminar de pagar`,
  recoverLead: (title, store) => `Empezaste a comprar ${title} en ${store} y no terminaste, así que no se ha cobrado nada.`,
  recoverHere: "Si todavía lo quieres, está aquí:",
  recoverPrice: (price) => `El precio: ${price}. El pago se abre con el precio de hoy.`,
  youChoosePrice: (price) => `lo eliges tú, desde ${price}`,
  recoverOnly: (why) => `Este es el único recordatorio sobre ese pago. ${why}`,
  recoverWhyCheckout: (store) => `Te ha llegado porque aceptaste, en la página de pago, recibir noticias de ${store}.`,
  recoverWhyAsked: (store) => `Te ha llegado porque lo pediste en la tienda de ${store}.`,
  recoverStop: (store, link) => `Dejar de recibir estos recordatorios de ${store}: ${link}`,
  /** The email for a reminder asked for on a product's page (lib/checkout-ask.ts). */
  pageAskSubject: (title) => `Un recordatorio sobre ${title}`,
  pageAskLead: (title, store) => `Pediste a ${store} que te recordara ${title}.`,
  pageAskOnly: (why) => `Este es el único recordatorio. ${why}`,
  callSubject: (title) => `Tu hora para ${title} aún no está reservada`,
  callLead: (title, when, store) => `Elegiste ${when} para ${title} con ${store} y no terminaste de pagar, así que no se ha cobrado nada y la hora no se ha guardado.`,
  callHere: "Para reservarla, elige una hora aquí:",

  keyLabel: "Tu clave de licencia",
  keyLabelFor: (title) => `Tu clave de licencia de ${title}`,
  keyReady: (title) => `Tu clave de licencia de ${title} está lista:`,
  keyThanks: (link) => `Gracias por esperar. También está en tu lista de compras: ${link}`,
  keyQuestions: (store) => `¿Tienes preguntas? Responde a este email y le llegará a ${store}.`,
  copy: "Copiar",
  keyYours: "Es solo tuya: nadie más recibe esta clave. También está en tu email de confirmación y en tu lista de compras.",
  keyRevoked: (store) =>
    `${store} ha marcado esta clave como ya no válida. Si crees que es un error, responde a tu email de confirmación del pedido y le llegará.`,
  keyWaiting: (store) =>
    `Tu pago se completó justo cuando a ${store} se le acabaron las claves, así que la tuya todavía no está lista. Ya se le ha avisado, y se te enviará por email en cuanto añada más. También aparece aquí y en tu lista de compras.`,
  keyFailed: "No se ha podido mostrar tu clave ahora mismo. Actualiza la página en un momento; está guardada para ti.",

  ppSubject: (title) => `Tu compra: ${title}`,
  ppThanks: (store) => `Gracias por comprar en ${store}. Esta es tu confirmación.`,
  ppWhat: (title) => `Lo que compraste: ${title}`,
  ppPaid: (amount) => `Pagado con PayPal: ${amount}`,
  ppTransaction: (id) => `Transacción de PayPal: ${id}`,
  ppPaidTo: (store) => `Pagado a la propia cuenta de PayPal de ${store}. Si tienes preguntas, responde a este email y le llegarán a ${store}.`,
};

// =====================================================================================
// French: "vous", a non-breaking space before ":", "?", "!", ";", singular for 0 and 1.

const frSentBy = (store: string) => `Envoyé par Marktmorgen pour le compte de ${store}.`;

const fr: GivingWords = {
  checkInbox: "Consultez votre boîte de réception",
  linkExpired: "Ce lien a expiré",
  emailTitle: "Cela ne ressemble pas à une adresse e-mail",
  openIt: "L'ouvrir",
  openHere: `Ouvrez-le ici${S}:`,
  sentBy: frSentBy,
  sentWith: "Envoyé avec Marktmorgen.",
  orderRef: (reference) => `Référence de commande${S}: ${reference}`,
  paidLine: (amount) => `Payé${S}: ${amount}`,
  thanksReceipt: (store) => `Merci pour votre achat chez ${store}. Voici votre reçu.`,
  chargedBy: (store) => `Débité par ${store} sur son propre compte Stripe. Pour toute question, répondez à cet e-mail, elle parviendra à ${store}.`,
  link24: (orders) => `Ce lien fonctionne pendant 24 heures. Ensuite, rendez-vous sur ${orders}, saisissez cette adresse, et un nouveau lien arrive aussitôt.`,
  ignoreThis: "Si vous ne l'avez pas demandé, ignorez cet e-mail.",
  sentByNothing: (store) => `${frSentBy(store)} Rien ne vous a été débité.`,

  freeMetaTitle: "Votre exemplaire gratuit",
  freeNotices: {
    email: {
      title: "Cela ne ressemble pas à une adresse e-mail",
      body: "Vérifiez-la et réessayez. L'exemplaire part à l'adresse que vous saisissez, il faut donc que vous puissiez la consulter.",
    },
    limited: {
      title: "Trop de demandes pour le moment",
      body: "Pour éviter que ce formulaire serve à inonder la boîte de réception de quelqu'un, il accepte un nombre limité de demandes par heure. Réessayez dans une heure.",
    },
    unavailable: {
      title: "Ce n'est pas disponible pour le moment",
      body: "Rien n'a été envoyé ni conservé. La boutique est peut-être encore en train de le préparer.",
    },
    error: {
      title: "Nous n'avons pas pu l'envoyer pour le moment",
      body: "Rien n'a été conservé. Réessayez dans un instant.",
    },
  },
  alsoFrom: (store) => `Également chez ${store}`,
  freeFrom: (store) => `De ${store}. Appuyez sur le bouton, et c'est à vous.`,
  downloadIt: "Le télécharger",
  keptOn: (host, store) => `${store} l'héberge sur ${host}, pas ici, donc le bouton vous y emmène.`,
  freeLinkWorks: "Le lien de votre e-mail fonctionne pendant 7 jours, vous pouvez donc y revenir depuis un autre appareil.",
  noLongerFree: "Ce n'est plus gratuit",
  changedSince: (store) => `${store} l'a modifié depuis l'envoi de l'e-mail, il n'est donc plus remis par ce lien.`,
  freeLinkDays: "Le lien d'un exemplaire gratuit fonctionne pendant 7 jours. Demandez-en un nouveau à la boutique — cela ne prend que quelques secondes.",
  sent: "Envoyé",
  emailedLinkTo: (title) => `Nous vous avons envoyé par e-mail un lien vers ${title}.`,
  emailedLink: "Nous vous avons envoyé un lien par e-mail.",
  comesFrom: (store) => `Il vient de ${store} via Marktmorgen. S'il n'y est pas, regardez dans les spams.`,
  joinsOnUse: (store) =>
    `Votre adresse ne rejoint la liste de ${store} qu'une fois ce lien utilisé, une adresse mal saisie n'y figure donc jamais.`,
  freeGone: "Ce n'est plus proposé gratuitement.",
  freeNothing: "Il n'y a encore rien ici. Renseignez-vous auprès de la boutique.",

  freeSubject: (title) => `Votre exemplaire de ${title}`,
  freeAsked: (store, title) => `Vous avez demandé ${title} à ${store}. Le voici${S}:`,
  freeOpen: "Ouvrez le lien et appuyez sur le bouton. Il fonctionne pendant 7 jours.",
  freeConsented: (store) => `Vous avez aussi accepté que ${store} vous envoie des e-mails. Vous pouvez vous désabonner depuis n'importe lequel d'entre eux.`,
  freeNotConsented: (store) =>
    `Vous n'avez pas coché la case pour recevoir des nouvelles de ${store}, votre adresse lui parvient donc avec la mention que vous avez demandé uniquement ceci, et rien de plus.`,
  freeIgnore: "Si vous ne l'avez pas demandé, ignorez cet e-mail. Rien ne se passe tant que le lien n'est pas utilisé.",
  freeContact: (store, link) => `Pour écrire à ${store}, utilisez le formulaire de contact de sa page : ${link}`,
  freeSentBy: (store) =>
    `Envoyé par Marktmorgen pour le compte de ${store}. Marktmorgen n'utilise votre adresse pour rien d'autre, et les réponses à cet e-mail ne parviennent pas à ${store}.`,

  waitlist: "Liste d'attente",
  waitNotices: {
    email: {
      title: "Cela ne ressemble pas à une adresse e-mail",
      body: "Vérifiez-la et réessayez. La confirmation part à l'adresse que vous saisissez, il faut donc que vous puissiez la consulter.",
    },
    limited: {
      title: "Trop d'inscriptions pour le moment",
      body: "Pour éviter que ce formulaire serve à inonder la boîte de réception de quelqu'un, il accepte un nombre limité d'inscriptions par heure. Réessayez dans une heure.",
    },
    full: {
      title: "Cette liste d'attente est complète",
      body: "Elle contient déjà autant de personnes que possible. Rien n'a été conservé.",
    },
    closed: {
      title: "Ce produit n'est plus annoncé comme bientôt disponible",
      body: "Il est peut-être déjà en vente. Rien n'a été conservé.",
    },
    error: {
      title: "Nous n'avons pas pu l'envoyer pour le moment",
      body: "Réessayez dans un instant.",
    },
    expired: {
      title: "Ce lien a expiré",
      body: `Un lien de confirmation fonctionne pendant 7 jours. Inscrivez-vous de nouveau depuis la page du produit${S}; cela ne prend que quelques secondes.`,
    },
  },
  confirmSpotTitle: "Confirmez votre place",
  confirmSpotBody: (store, title) => `Appuyez sur le bouton et ${store} vous enverra un seul e-mail, quand ${title || "il"} sera en vente.`,
  confirmSpotButton: "Confirmer ma place",
  removeTitle: `Retirer votre adresse${S}?`,
  notTold: (title) => `On ne vous préviendra pas quand ${title || "il"} sera en vente.`,
  removeButton: "Retirer mon adresse",
  notOnListTitle: "Votre adresse ne figure pas sur cette liste d'attente",
  notOnListBody: "Elle a déjà été retirée, ou la liste d'attente a rempli son rôle et ses adresses ont été supprimées.",
  almostThere: "Presque terminé",
  waitSentBody: (title, store) =>
    `Nous vous avons envoyé par e-mail un bouton pour confirmer votre place sur la liste d'attente${title ? ` de ${title}` : ""}. Il vient de ${store} via Marktmorgen. S'il n'y est pas, regardez dans les spams.`,
  waitSentNote: "Votre place compte dès que vous appuyez dessus, une adresse mal saisie ne reçoit donc jamais rien.",
  onTheList: "Vous êtes sur la liste",
  tellWhenOut: (title) => `Nous vous préviendrons à la sortie${title ? ` de ${title}` : ""}`,
  oneEmailDay: "Un seul e-mail, le jour de la mise en vente, avec son lien. C'est tout ce que cette liste d'attente envoie.",
  removedTitle: "Votre adresse a été retirée",

  waitSubject: (title) => `Confirmez votre place${S}: ${title}`,
  waitAsked: (store, title) => `Vous avez demandé à ${store} de vous prévenir à la sortie de ${title}.`,
  waitOpen: `Ouvrez ce lien et appuyez sur le bouton pour confirmer que c'était bien vous${S}:`,
  waitWorks: "Il fonctionne pendant 7 jours. À sa sortie, vous recevrez un e-mail avec son lien, et c'est le seul e-mail que cette liste d'attente envoie.",
  waitConsented: (store) =>
    `Vous avez aussi accepté que ${store} vous envoie d'autres e-mails${S}; une fois la confirmation faite, vous serez sur sa liste et pourrez vous désabonner depuis n'importe lequel d'entre eux.`,
  waitNotConsented: (store) => `Vous n'avez pas coché la case pour recevoir d'autres nouvelles de ${store}, vous n'en recevrez donc pas.`,
  waitIgnore: "Si vous ne l'avez pas demandé, ignorez cet e-mail. Rien ne se passe tant que personne n'appuie sur le bouton.",
  waitLeave: (link) => `Pour retirer votre adresse de cette liste d'attente à tout moment${S}: ${link}`,
  launchSubject: (title) => `${title} est disponible`,
  launchLead: (store, title, price) =>
    `Vous avez demandé à ${store} de vous prévenir à la sortie de ${title}. C'est disponible dès maintenant${price ? `, à ${price}` : ""}${S}:`,
  launchWhy: (title) =>
    `Vous recevez ceci parce que vous avez rejoint la liste d'attente de ${title} et confirmé votre adresse. C'est le seul e-mail que la liste d'attente envoie.`,
  launchLabel: "Retirer mon adresse",
  launchAfter: "de cette liste d'attente.",
  launchLine: (link) => `Retirer mon adresse${S}: ${link}`,

  groupMetaTitle: "Prenez votre place",
  groupNotices: {
    sent: {
      title: "Consultez votre boîte de réception",
      body: `Nous avons envoyé un lien à l'adresse saisie. Ouvrez-le et la place est à vous. Il fonctionne pendant 24 heures${S}; si rien n'arrive d'ici quelques minutes, regardez dans les spams, puis saisissez de nouveau l'adresse ci-dessous.`,
    },
    email: {
      title: "Cela ne ressemble pas à une adresse e-mail",
      body: "Vérifiez-la et réessayez. Le lien part à l'adresse que vous saisissez, il faut donc que vous puissiez la consulter.",
    },
    full: {
      title: "Toutes les places ont été prises",
      body: "La personne qui a acheté ceci a payé pour un nombre précis de personnes, et chaque place est désormais liée à l'adresse de quelqu'un. Demandez-lui si elle peut en acheter une de plus.",
    },
    slow: {
      title: "Trop de liens demandés pour le moment",
      body: `Pour éviter que cette page serve à remplir la boîte de réception de quelqu'un, elle envoie un nombre limité de liens par jour. Réessayez plus tard${S}; aucune place n'a été prise ni perdue.`,
    },
    unavailable: {
      title: "Nous n'avons pas pu l'envoyer pour le moment",
      body: "Aucune place n'a été prise ni perdue. Réessayez dans un instant.",
    },
    opening: {
      title: "Nous n'avons pas pu finir d'ouvrir votre place",
      body: "Rouvrez le lien dans un instant. Si elle était déjà à vous, rien ne change.",
    },
    expired: {
      title: "Ce lien a expiré",
      body: "Il fonctionne pendant 24 heures. Saisissez de nouveau votre adresse ci-dessous et un nouveau lien arrive aussitôt.",
    },
    resting: {
      title: "Cette boutique est en pause pour le moment",
      body: `Aucune place n'a été prise ni perdue. La boutique distribue de nouveau des places au début de son prochain mois, ou avant${S}: revenez alors et saisissez votre adresse ci-dessous pour recevoir un nouveau lien.`,
    },
  },
  groupRefundedTitle: "Cet achat a été remboursé",
  groupRefundedBody: (title, people) =>
    `${title} a été acheté pour ${people} personnes, puis le paiement a été entièrement remboursé, ses places sont donc fermées.`,
  alreadyYours: "Déjà à vous",
  done: "C'est fait",
  hasItTitle: "Cette adresse l'a déjà",
  placeYours: "La place est à vous",
  placeHas: (title, email) => `${title} était déjà lié à ${email}, aucune place n'a donc été utilisée.`,
  placeTaken: (title, email) => `${title} est désormais lié à ${email}, comme si vous l'aviez acheté. Rien ne vous a été débité.`,
  laterOrders: (address) =>
    `Plus tard, rendez-vous sur ${address}/orders et saisissez cette adresse${S}: un lien vers tout ce qui y est lié arrive aussitôt.`,
  paidForYou: "Payé pour vous",
  boughtForPeople: (store, people, open) => `Quelqu'un a acheté ceci chez ${store} pour ${people} personnes et a transmis ce lien. ${open}`,
  placesLeft: (people, left) =>
    left === 0
      ? `Les ${people} places ont toutes été prises.`
      : `${left} ${pluralFr(left, "place", "places")} sur ${people} ${pluralFr(left, "est encore libre", "sont encore libres")}.`,
  sendPlaceLink: "M'envoyer le lien vers ma place",
  placeNote: (title) =>
    `Un lien part à cette adresse, et l'ouvrir prend une place et y ajoute ${title}. Rien ne vous est débité. Votre adresse sert à vous le remettre et à le rouvrir plus tard, et elle n'est ajoutée à aucune liste.`,
  alreadyTook: `Vous avez déjà pris la vôtre${S}?`,
  openAgain: "Le rouvrir",
  linkToPass: "Le lien à transmettre",
  copyLink: "Copier le lien",
  copied: "Copié",

  people: (people) => `${people} ${pluralFr(people, "personne", "personnes")}`,
  groupReceiptSubject: (people, title) => `Vos ${people} places${S}: ${title}`,
  resentReceipt: (store) => `${store} nous a demandé de vous le renvoyer. C'est une copie de votre reçu.`,
  forWho: (title, who) => `${title}, pour ${who}`,
  passLinkOn: `Transmettez ce lien aux personnes à qui il est destiné${S}:`,
  eachPerson: (title, people) =>
    `Chaque personne l'ouvre et saisit sa propre adresse e-mail. Elle reçoit un lien dans sa boîte de réception, et l'ouvrir ajoute ${title} à cette adresse, comme si elle l'avait acheté. Prenez vous-même une place de la même façon${S}: vous avez payé pour ${people}, et vous n'en faites partie que si vous en prenez une.`,
  keepEmail: `Conservez cet e-mail${S}: le lien est ce qui permet de distribuer les places, et la page qu'il ouvre indique combien il en reste. Un remboursement intégral reprend toutes les places.`,
  placeAgainSubject: (title) => `Votre place pour ${title}`,
  placeAgainLead: (title, store) => `Vous avez déjà pris votre place pour ${title} de ${store}. Ouvrez-le ici${S}:`,
  takePlaceSubject: (title) => `Prenez votre place pour ${title}`,
  takePlaceLead: (title, store, who) =>
    `Quelqu'un a acheté ${title} chez ${store} pour ${who} et a transmis le lien. Cette adresse y a été saisie pour prendre l'une des places.`,
  openToTake: `Ouvrez ce lien pour la prendre${S}:`,
  takePlaceNote: (title) =>
    `${title} est alors ajouté à cette adresse e-mail, comme si vous l'aviez acheté. Rien ne vous est débité. Le lien fonctionne pendant 24 heures, et la place est à vous dès qu'il est ouvert, tant qu'il en reste une de libre.`,
  ignoreUnlessOpened: `Si vous ne l'avez pas demandé, ignorez cet e-mail${S}: rien ne se passe tant que le lien n'est pas ouvert.`,

  someone: "Quelqu'un",
  giftSubject: (who, title) => `${who} vous a envoyé un cadeau${S}: ${title}`,
  giftLead: (who, title, store) => `${who} vous a acheté ${title} chez ${store}.`,
  theirMessage: `Son message${S}:`,
  giftYours: `C'est à vous, sur cette adresse e-mail. Ouvrez-le ici${S}:`,
  giftReceiptSubject: (title) => `Votre cadeau est en route${S}: ${title}`,
  aGift: (title) => `Un cadeau${S}: ${title}`,
  giftFor: (email) => `Pour${S}: ${email}`,
  weEmailed: (email, withMessage) =>
    `Nous venons d'envoyer un e-mail à ${email}, avec votre nom${withMessage ? ", votre message" : ""} et un lien pour l'ouvrir. C'est à cette personne, sur son adresse${S}; vous ne recevez pas de copie.`,

  reviewMetaTitle: "Votre avis",
  orderRefundedTitle: "Cette commande a été remboursée",
  orderRefundedBody: (store) =>
    `Une commande que ${store} a entièrement remboursée ne peut pas être évaluée. Si vous aviez laissé un avis depuis celle-ci, ses étoiles ne comptent plus.`,
  expiredRecover: `Redemandez vos achats${S}: un nouveau lien arrive généralement par e-mail en moins d'une minute, et vous pourrez laisser votre avis depuis celui-ci.`,
  expiredReply: (store) => `Répondez à la confirmation de commande que ${store} vous a envoyée par e-mail, votre message lui parviendra.`,
  wrongTitle: "Un problème est survenu de notre côté",
  nothingChanged: "Rien n'a été modifié. Réessayez dans un instant.",
  tooManyTries: "Trop de tentatives",
  tooManyBody: "Cette page a été ouverte de nombreuses fois en quelques minutes. Patientez un peu, puis rouvrez votre lien.",
  cannotReviewTitle: "Cette commande ne peut pas être évaluée ici",
  cannotReviewBody: "Ouvrez le lien depuis votre e-mail ou depuis votre liste d'achats.",
  getMyPurchases: "Récupérer mes achats",
  reviewOne: (title) => `Évaluez ${title}`,
  reviewAll: "Évaluez vos achats",
  boughtFromOn: (store, date) => `Acheté chez ${store}${date ? ` le ${date}` : ""}. Un avis honnête aide le prochain acheteur, et ${store}.`,

  reviewNotices: {
    saved: "Merci. Votre avis est maintenant en ligne sur la page.",
    updated: "Votre avis a été mis à jour.",
    deleted: "Votre avis a été supprimé. Ses étoiles ne comptent plus dans la moyenne.",
    rating: "Choisissez entre une et cinq étoiles.",
    refunded: "Cette commande a été remboursée, elle ne peut donc pas être évaluée.",
    expired: "Ce lien a expiré. Redemandez vos achats depuis la boutique et laissez votre avis à partir de là.",
    no: "Cette commande ne peut pas être évaluée ici.",
    full: "Ce produit ne peut plus recevoir d'avis.",
    noroom: "Cette boutique n'a pas de place pour d'autres avis en ce moment, donc le vôtre n'a pas été enregistré. Réessayez plus tard.",
    slow: "Cela fait beaucoup de tentatives en peu de temps. Patientez quelques minutes et renvoyez-le.",
    busy: "Quelqu'un d'autre enregistrait au même moment. Renvoyez-le.",
    error: "Un problème est survenu de notre côté. Rien n'a été modifié. Réessayez dans un instant.",
    photo: "Impossible d'ajouter cette photo. Essayez-en une autre, en JPEG ou prise directement avec votre appareil.",
    photoPaused: "Votre avis a été enregistré, mais la nouvelle photo n'a pas été ajoutée : cette boutique n'accepte pas de nouvelles photos pour le moment.",
    photoLimit: "Votre avis a été enregistré, mais la nouvelle photo n'a pas été ajoutée : un avis peut recevoir 3 nouvelles photos au total, et le vôtre en a déjà reçu 3.",
    photoFailed: "Votre avis a été enregistré, mais la nouvelle photo n'a pas été ajoutée à cause d'un problème de notre côté. Cet essai compte quand même comme 1 des 3 nouvelles photos qu'un avis peut recevoir.",
    confirmDelete: "Vous n'avez ici aucun avis à supprimer.",
    kept: "Votre avis n'a pas été supprimé. Rien n'a été modifié.",
  },
  yourRating: (title) => `Votre note pour ${title}`,
  whatYouThink: "Votre avis (facultatif)",
  upTo: (written) => `Jusqu'à ${written}${S}caractères.`,
  nameToShow: "Nom affiché (facultatif)",
  updateReview: "Mettre à jour mon avis",
  postReview: "Publier mon avis",
  reviewUnread: (title) => `Votre avis sur ${title} n'a pas pu être chargé pour l'instant. Actualisez cette page dans un instant pour le voir ou le modifier.`,
  reviewPublic: (store) =>
    `Votre avis est public sur la page de ${store}, marqué comme achat vérifié. Votre adresse e-mail n'est jamais affichée. ${store} peut y répondre et le masquer, mais pas le modifier.`,
  deleteReview: "Supprimer mon avis",
  deleteReviewAsk: (title) => `Supprimer votre avis sur ${title}${S}?`,
  deleteReviewWhat: (stars, hasWords, hasPhoto, store) =>
    `Cela retire ${andList([`votre note de ${stars}${S}${pluralFr(stars, "étoile", "étoiles")}`, ...(hasWords ? ["votre texte"] : []), ...(hasPhoto ? ["votre photo"] : [])], "et")} de la page de ${store}. Cette suppression est définitive.`,
  deleteReviewYes: "Oui, supprimer mon avis",
  deleteReviewKeep: "Garder mon avis",
  reviewPhoto: "Ajoutez une photo (facultatif)",
  reviewPhotoHint: "Une photo de ce que vous avez réalisé avec, ou de son utilisation. Elle s'affiche avec votre avis.",
  reviewPhotoRemove: "Retirer ma photo",
  reviewPhotoYours: "Votre photo",
  reviewPhotoAlt: (name) => `Photo de ${name}`,

  askSubject: (title) => `Que pensez-vous de ${title}${S}?`,
  listAnd: (list, last) => `${list} et ${last}`,
  askLead: (what, store, date) =>
    `Vous avez acheté ${what} chez ${store} le ${date}. Si vous avez une minute, ${store} aimerait savoir ce que vous en pensez, en bien ou en mal.`,
  askHow: `Donnez-lui une à cinq étoiles et quelques mots ici${S}:`,
  askElsewhere: (store, site) => `Si vous le souhaitez aussi, vous pouvez laisser un avis sur ${store} sur ${site}. C'est la même demande pour tout le monde, et entièrement libre${S}:`,
  askShows: (store) =>
    `Votre avis apparaît sur la page de ${store}, marqué comme achat vérifié, sous le nom de votre choix. Votre adresse e-mail n'est jamais affichée. Le même lien vous permet de le modifier ou de le supprimer pendant 60 jours.`,
  askOnly: "C'est le seul e-mail concernant l'avis sur cette commande.",
  askOneMore: (days) => `Si vous n'avez pas donné votre avis d'ici ${days}${S}jours, vous recevrez un rappel, et ce sera le dernier e-mail à ce sujet.`,
  againSubject: (title) => `Un rappel${S}: que pensez-vous de ${title}${S}?`,
  againLead: (what, store, date) =>
    `Il y a quelques jours, ${store} vous a demandé ce que vous pensez de ${what}, acheté le ${date}. Si vous avez une minute, quelques mots sont les bienvenus, en bien ou en mal.`,
  againOnly: "C'est le dernier e-mail concernant l'avis sur cette commande.",
  askWhy: (store) => `Vous recevez ceci parce que vous avez acheté chez ${store}.`,
  askStopLabel: "Ne plus recevoir de demandes d'avis",
  askStopAfter: (store) => `de ${store} en un clic.`,
  askStopLine: (link) => `Ne plus recevoir de demandes d'avis${S}: ${link}`,

  recoverSubject: (title) => `Vous avez laissé ${title} au moment du paiement`,
  recoverLead: (title, store) => `Vous avez commencé à acheter ${title} chez ${store} sans aller au bout, donc rien n'a été débité.`,
  recoverHere: `Si vous le voulez toujours, c'est ici${S}:`,
  recoverPrice: (price) => `Le prix${S}: ${price}. Le paiement s'ouvre au prix du jour.`,
  youChoosePrice: (price) => `vous le choisissez, à partir de ${price}`,
  recoverOnly: (why) => `C'est le seul rappel concernant ce paiement. ${why}`,
  recoverWhyCheckout: (store) => `Il vous parvient parce que vous avez accepté, sur la page de paiement, de recevoir des nouvelles de ${store}.`,
  recoverWhyAsked: (store) => `Il vous parvient parce que vous l'avez demandé sur la boutique de ${store}.`,
  recoverStop: (store, link) => `Ne plus recevoir ces rappels de ${store}${S}: ${link}`,
  /** The email for a reminder asked for on a product's page (lib/checkout-ask.ts). */
  pageAskSubject: (title) => `Un rappel pour ${title}`,
  pageAskLead: (title, store) => `Vous avez demandé à ${store} de vous rappeler ${title}.`,
  pageAskOnly: (why) => `C'est le seul rappel. ${why}`,
  callSubject: (title) => `Votre créneau pour ${title} n'est pas encore réservé`,
  callLead: (title, when, store) => `Vous avez choisi ${when} pour ${title} avec ${store} sans terminer le paiement, donc rien n'a été débité et le créneau ne vous a pas été gardé.`,
  callHere: `Pour réserver, choisissez un créneau ici${S}:`,

  keyLabel: "Votre clé de licence",
  keyLabelFor: (title) => `Votre clé de licence pour ${title}`,
  keyReady: (title) => `Votre clé de licence pour ${title} est prête${S}:`,
  keyThanks: (link) => `Merci de votre patience. Elle figure aussi dans votre liste d'achats${S}: ${link}`,
  keyQuestions: (store) => `Des questions${S}? Répondez à cet e-mail, et votre message parviendra à ${store}.`,
  copy: "Copier",
  keyYours: `Elle n'est qu'à vous${S}: personne d'autre ne reçoit cette clé. Elle figure aussi dans votre e-mail de confirmation et dans votre liste d'achats.`,
  keyRevoked: (store) =>
    `${store} a marqué cette clé comme n'étant plus valide. Si vous pensez qu'il s'agit d'une erreur, répondez à votre e-mail de confirmation de commande, votre message lui parviendra.`,
  keyWaiting: (store) =>
    `Votre paiement est passé juste au moment où les clés de ${store} se sont épuisées, la vôtre n'est donc pas encore prête. ${store} en a été informé, et elle vous sera envoyée par e-mail dès que de nouvelles clés seront ajoutées. Elle apparaît aussi ici et dans votre liste d'achats.`,
  keyFailed: `Votre clé n'a pas pu être affichée pour le moment. Actualisez la page dans un instant${S}; elle vous est réservée.`,

  ppSubject: (title) => `Votre achat${S}: ${title}`,
  ppThanks: (store) => `Merci pour votre achat chez ${store}. Voici votre confirmation.`,
  ppWhat: (title) => `Ce que vous avez acheté${S}: ${title}`,
  ppPaid: (amount) => `Payé avec PayPal${S}: ${amount}`,
  ppTransaction: (id) => `Transaction PayPal${S}: ${id}`,
  ppPaidTo: (store) => `Payé sur le propre compte PayPal de ${store}. Pour toute question, répondez à cet e-mail, elle parviendra à ${store}.`,
};

// =====================================================================================
// German: "Sie".

const deSentBy = (store: string) => `Gesendet von Marktmorgen im Auftrag von ${store}.`;

const de: GivingWords = {
  checkInbox: "Sehen Sie in Ihrem Posteingang nach",
  linkExpired: "Dieser Link ist abgelaufen",
  emailTitle: "Das sieht nicht nach einer E-Mail-Adresse aus",
  openIt: "Öffnen",
  openHere: "Hier öffnen:",
  sentBy: deSentBy,
  sentWith: "Gesendet mit Marktmorgen.",
  orderRef: (reference) => `Bestellreferenz: ${reference}`,
  paidLine: (amount) => `Bezahlt: ${amount}`,
  thanksReceipt: (store) => `Vielen Dank für Ihren Kauf bei ${store}. Dies ist Ihre Quittung.`,
  chargedBy: (store) => `Berechnet von ${store} über das eigene Stripe-Konto. Fragen erreichen ${store}, wenn Sie auf diese E-Mail antworten.`,
  link24: (orders) => `Dieser Link funktioniert 24 Stunden lang. Gehen Sie danach auf ${orders}, geben Sie diese Adresse ein, und ein neuer kommt sofort.`,
  ignoreThis: "Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail.",
  sentByNothing: (store) => `${deSentBy(store)} Ihnen wurde nichts berechnet.`,

  freeMetaTitle: "Ihr kostenloses Exemplar",
  freeNotices: {
    email: {
      title: "Das sieht nicht nach einer E-Mail-Adresse aus",
      body: "Prüfen Sie sie und versuchen Sie es erneut. Das Exemplar geht an die Adresse, die Sie eingeben, daher muss es eine sein, die Sie abrufen können.",
    },
    limited: {
      title: "Gerade zu viele Anfragen",
      body: "Damit dieses Formular nicht benutzt werden kann, um jemandes Posteingang zu überfluten, nimmt es nur eine begrenzte Zahl von Anfragen pro Stunde an. Versuchen Sie es in einer Stunde erneut.",
    },
    unavailable: {
      title: "Das ist gerade nicht verfügbar",
      body: "Es wurde nichts gesendet und nichts gespeichert. Der Shop richtet es möglicherweise noch ein.",
    },
    error: {
      title: "Wir konnten es gerade nicht senden",
      body: "Es wurde nichts gespeichert. Versuchen Sie es gleich noch einmal.",
    },
  },
  alsoFrom: (store) => `Auch von ${store}`,
  freeFrom: (store) => `Von ${store}. Drücken Sie auf die Schaltfläche, und es gehört Ihnen.`,
  downloadIt: "Herunterladen",
  keptOn: (host, store) => `${store} bewahrt es auf ${host} auf, nicht hier, deshalb führt Sie die Schaltfläche dorthin.`,
  freeLinkWorks: "Der Link in Ihrer E-Mail funktioniert 7 Tage lang, Sie können es also auch auf einem anderen Gerät abholen.",
  noLongerFree: "Das ist nicht mehr kostenlos",
  changedSince: (store) => `${store} hat es seit dem Versand der E-Mail geändert, daher wird es über diesen Link nicht mehr ausgegeben.`,
  freeLinkDays: "Der Link zu einem kostenlosen Exemplar funktioniert 7 Tage lang. Fordern Sie im Shop einen neuen an – das dauert nur wenige Sekunden.",
  sent: "Gesendet",
  emailedLinkTo: (title) => `Wir haben Ihnen einen Link zu ${title} per E-Mail geschickt.`,
  emailedLink: "Wir haben Ihnen einen Link per E-Mail geschickt.",
  comesFrom: (store) => `Er kommt von ${store} über Marktmorgen. Falls nicht, sehen Sie im Spam-Ordner nach.`,
  joinsOnUse: (store) =>
    `Ihre Adresse kommt erst auf die Liste von ${store}, wenn Sie diesen Link nutzen, damit eine vertippte Adresse nie darauf landet.`,
  freeGone: "Das wird nicht mehr kostenlos angeboten.",
  freeNothing: "Hier ist noch nichts hinterlegt. Fragen Sie beim Shop nach.",

  freeSubject: (title) => `Ihr Exemplar von ${title}`,
  freeAsked: (store, title) => `Sie haben ${title} bei ${store} angefordert. Hier ist es:`,
  freeOpen: "Öffnen Sie den Link und drücken Sie auf die Schaltfläche. Er funktioniert 7 Tage lang.",
  freeConsented: (store) => `Sie haben außerdem zugestimmt, dass ${store} Ihnen E-Mails senden darf. Sie können sich in jeder davon abmelden.`,
  freeNotConsented: (store) =>
    `Sie haben das Kästchen für Nachrichten von ${store} nicht angekreuzt, daher erhält ${store} Ihre Adresse mit dem Vermerk, dass Sie nur dies angefordert haben, und nichts weiter.`,
  freeIgnore: "Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail. Es passiert nichts, solange der Link nicht benutzt wird.",
  freeContact: (store, link) => `Um ${store} zu schreiben, nutzen Sie das Kontaktformular auf der Seite: ${link}`,
  freeSentBy: (store) =>
    `Gesendet von Marktmorgen im Auftrag von ${store}. Marktmorgen verwendet Ihre Adresse für nichts anderes, und Antworten auf diese E-Mail erreichen ${store} nicht.`,

  waitlist: "Warteliste",
  waitNotices: {
    email: {
      title: "Das sieht nicht nach einer E-Mail-Adresse aus",
      body: "Prüfen Sie sie und versuchen Sie es erneut. Die Bestätigung geht an die Adresse, die Sie eingeben, daher muss es eine sein, die Sie abrufen können.",
    },
    limited: {
      title: "Gerade zu viele Anmeldungen",
      body: "Damit dieses Formular nicht benutzt werden kann, um jemandes Posteingang zu überfluten, nimmt es nur eine begrenzte Zahl pro Stunde an. Versuchen Sie es in einer Stunde erneut.",
    },
    full: {
      title: "Diese Warteliste ist voll",
      body: "Sie fasst so viele Personen, wie sie kann. Es wurde nichts gespeichert.",
    },
    closed: {
      title: "Dies ist nicht mehr als demnächst erhältlich angekündigt",
      body: "Möglicherweise ist es bereits im Verkauf. Es wurde nichts gespeichert.",
    },
    error: {
      title: "Wir konnten es gerade nicht senden",
      body: "Versuchen Sie es gleich noch einmal.",
    },
    expired: {
      title: "Dieser Link ist abgelaufen",
      body: "Ein Bestätigungslink funktioniert 7 Tage lang. Tragen Sie sich auf der Seite des Produkts erneut ein; das dauert nur wenige Sekunden.",
    },
  },
  confirmSpotTitle: "Bestätigen Sie Ihren Platz",
  confirmSpotBody: (store, title) =>
    `Drücken Sie auf die Schaltfläche, und ${store} schreibt Ihnen ein einziges Mal, wenn ${title || "es"} in den Verkauf geht.`,
  confirmSpotButton: "Meinen Platz bestätigen",
  removeTitle: "Ihre Adresse entfernen?",
  notTold: (title) => `Sie werden nicht benachrichtigt, wenn ${title || "es"} in den Verkauf geht.`,
  removeButton: "Meine Adresse entfernen",
  notOnListTitle: "Ihre Adresse steht nicht auf dieser Warteliste",
  notOnListBody: "Sie wurde bereits entfernt, oder die Warteliste hat ihren Zweck erfüllt und ihre Adressen sind gelöscht.",
  almostThere: "Fast geschafft",
  waitSentBody: (title, store) =>
    `Wir haben Ihnen per E-Mail eine Schaltfläche geschickt, mit der Sie Ihren Platz auf der Warteliste${title ? ` für ${title}` : ""} bestätigen. Sie kommt von ${store} über Marktmorgen. Falls sie nicht da ist, sehen Sie im Spam-Ordner nach.`,
  waitSentNote: "Ihr Platz zählt erst, wenn Sie darauf drücken, damit eine vertippte Adresse nie benachrichtigt wird.",
  onTheList: "Sie stehen auf der Liste",
  tellWhenOut: (title) => `Wir sagen Ihnen Bescheid, wenn ${title || "es"} erscheint`,
  oneEmailDay: "Eine E-Mail am Tag des Verkaufsstarts, mit dem Link. Mehr verschickt diese Warteliste nicht.",
  removedTitle: "Ihre Adresse wurde entfernt",

  waitSubject: (title) => `Bestätigen Sie Ihren Platz: ${title}`,
  waitAsked: (store, title) => `Sie haben ${store} gebeten, Ihnen Bescheid zu geben, wenn ${title} erscheint.`,
  waitOpen: "Öffnen Sie diesen Link und drücken Sie auf die Schaltfläche, um zu bestätigen, dass Sie es waren:",
  waitWorks: "Er funktioniert 7 Tage lang. Wenn es erscheint, erhalten Sie eine E-Mail mit dem Link, und das ist die einzige E-Mail, die diese Warteliste verschickt.",
  waitConsented: (store) =>
    `Sie haben außerdem zugestimmt, dass ${store} Ihnen weitere E-Mails senden darf; sobald Sie bestätigen, stehen Sie auf der Liste von ${store} und können sich in jeder davon abmelden.`,
  waitNotConsented: (store) => `Sie haben das Kästchen für weitere Nachrichten von ${store} nicht angekreuzt, also erhalten Sie keine.`,
  waitIgnore: "Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail. Es passiert nichts, solange niemand auf die Schaltfläche drückt.",
  waitLeave: (link) => `So nehmen Sie Ihre Adresse jederzeit von dieser Warteliste: ${link}`,
  launchSubject: (title) => `${title} ist erschienen`,
  launchLead: (store, title, price) =>
    `Sie haben ${store} gebeten, Ihnen Bescheid zu geben, wenn ${title} erscheint. Es ist jetzt da${price ? `, für ${price}` : ""}:`,
  launchWhy: (title) =>
    `Sie erhalten diese E-Mail, weil Sie sich auf die Warteliste für ${title} eingetragen und Ihre Adresse bestätigt haben. Es ist die einzige E-Mail, die die Warteliste verschickt.`,
  launchLabel: "Meine Adresse entfernen",
  launchAfter: "– von dieser Warteliste.",
  launchLine: (link) => `Meine Adresse entfernen: ${link}`,

  groupMetaTitle: "Nehmen Sie Ihren Platz ein",
  groupNotices: {
    sent: {
      title: "Sehen Sie in Ihrem Posteingang nach",
      body: "Wir haben einen Link an die eingegebene Adresse geschickt. Öffnen Sie ihn, und der Platz gehört Ihnen. Er funktioniert 24 Stunden lang; wenn in ein paar Minuten nichts ankommt, sehen Sie im Spam-Ordner nach und geben Sie die Adresse dann unten erneut ein.",
    },
    email: {
      title: "Das sieht nicht nach einer E-Mail-Adresse aus",
      body: "Prüfen Sie sie und versuchen Sie es erneut. Der Link geht an die Adresse, die Sie eingeben, daher muss es eine sein, die Sie abrufen können.",
    },
    full: {
      title: "Alle Plätze sind vergeben",
      body: "Wer das gekauft hat, hat für eine feste Zahl von Personen bezahlt, und jeder Platz ist jetzt unter der Adresse von jemandem vergeben. Fragen Sie diese Person, ob sie noch einen dazukaufen kann.",
    },
    slow: {
      title: "Gerade wurden zu viele Links angefordert",
      body: "Damit diese Seite nicht benutzt werden kann, um jemandes Posteingang zu füllen, verschickt sie nur eine begrenzte Zahl pro Tag. Versuchen Sie es später erneut; es wurde kein Platz vergeben oder verloren.",
    },
    unavailable: {
      title: "Wir konnten das gerade nicht senden",
      body: "Es wurde kein Platz vergeben oder verloren. Versuchen Sie es gleich noch einmal.",
    },
    opening: {
      title: "Wir konnten Ihren Platz nicht fertig öffnen",
      body: "Öffnen Sie den Link gleich noch einmal. Wenn der Platz schon Ihrer war, ändert sich nichts.",
    },
    expired: {
      title: "Dieser Link ist abgelaufen",
      body: "Er funktioniert 24 Stunden lang. Geben Sie Ihre Adresse unten erneut ein, und ein neuer kommt sofort.",
    },
    resting: {
      title: "Dieser Shop pausiert gerade",
      body: "Kein Platz wurde vergeben oder ist verloren. Der Shop vergibt wieder Plätze, wenn sein nächster Monat beginnt, oder früher: Kommen Sie dann zurück und geben Sie unten Ihre Adresse für einen neuen Link ein.",
    },
  },
  groupRefundedTitle: "Dieser Kauf wurde erstattet",
  groupRefundedBody: (title, people) =>
    `${title} wurde für ${people} Personen gekauft und die Zahlung später vollständig erstattet, daher sind die Plätze geschlossen.`,
  alreadyYours: "Gehört Ihnen bereits",
  done: "Erledigt",
  hasItTitle: "Diese Adresse hat es bereits",
  placeYours: "Der Platz gehört Ihnen",
  placeHas: (title, email) => `${title} war unter ${email} bereits freigeschaltet, daher wurde kein Platz verwendet.`,
  placeTaken: (title, email) => `${title} ist jetzt unter ${email} freigeschaltet, als hätten Sie es gekauft. Ihnen wurde nichts berechnet.`,
  laterOrders: (address) =>
    `Gehen Sie später auf ${address}/orders und geben Sie diese Adresse ein: Ein Link zu allem, was unter ihr freigeschaltet ist, kommt sofort.`,
  paidForYou: "Für Sie bezahlt",
  boughtForPeople: (store, people, open) => `Jemand hat das bei ${store} für ${people} Personen gekauft und diesen Link weitergegeben. ${open}`,
  placesLeft: (people, left) =>
    left === 0 ? `Alle ${people} Plätze sind vergeben.` : `${left} von ${people} Plätzen ${left === 1 ? "ist" : "sind"} noch frei.`,
  sendPlaceLink: "Link zu meinem Platz senden",
  placeNote: (title) =>
    `Ein Link geht an diese Adresse; wenn Sie ihn öffnen, wird ein Platz belegt und ${title} unter dieser Adresse freigeschaltet. Ihnen wird nichts berechnet. Ihre Adresse wird verwendet, um es zu übergeben und später wieder zu öffnen, und sie wird keiner Liste hinzugefügt.`,
  alreadyTook: "Haben Sie Ihren Platz schon?",
  openAgain: "Erneut öffnen",
  linkToPass: "Der Link zum Weitergeben",
  copyLink: "Link kopieren",
  copied: "Kopiert",

  people: (people) => `${people} ${plural(people, "Person", "Personen")}`,
  groupReceiptSubject: (people, title) => `Ihre ${people} Plätze: ${title}`,
  resentReceipt: (store) => `${store} hat uns gebeten, Ihnen das erneut zu senden. Es ist eine Kopie Ihrer Quittung.`,
  forWho: (title, who) => `${title}, für ${who}`,
  passLinkOn: "Geben Sie diesen Link an die Personen weiter, für die er gedacht ist:",
  eachPerson: (title, people) =>
    `Jede Person öffnet ihn und gibt ihre eigene E-Mail-Adresse ein. Sie erhält einen Link in ihrem Posteingang, und wenn sie ihn öffnet, wird ${title} unter dieser Adresse freigeschaltet, als hätte sie es gekauft. Nehmen Sie Ihren eigenen Platz auf dieselbe Weise: Sie haben für ${people} bezahlt, und Sie gehören nur dazu, wenn Sie einen Platz nehmen.`,
  keepEmail:
    "Bewahren Sie diese E-Mail auf: Über den Link werden die Plätze verteilt, und die Seite, die er öffnet, zeigt, wie viele noch frei sind. Eine vollständige Erstattung nimmt alle Plätze zurück.",
  placeAgainSubject: (title) => `Ihr Platz für ${title}`,
  placeAgainLead: (title, store) => `Sie haben Ihren Platz für ${title} von ${store} bereits eingenommen. Hier öffnen:`,
  takePlaceSubject: (title) => `Nehmen Sie Ihren Platz für ${title} ein`,
  takePlaceLead: (title, store, who) =>
    `Jemand hat ${title} bei ${store} für ${who} gekauft und den Link weitergegeben. Diese Adresse wurde dort eingegeben, um einen der Plätze zu nehmen.`,
  openToTake: "Öffnen Sie diesen Link, um ihn zu nehmen:",
  takePlaceNote: (title) =>
    `Damit wird ${title} unter dieser E-Mail-Adresse freigeschaltet, als hätten Sie es gekauft. Ihnen wird nichts berechnet. Der Link funktioniert 24 Stunden lang, und der Platz gehört Ihnen, sobald er geöffnet wird, solange noch einer frei ist.`,
  ignoreUnlessOpened: "Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail: Es passiert nichts, solange der Link nicht geöffnet wird.",

  someone: "Jemand",
  giftSubject: (who, title) => `${who} hat Ihnen ein Geschenk geschickt: ${title}`,
  giftLead: (who, title, store) => `${who} hat Ihnen ${title} bei ${store} gekauft.`,
  theirMessage: "Die Nachricht dazu:",
  giftYours: "Es gehört Ihnen, unter dieser E-Mail-Adresse. Hier öffnen:",
  giftReceiptSubject: (title) => `Ihr Geschenk ist unterwegs: ${title}`,
  aGift: (title) => `Ein Geschenk: ${title}`,
  giftFor: (email) => `Für: ${email}`,
  weEmailed: (email, withMessage) =>
    `Wir haben ${email} soeben eine E-Mail geschickt, mit Ihrem Namen${withMessage ? ", Ihrer Nachricht" : ""} und einem Link zum Öffnen. Es gehört der beschenkten Person, unter ihrer Adresse; Sie erhalten keine Kopie.`,

  reviewMetaTitle: "Ihre Bewertung",
  orderRefundedTitle: "Diese Bestellung wurde erstattet",
  orderRefundedBody: (store) =>
    `Eine Bestellung, die ${store} vollständig erstattet hat, kann nicht bewertet werden. Falls Sie dazu eine Bewertung geschrieben haben, zählen ihre Sterne nicht mehr.`,
  expiredRecover: "Fordern Sie Ihre Käufe erneut an: Ein neuer Link kommt meist innerhalb einer Minute per E-Mail, und von dort aus können Sie bewerten.",
  expiredReply: (store) => `Antworten Sie auf die Bestellbestätigung, die ${store} Ihnen per E-Mail geschickt hat; Ihre Antwort erreicht ${store}.`,
  wrongTitle: "Bei uns ist etwas schiefgelaufen",
  nothingChanged: "Es wurde nichts geändert. Versuchen Sie es gleich noch einmal.",
  tooManyTries: "Zu viele Versuche",
  tooManyBody: "Diese Seite wurde in wenigen Minuten sehr oft geöffnet. Warten Sie kurz und öffnen Sie Ihren Link dann erneut.",
  cannotReviewTitle: "Diese Bestellung kann hier nicht bewertet werden",
  cannotReviewBody: "Öffnen Sie den Link aus Ihrer E-Mail oder aus Ihrer Liste der Käufe.",
  getMyPurchases: "Meine Käufe abrufen",
  reviewOne: (title) => `${title} bewerten`,
  reviewAll: "Ihre Käufe bewerten",
  boughtFromOn: (store, date) => `Gekauft bei ${store}${date ? ` am ${date}` : ""}. Eine ehrliche Bewertung hilft dem nächsten Käufer – und ${store}.`,

  reviewNotices: {
    saved: "Vielen Dank. Ihre Bewertung steht jetzt auf der Seite.",
    updated: "Ihre Bewertung wurde aktualisiert.",
    deleted: "Ihre Bewertung wurde gelöscht. Ihre Sterne zählen nicht mehr zum Durchschnitt.",
    rating: "Wählen Sie ein bis fünf Sterne.",
    refunded: "Diese Bestellung wurde erstattet und kann daher nicht bewertet werden.",
    expired: "Dieser Link ist abgelaufen. Fordern Sie Ihre Käufe im Shop erneut an und bewerten Sie von dort aus.",
    no: "Diese Bestellung kann hier nicht bewertet werden.",
    full: "Dieses Produkt kann keine weiteren Bewertungen aufnehmen.",
    noroom: "Dieser Shop hat gerade keinen Platz für weitere Bewertungen, deshalb wurde Ihre nicht gespeichert. Versuchen Sie es später erneut.",
    slow: "Das waren viele Versuche in kurzer Zeit. Warten Sie ein paar Minuten und senden Sie sie erneut.",
    busy: "Jemand anderes hat im selben Moment gespeichert. Senden Sie sie erneut.",
    error: "Bei uns ist etwas schiefgelaufen. Es wurde nichts geändert. Versuchen Sie es gleich noch einmal.",
    photo: "Dieses Foto konnte nicht hinzugefügt werden. Versuche ein anderes, als JPEG oder direkt aus der Kamera.",
    photoPaused: "Ihre Bewertung wurde gespeichert, aber das neue Foto wurde nicht hinzugefügt: Dieser Shop nimmt im Moment keine neuen Fotos an.",
    photoLimit: "Ihre Bewertung wurde gespeichert, aber das neue Foto wurde nicht hinzugefügt: Eine Bewertung kann insgesamt 3 neue Fotos erhalten, und Ihre hat bereits 3 erhalten.",
    photoFailed: "Ihre Bewertung wurde gespeichert, aber das neue Foto wurde wegen eines Problems bei uns nicht hinzugefügt. Dieser Versuch zählt trotzdem als 1 der 3 neuen Fotos, die eine Bewertung erhalten kann.",
    confirmDelete: "Hier gibt es keine Bewertung von Ihnen, die gelöscht werden kann.",
    kept: "Ihre Bewertung wurde nicht gelöscht. Es wurde nichts geändert.",
  },
  yourRating: (title) => `Ihre Sterne für ${title}`,
  whatYouThink: "Ihre Meinung (optional)",
  upTo: (written) => `Bis zu ${written} Zeichen.`,
  nameToShow: "Angezeigter Name (optional)",
  updateReview: "Meine Bewertung aktualisieren",
  postReview: "Meine Bewertung veröffentlichen",
  reviewUnread: (title) => `Ihre Bewertung von ${title} konnte gerade nicht geladen werden. Laden Sie diese Seite gleich neu, um sie zu sehen oder zu ändern.`,
  reviewPublic: (store) =>
    `Ihre Bewertung ist auf der Seite von ${store} öffentlich sichtbar und als verifizierter Kauf gekennzeichnet. Ihre E-Mail-Adresse wird nie angezeigt. ${store} kann antworten und sie ausblenden, aber nicht ändern.`,
  deleteReview: "Meine Bewertung löschen",
  deleteReviewAsk: (title) => `Ihre Bewertung von ${title} löschen?`,
  deleteReviewWhat: (stars, hasWords, hasPhoto, store) =>
    `Damit löschen Sie ${andList([`Ihre Bewertung mit ${stars} ${plural(stars, "Stern", "Sternen")}`, ...(hasWords ? ["Ihren Text"] : []), ...(hasPhoto ? ["Ihr Foto"] : [])], "und")} von der Seite von ${store}. Das lässt sich nicht rückgängig machen.`,
  deleteReviewYes: "Ja, meine Bewertung löschen",
  deleteReviewKeep: "Meine Bewertung behalten",
  reviewPhoto: "Füge ein Foto hinzu (optional)",
  reviewPhotoHint: "Ein Foto von dem, was du damit gemacht hast, oder davon im Einsatz. Es erscheint mit deiner Bewertung.",
  reviewPhotoRemove: "Mein Foto entfernen",
  reviewPhotoYours: "Dein Foto",
  reviewPhotoAlt: (name) => `Foto von ${name}`,

  askSubject: (title) => `Wie gefällt Ihnen ${title}?`,
  listAnd: (list, last) => `${list} und ${last}`,
  askLead: (what, store, date) =>
    `Sie haben ${what} am ${date} bei ${store} gekauft. Wenn Sie eine Minute haben, möchte ${store} gern wissen, was Sie davon halten – ob gut oder schlecht.`,
  askHow: "Vergeben Sie hier ein bis fünf Sterne und ein paar Worte:",
  askElsewhere: (store, site) => `Wenn Sie möchten, können Sie ${store} auch auf ${site} bewerten. Alle werden gleich gefragt, und es ist ganz Ihnen überlassen:`,
  askShows: (store) =>
    `Ihre Bewertung erscheint auf der Seite von ${store}, als verifizierter Kauf gekennzeichnet, unter dem Namen, den Sie wählen. Ihre E-Mail-Adresse wird nie angezeigt. Mit demselben Link können Sie sie 60 Tage lang ändern oder löschen.`,
  askOnly: "Das ist die einzige E-Mail zur Bewertung dieser Bestellung.",
  askOneMore: (days) => `Wenn Sie in ${days} Tagen noch keine Bewertung geschrieben haben, erhalten Sie eine Erinnerung, und das ist die letzte E-Mail dazu.`,
  againSubject: (title) => `Eine Erinnerung: Wie gefällt Ihnen ${title}?`,
  againLead: (what, store, date) =>
    `Vor ein paar Tagen hat ${store} Sie gefragt, was Sie von ${what} halten, gekauft am ${date}. Wenn Sie eine Minute haben, sind ein paar Worte willkommen – ob gut oder schlecht.`,
  againOnly: "Das ist die letzte E-Mail zur Bewertung dieser Bestellung.",
  askWhy: (store) => `Sie erhalten diese E-Mail, weil Sie bei ${store} gekauft haben.`,
  askStopLabel: "Keine Bewertungsanfragen mehr",
  askStopAfter: (store) => `von ${store} – mit einem Klick.`,
  askStopLine: (link) => `Keine Bewertungsanfragen mehr: ${link}`,

  recoverSubject: (title) => `Sie haben ${title} an der Kasse zurückgelassen`,
  recoverLead: (title, store) => `Sie haben begonnen, ${title} bei ${store} zu kaufen, und nicht abgeschlossen, daher wurde nichts berechnet.`,
  recoverHere: "Falls Sie es noch möchten, hier ist es:",
  recoverPrice: (price) => `Der Preis: ${price}. Die Kasse öffnet zum heutigen Preis.`,
  youChoosePrice: (price) => `Sie wählen ihn selbst, ab ${price}`,
  recoverOnly: (why) => `Dies ist die einzige Erinnerung an diesen Kaufvorgang. ${why}`,
  recoverWhyCheckout: (store) => `Sie erhalten sie, weil Sie auf der Zahlungsseite zugestimmt haben, von ${store} zu hören.`,
  recoverWhyAsked: (store) => `Sie erhalten sie, weil Sie im Shop von ${store} darum gebeten haben.`,
  recoverStop: (store, link) => `Diese Erinnerungen von ${store} abbestellen: ${link}`,
  /** The email for a reminder asked for on a product's page (lib/checkout-ask.ts). */
  pageAskSubject: (title) => `Eine Erinnerung an ${title}`,
  pageAskLead: (title, store) => `Sie haben ${store} gebeten, Sie an ${title} zu erinnern.`,
  pageAskOnly: (why) => `Das ist die einzige Erinnerung. ${why}`,
  callSubject: (title) => `Ihr Termin für ${title} ist noch nicht gebucht`,
  callLead: (title, when, store) => `Sie haben ${when} für ${title} bei ${store} gewählt und die Zahlung nicht abgeschlossen. Es wurde nichts berechnet, und der Termin wurde nicht für Sie freigehalten.`,
  callHere: "Zum Buchen wählen Sie hier einen Termin:",

  keyLabel: "Ihr Lizenzschlüssel",
  keyLabelFor: (title) => `Ihr Lizenzschlüssel für ${title}`,
  keyReady: (title) => `Ihr Lizenzschlüssel für ${title} ist bereit:`,
  keyThanks: (link) => `Danke fürs Warten. Er steht auch in Ihrer Liste der Käufe: ${link}`,
  keyQuestions: (store) => `Fragen? Antworten Sie auf diese E-Mail, dann erreicht Ihre Nachricht ${store}.`,
  copy: "Kopieren",
  keyYours: "Er gehört nur Ihnen: Niemand sonst erhält diesen Schlüssel. Er steht auch in Ihrer Bestätigungs-E-Mail und in Ihrer Liste der Käufe.",
  keyRevoked: (store) =>
    `${store} hat diesen Schlüssel als nicht mehr gültig markiert. Wenn Sie das für einen Fehler halten, antworten Sie auf Ihre Bestellbestätigung per E-Mail; Ihre Antwort erreicht ${store}.`,
  keyWaiting: (store) =>
    `Ihre Zahlung ging genau in dem Moment durch, als die Schlüssel von ${store} ausgingen, daher ist Ihrer noch nicht bereit. ${store} wurde benachrichtigt, und Ihr Schlüssel wird Ihnen per E-Mail geschickt, sobald neue hinzugefügt werden. Er erscheint auch hier und in Ihrer Liste der Käufe.`,
  keyFailed: "Ihr Schlüssel konnte gerade nicht angezeigt werden. Laden Sie die Seite gleich neu; er bleibt für Sie reserviert.",

  ppSubject: (title) => `Ihr Kauf: ${title}`,
  ppThanks: (store) => `Vielen Dank für Ihren Kauf bei ${store}. Dies ist Ihre Bestätigung.`,
  ppWhat: (title) => `Was Sie gekauft haben: ${title}`,
  ppPaid: (amount) => `Bezahlt mit PayPal: ${amount}`,
  ppTransaction: (id) => `PayPal-Transaktion: ${id}`,
  ppPaidTo: (store) => `Bezahlt an das eigene PayPal-Konto von ${store}. Fragen erreichen ${store}, wenn Sie auf diese E-Mail antworten.`,
};

// =====================================================================================
// Italian: "tu".

const itSentBy = (store: string) => `Inviata da Marktmorgen per conto di ${store}.`;

const it: GivingWords = {
  checkInbox: "Controlla la tua casella di posta",
  linkExpired: "Questo link è scaduto",
  emailTitle: "Non sembra un indirizzo email",
  openIt: "Aprilo",
  openHere: "Aprilo qui:",
  sentBy: itSentBy,
  sentWith: "Inviata con Marktmorgen.",
  orderRef: (reference) => `Riferimento dell'ordine: ${reference}`,
  paidLine: (amount) => `Pagato: ${amount}`,
  thanksReceipt: (store) => `Grazie per aver acquistato da ${store}. Questa è la tua ricevuta.`,
  chargedBy: (store) => `Addebitato da ${store} sul proprio account Stripe. Per domande, rispondi a questa email e arriveranno a ${store}.`,
  link24: (orders) => `Quel link funziona per 24 ore. Dopo, vai su ${orders}, scrivi questo indirizzo e ne arriva subito uno nuovo.`,
  ignoreThis: "Se non l'hai chiesto tu, ignora questa email.",
  sentByNothing: (store) => `${itSentBy(store)} Non ti è stato addebitato nulla.`,

  freeMetaTitle: "La tua copia gratuita",
  freeNotices: {
    email: {
      title: "Non sembra un indirizzo email",
      body: "Controllalo e riprova. La copia va all'indirizzo che scrivi, quindi deve essere uno che puoi aprire.",
    },
    limited: {
      title: "Troppe richieste per ora",
      body: "Perché questo modulo non venga usato per intasare la casella di posta di qualcuno, accetta un numero limitato di richieste all'ora. Riprova tra un'ora.",
    },
    unavailable: {
      title: "Non è disponibile al momento",
      body: "Non è stato inviato né conservato nulla. Il negozio potrebbe starlo ancora preparando.",
    },
    error: {
      title: "Non siamo riusciti a inviarlo in questo momento",
      body: "Non è stato conservato nulla. Riprova tra un momento.",
    },
  },
  alsoFrom: (store) => `Anche da ${store}`,
  freeFrom: (store) => `Da ${store}. Premi il pulsante ed è tuo.`,
  downloadIt: "Scaricalo",
  keptOn: (host, store) => `${store} lo conserva su ${host}, non qui, quindi il pulsante ti porta lì.`,
  freeLinkWorks: "Il link nella tua email funziona per 7 giorni, quindi puoi tornare a prenderlo da un altro dispositivo.",
  noLongerFree: "Non è più gratuito",
  changedSince: (store) => `${store} l'ha modificato dopo l'invio dell'email, quindi non viene più consegnato da questo link.`,
  freeLinkDays: "Il link di una copia gratuita funziona per 7 giorni. Chiedine uno nuovo al negozio: bastano pochi secondi.",
  sent: "Inviato",
  emailedLinkTo: (title) => `Ti abbiamo inviato via email un link a ${title}.`,
  emailedLink: "Ti abbiamo inviato un link via email.",
  comesFrom: (store) => `Arriva da ${store} tramite Marktmorgen. Se non lo trovi, guarda nello spam.`,
  joinsOnUse: (store) =>
    `Il tuo indirizzo entra nella lista di ${store} solo quando usi quel link, così un indirizzo scritto male non ci finisce mai.`,
  freeGone: "Non è più offerto gratuitamente.",
  freeNothing: "Non c'è ancora niente qui. Chiedi al negozio.",

  freeSubject: (title) => `La tua copia di ${title}`,
  freeAsked: (store, title) => `Hai chiesto ${title} a ${store}. Eccolo:`,
  freeOpen: "Apri il link e premi il pulsante. Funziona per 7 giorni.",
  freeConsented: (store) => `Hai anche detto che ${store} può inviarti email. Puoi disiscriverti da ognuna di esse.`,
  freeNotConsented: (store) =>
    `Non hai spuntato la casella per ricevere notizie da ${store}, quindi il tuo indirizzo gli arriva con l'indicazione che hai chiesto solo questo, e nient'altro.`,
  freeIgnore: "Se non l'hai chiesto tu, ignora questa email. Non succede nulla finché il link non viene usato.",
  freeContact: (store, link) => `Per scrivere a ${store}, usa il modulo di contatto della sua pagina: ${link}`,
  freeSentBy: (store) =>
    `Inviata da Marktmorgen per conto di ${store}. Marktmorgen non usa il tuo indirizzo per nient'altro, e le risposte a questa email non arrivano a ${store}.`,

  waitlist: "Lista d'attesa",
  waitNotices: {
    email: {
      title: "Non sembra un indirizzo email",
      body: "Controllalo e riprova. La conferma va all'indirizzo che scrivi, quindi deve essere uno che puoi aprire.",
    },
    limited: {
      title: "Troppe iscrizioni per ora",
      body: "Perché questo modulo non venga usato per intasare la casella di posta di qualcuno, accetta un numero limitato di iscrizioni all'ora. Riprova tra un'ora.",
    },
    full: {
      title: "Questa lista d'attesa è piena",
      body: "Contiene già tutte le persone che può. Non è stato conservato nulla.",
    },
    closed: {
      title: "Non è più in arrivo",
      body: "Potrebbe essere già in vendita. Non è stato conservato nulla.",
    },
    error: {
      title: "Non siamo riusciti a inviarlo in questo momento",
      body: "Riprova tra un momento.",
    },
    expired: {
      title: "Questo link è scaduto",
      body: "Un link di conferma funziona per 7 giorni. Iscriviti di nuovo dalla pagina del prodotto; bastano pochi secondi.",
    },
  },
  confirmSpotTitle: "Conferma il tuo posto",
  confirmSpotBody: (store, title) =>
    `Premi il pulsante e ${store} ti scriverà una sola volta, quando ${title ? `${title} sarà` : "sarà"} in vendita.`,
  confirmSpotButton: "Conferma il mio posto",
  removeTitle: "Rimuovere il tuo indirizzo?",
  notTold: (title) => `Non ti avviseremo quando ${title ? `${title} sarà` : "sarà"} in vendita.`,
  removeButton: "Rimuovi il mio indirizzo",
  notOnListTitle: "Il tuo indirizzo non è in questa lista d'attesa",
  notOnListBody: "È già stato rimosso, oppure la lista d'attesa ha fatto il suo lavoro e i suoi indirizzi sono stati cancellati.",
  almostThere: "Ci sei quasi",
  waitSentBody: (title, store) =>
    `Ti abbiamo inviato via email un pulsante per confermare il tuo posto nella lista d'attesa${title ? ` per ${title}` : ""}. Arriva da ${store} tramite Marktmorgen. Se non la trovi, guarda nello spam.`,
  waitSentNote: "Il tuo posto conta solo quando lo premi, così un indirizzo scritto male non riceve mai niente.",
  onTheList: "Sei nella lista",
  tellWhenOut: (title) => (title ? `Ti avviseremo quando uscirà ${title}` : "Ti avviseremo quando uscirà"),
  oneEmailDay: "Un'email, il giorno in cui sarà in vendita, con il suo link. È tutto ciò che questa lista d'attesa invia.",
  removedTitle: "Il tuo indirizzo è stato rimosso",

  waitSubject: (title) => `Conferma il tuo posto: ${title}`,
  waitAsked: (store, title) => `Hai chiesto a ${store} di avvisarti quando esce ${title}.`,
  waitOpen: "Apri questo link e premi il pulsante per confermare che eri tu:",
  waitWorks: "Funziona per 7 giorni. Quando esce ricevi un'email con il suo link, ed è l'unica email che questa lista d'attesa invia.",
  waitConsented: (store) =>
    `Hai anche detto che ${store} può inviarti altre email; una volta confermato, sarai nella sua lista e potrai disiscriverti da ognuna di esse.`,
  waitNotConsented: (store) => `Non hai spuntato la casella per ricevere altre notizie da ${store}, quindi non ne riceverai.`,
  waitIgnore: "Se non l'hai chiesto tu, ignora questa email. Non succede nulla finché il pulsante non viene premuto.",
  waitLeave: (link) => `Per togliere il tuo indirizzo da questa lista d'attesa in qualsiasi momento: ${link}`,
  launchSubject: (title) => `${title} è disponibile`,
  launchLead: (store, title, price) =>
    `Hai chiesto a ${store} di avvisarti quando sarebbe uscito ${title}. Ora è disponibile${price ? `, a ${price}` : ""}:`,
  launchWhy: (title) =>
    `Ricevi questa email perché hai aderito alla lista d'attesa per ${title} e hai confermato il tuo indirizzo. È l'unica email che la lista d'attesa invia.`,
  launchLabel: "Rimuovi il mio indirizzo",
  launchAfter: "da questa lista d'attesa.",
  launchLine: (link) => `Rimuovi il mio indirizzo: ${link}`,

  groupMetaTitle: "Prendi il tuo posto",
  groupNotices: {
    sent: {
      title: "Controlla la tua casella di posta",
      body: "Abbiamo inviato un link all'indirizzo che hai scritto. Aprilo e il posto è tuo. Funziona per 24 ore; se entro pochi minuti non arriva nulla, guarda nello spam, poi scrivi di nuovo l'indirizzo qui sotto.",
    },
    email: {
      title: "Non sembra un indirizzo email",
      body: "Controllalo e riprova. Il link va all'indirizzo che scrivi, quindi deve essere uno che puoi aprire.",
    },
    full: {
      title: "Tutti i posti sono stati presi",
      body: "Chi ha acquistato questo ha pagato per un numero preciso di persone, e ogni posto ora è sull'indirizzo di qualcuno. Chiedigli se può acquistarne uno in più.",
    },
    slow: {
      title: "Troppi link richiesti in questo momento",
      body: "Perché questa pagina non venga usata per riempire la casella di posta di qualcuno, invia un numero limitato di link al giorno. Riprova più tardi; nessun posto è stato preso o perso.",
    },
    unavailable: {
      title: "Non siamo riusciti a inviarlo in questo momento",
      body: "Nessun posto è stato preso o perso. Riprova tra un momento.",
    },
    opening: {
      title: "Non siamo riusciti a finire di aprire il tuo posto",
      body: "Riapri il link tra un momento. Se era già tuo, non cambia nulla.",
    },
    expired: {
      title: "Quel link è scaduto",
      body: "Funziona per 24 ore. Scrivi di nuovo il tuo indirizzo qui sotto e ne arriva subito uno nuovo.",
    },
    resting: {
      title: "Questo negozio è in pausa per ora",
      body: "Nessun posto è stato preso o perso. Il negozio torna ad assegnare posti quando inizia il suo prossimo mese, o prima: torna allora e scrivi il tuo indirizzo qui sotto per un nuovo link.",
    },
  },
  groupRefundedTitle: "Questo acquisto è stato rimborsato",
  groupRefundedBody: (title, people) =>
    `${title} è stato acquistato per ${people} persone e il pagamento è stato poi rimborsato per intero, quindi i suoi posti sono chiusi.`,
  alreadyYours: "È già tuo",
  done: "Fatto",
  hasItTitle: "Questo indirizzo ce l'ha già",
  placeYours: "Il posto è tuo",
  placeHas: (title, email) => `${title} era già associato a ${email}, quindi non è stato usato nessun posto.`,
  placeTaken: (title, email) => `${title} ora è associato a ${email}, come se l'avessi acquistato tu. Non ti è stato addebitato nulla.`,
  laterOrders: (address) => `In seguito, vai su ${address}/orders e scrivi questo indirizzo: arriva subito un link a tutto ciò che contiene.`,
  paidForYou: "Pagato per te",
  boughtForPeople: (store, people, open) => `Qualcuno l'ha acquistato da ${store} per ${people} persone e ha condiviso questo link. ${open}`,
  placesLeft: (people, left) =>
    left === 0
      ? `Tutti e ${people} i posti sono stati presi.`
      : left === 1
        ? `È ancora libero ${left} posto su ${people}.`
        : `Sono ancora liberi ${left} posti su ${people}.`,
  sendPlaceLink: "Inviami il link al mio posto",
  placeNote: (title) =>
    `Un link va a quell'indirizzo, e aprirlo occupa un posto e associa ${title} a quell'indirizzo. Non ti viene addebitato nulla. Il tuo indirizzo serve a consegnartelo e a riaprirlo in seguito, e non viene aggiunto a nessuna lista.`,
  alreadyTook: "Hai già preso il tuo?",
  openAgain: "Riaprilo",
  linkToPass: "Il link da condividere",
  copyLink: "Copia il link",
  copied: "Copiato",

  people: (people) => `${people} ${plural(people, "persona", "persone")}`,
  groupReceiptSubject: (people, title) => `I tuoi ${people} posti: ${title}`,
  resentReceipt: (store) => `${store} ci ha chiesto di inviartelo di nuovo. È una copia della tua ricevuta.`,
  forWho: (title, who) => `${title}, per ${who}`,
  passLinkOn: "Condividi questo link con le persone a cui è destinato:",
  eachPerson: (title, people) =>
    `Ogni persona lo apre e scrive il proprio indirizzo email. Riceve un link nella sua casella di posta, e aprirlo associa ${title} a quell'indirizzo, come se l'avesse acquistato. Prendi un posto anche tu allo stesso modo: hai pagato per ${people}, e sei una di loro solo se ne prendi uno.`,
  keepEmail:
    "Conserva questa email: il link è il modo in cui si distribuiscono i posti, e la pagina che apre mostra quanti ne restano. Un rimborso completo ritira tutti i posti.",
  placeAgainSubject: (title) => `Il tuo posto per ${title}`,
  placeAgainLead: (title, store) => `Hai già preso il tuo posto per ${title} di ${store}. Aprilo qui:`,
  takePlaceSubject: (title) => `Prendi il tuo posto per ${title}`,
  takePlaceLead: (title, store, who) =>
    `Qualcuno ha acquistato ${title} da ${store} per ${who} e ha condiviso il link. Questo indirizzo è stato scritto lì per prendere uno dei posti.`,
  openToTake: "Apri questo link per prenderlo:",
  takePlaceNote: (title) =>
    `Associa ${title} a questo indirizzo email, come se l'avessi acquistato tu. Non ti viene addebitato nulla. Il link funziona per 24 ore, e il posto è tuo appena lo apri, finché ce n'è ancora uno libero.`,
  ignoreUnlessOpened: "Se non l'hai chiesto tu, ignora questa email: non succede nulla finché il link non viene aperto.",

  someone: "Qualcuno",
  giftSubject: (who, title) => `${who} ti ha inviato un regalo: ${title}`,
  giftLead: (who, title, store) => `${who} ha acquistato per te ${title} da ${store}.`,
  theirMessage: "Il suo messaggio:",
  giftYours: "È tuo, su questo indirizzo email. Aprilo qui:",
  giftReceiptSubject: (title) => `Il tuo regalo è in arrivo: ${title}`,
  aGift: (title) => `Un regalo: ${title}`,
  giftFor: (email) => `Per: ${email}`,
  weEmailed: (email, withMessage) =>
    `Abbiamo appena inviato un'email a ${email}, con il tuo nome${withMessage ? ", il tuo messaggio" : ""} e un link per aprirlo. È suo, sul suo indirizzo; tu non ne ricevi una copia.`,

  reviewMetaTitle: "La tua recensione",
  orderRefundedTitle: "Questo ordine è stato rimborsato",
  orderRefundedBody: (store) =>
    `Un ordine che ${store} ha rimborsato per intero non può essere recensito. Se ne avevi scritto una recensione, le sue stelle non contano più.`,
  expiredRecover: "Richiedi di nuovo i tuoi acquisti: di solito un nuovo link arriva via email entro un minuto, e da lì puoi lasciare la recensione.",
  expiredReply: (store) => `Rispondi alla conferma d'ordine che ${store} ti ha inviato via email, e il messaggio gli arriverà.`,
  wrongTitle: "Qualcosa è andato storto da parte nostra",
  nothingChanged: "Non è stato modificato nulla. Riprova tra un momento.",
  tooManyTries: "Troppi tentativi",
  tooManyBody: "Questa pagina è stata aperta molte volte in pochi minuti. Aspetta un po', poi riapri il tuo link.",
  cannotReviewTitle: "Questo ordine non può essere recensito qui",
  cannotReviewBody: "Apri il link dalla tua email o dal tuo elenco degli acquisti.",
  getMyPurchases: "Recupera i miei acquisti",
  reviewOne: (title) => `Recensisci ${title}`,
  reviewAll: "Recensisci ciò che hai acquistato",
  boughtFromOn: (store, date) =>
    `Acquistato da ${store}${date ? ` in data ${date}` : ""}. Una recensione sincera è ciò che aiuta il prossimo acquirente, e ${store}.`,

  reviewNotices: {
    saved: "Grazie. La tua recensione ora è sulla pagina.",
    updated: "La tua recensione è stata aggiornata.",
    deleted: "La tua recensione è stata eliminata. Le sue stelle non contano più nella media.",
    rating: "Scegli da una a cinque stelle.",
    refunded: "Questo ordine è stato rimborsato, quindi non può essere recensito.",
    expired: "Questo link è scaduto. Richiedi di nuovo i tuoi acquisti dal negozio e lascia la recensione da lì.",
    no: "Questo ordine non può essere recensito qui.",
    full: "Questo prodotto non può ricevere altre recensioni.",
    noroom: "Questo negozio non ha spazio per altre recensioni in questo momento, quindi la tua non è stata salvata. Riprova più tardi.",
    slow: "Sono stati molti tentativi in poco tempo. Aspetta qualche minuto e inviala di nuovo.",
    busy: "Qualcun altro stava salvando nello stesso momento. Inviala di nuovo.",
    error: "Qualcosa è andato storto da parte nostra. Non è stato modificato nulla. Riprova tra un momento.",
    photo: "Non è stato possibile aggiungere quella foto. Provane un'altra, in JPEG o scattata dalla fotocamera.",
    photoPaused: "La Sua recensione è stata salvata, ma la nuova foto non è stata aggiunta: questo negozio al momento non accetta nuove foto.",
    photoLimit: "La Sua recensione è stata salvata, ma la nuova foto non è stata aggiunta: una recensione può ricevere 3 nuove foto in tutto, e la Sua ne ha già ricevute 3.",
    photoFailed: "La Sua recensione è stata salvata, ma la nuova foto non è stata aggiunta per un problema da parte nostra. Questo tentativo conta comunque come 1 delle 3 nuove foto che una recensione può ricevere.",
    confirmDelete: "Qui non c'è nessuna tua recensione da eliminare.",
    kept: "La tua recensione non è stata eliminata. Non è stato modificato nulla.",
  },
  yourRating: (title) => `Il tuo voto per ${title}`,
  whatYouThink: "Cosa ne pensi (facoltativo)",
  upTo: (written) => `Fino a ${written} caratteri.`,
  nameToShow: "Nome da mostrare (facoltativo)",
  updateReview: "Aggiorna la mia recensione",
  postReview: "Pubblica la mia recensione",
  reviewUnread: (title) => `Al momento non è stato possibile caricare la tua recensione di ${title}. Aggiorna questa pagina tra un momento per vederla o modificarla.`,
  reviewPublic: (store) =>
    `La tua recensione è pubblica sulla pagina di ${store}, segnata come acquisto verificato. Il tuo indirizzo email non viene mai mostrato. ${store} può rispondere e nasconderla, ma non può modificarla.`,
  deleteReview: "Elimina la mia recensione",
  deleteReviewAsk: (title) => `Eliminare la tua recensione di ${title}?`,
  deleteReviewWhat: (stars, hasWords, hasPhoto, store) =>
    `Così elimini ${andList([`il tuo voto di ${stars} ${plural(stars, "stella", "stelle")}`, ...(hasWords ? ["il tuo testo"] : []), ...(hasPhoto ? ["la tua foto"] : [])], "e")} dalla pagina di ${store}. Non si può recuperare.`,
  deleteReviewYes: "Sì, elimina la mia recensione",
  deleteReviewKeep: "Mantieni la mia recensione",
  reviewPhoto: "Aggiungi una foto (facoltativo)",
  reviewPhotoHint: "Una foto di ciò che hai realizzato o di come lo usi. Appare con la tua recensione.",
  reviewPhotoRemove: "Rimuovi la mia foto",
  reviewPhotoYours: "La tua foto",
  reviewPhotoAlt: (name) => `Foto di ${name}`,

  askSubject: (title) => `Com'è ${title}?`,
  listAnd: (list, last) => `${list} e ${last}`,
  askLead: (what, store, date) =>
    `Hai acquistato ${what} da ${store} in data ${date}. Se hai un minuto, ${store} vorrebbe sapere cosa ne pensi, nel bene o nel male.`,
  askHow: "Dagli da una a cinque stelle e qualche parola qui:",
  askElsewhere: (store, site) => `Se ti va, puoi recensire ${store} anche su ${site}. Lo chiediamo allo stesso modo a tutti ed è del tutto facoltativo:`,
  askShows: (store) =>
    `La tua recensione compare sulla pagina di ${store} segnata come acquisto verificato, con il nome che scegli. Il tuo indirizzo email non viene mai mostrato. Lo stesso link ti permette di modificarla o eliminarla per 60 giorni.`,
  askOnly: "Questa è l'unica email sulla recensione di questo ordine.",
  askOneMore: (days) => `Se tra ${days} giorni non avrai ancora scritto una recensione, riceverai un promemoria, e sarà l'ultima email al riguardo.`,
  againSubject: (title) => `Un promemoria: com'è ${title}?`,
  againLead: (what, store, date) =>
    `Qualche giorno fa ${store} ti ha chiesto cosa pensi di ${what}, acquistato in data ${date}. Se hai un minuto, qualche parola è benvenuta, nel bene o nel male.`,
  againOnly: "Questa è l'ultima email sulla recensione di questo ordine.",
  askWhy: (store) => `Ricevi questa email perché hai acquistato da ${store}.`,
  askStopLabel: "Non ricevere più richieste di recensione",
  askStopAfter: (store) => `da ${store} con un clic.`,
  askStopLine: (link) => `Non ricevere più richieste di recensione: ${link}`,

  recoverSubject: (title) => `Hai lasciato ${title} al pagamento`,
  recoverLead: (title, store) => `Hai iniziato ad acquistare ${title} da ${store} e non hai finito, quindi non è stato addebitato nulla.`,
  recoverHere: "Se lo vuoi ancora, è qui:",
  recoverPrice: (price) => `Il prezzo: ${price}. Il pagamento si apre al prezzo di oggi.`,
  youChoosePrice: (price) => `lo scegli tu, a partire da ${price}`,
  recoverOnly: (why) => `Questo è l'unico promemoria su quel pagamento. ${why}`,
  recoverWhyCheckout: (store) => `Ti è arrivato perché hai accettato, nella pagina di pagamento, di ricevere notizie da ${store}.`,
  recoverWhyAsked: (store) => `Ti è arrivato perché l'hai chiesto nel negozio di ${store}.`,
  recoverStop: (store, link) => `Non ricevere più questi promemoria da ${store}: ${link}`,
  /** The email for a reminder asked for on a product's page (lib/checkout-ask.ts). */
  pageAskSubject: (title) => `Un promemoria per ${title}`,
  pageAskLead: (title, store) => `Hai chiesto a ${store} di ricordarti ${title}.`,
  pageAskOnly: (why) => `Questo è l'unico promemoria. ${why}`,
  callSubject: (title) => `Il tuo orario per ${title} non è ancora prenotato`,
  callLead: (title, when, store) => `Hai scelto ${when} per ${title} con ${store} e non hai finito di pagare, quindi non è stato addebitato nulla e l'orario non è stato tenuto per te.`,
  callHere: "Per prenotare, scegli un orario qui:",

  keyLabel: "La tua chiave di licenza",
  keyLabelFor: (title) => `La tua chiave di licenza per ${title}`,
  keyReady: (title) => `La tua chiave di licenza per ${title} è pronta:`,
  keyThanks: (link) => `Grazie per l'attesa. È anche nel tuo elenco degli acquisti: ${link}`,
  keyQuestions: (store) => `Domande? Rispondi a questa email e arriverà a ${store}.`,
  copy: "Copia",
  keyYours: "È solo tua: nessun altro riceve questa chiave. È anche nella tua email di conferma e nel tuo elenco degli acquisti.",
  keyRevoked: (store) =>
    `${store} ha segnato questa chiave come non più valida. Se pensi che sia un errore, rispondi all'email di conferma dell'ordine e il messaggio gli arriverà.`,
  keyWaiting: (store) =>
    `Il tuo pagamento è andato a buon fine proprio quando sono finite le chiavi di ${store}, quindi la tua non è ancora pronta. ${store} è stato avvisato, e ti verrà inviata via email non appena ne aggiungerà altre. Compare anche qui e nel tuo elenco degli acquisti.`,
  keyFailed: "Non è stato possibile mostrare la tua chiave in questo momento. Aggiorna la pagina tra un momento; è conservata per te.",

  ppSubject: (title) => `Il tuo acquisto: ${title}`,
  ppThanks: (store) => `Grazie per aver acquistato da ${store}. Questa è la tua conferma.`,
  ppWhat: (title) => `Cosa hai acquistato: ${title}`,
  ppPaid: (amount) => `Pagato con PayPal: ${amount}`,
  ppTransaction: (id) => `Transazione PayPal: ${id}`,
  ppPaidTo: (store) => `Pagato direttamente sull'account PayPal di ${store}. Per domande, rispondi a questa email e arriveranno a ${store}.`,
};

// =====================================================================================
// Dutch: "je/jij".

const nlSentBy = (store: string) => `Verstuurd door Marktmorgen namens ${store}.`;

const nl: GivingWords = {
  checkInbox: "Kijk in je inbox",
  linkExpired: "Deze link is verlopen",
  emailTitle: "Dat lijkt geen e-mailadres",
  openIt: "Openen",
  openHere: "Open het hier:",
  sentBy: nlSentBy,
  sentWith: "Verstuurd met Marktmorgen.",
  orderRef: (reference) => `Bestelreferentie: ${reference}`,
  paidLine: (amount) => `Betaald: ${amount}`,
  thanksReceipt: (store) => `Bedankt voor je aankoop bij ${store}. Dit is je bon.`,
  chargedBy: (store) => `Afgeschreven door ${store} via het eigen Stripe-account. Vragen komen bij ${store} terecht als je op deze e-mail antwoordt.`,
  link24: (orders) => `Die link werkt 24 uur. Ga daarna naar ${orders}, vul dit adres in en er komt meteen een nieuwe.`,
  ignoreThis: "Heb je hier niet om gevraagd, negeer deze e-mail dan.",
  sentByNothing: (store) => `${nlSentBy(store)} Er is niets bij je afgeschreven.`,

  freeMetaTitle: "Je gratis exemplaar",
  freeNotices: {
    email: {
      title: "Dat lijkt geen e-mailadres",
      body: "Controleer het en probeer het opnieuw. Het exemplaar gaat naar het adres dat je invult, dus het moet een adres zijn dat je kunt openen.",
    },
    limited: {
      title: "Te veel aanvragen op dit moment",
      body: "Om te voorkomen dat dit formulier wordt gebruikt om iemands inbox te overspoelen, neemt het een beperkt aantal aanvragen per uur aan. Probeer het over een uur opnieuw.",
    },
    unavailable: {
      title: "Dit is nu niet beschikbaar",
      body: "Er is niets verstuurd en niets bewaard. De winkel is het misschien nog aan het inrichten.",
    },
    error: {
      title: "We konden het nu niet versturen",
      body: "Er is niets bewaard. Probeer het zo opnieuw.",
    },
  },
  alsoFrom: (store) => `Ook van ${store}`,
  freeFrom: (store) => `Van ${store}. Druk op de knop en het is van jou.`,
  downloadIt: "Downloaden",
  keptOn: (host, store) => `${store} bewaart het op ${host}, niet hier, dus de knop brengt je daarheen.`,
  freeLinkWorks: "De link in je e-mail werkt 7 dagen, dus je kunt het ook op een ander apparaat ophalen.",
  noLongerFree: "Dit is niet meer gratis",
  changedSince: (store) => `${store} heeft het gewijzigd sinds de e-mail is verstuurd, dus het wordt via deze link niet meer gegeven.`,
  freeLinkDays: "De link naar een gratis exemplaar werkt 7 dagen. Vraag de winkel om een nieuwe — dat duurt een paar seconden.",
  sent: "Verstuurd",
  emailedLinkTo: (title) => `We hebben je een link naar ${title} gemaild.`,
  emailedLink: "We hebben je een link gemaild.",
  comesFrom: (store) => `De e-mail komt van ${store} via Marktmorgen. Staat hij er niet, kijk dan in je spam.`,
  joinsOnUse: (store) => `Je adres komt pas op de lijst van ${store} als je die link gebruikt, dus een verkeerd getypt adres komt er nooit op.`,
  freeGone: "Dit wordt niet meer gratis aangeboden.",
  freeNothing: "Hier staat nog niets op. Vraag het de winkel.",

  freeSubject: (title) => `Je exemplaar van ${title}`,
  freeAsked: (store, title) => `Je hebt ${title} aangevraagd bij ${store}. Hier is het:`,
  freeOpen: "Open de link en druk op de knop. Hij werkt 7 dagen.",
  freeConsented: (store) => `Je hebt ook aangegeven dat ${store} je e-mails mag sturen. Je kunt je via elk ervan afmelden.`,
  freeNotConsented: (store) =>
    `Je hebt het vakje om van ${store} te horen niet aangevinkt, dus je adres komt bij hen terecht met de vermelding dat je alleen hierom hebt gevraagd, en verder niets.`,
  freeIgnore: "Heb je hier niet om gevraagd, negeer deze e-mail dan. Er gebeurt niets zolang de link niet wordt gebruikt.",
  freeContact: (store, link) => `Wil je ${store} schrijven? Gebruik het contactformulier op de pagina: ${link}`,
  freeSentBy: (store) =>
    `Verstuurd door Marktmorgen namens ${store}. Marktmorgen gebruikt je adres nergens anders voor, en antwoorden op deze e-mail komen niet aan bij ${store}.`,

  waitlist: "Wachtlijst",
  waitNotices: {
    email: {
      title: "Dat lijkt geen e-mailadres",
      body: "Controleer het en probeer het opnieuw. De bevestiging gaat naar het adres dat je invult, dus het moet een adres zijn dat je kunt openen.",
    },
    limited: {
      title: "Te veel aanmeldingen op dit moment",
      body: "Om te voorkomen dat dit formulier wordt gebruikt om iemands inbox te overspoelen, neemt het een beperkt aantal per uur aan. Probeer het over een uur opnieuw.",
    },
    full: {
      title: "Deze wachtlijst is vol",
      body: "Er staan zoveel mensen op als er passen. Er is niets bewaard.",
    },
    closed: {
      title: "Dit staat niet meer als binnenkort beschikbaar",
      body: "Misschien is het al te koop. Er is niets bewaard.",
    },
    error: {
      title: "We konden het nu niet versturen",
      body: "Probeer het zo opnieuw.",
    },
    expired: {
      title: "Deze link is verlopen",
      body: "Een bevestigingslink werkt 7 dagen. Meld je opnieuw aan via de pagina van het product; dat duurt een paar seconden.",
    },
  },
  confirmSpotTitle: "Bevestig je plek",
  confirmSpotBody: (store, title) => `Druk op de knop en ${store} mailt je één keer, zodra ${title || "het"} te koop is.`,
  confirmSpotButton: "Mijn plek bevestigen",
  removeTitle: "Je adres verwijderen?",
  notTold: (title) => `Je krijgt geen bericht als ${title || "het"} te koop gaat.`,
  removeButton: "Mijn adres verwijderen",
  notOnListTitle: "Je adres staat niet op deze wachtlijst",
  notOnListBody: "Het is al verwijderd, of de wachtlijst heeft haar werk gedaan en de adressen zijn gewist.",
  almostThere: "Bijna klaar",
  waitSentBody: (title, store) =>
    `We hebben je een knop gemaild om je plek op de wachtlijst${title ? ` voor ${title}` : ""} te bevestigen. De e-mail komt van ${store} via Marktmorgen. Staat hij er niet, kijk dan in je spam.`,
  waitSentNote: "Je plek telt pas als je erop drukt, dus een verkeerd getypt adres krijgt nooit iets te horen.",
  onTheList: "Je staat op de lijst",
  tellWhenOut: (title) => `We laten het je weten als ${title || "het"} uit is`,
  oneEmailDay: "Eén e-mail, op de dag dat het te koop gaat, met de link. Meer stuurt deze wachtlijst niet.",
  removedTitle: "Je adres is verwijderd",

  waitSubject: (title) => `Bevestig je plek: ${title}`,
  waitAsked: (store, title) => `Je hebt ${store} gevraagd je te laten weten wanneer ${title} uitkomt.`,
  waitOpen: "Open deze link en druk op de knop om te bevestigen dat jij het was:",
  waitWorks: "Hij werkt 7 dagen. Als het uitkomt, krijg je één e-mail met de link, en dat is de enige e-mail die deze wachtlijst stuurt.",
  waitConsented: (store) =>
    `Je hebt ook aangegeven dat ${store} je andere e-mails mag sturen; zodra je bevestigt, sta je op hun lijst en kun je je via elk ervan afmelden.`,
  waitNotConsented: (store) => `Je hebt het vakje om verder van ${store} te horen niet aangevinkt, dus dat gebeurt ook niet.`,
  waitIgnore: "Heb je hier niet om gevraagd, negeer deze e-mail dan. Er gebeurt niets zolang er niet op de knop wordt gedrukt.",
  waitLeave: (link) => `Om je adres op elk moment van deze wachtlijst te halen: ${link}`,
  launchSubject: (title) => `${title} is uit`,
  launchLead: (store, title, price) =>
    `Je hebt ${store} gevraagd je te laten weten wanneer ${title} uitkwam. Het is nu uit${price ? `, voor ${price}` : ""}:`,
  launchWhy: (title) =>
    `Je ontvangt dit omdat je je hebt aangemeld voor de wachtlijst van ${title} en je adres hebt bevestigd. Het is de enige e-mail die de wachtlijst stuurt.`,
  launchLabel: "Mijn adres verwijderen",
  launchAfter: "van deze wachtlijst.",
  launchLine: (link) => `Mijn adres verwijderen: ${link}`,

  groupMetaTitle: "Neem je plek in",
  groupNotices: {
    sent: {
      title: "Kijk in je inbox",
      body: "We hebben een link gestuurd naar het adres dat je hebt ingevuld. Open hem en de plek is van jou. Hij werkt 24 uur; komt er binnen een paar minuten niets aan, kijk dan in je spam en vul het adres hieronder opnieuw in.",
    },
    email: {
      title: "Dat lijkt geen e-mailadres",
      body: "Controleer het en probeer het opnieuw. De link gaat naar het adres dat je invult, dus het moet een adres zijn dat je kunt openen.",
    },
    full: {
      title: "Alle plekken zijn bezet",
      body: "Wie dit heeft gekocht, heeft voor een vast aantal personen betaald, en elke plek staat nu op iemands adres. Vraag of diegene er nog een kan bijkopen.",
    },
    slow: {
      title: "Er zijn net te veel links aangevraagd",
      body: "Om te voorkomen dat deze pagina wordt gebruikt om iemands inbox te vullen, verstuurt ze een beperkt aantal per dag. Probeer het later opnieuw; er is geen plek ingenomen of verloren gegaan.",
    },
    unavailable: {
      title: "We konden dat nu niet versturen",
      body: "Er is geen plek ingenomen of verloren gegaan. Probeer het zo opnieuw.",
    },
    opening: {
      title: "We konden je plek niet helemaal openen",
      body: "Open de link zo opnieuw. Was de plek al van jou, dan verandert er niets.",
    },
    expired: {
      title: "Die link is verlopen",
      body: "Hij werkt 24 uur. Vul je adres hieronder opnieuw in en er komt meteen een nieuwe.",
    },
    resting: {
      title: "Deze winkel rust even",
      body: "Er is geen plaats genomen of verloren. De winkel geeft weer plaatsen uit wanneer zijn volgende maand begint, of eerder: kom dan terug en vul hieronder je adres in voor een nieuwe link.",
    },
  },
  groupRefundedTitle: "Deze aankoop is terugbetaald",
  groupRefundedBody: (title, people) =>
    `${title} is gekocht voor ${people} personen en de betaling is later volledig terugbetaald, dus de plekken zijn gesloten.`,
  alreadyYours: "Al van jou",
  done: "Klaar",
  hasItTitle: "Dit adres heeft het al",
  placeYours: "De plek is van jou",
  placeHas: (title, email) => `${title} stond al op ${email}, dus er is geen plek gebruikt.`,
  placeTaken: (title, email) => `${title} staat nu op ${email}, alsof je het zelf hebt gekocht. Er is niets bij je afgeschreven.`,
  laterOrders: (address) => `Ga later naar ${address}/orders en vul dit adres in: je krijgt meteen een link naar alles wat erop staat.`,
  paidForYou: "Voor jou betaald",
  boughtForPeople: (store, people, open) => `Iemand heeft dit bij ${store} gekocht voor ${people} personen en deze link doorgestuurd. ${open}`,
  placesLeft: (people, left) =>
    left === 0 ? `Alle ${people} plekken zijn bezet.` : `${left} van de ${people} plekken ${left === 1 ? "is" : "zijn"} nog vrij.`,
  sendPlaceLink: "Stuur me de link naar mijn plek",
  placeNote: (title) =>
    `Er gaat een link naar dat adres, en als je die opent, neem je een plek in en komt ${title} op dat adres. Er wordt niets bij je afgeschreven. Je adres wordt gebruikt om dit over te dragen en het later opnieuw te openen, en het wordt aan geen enkele lijst toegevoegd.`,
  alreadyTook: "Heb je de jouwe al?",
  openAgain: "Open het opnieuw",
  linkToPass: "De link om door te sturen",
  copyLink: "Link kopiëren",
  copied: "Gekopieerd",

  people: (people) => `${people} ${plural(people, "persoon", "personen")}`,
  groupReceiptSubject: (people, title) => `Je ${people} plekken: ${title}`,
  resentReceipt: (store) => `${store} heeft ons gevraagd je dit opnieuw te sturen. Het is een kopie van je bon.`,
  forWho: (title, who) => `${title}, voor ${who}`,
  passLinkOn: "Stuur deze link door naar de mensen voor wie hij bedoeld is:",
  eachPerson: (title, people) =>
    `Iedereen opent hem en vult het eigen e-mailadres in. Diegene krijgt een link in de inbox, en als die wordt geopend, komt ${title} op dat adres te staan, alsof diegene het zelf heeft gekocht. Neem zelf op dezelfde manier een plek: je hebt voor ${people} betaald, en je hoort er alleen bij als je er een neemt.`,
  keepEmail:
    "Bewaar deze e-mail: via de link worden de plekken uitgedeeld, en de pagina die hij opent laat zien hoeveel er nog over zijn. Een volledige terugbetaling neemt alle plekken terug.",
  placeAgainSubject: (title) => `Je plek voor ${title}`,
  placeAgainLead: (title, store) => `Je hebt je plek voor ${title} van ${store} al ingenomen. Open het hier:`,
  takePlaceSubject: (title) => `Neem je plek in voor ${title}`,
  takePlaceLead: (title, store, who) =>
    `Iemand heeft ${title} bij ${store} gekocht voor ${who} en de link doorgestuurd. Dit adres is daar ingevuld om een van de plekken in te nemen.`,
  openToTake: "Open deze link om hem in te nemen:",
  takePlaceNote: (title) =>
    `Daarmee komt ${title} op dit e-mailadres te staan, alsof je het zelf hebt gekocht. Er wordt niets bij je afgeschreven. De link werkt 24 uur, en de plek is van jou zodra hij wordt geopend, zolang er nog een vrij is.`,
  ignoreUnlessOpened: "Heb je hier niet om gevraagd, negeer deze e-mail dan: er gebeurt niets zolang de link niet wordt geopend.",

  someone: "Iemand",
  giftSubject: (who, title) => `${who} heeft je een cadeau gestuurd: ${title}`,
  giftLead: (who, title, store) => `${who} heeft ${title} bij ${store} voor je gekocht.`,
  theirMessage: "Het bericht:",
  giftYours: "Het is van jou, op dit e-mailadres. Open het hier:",
  giftReceiptSubject: (title) => `Je cadeau is onderweg: ${title}`,
  aGift: (title) => `Een cadeau: ${title}`,
  giftFor: (email) => `Voor: ${email}`,
  weEmailed: (email, withMessage) =>
    `We hebben ${email} zojuist gemaild, met je naam${withMessage ? ", je bericht" : ""} en een link om het te openen. Het is van de ontvanger, op diens adres; jij krijgt geen kopie.`,

  reviewMetaTitle: "Je beoordeling",
  orderRefundedTitle: "Deze bestelling is terugbetaald",
  orderRefundedBody: (store) =>
    `Een bestelling die ${store} volledig heeft terugbetaald, kan niet worden beoordeeld. Als je er een beoordeling over hebt geschreven, tellen de sterren daarvan niet meer mee.`,
  expiredRecover: "Vraag je aankopen opnieuw op: meestal komt er binnen een minuut een nieuwe link per e-mail, en van daaruit kun je een beoordeling schrijven.",
  expiredReply: (store) => `Antwoord op de orderbevestiging die ${store} je heeft gemaild, dan komt het bij hen aan.`,
  wrongTitle: "Er ging iets mis aan onze kant",
  nothingChanged: "Er is niets gewijzigd. Probeer het zo opnieuw.",
  tooManyTries: "Te veel pogingen",
  tooManyBody: "Deze pagina is in een paar minuten heel vaak geopend. Wacht even en open je link dan opnieuw.",
  cannotReviewTitle: "Deze bestelling kan hier niet worden beoordeeld",
  cannotReviewBody: "Open de link uit je e-mail of uit je lijst met aankopen.",
  getMyPurchases: "Mijn aankopen ophalen",
  reviewOne: (title) => `Beoordeel ${title}`,
  reviewAll: "Beoordeel wat je hebt gekocht",
  boughtFromOn: (store, date) => `Gekocht bij ${store}${date ? ` op ${date}` : ""}. Een eerlijke beoordeling helpt de volgende koper, en ${store}.`,

  reviewNotices: {
    saved: "Bedankt. Je beoordeling staat nu op de pagina.",
    updated: "Je beoordeling is bijgewerkt.",
    deleted: "Je beoordeling is verwijderd. De sterren tellen niet meer mee in het gemiddelde.",
    rating: "Kies één tot vijf sterren.",
    refunded: "Deze bestelling is terugbetaald, dus ze kan niet worden beoordeeld.",
    expired: "Deze link is verlopen. Vraag je aankopen opnieuw op in de winkel en schrijf van daaruit je beoordeling.",
    no: "Deze bestelling kan hier niet worden beoordeeld.",
    full: "Dit product kan geen beoordelingen meer ontvangen.",
    noroom: "Deze winkel heeft nu geen ruimte voor meer beoordelingen, dus de jouwe is niet bewaard. Probeer het later opnieuw.",
    slow: "Dat waren veel pogingen in korte tijd. Wacht een paar minuten en verstuur het opnieuw.",
    busy: "Iemand anders was op hetzelfde moment aan het opslaan. Verstuur het opnieuw.",
    error: "Er ging iets mis aan onze kant. Er is niets gewijzigd. Probeer het zo opnieuw.",
    photo: "Die foto kon niet worden toegevoegd. Probeer een andere, als JPEG of rechtstreeks van je camera.",
    photoPaused: "Uw review is opgeslagen, maar de nieuwe foto is niet toegevoegd: deze winkel neemt op dit moment geen nieuwe foto's aan.",
    photoLimit: "Uw review is opgeslagen, maar de nieuwe foto is niet toegevoegd: een review kan in totaal 3 nieuwe foto's krijgen, en de uwe heeft er al 3 gehad.",
    photoFailed: "Uw review is opgeslagen, maar de nieuwe foto is niet toegevoegd door een probleem aan onze kant. Deze poging telt toch als 1 van de 3 nieuwe foto's die een review kan krijgen.",
    confirmDelete: "Er staat hier geen beoordeling van je om te verwijderen.",
    kept: "Je beoordeling is niet verwijderd. Er is niets gewijzigd.",
  },
  yourRating: (title) => `Je score voor ${title}`,
  whatYouThink: "Wat je ervan vindt (optioneel)",
  upTo: (written) => `Maximaal ${written} tekens.`,
  nameToShow: "Naam die wordt getoond (optioneel)",
  updateReview: "Mijn beoordeling bijwerken",
  postReview: "Mijn beoordeling plaatsen",
  reviewUnread: (title) => `Je beoordeling van ${title} kon nu niet worden geladen. Vernieuw deze pagina zo meteen om hem te zien of te wijzigen.`,
  reviewPublic: (store) =>
    `Je beoordeling is openbaar op de pagina van ${store}, gemarkeerd als geverifieerde aankoop. Je e-mailadres wordt nooit getoond. ${store} kan erop reageren en haar verbergen, maar niet wijzigen.`,
  deleteReview: "Mijn beoordeling verwijderen",
  deleteReviewAsk: (title) => `Je beoordeling van ${title} verwijderen?`,
  deleteReviewWhat: (stars, hasWords, hasPhoto, store) =>
    `Hiermee verwijder je ${andList([`je score van ${stars} ${plural(stars, "ster", "sterren")}`, ...(hasWords ? ["je tekst"] : []), ...(hasPhoto ? ["je foto"] : [])], "en")} van de pagina van ${store}. Dit kan niet ongedaan worden gemaakt.`,
  deleteReviewYes: "Ja, mijn beoordeling verwijderen",
  deleteReviewKeep: "Mijn beoordeling houden",
  reviewPhoto: "Voeg een foto toe (optioneel)",
  reviewPhotoHint: "Een foto van wat je ermee maakte, of ervan in gebruik. Hij verschijnt bij je beoordeling.",
  reviewPhotoRemove: "Mijn foto verwijderen",
  reviewPhotoYours: "Je foto",
  reviewPhotoAlt: (name) => `Foto van ${name}`,

  askSubject: (title) => `Hoe bevalt ${title}?`,
  listAnd: (list, last) => `${list} en ${last}`,
  askLead: (what, store, date) =>
    `Je hebt ${what} op ${date} bij ${store} gekocht. Als je een minuutje hebt, wil ${store} graag weten wat je ervan vindt, goed of slecht.`,
  askHow: "Geef het hier één tot vijf sterren en een paar woorden:",
  askElsewhere: (store, site) => `Als je wilt, kun je ${store} ook beoordelen op ${site}. Iedereen krijgt dezelfde vraag, en het is helemaal aan jou:`,
  askShows: (store) =>
    `Je beoordeling verschijnt op de pagina van ${store}, gemarkeerd als geverifieerde aankoop, onder de naam die je kiest. Je e-mailadres wordt nooit getoond. Met dezelfde link kun je haar 60 dagen lang wijzigen of verwijderen.`,
  askOnly: "Dit is de enige e-mail over het beoordelen van deze bestelling.",
  askOneMore: (days) => `Heb je over ${days} dagen nog geen beoordeling gegeven, dan krijg je één herinnering, en dat is de laatste e-mail hierover.`,
  againSubject: (title) => `Een herinnering: hoe bevalt ${title}?`,
  againLead: (what, store, date) =>
    `Een paar dagen geleden vroeg ${store} wat je vindt van ${what}, gekocht op ${date}. Als je een minuutje hebt, zijn een paar woorden welkom, goed of slecht.`,
  againOnly: "Dit is de laatste e-mail over het beoordelen van deze bestelling.",
  askWhy: (store) => `Je ontvangt dit omdat je bij ${store} hebt gekocht.`,
  askStopLabel: "Geen beoordelingsverzoeken meer",
  askStopAfter: (store) => `van ${store}, met één klik.`,
  askStopLine: (link) => `Geen beoordelingsverzoeken meer: ${link}`,

  recoverSubject: (title) => `Je hebt ${title} bij het afrekenen laten liggen`,
  recoverLead: (title, store) => `Je begon ${title} bij ${store} te kopen en hebt het niet afgerond, dus er is niets afgeschreven.`,
  recoverHere: "Wil je het nog steeds, dan staat het hier:",
  recoverPrice: (price) => `De prijs: ${price}. Het afrekenen opent tegen de prijs van vandaag.`,
  youChoosePrice: (price) => `je kiest hem zelf, vanaf ${price}`,
  recoverOnly: (why) => `Dit is de enige herinnering over die betaling. ${why}`,
  recoverWhyCheckout: (store) => `Je krijgt dit omdat je op de betaalpagina hebt aangegeven van ${store} te willen horen.`,
  recoverWhyAsked: (store) => `Je krijgt dit omdat je erom hebt gevraagd in de winkel van ${store}.`,
  recoverStop: (store, link) => `Deze herinneringen van ${store} stoppen: ${link}`,
  /** The email for a reminder asked for on a product's page (lib/checkout-ask.ts). */
  pageAskSubject: (title) => `Een herinnering aan ${title}`,
  pageAskLead: (title, store) => `Je vroeg ${store} om je aan ${title} te herinneren.`,
  pageAskOnly: (why) => `Dit is de enige herinnering. ${why}`,
  callSubject: (title) => `Je tijd voor ${title} is nog niet geboekt`,
  callLead: (title, when, store) => `Je koos ${when} voor ${title} bij ${store} en hebt de betaling niet afgerond, dus er is niets afgeschreven en de tijd is niet voor je vastgehouden.`,
  callHere: "Om te boeken, kies je hier een tijd:",

  keyLabel: "Je licentiesleutel",
  keyLabelFor: (title) => `Je licentiesleutel voor ${title}`,
  keyReady: (title) => `Je licentiesleutel voor ${title} staat klaar:`,
  keyThanks: (link) => `Bedankt voor het wachten. Hij staat ook in je lijst met aankopen: ${link}`,
  keyQuestions: (store) => `Vragen? Antwoord op deze e-mail, dan komt het bij ${store} aan.`,
  copy: "Kopiëren",
  keyYours: "Hij is alleen van jou: niemand anders krijgt deze sleutel. Hij staat ook in je bevestigingsmail en in je lijst met aankopen.",
  keyRevoked: (store) =>
    `${store} heeft deze sleutel gemarkeerd als niet meer geldig. Denk je dat dat een vergissing is, antwoord dan op je orderbevestiging en het komt bij hen aan.`,
  keyWaiting: (store) =>
    `Je betaling ging door net toen de sleutels van ${store} op waren, dus de jouwe is nog niet klaar. ${store} is op de hoogte gebracht, en je sleutel wordt je gemaild zodra er nieuwe zijn toegevoegd. Hij verschijnt ook hier en in je lijst met aankopen.`,
  keyFailed: "Je sleutel kon nu niet worden getoond. Vernieuw de pagina zo meteen; hij wordt voor je bewaard.",

  ppSubject: (title) => `Je aankoop: ${title}`,
  ppThanks: (store) => `Bedankt voor je aankoop bij ${store}. Dit is je bevestiging.`,
  ppWhat: (title) => `Wat je hebt gekocht: ${title}`,
  ppPaid: (amount) => `Betaald met PayPal: ${amount}`,
  ppTransaction: (id) => `PayPal-transactie: ${id}`,
  ppPaidTo: (store) => `Betaald op het eigen PayPal-account van ${store}. Vragen komen bij ${store} terecht als je op deze e-mail antwoordt.`,
};

// =====================================================================================
// European Portuguese: the courteous third person ("o seu", "introduza").

const ptSentBy = (store: string) => `Enviado pela Marktmorgen em nome de ${store}.`;

const pt: GivingWords = {
  checkInbox: "Verifique a sua caixa de entrada",
  linkExpired: "Esta ligação expirou",
  emailTitle: "Isso não parece um endereço de email",
  openIt: "Abrir",
  openHere: "Abra-o aqui:",
  sentBy: ptSentBy,
  sentWith: "Enviado com Marktmorgen.",
  orderRef: (reference) => `Referência da encomenda: ${reference}`,
  paidLine: (amount) => `Pago: ${amount}`,
  thanksReceipt: (store) => `Obrigado por comprar a ${store}. Este é o seu recibo.`,
  chargedBy: (store) => `Cobrado por ${store} na sua própria conta Stripe. Para questões, responda a este email e chegarão a ${store}.`,
  link24: (orders) => `Essa ligação funciona durante 24 horas. Depois disso, aceda a ${orders}, introduza este endereço e chega logo uma nova.`,
  ignoreThis: "Se não pediu isto, ignore este email.",
  sentByNothing: (store) => `${ptSentBy(store)} Nada lhe foi cobrado.`,

  freeMetaTitle: "O seu exemplar gratuito",
  freeNotices: {
    email: {
      title: "Isso não parece um endereço de email",
      body: "Verifique-o e tente novamente. O exemplar é enviado para o endereço que introduzir, por isso tem de ser um a que tenha acesso.",
    },
    limited: {
      title: "Demasiados pedidos por agora",
      body: "Para que este formulário não seja usado para inundar a caixa de entrada de alguém, aceita um número limitado de pedidos por hora. Tente novamente dentro de uma hora.",
    },
    unavailable: {
      title: "Isto não está disponível neste momento",
      body: "Nada foi enviado nem guardado. A loja pode ainda estar a prepará-lo.",
    },
    error: {
      title: "Não foi possível enviá-lo neste momento",
      body: "Nada foi guardado. Tente novamente daqui a pouco.",
    },
  },
  alsoFrom: (store) => `Também de ${store}`,
  freeFrom: (store) => `De ${store}. Carregue no botão e é seu.`,
  downloadIt: "Descarregar",
  keptOn: (host, store) => `${store} guarda-o em ${host}, não aqui, por isso o botão leva-o até lá.`,
  freeLinkWorks: "A ligação no seu email funciona durante 7 dias, por isso pode voltar a buscá-lo noutro dispositivo.",
  noLongerFree: "Isto já não é gratuito",
  changedSince: (store) => `${store} alterou-o desde que o email foi enviado, por isso já não é entregue através desta ligação.`,
  freeLinkDays: "A ligação de um exemplar gratuito funciona durante 7 dias. Peça uma nova à loja — demora apenas alguns segundos.",
  sent: "Enviado",
  emailedLinkTo: (title) => `Enviámos-lhe por email uma ligação para ${title}.`,
  emailedLink: "Enviámos-lhe uma ligação por email.",
  comesFrom: (store) => `Chega de ${store} através da Marktmorgen. Se não estiver lá, veja na pasta de spam.`,
  joinsOnUse: (store) =>
    `O seu endereço só entra na lista de ${store} quando utilizar essa ligação, por isso um endereço mal escrito nunca lá fica.`,
  freeGone: "Isto já não é oferecido gratuitamente.",
  freeNothing: "Ainda não há nada aqui. Pergunte à loja.",

  freeSubject: (title) => `O seu exemplar de ${title}`,
  freeAsked: (store, title) => `Pediu ${title} a ${store}. Aqui está:`,
  freeOpen: "Abra a ligação e carregue no botão. Funciona durante 7 dias.",
  freeConsented: (store) => `Também indicou que ${store} lhe pode enviar emails. Pode cancelar a subscrição a partir de qualquer um deles.`,
  freeNotConsented: (store) =>
    `Não assinalou a caixa para receber notícias de ${store}, por isso o seu endereço chega-lhe com a indicação de que pediu apenas isto, e mais nada.`,
  freeIgnore: "Se não pediu isto, ignore este email. Nada acontece a menos que a ligação seja utilizada.",
  freeContact: (store, link) => `Para escrever a ${store}, use o formulário de contacto da página: ${link}`,
  freeSentBy: (store) =>
    `Enviado pela Marktmorgen em nome de ${store}. A Marktmorgen não utiliza o seu endereço para mais nada, e as respostas a este email não chegam a ${store}.`,

  waitlist: "Lista de espera",
  waitNotices: {
    email: {
      title: "Isso não parece um endereço de email",
      body: "Verifique-o e tente novamente. A confirmação é enviada para o endereço que introduzir, por isso tem de ser um a que tenha acesso.",
    },
    limited: {
      title: "Demasiadas inscrições por agora",
      body: "Para que este formulário não seja usado para inundar a caixa de entrada de alguém, aceita um número limitado por hora. Tente novamente dentro de uma hora.",
    },
    full: {
      title: "Esta lista de espera está cheia",
      body: "Já tem tantas pessoas quantas pode ter. Nada foi guardado.",
    },
    closed: {
      title: "Isto já não está marcado como «em breve»",
      body: "Pode já estar à venda. Nada foi guardado.",
    },
    error: {
      title: "Não foi possível enviá-lo neste momento",
      body: "Tente novamente daqui a pouco.",
    },
    expired: {
      title: "Esta ligação expirou",
      body: "Uma ligação de confirmação funciona durante 7 dias. Volte a inscrever-se a partir da página do produto; demora apenas alguns segundos.",
    },
  },
  confirmSpotTitle: "Confirme o seu lugar",
  confirmSpotBody: (store, title) =>
    `Carregue no botão e ${store} envia-lhe um único email quando ${title ? `${title} ficar` : "ficar"} à venda.`,
  confirmSpotButton: "Confirmar o meu lugar",
  removeTitle: "Remover o seu endereço?",
  notTold: (title) => `Não receberá aviso quando ${title ? `${title} ficar` : "ficar"} à venda.`,
  removeButton: "Remover o meu endereço",
  notOnListTitle: "O seu endereço não está nesta lista de espera",
  notOnListBody: "Já foi removido, ou a lista de espera já cumpriu a sua função e os endereços foram apagados.",
  almostThere: "Está quase",
  waitSentBody: (title, store) =>
    `Enviámos-lhe por email um botão para confirmar o seu lugar na lista de espera${title ? ` de ${title}` : ""}. Chega de ${store} através da Marktmorgen. Se não estiver lá, veja na pasta de spam.`,
  waitSentNote: "O seu lugar só conta quando carregar nele, por isso um endereço mal escrito nunca recebe nada.",
  onTheList: "Está na lista",
  tellWhenOut: (title) => (title ? `Receberá um aviso quando ${title} sair` : "Receberá um aviso quando sair"),
  oneEmailDay: "Um email, no dia em que ficar à venda, com a respetiva ligação. É tudo o que esta lista de espera envia.",
  removedTitle: "O seu endereço foi removido",

  waitSubject: (title) => `Confirme o seu lugar: ${title}`,
  waitAsked: (store, title) => `Pediu a ${store} um aviso para quando ${title} sair.`,
  waitOpen: "Abra esta ligação e carregue no botão para confirmar que o pedido foi seu:",
  waitWorks: "Funciona durante 7 dias. Quando sair, recebe um email com a respetiva ligação, e é o único email que esta lista de espera envia.",
  waitConsented: (store) =>
    `Também indicou que ${store} lhe pode enviar outros emails; assim que confirmar, fica na respetiva lista e pode cancelar a subscrição a partir de qualquer um deles.`,
  waitNotConsented: (store) => `Não assinalou a caixa para receber outras notícias de ${store}, por isso não as receberá.`,
  waitIgnore: "Se não pediu isto, ignore este email. Nada acontece a menos que se carregue no botão.",
  waitLeave: (link) => `Para retirar o seu endereço desta lista de espera a qualquer momento: ${link}`,
  launchSubject: (title) => `${title} já está disponível`,
  launchLead: (store, title, price) =>
    `Pediu a ${store} um aviso para quando ${title} saísse. Já está disponível${price ? `, por ${price}` : ""}:`,
  launchWhy: (title) =>
    `Recebe isto porque entrou na lista de espera de ${title} e confirmou o seu endereço. É o único email que a lista de espera envia.`,
  launchLabel: "Remover o meu endereço",
  launchAfter: "desta lista de espera.",
  launchLine: (link) => `Remover o meu endereço: ${link}`,

  groupMetaTitle: "Ocupe o seu lugar",
  groupNotices: {
    sent: {
      title: "Verifique a sua caixa de entrada",
      body: "Enviámos uma ligação para o endereço que introduziu. Abra-a e o lugar é seu. Funciona durante 24 horas; se nada chegar dentro de alguns minutos, veja na pasta de spam e depois introduza novamente o endereço abaixo.",
    },
    email: {
      title: "Isso não parece um endereço de email",
      body: "Verifique-o e tente novamente. A ligação é enviada para o endereço que introduzir, por isso tem de ser um a que tenha acesso.",
    },
    full: {
      title: "Todos os lugares foram ocupados",
      body: "Quem comprou isto pagou por um número definido de pessoas, e cada lugar já está no endereço de alguém. Pergunte a essa pessoa se pode comprar mais um.",
    },
    slow: {
      title: "Foram pedidas demasiadas ligações neste momento",
      body: "Para que esta página não seja usada para encher a caixa de entrada de alguém, envia um número limitado por dia. Tente novamente mais tarde; nenhum lugar foi ocupado nem perdido.",
    },
    unavailable: {
      title: "Não foi possível enviá-la neste momento",
      body: "Nenhum lugar foi ocupado nem perdido. Tente novamente daqui a pouco.",
    },
    opening: {
      title: "Não foi possível terminar de abrir o seu lugar",
      body: "Abra a ligação novamente daqui a pouco. Se o lugar já era seu, nada muda.",
    },
    expired: {
      title: "Essa ligação expirou",
      body: "Funciona durante 24 horas. Introduza novamente o seu endereço abaixo e chega logo uma nova.",
    },
    resting: {
      title: "Esta loja está em pausa por agora",
      body: "Nenhum lugar foi ocupado nem perdido. A loja volta a atribuir lugares quando começa o seu próximo mês, ou antes: volte nessa altura e introduza o seu endereço abaixo para receber uma nova ligação.",
    },
  },
  groupRefundedTitle: "Esta compra foi reembolsada",
  groupRefundedBody: (title, people) =>
    `${title} foi comprado para ${people} pessoas e o pagamento foi depois totalmente reembolsado, por isso os lugares estão fechados.`,
  alreadyYours: "Já é seu",
  done: "Concluído",
  hasItTitle: "Este endereço já o tem",
  placeYours: "O lugar é seu",
  placeHas: (title, email) => `${title} já estava associado a ${email}, por isso não foi usado nenhum lugar.`,
  placeTaken: (title, email) => `${title} está agora associado a ${email}, como se o tivesse comprado. Nada lhe foi cobrado.`,
  laterOrders: (address) => `Mais tarde, aceda a ${address}/orders e introduza este endereço: chega logo uma ligação para tudo o que lá estiver.`,
  paidForYou: "Pago para si",
  boughtForPeople: (store, people, open) => `Alguém comprou isto a ${store} para ${people} pessoas e partilhou esta ligação. ${open}`,
  placesLeft: (people, left) =>
    left === 0
      ? `Os ${people} lugares foram todos ocupados.`
      : left === 1
        ? `Ainda está livre ${left} de ${people} lugares.`
        : `Ainda estão livres ${left} de ${people} lugares.`,
  sendPlaceLink: "Enviar-me a ligação para o meu lugar",
  placeNote: (title) =>
    `É enviada uma ligação para esse endereço; ao abri-la, ocupa um lugar e ${title} fica associado a ele. Nada lhe é cobrado. O seu endereço é usado para lho entregar e para o voltar a abrir mais tarde, e não é adicionado a nenhuma lista.`,
  alreadyTook: "Já ocupou o seu?",
  openAgain: "Abrir novamente",
  linkToPass: "A ligação a partilhar",
  copyLink: "Copiar a ligação",
  copied: "Copiado",

  people: (people) => `${people} ${plural(people, "pessoa", "pessoas")}`,
  groupReceiptSubject: (people, title) => `Os seus ${people} lugares: ${title}`,
  resentReceipt: (store) => `${store} pediu-nos para lhe enviar isto novamente. É uma cópia do seu recibo.`,
  forWho: (title, who) => `${title}, para ${who}`,
  passLinkOn: "Partilhe esta ligação com as pessoas a quem se destina:",
  eachPerson: (title, people) =>
    `Cada pessoa abre-a e introduz o próprio endereço de email. Recebe uma ligação na caixa de entrada e, ao abri-la, ${title} fica associado a esse endereço, como se o tivesse comprado. Ocupe também um lugar da mesma forma: pagou por ${people}, e só é uma delas se ocupar um lugar.`,
  keepEmail:
    "Guarde este email: a ligação é a forma de distribuir os lugares, e a página que abre mostra quantos restam. Um reembolso total retira todos os lugares.",
  placeAgainSubject: (title) => `O seu lugar em ${title}`,
  placeAgainLead: (title, store) => `Já ocupou o seu lugar em ${title} de ${store}. Abra-o aqui:`,
  takePlaceSubject: (title) => `Ocupe o seu lugar em ${title}`,
  takePlaceLead: (title, store, who) =>
    `Alguém comprou ${title} a ${store} para ${who} e partilhou a ligação. Este endereço foi introduzido nela para ocupar um dos lugares.`,
  openToTake: "Abra esta ligação para o ocupar:",
  takePlaceNote: (title) =>
    `Assim, ${title} fica associado a este endereço de email, como se o tivesse comprado. Nada lhe é cobrado. A ligação funciona durante 24 horas, e o lugar é seu assim que for aberta, enquanto ainda houver um livre.`,
  ignoreUnlessOpened: "Se não pediu isto, ignore este email: nada acontece a menos que a ligação seja aberta.",

  someone: "Alguém",
  giftSubject: (who, title) => `${who} enviou-lhe um presente: ${title}`,
  giftLead: (who, title, store) => `${who} comprou-lhe ${title} a ${store}.`,
  theirMessage: "A mensagem:",
  giftYours: "É seu, neste endereço de email. Abra-o aqui:",
  giftReceiptSubject: (title) => `O seu presente está a caminho: ${title}`,
  aGift: (title) => `Um presente: ${title}`,
  giftFor: (email) => `Para: ${email}`,
  weEmailed: (email, withMessage) =>
    `Acabámos de enviar um email para ${email}, com o seu nome${withMessage ? ", a sua mensagem" : ""} e uma ligação para o abrir. É da pessoa, no endereço dela; não recebe uma cópia.`,

  reviewMetaTitle: "A sua avaliação",
  orderRefundedTitle: "Esta encomenda foi reembolsada",
  orderRefundedBody: (store) =>
    `Uma encomenda que ${store} reembolsou na totalidade não pode ser avaliada. Se escreveu uma avaliação a partir dela, as estrelas já não contam.`,
  expiredRecover: "Peça novamente as suas compras: normalmente chega uma nova ligação por email em menos de um minuto, e pode avaliar a partir daí.",
  expiredReply: (store) => `Responda à confirmação da encomenda que ${store} lhe enviou por email, e a mensagem chega-lhe.`,
  wrongTitle: "Algo correu mal do nosso lado",
  nothingChanged: "Nada foi alterado. Tente novamente daqui a pouco.",
  tooManyTries: "Demasiadas tentativas",
  tooManyBody: "Esta página foi aberta muitas vezes em poucos minutos. Aguarde um pouco e volte a abrir a sua ligação.",
  cannotReviewTitle: "Esta encomenda não pode ser avaliada aqui",
  cannotReviewBody: "Abra a ligação do seu email ou da sua lista de compras.",
  getMyPurchases: "Obter as minhas compras",
  reviewOne: (title) => `Avalie ${title}`,
  reviewAll: "Avalie o que comprou",
  boughtFromOn: (store, date) =>
    `Comprado a ${store}${date ? ` em ${date}` : ""}. Uma avaliação honesta é o que ajuda o próximo comprador, e ${store}.`,

  reviewNotices: {
    saved: "Obrigado. A sua avaliação já está na página.",
    updated: "A sua avaliação foi atualizada.",
    deleted: "A sua avaliação foi eliminada. As estrelas já não contam para a média.",
    rating: "Escolha de uma a cinco estrelas.",
    refunded: "Esta encomenda foi reembolsada, por isso não pode ser avaliada.",
    expired: "Esta ligação expirou. Peça novamente as suas compras na loja e avalie a partir daí.",
    no: "Esta encomenda não pode ser avaliada aqui.",
    full: "Este produto não pode receber mais avaliações.",
    noroom: "Esta loja não tem espaço para mais avaliações neste momento, por isso a sua não foi guardada. Tente mais tarde.",
    slow: "Foram muitas tentativas em pouco tempo. Aguarde alguns minutos e envie-a novamente.",
    busy: "Outra pessoa estava a guardar no mesmo momento. Envie-a novamente.",
    error: "Algo correu mal do nosso lado. Nada foi alterado. Tente novamente daqui a pouco.",
    photo: "Não foi possível adicionar essa fotografia. Experimente outra, em JPEG ou tirada diretamente com a câmara.",
    photoPaused: "A sua avaliação foi guardada, mas a nova fotografia não foi adicionada: esta loja não está a aceitar novas fotografias neste momento.",
    photoLimit: "A sua avaliação foi guardada, mas a nova fotografia não foi adicionada: uma avaliação pode receber 3 novas fotografias no total, e a sua já recebeu 3.",
    photoFailed: "A sua avaliação foi guardada, mas a nova fotografia não foi adicionada devido a um problema do nosso lado. Esta tentativa conta na mesma como 1 das 3 novas fotografias que uma avaliação pode receber.",
    confirmDelete: "Não tem aqui nenhuma avaliação para eliminar.",
    kept: "A sua avaliação não foi eliminada. Nada foi alterado.",
  },
  yourRating: (title) => `A sua classificação de ${title}`,
  whatYouThink: "O que achou (opcional)",
  upTo: (written) => `Até ${written} caracteres.`,
  nameToShow: "Nome a mostrar (opcional)",
  updateReview: "Atualizar a minha avaliação",
  postReview: "Publicar a minha avaliação",
  reviewUnread: (title) => `Não foi possível carregar a sua avaliação de ${title} neste momento. Atualize esta página daqui a pouco para a ver ou alterar.`,
  reviewPublic: (store) =>
    `A sua avaliação é pública na página de ${store}, marcada como compra verificada. O seu endereço de email nunca é mostrado. ${store} pode responder e ocultá-la, mas não a pode alterar.`,
  deleteReview: "Eliminar a minha avaliação",
  deleteReviewAsk: (title) => `Eliminar a sua avaliação de ${title}?`,
  deleteReviewWhat: (stars, hasWords, hasPhoto, store) =>
    `Isto elimina ${andList([`a sua classificação de ${stars} ${plural(stars, "estrela", "estrelas")}`, ...(hasWords ? ["o seu texto"] : []), ...(hasPhoto ? ["a sua fotografia"] : [])], "e")} da página de ${store}. Não é possível recuperá-la depois.`,
  deleteReviewYes: "Sim, eliminar a minha avaliação",
  deleteReviewKeep: "Manter a minha avaliação",
  reviewPhoto: "Adicione uma fotografia (opcional)",
  reviewPhotoHint: "Uma fotografia do que fez com ele, ou de como o usa. Aparece com a sua avaliação.",
  reviewPhotoRemove: "Remover a minha fotografia",
  reviewPhotoYours: "A sua fotografia",
  reviewPhotoAlt: (name) => `Fotografia de ${name}`,

  askSubject: (title) => `O que achou de ${title}?`,
  listAnd: (list, last) => `${list} e ${last}`,
  askLead: (what, store, date) =>
    `Comprou ${what} a ${store} em ${date}. Se tiver um minuto, ${store} gostaria de saber o que achou, seja bom ou mau.`,
  askHow: "Dê-lhe de uma a cinco estrelas e algumas palavras aqui:",
  askElsewhere: (store, site) => `Se também quiser, pode avaliar ${store} no ${site}. O pedido é igual para todos e é totalmente opcional:`,
  askShows: (store) =>
    `A sua avaliação aparece na página de ${store} marcada como compra verificada, com o nome que escolher. O seu endereço de email nunca é mostrado. A mesma ligação permite-lhe alterá-la ou eliminá-la durante 60 dias.`,
  askOnly: "Este é o único email sobre a avaliação desta encomenda.",
  askOneMore: (days) => `Se daqui a ${days} dias ainda não a tiver avaliado, recebe um lembrete, e será o último email sobre isto.`,
  againSubject: (title) => `Um lembrete: o que achou de ${title}?`,
  againLead: (what, store, date) =>
    `Há alguns dias, ${store} perguntou-lhe o que achou de ${what}, comprado em ${date}. Se tiver um minuto, algumas palavras são bem-vindas, seja bom ou mau.`,
  againOnly: "Este é o último email sobre a avaliação desta encomenda.",
  askWhy: (store) => `Recebe isto porque comprou a ${store}.`,
  askStopLabel: "Deixar de receber pedidos de avaliação",
  askStopAfter: (store) => `de ${store} com um clique.`,
  askStopLine: (link) => `Deixar de receber pedidos de avaliação: ${link}`,

  recoverSubject: (title) => `Deixou ${title} a meio do pagamento`,
  recoverLead: (title, store) => `Começou a comprar ${title} a ${store} e não terminou, por isso nada foi cobrado.`,
  recoverHere: "Se ainda o quiser, está aqui:",
  recoverPrice: (price) => `O preço: ${price}. O pagamento abre com o preço de hoje.`,
  youChoosePrice: (price) => `escolhido por si, desde ${price}`,
  recoverOnly: (why) => `Este é o único lembrete sobre esse pagamento. ${why}`,
  recoverWhyCheckout: (store) => `Recebeu-o porque aceitou, na página de pagamento, receber notícias de ${store}.`,
  recoverWhyAsked: (store) => `Recebeu-o porque o pediu na loja de ${store}.`,
  recoverStop: (store, link) => `Deixar de receber estes lembretes de ${store}: ${link}`,
  /** The email for a reminder asked for on a product's page (lib/checkout-ask.ts). */
  pageAskSubject: (title) => `Um lembrete sobre ${title}`,
  pageAskLead: (title, store) => `Pediu a ${store} um lembrete sobre ${title}.`,
  pageAskOnly: (why) => `Este é o único lembrete. ${why}`,
  callSubject: (title) => `A sua hora para ${title} ainda não está marcada`,
  callLead: (title, when, store) => `Escolheu ${when} para ${title} com ${store} e não terminou o pagamento, por isso nada foi cobrado e a hora não lhe foi reservada.`,
  callHere: "Para marcar, escolha uma hora aqui:",

  keyLabel: "A sua chave de licença",
  keyLabelFor: (title) => `A sua chave de licença de ${title}`,
  keyReady: (title) => `A sua chave de licença de ${title} está pronta:`,
  keyThanks: (link) => `Obrigado pela espera. Também está na sua lista de compras: ${link}`,
  keyQuestions: (store) => `Tem questões? Responda a este email e a mensagem chega a ${store}.`,
  copy: "Copiar",
  keyYours: "É só sua: mais ninguém recebe esta chave. Também está no seu email de confirmação e na sua lista de compras.",
  keyRevoked: (store) =>
    `${store} marcou esta chave como já não válida. Se achar que se trata de um erro, responda ao email de confirmação da encomenda e a mensagem chega-lhe.`,
  keyWaiting: (store) =>
    `O seu pagamento foi concluído no momento em que as chaves de ${store} se esgotaram, por isso a sua ainda não está pronta. ${store} já recebeu o aviso, e a chave ser-lhe-á enviada por email assim que forem adicionadas mais. Também aparece aqui e na sua lista de compras.`,
  keyFailed: "Não foi possível mostrar a sua chave neste momento. Atualize a página daqui a pouco; está guardada para si.",

  ppSubject: (title) => `A sua compra: ${title}`,
  ppThanks: (store) => `Obrigado por comprar a ${store}. Esta é a sua confirmação.`,
  ppWhat: (title) => `O que comprou: ${title}`,
  ppPaid: (amount) => `Pago com PayPal: ${amount}`,
  ppTransaction: (id) => `Transação PayPal: ${id}`,
  ppPaidTo: (store) => `Pago na própria conta PayPal de ${store}. Para questões, responda a este email e chegarão a ${store}.`,
};

export const GIVING_WORDS: Record<LanguageCode, GivingWords> = { en, es, fr, de, it, nl, pt };

/** The giving words of a store with this language; English for anything else. */
export function givingWords(language: unknown): GivingWords {
  return GIVING_WORDS[parseLanguage(language)];
}

/**
 * What the license key box says (components/licence-key-box.tsx), every
 * sentence already said with the store's name and the product's title in it.
 */
export function licenceKeyBoxWords(language: unknown, storeName: string, title?: string) {
  const g = givingWords(language);
  return {
    label: title ? g.keyLabelFor(title) : g.keyLabel,
    copy: g.copy,
    copied: g.copied,
    yours: g.keyYours,
    revoked: g.keyRevoked(storeName),
    waiting: g.keyWaiting(storeName),
    failed: g.keyFailed,
  };
}

/** What the box with the link to pass on says (components/group-link-box.tsx). */
export function groupLinkBoxWords(language: unknown) {
  const g = givingWords(language);
  return { label: g.linkToPass, copy: g.copyLink, copied: g.copied };
}
