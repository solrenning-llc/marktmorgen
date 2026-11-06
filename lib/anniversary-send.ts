/**
 * Sending the email on the anniversary of a purchase (lib/anniversary-rules.ts, 283 [HG2]).
 *
 * Once a day, inside the daily job (app/api/cron/plans), for every store that
 * turned it on: the paid checkouts on the creator's own Stripe account made in
 * the two days up to this moment a year ago (anniversaryWindow), at most
 * SESSION_PAGES pages of a hundred. A checkout is written about only when all
 * of this is known, and nothing is sent on anything not known:
 *
 *   - it is this store's, complete and paid, a one-time payment above zero,
 *     of a product the store still has (never a tip, a call, a payment plan,
 *     a membership, a package or a request);
 *   - its charge, read in the same list, was neither refunded (in whole or
 *     in part) nor disputed;
 *   - the buyer ticked the box to hear from the creator at that checkout
 *     (`news` "yes"), AND is on the creator's list and may be written to now
 *     (lib/contacts.ts, tokensFor: never unsubscribed, bounced or marked as
 *     spam), AND was not deleted from the store (lib/suppression.ts, read
 *     whole or not at all).
 *
 * One email per person per date, whatever they bought that day: the once-mark
 * is claimed exactly (lib/claim-mark.ts) before sending and let go only when
 * the email did not go. The email is taken from the store's own figure
 * before it is sent (lib/email.ts, meter "store"); a spent figure sends
 * nothing. At most ANNIVERSARIES_PER_STORE_RUN a store in one run; the window
 * is two days wide, so the rest go the next day.
 *
 *   nl:hg:once:<statsId>:<hash>           that person was written to lately, ONCE_DAYS
 *   nl:hg:count:<statsId>:<yyyy-mm>       sent this month, for the studio, COUNT_DAYS
 *   nl:hg:cursor                          where the last run stopped
 */
import { createHash } from "node:crypto";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { onAccount, platformKey } from "@/lib/stripe-account";
import { type Store, saleHandles, storesAfter } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { fromLine, render } from "@/lib/mail";
import { tokensFor } from "@/lib/contacts";
import { suppressedAmong } from "@/lib/suppression";
import { storeBase } from "@/lib/purchase-email";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { anniversaryEmail, anniversaryOn, anniversaryWindow } from "@/lib/anniversary-rules";

