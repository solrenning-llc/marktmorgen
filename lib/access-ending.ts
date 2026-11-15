/**
 * 361 [AP1] (e), unit 2: the reminder a member gets the day before their
 * access ends (the rules: lib/access-ending-rules.ts), sent from the daily run
 * that already reads the store's running memberships for the come-back email
 * (lib/member-nudge.ts sendMemberNudges), so Stripe's list is read once for both.
 *
 * Off until the creator turns it on, with the postal address every email to a
 * list carries. For each membership whose end, as Stripe gives it, is ahead and
 * at most a day away, and only to somebody who agreed to hear from the creator
 * and has not left the list:
 *
 *   - its end is claimed once (endingMark, kept 400 days), so one end gets one
 *     reminder however often the run comes back;
 *   - the membership is read again from Stripe just before sending; a read
 *     that fails, an end that moved or went away (they changed their mind), or
 *     a membership no longer running sends nothing, and the claim is let go;
 *   - it goes out as a list email from the store, counted in the store's own
 *     email quota (meter by "store"), with the real end date, the way to keep
 *     it (the member's own page), the one-click way off and the postal address;
 *   - a send that fails lets the claim go, so the next run can try.
 *
 * No discount, urgency or scarcity: a fact and a way to act on it.
 */
import { redisPipeline } from "@/lib/redis";
import { sendEmail } from "@/lib/email";
import type { Store } from "@/lib/store";
import { fromLine, render } from "@/lib/mail";
import { tokensFor } from "@/lib/contacts";
import { storeBase } from "@/lib/purchase-email";
import { readListings } from "@/lib/catalog";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { endsAtOf } from "@/lib/membership-manage";
import { onAccount } from "@/lib/stripe-account";
import { productOfSub } from "@/lib/tier-rules";
import { endingDue, endingMark } from "@/lib/access-ending-rules";

const KEEP_SECONDS = 400 * 86_400;

type Sub = { id?: unknown; status?: unknown; customer?: { email?: unknown } | string | null; metadata?: Record<string, string> | null };

const emailOf = (sub: Sub) =>
  sub.customer && typeof sub.customer === "object" && typeof sub.customer.email === "string" ? sub.customer.email.trim().toLowerCase() : "";
const endOf = (sub: Sub) => endsAtOf(sub as Parameters<typeof endsAtOf>[0]);

/** The real end, in the store's language, to the minute, in UTC so it is the same for everybody. */
function endWords(store: Store, endsAt: number): string {
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  return `${new Date(endsAt * 1000).toLocaleString(locale, { dateStyle: "long", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

/** One store's reminders, from the running memberships the daily run read. Returns how many went out. */
export async function endingStore(store: Store, rows: readonly Sub[], deadline: number, now = Date.now()): Promise<number> {
  if (!store.ending?.on || !store.stripeAccountId || !store.statsId || !store.listId) return 0;
  const due = rows
    .map((sub) => ({ sub, id: typeof sub.id === "string" ? sub.id : "", email: emailOf(sub), endsAt: endOf(sub) }))
    .filter((m) => m.id && m.email && typeof m.endsAt === "number" && endingDue({ status: String(m.sub.status ?? ""), endsAt: m.endsAt }, now));
  if (!due.length) return 0;
  // Only those who agreed to hear from the creator and have not left the list.
  const tokens = await tokensFor(store.listId, [...new Set(due.map((m) => m.email))], store.handle);
  const listings = new Map((await readListings(store, [...new Set(due.map((m) => productOfSub(m.sub as never)))]).catch(() => [])).map((p) => [p.id, p]));
  const statsId = store.statsId;
  const account = store.stripeAccountId;
  const words = membershipWords(parseLanguage(store.language));
  let sent = 0;

  for (const member of due) {
    if (Date.now() >= deadline) break;
    const unsub = tokens.get(member.email);
    const listing = listings.get(productOfSub(member.sub as never));
    if (!unsub || !listing) continue;
    const endsAt = member.endsAt as number;
    const key = endingMark(statsId, member.id, endsAt);
    const claim = await redisPipeline([["SET", key, String(now), "NX", "EX", KEEP_SECONDS]]);
    if (!Array.isArray(claim) || claim.length !== 1 || !Object.hasOwn(claim, 0) || (claim[0] !== "OK" && claim[0] !== null)) {
      // The mark may already exist: never send or delete it without proof that this attempt owns it.
      throw new Error("Access reminder ownership could not be confirmed");
    }
    if (claim[0] === null) continue;
    let accepted = false;
    try {
      // Read again just before sending: they may have changed their mind, or the end may have moved.
      const again = (await onAccount("GET", account, `/subscriptions/${encodeURIComponent(member.id)}`).catch(() => null)) as Sub | null;
      const freshEnd = again && again.id === member.id ? endOf(again) : null;
      if (!again || freshEnd !== endsAt || !endingDue({ status: String(again.status ?? ""), endsAt: freshEnd }, Date.now())) {
        await redisPipeline([["DEL", key]]);
        continue;
      }
      const when = endWords(store, endsAt);
      const subject = words.endingSubject(listing.title, when).slice(0, 200);
      const body = [words.endingLead(listing.title, store.name, when), "", words.endingKeep, `${storeBase(store)}/manage`].join("\n");
      const withAddress = { ...store, mail: { fromName: store.mail?.fromName || store.name, address: store.ending.address } };
      const rendered = render(withAddress, subject, body, unsub);
      const ok = await sendEmail({
        meter: { by: "store", store, kind: "email" },
        from: fromLine(withAddress),
        to: member.email,
        subject: rendered.subject,
        text: rendered.text,
        replyTo: store.email,
        headers: rendered.headers,
        idempotencyKey: `nimbus-ending:${statsId}:${member.id}:${endsAt}`,
      });
      if (ok) {
        accepted = true;
        sent += 1;
      }
    } catch (error) {
      console.error("sending an access reminder failed", store.handle, error);
    }
    if (!accepted) await redisPipeline([["DEL", key]]).catch(() => {});
  }
  return sent;
}
