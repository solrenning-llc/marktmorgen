/**
 * The two notices of a PayPal order canceled because PayPal never confirmed its payment (lib/paypal-sales.ts,
 * watchPayPal, PENDING_GIVE_UP_SECONDS): one to the buyer, one to the creator. Added 12 November 2026 (Claude 7;
 * decision C1-20261112-1102-C7-146, item 2) so a buyer whose payment PayPal held is never left without an answer,
 * also after the creator disconnected PayPal.
 *
 * Marktmorgen never holds the money: PayPal pays a buyer straight into the creator's own PayPal account. So neither
 * notice promises a refund it cannot make; each says what happened, whether any money was taken, and what to do if
 * PayPal completes a pending payment after the cancellation.
 *
 * Each is an email with a text part and an HTML part (a page with its language, one heading and plain paragraphs),
 * counted as one of the order's emails (meter "order"): a canceled order never gets its receipt, since its record
 * is let go with the cancellation. The buyer's is in the store's language (lib/buyer-words/paypal-cancel.ts), like the
 * receipt; the creator's is in English, like every other notice to a creator (lib/account-notice.ts). Each is sent
 * under its own idempotency key, and each is tried again only when the sender certainly refused it.
 */
import { readListing } from "@/lib/catalog";
import { NIMBUS_FROM, sendEmailOutcome } from "@/lib/email";
import { formatMoney } from "@/lib/money";
import type { CanceledOrder, TellOutcomes, TellWho } from "@/lib/paypal-sales";
import { PENDING_GIVE_UP_SECONDS } from "@/lib/paypal-sales";
import { paypalCancelWords } from "@/lib/buyer-words/paypal-cancel";
import { fromStore, storeBase } from "@/lib/purchase-email";
import { SITE_URL } from "@/lib/site-url";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import type { Store } from "@/lib/store";

const SUPPORT = "support@marktmorgen.com";
const DAYS = Math.round(PENDING_GIVE_UP_SECONDS / 86_400);

type Notice = { subject: string; heading: string; paragraphs: string[] };

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The text part of a notice: its heading, then its paragraphs. Pure. */
export function noticeText(notice: Notice): string {
  return [notice.heading, "", ...notice.paragraphs.flatMap((p, i) => (i === 0 ? [p] : ["", p]))].join("\n");
}

/** The HTML part of a notice: a page in its language (US English unless said), one heading, plain paragraphs, links written out. Pure. */
export function noticeHtml(notice: Notice, lang = "en-US"): string {
  const paragraphs = notice.paragraphs
    .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1d4ed8">$1</a>')}</p>`)
    .join("");
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(notice.subject)}</title></head><body style="margin:0;padding:24px;background:#ffffff;color:#111111;font:18px/1.6 system-ui,sans-serif"><main style="max-width:40rem;margin:0 auto"><h1 style="font-size:24px;line-height:1.3;margin:0 0 16px">${escapeHtml(notice.heading)}</h1>${paragraphs}</main></body></html>`;
}

/** What the buyer is told, in the store's language (English for anything else). Pure. */
export function buyerNotice(input: { language: unknown; storeName: string; title: string; money: string; order: string; charged: CanceledOrder["charged"]; productLink: string }): Notice {
  const { storeName, title, money, order, charged, productLink } = input;
  const w = paypalCancelWords(input.language);
  return {
    subject: w.subject(title).slice(0, 200),
    heading: w.heading,
    paragraphs: [
      w.canceled(title, storeName, DAYS),
      charged === "none" ? w.notCharged : w.pending(storeName),
      w.orderLine(order, money),
      w.buyAgain(title, productLink),
      w.questions(storeName),
    ],
  };
}

/** What the creator is told. Pure. */
export function creatorNotice(input: { title: string; money: string; order: string; charged: CanceledOrder["charged"]; hasAddress: boolean; disconnected: boolean }): Notice {
  const { title, money, order, charged, hasAddress, disconnected } = input;
  return {
    subject: `A PayPal order was canceled: ${title}`.slice(0, 200),
    heading: "A PayPal order was canceled",
    paragraphs: [
      `A buyer's PayPal order for ${title} (${money}) was canceled, because PayPal did not confirm the payment within ${DAYS} days. The buyer did not get the product.`,
      charged === "none"
        ? "PayPal took no money for this order. There is nothing for you to do."
        : "PayPal still showed the payment as pending. If it reaches your PayPal account later, please refund it in PayPal, because the buyer did not get the product.",
      hasAddress
        ? "We email the buyer to say so, and keep trying until the email goes. The page PayPal sends them back to says so too."
        : "PayPal gave us no email address for the buyer, so we could not email them. The page PayPal sends them back to says the order was canceled.",
      `PayPal order: ${order}.`,
      ...(disconnected
        ? [`Your store is no longer connected to PayPal. While other PayPal orders still wait, connect PayPal again in your studio, under Payments, so we can keep checking them: ${SITE_URL}/studio#paypal`]
        : []),
      `Questions? Reply to this email to reach Marktmorgen support.`,
    ],
  };
}

/**
 * Tells of one canceled order (lib/paypal-sales.ts, cancelOrder and retryCancelNotices): the buyer and the creator at
 * the cancellation ("both"), then either one on its own while the sender refused it. Returns what became of each, the
 * sender's own outcome (only "refused" is tried again); "none" for a side not asked, and for a buyer PayPal gave no
 * address for (then the creator's notice says so, and the page the buyer comes back to says the order was canceled).
 */
export async function tellCanceled(store: Store, canceled: CanceledOrder, who: TellWho): Promise<TellOutcomes> {
  const product = await readListing(store, canceled.product).catch(() => null);
  const title = product?.title || "your order";
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  const told: TellOutcomes = { buyer: "none", creator: "none" };
  if (who !== "creator" && canceled.email) {
    const notice = buyerNotice({
      language: store.language,
      storeName: store.name,
      title,
      money: formatMoney(canceled.cents, canceled.currency, locale),
      order: canceled.order,
      charged: canceled.charged,
      productLink: `${storeBase(store)}/p/${canceled.product}`,
    });
    told.buyer = await sendEmailOutcome({
      meter: { by: "order" },
      from: fromStore(store),
      to: canceled.email,
      replyTo: store.email,
      subject: notice.subject,
      text: noticeText(notice),
      html: noticeHtml(notice, locale),
      idempotencyKey: `nimbus-paypal-cancel:${canceled.order}`,
    }).catch(() => "refused" as const);
  }
  if (who !== "buyer") {
    const notice = creatorNotice({
      title,
      money: formatMoney(canceled.cents, canceled.currency, "en-US"),
      order: canceled.order,
      charged: canceled.charged,
      hasAddress: Boolean(canceled.email),
      disconnected: !store.paypalSeller,
    });
    told.creator = await sendEmailOutcome({
      meter: { by: "order" },
      from: NIMBUS_FROM,
      to: store.email,
      replyTo: SUPPORT,
      subject: notice.subject,
      text: noticeText(notice),
      html: noticeHtml(notice),
      idempotencyKey: `nimbus-paypal-cancel-creator:${canceled.order}`,
    }).catch(() => "refused" as const);
  }
  return told;
}
