/**
 * The emails an import sends to people brought over keep the creator's list's no (synthetic only; Stripe and the
 * sender are stand-ins for fetch).
 *
 * A members import emails each member their own link, and a reminder may follow; a past buyers' import may email
 * each buyer once that what they bought has moved. None of them goes to an address the creator's list keeps as
 * having left it: unsubscribed, marked as spam, or bounced for good. The members' emails carry a way to stop them that
 * works at once (a link and the one-click header a mail app reads) and the creator's postal address; a store without
 * one does not start a members import. Each read is exact (CX-123 rule 24): a list row in any other shape holds the
 * emails, still queued, and the reminder, still in line, and is never taken as "may be written to".
 *
 * Also here: "Keep my membership" opens no second checkout once the membership was kept, and a read of the
 * invitation in an unknown shape opens nothing; an order status left empty in a file that has a status column is
 * never read as paid, while a file with no status column is read as before.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { addRows, finishUpload, previewImport, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { importedFor } from "@/lib/imported-purchases";
import { noteKept, openMove } from "@/lib/move-members";
import { readStopToken, stopReminders } from "@/lib/checkout-recovery";
import { readOrderStatus } from "@/lib/clickfunnels-csv";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { TEST_CONSENT } from "./digital-consent-fixture";

const DAY = 86_400;
const POSTAL = "12 Harbor Lane, Portland, ME 04101, USA";
type Sent = { to: string | string[]; subject: string; text: string; html: string; headers?: Record<string, string> };
const emails: Sent[] = [];
const checkouts: URLSearchParams[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as Sent | Sent[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one);
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && init?.method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"o".repeat(20)}${checkouts.length}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const to = (e: Sent) => [e.to].flat()[0];
const sentTo = (address: string, from = 0) => emails.slice(from).filter((e) => to(e) === address).length;
const lastTo = (address: string) => emails.filter((e) => to(e) === address).at(-1);
const header = (e: Sent | undefined, name: string) => {
  const found = Object.entries(e?.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return found ? found[1] : null;
};

async function run(id: string) {
  let job = await runImport(id, Date.now() + 30_000);
  for (let i = 0; i < 10 && job && job.state !== "done"; i += 1) job = await runImport(id, Date.now() + 30_000);
  return job;
}

const original = redis.pipeline.bind(redis);
const restore = () => {
  redis.pipeline = original;
};
/** Answers every read of the list's rows (HMGET or HGET of nl:store:leads:<listId>) with `reply` while `when()` holds. */
function listRowsAnswer(listId: string, reply: unknown, when: () => boolean = () => true) {
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (when() && commands.some((c) => (c[0] === "HMGET" || c[0] === "HGET") && c[1] === `nl:store:leads:${listId}`)) {
      if (reply === "throw") throw new Error("synthetic list read failure");
      return commands.map(() => reply);
    }
    return original(commands);
  };
}

const UNKNOWN: [string, unknown][] = [
  ["a reply that is not a list", "OK"],
  ["a list shorter than the addresses", []],
  ["an entry that is neither nothing nor text", [{ x: 1 }]],
  ["a row that is not a contact", ["not a contact"]],
  ["a failed read", "throw"],
];

/** The store's count of emails to people brought over this month, cleared, so each part starts from an unused month (synthetic). */
function monthUnused(sid: string) {
  for (const key of (redis.run(["SCAN", "0", "MATCH", `nl:imports:moved:${sid}:*`]) as [string, string[]])[1]) redis.run(["DEL", key]);
}

/** A row on the creator's list, as lib/contacts.ts keeps it. */
function onList(listId: string, email: string, row: Record<string, unknown>) {
  redis.run(["HSET", `nl:store:leads:${listId}`, email, JSON.stringify({ agreed: true, agreedAt: "2026-01-01T00:00:00.000Z", unsub: false, ...row })]);
}

