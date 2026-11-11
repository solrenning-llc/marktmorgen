/**
 * Reminders before a booked call, sent by the five-minute mail job.
 *
 * Each booking gets two, to the buyer: a day before and an hour before, in
 * the buyer's own time zone, with the meeting link, a link to the calendar
 * file and, while it can still be moved, the link to move it. The creator
 * gets one email per time rather than per buyer — at the same two moments —
 * listing everyone booked into it, so a group call of forty is one email.
 *
 * What is due is read from the queue in lib/call-records.ts, planned when a
 * booking is confirmed or moved. Nothing in the queue is trusted beyond "look
 * at this booking now": the booking itself is read from the creator's Stripe
 * account, with its move applied, and a reminder whose booking is no longer
 * paid, or no longer at the time it was planned for, is dropped. Each email
 * is guarded by its own key, so a run that dies half way and the run after
 * it never send the same reminder twice.
 *
 * The same queue carries one check per checkout, made once it has closed: a
 * buyer who paid and never came back to the store is confirmed then, so
 * their confirmation — and their reminders — do not wait for somebody to open
 * the store or the studio.
 */
import { placeLine } from "@/lib/call-place";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isSenderConfigured, sendEmail } from "@/lib/email";
import type { Listing, Store } from "@/lib/store";
import { listingFinder } from "@/lib/catalog";
import { readableTime, seatsAt, zoneName, isTimeZone } from "@/lib/call-setup";
import { VIDEO_ROOM_NOTE, isVideoRoom, roomKind, roomOf } from "@/lib/call-rooms";
import { REMINDER_QUEUE, parseMember } from "@/lib/call-records";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { bookingWords } from "@/lib/buyer-words/booking";
import {
  type PaidCall,
  canMove,
  confirmBooking,
  icsLink,
  isCallProduct,
  isConfirmed,
  moveLink,
  paidCall, paidCalls,
  senderAddress,
  storeSender,
} from "@/lib/calls";

/** How many due entries one run takes on. The rest wait five minutes. */
const BATCH = 200;
/** An entry that could not be dealt with for this long is given up on. */
const GIVE_UP_MS = 6 * 3600_000;
const SENT_SECONDS = 14 * 86_400;

const sentKey = (session: string, start: number, mark: string) => `nl:call:reminded:${session}:${start}:${mark}`;
const creatorKey = (callsId: string, product: string, start: number, mark: string) =>
  `nl:call:creator-reminded:${callsId}:${product}:${start}:${mark}`;

/** Whether a reminder is still worth sending: the day-before one gives way to the hour-before one. */
function stillUseful(mark: "24" | "1", start: number, now: number): boolean {
  return mark === "24" ? now < start - 3600_000 : now < start;
}

function when(mark: "24" | "1"): string {
  return mark === "24" ? "Tomorrow" : "In 1 hour";
}

/** Confirm the whole bounded WITHSCORES reply before processing any member. */
function dueQueue(reply: unknown, now: number): string[] {
  const unreadable = () => new Error("The call reminder queue could not be read.");
  if (!Array.isArray(reply) || reply.length !== 1) throw unreadable();
  const entry = Object.getOwnPropertyDescriptor(reply, "0");
  if (!entry || !("value" in entry)) throw unreadable();
  const raw: unknown = entry.value;
  if (!Array.isArray(raw) || raw.length % 2 !== 0 || raw.length > BATCH * 2) throw unreadable();
  const flat: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const member = Object.getOwnPropertyDescriptor(raw, String(i));
    const score = Object.getOwnPropertyDescriptor(raw, String(i + 1));
    if (!member || !("value" in member) || typeof member.value !== "string" ||
      !score || !("value" in score)) throw unreadable();
    const value: unknown = score.value;
    if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) throw unreadable();
    const at = Number(value);
    if (!Number.isFinite(at) || at < 0 || at > now) throw unreadable();
    flat.push(member.value, String(at));
  }
  return flat;
}

