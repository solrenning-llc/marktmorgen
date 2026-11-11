/**
 * Sending the come-back offer (lib/winback.ts), and opening the checkout its
 * link leads to.
 *
 * Read once a day, from the creator's own Stripe account: the memberships
 * that ended in a two-day window ending the chosen number of days ago. The
 * list of ended memberships comes from Stripe's events
 * (customer.subscription.deleted), which Stripe keeps for thirty days and
 * which say when each one ended; listing ended subscriptions instead would
 * mean paging through every membership ever cancelled, oldest-made first.
 *
 * The window is two days wide so a day the job did not run is caught the next
 * day; the mark per subscription keeps that from ever meaning two emails.
 *
 *   nl:wb:<account>:<subscription>     that membership's email went
 *   nl:wb:once:<statsId>:<hash>        that person heard about that product lately
 *   nl:wb:link:<token>                 who a link in an email is for
 *   nl:wb:n:<statsId>                  how many have been sent, for the studio
 */
import { type DigitalConsent, DigitalConsentMissing } from "@/lib/digital-consent";
import { OrdersPausedError } from "@/lib/order-admission";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { onAccount, platformKey } from "@/lib/stripe-account";
import { readStripePage } from "@/lib/stripe-list";
import { type Store, saleHandles, storesAfter } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { canSellProduct, createCheckout } from "@/lib/store-checkout";
import { namedPriceGone, namedPriceOffered } from "@/lib/product-option";
import { withStockHold } from "@/lib/stock";
import { fromLine, render } from "@/lib/mail";
import { tokensFor } from "@/lib/contacts";
import { storeBase } from "@/lib/purchase-email";
import { OFFER_DAYS, ONCE_PER_DAYS, canWinBack, winbackOn } from "@/lib/winback";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { noteForErasure } from "@/lib/erasure-index";

const CURSOR_KEY = "nl:wb:cursor";
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;
const TOKEN_PATTERN = /^[0-9a-f]{40}$/;
const LIVE = new Set(["active", "trialing", "past_due"]);

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sentKey = (account: string, sub: string) => `nl:wb:${account}:${sub}`;
const onceKey = (statsId: string, email: string, product: string) =>
  `nl:wb:once:${statsId}:${sha(`nimbus-wb-once:${normaliseEmail(email)}|${product}`).slice(0, 32)}`;
const linkKey = (token: string) => `nl:wb:link:${token}`;
const countKey = (statsId: string) => `nl:wb:n:${statsId}`;

