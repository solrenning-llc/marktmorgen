/**
 * Moving from ClickFunnels, the spreadsheet half (added 17 October 2026):
 * how the files a ClickFunnels workspace owner exports read here. See
 * docs/clickfunnels-import.md for what ClickFunnels' own help center says
 * each export holds, and when it was read.
 *
 * ClickFunnels lets the owner export three things as a file, each from its
 * own page, choosing the fields: contacts, products and orders. None of its
 * help pages lists every column name, so nothing here depends on one name:
 * each field below is matched by the names ClickFunnels' screens and help
 * pages use for it, then by the ordinary names any platform uses, and the
 * creator sees the match and can change it before anything is read.
 *
 * Consent is the part that matters most. ClickFunnels marks each contact
 * Subscribed, Unsubscribed or Undeliverable, and asks whoever imports
 * contacts into it to confirm they agreed to marketing. Here:
 *
 *   - only a row marked Subscribed, in a file whose importer confirms those
 *     people agreed, comes in as someone the creator may email;
 *   - every other row comes in as a contact the creator cannot email: kept
 *     with their name and tags, never written to because of the import;
 *   - a row marked Unsubscribed or Undeliverable keeps that here too: the
 *     address is marked as having left, so no later import can make it one
 *     the creator emails. Only that person, ticking a box on one of the
 *     creator's pages, can.
 *
 * Pure and browser-safe: the studio's screen and the server read the same.
 */
import { readConsent } from "@/lib/csv";

/** The three files a ClickFunnels owner exports, and the import each becomes here. */
export type ClickFunnelsFile = "contacts" | "products" | "purchases";

/**
 * Header names for each field, as ClickFunnels' contact, product and order
 * screens name them, and then as other platforms do. Matched ignoring case,
 * spaces, dashes and underscores (lib/csv.ts, guessColumn).
 */
export const CLICKFUNNELS_HEADERS: Record<ClickFunnelsFile, Record<string, string[]>> = {
  contacts: {
    email: ["email address", "email", "contact email", "e-mail"],
    name: ["first name", "firstname", "name", "full name", "contact name"],
    tags: ["tags", "tag", "contact tags"],
    consent: ["status", "subscription status", "email subscription status", "email status", "subscribed", "marketing consent"],
  },
  products: {
    title: ["product name", "name", "title", "product"],
    price: ["price", "default price", "amount", "price amount", "prices"],
    description: ["description", "product description", "details"],
    type: ["type", "pricing type"],
    link: ["url", "product url", "link"],
  },
  purchases: {
    email: ["customer email", "contact email", "email address", "email", "customer email address"],
    product: ["product name", "product", "products", "line items", "item", "items", "offer"],
    status: ["billing status", "status", "order status", "payment status", "fulfillment status"],
  },
};

/** The column ClickFunnels splits a contact's name into. */
export const CLICKFUNNELS_LAST_NAME = ["last name", "lastname", "surname"];

/** What a ClickFunnels contact's status column says about email, read row by row. */
export type ClickFunnelsStatus = "subscribed" | "unsubscribed" | "undeliverable" | "none" | "unknown";

/**
 * A contact's status as ClickFunnels writes it: Subscribed, Unsubscribed or
 * Undeliverable. A yes or no in other words (a "Marketing consent" column a
 * creator added, say) reads as subscribed or none. An empty cell is none:
 * nobody becomes someone the creator emails because a cell was blank.
 */
export function readClickFunnelsStatus(raw: string): ClickFunnelsStatus {
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (value === "") return "none";
  if (value === "subscribed" || value === "active subscribed") return "subscribed";
  if (value === "unsubscribed" || value === "opted out" || value === "opt out" || value === "optout") return "unsubscribed";
  if (value === "undeliverable" || value === "bounced" || value === "hard bounced" || value === "invalid") return "undeliverable";
  const said = readConsent(raw);
  if (said === "yes") return "subscribed";
  if (said === "no") return "none";
  return "unknown";
}

/**
 * How a contact comes in, from what ClickFunnels says and whether the
 * creator confirmed that the people marked Subscribed agreed:
 *
 *   agreed         may be emailed (Subscribed, and the creator confirmed it)
 *   none           a contact who may not be emailed (no recorded consent)
 *   unsubscribed   a contact who opted out there, kept as having left here
 *   undeliverable  the same, for an address that could not be delivered to
 */
export type ContactConsent = "agreed" | "none" | "unsubscribed" | "undeliverable";

export function consentFrom(status: ClickFunnelsStatus, confirmed: boolean): ContactConsent {
  if (status === "subscribed") return confirmed ? "agreed" : "none";
  if (status === "unsubscribed") return "unsubscribed";
  if (status === "undeliverable") return "undeliverable";
  return "none";
}

/**
 * What an order's status column says: paid, not paid, or not understood. Empty is not understood: it is never taken
 * as paid in a file that has a status column. Only a file with no status column at all is read as all paid.
 */
export type OrderStatus = "paid" | "unpaid" | "unknown";

/**
 * An order's billing status, in the words checkout platforms use. Only a
 * paid order gives a past buyer what they bought: a refunded, failed or
 * canceled one never does, nor one whose status is empty or not known.
 * `column` is false only for a file with no status column, whose empty
 * cells are then read as paid, as before; words are read as words either way.
 */
export function readOrderStatus(raw: string, column = true): OrderStatus {
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (value === "") return column ? "unknown" : "paid";
  const paid = ["paid", "complete", "completed", "succeeded", "success", "successful", "active", "fulfilled", "settled", "captured", "paid in full", "approved"];
  const unpaid = [
    "refunded",
    "partially refunded",
    "partial refund",
    "failed",
    "canceled",
    "cancelled",
    "void",
    "voided",
    "declined",
    "disputed",
    "chargeback",
    "charged back",
    "pending",
    "unpaid",
    "abandoned",
    "incomplete",
    "past due",
    "overdue",
    "expired",
    "draft",
  ];
  if (paid.includes(value)) return "paid";
  if (unpaid.includes(value)) return "unpaid";
  return "unknown";
}

/** The example files the studio offers, with ClickFunnels' own column names. */
export const CLICKFUNNELS_EXAMPLES: Record<ClickFunnelsFile, string> = {
  contacts: "Email Address,First Name,Last Name,Tags,Status\r\nada@example.com,Ada,Lovelace,\"Customer, VIP\",Subscribed\r\ngrace@example.com,Grace,Hopper,,Unsubscribed\r\n",
  products: "Product Name,Price,Description\r\nThe starter guide,19,A short guide to getting started.\r\n",
  purchases: "Customer Email,Product Name,Billing Status\r\nada@example.com,The starter guide,Paid\r\n",
};
