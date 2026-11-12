/**
 * A past buyers' or members' import step that failed after its writes and before its emails were queued, retried,
 * still emails the people it brought over (issue #3957; synthetic only, Stripe and the sender are stand-ins for fetch).
 *
 * runImport redoes a step from its last saved place when any command of the step fails. The grant (or invitation)
 * written the first time answers "already" on the retry; taken at its word, nobody was queued for the email the
 * creator asked for and the report said "already" for people this very import brought over. A record written by this
 * same import is its own earlier write: the retry counts it as added and queues its email, and a member's link and
 * reminder are written again so the emailed link works. A record from another import or an earlier gift is still
 * "already" and is not emailed.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addRows, finishUpload, runImport, startImport } from "@/lib/imports";
import { importedFor } from "@/lib/imported-purchases";
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
const sentTo = (address: string, from = 0) => emails.slice(from).filter((e) => to(e) === address);

async function run(id: string) {
  let job = await runImport(id, Date.now() + 30_000);
  for (let i = 0; i < 10 && job && job.state !== "done"; i += 1) job = await runImport(id, Date.now() + 30_000);
  return job;
}

const original = redis.pipeline.bind(redis);
/** Throws once, instead of running it, the first pipeline holding a command that matches `at`. */
function failOnce(at: (c: (string | number)[]) => boolean) {
  let fired = false;
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (!fired && commands.some(at)) {
      fired = true;
      throw new Error("synthetic pipeline failure");
    }
    return original(commands);
  };
  return () => fired;
}
const restore = () => {
  redis.pipeline = original;
};
const queuesMail = (c: (string | number)[]) => c[0] === "SADD" && String(c[1]).endsWith(":mail");

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
}

/** The months' counts of emails to people brought over, cleared, so each import starts from an unused month. */
function monthUnused(sid: string) {
  for (const key of (redis.run(["SCAN", "0", "MATCH", `nl:imports:moved:${sid}:*`]) as [string, string[]])[1]) redis.run(["DEL", key]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();
  const OWNER = "retry-owner@example.com";
  await openStore(OWNER, "retryshop", "acct_1TestRetry00001", "RetryOwner1");
  const fresh = async () => (await storeForEmail(OWNER))!;
  let store = await fresh();
  const renews = new Date((Math.floor(Date.now() / 1000) + 20 * DAY) * 1000).toISOString().slice(0, 10);

  part("A past buyer already given the product by an earlier import");
  {
    const first = await startImport(store, OWNER, "purchases", { expected: 1, file: "old.csv", email: false });
    if (!first.ok) throw new Error(`not started: ${first.reason}`);
    await addRows(store, first.job.id, [["2", "earlier@example.com", "The Guide", "Paid"]]);
    await finishUpload(store, first.job.id);
    const j = await run(first.job.id);
    is("setup: given, not emailed", [j?.state, j?.counts.added, sentTo("earlier@example.com").length], ["done", 1, 0]);
  }

  part("The past buyers' step fails after the grant and before the email is queued, then is retried");
  {
    store = await fresh();
    const p = await startImport(store, OWNER, "purchases", { expected: 2, file: "orders.csv", email: true });
    if (!p.ok) throw new Error(`not started: ${p.reason}`);
    await addRows(store, p.job.id, [["2", "buyer@example.com", "The Guide", "Paid"], ["3", "earlier@example.com", "The Guide", "Paid"]]);
    await finishUpload(store, p.job.id);
    const before = emails.length;
    const fired = failOnce(queuesMail);
    let job;
    try {
      job = await run(p.job.id);
    } finally {
      restore();
    }
    is("the synthetic failure happened", fired(), true);
    store = await fresh();
    is("the buyer has the product", (await importedFor(store, "buyer@example.com")).length, 1);
    is(
      "the retried step counts the buyer as added and sends the email the creator asked for",
      [job?.state, job?.counts.added, job?.counts.already, job?.counts.mailed, sentTo("buyer@example.com", before).length],
      ["done", 1, 1, 1, 1],
    );
    is("the buyer given it by another import is still 'already' and not emailed", sentTo("earlier@example.com", before).length, 0);
  }

  part("The members' step fails after the invitation and before the email is queued, then is retried");
  {
    store = await fresh();
    monthUnused(store.sid);
    const m = await startImport(store, OWNER, "members", { expected: 1, file: "patrons.csv", stopped: true });
    if (!m.ok) throw new Error(`not started: ${m.reason}`);
    await addRows(store, m.job.id, [["2", "member@example.com", "The Inner Circle", renews, ""]]);
    await finishUpload(store, m.job.id);
    const before = emails.length;
    const fired = failOnce(queuesMail);
    let job;
    try {
      job = await run(m.job.id);
    } finally {
      restore();
    }
    is("the synthetic failure happened", fired(), true);
    is("the retried step counts the member as added and emails their link", [job?.state, job?.counts.added, job?.counts.already, sentTo("member@example.com", before).length], ["done", 1, 0, 1]);
  }

  part("The members' step fails after the invitation and before its link is written, then is retried");
  {
    store = await fresh();
    monthUnused(store.sid);
    const m = await startImport(store, OWNER, "members", { expected: 1, file: "patrons2.csv", stopped: true });
    if (!m.ok) throw new Error(`not started: ${m.reason}`);
    await addRows(store, m.job.id, [["2", "linked@example.com", "The Inner Circle", renews, ""]]);
    await finishUpload(store, m.job.id);
    const before = emails.length;
    const fired = failOnce((c) => c[0] === "SET" && String(c[1]).startsWith("nl:mv:link:"));
    let job;
    try {
      job = await run(m.job.id);
    } finally {
      restore();
    }
    is("the synthetic failure happened", fired(), true);
    const sent = sentTo("linked@example.com", before);
    is("the retried step counts the member as added and emails their link", [job?.state, job?.counts.added, sent.length], ["done", 1, 1]);
    const token = /[?&]k=([0-9a-f]{40})/.exec(sent[0]?.text ?? "")?.[1] ?? "";
    is("the emailed link works: its token is kept", token !== "" && redis.run(["EXISTS", `nl:mv:link:${token}`]), 1);
  }

  done();
}

void main();
