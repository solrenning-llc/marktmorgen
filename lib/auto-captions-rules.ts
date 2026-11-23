/**
 * Captions written by AI for a lesson's video: the rules and the price
 * (added 11 October 2026; lib/auto-captions.ts does it).
 *
 * Captions could be added from a file the creator had (lib/captions.ts), and
 * the studio said plainly that they were not written for you. Most creators
 * have no such file, so most lessons had none: no help for a student who
 * cannot hear, or is on a train, or follows English better read than heard.
 *
 * The video service writes them (Bunny Stream's "Transcribe AI", a Whisper
 * model): in the language spoken, and, if asked, in other languages too. It
 * charges ten cents a minute of video for each language (its price page,
 * read October 11, 2026). Nothing a plan covers has room for that by the
 * hour (tests/plan-margin.test.ts), so it is a thing bought when wanted:
 *
 *   - CENTS_PER_MINUTE a minute of video, for each language, the minutes
 *     rounded up, and never less than MIN_CENTS in all;
 *   - the price is shown before the button is pressed, and charged at once
 *     on the card the plan is paid with (lib/billing.ts, chargeNow), so
 *     nothing is ever owed afterward;
 *   - what the service does not deliver within GIVE_UP_HOURS is refunded,
 *     language by language, once the service says what it delivered; an
 *     answer that stays unknown is asked again for DELIVERY_LOOK_DAYS, then
 *     kept for a person, never refunded on it (#5010 row 190).
 *
 * At its dearest a minute costs us ten cents for each language asked, and a
 * dime more should the service count the spoken language on its own as well,
 * with the card's fee on top: a quarter covers it all. Browser-safe.
 */
import { CAPTION_LANGUAGES, MAX_CAPTION_TRACKS } from "@/lib/captions";

/** What a minute of video costs, for each language, in cents. */
export const CENTS_PER_MINUTE = 600;
/** The least one request is charged, in cents: a card's own fee is thirty cents, and a short video's minutes do not cover it. */
export const MIN_CENTS = 3_500;
/** Languages asked for at once: the one spoken, and up to two more. */
export const MAX_AUTO_LANGUAGES = 3;
/** The longest video captions are written for, in minutes. */
export const MAX_AUTO_MINUTES = 240;
/** How long the service has to deliver before what it did not is refunded. */
export const GIVE_UP_HOURS = 48;
/**
 * Past GIVE_UP_HOURS, how many days a request whose answer from the service stays unknown is asked again before it is
 * kept for a person (lib/auto-captions.ts, DELIVERY_LOOKS_MS). The Terms and the help say it in these words.
 */
export const DELIVERY_LOOK_DAYS = 14;

/** Minutes of video, as they are charged: rounded up. */
export function chargedMinutes(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 0;
}

/** What captions in `languages` languages for a video of `seconds` seconds cost, in cents. */
export function autoCaptionCents(seconds: number, languages: number): number {
  const minutes = chargedMinutes(seconds);
  if (!minutes || languages < 1) return 0;
  return Math.max(MIN_CENTS, minutes * languages * CENTS_PER_MINUTE);
}

/** "$2.50": an amount in cents, for the studio and the invoice. */
export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export type AutoAsk = { spoken: string; languages: string[] };

/**
 * The languages asked for, cleaned: the one spoken first, then the others,
 * each once, each one captions can be in. Null when it cannot be done.
 */
export function readAutoAsk(spoken: unknown, also: unknown, already: readonly string[] = []): AutoAsk | null {
  const known = (code: unknown): code is string => typeof code === "string" && CAPTION_LANGUAGES.some((l) => l.code === code);
  if (!known(spoken)) return null;
  const others = Array.isArray(also) ? also.filter(known) : [];
  const languages = [spoken, ...others].filter((code, i, all) => all.indexOf(code) === i);
  if (languages.length > MAX_AUTO_LANGUAGES) return null;
  // A video holds captions in so many languages in all (lib/captions.ts).
  const after = new Set([...already, ...languages]);
  if (after.size > MAX_CAPTION_TRACKS) return null;
  return { spoken, languages };
}
