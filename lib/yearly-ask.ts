/**
 * The one email that offers a monthly member the same membership's yearly
 * price (added 12 October 2026; the rules are lib/yearly-switch-rules.ts).
 *
 * Once a day, for every store that turned it on: each running monthly member
 * whose membership could move to yearly, from their third monthly payment
 * on, gets one email from the store — once per membership, ever. It says
 * what they pay now, what a year costs and what it saves, and links to the
 * page that shows, in Stripe's own figures, what moving would charge today
 * (lib/yearly-switch.ts). That link opens that one switch and nothing else,
 * for 14 days; nothing changes unless the member presses the button there.
 *
 * Only to those who agreed to hear from the creator and have not left the
 * list: it goes out as a list email, with the reason they get it, the
 * one-click way off and the creator's postal address.
 *
 *   nl:yearask:<statsId>:<sub>               sent, kept five years: once per membership
 *   nl:yearask:count:<statsId>:<yyyy-mm>     sent this month, 400 days
 *   nl:yearask:cursor                         where the last run stopped
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { types } from "node:util";
import { UnknownReplyError } from "@/lib/redis-reply";
import { orderWrite } from "@/lib/order-data";
import { platformKey } from "@/lib/stripe-account";
import { isSenderConfigured, sendEmail } from "@/lib/email";
import { type Listing, type Store, storesAfter } from "@/lib/store";
import { sellsMemberships } from "@/lib/membership-manage";
import { fromLine, render } from "@/lib/mail";
import { tokensFor } from "@/lib/contacts";
import { storeBase } from "@/lib/purchase-email";
import { readListings } from "@/lib/catalog";
import { canSellProduct } from "@/lib/store-checkout";
import { normaliseEmail } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";
import { productOfSub } from "@/lib/tier-rules";
import { runningMembers } from "@/lib/member-health";
import { type YearlyChoice, type YearlySub, askFits, yearlyChoice } from "@/lib/yearly-switch-rules";
import { YEARLY_TARGET, mintYearlyLink, priceWords } from "@/lib/yearly-switch";

const CURSOR_KEY = "nl:yearask:cursor";
const SENT_SECONDS = 5 * 365 * 86_400;
const COUNT_SECONDS = 400 * 86_400;
/** At most this many from one store in one run; the rest go the next day. */
const PER_RUN = 200;
const sentKey = (statsId: string, sub: string) => `nl:yearask:${statsId}:${sub}`;
const countKey = (statsId: string, month: string) => `nl:yearask:count:${statsId}:${month}`;
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** Snapshot only the exact inert replies the existing commands requested. */
function offerReplies(value: unknown, count: number): unknown[] | null {
  try {
    if (types.isProxy(value) || !Array.isArray(value) || Object.getOwnPropertySymbols(value).length) return null;
    const size = Object.getOwnPropertyDescriptor(value, "length");
    if (!size || !Object.hasOwn(size, "value") || size.value !== count || Object.getOwnPropertyNames(value).length !== count + 1) return null;
    const replies: unknown[] = [];
    for (let i = 0; i < count; i++) {
      const item = Object.getOwnPropertyDescriptor(value, String(i));
      if (!item || !Object.hasOwn(item, "value")) return null;
      replies.push(item.value);
    }
    return replies;
  } catch { return null; }
}

/** The email, pure: what a member reads. */
export function yearlyAskEmail(input: { storeName: string; title: string; monthly: string; yearly: string; saving: string; url: string; language?: LanguageCode }): { subject: string; body: string } {
  const m = membershipWords(input.language);
  return {
    subject: m.askSubject(input.title, input.saving).slice(0, 200),
    body: [
      m.askLead(input.storeName, input.title, input.monthly, input.yearly, input.saving),
      "",
      m.askSee,
      input.url,
      "",
      m.askWorks,
      "",
      m.askReply(input.storeName),
    ].join("\n"),
  };
}

type Row = { sub: string; customer: string; email: string; product: Listing; choice: YearlyChoice };