const CURSOR_KEY = "nl:hg:cursor";
/** A person written to is not written to again for this long: once per date, and never twice in a month. */
const ONCE_DAYS = 30;
const COUNT_DAYS = 62;
/** Pages of a hundred checkouts read for one store in one run. */
const SESSION_PAGES = 3;
/** At most this many emails tried from one store in one run; the rest go the next day, inside the window. */
export const ANNIVERSARIES_PER_STORE_RUN = 100;
/** Checkouts that are not a purchase of a product to look back on. */
const NOT_A_PURCHASE = new Set(["tip", "call", "plan", "package", "request", "upsell"]);
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,255}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const onceKey = (statsId: string, email: string) => `nl:hg:once:${statsId}:${sha(`nimbus-hg-once:${normaliseEmail(email)}`).slice(0, 32)}`;
const countKey = (statsId: string, month: string) => `nl:hg:count:${statsId}:${month}`;
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** A day as the store's language writes it: "November 6, 2025", "6 de noviembre de 2025". */
const day = (seconds: number, language: unknown) =>
  new Date(seconds * 1000).toLocaleDateString(LANGUAGES[parseLanguage(language)].locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

type Candidate = { email: string; product: string; created: number; session: string };

/** A checkout's charge as the list expanded it: known untouched only when Stripe said so, field by field. */
function chargeUntouched(payment: unknown): boolean | null {
  if (!payment || typeof payment !== "object") return null;
  const charge = (payment as { latest_charge?: unknown }).latest_charge;
  if (!charge || typeof charge !== "object") return null;
  const { refunded, amount_refunded: amountRefunded, disputed } = charge as Record<string, unknown>;
  if (typeof refunded !== "boolean" || typeof disputed !== "boolean" || typeof amountRefunded !== "number") return null;
  return !refunded && amountRefunded === 0 && !disputed;
}

/** One listed checkout, read whole: a candidate, or null when it is not one (or not known to be one). */
function candidateOf(row: unknown, handles: Set<string>, window: { from: number; upTo: number }): Candidate | null {
  if (!row || typeof row !== "object") return null;
  const s = row as Record<string, unknown>;
  const meta = s.metadata && typeof s.metadata === "object" && !Array.isArray(s.metadata) ? (s.metadata as Record<string, unknown>) : null;
  if (!meta || typeof s.id !== "string" || !SESSION_ID.test(s.id)) return null;
  if (typeof meta.store !== "string" || !handles.has(meta.store)) return null;
  // The box at that checkout, said yes to: nothing else stands for it.
  if (meta.news !== "yes") return null;
  if (typeof meta.product !== "string" || !meta.product) return null;
  if (typeof meta.kind === "string" && NOT_A_PURCHASE.has(meta.kind)) return null;
  if (s.status !== "complete" || s.payment_status !== "paid" || s.mode !== "payment") return null;
  if (typeof s.amount_total !== "number" || s.amount_total <= 0) return null;
  if (typeof s.created !== "number" || s.created < window.from || s.created > window.upTo) return null;
  if (chargeUntouched(s.payment_intent) !== true) return null;
  const details = s.customer_details && typeof s.customer_details === "object" ? (s.customer_details as { email?: unknown }) : {};
  const raw = typeof details.email === "string" ? details.email : typeof s.customer_email === "string" ? s.customer_email : "";
  if (!raw || !EMAIL_PATTERN.test(raw)) return null;
  return { email: normaliseEmail(raw), product: meta.product, created: s.created, session: s.id };
}

/** The paid checkouts of the window, whole pages only: a page that is not a list stops the store's run (nothing is sent). */
async function windowCheckouts(store: Store, window: { from: number; upTo: number }, deadline: number): Promise<unknown[]> {
  const rows: unknown[] = [];
  let after = "";
  for (let page = 0; page < SESSION_PAGES && Date.now() < deadline; page += 1) {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(window.from), "created[lte]": String(window.upTo) });
    query.append("expand[]", "data.payment_intent.latest_charge");
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", store.stripeAccountId as string, `/checkout/sessions?${query}`);
    if (!Array.isArray(listed.data) || (listed.has_more !== true && listed.has_more !== false)) throw new Error("a page of checkouts could not be read whole");
    rows.push(...(listed.data as unknown[]));
    const last = (listed.data as { id?: unknown }[]).at(-1)?.id;
    if (listed.has_more === false || typeof last !== "string" || !last) break;
    after = last;
  }
  return rows;
}

