/**
 * What the studio's "Change where a link goes" page reads of the histories it
 * shows, measured on the real database calls (124 [F2-EDIT-SENT-LINKS], #3034;
 * Claude 5's review, MEDIUM): the page shows up to ten sent emails and read
 * every one's history whole (each up to SENT_LINK_RECORD_MAX_BYTES, about
 * 615 KB as they cross) while it paid only its own STUDIO_PAGE_UNITS (about
 * 200 KB and 80 commands). Held here, with synthetic stores only:
 *
 *   1. Before any history is read, the page asks each one's size (one STRLEN
 *      each, inside its own studio requests) and takes the studio requests
 *      the read comes to at the most; every command and byte after that, both
 *      ways as sent (JSON), is inside what was taken when it is sent. A history
 *      that grows between the size and the read is read no further than paid.
 *   2. Without those studio requests, no history is read, and the page has the
 *      sentence that says why.
 *   3. A history with no room in bytes for even the shortest change, though
 *      under SENT_LINK_CHANGES_MAX changes, is said so: the page hides its
 *      form and explains, instead of a form whose every change is refused.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { SENT_LINK_CHANGES_MAX, SENT_LINK_MAX_LENGTH, SENT_LINK_RECORD_MAX_BYTES } from "@/lib/sent-link-rules";
import * as sentLinks from "@/lib/sent-links";
import { sentLinkKey } from "@/lib/sent-links";
import { countStudio } from "@/lib/studio-route";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

/** What one studio request pays for in the database (tests/plan-cost-registry.ts, UNIT_COST.studio). */
const UNIT_COMMANDS = 20;
const UNIT_BYTES = 50_000;
/** The most emails the page shows (app/studio/email/links/page.tsx, SHOWN). */
const SHOWN = 10;

type Command = (string | number)[];
type Event = { kind: "pay"; units: number } | { kind: "db"; commands: number; bytes: number; reads: string[]; first: string };
type Shown = { ok: true; kept: Map<string, { changes: unknown[] } | null>; noRoom: Set<string> } | { ok: false; refused: string };
type Reader = (ids: string[], pay: (units: number) => Promise<{ ok: true } | { ok: false; message: string }>) => Promise<Shown>;

const OWNER = "pagecost@example.com";
const wire = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");
const read = (path: string) => readFileSync(path, "utf8");