async function remindBuyer(store: Store, product: Listing, call: PaidCall, mark: "24" | "1", origin: string): Promise<boolean> {
  if (!product || !isCallProduct(product) || !call.email) return false;
  const setup = product.call;
  const tz = isTimeZone(call.buyerTz) ? call.buyerTz : setup.tz;
  // In person (lib/call-place.ts): no link, not even a room kept from when it was online.
  const room = setup.place ? null : await roomOf(store.callsId, { product: product.id, setup, session: call.session, start: call.start, end: call.end });
  const minutes = Math.round((call.end - call.start) / 60_000);
  // In the store's language (lib/buyer-words/booking.ts), times in its locale.
  const b = bookingWords(store.language);
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  const isDay = mark === "24";
  return sendEmail({ meter: { by: "order" },
    from: storeSender(store),
    to: call.email,
    subject: b.reminderSubject(isDay, product.title, store.name),
    text: [
      b.reminderHead(isDay, product.title, store.name),
      "",
      b.whenLength(`${readableTime(call.start, tz, locale)} (${zoneName(call.start, tz, locale)})`, minutes),
      "",
      // In person (lib/call-place.ts): the address, and no link.
      setup.place ? b.whereAt(placeLine(setup.place)) : room ? b.joinAtThatTime(room) : b.willSendOrReply(store.name),
      ...(isVideoRoom(room) ? [b.videoRoomNote] : []),
      "",
      b.addToCalendar(icsLink(origin, store, call.session)),
      ...(canMove(setup, call.start, call.moves) ? [b.moveToAnother(moveLink(origin, store, product.id, call.session))] : []),
      b.toCancel(store.name),
    ].join("\n"),
    replyTo: store.email,
  });
}

async function remindCreator(store: Store, product: Listing, paid: PaidCall[], call: PaidCall, mark: "24" | "1"): Promise<boolean> {
  if (!product || !isCallProduct(product)) return false;
  const setup = product.call;
  // In person (lib/call-place.ts): no link, not even a room kept from when it was online.
  const room = setup.place ? null : await roomOf(store.callsId, { product: product.id, setup, session: call.session, start: call.start, end: call.end });
  const people = paid.filter((c) => c.product === call.product && c.start === call.start);
  const emails = people.map((c) => c.email ?? "a buyer who gave no address");
  const seats = seatsAt(setup, call.start);
  const group = setup.kind === "live" || seats > 1;
  return sendEmail({ meter: { by: "order" },
    from: `"Marktmorgen" <${senderAddress()}>`,
    to: store.email,
    subject: `${when(mark)}: ${product.title}, ${readableTime(call.start, setup.tz)}`,
    text: [
      `${product.title} starts ${mark === "24" ? "in a day" : "in an hour"}.`,
      "",
      `${readableTime(call.start, setup.tz)} (${zoneName(call.start, setup.tz)}, your time zone)`,
      "",
      group ? `${people.length} of ${seats} ${seats === 1 ? "seat" : "seats"} booked:` : "Booked by:",
      ...emails.map((email) => `- ${email}`),
      "",
      setup.place
        ? `In person, at: ${placeLine(setup.place)}`
        : room
        ? isVideoRoom(room)
          ? `The private video room, which they have: ${room}\n${VIDEO_ROOM_NOTE} Open it a few minutes early and sign in, so nobody is left waiting.`
          : roomKind(room) === "meet"
            ? `The Google Meet link, which they have: ${room}`
            : roomKind(room) === "zoom"
              ? `The Zoom link, which they have: ${room}\nStart it as the host, signed in to Zoom.`
              : `Your meeting link, which they have: ${room}`
        : `You have not set a meeting link, so send one to ${people.length === 1 ? "them" : "each of them"} before it starts.`,
      "",
      "Everyone booked is also in your studio, under Upcoming calls.",
    ].join("\n"),
  });
}

/**
 * Sends every reminder that is due, and confirms every paid booking whose
 * buyer never came back. Safe to run more than once; one run at a time is the
 * caller's lock.
 */
