/**
 * The words of the EU withdrawal function for a creator's own Marktmorgen
 * plan (588 [KB9] unit 3; lib/plan-withdrawal.ts): the section of the plan
 * refund page, its answers, the receipt email and the note to support.
 * Plain US English; the two labels are the law's own words (Directive
 * 2011/83/EU art. 11a: "withdraw from contract here", "confirm withdrawal").
 * Browser-safe: plain data and small functions.
 */
import { WITHDRAWAL_WORDS, type WithdrawalWords } from "@/lib/buyer-words/withdrawal";
import { CONFIRM_WITHDRAWAL, WITHDRAW_FROM_CONTRACT } from "@/lib/withdrawal-rules";

const SUPPORT = "support@marktmorgen.com";

/**
 * What happens once a withdrawal is confirmed, said on the page only when the money-back guarantee gives the full
 * refund (lib/plan-withdrawal.ts, planWithdrawWindow): anywhere else it would promise a refund nobody has worked out.
 */
const NEXT =
  "We refund your plan payment in full and end your plan at once, and email you when it is done. If we cannot do that at once, our support team handles it and writes to you.";
/**
 * What happens next when the refund is not known yet: on the page while the payment cannot be read, and in every
 * receipt, which goes before the refund is decided. It promises no amount (Claude 5's ALTO on #2849).
 */
const NEXT_CHECKED =
  "Our support team checks your payment and any refund owed to you, ends your plan, and writes to you.";

export const PLAN_WITHDRAW_WORDS = {
  link: WITHDRAW_FROM_CONTRACT,
  confirm: CONFIRM_WITHDRAWAL,
  title: "Withdraw from your plan",
  lead: (plan: string) =>
    `You can withdraw from your contract for ${plan} within 14 days of paying for it. You do not need to give a reason. This tells Marktmorgen that you are withdrawing.`,
  until: (date: string) => `You can withdraw until ${date}.`,
  noEnd: "We could not check the date of your payment just now, so you can still send your withdrawal. We check it when it arrives.",
  next: NEXT,
  nextChecked: NEXT_CHECKED,
  planLabel: "Your plan",
  subscriptionLabel: "Subscription",
  nameLabel: "Your name",
  nameHint: "The name you want on your withdrawal.",
  emailLabel: "Email for the confirmation",
  emailHint: "We send the receipt of your withdrawal to this address. You can change it.",
  withdrawn: (when: string) => `You withdrew from your plan on ${when}.`,
  receiptSent: "We emailed you a receipt with what you sent and when.",
  receiptUnsent: "We could not email your receipt yet. Confirm again below to get it.",
  receiptGiveUp: `We could not email your receipt. Your withdrawal is recorded with its date and time; email ${SUPPORT} for a copy.`,
  supportUnsent: "We could not pass your refund to our support team yet. Confirm again below to try again.",
  supportGiveUp: (subscription: string) => `We could not pass your refund to our support team. Your withdrawal is recorded with its date and time; email ${SUPPORT} with your subscription ${subscription} to get your refund.`,
  notices: {
    refunded: { tone: "success", title: "Your withdrawal was received and your payment was refunded", body: "Your plan has ended. We sent you an email with the amount. Your bank may take a few days to show the refund." },
    ending: { tone: "success", title: "Your withdrawal was received and your refund is on its way", body: "We end your plan once the refund goes through and email you then." },
    handled: { tone: "success", title: "Your withdrawal was received", body: "We could not refund your payment at once, so our support team handles your refund and writes to you." },
    pending: { tone: "warn", title: "Your withdrawal was received, but your refund is not with our team yet", body: "We could not refund your payment at once, and we could not pass your refund to our support team just now. Confirm again in a few minutes to try again." },
    unreached: { tone: "warn", title: "Your withdrawal was received, but we could not pass on your refund", body: `Your withdrawal is recorded with its date and time. We could not refund your payment at once or reach our support team. Email ${SUPPORT} with your subscription ID to get your refund.` },
    resent: { tone: "success", title: "Your receipt was sent", body: "It shows what you sent and the date and time of your first withdrawal." },
    unsent: { tone: "warn", title: "Your receipt was not sent", body: "Your withdrawal is recorded with its date and time. Try again in a few minutes." },
    already: { tone: "success", title: "You already withdrew from your plan", body: "Nothing more is needed. Your first withdrawal and its date stand." },
    closed: { tone: "warn", title: "Your plan cannot be withdrawn from here", body: `The 14 days to withdraw from it online have passed, or it has no payment to withdraw from. Questions: ${SUPPORT}.` },
    form: { tone: "warn", title: "Check the details", body: "A name and a working email address are needed. Nothing was sent." },
    owner: { tone: "warn", title: "Only the store's owner can withdraw from its plan", body: "Ask the owner of this store to open this page." },
    later: { tone: "warn", title: "Nothing was sent", body: `You tried many times today. Try again tomorrow, or email ${SUPPORT}.` },
    error: { tone: "warn", title: "Your withdrawal was not sent", body: `Something went wrong on our side. Try again in a moment. If it happens again, email ${SUPPORT}.` },
  } as Record<string, { tone: "success" | "warn"; title: string; body: string }>,
};

/** The receipt (art. 11a(4)): the buyer's receipt words, said of Marktmorgen's own contract. */
export const PLAN_ACK_WORDS: WithdrawalWords = {
  ...WITHDRAWAL_WORDS.en,
  ackReceived: (when: string) => `We received your withdrawal from your Marktmorgen plan on ${when}.`,
  ackOrder: "Subscription",
  ackProduct: "Plan",
  ackNext: () => `We end your plan and refund what is owed to you, and email you when it is done. If we cannot do that at once, our support team checks your payment and writes to you. Keep this email: it shows that and when you withdrew.`,
};

/** The note to support when the refund was not made at once. */
export function supportNote(o: { store: string; sid: string; subscription: string; when: string; email: string; why: string }): { subject: string; text: string } {
  return {
    subject: `Withdrawn plan to handle: ${o.store}`,
    text: [
      `A creator withdrew from their plan (Directive 2011/83/EU art. 11a) on ${o.when}. The refund was not made at once.`,
      "",
      `Store: ${o.store} (${o.sid})`,
      `Subscription: ${o.subscription}`,
      `Why not at once: ${o.why}`,
      `Email for the confirmation: ${o.email}`,
      "",
      "Check the payment and the refund owed, end the plan, and write to the creator.",
    ].join("\n"),
  };
}