/** A day as the store's language writes it: "October 8, 2026", "8 de octubre de 2026". */
const day = (seconds: number, language: unknown) =>
  new Date(seconds * 1000).toLocaleDateString(LANGUAGES[parseLanguage(language)].locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The email, and nothing else: pure, so it can be read before it is sent. In
 * the store's language (lib/buyer-words/affiliates.ts), English when none is
 * given; `endedOn`, `offer` and `until` arrive already written in it.
 */
export function winbackEmail(input: {
  storeName: string;
  title: string;
  endedOn: string;
  offer: string;
  link: string;
  until: string;
  language?: unknown;
}): { subject: string; body: string } {
  const a = affiliatesWords(input.language);
  return {
    subject: a.winbackSubject(input.title, input.offer).slice(0, 200),
    body: [
      a.hi,
      "",
      a.winbackBody(input.title, input.endedOn, input.offer, input.until),
      "",
      input.link,
      "",
      a.winbackLinkNote,
      "",
      `— ${input.storeName}`,
    ].join("\n"),
  };
}

type Ended = {
  id?: unknown;
  customer?: unknown;
  ended_at?: unknown;
  metadata?: Record<string, string> | null;
  items?: { data?: { price?: { recurring?: { interval?: unknown; interval_count?: unknown } | null } | null }[] } | null;
};

/** Pages of a customer's memberships read before "has not come back" is left unknown. */
const CAME_BACK_PAGES = 5;
/**
 * Pages of memberships read for one offer, across every customer of the address (audit R43): past them, "has not
 * come back" is left unknown and nothing is sent. The customers of one address are read on one page of a hundred.
 */
const CAME_BACK_OFFER_PAGES = 10;

/**
 * Whether this address has a live membership to this product on the creator's account now: true, false, or null
 * when it cannot be said (CX-123 rule 24, L6). "No" needs the whole list: every page read to has_more false, each a
 * list. A page that is not one, a membership without an id to go on from, or more pages than are read is unknown,
 * never "has not come back", so no offer goes to somebody who may already be back.
 */
async function cameBack(account: string, customer: string, product: string, budget: { pages: number }): Promise<boolean | null> {
  let after = "";
  for (let page = 0; page < CAME_BACK_PAGES; page += 1) {
    if (budget.pages <= 0) return null;
    budget.pages -= 1;
    const listed = await onAccount("GET", account, `/subscriptions?customer=${customer}&status=all&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
    const subs: unknown = listed.data;
    if (!Array.isArray(subs) || (listed.has_more !== true && listed.has_more !== false)) return null;
    // Each membership read whole (Codex N on #2714): a status in words and its metadata as an object. A row missing
    // either cannot show it is to another product, so the answer is unknown, never "has not come back".
    for (const sub of subs as unknown[]) {
      if (!sub || typeof sub !== "object") return null;
      const { status, metadata } = sub as { status?: unknown; metadata?: unknown };
      if (typeof status !== "string" || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
      if (LIVE.has(status) && (metadata as Record<string, unknown>).product === product) return true;
    }
    if (listed.has_more === false) return false;
    const last = (subs as { id?: unknown }[]).at(-1)?.id;
    if (typeof last !== "string" || !SUB_PATTERN.test(last)) return null;
    after = last;
  }
  return null;
}

/**
 * Whether this address is back on this product under any of its customers on the creator's account: true, false, or
 * null when it cannot be said (audit R43; CX-123 rule 24). Each store checkout makes a new customer, so the one whose
 * membership ended is read first, then every other customer listed under the address as Stripe holds it and in small
 * letters (Stripe's email filter matches the text exactly). A customer list that is not one, read in part, with a row
 * that cannot be read, or not read at all (a provider error), and more memberships than CAME_BACK_OFFER_PAGES, are
 * unknown, never "has not come back".
 */
async function cameBackUnder(account: string, customer: string, email: string, product: string): Promise<boolean | null> {
  const budget = { pages: CAME_BACK_OFFER_PAGES };
  const own = await cameBack(account, customer, product, budget);
  if (own !== false) return own;
  try {
    const others: string[] = [];
    for (const address of new Set([email, normaliseEmail(email)])) {
      const page = readStripePage(await onAccount("GET", account, `/customers?${new URLSearchParams({ email: address, limit: "100" })}`), undefined, CUSTOMER_PATTERN);
      if (page.hasMore || page.unreadable > 0) return null;
      for (const row of page.rows) if (row.id !== customer && !others.includes(row.id)) others.push(row.id);
    }
    for (const other of others) {
      const back = await cameBack(account, other, product, budget);
      if (back !== false) return back;
    }
    return false;
  } catch (error) {
    console.error("reading whether a member came back failed", error);
    return null;
  }
}

/** Pages of a window's ended memberships read in one run (a hundred each). */
const EVENT_PAGES = 10;
/**
 * At most this many offers looked at per store per run (Claude 3 on #2714): each is a customer read, up to two
 * pages of the address's customers, up to CAME_BACK_OFFER_PAGES pages of their memberships and an email. The window
 * is read whole to decide, but no more than this is spent on it in one run, as when only its first page was read;
 * the rest wait for the next run.
 */
const OFFERS_PER_RUN = 100;

async function sweepStore(store: Store, deadline: number, now: number): Promise<number> {
  const account = store.stripeAccountId as string;
  const statsId = store.statsId as string;
  const handles = saleHandles(store);
  const nowSeconds = Math.floor(now / 1000);
  const upTo = nowSeconds - store.winback.days * 86_400;
  const from = upTo - 2 * 86_400;
  // Every ended membership of the window, past the first page (CX-123 rule 24, L6): a page that is not a list stops
  // the run for this store (nothing is sent on it), never reads as "no more ended memberships".
  const events: { id?: unknown; data?: { object?: Ended } }[] = [];
  let after = "";
  for (let page = 0; page < EVENT_PAGES && Date.now() < deadline; page += 1) {
    const query = new URLSearchParams({ type: "customer.subscription.deleted", limit: "100", "created[gte]": String(from), "created[lte]": String(upTo) });
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", account, `/events?${query}`);
    if (!Array.isArray(listed.data) || (listed.has_more !== true && listed.has_more !== false)) throw new UnknownReplyError("a page of ended memberships");
    const rows = listed.data as { id?: unknown; data?: { object?: Ended } }[];
    events.push(...rows);
    const last = rows.at(-1)?.id;
    if (listed.has_more === false || typeof last !== "string" || !last) break;
    after = last;
  }
  let sent = 0;
  let lookedAt = 0;

  // Oldest first (Claude 4 on #2714): Stripe lists events newest first, and the window is two days wide with one run
  // a day, so the offers a run can look at go to the ended memberships about to leave the window, not the newest.
  for (const event of [...events].reverse()) {
    if (Date.now() >= deadline || lookedAt >= OFFERS_PER_RUN) break;
    const sub = event.data?.object ?? {};
    const subId = typeof sub.id === "string" && SUB_PATTERN.test(sub.id) ? sub.id : "";
    const customer = typeof sub.customer === "string" && CUSTOMER_PATTERN.test(sub.customer) ? sub.customer : "";
    const meta = sub.metadata ?? {};
    // A membership of this store; never a payment plan, which ends by
    // design, nor a membership sold to end after a set number of payments.
    if (!subId || !customer || !handles.has(meta.store ?? "") || !meta.product || meta.kind === "plan" || meta.ends_after) continue;
    const product = await readListing(store, meta.product);
    if (!product?.recurring || !canSellProduct(store, product)) continue;
    // The price they left: one removed, or kept with nothing to hand over, is
    // offered to nobody (owner, C2-89). Skipped before any mark, so no email
    // is spent and no later offer is held back by ONCE_PER_DAYS.
    if (!namedPriceOffered(product, meta.option ?? "")) continue;
    const recurring = sub.items?.data?.[0]?.price?.recurring;
    const interval = typeof recurring?.interval === "string" ? recurring.interval : product.recurring.interval;
    const count = typeof recurring?.interval_count === "number" ? recurring.interval_count : 1;
    if (!canWinBack(store.winback, interval, count)) continue;

    // Ours only when Redis says OK or, answered in another shape, the key holds this claim's own value read back
    // (CX-123 rule 24, L6; Claude 4 on #2714). Somebody else's mark, or unknown: nothing is sent and nothing let go.
    const claim = claimValue();
    if ((await claimMark(sentKey(account, subId), 90 * 86_400, claim)) !== "ours") continue;
    lookedAt += 1;
    try {
      const found = await onAccount("GET", account, `/customers/${customer}`);
      const email = typeof found.email === "string" && EMAIL_PATTERN.test(found.email) ? normaliseEmail(found.email) : "";
      if (!email || found.deleted === true) continue;
      const back = await cameBackUnder(account, customer, found.email as string, product.id);
      if (back === null) {
        // Not known whether they came back: nothing is sent, and the mark (ours) is let go for a whole reading next run.
        await releaseMark(sentKey(account, subId), claim);
        continue;
      }
      if (back) continue;
      // Somebody who agreed to hear from the creator and has not left the
      // list: the list's own token is what the unsubscribe link carries, and
      // no token means no agreement to write under.
      if (!store.listId) continue;
      const tokens = await tokensFor(store.listId, [email], store.handle);
      const unsub = tokens.get(email);
      if (!unsub) continue;
      const onceValue = claimValue();
      const once = await claimMark(onceKey(statsId, email, product.id), ONCE_PER_DAYS * 86_400, onceValue);
      if (once !== "ours") {
        // Heard one lately, or unknown: nothing is sent. On unknown the membership's own mark is let go, so the next
        // run asks again. A once-mark answered oddly that did land holds this claim's value and reads as ours above.
        if (once === "unknown") await releaseMark(sentKey(account, subId), claim);
        continue;
      }

      const token = randomBytes(20).toString("hex");
      const grant = { s: statsId, e: email, p: product.id, o: meta.option ?? "", c: store.winback.coupon, pc: store.winback.percent, m: store.winback.months };
      // Read in their exact shape (CX-123 rule 24, as lib/checkout-recovery.ts writes its stop link): the link written
      // ("OK") and each erasure note a count. Anything else is unknown: the email does not go with a link that may lead
      // to "this offer has ended" or that an erasure could not find; the link that may have landed is taken back (its
      // reply read as nothing) and this run's marks are let go, so the next run sends the offer once.
      const notes = noteForErasure(statsId, email, linkKey(token));
      const written = repliesFor(
        await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", OFFER_DAYS * 86_400], ...notes]).catch(() => null),
        1 + notes.length,
      );
      if (!written || written[0] !== "OK" || written.slice(1).some((reply) => countOf(reply) === null)) {
        await redisPipeline([["DEL", linkKey(token)]]).catch(() => null);
        await releaseMark(onceKey(statsId, email, product.id), onceValue);
        await releaseMark(sentKey(account, subId), claim);
        console.error("a come-back link was not written as asked; nothing sent", store.handle);
        continue;
      }
      const ended = typeof sub.ended_at === "number" ? sub.ended_at : nowSeconds;
      const mail = winbackEmail({
        storeName: store.name,
        title: product.title,
        endedOn: day(ended, store.language),
        offer: affiliatesWords(store.language).winbackOffer(store.winback.percent, store.winback.months),
        link: `${storeBase(store)}/renew/${encodeURIComponent(product.id)}?back=${token}`,
        until: day(nowSeconds + OFFER_DAYS * 86_400, store.language),
        language: store.language,
      });
      // The list email's own footer: why they get it, the one-click way off
      // the list, and the creator's postal address.
      const withAddress = { ...store, mail: { fromName: store.mail?.fromName || store.name, address: store.winback.address } };
      const rendered = render(withAddress, mail.subject, mail.body, unsub);
      const ok = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
        from: fromLine(withAddress),
        to: email,
        subject: rendered.subject,
        text: rendered.text,
        replyTo: store.email,
        headers: rendered.headers,
        idempotencyKey: `nimbus-wb:${account}:${subId}`,
      });
      if (ok) {
        sent += 1;
        await redisPipeline([["INCR", countKey(statsId)]]);
      } else {
        // false is refused or unknown alike (Amazon SES or Resend may have taken it and the reply been lost), so the
        // marks and the offer's link are kept, as lib/trial-nudges.ts keeps its mark: the person is written to at most
        // once, and the link in an email that may have arrived keeps working (CX-123 rule 24).
        console.error("a come-back offer may not have gone; kept as sent", store.handle);
      }
    } catch (error) {
      console.error("sending a come-back offer failed", store.handle, error);
    }
  }
  return sent;
}

/** How many come-back emails a store has sent. */
export async function winbacksSent(store: Store): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["GET", countKey(store.statsId)]]);
  return Number(n) || 0;
}

/** The daily run: every store with the offer on, from where the last run stopped. */
export async function sendWinBacks(deadline: number, now = Date.now()): Promise<{ stores: number; sent: number }> {
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
      if (winbackOn(store) && store.stripeAccountId && store.statsId && store.listId) {
        counts.stores += 1;
        try {
          counts.sent += await sweepStore(store, deadline, now);
        } catch (error) {
          console.error("reading a store's ended memberships failed", store.handle, error);
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

/** `percent` and `months` are the offer as it was emailed, whatever the setting says now. */
export type WinBackGrant = { email: string; product: string; option: string; coupon: string; until: number; percent: number; months: number };

/**
 * Who a link in a come-back email is for, on this store and product, while it works.
 *
 * null only for a link that is not one (a malformed token), an absent key (an
 * offer never sent or ended) or a whole grant for another store, another
 * product or no offer. Any other reply, or none, throws UnknownReplyError
 * (CX-123 rule 24): an unknown reading is never told as an offer that has ended.
 */
export async function readWinBack(store: Store, product: string, token: string): Promise<WinBackGrant | null> {
  if (!TOKEN_PATTERN.test(token) || !store.statsId || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", linkKey(token)], ["TTL", linkKey(token)]]), 2);
  if (!replies) throw new UnknownReplyError("a come-back link");
  const [raw, ttl] = replies;
  if (raw === null) return null;
  if (typeof raw !== "string" || typeof ttl !== "number" || !Number.isSafeInteger(ttl)) throw new UnknownReplyError("a come-back link");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UnknownReplyError("a come-back link");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UnknownReplyError("a come-back link");
  const g = parsed as { s?: unknown; e?: unknown; p?: unknown; o?: unknown; c?: unknown; pc?: unknown; m?: unknown };
  if (g.s !== store.statsId || g.p !== product || typeof g.e !== "string" || typeof g.c !== "string" || !g.c) return null;
  const left = ttl > 0 ? ttl : 0;
  const percent = typeof g.pc === "number" ? g.pc : 0;
  const months = typeof g.m === "number" ? g.m : 1;
  if (!percent) return null;
  return { email: g.e, product, option: typeof g.o === "string" ? g.o : "", coupon: g.c, until: Math.floor(Date.now() / 1000) + left, percent, months };
}

/** "unknown": the link could not be read just now (readWinBack threw); never said as "expired". */
export type OpenResult = { ok: true; url: string } | { ok: false; reason: "expired" | "unavailable" | "price" | "refused" | "consent" | "unknown" };

/** The checkout a come-back link opens: this product, this address, the offer applied, no second trial. */
export async function openWinBack(
  store: Store,
  productId: string,
  token: string,
  origin: string,
  /** The box to start access at once, checked on the button's page (lib/digital-consent.ts). */
  consent: DigitalConsent | null = null,
): Promise<OpenResult> {
  let grant: WinBackGrant | null;
  try {
    grant = await readWinBack(store, productId, token);
  } catch (error) {
    // Redis answered the link oddly or not at all: nothing opened, nothing charged, and not said as ended (rule 24).
    console.error("reading a come-back link failed", store.handle, error);
    return { ok: false, reason: "unknown" };
  }
  if (!grant) return { ok: false, reason: "expired" };
  const product = await readProduct(store, productId);
  if (!product?.recurring) return { ok: false, reason: "unavailable" };
  // The option they had. One the creator has since taken away, even the
  // last, is not swapped for another or for the product's own price: the
  // page says that price is no longer offered, with a link to the product's page.
  if (namedPriceGone(product, grant.option)) return { ok: false, reason: "price" };
  // Not on sale now, or the option kept with nothing to hand over: the general answer, nothing charged.
  if (!canSellProduct(store, product) || !namedPriceOffered(product, grant.option)) return { ok: false, reason: "unavailable" };
  const option = product.options.length ? grant.option : undefined;
  try {
    // A limited product holds a unit while the checkout is open, as any other checkout does.
    const held = await withStockHold(store, product, (holding) =>
      createCheckout(store, product, origin, option, { coupon: grant.coupon, email: grant.email, noTrial: true, held: holding, digitalConsent: consent }),
    );
    if (!held.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, url: held.value.url };
  } catch (error) {
    // A coupon the creator deleted in their own dashboard, most likely: said
    // plainly, with the ordinary way back, rather than a checkout at a price
    // the email did not promise.
    // The store's orders for the month are reached (lib/order-admission.ts): not open right now, nothing charged.
    if (error instanceof OrdersPausedError) return { ok: false, reason: "unavailable" };
    // The box to start access at once was not checked: said beside it, nothing opened.
    if (error instanceof DigitalConsentMissing) return { ok: false, reason: "consent" };
    console.error("opening a come-back checkout failed", store.handle, error);
    return { ok: false, reason: "refused" };
  }
}

/** Forgets that one person heard a come-back offer about each product lately (lib/person-erasure.ts). */
export async function forgetWinbackPerson(statsId: string | null, productIds: string[], email: string): Promise<number> {
  if (!statsId || !productIds.length || !isRedisConfigured()) return 0;
  // DEL's own count only: any other answer throws (CX-123 rule 24), so the erasure is never reported done on it.
  const gone = countOf(repliesFor(await redisPipeline([["DEL", ...productIds.map((p) => onceKey(statsId, email, p))]]), 1)?.[0]);
  if (gone === null) throw new UnknownReplyError("the come-back marks forgotten");
  return gone;
}
