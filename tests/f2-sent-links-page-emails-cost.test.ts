/**
 * What the studio's "Change where a link goes" page reads of the store's sent
 * emails, measured on the real database calls (124 [F2-EDIT-SENT-LINKS],
 * #3034; Claude 5's review): the page read the newest thirty emails whole
 * (listBroadcastsStrict, each up to MAX_MAIL_BODY characters, about 120 KB as
 * stored and twice that as they cross) while it paid only its own
 * STUDIO_PAGE_UNITS (about 200 KB and 80 commands). Held here, with synthetic
 * stores only:
 *
 *   1. Before any email is read, the page asks the list and each email's size
 *      (one LRANGE and one STRLEN each, inside its own studio requests) and
 *      takes the studio requests the read comes to at the most; every command
 *      and byte after that, both ways as sent (JSON), is inside what was taken
 *      when it is sent. An email that grows between its size and its read is
 *      read no further than paid: once more, paid first, then not at all.
 *   2. Without those studio requests, no email is read, and the page has the
 *      sentence that says why.
 *   3. The list is all or nothing, as listBroadcastsStrict's: a record missing,
 *      of another list or malformed makes the page say the emails could not be
 *      read, never a shorter list.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { listBroadcastsStrict } from "@/lib/broadcasts";
import { MAX_MAIL_BODY } from "@/lib/mail";
import * as sentLinks from "@/lib/sent-links";
import { countStudio } from "@/lib/studio-route";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

/** What one studio request pays for in the database (tests/plan-cost-registry.ts, UNIT_COST.studio). */
const UNIT_COMMANDS = 20;
const UNIT_BYTES = 50_000;
/** The emails the page reads (listBroadcastsStrict's default, which it read before). */
const READ = 30;

type Command = (string | number)[];
type Event = { kind: "pay"; units: number } | { kind: "db"; commands: number; bytes: number; reads: string[] };
type Email = { id: string; subject: string; body: string; sent: number; links?: true; finishedAt: number; sendAt: number };
type Shown = { ok: true; emails: Email[] } | { ok: false; refused: string };
type Reader = (listId: string | null, pay: (units: number) => Promise<{ ok: true } | { ok: false; message: string }>) => Promise<Shown>;