/** The longest address link `n` can go to, in characters, made of 3-byte characters. */
function longest(n: number, k: number): string {
  const head = `https://youtube.com/watch?v=${n}&k=${k}&q=`;
  return head + "中".repeat(SENT_LINK_MAX_LENGTH - head.length);
}

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "pagecost", "Page Cost", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PageCost001", subscriptionId: "sub_PageCost001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Page Cost", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  const history = (count: number, salt = 0) =>
    JSON.stringify({ l: store.listId, exp: now + 300 * 86_400, changes: Array.from({ length: count }, (_, i) => ({ n: 19, to: longest(19, i + salt), at: now })) });
  const ids = Array.from({ length: SHOWN }, (_, i) => `${"ab".repeat(11)}${String(i).padStart(2, "0")}`);
  const pipeline = redis.pipeline.bind(redis);
  const full = history(SENT_LINK_CHANGES_MAX);
  is("a history at its longest in bytes, inside the ceiling", utf8(full) > 55_000 && utf8(full) <= SENT_LINK_RECORD_MAX_BYTES, true);

  // The reviewer's proof: the ten histories read whole, as the page did, against the page's own studio requests.
  for (const id of ids) await pipeline([["SET", sentLinkKey(id), full, "EX", 86_400]]);
  {
    const [raws] = [(await pipeline(ids.map((id) => ["GET", sentLinkKey(id)]))) as string[]];
    const whole = wire(ids.map((id) => ["GET", sentLinkKey(id)])) + wire(raws);
    is(`read whole, ten histories are more than the page's own ${STUDIO_PAGE_UNITS} studio requests (${whole} bytes)`, whole > STUDIO_PAGE_UNITS * UNIT_BYTES, true);
  }

  const reader = (sentLinks as unknown as { readShownSentLinks?: Reader }).readShownSentLinks;
  is("the page's reader of the histories it shows exists", typeof reader, "function");
  if (typeof reader !== "function") return done();

  // ------------------------------------------------------------- watching
  let events: Event[] = [];
  let after: ((batch: Command[]) => Promise<void>) | null = null;
  const watch = () => {
    events = [];
    redis.pipeline = (async (batch: Command[]) => {
      const studio = batch.find((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:allow:studio:"));
      // A take is credited when it is sent: its own commands are in what it takes.
      if (studio) events.push({ kind: "pay", units: Number(studio[2]) });
      const replies = await pipeline(batch);
      events.push({ kind: "db", commands: batch.length, bytes: wire(batch) + wire(replies), reads: batch.filter((c) => c[0] === "GET" || c[0] === "GETRANGE").map((c) => String(c[1])), first: String(batch[0]?.[0] ?? "") });
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
  /**
   * The sizes asked inside the page's own studio requests (one at most); every call after the first take inside
   * what was taken when it was sent; and no history read before that take.
   */
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
    const readBefore = before.some((e) => e.reads.length > 0);
    return { ok, paid, commands, bytes, own, ownFits: own.commands <= UNIT_COMMANDS && own.bytes <= UNIT_BYTES, readBefore };
  };

  // ---------------------------------------------------------------- part 1
  part("1. Ten histories at their longest: paid before they are read, every call inside what was taken");
  for (const id of ids) await pipeline([["SET", sentLinkKey(id), full, "EX", 86_400]]);
  {
    watch();
    const shown = await reader(ids, pay);
    const log = events;
    unwatch();
    const sum = covered(log);
    is("every history is read and shown", shown.ok ? ids.map((id) => shown.kept.get(id)?.changes.length ?? -1) : shown.refused, ids.map(() => SENT_LINK_CHANGES_MAX));
    is(`the sizes are asked inside one studio request of the page's own (${JSON.stringify(sum.own)})`, sum.ownFits, true);
    is("no history is read before the studio requests are taken", sum.readBefore, false);
    is(`every command and byte after it is inside what was taken when sent (${JSON.stringify({ paid: sum.paid, commands: sum.commands, bytes: sum.bytes })})`, sum.ok, true);
  }

  part("1b. Small histories cost what they are, and none costs nothing more");
  {
    for (const [i, id] of ids.entries()) await pipeline(i < 3 ? [["SET", sentLinkKey(id), history(1), "EX", 86_400]] : [["DEL", sentLinkKey(id)]]);
    watch();
    const shown = await reader(ids, pay);
    const log = events;
    unwatch();
    const sum = covered(log);
    is("three with one change, seven with none", shown.ok ? ids.map((id) => shown.kept.get(id)?.changes.length ?? 0) : shown.refused, ids.map((_, i) => (i < 3 ? 1 : 0)));
    is(`a small read takes one studio request more, not the ceiling (${sum.paid})`, sum.paid, 1);
    is("inside what was taken", sum.ok, true);
    for (const id of ids) await pipeline([["DEL", sentLinkKey(id)]]);
    watch();
    const none = await reader(ids, pay);
    const empty = events;
    unwatch();
    is("with no history at all, nothing more is taken and nothing more is read", [none.ok && [...none.kept.values()].every((v) => v === null), empty.filter((e) => e.kind === "pay").length, empty.filter((e) => e.kind === "db").length], [true, 0, 1]);
  }

  part("1c. A history that grows between its size and its read is read no further than paid");
  {
    for (const id of ids) await pipeline([["SET", sentLinkKey(id), history(2), "EX", 86_400]]);
    after = async (batch) => {
      if (batch[0]?.[0] !== "STRLEN") return;
      // Changes landing elsewhere between the size and the read: the first history now at its longest.
      await pipeline([["SET", sentLinkKey(ids[0]), full, "EX", 86_400]]);
    };
    const pending = after;
    watch();
    after = pending;
    const shown = await reader(ids, pay);
    const log = events;
    unwatch();
    const sum = covered(log);
    is(`inside what was taken (${JSON.stringify({ paid: sum.paid, commands: sum.commands, bytes: sum.bytes })})`, sum.ok, true);
    is("the grown one is not shown as read (the page says it could not be read), the others are", shown.ok ? [shown.kept.has(ids[0]), ids.slice(1).every((id) => shown.kept.get(id)?.changes.length === 2)] : shown.refused, [false, true]);
  }

  // ---------------------------------------------------------------- part 2
  part("2. Without the studio requests the histories need, none is read");
  {
    for (const id of ids) await pipeline([["SET", sentLinkKey(id), full, "EX", 86_400]]);
    const allowance = redis.keys().filter((k) => k.startsWith("nl:allow:studio:"));
    is("the store's studio count is where the page counts it", allowance.length, 1);
    await pipeline([["SET", allowance[0], String(5_000 - 2)]]);
    watch();
    const shown = await reader(ids, pay);
    const log = events;
    unwatch();
    is("refused, in words", !shown.ok && shown.refused.length > 10, true);
    is("no history read", log.some((e) => e.kind === "db" && e.reads.length > 0), false);
    await pipeline([["SET", allowance[0], "0"]]);
    const page = read("app/studio/email/links/page.tsx");
    is("the page reads them through it, paying from the store's studio requests", /readShownSentLinks\(/.test(page) && /countStudio\(/.test(page) && !/readSentLinksMany\(/.test(page), true);
    is("and says why when it is refused", /shown\.ok \? null : /.test(page) || /!shown\.ok/.test(page), true);
  }

  // ---------------------------------------------------------------- part 3
  part("3. A history with no room in bytes for another change, under the most changes");
  {
    // Written by a version before the ceiling was checked: six bytes a half-character, past the ceiling.
    const past = JSON.stringify({ l: store.listId, exp: now + 300 * 86_400, changes: Array.from({ length: SENT_LINK_CHANGES_MAX - 1 }, (_, i) => ({ n: 5, to: `https://youtube.com/watch?v=${i}&q=${"\ud800".repeat(960)}`, at: now })) });
    is("that history is past the ceiling, under the most changes", utf8(past) > SENT_LINK_RECORD_MAX_BYTES, true);
    await pipeline([["SET", sentLinkKey(ids[0]), past, "EX", 86_400]]);
    await pipeline([["SET", sentLinkKey(ids[1]), history(SENT_LINK_CHANGES_MAX - 1), "EX", 86_400]]);
    for (const id of ids.slice(2)) await pipeline([["DEL", sentLinkKey(id)]]);
    const shown = await reader(ids, pay);
    is("said to have no room; one written by the server one change short of full still has room", shown.ok ? [shown.noRoom.has(ids[0]), shown.noRoom.has(ids[1]), shown.kept.get(ids[0])?.changes.length] : shown.refused, [true, false, SENT_LINK_CHANGES_MAX - 1]);
    const page = read("app/studio/email/links/page.tsx");
    const editor = read("components/sent-links-editor.tsx");
    is("the page hands it to the editor", /noRoom: /.test(page), true);
    is("the editor offers no form for its links then", /email\.noRoom \|\| used >= SENT_LINK_CHANGES_MAX \? null : <form/.test(editor), true);
    is("and says why, plainly", /no room left for another change/.test(editor), true);
    is("a refusal for room from the server hides the form as well", /answer\.error === "full"/.test(editor), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
