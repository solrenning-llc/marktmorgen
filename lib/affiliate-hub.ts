/**
 * An affiliate's own page across every store (added 13 October 2026): one
 * place, at marktmorgen.com/affiliate, for somebody who promotes several
 * creators here.
 *
 * Each store already has its affiliates' page (app/[handle]/affiliates):
 * their link, their numbers, what the creator paid them. An affiliate of
 * five creators had five pages and five emails to sign in from. What keeps
 * an affiliate on a platform rather than with one seller is that their work
 * lives in one place: the programs they are in, side by side, and the
 * directory of programs they could join (app/affiliate-programs) one click
 * away. So this keeps, for an address, which stores it is an affiliate of,
 * and nothing else: the status, the link and the numbers are each store's
 * own, read from the store when the page is opened, and each store's page
 * is opened from here with a sign-in made for that address on the spot.
 *
 * What is kept is the least that can do it, the same as a buyer's library
 * (lib/buyer-library.ts): for an address, read only as a one-way hash of it,
 * the ids of the stores it joined. Written whenever a store writes the
 * affiliate down (lib/affiliates.ts, writeAffiliate) and whenever they sign
 * in to a store's page, so somebody who joined before this existed is found
 * the next time they open any one of them.
 *
 * Signing in is the library's: the address is typed, and a link that opens
 * the page for a day is emailed to it. Nothing is sent to an address that is
 * nobody's affiliate, and the answer on the page is the same either way, so
 * the form cannot be used to learn who promotes whom.
 *
 *   nl:affhub:<quarter>:<hash of the address>   the stores it was noted an affiliate of in that quarter (a set of ids)
 *   nl:affhub:link:<hash of a token>            the address a link was sent to, for a day
 *
 * Since 18 October 2026 by the quarter, as a buyer's library is
 * (lib/joined-stores.ts): a store is on the page for at least three years
 * after it last noted the address, and a store that has closed is never
 * shown and runs out of it by itself. Until then one set held them all,
 * kept three years after the last, and is still read until it ends.
 */
import { storeForId } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { withinLimit } from "@/lib/request-guard";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { personKeys, personWrite } from "@/lib/joined-stores";

export const HUB_LINK_SECONDS = 24 * 60 * 60;
export const HUB_TOKEN = /^[0-9a-f]{64}$/;
/** The most stores one page lists. */
export const MAX_HUB_STORES = 100;
const STORE_ID = /^[0-9a-f]{32}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const HUB = "nl:affhub:";
const HUB_SALT = "nimbus-affhub";
const linkKey = (token: string) => `nl:affhub:link:${sha(`nimbus-affhub-link:${token}`).slice(0, 40)}`;

/** Notes that this address is an affiliate of the store with this id. Never throws. */
export async function rememberAffiliate(sid: string, email: string): Promise<void> {
  if (!STORE_ID.test(sid) || typeof email !== "string" || !EMAIL_PATTERN.test(normaliseEmail(email)) || !isRedisConfigured()) return;
  try {
    await redisPipeline(personWrite(HUB, HUB_SALT, email, sid));
  } catch (error) {
    console.error("noting an affiliate for their page failed", error);
  }
}

/**
 * The ids of the stores an address is an affiliate of. An empty list is none;
 * a reply missing or in any other shape throws UnknownReplyError (rule 24),
 * never "none".
 */
export async function storesPromoted(email: string): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const [reply] = repliesFor(await redisPipeline([["SUNION", ...personKeys(HUB, HUB_SALT, email)]]), 1) ?? unknownHub("the stores an address promotes");
  const ids = stringList(reply) ?? unknownHub("the stores an address promotes");
  return [...new Set(ids.filter((id) => STORE_ID.test(id)))].slice(0, MAX_HUB_STORES);
}

export type HubRequest = "sent" | "email" | "limited" | "error";

/**
 * Emails a link that opens the page. "sent" whether or not the address is
 * anybody's affiliate; nothing is sent to one that is not.
 */
export async function requestHubLink(input: { email: string; ip: string; origin: string }): Promise<HubRequest> {
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!isRedisConfigured() || !isSenderConfigured()) return "error";
  const email = normaliseEmail(raw);
  if (!(await withinLimit("affhub-ip", input.ip, 10, 3_600))) return "limited";
  if (!(await withinLimit("affhub-address", sha(email), 5, 3_600))) return "limited";
  const stores = await storesPromoted(email);
  if (!stores.length) return "sent";
  const token = randomBytes(32).toString("hex");
  await redisPipeline([["SET", linkKey(token), email, "EX", HUB_LINK_SECONDS]]);
  const link = `${input.origin}/affiliate?token=${token}`;
  // One of the access emails of the first store in the list (lib/store-allowance-rules.ts).
  const charged = await storeForId(stores[0]).catch(() => null);
  if (!charged) return "error";
  const sent = await sendEmail({ meter: { by: "store", store: charged, kind: "transactional" },
    from: NIMBUS_FROM,
    to: email,
    subject: "Your affiliate programs on Marktmorgen",
    text: [
      `Here are the affiliate programs you are in on Marktmorgen, ${stores.length} ${stores.length === 1 ? "store" : "stores"} in one place:`,
      "",
      link,
      "",
      "The link works for 24 hours. After that, ask for a new one at marktmorgen.com/affiliate.",
      "",
      "If you did not ask for this, you can ignore it: nobody can open the page without this email.",
    ].join("\n"),
  });
  return sent ? "sent" : "error";
}

/**
 * The address a live link was sent to, or null when the link is truly not
 * there (never made, ended or replaced). A reply missing or in any other
 * shape throws UnknownReplyError (rule 24): never "expired".
 */
export async function hubOwner(token: string): Promise<string | null> {
  if (!HUB_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [email] = repliesFor(await redisPipeline([["GET", linkKey(token)]]), 1) ?? unknownHub("an affiliate page's link");
  if (email === null) return null;
  return typeof email === "string" && email ? email : unknownHub("an affiliate page's link");
}

function unknownHub(what: string): never {
  throw new UnknownReplyError(what);
}
