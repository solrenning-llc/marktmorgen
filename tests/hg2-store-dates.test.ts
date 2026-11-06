/**
 * 283 [HG2], unit 2: the store's own dates, once a year.
 *
 * A creator names a few days of the year (the day the store opened, a
 * holiday it marks) and writes the email for each. Every year, on that day,
 * the email is made as one of the store's own emails (lib/broadcasts.ts) and
 * sent by the scheduled job. The email sender is a stand-in; no real email is
 * sent. What is checked:
 *
 *   - the setting: off until turned on with at least one whole date; one
 *     email a day of the year; bounded; nothing about any person (no birth
 *     date, ever); a day added after it passed waits for next year;
 *   - saving: refused whole, with the reason, never trimmed quietly; never
 *     on without the list email set up (sender name and postal address);
 *   - who: only people on the list who agreed and may be written to (never
 *     somebody who left, bounced, marked it as spam, never agreed, or was
 *     deleted from the store);
 *   - how often: once per date per year, however many times the job runs;
 *   - cost: one studio request taken before the email is made (none spent,
 *     none made), the store's emails checked before it is made and taken
 *     before each batch goes (too few left, none made), at most a set number
 *     made in one run;
 *   - unknown fails closed: a claim whose answer is not known makes nothing;
 *   - what happened each year is kept for the studio, without any address.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStoreDates, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { forgetContactPerson, stopWriting, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { advanceAll, listBroadcasts } from "@/lib/broadcasts";
import { allowanceUsed, allowancesUsedStrict, forceAllowance } from "@/lib/store-allowance";
import { windowId } from "@/lib/allowance-window";
import { MAX_SUBJECT, monthlyAllowance } from "@/lib/mail";
import {
  MAX_DATE_MESSAGE,
  MAX_DATE_SUBJECT,
  MAX_STORE_DATES,
  NO_STORE_DATES,
  STORE_DATE_WINDOW_DAYS,
  dateKey,
  dayWords,
  dueYear,
  nextDay,
  parseStoreDates,
  readStoreDatesInput,
  storeDatesOn,
  type StoreDate,
} from "@/lib/store-dates-rules";
import { DATE_EMAILS_PER_RUN, readStoreDateResults, saveStoreDates, sendStoreDates } from "@/lib/store-dates-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const DAY = 86_400_000;
const delivery = installSesMailFixture();
const date = (month: number, day: number, since = 0, extra: Partial<StoreDate> = {}): StoreDate => ({ name: "Store birthday", month, day, subject: "Our store turns one", message: "Thank you for being here this year.", since, ...extra });

async function shop(owner: string, handle: string, mail = true) {
  const made = await claimHandle(owner, handle, `${handle} shop`, "");
  if (!made.ok) throw new Error(`no store ${handle}`);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  if (mail) await setMailSettings(owner, { fromName: `${handle} shop`, address: "1 Main St, Portland, OR 97201" });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  delivery.configure();
  delivery.reset();
  process.env.RESEND_API_KEY = "re_test_store_dates_only_a_stand_in";

  part("The setting");
  is("off by default, with no dates", [NO_STORE_DATES.on, NO_STORE_DATES.dates.length], [false, 0]);
  is("never on without a date", parseStoreDates({ on: true, dates: [] }).on, false);
  is("on with a whole one", parseStoreDates({ on: true, dates: [date(3, 14)] }).on, true);
  is("a day that does not exist is left out", parseStoreDates({ on: true, dates: [date(2, 30), date(4, 31), date(13, 1), date(0, 5)] }).dates.length, 0);
  is("February 29 is a day", parseStoreDates({ dates: [date(2, 29)] }).dates.length, 1);
  is("one email a day of the year: the second on the same day is left out", parseStoreDates({ dates: [date(3, 14), date(3, 14, 0, { subject: "Again" })] }).dates.map((d) => d.subject), ["Our store turns one"]);
  is("at most MAX_STORE_DATES are kept", parseStoreDates({ dates: Array.from({ length: MAX_STORE_DATES + 3 }, (_, i) => date(1, i + 1)) }).dates.length, MAX_STORE_DATES);
  is("kept in calendar order", parseStoreDates({ dates: [date(12, 25), date(1, 2), date(7, 4)] }).dates.map(dateKey), ["0102", "0704", "1225"]);
  const long = parseStoreDates({ dates: [date(5, 5, 0, { subject: "s".repeat(500), message: `  ${"m".repeat(MAX_DATE_MESSAGE + 50)}  ` })] }).dates[0];
  is("subject and message are cut to their bounds", [long.subject.length, long.message.length], [MAX_DATE_SUBJECT, MAX_DATE_MESSAGE]);
  is("the subject's bound is an email's", MAX_DATE_SUBJECT, MAX_SUBJECT);
  is("nothing else is kept: no birth date, nobody's anything", Object.keys(parseStoreDates({ dates: [{ ...date(5, 5), birthday: "2000-01-01", email: "a@example.com" }] }).dates[0]).sort(), ["day", "message", "month", "name", "since", "subject"]);
  is("on reads the saved setting", storeDatesOn({ storeDates: parseStoreDates({ on: true, dates: [date(5, 5)] }) }), true);
  is("a day in words", dayWords({ month: 11, day: 6 }), "November 6");

  part("When a date is due: its day, UTC, and the next, and only when set in time");
  const nov6 = date(11, 6);
  is("on the day", dueYear(nov6, Date.UTC(2026, 10, 6, 9)), 2026);
  is("the day after, a run that was missed is caught", dueYear(nov6, Date.UTC(2026, 10, 7, 9)), 2026);
  is("not after that", dueYear(nov6, Date.UTC(2026, 10, 6) + STORE_DATE_WINDOW_DAYS * DAY), null);
  is("not before", dueYear(nov6, Date.UTC(2026, 10, 5, 23, 59)), null);
  is("December 31 caught on January 1 belongs to the year before", dueYear(date(12, 31), Date.UTC(2027, 0, 1, 9)), 2026);
  is("February 29 comes on March 1 in other years", dueYear(date(2, 29), Date.UTC(2027, 2, 1, 9)), 2027);
  is("a day set on that day itself is due", dueYear(date(11, 6, Date.UTC(2026, 10, 6, 8)), Date.UTC(2026, 10, 6, 9)), 2026);
  is("a day set after it passed waits for next year", dueYear(date(11, 6, Date.UTC(2026, 10, 7, 8)), Date.UTC(2026, 10, 7, 9)), null);
  is("and the studio says next year", new Date(nextDay(date(11, 6, Date.UTC(2026, 10, 7, 8)), Date.UTC(2026, 10, 7, 9))).toISOString().slice(0, 10), "2027-11-06");
  is("a day still ahead this year is this year's", new Date(nextDay(date(12, 25), Date.UTC(2026, 10, 7))).toISOString().slice(0, 10), "2026-12-25");

  part("Saving checks the whole list and says why");
  const before = parseStoreDates({ on: true, dates: [date(3, 14, 111)] });
  const input = (dates: unknown[], on = true) => readStoreDatesInput({ on, dates }, before, 999);
  is("too many", input(Array.from({ length: MAX_STORE_DATES + 1 }, (_, i) => date(1, i + 1))).ok ? "ok" : "refused", "refused");
  is("a day that does not exist", (input([date(2, 30)]) as { reason: string }).reason, "date");
  is("two on one day", (input([date(3, 14), date(3, 14)]) as { reason: string }).reason, "twice");
  is("no name", (input([date(3, 14, 0, { name: " " })]) as { reason: string }).reason, "name");
  is("no subject", (input([date(3, 14, 0, { subject: "" })]) as { reason: string }).reason, "subject");
  is("no email", (input([date(3, 14, 0, { message: "  " })]) as { reason: string }).reason, "message");
  is("a template's part still to write", (input([date(3, 14, 0, { message: "Hello ⟦your words⟧" })]) as { reason: string }).reason, "placeholder");
  is("on with nothing", (input([]) as { reason: string }).reason, "empty");
  const kept = input([date(3, 14), { ...date(4, 1), month: "4", day: "1" }]);
  is("a day kept keeps when it was set; a new one is set now", kept.ok ? kept.value.dates.map((d) => d.since) : null, [111, 999]);

  part("Never on without the list email set up");
  const quietStore = await shop("quiet@example.com", "quiet", false);
  const refused = await saveStoreDates("quiet@example.com", { on: true, dates: [date(3, 14)] });
  is("refused, saying why", refused.ok ? "saved" : refused.reason, "setup");
  is("and nothing saved", (await storeForEmail("quiet@example.com"))?.storeDates.on, false);
  is("off may be saved", (await saveStoreDates("quiet@example.com", { on: false, dates: [date(3, 14)] })).ok, true);

  part("Made on its day and sent to the list, once");
  const now = Date.now();
  const today = new Date(now);
  const todays = { month: today.getUTCMonth() + 1, day: today.getUTCDate() };
  const other = todays.month === 1 ? { month: 6, day: 1 } : { month: 1, day: 1 };
  const owner = "owner@example.com";
  const harbor = await shop(owner, "harbor");
  const listId = harbor.listId as string;
  for (const name of ["ana", "ben", "cy", "dee", "eli", "fay"]) await upsertContact(listId, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(listId, "eve@example.com", { agreed: false, explicit: false, source: "buyer" }, ROOM);
  const tokens = await tokensFor(listId, ["cy@example.com"], "harbor");
  await unsubscribe(tokens.get("cy@example.com")!);
  await stopWriting(listId, "dee@example.com", "bounced");
  await stopWriting(listId, "eli@example.com", "complained");
  await forgetContactPerson(listId, "fay@example.com");
  const saved = await saveStoreDates(owner, { on: true, dates: [{ ...date(todays.month, todays.day), message: "Thank you for being here this year.\n\nhttps://marktmorgen.com/@harbor" }, date(other.month, other.day)] }, now - 60_000);
  is("saved", saved.ok, true);
  const usedBefore = await allowanceUsed((await storeForEmail(owner))!, "studio");
  const deadline = () => Date.now() + 30_000;
  const first = await sendStoreDates(deadline(), now);
  is("today's date made one email; the other day none", first.made, 1);
  is("one studio request taken for it", (await allowanceUsed((await storeForEmail(owner))!, "studio")) - usedBefore, 1);
  const made = await listBroadcasts(listId);
  is("one of the store's own emails, to the whole list that may be written to", made.map((b) => [b.subject, b.who, b.total]), [["Our store turns one", "all", 2]]);
  delivery.clearCaptured();
  await advanceAll(storeForHandle, deadline());
  is("sent only to the two who agreed and may be written to", delivery.sent.flatMap((m) => m.to).sort(), ["ana@example.com", "ben@example.com"]);
  is("the creator's words, as written", delivery.sent.every((m) => m.text.includes("Thank you for being here this year.")), true);
  is("with the list email's postal address", delivery.sent.every((m) => m.text.includes("1 Main St, Portland, OR 97201")), true);
  is("and a one-click way off the list", delivery.sent.every((m) => /unsubscribe/i.test(m.text)), true);
  is("the job again: nothing more made", (await sendStoreDates(deadline(), now)).made, 0);
  is("the next day: nothing more made", (await sendStoreDates(deadline(), now + DAY)).made, 0);
  is("still one email", (await listBroadcasts(listId)).length, 1);
  const results = await readStoreDateResults((await storeForEmail(owner))!);
  const mine = results.get(dateKey(todays));
  is("what happened this year is kept for the studio", [mine?.outcome, mine?.total, mine?.year], ["made", 2, today.getUTCFullYear()]);
  is("and nothing about any person in it", JSON.stringify([...results.values()]).includes("@"), false);

  part("Too few emails left this month: none made, tried again");
  const glen = await shop("glen@example.com", "glen");
  await upsertContact(glen.listId as string, "gus@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await saveStoreDates("glen@example.com", { on: true, dates: [date(todays.month, todays.day)] }, now - 60_000);
  const glenNow = (await storeForEmail("glen@example.com"))!;
  const usedKey = `nl:mail:used:${glenNow.listId}:${windowId(glenNow)}`;
  await redis.pipeline([["SET", usedKey, String(monthlyAllowance(glenNow))]]);
  is("none made", (await sendStoreDates(deadline(), now)).made, 0);
  is("the studio is told why", (await readStoreDateResults(glenNow)).get(dateKey(todays))?.outcome, "allowance");
  await redis.pipeline([["DEL", usedKey]]);
  is("with emails back, made on the next run that day", (await sendStoreDates(deadline(), now)).made, 1);

  part("No studio request left: none made, nothing taken");
  const hale = await shop("hale@example.com", "hale");
  await upsertContact(hale.listId as string, "hal@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await saveStoreDates("hale@example.com", { on: true, dates: [date(todays.month, todays.day)] }, now - 60_000);
  const [studio] = (await allowancesUsedStrict(hale, ["studio"]))!;
  await forceAllowance(hale, "studio", studio.figure - studio.used);
  is("none made", (await sendStoreDates(deadline(), now)).made, 0);
  is("the studio is told why", (await readStoreDateResults(hale)).get(dateKey(todays))?.outcome, "studio");
  is("and no email of the store's was made", (await listBroadcasts(hale.listId)).length, 0);

  part("The list email taken away after saving: none made, no request taken");
  await setStoreDates("quiet@example.com", { on: true, dates: [date(todays.month, todays.day, now - 60_000)] });
  const quietUsed = await allowanceUsed(quietStore, "studio");
  is("none made", (await sendStoreDates(deadline(), now)).made, 0);
  is("nothing taken", await allowanceUsed(quietStore, "studio"), quietUsed);
  is("the studio is told why", (await readStoreDateResults(quietStore)).get(dateKey(todays))?.outcome, "setup");

  part("A claim already taken, or whose answer is not known: nothing made");
  const isla = await shop("isla@example.com", "isla");
  await upsertContact(isla.listId as string, "ivy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await saveStoreDates("isla@example.com", { on: true, dates: [date(todays.month, todays.day)] }, now - 60_000);
  const islaKey = `nl:hgd:made:${isla.statsId}:${dateKey(todays)}:${today.getUTCFullYear()}`;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SET" && c[1] === islaKey)) return commands.map(() => "QUEUED");
    if (commands.some((c) => c[0] === "GET" && c[1] === islaKey)) return commands.map(() => null);
    return original(commands);
  }) as typeof redis.pipeline;
  is("unknown: none made", (await sendStoreDates(deadline(), now)).made, 0);
  redis.pipeline = original;
  await redis.pipeline([["SET", islaKey, "someone-else"]]);
  is("taken by another run: none made", (await sendStoreDates(deadline(), now)).made, 0);
  is("no email of the store's was made", (await listBroadcasts(isla.listId)).length, 0);

  part("A day added after it passed waits for next year");
  const jade = await shop("jade@example.com", "jade");
  await upsertContact(jade.listId as string, "jo@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const yesterday = new Date(now - DAY);
  await saveStoreDates("jade@example.com", { on: true, dates: [date(yesterday.getUTCMonth() + 1, yesterday.getUTCDate())] }, now);
  is("not made", (await sendStoreDates(deadline(), now)).made, 0);

  part("At most a set number made in one run; the rest on the next");
  is("the number is bounded", DATE_EMAILS_PER_RUN > 0 && DATE_EMAILS_PER_RUN <= 100, true);
  for (const handle of ["kay", "lee"]) {
    const s = await shop(`${handle}@example.com`, handle);
    await upsertContact(s.listId as string, `${handle}-fan@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
    await saveStoreDates(`${handle}@example.com`, { on: true, dates: [date(todays.month, todays.day)] }, now - 60_000);
  }
  is("one made with a limit of one", (await sendStoreDates(deadline(), now, 1)).made, 1);
  is("the other on the next run", (await sendStoreDates(deadline(), now, 1)).made, 1);
  is("then none", (await sendStoreDates(deadline(), now, 1)).made, 0);

  delivery.restore();
  done();
}

void main();
