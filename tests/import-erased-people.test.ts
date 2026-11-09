/**
 * A person deleted from a store stays out of every import and every email under its name (synthetic only; Stripe
 * and the sender are stand-ins for fetch).
 *
 * The promise (app/privacy/delete/page.tsx, lib/help-content.ts, lib/suppression.ts): once deleted, "that store never
 * emails you again and no import puts you back", and "no import or API call puts them back". The store's prints
 * (nl:erased:<listId>) are read where each import writes and where each of its emails goes out: the past buyers'
 * import and the members' import leave a deleted address out (counted as left out, with the reason, and the address
 * not written into the report), their emails and the members' reminder skip it, and the API's give-access answers
 * "deleted". Each read is exact (CX-123 rule 24): a reply in any other shape holds the rows, the emails or the
 * reminder as they were, and never takes the person as not deleted. Everybody else goes on exactly as before.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { addRows, finishUpload, previewImport, readJob, reportCsv, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { importedFor } from "@/lib/imported-purchases";
import { erasePerson } from "@/lib/person-erasure";
import { suppressCommand } from "@/lib/suppression";
import { giveAccess } from "@/lib/api-write";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
type Sent = { to: string | string[]; subject: string; text: string };
const emails: Sent[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as Sent | Sent[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one);
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const to = (e: Sent) => [e.to].flat()[0];
const sentTo = (address: string, from = 0) => emails.slice(from).filter((e) => to(e) === address).length;

async function run(id: string) {
  let job = await runImport(id, Date.now() + 30_000);
  for (let i = 0; i < 10 && job && job.state !== "done"; i += 1) job = await runImport(id, Date.now() + 30_000);
  return job;
}

const original = redis.pipeline.bind(redis);
/** Answers the store's prints in `reply` (or throws) while `when()` holds; every other command as it is. */
function printsAnswer(listId: string, reply: unknown, when: () => boolean = () => true) {
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (when() && commands.some((c) => c[0] === "HMGET" && c[1] === `nl:erased:${listId}`)) {
      if (reply === "throw") throw new Error("synthetic prints read failure");
      return commands.map(() => reply);
    }
    return original(commands);
  };
}
const restore = () => {
  redis.pipeline = original;
};

const UNKNOWN: [string, unknown][] = [
  ["a reply that is not a list", "OK"],
  ["a list shorter than the addresses", [null]],
  ["an entry that is neither nothing nor text", [null, { x: 1 }]],
  ["a failed read", "throw"],
];

