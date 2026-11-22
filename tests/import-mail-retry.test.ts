/**
 * A step of an import that fails after its rows were written, and is done again from its last saved place, still
 * emails the people this import itself gave a purchase or invited, and still counts them as added (issue #3957;
 * synthetic only: Stripe and the sender are stand-ins for fetch).
 *
 * The past buyers' step grants each purchase (GRANT_UNLESS_ERASED) and only then queues the address for the email the
 * creator asked for (SADD nl:import:<id>:mail); the members' step invites (INVITE_UNLESS_ERASED), sets each link and
 * reminder, then queues the invitation. When a command in between failed, the step was done again and the grant
 * answered "already", the invitation "already invited": nobody was emailed and the report said already 1, added 0.
 * A row is taken as this import's own only from its record (the grant's or the invitation's job), never from the
 * answer alone: a buyer or member another import brought is still "already", and is not emailed.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { RETRY_OWN_READ_BYTES, RETRY_OWN_READ_COMMANDS, addRows, finishUpload, runImport, startImport } from "@/lib/imports";
import { IMPORT_WORST_BYTES_PER_ROW } from "@/lib/import-limits";
import { importedFor } from "@/lib/imported-purchases";
import { INVITE_OWN_READ_COMMANDS, inviteMembers, linkKey, readInvite, inviteField } from "@/lib/move-members";
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
/** Throws once, instead of running them, on the first pipeline holding a command that matches `at`; the rest as they are. */
function failOnce(at: (c: (string | number)[]) => boolean): { fired: () => boolean } {
  let fired = false;
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (!fired && commands.some(at)) {
      fired = true;
      throw new Error("synthetic failure between the write and the queue");
    }
    return original(commands);
  };
  return { fired: () => fired };
}
const restore = () => {
  redis.pipeline = original;
};
const queues = (id: string) => (c: (string | number)[]) => c[0] === "SADD" && c[1] === `nl:import:${id}:mail`;

/**
 * Runs an import whose first pipeline matching `at` fails once (before it runs, or, with `lost`, after it ran with its
 * reply lost), and measures, pass by pass, the reads a step done again makes of what it wrote before (#4008's cost
 * line, tests/plan-cost-registry.ts "imports"): each HGET of a stored purchase, each HMGET of the store's invitations
 * outside a script, and the bytes of every record they bring back.
 */
async function measured(id: string, at: (c: (string | number)[]) => boolean, lost = false) {
  let fired = false;
  let pass = { commands: 0, bytes: 0 };
  const passes: { commands: number; bytes: number }[] = [];
  let worstRecord = 0;
  const size = (raw: unknown) => (typeof raw === "string" ? Buffer.byteLength(raw) : 0);
  redis.pipeline = async (commands: (string | number)[][]) => {
    const hit = !fired && commands.some(at);
    if (hit && !lost) {
      fired = true;
      throw new Error("synthetic failure before the pipeline ran");
    }
    const replies = (await original(commands)) as unknown[];
    commands.forEach((c, i) => {
      const key = String(c[1]);
      const own = (c[0] === "HGET" && key.startsWith("nl:imp:buy:")) || (c[0] === "HMGET" && key.startsWith("nl:mv:") && !key.startsWith("nl:mv:link:"));
      if (!own) return;
      const records = c[0] === "HMGET" ? (replies[i] as unknown[]) : [replies[i]];
      pass.commands += 1;
      for (const raw of records) {
        pass.bytes += size(raw);
        worstRecord = Math.max(worstRecord, size(raw));
      }
    });
    if (hit) {
      fired = true;
      throw new Error("synthetic failure: the pipeline ran, its reply lost");
    }
    return replies;
  };
  let job;
  try {
    for (let i = 0; i < 10 && (!job || job.state !== "done"); i += 1) {
      pass = { commands: 0, bytes: 0 };
      job = await runImport(id, Date.now() + 30_000);
      passes.push(pass);
    }
  } finally {
    restore();
  }
  return { fired, job, passes, worstRecord };
}

/** The store's count of emails to people brought over this month, cleared, so each members part starts from an unused month. */
function monthUnused(sid: string) {
  for (const key of (redis.run(["SCAN", "0", "MATCH", `nl:imports:moved:${sid}:*`]) as [string, string[]])[1]) redis.run(["DEL", key]);
}

