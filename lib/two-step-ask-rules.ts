/**
 * 757 [STN4] unit 3: after a store's first sale, the studio asks the creator
 * to turn on two-step login (lib/two-step.ts), and never blocks a sale for it.
 *
 * Why then: before the first sale the account holds drafts; after it, it holds
 * money on the way, buyers' names and addresses, and a store people trust.
 * Somebody who gets into the creator's inbox can open the studio with an
 * emailed link alone, unless a second step is on. Stan's test account showed
 * it off and never asked (research of 06–09/11/2026).
 *
 * Who is asked, each read for sure (rule 24: unknown is never "no"):
 *   - the store's first sale is known, from the mark lib/yearly-offer.ts keeps
 *     (noteFirstSale), read exactly by lib/two-step-ask.ts: not kept is "not
 *     yet", any other shape is unknown, and unknown asks nothing;
 *   - the person has no app turned on and no passkey (a passkey is a second
 *     step already), both read; a session that is locked has its own notice,
 *     and a lock that could not be read is unknown, never "unlocked".
 *
 * Dismissed once, remembered for the store in this browser, under
 * TWO_STEP_ASK_PREFIX and the store's 32-character id: a bounded key, and no
 * read, write or key on our side. A browser that cannot keep the dismissal
 * (storage blocked or full) is not asked, since it would be asked again on
 * every visit. A store never sells less for any of it: nothing that decides a
 * sale reads this file.
 *
 * Browser-safe: no server read of its own.
 */

/** The browser key's start; the store's id follows. */
export const TWO_STEP_ASK_PREFIX = "mm:2fa-ask:";
/** The one value written when the creator dismisses it. */
export const TWO_STEP_ASK_DISMISSED = "1";
/** Where the link goes: the studio's Two-step login (components/two-step-manager.tsx). */
export const TWO_STEP_ASK_HREF = "#two-step";

const STORE_ID = /^[0-9a-f]{32}$/;
/** The mark's value: the day in seconds, then, since claimValue, a point and a random part of digits. */
const FIRST_SALE_VALUE = /^([1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/;

/** The browser key of one store's dismissal; null when the id is not one we make (then nothing is shown). */
export function twoStepAskKey(sid: string): string | null {
  return typeof sid === "string" && STORE_ID.test(sid) ? `${TWO_STEP_ASK_PREFIX}${sid}` : null;
}

/**
 * The first sale's day in seconds from the mark's GET reply: 0 when nothing is kept (no sale yet), null when the
 * reply is in any other shape (unknown).
 */
export function firstSaleFromReply(reply: unknown): number | null {
  if (reply === null) return 0;
  if (typeof reply !== "string") return null;
  const match = FIRST_SALE_VALUE.exec(reply);
  return match ? Number(match[1]) : null;
}

/** An account with no second step at all, each read for sure, its session's lock too: null is "not read". */
export function noSecondStep(account: { appOn: boolean | null; passkeys: number | null; locked: boolean | null }): boolean {
  return account.appOn === false && account.passkeys === 0 && account.locked === false;
}

/** Whether the studio asks: an account with no second step, in a store whose first sale is known. */
export function showTwoStepAsk(account: { firstSale: number | null; appOn: boolean | null; passkeys: number | null; locked: boolean | null }): boolean {
  return noSecondStep(account) && typeof account.firstSale === "number" && account.firstSale > 0;
}

/**
 * Whether this browser shows it, from what it keeps under the store's key (null: nothing kept; undefined: storage
 * blocked) and whether it can write there: only when nothing is kept and a dismissal could be kept.
 */
export function askShown(kept: string | null | undefined, writable: boolean): boolean {
  return writable && kept === null;
}

/** The studio is in US English; what to do and why, in short plain sentences. */
export const TWO_STEP_ASK_WORDS = {
  title: "Your store made its first sale. Keep your account safe.",
  body: "Turn on two-step login. Then a person who gets into your email still cannot open your studio without your phone. Your store keeps selling either way.",
  link: "Turn on two-step login",
  dismiss: "Don't show this again",
  dismissed: "Hidden. You can turn it on any time under Two-step login on this page.",
} as const;
