/**
 * The stop links of the emails to people brought over stay one a store and address, however many passes a send
 * takes (synthetic only; Stripe and the sender are stand-ins for fetch, Redis is lib/redis-memory.ts; review of #3476,
 * MEDIUM 1).
 *
 * A members import emails each member their own link, and a reminder may follow; each carries a stop link
 * (lib/checkout-recovery.ts, moveStopLink), kept 400 days with the address in it and noted for erasure. Held here:
 *   - while the sender answers "try again later" (429: known not taken, so the same email may go again), the passes
 *     that try again leave at most one link a member, and once it is back, each member emailed has exactly one link,
 *     the one in their email, with one erasure note;
 *   - the reminder carries the same link as the member's first email, so it adds none;
 *   - a reminder the month cannot take writes no link;
 *   - a link write answered in an unknown shape sends nothing, gives back the day and the month, puts the reminder
 *     back in line, and keeps the link an email already sent carries;
 *   - a member's link write answered in an unknown shape sends nothing, keeps the member queued and the import's hold
 *     whole, and the next pass emails them once;
 *   - a reminder whose store has no postal address any more is put back in line, not dropped (LOW 2);
 *   - a purchases import saved before files could say they have no status column reads its rows as before (LOW 3).
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { addRows, finishUpload, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { allowanceWindow } from "@/lib/allowance-window";
import { IMPORT_ALLOWANCES } from "@/lib/import-limits";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const POSTAL = "12 Harbor Lane, Portland, ME 04101, USA";
type Sent = { to: string | string[]; subject: string; text: string; html: string; headers?: Record<string, string> };
const emails: Sent[] = [];
let senderDown = false;
let senderCalls = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com" && url.pathname.startsWith("/emails")) {
    senderCalls += 1;
    if (senderDown) return new Response(JSON.stringify({ message: "synthetic: try again later" }), { status: 429 });
    const body = JSON.parse(String(init?.body)) as Sent | Sent[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one);
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const to = (e: Sent) => [e.to].flat()[0];
const sentTo = (address: string, from = 0) => emails.slice(from).filter((e) => to(e) === address);
const tokenOf = (e: Sent | undefined) => e?.text.match(/\/unsubscribe\?r=([0-9a-f]{40})/)?.[1] ?? "";
const keysLike = (pattern: string) => (redis.run(["SCAN", "0", "MATCH", pattern, "COUNT", 1_000_000]) as [string, string[]])[1];
/** Every stop link kept, by token. */
const links = () => keysLike("nl:recover:link:*").map((k) => k.slice("nl:recover:link:".length)).sort();
/** Every erasure note of a stop link, across every address. */
const linkNotes = () =>
  keysLike("nl:erase:ix:*:z").flatMap((k) => (redis.run(["ZRANGEBYSCORE", k, "-inf", "+inf"]) as string[]).filter((m) => m.startsWith("nl:recover:link:"))).length;
const movedCount = (s: Store) => Number(redis.run(["GET", `nl:imports:moved:${s.sid}:${allowanceWindow(s)!.id}`]) ?? 0);

const original = redis.pipeline.bind(redis);
const restore = () => {
  redis.pipeline = original;
};

