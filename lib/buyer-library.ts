/**
 * A buyer's library (added 11 October 2026): everything an address bought
 * from any store on Marktmorgen, in one place, with no account.
 *
 * Each store already gives its buyers their purchases back by email
 * (lib/buyer-orders.ts): type the address you paid with, use the link that
 * arrives. A buyer of five creators had five stores to remember. Gumroad and
 * Kajabi each keep one library per buyer, and their apps are built on it; so
 * is the app this will be.
 *
 * What is kept is the least that can do it: for an address, read only as a
 * one-way hash of it, which stores it bought something from, by the store's
 * id. Not what, not when, not for how much: each store's own list is still
 * read from the creator's Stripe account when the buyer opens it, exactly as
 * before. The privacy page says so.
 *
 * Signing in is the same as a store's: the address is typed, and a link that
 * opens the library for a day is emailed to it. Nothing is sent to an address
 * that bought nothing, and the answer on the page is the same either way, so
 * the form cannot be used to learn who buys from whom.
 *
 *   nl:lib:<quarter>:<hash of the address>         the stores it bought from in that quarter (a set of ids)
 *   nl:lib:link:<hash of a token>                  the address a library link was sent to, for a day
 *   nl:lib:joined:<quarter>:<hash of the address>  the stores whose list it joined itself in that quarter
 *
 * The last (added 17 October 2026) is not shown anywhere: it is how a person
 * asking to be deleted from every store (lib/erasure-request.ts) is found in
 * the stores they joined without buying, by the same one-way hash.
 *
 * Since 18 October 2026 each quarter's set ends QUARTERS_KEPT quarters after
 * the one it was written in, so a store is in a library for at least three
 * years after the last purchase from it (lib/joined-stores.ts says why).
 * Until then one set held them all, kept three years after the last
 * purchase from any store, and is still read until it ends. A store that
 * has closed is never shown: it no longer exists. And only what was bought
 * on Marktmorgen puts a store in: an order, a gift, a place bought for
 * somebody, a pre-order, a PayPal purchase; not what a creator brings over
 * from another platform or gives through the API.
 */
import { storeForId } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { orderWrite } from "@/lib/order-data";
import { essentialLimitState } from "@/lib/request-guard";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { afterAnswer } from "@/lib/after-answer";
import { joinedKeys, personKeys, personWrite } from "@/lib/joined-stores";
import { repliesFor as linkSetReplies } from "@/lib/redis-reply";

export const LIBRARY_LINK_SECONDS = 24 * 60 * 60;
export const LIBRARY_TOKEN = /^[0-9a-f]{64}$/;
/** The most stores one library lists. */
export const MAX_LIBRARY_STORES = 60;
const STORE_ID = /^[0-9a-f]{32}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const LIBRARY = "nl:lib:";
const LIBRARY_SALT = "nimbus-lib";
const libraryKeys = (email: string) => personKeys(LIBRARY, LIBRARY_SALT, email);
const linkKey = (token: string) => `nl:lib:link:${sha(`nimbus-lib-link:${token}`).slice(0, 40)}`;

const ids = (reply: unknown) => (Array.isArray(reply) ? reply.filter((id): id is string => typeof id === "string" && STORE_ID.test(id)) : []);

/** The ids of every store an address bought from or joined itself, at most MAX_LIBRARY_STORES: one command, whatever the quarters. */
export async function storesKnownFor(email: string): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const [all] = await redisPipeline([["SUNION", ...libraryKeys(email), ...joinedKeys(email)]]);
  return [...new Set(ids(all))].slice(0, MAX_LIBRARY_STORES);
}

/** Forgets that this address bought from or joined the store with this id (lib/person-erasure.ts): in every quarter it can be in. */
export async function forgetLibraryPerson(sid: string, email: string): Promise<number> {
  if (!STORE_ID.test(sid) || !isRedisConfigured()) return 0;
  const replies = await redisPipeline([...libraryKeys(email), ...joinedKeys(email)].map((key) => ["SREM", key, sid]));
  return replies.reduce<number>((sum, n) => sum + (Number(n) || 0), 0);
}

/**
 * Notes that these addresses bought something from the store with this id,
 * counted in that store's room at what it really adds (lib/order-data.ts):
 * an address already noted adds nothing. Never throws.
 */