/** A paid Store plan with a product to give and a membership to move. */
async function openStore(owner: string, handle: string, account: string, id: string) {
  await claimHandle(owner, handle, "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${id}`, subscriptionId: `sub_${id}`, active: true, period: paidPeriod() });
  const guide = await addProduct(owner, "The Guide", "", "12", null);
  const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!guide.ok || !club.ok) throw new Error("no product");
  await setProductLink(owner, guide.product.id, "https://example.com/guide");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  return { guide, club };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();
  const OWNER = "erased-owner@example.com";
  const { guide } = await openStore(OWNER, "erasedshop", "acct_1TestErased0001", "ErasedOwner1");
  const fresh = async () => (await storeForEmail(OWNER))!;
  let store: Store = await fresh();

  part("The person asks to be deleted from the store");
  is("the deletion finished", (await erasePerson(store, "gone@example.com", { kind: "person" })).ok, true);
  store = await fresh();
  const listId = store.listId!;
  const in20 = Math.floor(Date.now() / 1000) + 20 * DAY;
  const renews = new Date(in20 * 1000).toISOString().slice(0, 10);

  part("The past buyers' dry run says the deleted address is left out");
  const dry = await previewImport(store, "purchases", { expected: 2, file: "orders.csv", email: true }, [["2", "gone@example.com", "The Guide", "Paid"], ["3", "kept@example.com", "The Guide", "Paid"]]);
  is(
    "the deleted address is left out, the other given (the dry run reads as the import will)",
    dry.ok ? dry.rows.map((r) => [r[0], r[1], r[3]]) : dry,
    [[2, "skipped", "Deleted from your store before, so left alone"], [3, "added", "Given The Guide, unless they already have it"]],
  );

  part("The creator imports the old platform's past buyers, with the email box checked");
  const p = await startImport(store, OWNER, "purchases", { expected: 2, file: "orders.csv", email: true });
  if (!p.ok) throw new Error(`purchases not started: ${p.reason}`);
  await addRows(store, p.job.id, [["2", "gone@example.com", "The Guide", "Paid"], ["3", "kept@example.com", "The Guide", "Paid"]]);
  await finishUpload(store, p.job.id);
  const pj = await run(p.job.id);
  is("control: the import finished, the other buyer given the product and emailed", [pj?.state, pj?.counts.added, pj?.counts.mailed, sentTo("kept@example.com")], ["done", 1, 1, 1]);
  store = await fresh();
  is("the deleted address is not given the product again (no import puts them back)", (await importedFor(store, "gone@example.com")).length, 0);
  is("the deleted address is not emailed (the store never emails them again)", sentTo("gone@example.com"), 0);
  is("the row is counted as left out", pj?.counts.skipped, 1);
  const report = pj ? await reportCsv(pj) : "";
  is("the report says why, by its row, without writing the address back", [report.includes("Left out: Deleted from your store before, so left alone"), report.includes("gone@example.com")], [true, false]);

  part("And a members import");
  let before = emails.length;
  const m = await startImport(store, OWNER, "members", { expected: 2, file: "patrons.csv", stopped: true });
  if (!m.ok) throw new Error(`members not started: ${m.reason}`);
  await addRows(store, m.job.id, [["2", "gone@example.com", "The Inner Circle", renews, ""], ["3", "member@example.com", "The Inner Circle", renews, ""]]);
  await finishUpload(store, m.job.id);
  const mj = await run(m.job.id);
  is("control: the other member is invited and emailed their link", [mj?.state, mj?.counts.added, sentTo("member@example.com", before)], ["done", 1, 1]);
  is("the deleted address is not invited (counted as left out)", mj?.counts.skipped, 1);
  is("nor emailed a link to pay", sentTo("gone@example.com", before), 0);

  part("An unknown reply about who was deleted holds the past buyers' rows");
  for (const [i, [what, reply]] of UNKNOWN.entries()) {
    const buyer = `held${i}@example.com`;
    store = await fresh();
    const job = await startImport(store, OWNER, "purchases", { expected: 2, file: "orders.csv", email: true });
    if (!job.ok) throw new Error(`not started: ${job.reason}`);
    await addRows(store, job.job.id, [["2", buyer, "The Guide", "Paid"], ["3", "gone@example.com", "The Guide", "Paid"]]);
    await finishUpload(store, job.job.id);
    before = emails.length;
    printsAnswer(listId, reply);
    let held;
    try {
      held = await runImport(job.job.id, Date.now() + 30_000);
    } finally {
      restore();
    }
    store = await fresh();
    is(`${what}: nobody in the rows is given anything or emailed, the import still running`, [held?.state, (await readJob(job.job.id))?.done, (await importedFor(store, buyer)).length, (await importedFor(store, "gone@example.com")).length, emails.length - before], ["running", 0, 0, 0, 0]);
    const after = await run(job.job.id);
    is(`${what}: read again, it goes on as before`, [after?.state, after?.counts.added, after?.counts.skipped, sentTo(buyer, before), sentTo("gone@example.com", before)], ["done", 1, 1, 1, 0]);
  }

  part("An unknown reply about who was deleted holds the members' rows");
  {
    store = await fresh();
    const job = await startImport(store, OWNER, "members", { expected: 1, file: "patrons.csv", stopped: true });
    if (!job.ok) throw new Error(`not started: ${job.reason}`);
    await addRows(store, job.job.id, [["2", "heldmember@example.com", "The Inner Circle", renews, ""]]);
    await finishUpload(store, job.job.id);
    before = emails.length;
    printsAnswer(listId, "OK");
    let held;
    try {
      held = await runImport(job.job.id, Date.now() + 30_000);
    } finally {
      restore();
    }
    is("nobody is invited or emailed, the import still running", [held?.state, held?.counts.added, emails.length - before], ["running", 0, 0]);
    const after = await run(job.job.id);
    is("read again, the member is invited and emailed", [after?.state, after?.counts.added, sentTo("heldmember@example.com", before)], ["done", 1, 1]);
  }

  part("Somebody deleted after the rows were brought in and before the email goes");
  {
    store = await fresh();
    const job = await startImport(store, OWNER, "purchases", { expected: 2, file: "orders.csv", email: true });
    if (!job.ok) throw new Error(`not started: ${job.reason}`);
    await addRows(store, job.job.id, [["2", "late@example.com", "The Guide", "Paid"], ["3", "ontime@example.com", "The Guide", "Paid"]]);
    await finishUpload(store, job.job.id);
    before = emails.length;
    // The print is written the moment the rows have queued their emails, as a deletion in between would.
    redis.pipeline = async (commands: (string | number)[][]) => {
      const out = await original(commands);
      if (commands.some((c) => c[0] === "SADD" && c[1] === `nl:import:${job.job.id}:mail`)) redis.run(suppressCommand(listId, "late@example.com"));
      return out;
    };
    let after;
    try {
      after = await run(job.job.id);
    } finally {
      restore();
    }
    is("control: the other buyer is emailed", [after?.state, sentTo("ontime@example.com", before)], ["done", 1]);
    is("the one deleted in between is not emailed", sentTo("late@example.com", before), 0);
  }

  part("An unknown reply about who was deleted holds the emails, still queued");
  for (const [what, reply] of UNKNOWN.slice(0, 2)) {
    store = await fresh();
    const job = await startImport(store, OWNER, "purchases", { expected: 2, file: "orders.csv", email: true });
    if (!job.ok) throw new Error(`not started: ${job.reason}`);
    const pair = [`q1${what.length}@example.com`, `q2${what.length}@example.com`];
    await addRows(store, job.job.id, [["2", pair[0], "The Guide", "Paid"], ["3", pair[1], "The Guide", "Paid"]]);
    await finishUpload(store, job.job.id);
    before = emails.length;
    let queued = false;
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (queued && commands.some((c) => c[0] === "HMGET" && c[1] === `nl:erased:${listId}`)) return commands.map(() => reply);
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
    const waiting = redis.run(["SCARD", `nl:import:${job.job.id}:mail`]);
    is(`${what}: nobody is emailed, both still queued, the import still mailing`, [held?.state, emails.length - before, waiting], ["mailing", 0, 2]);
    const after = await run(job.job.id);
    is(`${what}: read again, both are emailed`, [after?.state, sentTo(pair[0], before), sentTo(pair[1], before)], ["done", 1, 1]);
  }

  part("The members' one reminder (another store, with its month's emails unused)");
  {
    const REMINDER_OWNER = "reminder-owner@example.com";
    await openStore(REMINDER_OWNER, "remindshop", "acct_1TestRemind0001", "RemindOwner1");
    const store = (await storeForEmail(REMINDER_OWNER))!;
    const listId = store.listId!;
    const in10 = Math.floor(Date.now() / 1000) + 10 * DAY;
    const job = await startImport(store, REMINDER_OWNER, "members", { expected: 2, file: "patrons.csv", stopped: true });
    if (!job.ok) throw new Error(`not started: ${job.reason}`);
    const day = new Date(in10 * 1000).toISOString().slice(0, 10);
    await addRows(store, job.job.id, [["2", "remgone@example.com", "The Inner Circle", day, ""], ["3", "remkept@example.com", "The Inner Circle", day, ""]]);
    await finishUpload(store, job.job.id);
    const invited = await run(job.job.id);
    is("setup: both invited and emailed", [invited?.counts.added, sentTo("remgone@example.com"), sentTo("remkept@example.com")], [2, 1, 1]);
    // The print alone, as if the person were deleted while the invitation was still kept.
    redis.run(suppressCommand(listId, "remgone@example.com"));
    // Past the reminder's time (three days before the renewal, as the file's date is read) and before the renewal.
    const at = (in10 - 2 * DAY + 3_600) * 1000;
    before = emails.length;
    printsAnswer(listId, "OK");
    let r1;
    try {
      r1 = await sendMoveReminders(Date.now() + 30_000, at);
    } finally {
      restore();
    }
    is("an unknown reply sends no reminder, and keeps both in line", [r1.sent, emails.length - before], [0, 0]);
    const r2 = await sendMoveReminders(Date.now() + 30_000, at + 3_601 * 1000);
    is("read again, the other member is reminded", [r2.sent, sentTo("remkept@example.com", before)], [1, 1]);
    is("the deleted address is never reminded", sentTo("remgone@example.com", before), 0);
  }

  part("The API's give-access");
  {
    store = await fresh();
    before = emails.length;
    const refused = await giveAccess(store, "key_erased_test", { email: "gone@example.com", product: guide.product.id, notify: true });
    is("a deleted address is refused as deleted", refused, { ok: false, error: "deleted" });
    store = await fresh();
    is("nothing is given or emailed", [(await importedFor(store, "gone@example.com")).length, sentTo("gone@example.com", before)], [0, 0]);
    printsAnswer(listId, "OK");
    let unknown;
    try {
      unknown = await giveAccess(store, "key_erased_test", { email: "apiheld@example.com", product: guide.product.id, notify: true });
    } finally {
      restore();
    }
    store = await fresh();
    is("an unknown reply refuses, nothing given or emailed", [unknown, (await importedFor(store, "apiheld@example.com")).length, sentTo("apiheld@example.com", before)], [{ ok: false, error: "unavailable" }, 0, 0]);
    const given = await giveAccess(store, "key_erased_test", { email: "apiheld@example.com", product: guide.product.id, notify: true });
    is("control: anybody else is given it and emailed", [given.ok && given.value.status, given.ok && given.value.emailed, sentTo("apiheld@example.com", before)], ["given", true, 1]);
  }
  done();
}

void main();
