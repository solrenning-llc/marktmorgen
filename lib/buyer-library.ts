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
import { withinLimit } from "@/lib/request-guard";
import { NIMBUS_FROM, isSenderConfigured, sendEmailOutcome } from "@/lib/email";
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

/**
 * "unsure": the sender's answer is not known (a timeout, a server error), so
 * the email may have gone; it is never said as not sent, and the link
 * written for it stays open (VR 2).
 */
export type LibraryRequest = "sent" | "unsure" | "email" | "limited" | "error";

/**
 * Emails a link that opens the library. "sent" whether or not the address
 * bought anything; nothing is sent to one that did not.
 */
export async function requestLibraryLink(input: { email: string; ip: string; origin: string }): Promise<LibraryRequest> {
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!isRedisConfigured() || !isSenderConfigured()) return "error";
  const email = normaliseEmail(raw);
  if (!(await withinLimit("library-ip", input.ip, 10, 3_600))) return "limited";
  if (!(await withinLimit("library-address", sha(email), 5, 3_600))) return "limited";
  // Only stores that are still open: one that has closed is gone, and is never shown.
  const stores: string[] = [];
  let charged: Awaited<ReturnType<typeof storeForId>> = null;
  for (const sid of await storesBoughtFrom(email)) {
    const store = await storeForId(sid).catch(() => null);
    if (!store) continue;
    stores.push(sid);
    charged ??= store;
  }
  if (!stores.length) return "sent";
  if (!charged) return "error";
  const token = randomBytes(32).toString("hex");
  await redisPipeline([["SET", linkKey(token), email, "EX", LIBRARY_LINK_SECONDS]]);
  const link = `${input.origin}/library?token=${token}`;
  // One of the access emails of the store the address bought from first in the list (lib/store-allowance-rules.ts).
  const outcome = await sendEmailOutcome({ meter: { by: "store", store: charged, kind: "transactional" },
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
  return outcome === "sent" ? "sent" : outcome === "uncertain" ? "unsure" : "error";
}

/** The address a live library link was sent to, or null. */
export async function libraryOwner(token: string): Promise<string | null> {
  if (!LIBRARY_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [email] = await redisPipeline([["GET", linkKey(token)]]);
  return typeof email === "string" && email ? email : null;
}