/** One store's purchases of a year ago, each buyer written to once. */
export async function anniversaryStore(store: Store, deadline: number, now = Date.now()): Promise<number> {
  if (!anniversaryOn(store) || !store.stripeAccountId || !store.statsId || !store.listId) return 0;
  const statsId = store.statsId;
  const listId = store.listId;
  const window = anniversaryWindow(now);
  const handles = saleHandles(store);
  // Oldest first: Stripe lists newest first, and the oldest are about to leave the window. Each person's first
  // purchase of the window is the one named; whatever else they bought that day does not mean a second email.
  const found = (await windowCheckouts(store, window, deadline))
    .reverse()
    .map((row) => candidateOf(row, handles, window))
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => a.created - b.created);
  const byPerson = new Map<string, Candidate>();
  for (const candidate of found) if (!byPerson.has(candidate.email)) byPerson.set(candidate.email, candidate);
  if (!byPerson.size) return 0;
  // On the list and may be written to now; and not deleted from the store, read whole or the run sends nothing.
  const emails = [...byPerson.keys()];
  const tokens = await tokensFor(listId, emails, store.handle);
  const deleted = await suppressedAmong(listId, emails.filter((e) => tokens.has(e)));
  const base = storeBase(store);
  let tried = 0;
  let sent = 0;

  for (const candidate of byPerson.values()) {
    if (Date.now() >= deadline || tried >= ANNIVERSARIES_PER_STORE_RUN) break;
    const unsub = tokens.get(candidate.email);
    if (!unsub || deleted.has(candidate.email)) continue;
    const product = await readListing(store, candidate.product);
    if (!product) continue;
    const claim = claimValue();
    const key = onceKey(statsId, candidate.email);
    // Ours only on an exact claim: written to lately, or an unknown answer, sends nothing.
    if ((await claimMark(key, ONCE_DAYS * 86_400, claim)) !== "ours") continue;
    tried += 1;
    try {
      const mail = anniversaryEmail({
        storeName: store.name,
        title: product.title,
        boughtOn: day(candidate.created, store.language),
        message: store.anniversary.message,
        link: base,
        language: store.language,
      });
      // The list email's own footer: why they get it, the one-click way off the list, and the creator's postal address.
      const withAddress = { ...store, mail: { fromName: store.mail?.fromName || store.name, address: store.anniversary.address } };
      const rendered = render(withAddress, mail.subject, mail.body, unsub);
      const ok = await sendEmail({
        meter: { by: "store", store: store, kind: "email" },
        from: fromLine(withAddress),
        to: candidate.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        replyTo: store.email,
        headers: rendered.headers,
        idempotencyKey: `nimbus-hg:${statsId}:${candidate.session}`,
      });
      if (ok) {
        sent += 1;
        const count = countKey(statsId, monthOf(now));
        await redisPipeline([
          ["INCR", count],
          ["EXPIRE", count, COUNT_DAYS * 86_400],
        ]);
      } else {
        // Not sent (the store's figure spent, the sender down): only this run's own claim is let go, for a later run.
        await releaseMark(key, claim);
      }
    } catch (error) {
      await releaseMark(key, claim).catch(() => {});
      console.error("sending an anniversary email failed", store.handle, error);
    }
  }
  return sent;
}

/** How many anniversary emails a store sent this month. */
export async function anniversariesThisMonth(store: Store, now = Date.now()): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [count] = await redisPipeline([["GET", countKey(store.statsId, monthOf(now))]]);
  return Number(count) || 0;
}

/** The daily run: every store with it on, from where the last run stopped. */
export async function sendAnniversaries(deadline: number, now = Date.now()): Promise<{ stores: number; sent: number }> {
  const counts = { stores: 0, sent: 0 };
  if (!isRedisConfigured() || !platformKey() || !isSenderConfigured()) return counts;
  const [saved] = await redisPipeline([["GET", CURSOR_KEY]]);
  const [savedCursor, savedDone] = typeof saved === "string" ? saved.split("|") : ["0", "0"];
  let cursor = /^\d+$/.test(savedCursor ?? "") ? savedCursor : "0";
  let skip = Number(savedDone) || 0;
  while (Date.now() < deadline) {
    const { stores, next } = await storesAfter(cursor);
    let done = 0;
    for (const store of stores) {
      if (done < skip) {
        done += 1;
        continue;
      }
      if (Date.now() >= deadline) break;
      if (anniversaryOn(store) && store.stripeAccountId && store.statsId && store.listId) {
        counts.stores += 1;
        try {
          counts.sent += await anniversaryStore(store, deadline, now);
        } catch (error) {
          console.error("reading a store's purchases of a year ago failed", store.handle, error);
        }
      }
      done += 1;
    }
    if (done < stores.length) {
      await redisPipeline([["SET", CURSOR_KEY, `${cursor}|${done}`]]);
      return counts;
    }
    skip = 0;
    cursor = next;
    if (next === "0") break;
  }
  await redisPipeline([["SET", CURSOR_KEY, `${cursor}|0`]]);
  return counts;
}

/** Forgets that one person was written to on a purchase's anniversary (lib/person-erasure.ts). */
export async function forgetAnniversaryPerson(statsId: string | null, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["DEL", onceKey(statsId, email)]]);
  return Number(gone) || 0;
}