/** One store's monthly members the email fits, each written to once. */
export async function askStore(store: Store, deadline: number, now = Date.now()): Promise<number> {
  if (!store.yearlyAsk.on || !store.stripeAccountId || !store.statsId || !store.listId) return 0;
  const { rows } = await runningMembers(store);
  const nowSeconds = Math.floor(now / 1000);
  const ids = [...new Set(rows.map((r) => productOfSub(r as Parameters<typeof productOfSub>[0])).filter(Boolean))];
  if (!ids.length) return 0;
  const listings = new Map((await readListings(store, ids).catch(() => [] as Listing[])).map((p) => [p.id, p]));
  const fits: Row[] = [];
  for (const raw of rows) {
    const sub = raw as YearlySub & { id?: unknown; customer?: unknown };
    const product = listings.get(productOfSub(raw as Parameters<typeof productOfSub>[0]));
    if (typeof sub.id !== "string" || !product || !canSellProduct(store, product) || !askFits(sub, nowSeconds)) continue;
    const choice = yearlyChoice(sub, product, store.tiers, store.currency, nowSeconds);
    const customer = sub.customer && typeof sub.customer === "object" ? (sub.customer as { id?: unknown; email?: unknown }) : null;
    const email = typeof customer?.email === "string" ? normaliseEmail(customer.email) : "";
    if (!choice || !email || typeof customer?.id !== "string") continue;
    fits.push({ sub: sub.id, customer: customer.id, email, product, choice });
  }
  if (!fits.length) return 0;
  const statsId = store.statsId;
  // Those already written to are skipped before anything else is asked.
  const seen = offerReplies(await redisPipeline(fits.map((f) => ["EXISTS", sentKey(statsId, f.sub)])), fits.length);
  if (!seen || seen.some(value => value !== 0 && value !== 1)) throw new UnknownReplyError("yearly offer history");
  const fresh = fits.filter((_, i) => seen[i] === 0).slice(0, PER_RUN);
  if (!fresh.length) return 0;
  // Only those who agreed to hear from the creator and have not left the list.
  const tokens = await tokensFor(store.listId, [...new Set(fresh.map((f) => f.email))], store.handle);
  const base = storeBase(store);
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  let sent = 0;
  for (const row of fresh) {
    if (Date.now() >= deadline) break;
    const unsub = tokens.get(row.email);
    if (!unsub) continue;
    const key = sentKey(statsId, row.sub);
    // Five years, counted as for good in the store's room (lib/order-data.ts).
    const claim = offerReplies(await orderWrite(store, [["SET", key, String(now), "NX", "EX", SENT_SECONDS]]), 1);
    if (!claim || (claim[0] !== null && claim[0] !== "OK")) throw new UnknownReplyError("a yearly offer claim");
    const claimed = claim[0];
    if (claimed === null) continue;
    // Set once the email is handed to the sender: from then on, not sent is not known (CX-123 rule 24).
    let handed = false;
    try {
      const token = await mintYearlyLink(store, row.customer, row.sub);
      const url = `${base}/manage/switch?token=${token}&sub=${encodeURIComponent(row.sub)}&to=${YEARLY_TARGET}&from=offer`;
      const mail = yearlyAskEmail({
        storeName: store.name,
        title: row.product.title,
        monthly: priceWords(store, row.choice.monthly, "month", store.language),
        yearly: priceWords(store, row.choice.cents, "year", store.language),
        saving: formatMoney(row.choice.saving, store.currency, locale),
        url,
        language: store.language as LanguageCode,
      });
      const withAddress = { ...store, mail: { fromName: store.mail?.fromName || store.name, address: store.yearlyAsk.address } };
      const rendered = render(withAddress, mail.subject, mail.body, unsub);
      handed = true;
      const ok = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
        from: fromLine(withAddress),
        to: row.email,
        subject: rendered.subject,
        text: rendered.text,
        replyTo: store.email,
        headers: rendered.headers,
        idempotencyKey: `nimbus-yearask:${statsId}:${row.sub}`,
      });
      if (ok) {
        sent += 1;
        const count = countKey(statsId, monthOf(now));
        await redisPipeline([
          ["INCR", count],
          ["EXPIRE", count, COUNT_SECONDS],
        ]);
      } else {
        // false is refused or unknown alike (Amazon SES or Resend may have taken it and the reply been lost), so the
        // mark is kept, as lib/trial-nudges.ts keeps its own: the offer goes at most once, never twice (CX-123 rule 24).
        console.error("the yearly offer may not have gone; kept as sent", store.handle);
      }
    } catch (error) {
      // Let go only when nothing was handed to the sender: a throw from the send itself is not known either.
      if (!handed) await redisPipeline([["DEL", key]]).catch(() => {});
      console.error("sending the yearly offer failed", store.handle, error);
    }
  }
  return sent;
}

/** How many yearly offers a store sent this month. */
export async function yearlyAsksThisMonth(store: Store, now = Date.now()): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["GET", countKey(store.statsId, monthOf(now))]]);
  return Number(n) || 0;
}

/** The daily run: every store with it on, from where the last run stopped. */
export async function sendYearlyAsks(deadline: number): Promise<{ stores: number; sent: number }> {
  const counts = { stores: 0, sent: 0 };
  if (!isRedisConfigured() || !platformKey() || !isSenderConfigured()) return counts;
  const reply = offerReplies(await redisPipeline([["GET", CURSOR_KEY]]), 1);
  if (!reply) throw new UnknownReplyError("the yearly offer cursor");
  // A confirmed absent key means this job has never kept a resume point.
  const saved = reply[0] === null ? "0|0" : reply[0];
  const match = typeof saved === "string" ? /^(0|[1-9][0-9]*)\|(0|[1-9][0-9]*)$/.exec(saved) : null;
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new UnknownReplyError("the yearly offer cursor");
  let cursor = match[1];
  let skip = Number(match[2]);
  while (Date.now() < deadline) {
    const { stores, next } = await storesAfter(cursor);
    let done = 0;
    for (const store of stores) {
      if (done < skip) {
        done += 1;
        continue;
      }
      if (Date.now() >= deadline) break;
      if (store.yearlyAsk.on && sellsMemberships(store)) {
        counts.stores += 1;
        try {
          counts.sent += await askStore(store, deadline);
        } catch (error) {
          console.error("reading a store's members for the yearly offer failed", store.handle, error);
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