async function openStore(owner: string, handle: string, account: string, id: string, postal: boolean) {
  await claimHandle(owner, handle, "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  if (postal) await setMailSettings(owner, { fromName: "Harbor Kitchen", address: POSTAL });
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
  const OWNER = "optout-owner@example.com";
  const { club } = await openStore(OWNER, "optoutshop", "acct_1TestOptOut0001", "OptOutOwner1", true);
  const fresh = async () => (await storeForEmail(OWNER))!;
  let store: Store = await fresh();
  const listId = store.listId!;
  onList(listId, "left@example.com", { unsub: true, unsubAt: "2026-02-01T00:00:00.000Z" });
  onList(listId, "spam@example.com", { unsub: true, unsubAt: "2026-02-01T00:00:00.000Z", gone: "complained" });
  onList(listId, "bounce@example.com", { unsub: true, unsubAt: "2026-02-01T00:00:00.000Z", gone: "bounced" });
  onList(listId, "quiet@example.com", { agreed: false });
  const in20 = Math.floor(Date.now() / 1000) + 20 * DAY;
  const renews = new Date(in20 * 1000).toISOString().slice(0, 10);
  const OUT = ["left@example.com", "spam@example.com", "bounce@example.com"];

  part("A members import skips the addresses the list keeps as having left");
  monthUnused(store.sid);
  const m = await startImport(store, OWNER, "members", { expected: 5, file: "patrons.csv", stopped: true });
  if (!m.ok) throw new Error(`members not started: ${m.reason}`);
  await addRows(store, m.job.id, [...OUT, "quiet@example.com", "new@example.com"].map((e, i) => [String(i + 2), e, "The Inner Circle", renews, ""]));
  await finishUpload(store, m.job.id);
  const mj = await run(m.job.id);
  is("control: a member on the list who never agreed, and one not on it, are emailed their link", [mj?.state, sentTo("quiet@example.com"), sentTo("new@example.com")], ["done", 1, 1]);
  is("unsubscribed, marked as spam and bounced: not emailed", OUT.map((e) => sentTo(e)), [0, 0, 0]);
  is("and counted as not emailed", [mj?.counts.mailed, mj?.counts.unmailed], [2, 3]);

  part("Each member's email carries a way to stop it and the creator's postal address");
  const invite = lastTo("new@example.com");
  const oneClick = header(invite, "List-Unsubscribe") ?? "";
  const token = oneClick.match(/\/api\/mail\/unsubscribe\?r=([0-9a-f]{40})>$/)?.[1] ?? "";
  is("the one-click header a mail app reads, and its POST", [token.length, header(invite, "List-Unsubscribe-Post")], [40, "List-Unsubscribe=One-Click"]);
  is("the stop link is in the text and the HTML", [invite?.text.includes(`/unsubscribe?r=${token}`), invite?.html.includes(`/unsubscribe?r=${token}`)], [true, true]);
  is("the postal address is in the text and the HTML", [invite?.text.includes(POSTAL), invite?.html.includes(POSTAL)], [true, true]);
  const found = token ? await readStopToken(token) : null;
  is("the link is the member's own", found?.email, "new@example.com");

  part("An unknown read of the list's rows holds the members' emails, still queued");
  for (const [what, reply] of UNKNOWN) {
    store = await fresh();
    monthUnused(store.sid);
    const member = `held${what.length}@example.com`;
    const job = await startImport(store, OWNER, "members", { expected: 1, file: "patrons.csv", stopped: true });
    if (!job.ok) throw new Error(`not started: ${job.reason}`);
    await addRows(store, job.job.id, [["2", member, "The Inner Circle", renews, ""]]);
    await finishUpload(store, job.job.id);
    let queued = false;
    const before = emails.length;
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (queued && commands.some((c) => (c[0] === "HMGET" || c[0] === "HGET") && c[1] === `nl:store:leads:${listId}`)) {
        if (reply === "throw") throw new Error("synthetic list read failure");
        return commands.map(() => reply);
      }
      const out = await original(commands);
      if (commands.some((c) => c[0] === "SADD" && c[1] === `nl:import:${job.job.id}:mail`)) queued = true;
      return out;
    };
    let held;
    try {
      held = await runImport(job.job.id, Date.now() + 30_000);
    } finally {
      restore();
    }
    is(`${what}: nobody is emailed, the member still queued, the import still mailing`, [held?.state, emails.length - before, redis.run(["SCARD", `nl:import:${job.job.id}:mail`])], ["mailing", 0, 1]);
    const after = await run(job.job.id);
    is(`${what}: read again, the member is emailed`, [after?.state, sentTo(member, before)], ["done", 1]);
  }

  part("The one reminder: not to who left the list or pressed stop, held on an unknown read");
  is("the member presses stop in their email", await stopReminders(token), true);
  is("it is kept at once", (await readStopToken(token))?.stopped, true);
  store = await fresh();
  monthUnused(store.sid);
  const at = (in20 - 2 * DAY + 3_600) * 1000;
  let before = emails.length;
  listRowsAnswer(listId, "OK");
  let r1;
  try {
    r1 = await sendMoveReminders(Date.now() + 30_000, at);
  } finally {
    restore();
  }
  is("an unknown list read sends no reminder", [r1.sent, emails.length - before], [0, 0]);
  const r2 = await sendMoveReminders(Date.now() + 30_000, at + 3_601 * 1000);
  is("read again, control: the member who never agreed is reminded", [r2.sent > 0, sentTo("quiet@example.com", before)], [true, 1]);
  is("the member who pressed stop is not", sentTo("new@example.com", before), 0);
  is("nor those who left the list", OUT.map((e) => sentTo(e, before)), [0, 0, 0]);
  const reminder = lastTo("quiet@example.com");
  is("the reminder carries the stop link, its headers and the postal address", [
    /\/api\/mail\/unsubscribe\?r=[0-9a-f]{40}>$/.test(header(reminder, "List-Unsubscribe") ?? ""),
    header(reminder, "List-Unsubscribe-Post"),
    /\/unsubscribe\?r=[0-9a-f]{40}/.test(reminder?.text ?? ""),
    reminder?.text.includes(POSTAL),
  ], [true, "List-Unsubscribe=One-Click", true, true]);

  part("A past buyers' import: the one email that what they bought has moved");
  store = await fresh();
  monthUnused(store.sid);
  before = emails.length;
  const p = await startImport(store, OWNER, "purchases", { expected: 4, file: "orders.csv", email: true });
  if (!p.ok) throw new Error(`purchases not started: ${p.reason}`);
  await addRows(store, p.job.id, [...OUT, "buyer@example.com"].map((e, i) => [String(i + 2), e, "The Guide", "Paid"]));
  await finishUpload(store, p.job.id);
  const pj = await run(p.job.id);
  store = await fresh();
  is("control: everyone is given what they bought", [pj?.state, pj?.counts.added, ...(await Promise.all([...OUT, "buyer@example.com"].map(async (e) => (await importedFor(store, e)).length)))], ["done", 4, 1, 1, 1, 1]);
  is("control: the buyer not on the list is emailed", sentTo("buyer@example.com", before), 1);
  is("those who left the list are not emailed, and are counted so", [...OUT.map((e) => sentTo(e, before)), pj?.counts.unmailed], [0, 0, 0, 3]);
  {
    store = await fresh();
    monthUnused(store.sid);
    const job = await startImport(store, OWNER, "purchases", { expected: 1, file: "orders.csv", email: true });
    if (!job.ok) throw new Error(`not started: ${job.reason}`);
    await addRows(store, job.job.id, [["2", "heldbuyer@example.com", "The Guide", "Paid"]]);
    await finishUpload(store, job.job.id);
    let queued = false;
    before = emails.length;
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (queued && commands.some((c) => (c[0] === "HMGET" || c[0] === "HGET") && c[1] === `nl:store:leads:${listId}`)) return commands.map(() => "OK");
      const out = await original(commands);
      if (commands.some((c) => c[0] === "SADD" && c[1] === `nl:import:${job.job.id}:mail`)) queued = true;
      return out;
    };
    let held;
    try {
      held = await runImport(job.job.id, Date.now() + 30_000);
    } finally {
      restore();
    }
    is("an unknown list read: nobody emailed, still queued", [held?.state, emails.length - before, redis.run(["SCARD", `nl:import:${job.job.id}:mail`])], ["mailing", 0, 1]);
    const after = await run(job.job.id);
    is("read again, the buyer is emailed", [after?.state, sentTo("heldbuyer@example.com", before)], ["done", 1]);
  }

  part("A store with no postal address does not start a members import");
  {
    const NO_POSTAL = "nopostal-owner@example.com";
    await openStore(NO_POSTAL, "nopostalshop", "acct_1TestNoPostal01", "NoPostal1", false);
    const bare = (await storeForEmail(NO_POSTAL))!;
    const refused = await startImport(bare, NO_POSTAL, "members", { expected: 1, file: "patrons.csv", stopped: true });
    is("refused, saying why", refused.ok ? "started" : refused.reason, "address");
    const control = await previewImport(bare, "purchases", { expected: 1, file: "orders.csv", email: true }, [["2", "someone@example.com", "The Guide", "Paid"]]);
    is("control: a past buyers' import, emailed once, is not held by it", control.ok, true);
  }

  part("Keep my membership, once kept, opens no second checkout");
  {
    store = await fresh();
    const link = lastTo("quiet@example.com")?.text.match(/\/move\/([A-Za-z0-9_-]+)\?k=([0-9a-f]{40})/);
    if (!link) throw new Error("no link");
    const first = await openMove(store, link[1], link[2], "https://marktmorgen.com", Date.now(), TEST_CONSENT);
    is("control: before it is kept, the checkout opens", [first.ok, checkouts.length], [true, 1]);
    await noteKept(store, "quiet@example.com", club.id);
    const again = await openMove(store, link[1], link[2], "https://marktmorgen.com", Date.now(), TEST_CONSENT);
    is("once kept, it answers kept and opens nothing", [again.ok ? "opened" : again.reason, checkouts.length], ["kept", 1]);
    const other = lastTo(`held${UNKNOWN[0][0].length}@example.com`);
    const otherLink = other?.text.match(/\/move\/([A-Za-z0-9_-]+)\?k=([0-9a-f]{40})/);
    if (!otherLink) throw new Error("no second link");
    for (const [what, reply] of [["an invitation read in an unknown shape", 7], ["a link read in an unknown shape", ["x"]]] as [string, unknown][]) {
      redis.pipeline = async (commands: (string | number)[][]) => {
        const target = what.startsWith("an invitation") ? (c: (string | number)[]) => c[0] === "HGET" && String(c[1]).startsWith("nl:mv:") : (c: (string | number)[]) => c[0] === "GET" && String(c[1]).startsWith("nl:mv:link:");
        if (commands.some(target)) return commands.map(() => reply);
        return original(commands);
      };
      let unknown;
      try {
        unknown = await openMove(store, otherLink[1], otherLink[2], "https://marktmorgen.com", Date.now(), TEST_CONSENT);
      } finally {
        restore();
      }
      is(`${what}: nothing opens, and the member is asked to try again`, [unknown.ok ? "opened" : unknown.reason, checkouts.length], ["refused", 1]);
    }
    const control = await openMove(store, otherLink[1], otherLink[2], "https://marktmorgen.com", Date.now(), TEST_CONSENT);
    is("control: read whole, that member's checkout opens", [control.ok, checkouts.length], [true, 2]);
  }

  part("An order status left empty is not read as paid");
  is("empty, in a file with a status column: not known, never paid", [readOrderStatus(""), readOrderStatus("   ")], ["unknown", "unknown"]);
  is("control: the words read as before", ["Paid", "Refunded", "who knows"].map((s) => readOrderStatus(s)), ["paid", "unpaid", "unknown"]);
  store = await fresh();
  const rows = [["2", "empty@example.com", "The Guide", ""], ["3", "paid@example.com", "The Guide", "Paid"]];
  const withColumn = await previewImport(store, "purchases", { expected: 2, file: "orders.csv", email: false, statusColumn: true } as Parameters<typeof previewImport>[2], rows);
  is("a file with a status column: the empty one is not given, the paid one is", withColumn.ok ? withColumn.rows.map((r) => [r[0], r[1]]).sort((a, b) => Number(a[0]) - Number(b[0])) : withColumn, [[2, "error"], [3, "added"]]);
  const cf = await previewImport(store, "purchases", { expected: 2, file: "orders.csv", email: false, statusColumn: true, source: "clickfunnels" } as Parameters<typeof previewImport>[2], rows);
  is("the same from a ClickFunnels export", cf.ok ? cf.rows.map((r) => [r[0], r[1]]).sort((a, b) => Number(a[0]) - Number(b[0])) : cf, [[2, "error"], [3, "added"]]);
  const noColumn = await previewImport(store, "purchases", { expected: 2, file: "orders.csv", email: false, statusColumn: false } as Parameters<typeof previewImport>[2], rows);
  is("control: a file with no status column gives both, as before", noColumn.ok ? noColumn.rows.map((r) => [r[0], r[1]]).sort((a, b) => Number(a[0]) - Number(b[0])) : noColumn, [[2, "added"], [3, "added"]]);
  done();
}

void main();
