/**
 * The email on the anniversary of a purchase: 283 [HG2], unit 1 (6 November 2026).
 *
 * A year after a paid one-time purchase, one email from the store: the date
 * they bought, what, a few words the creator chose (a new edition, a part
 * added to a course) and the store's link. Only to a buyer who ticked the box
 * to hear from the creator at that checkout (`news` "yes") and is still on
 * the creator's list; once per person per date. Sent by lib/anniversary-send.ts.
 *
 * No birth date is ever asked for or kept (the owner's decision recorded in
 * 283 [HG2]): the only date read is the purchase's own, already on the
 * creator's Stripe account. Nothing else of the person is kept here.
 *
 * Every product the buyer paid for once, by default; or only the products
 * the creator chooses (unit 3). The choice is read exactly: anything that
 * cannot be read whole is "unknown", and a store whose choice is unknown, or
 * has none left, sends nothing, never every product. A product deleted from
 * the store leaves the choice in the same write (lib/store.ts, removeProduct).
 *
 * Dates the creator sets for the whole store are lib/store-dates-rules.ts
 * (unit 2); this setting does not hold them.
 *
 * Pure and browser-safe, so the studio's form and the email read the same rules.
 */
import { anniversaryWords } from "@/lib/buyer-words/anniversary";

/** Which purchases are written about: every product, the ones chosen, or a saved choice that could not be read. */
export type AnniversaryProducts = "all" | string[] | "unknown";

export type Anniversary = {
  on: boolean;
  /** The creator's own few words, plain text, shown as written. "" for none. */
  message: string;
  /** The creator's postal address, which every email like this carries. */
  address: string;
  /** Every product ("all", the default), only these product ids, or "unknown": never sent on. */
  products: AnniversaryProducts;
};

/** How long the creator's words may be. */
export const MAX_ANNIVERSARY_MESSAGE = 600;
export const MAX_ANNIVERSARY_ADDRESS = 300;
/** How many products may be chosen; past it, "every product" is the choice. */
export const MAX_ANNIVERSARY_PRODUCTS = 200;
export const NO_ANNIVERSARY: Anniversary = { on: false, message: "", address: "", products: "all" };
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const DAY_SECONDS = 86_400;
/** How wide the window read each day is: a day the job did not run is caught the next. */
export const ANNIVERSARY_WINDOW_DAYS = 2;

/** The creator's words as kept: line breaks kept as "\n", every other control character taken out, cut to the bound. */
function cleanMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_ANNIVERSARY_MESSAGE)
    .trim();
}

/**
 * The choice, read exactly. Absent means every product (a setting saved
 * before the choice existed, as it then was); "all" means every product; a
 * list counts only when every entry in it is a product id and it is within
 * the bound, each id kept once in the order given. Anything else is
 * "unknown", never cut down to the part that could be read.
 */
export function parseAnniversaryProducts(raw: unknown): AnniversaryProducts {
  if (raw === undefined || raw === "all") return "all";
  if (!Array.isArray(raw) || raw.length > MAX_ANNIVERSARY_PRODUCTS) return "unknown";
  if (!raw.every((id): id is string => typeof id === "string" && PRODUCT_ID.test(id))) return "unknown";
  return [...new Set(raw)];
}

/** Whatever came back from storage or a form, made safe to use: on only with a postal address to print. */
export function parseAnniversary(raw: unknown): Anniversary {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const address = typeof value.address === "string" ? value.address.replace(/\s+/g, " ").trim().slice(0, MAX_ANNIVERSARY_ADDRESS) : "";
  return { on: value.on === true && address.length > 0, message: cleanMessage(value.message), address, products: parseAnniversaryProducts(value.products) };
}

/** Whether a store sends the anniversary email: on, with an address, and a choice that is known and not empty. */
export function anniversaryOn(store: { anniversary: Anniversary }): boolean {
  const { on, address, products } = store.anniversary;
  return on && address !== "" && (products === "all" || (Array.isArray(products) && products.length > 0));
}

/** Whether a purchase of this product is written about: every product, or this one chosen. Unknown covers nothing. */
export function anniversaryCovers(setting: Anniversary, productId: string): boolean {
  return setting.products === "all" || (Array.isArray(setting.products) && setting.products.includes(productId));
}

/** The choice without a product deleted from the store; "all" and "unknown" stay as they are. */
export function anniversaryWithout(setting: Anniversary, removed: string): Anniversary {
  return Array.isArray(setting.products) && setting.products.includes(removed) ? { ...setting, products: setting.products.filter((id) => id !== removed) } : setting;
}

/**
 * The purchases a run looks at, in Stripe's seconds: those made in the two
 * days up to this moment one calendar year ago (a leap day's comes round on
 * March 1). The once-mark per person keeps the overlap of two runs from ever
 * meaning two emails.
 */
export function anniversaryWindow(now: number): { from: number; upTo: number } {
  const at = new Date(now);
  at.setUTCFullYear(at.getUTCFullYear() - 1);
  const upTo = Math.floor(at.getTime() / 1000);
  return { from: upTo - ANNIVERSARY_WINDOW_DAYS * DAY_SECONDS, upTo };
}

/**
 * The email, and nothing else: pure, so the studio shows what a buyer reads.
 * `boughtOn` arrives already written in the store's language. The footer (why
 * they get it, the one-click way off the list, the postal address) is the
 * list email's own (lib/mail.ts, render).
 */
export function anniversaryEmail(input: { storeName: string; title: string; boughtOn: string; message: string; link: string; language?: unknown }): { subject: string; body: string } {
  const words = anniversaryWords(input.language);
  const message = cleanMessage(input.message);
  return {
    subject: words.subject(input.title).slice(0, 150),
    body: [words.lead(input.title, input.storeName, input.boughtOn), ...(message ? ["", message] : []), "", words.visit, input.link, "", words.reply(input.storeName)].join("\n"),
  };
}