async function openStore(owner: string, handle: string, account: string, id: string) {
  await claimHandle(owner, handle, "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${id}`, subscriptionId: `sub_${id}`, active: true, period: paidPeriod() });
  // A members import needs the postal address its emails carry since main's move-members work (lib/move-members.ts,
  // movePostal; merge of main, 18 November 2026). A synthetic one, as tests/members-import-emails-month.test.ts gives.
  await setMailSettings(owner, { fromName: "Harbor Kitchen", address: "12 Harbor Lane, Portland, ME 04101, USA" });
  const guide = await addProduct(owner, "The Guide", "", "12", null);
  const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!guide.ok || !club.ok) throw new Error("no product");
  await setProductLink(owner, guide.product.id, "https://example.com/guide");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  return { guide, club };
}

async function purchases(store: Store, owner: string, buyer: string) {
  const job = await startImport(store, owner, "purchases", { expected: 1, file: "orders.csv", email: true });
  if (!job.ok) throw new Error(`purchases not started: ${job.reason}`);
  await addRows(store, job.job.id, [["2", buyer, "The Guide", "Paid"]]);
  await finishUpload(store, job.job.id);
  return job.job.id;
}

async function members(store: Store, owner: string, member: string, renews: string) {
  monthUnused(store.sid);
  const job = await startImport(store, owner, "members", { expected: 1, file: "patrons.csv", stopped: true });
  if (!job.ok) throw new Error(`members not started: ${job.reason}`);
  await addRows(store, job.job.id, [["2", member, "The Inner Circle", renews, ""]]);
  await finishUpload(store, job.job.id);
  return job.job.id;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();
  const OWNER = "retry-owner@example.com";
  const { club } = await openStore(OWNER, "retryshop", "acct_1TestRetry00001", "RetryOwner1");
  const fresh = async () => (await storeForEmail(OWNER))!;
  let store: Store = await fresh();
  const in20 = Math.floor(Date.now() / 1000) + 20 * DAY;
  const renews = new Date(in20 * 1000).toISOString().slice(0, 10);

  part("Past buyers: the step fails after the grant, before the address is queued, and is done again");
  {
    const before = emails.length;
    const id = await purchases(store, OWNER, "retried@example.com");
    const failure = failOnce(queues(id));
    let after;
    try {
      after = await run(id);
    } finally {
      restore();
    }
    store = await fresh();
    is("the failure happened between the grant and the queue", failure.fired(), true);
    is("the purchase was given once, by this import", (await importedFor(store, "retried@example.com")).map((p) => p.job), [id]);
    is("the buyer is emailed exactly once", [after?.state, sentTo("retried@example.com", before)], ["done", 1]);
    is("the report counts the buyer as added, not already", [after?.counts.added, after?.counts.already, after?.counts.mailed], [1, 0, 1]);
  }

  part("Control: a buyer another import gave the product is still already, and not emailed again");
  {
    const before = emails.length;
    const id = await purchases(store, OWNER, "retried@example.com");
    const after = await run(id);
    is("already, never added, and nobody emailed", [after?.state, after?.counts.added, after?.counts.already, sentTo("retried@example.com", before)], ["done", 0, 1, 0]);
  }

  part("Members: the step fails after the invitation, before it is queued, and is done again");
  {
    const before = emails.length;
    const id = await members(store, OWNER, "member@example.com", renews);
    const failure = failOnce(queues(id));
    let after;
    try {
      after = await run(id);
    } finally {
      restore();
    }
    is("the failure happened between the invitation and the queue", failure.fired(), true);
    is("the member is emailed their link exactly once", [after?.state, sentTo("member@example.com", before)], ["done", 1]);
    is("the report counts the member as added, not already", [after?.counts.added, after?.counts.already], [1, 0]);
  }

  // Since main's move-members work (lib/move-members.ts INVITE_UNLESS_ERASED, merge of main, 18 November 2026) an
  // import writes the invitation, its link and its reminder in one step, so no separate SET of the link can fail. The
  // nearest failure left: that step is written and its reply is lost. The next try finds the invitation its own and
  // answers it as new (issue #3957), with the link written in that first step.
  part("Members: the step that writes the invitation and its link is written, its reply lost, and is done again");
  {
    const before = emails.length;
    const id = await members(store, OWNER, "linked@example.com", renews);
    let lost = false;
    redis.pipeline = async (commands: (string | number)[][]) => {
      const replies = await original(commands);
      if (!lost && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:invite-unless-erased:"))) {
        lost = true;
        throw new Error("synthetic failure: the invitations were written, the reply lost");
      }
      return replies;
    };
    const failure = { fired: () => lost };
    let after;
    try {
      after = await run(id);
    } finally {
      restore();
    }
    store = await fresh();
    const invite = await readInvite(store.statsId!, inviteField("linked@example.com", club.product.id));
    is("the failure happened after the invitation and its link were written", failure.fired(), true);
    is("the member is emailed exactly once, counted as added", [after?.state, sentTo("linked@example.com", before), after?.counts.added, after?.counts.already], ["done", 1, 1, 0]);
    is("the link in the email opens: it is kept under the invitation's token", invite ? redis.run(["EXISTS", linkKey(invite.t)]) : "no invitation", 1);
  }

  part("An unknown reply when the grant or the invitation is read again holds the step, never taken as somebody else's");
  for (const kind of ["purchases", "members"] as const) {
    const address = `unknown-${kind}@example.com`;
    const before = emails.length;
    store = await fresh();
    const id = kind === "purchases" ? await purchases(store, OWNER, address) : await members(store, OWNER, address, renews);
    const rereads = (c: (string | number)[]) => (kind === "purchases" ? c[0] === "HGET" && String(c[1]).startsWith("nl:imp:buy:") : c[0] === "HMGET" && String(c[1]).startsWith("nl:mv:"));
    let queued = false;
    let answered = false;
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (!queued && commands.some(queues(id))) {
        queued = true;
        throw new Error("synthetic failure between the write and the queue");
      }
      if (queued && !answered && commands.some(rereads)) {
        answered = true;
        return commands.map(() => [{ x: 1 }]);
      }
      return original(commands);
    };
    let held;
    try {
      held = await runImport(id, Date.now() + 30_000);
      held = await runImport(id, Date.now() + 30_000);
    } finally {
      restore();
    }
    is(`${kind}: the unknown reply was given`, answered, true);
    is(`${kind}: nothing counted or emailed, the import still running`, [held?.state, held?.done, held?.counts.added, held?.counts.already, sentTo(address, before)], ["running", 0, 0, 0, 0]);
    const after = await run(id);
    is(`${kind}: read again, added and emailed exactly once`, [after?.state, after?.counts.added, after?.counts.already, sentTo(address, before)], ["done", 1, 0, 1]);
  }

  for (const mode of ["missing claim reply", "unreadable row", "sparse invitation reply"] as const) {
    part(`An import retry waits for exact reads: ${mode}`);
    const address = `exact-retry-${mode.split(" ")[0]}@example.test`;
    const before = emails.length;
    store = await fresh();
    const id = mode === "sparse invitation reply"
      ? await members(store, OWNER, address, renews)
      : await purchases(store, OWNER, address);
    const seen = `nl:import:${id}:seen`;
    let queued = false;
    let injected = false;
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (!queued && commands.some(queues(id))) {
        queued = true;
        throw new Error("synthetic failure before queueing the mail");
      }
      const replies = await original(commands);
      if (!queued || injected) return replies;
      const slot = commands.findIndex(([command, key]) =>
        (mode === "missing claim reply" && command === "HSETNX" && key === seen)
        || (mode === "unreadable row" && command === "HMGET" && key === seen)
        || (mode === "sparse invitation reply" && command === "HMGET" && String(key).startsWith("nl:mv:")));
      if (slot === -1) return replies;
      injected = true;
      if (mode === "missing claim reply") delete replies[slot];
      else replies[slot] = mode === "unreadable row" ? ["not-a-row-number"] : Array(1);
      return replies;
    };
    let held;
    try {
      await runImport(id, Date.now() + 30_000);
      held = await runImport(id, Date.now() + 30_000);
    } finally {
      restore();
    }
    is("the reply reached the retry", injected, true);
    is("unknown evidence makes no progress and queues no email",
      [held?.state, held?.done, held?.counts.added, held?.counts.already, sentTo(address, before)],
      ["running", 0, 0, 0, 0]);
    const finished = await run(id);
    is("an exact retry counts and emails the row once",
      [finished?.state, finished?.counts.added, finished?.counts.already, sentTo(address, before)],
      ["done", 1, 0, 1]);
  }

  // The other branch of inviteMembers, without the erasure step (erased null): its record is an HSETNX, and its link
  // and reminder are a separate pipeline after it. Imports always pass the erasure step (lib/imports.ts), so no import
  // above reaches it; it is called here directly (Codex X6's LOW on #4008). The record is written, the link's SET fails,
  // and the same job tries again: the invitation answers as new, with its link under the record's own token.
  part("Members, the branch without the erasure step: the record is written, its link's SET fails, and the same job tries again");
  {
    const rows = [{ email: "direct@example.com", productId: club.product.id, option: "", renews: in20 }];
    const field = inviteField("direct@example.com", club.product.id);
    const failure = failOnce((c) => c[0] === "SET" && String(c[1]).startsWith("nl:mv:link:"));
    let first: unknown;
    try {
      first = await inviteMembers(store, "job-direct", rows).catch((error: unknown) => error);
    } finally {
      restore();
    }
    const written = await readInvite(store.statsId!, field);
    is("the failure came after the record, before its link", [failure.fired(), first instanceof Error, written?.job, written ? redis.run(["EXISTS", linkKey(written.t)]) : "no invitation"], [true, true, "job-direct", 0]);
    const again = await inviteMembers(store, "job-direct", rows);
    is("the same job's retry answers it as new", again, [field]);
    is("and sets its link under the record's own token", written ? redis.run(["EXISTS", linkKey(written.t)]) : "no invitation", 1);
    const other = await inviteMembers(store, "job-other", rows);
    is("control: another job finds it already invited", other, [null]);
  }

  part("Control: a member another import invited is still already, and not emailed again");
  {
    const before = emails.length;
    const id = await members(store, OWNER, "member@example.com", renews);
    const after = await run(id);
    is("already, never added, and nobody emailed", [after?.state, after?.counts.added, after?.counts.already, sentTo("member@example.com", before)], ["done", 0, 1, 0]);
  }
  // The cost line these reads are priced on (tests/plan-cost-registry.ts "imports"): every step at RETRY_OWN_READ_COMMANDS
  // and RETRY_OWN_READ_BYTES, each record at most a row's IMPORT_WORST_BYTES_PER_ROW. Measured on the two retries that
  // reach them: a purchases step failing between the grant and the queue, and a members step whose reply is lost.
  part("Cost: a step done again reads within its priced commands and bytes");
  {
    const buy = await measured(await purchases(store, OWNER, "cost-buyer@example.com"), (c) => c[0] === "SADD" && String(c[1]).startsWith("nl:import:") && String(c[1]).endsWith(":mail"));
    const most = Math.max(...buy.passes.map((p) => p.commands));
    is("purchases: the retry was reached, and read its own row", [buy.fired, buy.job?.state, buy.job?.counts.added, most > 0], [true, "done", 1, true]);
    is("purchases: no pass reads more than priced", buy.passes.every((p) => p.commands <= RETRY_OWN_READ_COMMANDS && p.bytes <= RETRY_OWN_READ_BYTES), true);
    store = await fresh();
    monthUnused(store.sid!);
    const join = await measured(await members(store, OWNER, "cost-member@example.com", renews), (c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:invite-unless-erased:"), true);
    const most2 = Math.max(...join.passes.map((p) => p.commands));
    is("members: the retry was reached, and read its own invitation", [join.fired, join.job?.state, join.job?.counts.added, most2], [true, "done", 1, INVITE_OWN_READ_COMMANDS]);
    is("members: no pass reads more than priced", join.passes.every((p) => p.commands <= INVITE_OWN_READ_COMMANDS && p.bytes <= RETRY_OWN_READ_BYTES), true);
    is("every record read is within a row's bytes", [buy.worstRecord > 0, join.worstRecord > 0, Math.max(buy.worstRecord, join.worstRecord) <= IMPORT_WORST_BYTES_PER_ROW], [true, true, true]);
  }

  done();
}

void main();