export async function rememberBuyers(sid: string, emails: string[]): Promise<void> {
  const wanted = emails.filter((email) => typeof email === "string" && EMAIL_PATTERN.test(normaliseEmail(email)));
  if (!STORE_ID.test(sid) || !wanted.length || !isRedisConfigured()) return;
  try {
    await orderWrite({ sid }, wanted.flatMap((email) => personWrite(LIBRARY, LIBRARY_SALT, email, sid)));
  } catch (error) {
    console.error("noting a buyer for their library failed", error);
  }
}

/** The ids of the stores an address bought from, closed ones among them until they run out (a closed store no longer resolves). */
export async function storesBoughtFrom(email: string): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const [all] = await redisPipeline([["SUNION", ...libraryKeys(email)]]);
  return [...new Set(ids(all))].slice(0, MAX_LIBRARY_STORES);
}

export type LibraryRequest = "sent" | "email" | "limited" | "error";

/**
 * Emails a link that opens the library. "sent" whether or not the address
 * bought anything, and at once, right after the limits: which stores it
 * bought from is read, and its link made and emailed, only after the answer
 * is sent (lib/after-answer.ts), so neither the answer's words nor its time
 * tell them apart, and an email that could not go out is said only in the
 * server's log. Nothing is sent to an address that bought nothing.
 */
export async function requestLibraryLink(input: { email: string; ip: string; origin: string }): Promise<LibraryRequest> {
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!isRedisConfigured() || !isSenderConfigured()) return "error";
  const email = normaliseEmail(raw);
  // A paid email follows: a count that is not known sends nothing, for every address alike, before anything about the
  // address is asked, so saying so tells nobody who bought; it is said as our error, never as too many requests.
  const byConnection = await essentialLimitState("library-ip", input.ip, 10, 3_600);
  if (byConnection === "unknown") return "error";
  if (byConnection === "exceeded") return "limited";
  const byAddress = await essentialLimitState("library-address", sha(email), 5, 3_600);
  if (byAddress === "unknown") return "error";
  if (byAddress === "exceeded") return "limited";
  // From here the answer is "sent" whatever happens, and at once: the stores, the link and its email are all after it.
  afterAnswer("sending a library link", () => sendLibraryLink(email, input.origin));
  return "sent";
}

/** The link itself, for an address that bought from a store still open; nothing for one that did not. */
async function sendLibraryLink(email: string, origin: string): Promise<void> {
  // Only stores that are still open: one that has closed is gone, and is never shown.
  const stores: string[] = [];
  let charged: Awaited<ReturnType<typeof storeForId>> = null;
  for (const sid of await storesBoughtFrom(email)) {
    const store = await storeForId(sid).catch(() => null);
    if (!store) continue;
    stores.push(sid);
    charged ??= store;
  }
  if (!stores.length || !charged) return;
  const token = randomBytes(32).toString("hex");
  let sent = false;
  try {
    // A paid email only with a link Redis said it stored (rule 24): any other answer sends nothing, and the link,
    // in case it did land, is removed below like any unsent one. The answer was already "sent" for every address.
    const saved = linkSetReplies(await redisPipeline([["SET", linkKey(token), email, "EX", LIBRARY_LINK_SECONDS]]), 1);
    if (saved?.[0] !== "OK") {
      console.error("a library link was not stored, so no email was sent");
      return;
    }
    const link = `${origin}/library?token=${token}`;
    // One of the access emails of the store the address bought from first in the list (lib/store-allowance-rules.ts).
    sent = await sendEmail({ meter: { by: "store", store: charged, kind: "transactional" },
      from: NIMBUS_FROM,
      to: email,
      subject: "Your purchases on Marktmorgen",
      text: [
        `Here is everything you bought from creators on Marktmorgen, from ${stores.length} ${stores.length === 1 ? "store" : "stores"}:`,
        "",
        link,
        "",
        "The link works for 24 hours. After that, ask for a new one at marktmorgen.com/library.",
        "",
        "If you did not ask for this, you can ignore it: nobody can open your library without this email.",
      ].join("\n"),
    });
  } finally {
    // A link whose email did not go out opens nothing: it is removed at once,
    // not left for the day. When the send's outcome was unknown, an email that
    // did arrive then holds a link that no longer opens, and asking again sends
    // a new one. Removal is best effort: the day's expiry still ends it.
    if (!sent) {
      await redisPipeline([["DEL", linkKey(token)]]).catch((error) => console.error("removing an unsent library link failed", error));
    }
  }
  if (!sent) console.error("a library link was not sent");
}

/** The address a live library link was sent to, or null. */
export async function libraryOwner(token: string): Promise<string | null> {
  if (!LIBRARY_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [email] = await redisPipeline([["GET", linkKey(token)]]);
  return typeof email === "string" && email ? email : null;
}