export async function sendCallReminders(
  findStore: (handle: string) => Promise<Store | null>,
  deadline: number,
  origin: string,
): Promise<{ reminded: number; confirmed: number; dropped: number }> {
  const counts = { reminded: 0, confirmed: 0, dropped: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  const now = Date.now();
  const flat = dueQueue(await redisPipeline([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, now, "WITHSCORES", "LIMIT", 0, BATCH]]), now);

  // One read of Stripe per store, however many of its bookings are due.
  const groups = new Map<string, { member: string; score: number }[]>();
  const broken: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const parsed = parseMember(flat[i]);
    if (!parsed) {
      broken.push(flat[i]);
      continue;
    }
    const key = `${parsed.callsId}|${parsed.handle}`;
    const list = groups.get(key) ?? [];
    list.push({ member: flat[i], score: Number(flat[i + 1]) });
    groups.set(key, list);
  }
  if (broken.length) {
    await redisPipeline([["ZREM", REMINDER_QUEUE, ...broken]]);
    counts.dropped += broken.length;
  }

  for (const [key, members] of groups) {
    if (Date.now() > deadline) break;
    const [callsId, handle] = key.split("|");
    let store: Awaited<ReturnType<typeof findStore>>;
    try {
      store = await findStore(handle);
    } catch (error) {
      // Unknown, not gone: tried again next run, and given up on only once it
      // is hours late, as when Stripe does not answer below, so one unreadable
      // store never holds the batch for good.
      console.error("reading the store for call reminders failed", error);
      const stale = members.filter((m) => now - m.score > GIVE_UP_MS).map((m) => m.member);
      if (stale.length) await redisPipeline([["ZREM", REMINDER_QUEUE, ...stale]]);
      counts.dropped += stale.length;
      continue;
    }
    const done: string[] = [];
    if (!store || store.callsId !== callsId) {
      await redisPipeline([["ZREM", REMINDER_QUEUE, ...members.map((m) => m.member)]]);
      counts.dropped += members.length;
      continue;
    }
    let paid: PaidCall[];
    try {
      paid = await paidCalls(store);
    } catch (error) {
      // Stripe did not answer: tried again next run, and given up on only
      // once it is hours late and no use to anybody.
      console.error("reading paid calls for reminders failed", error);
      const stale = members.filter((m) => now - m.score > GIVE_UP_MS).map((m) => m.member);
      if (stale.length) await redisPipeline([["ZREM", REMINDER_QUEUE, ...stale]]);
      counts.dropped += stale.length;
      continue;
    }
    const bySession = new Map(paid.map((call) => [call.session, call]));
    const find = listingFinder(store);

    for (const { member } of members) {
      const item = parseMember(member);
      done.push(member);
      if (!item) continue;
      // A booking made long ahead in a busy account may be older than the
      // sessions paidCalls reads: it is looked up on its own before it is
      // taken for unpaid or refunded.
      let call: PaidCall | null | undefined;
      try {
        call = bySession.get(item.session) ?? await paidCall(store, item.session);
      } catch (error) {
        console.error("reading one paid call for reminders failed", error);
        done.pop();
        continue;
      }
      const product = call ? await find(call.product) : null;
      if (!call || !product || !isCallProduct(product)) {
        // Never paid, refunded out of the list, or the product is gone.
        counts.dropped += 1;
        continue;
      }
      try {
        if (item.mark === "c") {
          if (call.end > Date.now() && !(await isConfirmed(call.session))) {
            await confirmBooking({
              store,
              product,
              session: call.session,
              start: call.start,
              end: call.end,
              buyerEmail: call.email,
              buyerName: call.name,
              buyerTz: call.buyerTz,
              moves: call.moves,
              answers: call.answers,
              amountCents: call.amount,
              currency: call.currency,
              lead: call.lead,
              pi: call.pi,
              due: call.due,
              cancel: call.cancel,
              origin,
            });
            counts.confirmed += 1;
          }
          continue;
        }
        // Planned for a time the booking has since moved away from: the move
        // planned its own.
        if (call.start !== item.start || !stillUseful(item.mark, call.start, Date.now())) {
          counts.dropped += 1;
          continue;
        }
        const [fresh, freshCreator] = await redisPipeline([
          ["SET", sentKey(call.session, call.start, item.mark), "1", "NX", "EX", SENT_SECONDS],
          ["SET", creatorKey(callsId, call.product, call.start, item.mark), "1", "NX", "EX", SENT_SECONDS],
        ]);
        // A send that did not go (the mail service down for a moment) is
        // tried again on the next run, while the reminder is still of use.
        let again = false;
        if (fresh !== null) {
          if (await remindBuyer(store, product, call, item.mark, origin)) counts.reminded += 1;
          else if (call.email) {
            await redisPipeline([["DEL", sentKey(call.session, call.start, item.mark)]]);
            again = true;
          }
        }
        // A booking found on its own is counted among the people booked, too.
        const booked = paid.some((c) => c.session === call.session) ? paid : [...paid, call];
        if (freshCreator !== null && !(await remindCreator(store, product, booked, call, item.mark))) {
          await redisPipeline([["DEL", creatorKey(callsId, call.product, call.start, item.mark)]]);
          again = true;
        }
        if (again) done.pop();
      } catch (error) {
        console.error("sending a call reminder failed", error);
        // Kept in the queue for the next run; stillUseful lets it go once it is too late.
        done.pop();
      }
    }
    if (done.length) await redisPipeline([["ZREM", REMINDER_QUEUE, ...done]]);
  }
  return counts;
}
