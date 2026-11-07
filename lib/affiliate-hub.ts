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
import { withinLimit } from "@/lib/request-guard";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { personKeys, personWrite } from "@/lib/joined-stores";
import { repliesFor as exactReplies } from "@/lib/redis-reply";
import { afterAnswer } from "@/lib/after-answer";

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

/** The ids of the stores an address is an affiliate of. */
export async function storesPromoted(email: string): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const [ids] = await redisPipeline([["SUNION", ...personKeys(HUB, HUB_SALT, email)]]);
  return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && STORE_ID.test(id)))].slice(0, MAX_HUB_STORES) : [];
}

export type HubRequest = "sent" | "email" | "limited" | "error";

/**
 * Emails a link that opens the page. "sent" whether or not the address is
 * anybody's affiliate, and at once, right after the limits: which stores it
 * promotes is read, and its link made and emailed, only after the answer is
 * sent (lib/after-answer.ts), so neither the answer's words nor its time tell
 * them apart, and an email that could not go out is said only in the server's
 * log. Nothing is sent to an address that is nobody's affiliate.
 */
export async function requestHubLink(input: { email: string; ip: string; origin: string }): Promise<HubRequest> {
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!isRedisConfigured() || !isSenderConfigured()) return "error";
  const email = normaliseEmail(raw);
  if (!(await withinLimit("affhub-ip", input.ip, 10, 3_600))) return "limited";
  if (!(await withinLimit("affhub-address", sha(email), 5, 3_600))) return "limited";
  // From here the answer is "sent" whatever happens, and at once: the stores, the link and its email are all after it.
  afterAnswer("sending an affiliate's page link", () => sendHubLink(email, input.origin));
  return "sent";
}

/** The link itself, for an address that is an affiliate of a store here; nothing for one that is not. */
async function sendHubLink(email: string, origin: string): Promise<void> {
  const stores = await storesPromoted(email);
  if (!stores.length) return;
  // One of the access emails of the first store in the list (lib/store-allowance-rules.ts).
  const charged = await storeForId(stores[0]).catch(() => null);
  if (!charged) {
    console.error("an affiliate's page link was not sent: its first store could not be read");
    return;
  }
  const token = randomBytes(32).toString("hex");
  let sent = false;
  try {
    // A paid email only with a link Redis said it stored (rule 24): any other answer sends nothing, and the link,
    // in case it did land, is removed below like any unsent one. The answer was already "sent" for every address.
    const saved = exactReplies(await redisPipeline([["SET", linkKey(token), email, "EX", HUB_LINK_SECONDS]]), 1);
    if (saved?.[0] !== "OK") {
      console.error("an affiliate's page link was not stored, so no email was sent");
      return;
    }
    const link = `${origin}/affiliate?token=${token}`;
    sent = await sendEmail({ meter: { by: "store", store: charged, kind: "transactional" },
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
  } finally {
    // A link whose email did not go out opens nothing: it is removed at once, not left for the day. When the send's
    // outcome was unknown, an email that did arrive then holds a link that no longer opens, and asking again sends a
    // new one. Removal is best effort: the day's expiry still ends it.
    if (!sent) {
      await redisPipeline([["DEL", linkKey(token)]]).catch((error) => console.error("removing an unsent affiliate page link failed", error));
    }
  }
  if (!sent) console.error("an affiliate's page link was not sent");
}

/** The address a live link was sent to, or null. */
export async function hubOwner(token: string): Promise<string | null> {
  if (!HUB_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [email] = await redisPipeline([["GET", linkKey(token)]]);
  return typeof email === "string" && email ? email : null;
}
