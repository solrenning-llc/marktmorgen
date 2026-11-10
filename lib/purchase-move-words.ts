/**
 * The words of a buyer's move of their purchases to another email
 * (611 [WP10], unit 3): the page that asks, the page each emailed link
 * opens, what each answer says, and the two emails.
 *
 * US English only for now. The pages and the emails are shown to nobody
 * until lib/purchase-move-open.ts opens them, with the move itself; the
 * store's other languages come with that unit, as the rest of the buyer
 * area has them (lib/buyer-words). Browser-safe: plain data and small
 * functions.
 */

export type Notice = { title: string; body: string };

export const moveWords = {
  title: "Move your purchases to another email",
  lead: (store: string, from: string) =>
    `Your purchases from ${store} are on ${from}. You can move them to another email address that you use.`,
  steps: [
    "Type the new email address and send.",
    "We email a link to each address: the one you use now and the new one.",
    "Open both links and press Confirm on each, within 24 hours.",
  ],
  stepsLabel: "How it works",
  toLabel: "New email address",
  toHint: (from: string) => `It must be different from ${from}. Check it before you send: the link goes there.`,
  send: "Send the two links",
  backToList: "Back to your purchases",
  limitNote: "You can ask 3 times a day. Refunds stay with the order you paid for.",

  confirmTitle: "Confirm the move of your purchases",
  confirmLead: (store: string, from: string, to: string) => `Purchases from ${store} move from ${from} to ${to}.`,
  confirmSide: { from: "This is the address your purchases are on now.", to: "This is the new address for your purchases." },
  confirmButton: "Confirm",
  confirmIgnore: "If you did not ask for this, close this page. Nothing moves without both confirmations.",
  confirmedHere: "This address has confirmed.",

  /** What an ask answers, by the state the route sends back. */
  asked: {
    sent: { title: "Check both inboxes", body: "We sent a link to your current address and one to the new address. Open each one and press Confirm within 24 hours." },
    half: {
      title: "Only one link was sent",
      body: "We emailed your current address, but could not email the new address just now. Nothing will move. Try again later with a new request.",
    },
    unsent: { title: "No links were sent", body: "We could not send the emails just now. Nothing was changed. Try again later." },
    email: { title: "Check the new address", body: "That does not look like an email address. Check it and try again." },
    same: { title: "That is the same address", body: "Type a different email address from the one your purchases are on." },
    over: { title: "Too many requests today", body: "You can ask 3 times a day. Try again tomorrow." },
    deleted: { title: "This move can't be made", body: "This store can't move purchases to or from that address. If you think this is wrong, write to the store." },
    "signed-out": { title: "Your link has expired", body: "Ask for a new link to your purchases, then try again." },
    busy: { title: "The store is busy right now", body: "Nothing was changed. Try again in a few minutes." },
    error: { title: "Something went wrong on our side", body: "We could not tell if your request was saved. Try again in a few minutes." },
  } satisfies Record<string, Notice>,

  /** What a confirmation answers, and what an opened link finds. */
  confirmed: {
    waiting: { title: "Thank you, this address is confirmed", body: "Now open the link we sent to the other address and press Confirm there, within 24 hours." },
    both: { title: "Both addresses are confirmed", body: "Your purchases from this store move to the new address." },
    expired: { title: "This link has expired", body: "The 24 hours are over and nothing moved. You can ask again from your purchases page." },
    done: { title: "Already moved", body: "These purchases were already moved. Nothing else changes." },
    unfinished: {
      title: "Both addresses are confirmed, but the move isn't finished",
      body: "We could not finish moving your purchases just now. Open this link again in a few minutes to finish it. Nothing is lost.",
    },
    limit: {
      title: "These purchases can't be moved here",
      body: "One of these addresses already holds purchases moved from other addresses, so this move can't be made. Nothing moved. If you need help, write to the store.",
    },
    elsewhere: { title: "These purchases already moved", body: "They were moved to another address before. Nothing else changes." },
    link: { title: "This link does not work", body: "It may be mistyped or too old. You can ask again from your purchases page." },
    deleted: { title: "This move can't be made", body: "This store can't move purchases to or from one of these addresses. Nothing moved." },
    busy: { title: "The store is busy right now", body: "Nothing was changed. Open the link again in a few minutes." },
    error: { title: "Something went wrong on our side", body: "We could not tell if your confirmation was saved. Open the link again in a few minutes." },
  } satisfies Record<string, Notice>,

  mailFrom: (store: string) => `${store} via Marktmorgen`,
  oldSubject: (store: string) => `Confirm moving your purchases from ${store}`,
  oldText: (store: string, to: string, link: string) =>
    [
      `You asked to move your purchases from ${store} from this address to ${to}.`,
      "",
      "To confirm, open this link and press Confirm:",
      "",
      link,
      "",
      `We also sent a link to ${to}. Nothing moves until both addresses confirm, within 24 hours. Refunds stay with the order you paid for.`,
      "",
      "If you did not ask for this, ignore this email: nothing moves without your confirmation.",
    ].join("\n"),
  newSubject: (store: string) => `Confirm this address for your purchases from ${store}`,
  newText: (store: string, from: string, link: string) =>
    [
      `Someone using ${from} asked to move their purchases from ${store} to this address.`,
      "",
      "If that was you, open this link and press Confirm:",
      "",
      link,
      "",
      "Nothing moves until both addresses confirm, within 24 hours.",
      "",
      "If you did not ask for this, ignore this email: nothing moves without your confirmation.",
    ].join("\n"),
};

export type AskState = keyof typeof moveWords.asked;
export type ConfirmState = keyof typeof moveWords.confirmed;
