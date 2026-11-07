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
 * Dates the creator sets for the whole store are a later unit of 283 [HG2];
 * this setting does not hold them, so the studio shows no field that does
 * nothing.
 *
 * Pure and browser-safe, so the studio's form and the email read the same rules.
 */
import { anniversaryWords } from "@/lib/buyer-words/anniversary";

export type Anniversary = {
  on: boolean;
  /** The creator's own few words, plain text, shown as written. "" for none. */
  message: string;
  /** The creator's postal address, which every email like this carries. */
  address: string;
};

/** How long the creator's words may be. */
export const MAX_ANNIVERSARY_MESSAGE = 600;
export const MAX_ANNIVERSARY_ADDRESS = 300;
export const NO_ANNIVERSARY: Anniversary = { on: false, message: "", address: "" };

const DAY_SECONDS = 86_400;
/** How wide the window a store's first run reads is; later runs go on from where the last stopped (lib/anniversary-send.ts). */
export const ANNIVERSARY_WINDOW_DAYS = 2;
/**
 * How late an anniversary email may still go: on a busy day some go on the following days, and a purchase
 * older than this before a run is no longer read, so its email is not sent (lib/anniversary-send.ts).
 */
export const ANNIVERSARY_LATE_DAYS = 7;

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

/** Whatever came back from storage or a form, made safe to use: on only with a postal address to print. */
export function parseAnniversary(raw: unknown): Anniversary {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const address = typeof value.address === "string" ? value.address.replace(/\s+/g, " ").trim().slice(0, MAX_ANNIVERSARY_ADDRESS) : "";
  return { on: value.on === true && address.length > 0, message: cleanMessage(value.message), address };
}

/** Whether a store sends the anniversary email. */
export function anniversaryOn(store: { anniversary: Anniversary }): boolean {
  return store.anniversary.on && store.anniversary.address !== "";
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
