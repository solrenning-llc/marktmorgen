/**
 * The two notices of a PayPal order cancelled because PayPal never confirmed its payment (lib/paypal-sales.ts,
 * watchPayPal, PENDING_GIVE_UP_SECONDS): one to the buyer, one to the creator. Added 12 November 2026 (Claude 7;
 * decision C1-20261112-1102-C7-146, item 2) so a buyer whose payment PayPal held is never left without an answer,
 * also after the creator disconnected PayPal.
 *
 * Marktmorgen never holds the money: PayPal pays a buyer straight into the creator's own PayPal account. So neither
 * notice promises a refund it cannot make; each says what happened, whether any money was taken, and what to do if
 * PayPal completes a pending payment after the cancellation.
 *
 * Each is an email with a text part and an HTML part (a page with its language, one heading and plain paragraphs),
 * counted as one of the order's emails (meter "order"): a cancelled order never gets its receipt, since its record
 * is let go with the cancellation. Each is sent under its own idempotency key, so a try again sends nothing twice.
 */
import { readListing } from "@/lib/catalog";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { formatMoney } from "@/lib/money";
import type { CancelledOrder } from "@/lib/paypal-sales";
import { PENDING_GIVE_UP_SECONDS } from "@/lib/paypal-sales";
import { fromStore, storeBase } from "@/lib/purchase-email";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";

const SUPPORT = "support@marktmorgen.com";
const DAYS = Math.round(PENDING_GIVE_UP_SECONDS / 86_400);

type Notice = { subject: string; heading: string; paragraphs: string[] };

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The text part of a notice: its heading, then its paragraphs. Pure. */
export function noticeText(notice: Notice): string {
  return [notice.heading, "", ...notice.paragraphs.flatMap((p, i) => (i === 0 ? [p] : ["", p]))].join("\n");
}

/** The HTML part of a notice: a page in US English, one heading, plain paragraphs, links written out. Pure. */
export function noticeHtml(notice: Notice): string {
  const paragraphs = notice.paragraphs
    .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1d4ed8">$1</a>')}</p>`)
    .join("");
  return `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(notice.subject)}</title></head><body style="margin:0;padding:24px;background:#ffffff;color:#111111;font:18px/1.6 system-ui,sans-serif"><main style="max-width:40rem;margin:0 auto"><h1 style="font-size:24px;line-height:1.3;margin:0 0 16px">${escapeHtml(notice.heading)}</h1>${paragraphs}</main></body></html>`;
}

/** What the buyer is told. Pure. */
export function buyerNotice(input: { storeName: string; title: string; money: string; order: string; charged: CancelledOrder["charged"]; productLink: string }): Notice {
  const { storeName, title, money, order, charged, productLink } = input;
  return {
    subject: `Your PayPal order for ${title} was cancelled`.slice(0, 200),
    heading: "Your PayPal order was cancelled",
    paragraphs: [
      `Your PayPal order for ${title} from ${storeName} was cancelled. PayPal did not confirm your payment within ${DAYS} days, so you do not get ${title} for this order.`,
      charged === "none"
        ? "You were not charged. PayPal did not take any money for this order."
        : `PayPal still shows your payment as pending. Marktmorgen never holds your money: PayPal pays it straight into the PayPal account of ${storeName}. If PayPal completes this payment later, reply to this email to ask ${storeName} for a refund, or open a dispute in your PayPal account.`,
      `Order: ${order} (PayPal). Amount: ${money}.`,
      `To buy ${title} again, go to ${productLink}`,
      `Questions? Reply to this email to reach ${storeName}.`,
    ],
  };
}

/** What the creator is told. Pure. */
export function creatorNotice(input: { title: string; money: string; order: string; charged: CancelledOrder["charged"]; buyerTold: boolean; disconnected: boolean }): Notice {
  const { title, money, order, charged, buyerTold, disconnected } = input;
  return {
    subject: `A PayPal order was cancelled: ${title}`.slice(0, 200),
    heading: "A PayPal order was cancelled",
    paragraphs: [
      `A buyer's PayPal order for ${title} (${money}) was cancelled, because PayPal did not confirm the payment within ${DAYS} days. The buyer did not get the product.`,
      charged === "none"
        ? "PayPal took no money for this order. There is nothing for you to do."
        : "PayPal still showed the payment as pending. If it reaches your PayPal account later, please refund it in PayPal, because the buyer did not get the product.",
      buyerTold ? "We emailed the buyer to say so." : "PayPal gave us no email address for the buyer, so we could not tell them.",
      `PayPal order: ${order}.`,
      ...(disconnected
        ? [`Your store is no longer connected to PayPal. While other PayPal orders still wait, connect PayPal again in your studio, under Payments, so we can keep checking them: ${SITE_URL}/studio#paypal`]
        : []),
      `Questions? Reply to this email to reach Marktmorgen support.`,
    ],
  };
}

/**
 * Sends both notices for one cancelled order. True when the buyer was told, or PayPal gave no address to tell; false
 * when the sender did not take the buyer's notice, so it is tried again next run (lib/paypal-sales.ts,
 * CANCEL_NOTICE_TRIES). The creator's notice is best effort, under its own key.
 */
export async function tellCancelled(store: Store, cancelled: CancelledOrder): Promise<boolean> {
  const product = await readListing(store, cancelled.product).catch(() => null);
  const title = product?.title || "your order";
  const money = formatMoney(cancelled.cents, cancelled.currency, "en-US");
  let buyerTold = !cancelled.email;
  if (cancelled.email) {
    const notice = buyerNotice({ storeName: store.name, title, money, order: cancelled.order, charged: cancelled.charged, productLink: `${storeBase(store)}/p/${cancelled.product}` });
    buyerTold = await sendEmail({
      meter: { by: "order" },
      from: fromStore(store),
      to: cancelled.email,
      replyTo: store.email,
      subject: notice.subject,
      text: noticeText(notice),
      html: noticeHtml(notice),
      idempotencyKey: `nimbus-paypal-cancel:${cancelled.order}`,
    }).catch(() => false);
  }
  const notice = creatorNotice({ title, money, order: cancelled.order, charged: cancelled.charged, buyerTold: Boolean(cancelled.email) && buyerTold, disconnected: !store.paypalSeller });
  await sendEmail({
    meter: { by: "order" },
    from: NIMBUS_FROM,
    to: store.email,
    replyTo: SUPPORT,
    subject: notice.subject,
    text: noticeText(notice),
    html: noticeHtml(notice),
    idempotencyKey: `nimbus-paypal-cancel-creator:${cancelled.order}`,
  }).catch((error) => console.error("telling a creator of a cancelled PayPal order failed", error));
  return buyerTold;
}