const OWNER = "pageemails@example.com";
const wire = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");
const read = (path: string) => readFileSync(path, "utf8");
const emailKey = (id: string) => `nl:mail:bc:${id}`;

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "pageemails", "Page Emails", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PageEmails01", subscriptionId: "sub_PageEmails01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Page Emails", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId!;
  const listKey = `nl:mail:bcs:${listId}`;
  const now = Math.floor(Date.now() / 1000);
  const pipeline = redis.pipeline.bind(redis);

  /** A sent email's record as createBroadcast writes it (lib/broadcasts.ts), with links that can be changed. */
  const record = (id: string, body: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      id, listId, handle: store.handle, subject: `Subject ${id.slice(-2)}`, body, productId: null, notProductId: null, who: "all", narrow: null,
      status: "sent", createdAt: now - 3_600, sendAt: now - 3_600, finishedAt: now - 3_000, total: 100, sent: 100, note: "", failures: 0, listed: true, tagged: true, test: null, links: true,
      ...extra,
    });
  const link = '<p><a href="https://youtube.com/watch?v=1">Watch</a></p>';
  // The longest body there is, every character escaped as stored (six bytes) and once more as it crosses.
  const longest = link + "\u0001".repeat(MAX_MAIL_BODY - link.length);
  const ids = Array.from({ length: READ }, (_, i) => `${"cd".repeat(11)}${String(i).padStart(2, "0")}`);
  const write = async (bodyOf: (i: number) => string) => {
    await pipeline([["DEL", listKey]]);
    for (const [i, id] of ids.entries()) await pipeline([["SET", emailKey(id), record(id, bodyOf(i))]]);
    await pipeline([["RPUSH", listKey, ...ids]]);
  };
  await write(() => longest);
  is("an email at its longest, as stored, past a hundred kilobytes", utf8(record(ids[0], longest)) > 100_000, true);

  // The reviewer's proof: the thirty emails read whole, as the page did, against the page's own studio requests.
  {
    const strict = await listBroadcastsStrict(listId);
    is("listBroadcastsStrict reads all thirty", strict.length, READ);
    const raws = (await pipeline(ids.map((id) => ["GET", emailKey(id)]))) as string[];
    const whole = wire(ids.map((id) => ["GET", emailKey(id)])) + wire(raws);
    is(`read whole, thirty emails are more than the page's own ${STUDIO_PAGE_UNITS} studio requests (${whole} bytes)`, whole > STUDIO_PAGE_UNITS * UNIT_BYTES, true);
  }

  const reader = (sentLinks as unknown as { readShownSentEmails?: Reader }).readShownSentEmails;
  is("the page's reader of the emails it shows exists", typeof reader, "function");
  if (typeof reader !== "function") return done();

  // ------------------------------------------------------------- watching
  let events: Event[] = [];
  let after: ((batch: Command[]) => Promise<void>) | null = null;
  const watch = (then: ((batch: Command[]) => Promise<void>) | null = null) => {
    events = [];
    after = then;
    redis.pipeline = (async (batch: Command[]) => {
      const studio = batch.find((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:allow:studio:"));
      // A take is credited when it is sent: its own commands are in what it takes.
      if (studio) events.push({ kind: "pay", units: Number(studio[2]) });
      const replies = await pipeline(batch);
      events.push({ kind: "db", commands: batch.length, bytes: wire(batch) + wire(replies), reads: batch.filter((c) => (c[0] === "GET" || c[0] === "GETRANGE") && /^nl:mail:bc:[0-9a-f]{24}$/.test(String(c[1]))).map((c) => String(c[1])) });
      if (after) await after(batch);
      return replies;
    }) as typeof redis.pipeline;
  };
  const unwatch = () => {
    redis.pipeline = pipeline as typeof redis.pipeline;
    after = null;
  };
  const pay = async (units: number) => {
    const counted = await countStudio(store, "send", units);
    return counted.ok ? ({ ok: true } as const) : ({ ok: false, message: counted.message } as const);
  };
  /** The list and sizes asked inside the page's own studio requests; every call after the first take inside what was taken when it was sent; no email read before that take. */
  const covered = (log: Event[]) => {
    const firstPay = log.findIndex((e) => e.kind === "pay");
    const before = log.slice(0, firstPay < 0 ? log.length : firstPay).filter((e): e is Extract<Event, { kind: "db" }> => e.kind === "db");
    const own = { commands: before.reduce((n, e) => n + e.commands, 0), bytes: before.reduce((n, e) => n + e.bytes, 0) };
    let paid = 0;
    let commands = 0;
    let bytes = 0;
    let ok = true;
    for (const event of log.slice(firstPay < 0 ? log.length : firstPay)) {
      if (event.kind === "pay") {
        paid += event.units;
        continue;
      }
      commands += event.commands;
      bytes += event.bytes;
      if (commands > paid * UNIT_COMMANDS || bytes > paid * UNIT_BYTES) ok = false;
    }
    return { ok, paid, commands, bytes, own, readBefore: before.some((e) => e.reads.length > 0) };
  };
  const run = async (then: ((batch: Command[]) => Promise<void>) | null = null) => {
    watch(then);
    let shown: Shown | "threw";
    try {
      shown = await reader(listId, pay);
    } catch {
      shown = "threw";
    }
    const log = events;
    unwatch();
    return { shown, sum: covered(log), log };
  };

  // ---------------------------------------------------------------- part 1
  part("1. Thirty emails at their longest: paid before they are read, every call inside what was taken");
  {
    const { shown, sum } = await run();
    is("every email is read whole, newest first", shown !== "threw" && shown.ok ? shown.emails.map((e) => [e.id, e.body === longest, e.links === true, e.sent]) : shown, ids.map((id) => [id, true, true, 100]));
    is(`the list and the sizes are asked with one LRANGE and one STRLEN each, small, inside the page's own studio requests (${JSON.stringify(sum.own)})`, sum.own.commands <= 1 + READ && sum.own.bytes <= 8_000, true);
    is("no email is read before the studio requests are taken", sum.readBefore, false);
    is(`every command and byte after it is inside what was taken when sent (${JSON.stringify({ paid: sum.paid, commands: sum.commands, bytes: sum.bytes })})`, sum.ok, true);
  }

  part("1b. Small emails cost what they are; no email costs nothing more");
  {
    await pipeline([["DEL", listKey]]);
    await pipeline([["RPUSH", listKey, ...ids.slice(0, 3)]]);
    for (const id of ids.slice(0, 3)) await pipeline([["SET", emailKey(id), record(id, link)]]);
    const { shown, sum } = await run();
    is("three small emails", shown !== "threw" && shown.ok ? shown.emails.length : shown, 3);
    is(`a small read takes one studio request more (${sum.paid})`, sum.paid, 1);
    is("inside what was taken", sum.ok, true);
    await pipeline([["DEL", listKey]]);
    const none = await run();
    is("with no email, nothing is taken and only the list is asked", [none.shown !== "threw" && none.shown.ok && none.shown.emails.length, none.log.filter((e) => e.kind === "pay").length, none.log.filter((e) => e.kind === "db").length], [0, 0, 1]);
    const noList = await reader(null, pay);
    is("a store with no list has no email, read from nowhere", noList.ok && noList.emails.length, 0);
  }

  part("1c. An email that grows between its size and its read is read no further than paid");
  {
    await write(() => longest);
    // Its send moving on elsewhere between the size and the read: a note written on the first email.
    const grown = await run(async (batch) => {
      if (batch[0]?.[0] === "STRLEN" && batch.length === READ) await pipeline([["SET", emailKey(ids[0]), record(ids[0], longest, { note: "n".repeat(300), failures: 12 })]]);
    });
    is(`inside what was taken (${JSON.stringify({ paid: grown.sum.paid, commands: grown.sum.commands, bytes: grown.sum.bytes })})`, grown.sum.ok, true);
    is("the grown one is read again, paid first, and shown as it is now", grown.shown !== "threw" && grown.shown.ok ? [grown.shown.emails.length, grown.shown.emails[0].body === longest] : grown.shown, [READ, true]);
    is("it was taken twice: once for all, once for the grown one", grown.log.filter((e) => e.kind === "pay").length, 2);
    // Grown past what a send can write on it: the page says the emails could not be read, and read nothing unpaid.
    await write(() => longest);
    const far = await run(async (batch) => {
      if (batch[0]?.[0] === "STRLEN" && batch.length === READ) await pipeline([["SET", emailKey(ids[0]), record(ids[0], longest, { note: "n".repeat(20_000) })]]);
    });
    is("grown past it: could not be read", far.shown, "threw");
    is("and still inside what was taken", far.sum.ok, true);
  }

  // ---------------------------------------------------------------- part 2
  part("2. Without the studio requests the emails need, none is read");
  {
    await write(() => longest);
    const allowance = redis.keys().filter((k) => k.startsWith("nl:allow:studio:"));
    is("the store's studio count is where the page counts it", allowance.length, 1);
    await pipeline([["SET", allowance[0], String(5_000 - 2)]]);
    const { shown, log } = await run();
    is("refused, in words", shown !== "threw" && !shown.ok && shown.refused.length > 10, true);
    is("no email read", log.some((e) => e.kind === "db" && e.reads.length > 0), false);
    await pipeline([["SET", allowance[0], "0"]]);
    const page = read("app/studio/email/links/page.tsx");
    is("the page reads them through it, paying from the store's studio requests, and no longer whole", /readShownSentEmails\(/.test(page) && /countStudio\(/.test(page) && !/listBroadcastsStrict\(/.test(page), true);
    is("and says why when it is refused", /listed\.ok \? null : /.test(page) || /!listed\.ok/.test(page), true);
  }

  // ---------------------------------------------------------------- part 3
  part("3. All or nothing, as listBroadcastsStrict");
  {
    const small = (i: number) => `${link}<p>${i}</p>`;
    await write(small);
    await pipeline([["DEL", emailKey(ids[4])]]);
    is("a record missing from the list: could not be read", (await run()).shown, "threw");
    await write(small);
    await pipeline([["SET", emailKey(ids[4]), record(ids[4], small(4), { listId: "another-list" })]]);
    is("a record of another list: could not be read", (await run()).shown, "threw");
    await write(small);
    await pipeline([["SET", emailKey(ids[4]), record(ids[4], small(4), { sent: -1 })]]);
    is("a malformed record: could not be read", (await run()).shown, "threw");
    await write(small);
    await pipeline([["SET", emailKey(ids[4]), record(ids[4], small(4), { links: false, sent: 0, status: "scheduled", finishedAt: 0 })]]);
    const fine = await run();
    is("an email whose links cannot be changed, not sent yet, is read as it is", fine.shown !== "threw" && fine.shown.ok ? [fine.shown.emails[4].links, fine.shown.emails[4].sent] : fine.shown, [undefined, 0]);
    await pipeline([["DEL", listKey]]);
    await pipeline([["RPUSH", listKey, "not-an-id"]]);
    is("an index that is not one: could not be read", (await run()).shown, "threw");
    await pipeline([["DEL", listKey]]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
