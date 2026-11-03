/**
 * What every module keeps about a store's people, and what deleting one of
 * them does to it (added 17 October 2026) — the erasure's counterpart of the
 * cost registry (tests/plan-cost-registry.ts).
 *
 * tests/person-data-registry.test.ts reads the code for every file that may
 * keep something per person (tests/person-data-scan.ts) and fails until that
 * file is here, and fails when an entry says a module is erased by a
 * function that lib/person-erasure.ts does not run. So a module that starts
 * keeping something about a person cannot ship without saying, here, how it
 * is deleted, or why it is kept.
 *
 * The studio's confirmation and the person's own page read the "erased",
 * "kept", "suppression", "expires" and "open" lines below, so what they say
 * is what the code does. Each line is US English, written for the creator.
 *
 *   erased       deleted by the erasure, through the module named in `via`
 *                (the file itself when not given), one of lib/person-erasure.ts ERASERS
 *   suppression  the one-way fingerprint kept so they are never emailed again
 *   kept         kept on purpose, with the reason, and only the fields named
 *   expires      found only by a link's own token; gone by itself within `days`,
 *                and never acted on for a deleted address
 *   open         not reached by the erasure yet; said before anyone deletes
 *   account      a creator's or teammate's own sign-in and account, not a store's people
 *   none         found by the scan, and keeps nothing about a store's people
 */

export type PersonData =
  | { file: string; how: "erased"; what: string; via?: string; only?: ErasureBy }
  | { file: string; how: "suppression"; what: string }
  | { file: string; how: "kept"; what: string; why: string; only?: ErasureBy }
  | { file: string; how: "expires"; what: string; days: number }
  | { file: string; how: "open"; what: string }
  | { file: string; how: "account"; what: string }
  | { file: string; how: "none"; what: string };

const CE = "lib/community-erasure.ts";

/** Who asked, as lib/erasure-rules.ts names the two doors; a line with `only` holds for that door alone. */
type ErasureBy = "team" | "person";