async function openStore(owner: string, handle: string, account: string, id: string) {
  await claimHandle(owner, handle, "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setMailSettings(owner, { fromName: "Harbor Kitchen", address: POSTAL });
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${id}`, subscriptionId: `sub_${id}`, active: true, period: paidPeriod() });
  const guide = await addProduct(owner, "The Guide", "", "12", null);
  const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!guide.ok || !club.ok) throw new Error("no product");
  await setProductLink(owner, guide.product.id, "https://example.com/guide");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  return { guide: guide.product, club: club.product };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();
  const OWNER = "links-owner@example.com";
  await openStore(OWNER, "linksshop", "acct_1TestStopLink01", "StopLinks1");
  const fresh = async () => (await storeForEmail(OWNER))!;
  let store = await fresh();
  const MEMBERS = ["ana@example.com", "ben@example.com"];
  const in20 = Math.floor(Date.now() / 1000) + 20 * DAY;
  const renews = new Date(in20 * 1000).toISOString().slice(0, 10);

  part("A sender answering \"try again later\": one stop link a member, however many passes");
  const m = await startImport(store, OWNER, "members", { expected: 2, file: "patrons.csv", stopped: true });
  if (!m.ok) throw new Error(`members not started: ${m.reason}`);
  await addRows(store, m.job.id, MEMBERS.map((e, i) => [String(i + 2), e, "The Inner Circle", renews, ""]));
  await finishUpload(store, m.job.id);
  senderDown = true;
  let job = await runImport(m.job.id, Date.now() + 30_000);
  for (let i = 0; i < 12; i += 1) job = await runImport(m.job.id, Date.now() + 30_000);
  is("control: the sender was asked and nothing went", [senderCalls > 1, emails.length, job?.state], [true, 0, "mailing"]);
  is("at most one stop link a member while it is down", links().length <= MEMBERS.length, true);
  senderDown = false;
  for (let i = 0; i < 10 && job && job.state !== "done"; i += 1) job = await runImport(m.job.id, Date.now() + 30_000);
  is("control: once it is back, each member is emailed once", [job?.state, ...MEMBERS.map((e) => sentTo(e).length)], ["done", 1, 1]);
  const invites = MEMBERS.map((e) => tokenOf(sentTo(e)[0]));
  is("exactly one stop link a member emailed, the one in their email", links(), invites.slice().sort());
  is("and one erasure note each", linkNotes(), MEMBERS.length);

  part("The reminder carries the member's own stop link, and adds none");
  store = await fresh();
  const at = (in20 - 2 * DAY + 3_600) * 1000;
  let before = emails.length;
  senderDown = true;
  for (let hour = 0; hour < 6; hour += 1) await sendMoveReminders(Date.now() + 30_000, at + hour * 3_601 * 1000);
  is("control: nothing went while the sender is down", emails.length - before, 0);
  is("no link added by the passes that tried again", links(), invites.slice().sort());
  senderDown = false;
  const r = await sendMoveReminders(Date.now() + 30_000, at + 6 * 3_601 * 1000);
  is("control: once it is back, each member is reminded once", [r.sent, ...MEMBERS.map((e) => sentTo(e, before).length)], [2, 1, 1]);
  is("each reminder carries the link of the member's first email", MEMBERS.map((e) => tokenOf(sentTo(e, before)[0])), invites);
  is("still one link and one note a member", [links(), linkNotes()], [invites.slice().sort(), MEMBERS.length]);

  part("A reminder the month cannot take writes no link; an unknown link write keeps the link already sent");
  {
    const OTHER = "links-other@example.com";
    await openStore(OTHER, "linksother", "acct_1TestStopLink02", "StopLinks2");
    let other = (await storeForEmail(OTHER))!;
    const member = "cleo@example.com";
    const j = await startImport(other, OTHER, "members", { expected: 1, file: "patrons.csv", stopped: true });
    if (!j.ok) throw new Error(`not started: ${j.reason}`);
    await addRows(other, j.job.id, [["2", member, "The Inner Circle", renews, ""]]);
    await finishUpload(other, j.job.id);
    let oj = await runImport(j.job.id, Date.now() + 30_000);
    for (let i = 0; i < 10 && oj && oj.state !== "done"; i += 1) oj = await runImport(j.job.id, Date.now() + 30_000);
    const sent = tokenOf(sentTo(member)[0]);
    is("control: the member is emailed with a stop link", [oj?.state, sent.length], ["done", 40]);
    other = (await storeForEmail(OTHER))!;

    // The reminder's link write answered in an unknown shape: nothing goes, the month is given back, and the link the
    // member's first email carries is kept.
    redis.pipeline = async (commands: (string | number)[][]) => {
      const out = (await original(commands)) as unknown[];
      return commands.map((c, i) => (c[0] === "SET" && String(c[1]).startsWith("nl:recover:link:") ? "QUEUED" : out[i]));
    };
    let unknown;
    before = emails.length;
    const usedBefore = movedCount(other);
    try {
      unknown = await sendMoveReminders(Date.now() + 30_000, at);
    } finally {
      restore();
    }
    is("an unknown link write sends nothing and gives the month back", [unknown.sent, emails.length - before, movedCount(other)], [0, 0, usedBefore]);
    is("the link the member's first email carries still works", redis.run(["GET", `nl:recover:link:${sent}`]) !== null, true);
    is("control: the reminder is back in line", (redis.run(["ZRANGEBYSCORE", "nl:mv:due", "-inf", "+inf"]) as string[]).some((e) => e.startsWith(`${other.sid}|`)), true);

    // The month spent, with no link kept for that address (synthetic: as if it ran out): no reminder and no link.
    redis.run(["DEL", `nl:recover:link:${sent}`]);
    const allLinks = links().length;
    redis.run(["SET", `nl:imports:moved:${other.sid}:${allowanceWindow(other)!.id}`, String(IMPORT_ALLOWANCES.creator.movedEmails)]);
    before = emails.length;
    const full = await sendMoveReminders(Date.now() + 30_000, at + 3_601 * 1000);
    is("control: a spent month sends no reminder", [full.sent, emails.length - before], [0, 0]);
    is("and writes no stop link", links().length, allLinks);
  }

  part("A reminder whose store has no postal address any more waits in line (LOW 2)");
  {
    const LATER = "links-later@example.com";
    await openStore(LATER, "linkslater", "acct_1TestStopLink03", "StopLinks3");
    let later = (await storeForEmail(LATER))!;
    const member = "dara@example.com";
    const j = await startImport(later, LATER, "members", { expected: 1, file: "patrons.csv", stopped: true });
    if (!j.ok) throw new Error(`not started: ${j.reason}`);
    await addRows(later, j.job.id, [["2", member, "The Inner Circle", renews, ""]]);
    await finishUpload(later, j.job.id);
    let lj = await runImport(j.job.id, Date.now() + 30_000);
    for (let i = 0; i < 10 && lj && lj.state !== "done"; i += 1) lj = await runImport(j.job.id, Date.now() + 30_000);
    await setMailSettings(LATER, { fromName: "Harbor Kitchen", address: "" });
    later = (await storeForEmail(LATER))!;
    before = emails.length;
    const none = await sendMoveReminders(Date.now() + 30_000, at);
    is("no postal address: no reminder", [none.sent, sentTo(member, before).length], [0, 0]);
    await setMailSettings(LATER, { fromName: "Harbor Kitchen", address: POSTAL });
    const back = await sendMoveReminders(Date.now() + 30_000, at + 3_601 * 1000);
    is("the address saved again, the reminder goes, once", [back.sent >= 1, sentTo(member, before).length], [true, 1]);
  }

  part("A purchases import saved before the status column option reads its rows as before (LOW 3)");
  {
    store = await fresh();
    const p = await startImport(store, OWNER, "purchases", { expected: 1, file: "orders.csv", email: false, statusColumn: false } as Parameters<typeof startImport>[3]);
    if (!p.ok) throw new Error(`purchases not started: ${p.reason}`);
    // As a job saved before the option existed: no statusColumn at all.
    const saved = JSON.parse(String(redis.run(["GET", `nl:import:${p.job.id}`]))) as { options: Record<string, unknown> };
    delete saved.options.statusColumn;
    redis.run(["SET", `nl:import:${p.job.id}`, JSON.stringify(saved), "KEEPTTL"]);
    await addRows(store, p.job.id, [["2", "early@example.com", "The Guide", ""]]);
    await finishUpload(store, p.job.id);
    let pj = await runImport(p.job.id, Date.now() + 30_000);
    for (let i = 0; i < 10 && pj && pj.state !== "done"; i += 1) pj = await runImport(p.job.id, Date.now() + 30_000);
    is("a row with no status is given, as before the option", [pj?.state, pj?.counts.added, pj?.counts.errors], ["done", 1, 0]);
    const q = await startImport(store, OWNER, "purchases", { expected: 1, file: "orders.csv", email: false, statusColumn: true } as Parameters<typeof startImport>[3]);
    if (!q.ok) throw new Error(`purchases not started: ${q.reason}`);
    await addRows(store, q.job.id, [["2", "late@example.com", "The Guide", ""]]);
    await finishUpload(store, q.job.id);
    let qj = await runImport(q.job.id, Date.now() + 30_000);
    for (let i = 0; i < 10 && qj && qj.state !== "done"; i += 1) qj = await runImport(q.job.id, Date.now() + 30_000);
    is("control: one started with a status column still reads an empty status as not paid", [qj?.state, qj?.counts.added, qj?.counts.errors], ["done", 0, 1]);
  }

  part("A member's stop link write answered in an unknown shape: nothing goes, and the import's hold is kept whole");
  {
    const HOLD = "links-hold@example.com";
    await openStore(HOLD, "linkshold", "acct_1TestStopLink04", "StopLinks4");
    const hold = (await storeForEmail(HOLD))!;
    const member = "eli@example.com";
    const j = await startImport(hold, HOLD, "members", { expected: 1, file: "patrons.csv", stopped: true });
    if (!j.ok) throw new Error(`not started: ${j.reason}`);
    await addRows(hold, j.job.id, [["2", member, "The Inner Circle", renews, ""]]);
    await finishUpload(hold, j.job.id);
    const heldOf = () => (JSON.parse(String(redis.run(["GET", `nl:import:${j.job.id}`]))) as { held?: { n: number } }).held?.n;
    const heldBefore = heldOf();
    redis.pipeline = async (commands: (string | number)[][]) => {
      const out = (await original(commands)) as unknown[];
      return commands.map((c, i) => (c[0] === "SET" && String(c[1]).startsWith("nl:recover:link:") ? "QUEUED" : out[i]));
    };
    before = emails.length;
    let first;
    try {
      first = await runImport(j.job.id, Date.now() + 30_000);
    } finally {
      restore();
    }
    is("nothing goes, the member is still queued, the hold is as it was", [first?.state, emails.length - before, redis.run(["SCARD", `nl:import:${j.job.id}:mail`]), heldOf()], ["mailing", 0, 1, heldBefore]);
    let hj = await runImport(j.job.id, Date.now() + 30_000);
    for (let i = 0; i < 10 && hj && hj.state !== "done"; i += 1) hj = await runImport(j.job.id, Date.now() + 30_000);
    is("control: the next pass emails the member once", [hj?.state, sentTo(member, before).length, tokenOf(sentTo(member, before)[0]).length], ["done", 1, 40]);
  }
  done();
}

void main();
