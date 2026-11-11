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
import { type Store } from "@/lib/store";
import { storeForIdExactly } from "@/lib/store-exact";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { orderWrite } from "@/lib/order-data";
import { withinEssentialLimit } from "@/lib/request-guard";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { joinedKeys, personKeys, personWrite } from "@/lib/joined-stores";

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

/**
 * The store ids in one SUNION reply, read in its exact shape (CX-123 rule 24): a list of strings, an exact empty one
 * staying "none"; anything else throws UnknownReplyError, never "no stores". A member that cannot be a store's id is
 * left out, as before: it is not a store.
 */
const ids = (reply: unknown, what = "a library's stores") => {
  const all = stringList(reply);
  if (!all) throw new UnknownReplyError(what);
  return all.filter((id) => STORE_ID.test(id));
};

/**
 * The ids of every store an address bought from or joined itself, at most MAX_LIBRARY_STORES: one command, whatever
 * the quarters. A reply out of shape throws UnknownReplyError: the deletion ask for every store (lib/erasure-request.ts)
 * and the person's copy (lib/person-copy.ts) then fail, never go on as if no store knew the address.
 */
export async function storesKnownFor(email: string): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["SUNION", ...libraryKeys(email), ...joinedKeys(email)]]), 1);
  if (!replies) throw new UnknownReplyError("the stores that know an address");
  return [...new Set(ids(replies[0], "the stores that know an address"))].slice(0, MAX_LIBRARY_STORES);
}

/**
 * Forgets that this address bought from or joined the store with this id (lib/person-erasure.ts): in every quarter it
 * can be in. Each SREM reply is read in its exact shape (rule 24): 0 or 1, one per command. Anything else throws
 * UnknownReplyError, so the erasure says this part could not finish and can be asked again, never "erased, 0 records"
 * with the address still linked to the store.
 */
export async function forgetLibraryPerson(sid: string, email: string): Promise<number> {
  if (!STORE_ID.test(sid) || !isRedisConfigured()) return 0;
  const commands = [...libraryKeys(email), ...joinedKeys(email)].map((key) => ["SREM", key, sid]);
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  const counts = replies?.map(countOf);
  if (!counts || counts.some((n) => n === null || n > 1)) throw new UnknownReplyError("forgetting a library's store");
  return (counts as number[]).reduce((sum, n) => sum + n, 0);
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

/**
 * The ids of the stores an address bought from, closed ones among them until they run out (a closed store no longer
 * resolves). Read in its exact shape (CX-123 rule 24): one list of strings, or UnknownReplyError, never "none".
 */
export async function storesBoughtFrom(email: string): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["SUNION", ...libraryKeys(email)]]), 1);
  const all = replies ? stringList(replies[0]) : null;
  if (!all) throw new UnknownReplyError("a library's stores");
  return [...new Set(all.filter((id) => STORE_ID.test(id)))].slice(0, MAX_LIBRARY_STORES);
}

export type LibraryRequest = "sent" | "email" | "limited" | "error";

/**
 * Emails a link that opens the library. "sent" whether or not the address
 * bought anything; nothing is sent to one that did not.
 */
export async function requestLibraryLink(input: { email: string; ip: string; origin: string }): Promise<LibraryRequest> {
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!isRedisConfigured() || !isSenderConfigured()) return "error";
  const email = normaliseEmail(raw);
  if (!(await withinEssentialLimit("library-ip", input.ip, 10, 3_600))) return "limited";
  if (!(await withinEssentialLimit("library-address", sha(email), 5, 3_600))) return "limited";
  // Only stores that are still open: one that has closed is gone, and is never shown.
  const stores: string[] = [];
  let charged: Store | null = null;
  // A store whose record could not be read, or answered out of shape, is not a closed one (CX-123 rule 24): when none
  // read and one did not, nothing was sent, so the page never says a link is on its way (Claude 5 and Codex J on #2910).
  let unread = 0;
  for (const sid of await storesBoughtFrom(email)) {
    const store = await storeForIdExactly(sid).catch(() => "unknown" as const);
    if (store === "unknown") unread += 1;
    if (store === "unknown" || store === "none") continue;
    stores.push(sid);
    charged ??= store;
  }
  if (!stores.length) return unread ? "error" : "sent";
  if (!charged) return "error";
  const token = randomBytes(32).toString("hex");
  // The grant is the link: only a SET answered exactly "OK" is one (CX-123 rule 24). Any other reply sends nothing and
  // takes no store email, so nobody is emailed a link that does not open; the route answers "error".
  const written = repliesFor(await redisPipeline([["SET", linkKey(token), email, "EX", LIBRARY_LINK_SECONDS]]), 1);
  if (!written || written[0] !== "OK") throw new UnknownReplyError("a library link's grant");
  const link = `${input.origin}/library?token=${token}`;
  // One of the access emails of the store the address bought from first in the list (lib/store-allowance-rules.ts).
  const sent = await sendEmail({ meter: { by: "store", store: charged, kind: "transactional" },
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
  return sent ? "sent" : "error";
}

/**
 * The address a live library link was sent to, or null when the link is confirmed gone. Read in its exact shape
 * (CX-123 rule 24): any other reply throws UnknownReplyError, never "expired" (Claude 5 on #2910).
 */
export async function libraryOwner(token: string): Promise<string | null> {
  if (!LIBRARY_TOKEN.test(token) || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", linkKey(token)]]), 1);
  const email = replies ? replies[0] : undefined;
  if (email === null) return null;
  if (typeof email !== "string" || !email) throw new UnknownReplyError("a library link's address");
  return email;
}