export const PERSON_DATA: PersonData[] = [
  { file: "lib/checkout-sweep.ts", how: "none", what: "Checkout observations are inactive: there is no production persistence policy. Synthetic integration tests may keep a hashed checkout reference, provider creation time, country/state, currency and gross amount under an absolute expiry of at most one day. No name, email or street address is kept; fiscal coverage remains incomplete. Enabling real records needs a separate scope, retention, erasure and cost review." },
  { file: "lib/redis-memory.ts", how: "none", what: "In-memory database adapter: follows callers' keys and deletions and keeps no separate per-person index" },
  // ---------------------------------------------------------------- the list and email
  { file: "lib/contacts.ts", how: "erased", what: "Their row on your list: address, name, labels, what they asked for or bought, and whether they agreed to hear from you" },
  { file: "lib/contacts.ts", how: "erased", what: "The link in your emails that unsubscribes them" },
  { file: "lib/suppression.ts", how: "suppression", what: "A one-way fingerprint of the address, so your store never emails it again and no import puts it back. It cannot be turned back into the address. Only the person can lift it, by joining your list again themselves." },
  { file: "lib/joined-stores.ts", how: "erased", via: "lib/buyer-library.ts", what: "The note that they joined your list, used to find them when they ask to be deleted everywhere" },
  { file: "lib/mail-clicks.ts", how: "erased", what: "Which links in your sequences' emails they used" },
  { file: "lib/mail-health.ts", how: "erased", what: "The mark that their address was counted in this week's delivery checks" },
  { file: "lib/flows.ts", how: "erased", what: "Their way through every sequence and workflow, and any step still waiting to reach them" },
  { file: "lib/flow-runs.ts", how: "erased", via: "lib/flows.ts", what: "Each workflow run's record and history" },
  { file: "lib/broadcasts.ts", how: "expires", days: 60, what: "A broadcast already going out keeps its list of addresses until it finishes; a deleted address on it is passed over, never written to" },
  { file: "lib/product-updates.ts", how: "expires", days: 60, what: "An update email already going out keeps its addresses until it finishes; a deleted address is passed over" },
  { file: "lib/product-updates.ts", how: "suppression", what: "If they had pressed stop on update emails, that one-way mark stays, as their own no" },
  { file: "lib/review-requests.ts", how: "suppression", what: "If they had pressed stop on review requests, that one-way mark stays, as their own no" },
  { file: "lib/checkout-recovery.ts", how: "suppression", what: "If they had pressed stop on checkout reminders, that one-way mark stays, as their own no" },
  { file: "lib/checkout-recovery.ts", how: "erased", what: "The marks that they heard a checkout reminder about a product this week" },
  { file: "lib/checkout-ask.ts", how: "expires", days: 1, what: "A checkout reminder they asked for in the last hour waits in its queue; it is not sent to a deleted address" },
  { file: "lib/review-ask.ts", how: "none", what: "Review requests wait for their day by the order's reference, never by address, and are not sent to a deleted address" },
  { file: "lib/welcome-offer-send.ts", how: "erased", what: "When their welcome offer began, and that its reminder was set" },
  { file: "lib/winback-send.ts", how: "erased", what: "The marks that they heard a come-back offer about a product" },
  { file: "lib/erasure-index.ts", how: "erased", what: "Every link your store emailed them that is still kept: stop links, waitlist links, review links, free-product and sign-up links" },
  { file: "lib/email-sync.ts", how: "erased", what: "The record of sending them to your connected email platform, and any send still waiting" },
  { file: "lib/email-sync.ts", how: "expires", days: 30, what: "A one-way mark that a sign-up or purchase was already sent to your email platform. What the platform took is in your own account there: delete them there too" },
  { file: "lib/segments.ts", how: "erased", what: "The ten-minute copy of your buyers that segments are read from" },
  { file: "lib/member-health.ts", how: "erased", what: "The ten-minute copy of your members' scores" },
  { file: "lib/inbox.ts", how: "erased", what: "Their conversations in your inbox: what they wrote and what you answered" },
  { file: "lib/imports.ts", how: "expires", days: 14, what: "A file you imported is kept for 14 days after the import began, then deleted with everything in it" },

  // ---------------------------------------------------------------- what the store keeps about them
  { file: "lib/crm.ts", how: "erased", what: "Your fields about them, and every deal with them" },
  { file: "lib/agreement-store.ts", how: "erased", what: "Every proposal and agreement you sent them, each version's text and any signature they gave: their name and address, the name they typed, when, and the one-way code made from their internet address. One waiting for a signature stops taking one. The signed copies already emailed stay with whoever received them" },
  { file: "lib/payment-request-store.ts", how: "erased", what: "Every payment request you sent them: their name and address, what it asked for and what became of it. An open one is withdrawn, so its link stops working and no reminder goes. What they paid stays on your Stripe account" },
  { file: "lib/buyer-profile.ts", how: "erased", what: "Your team's notes about them" },
  { file: "lib/buyer-profile.ts", how: "expires", days: 1, what: "A search for their page in the studio works for an hour" },
  { file: "lib/form-store.ts", how: "erased", what: "Every answer they gave to your forms, with each quiz result and score kept with it" },
  { file: "lib/waitlist.ts", how: "erased", what: "Their place on every waitlist, and in any launch email still going out" },
  { file: "lib/affiliate-bond.ts", how: "erased", what: "Which affiliate they belong to" },
  { file: "lib/affiliate-leads.ts", how: "erased", what: "Their address on a lead an affiliate was credited for (a sign-up, a free product claimed or a call booked); the lead stays without it, as the affiliate's money record" },
  { file: "lib/affiliate-leads.ts", how: "suppression", what: "A one-way fingerprint of the address in your affiliate program, the lead's id, so the same person is never counted as a new lead again. It cannot be turned back into the address." },
  { file: "lib/affiliates.ts", how: "kept", what: "Commissions an affiliate earned on their purchases", why: "They are the affiliate's money records, paid or owed, and name the sale, not the buyer's address." },
  { file: "lib/affiliates.ts", how: "account", what: "An affiliate's own account in a store's program; a buyer is not one" },
  { file: "lib/affiliate-hub.ts", how: "account", what: "An affiliate's own sign-in to their programs, by a one-way hash" },
  { file: "lib/imported-purchases.ts", how: "erased", only: "person", what: "What an import from another platform gave them here. Nothing was paid here for it, so they lose access to it" },
  { file: "lib/imported-purchases.ts", how: "kept", only: "team", what: "What an import from another platform gave them here", why: "It is how they keep what they bought on your old platform. They can delete it themselves, from your store's privacy link." },
  { file: "lib/move-members.ts", how: "erased", what: "The invitations an import gave them to keep a membership here, with their links and reminders" },
  { file: "lib/reviews.ts", how: "erased", only: "person", what: "Their reviews, with their photos; their stars leave your averages" },
  { file: "lib/reviews.ts", how: "kept", only: "team", what: "Reviews they wrote, under the name they chose, without their address", why: "A store may not take down a review by deleting its writer (the FTC's rule on consumer reviews). They can delete it themselves, or delete themselves from your store's privacy link." },
  { file: "lib/review-proof.ts", how: "erased", via: "lib/erasure-index.ts", what: "The links that let them write a review" },

  // ---------------------------------------------------------------- courses
  { file: "lib/learn.ts", how: "erased", what: "Their progress in your courses: when they began and came back, the lessons they marked done, the drip emails sent them, and every browser let in with their address" },
  { file: "lib/learn.ts", how: "expires", days: 1, what: "A sign-in link to a course already emailed works for an hour" },
  { file: "lib/course-finish.ts", how: "erased", what: "The marks that they opened and finished each course" },
  { file: "lib/quiz.ts", how: "erased", what: "Their quiz tries, results and passes" },
  { file: "lib/assignment.ts", how: "erased", what: "The work they handed in for assignments, files included, and your feedback on it" },
  { file: "lib/certificate.ts", how: "erased", what: "Their certificates; a certificate's page then says it was not found" },
  { file: "lib/lesson-comments.ts", how: "erased", what: "Their comments under lessons, the answers under them, and the name they chose" },
  { file: "lib/podcast-access.ts", how: "erased", what: "Their private podcast feeds" },
  { file: "lib/discord-store.ts", how: "erased", via: "lib/discord-access.ts", what: "Their Discord account, and the roles they were given are taken back in your server" },
  { file: "lib/discord-access.ts", how: "erased", what: "The answers kept about whether they may have Discord roles" },

  // ---------------------------------------------------------------- the community
  { file: "lib/community.ts", how: "erased", via: CE, what: "Their community member record: address, name, handle, answers to your questions and their place in the directory" },
  { file: "lib/community-mentions.ts", how: "erased", via: CE, what: "The handle others used to mention them" },
  { file: "lib/community-points.ts", how: "erased", via: CE, what: "Their points, rewards and places on the leaderboards" },
  { file: "lib/community-notify.ts", how: "erased", via: CE, what: "What the community told them, and when they last looked" },
  { file: "lib/community-push.ts", how: "erased", via: CE, what: "The devices they let the community notify" },
  { file: "lib/community-dm.ts", how: "erased", via: CE, what: "Their private conversations and requests, for both people in each" },
  { file: "lib/community-chat.ts", how: "erased", via: CE, what: "What they said in the community's room" },
  { file: "lib/chat-grant.ts", how: "erased", via: CE, what: "The leave they held in the room" },
  { file: "lib/community-events.ts", how: "erased", via: CE, what: "Their answers to whether they are coming to each live event" },
  { file: "lib/community-access.ts", how: "erased", via: CE, what: "The answers kept about whether they may come into the community and its spaces" },
  { file: "lib/community-mail.ts", how: "erased", via: CE, what: "The link that stops your announcement emails to them" },
  { file: "lib/community-search.ts", how: "erased", via: CE, what: "Their place in the community's member search" },
  { file: "lib/community-index.ts", how: "erased", via: CE, what: "Their place in the community's member search" },
  { file: "lib/community-found.ts", how: "erased", via: CE, what: "The answers kept about which courses they may find in the community's search" },
  // The two above are kept under keys their neighbors make and forget: lib/community-index.ts and lib/community-access.ts.
  { file: "lib/community-event-mail.ts", how: "expires", days: 30, what: "An event email already going out keeps its readers until it finishes; a deleted member is passed over" },
  { file: "lib/community.ts", how: "open", what: "Posts and comments they wrote in your community, and their likes and reports, stay, shown without their name. Delete them from the community if they ask." },
  { file: "lib/community-polls.ts", how: "open", what: "Their votes in community polls stay in the totals, without their name" },
  { file: "lib/community-dm.ts", how: "kept", what: "Another member's choice to decline their messages", why: "It is that other member's protection, and holds only a one-way key." },

  // ---------------------------------------------------------------- orders and money
  { file: "lib/paypal-sales.ts", how: "kept", what: "PayPal orders: the order and capture ids, the product, the amount, the date, the buyer's address and, for something opened right away, the box they checked before paying (\"yes\", the version and kind of its words and the time)", why: "They are the sale's own record, kept 400 days for refunds, disputes and your books, and nowhere else but in PayPal." },
  { file: "lib/licence-keys.ts", how: "kept", what: "License keys sold: the key, the sale it came from and the buyer's address", why: "The key is what was bought; it stays theirs, and the sale needs it for refunds." },
  { file: "lib/gifts.ts", how: "kept", what: "Gifts bought: who paid, who it was for, and the payment", why: "They are the order's record, for refunds and delivery." },
  { file: "lib/group-buy.ts", how: "kept", what: "Places bought for a group: the purchase and the address each place went to", why: "They are the order's record, for refunds and delivery." },
  { file: "lib/preorders.ts", how: "kept", what: "Pre-orders: who paid and what became of the order", why: "They are the order's record until it is delivered or refunded." },
  { file: "lib/call-packages.ts", how: "kept", what: "Packages of calls bought: the buyer's address and the sessions left", why: "They are the order's record: the calls still owed to them." },
  { file: "lib/meet-records.ts", how: "kept", what: "For a booked group call still to happen, their place on the meeting's guest list, until 60 days after the call", why: "It is how they get into the call they paid for." },
  { file: "lib/shipments.ts", how: "kept", what: "When a physical order was marked shipped, and its tracking link, for 400 days", why: "They are the order's delivery record." },
  { file: "lib/stripe-account.ts", how: "kept", what: "Payments on your own Stripe account: what they paid, when, for what, refunds, their billing details, and, for something opened right away, the box they checked to start access at once (\"yes\", the version of its words and the time)", why: "They are your sales and tax records. Marktmorgen never stores them; delete or keep them in Stripe as the law that applies to you says." },

  // ---------------------------------------------------------------- links and limits that run out by themselves
  { file: "lib/free.ts", how: "erased", via: "lib/erasure-index.ts", what: "Their free-product links" },
  { file: "lib/free.ts", how: "expires", days: 1, what: "Counts that limit how often one address may ask, as one-way hashes, for an hour" },
  { file: "lib/store-join.ts", how: "erased", via: "lib/erasure-index.ts", what: "Their sign-up confirmation links" },
  { file: "lib/buyer-orders.ts", how: "expires", days: 1, what: "A link to their purchases already emailed works for 24 hours" },
  { file: "lib/membership-manage.ts", how: "expires", days: 1, what: "A link to manage their membership already emailed works for an hour" },
  { file: "lib/request-guard.ts", how: "expires", days: 32, what: "Counts that limit how often one address may ask for things, kept as one-way hashes for at most 32 days" },
  { file: "lib/buyer-library.ts", how: "erased", what: "The note that they bought from your store, used for their library across stores" },
  { file: "lib/buyer-library.ts", how: "expires", days: 1, what: "A link to their library across stores works for 24 hours" },
  { file: "lib/checkout-recovery.ts", how: "expires", days: 7, what: "The mark that they heard about a cart of several products, a one-way hash, for a week" },
  { file: "lib/welcome-offer-send.ts", how: "expires", days: 7, what: "A welcome reminder waiting for its hour is not sent to a deleted address" },
  { file: "lib/erasure-request.ts", how: "expires", days: 1, what: "The emailed link with which a person deletes themselves works for an hour, then is deleted" },
  { file: "lib/webhooks.ts", how: "expires", days: 7, what: "Events your webhooks already sent, kept for seven days, as your endpoint received them" },

  // ---------------------------------------------------------------- not a store's people
  { file: "app/api/creators/route.ts", how: "account", what: "Answers creators send to Marktmorgen's own research, with their own retention" },
  { file: "lib/auth.ts", how: "account", what: "Sign-in sessions, links and devices of an account" },
  { file: "lib/passkeys.ts", how: "account", what: "An account's passkeys" },
  { file: "lib/two-step.ts", how: "account", what: "An account's two-step sign-in" },
  { file: "lib/recovery-address.ts", how: "account", what: "An account's recovery address" },
  { file: "lib/partner-invites.ts", how: "account", what: "Invitations to Marktmorgen's partner offer, by a one-way hash" },
  { file: "lib/creator-invites.ts", how: "account", what: "Which store invited which store" },
  { file: "lib/team.ts", how: "account", what: "A store's team and invitations" },
  { file: "lib/store.ts", how: "account", what: "Which stores an account owns" },
  { file: "lib/phone-alerts.ts", how: "account", what: "The creator's own phone, and one-way marks of events already told" },
  { file: "lib/path.ts", how: "account", what: "The store owner's own Path: their four answers, days, best level, cached facts and optional mission-board token/count/time; private record downloadable only by the owner through /api/store/path, board removed when Path/store is deleted, nothing about a buyer" },
  { file: "lib/stats-report.ts", how: "none", what: "Weekly reports to the store's own team; no buyer's address" },
  { file: "lib/traffic.ts", how: "none", what: "Visits counted by a keyed one-way fingerprint of the network address, two days; no email address" },
  { file: "lib/answers.ts", how: "none", what: "Answers to visitors' questions, never who asked" },
  { file: "lib/store-assistant.ts", how: "expires", days: 1, what: "What they asked your Store assistant and its replies, under a random code only their browser holds and with no name or address, deleted a day after the last message, or at once when they press Delete this chat" },
  { file: "lib/store-assistant.ts", how: "none", what: "Questions your Store assistant could not answer, with the day, never who asked; what they chose to send you goes into your inbox, deleted with it" },
  { file: "lib/closing-buyers.ts", how: "kept", what: "Only while your store is closing: the address of each buyer we emailed that it closes, so nobody is emailed twice and each can be told if it stays open", why: "Needed to tell them once, at least 7 days before the store closes, as the checkout promised; deleted the day the store closes or the day it stays open, and never used for anything else" },
  { file: "lib/plan-refund-flow.ts", how: "none", what: "A plan refund in progress is noted by the store's id and its subscription only; the emails about it are sent to the store's own address read from the store at the time, and nothing of it is kept here" },
  { file: "lib/closing-plan-guard.ts", how: "kept", what: "Only if a plan is paid for your store after its closing day began: your address, your Stripe customer and the store's name", why: "Needed to end that plan, return its payment in full and tell you so; deleted as soon as that is done (only the dates are kept 40 days, so it is never done twice and a refund your bank sends back is made again)" },
  { file: "lib/closing-holds.ts", how: "kept", what: "Only while your store is closing: each member's address on Stripe and last payment (its amount and period), from the day your plan ended", why: "Needed to give back the time they paid for after the closing day, from your own Stripe account, and to tell them if it could not be; deleted the day the store closes or the day it stays open" },
  { file: "lib/assistant-reminder.ts", how: "erased", what: "A checkout reminder they asked for with your Store assistant's box at checkout: the address they typed, the sentence they checked, when and its version. Deleted by itself three days after that checkout opened, sent or not" },
  { file: "lib/next-offer.ts", how: "expires", days: 3, what: "The one next product your Store assistant suggested after an order, under the order's reference and with no name or address, deleted three days later; what the buyer already owns is read from your Stripe account to leave it out, and not kept" },
  { file: "lib/yearly-ask.ts", how: "none", what: "Marks that a membership's yearly offer went, by its Stripe subscription, never by address" },
];

/** Whether a line holds for this door. */
const holdsFor = (d: PersonData, door?: ErasureBy) => !door || !("only" in d) || !d.only || d.only === door;

/** The lines of one kind, each said once, in the order above; for one door when given. */
export function linesOf(how: PersonData["how"], door?: ErasureBy): string[] {
  return [...new Set(PERSON_DATA.filter((d) => d.how === how && holdsFor(d, door)).map((d) => d.what))];
}

/** The reasons beside the kept lines, in the same order; for one door when given. */
export function keptLines(door?: ErasureBy): { what: string; why: string }[] {
  const seen = new Set<string>();
  return PERSON_DATA.flatMap((d) => (d.how === "kept" && holdsFor(d, door) && !seen.has(d.what) && seen.add(d.what) ? [{ what: d.what, why: d.why }] : []));
}
