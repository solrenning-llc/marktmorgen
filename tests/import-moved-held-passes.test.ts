/**
 * A member's reminder held because the creator's postal address is missing (review of #3476, Claude 7's cost MEDIUM 1):
 * it is checked before any other read, tried again once a day rather than every hour while the renewal date is still
 * more than a day away, at most MOVE_HELD_PASSES passes an invitation, each at most MOVE_HELD_PASS_COMMANDS commands,
 * and the imports cost line prices them on every moved email (tests/plan-cost-registry.ts, MOVED_EMAIL_COMMANDS_PRICED).
 * A creator who saves the address again before the renewal date still has the reminder sent (review of #3476, LOW 2).
 * Synthetic only: Stripe and the sender are stand-ins for fetch, Redis is lib/redis-memory.ts.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { MOVED_EMAIL_EXTRA_COMMANDS, MOVE_HELD_PASSES, MOVE_HELD_PASS_COMMANDS, addRows, finishUpload, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { REMIND_DAYS_BEFORE } from "@/lib/move-rules";
import { MOVED_EMAIL_COMMANDS_PRICED } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const HOUR = 3_600;
const POSTAL = "12 Harbor Lane, Portland, ME 04101, USA";
type Sent = { to: string | string[]; text: string };
const emails: Sent[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com" && url.pathname.startsWith("/emails")) {
    const body = JSON.parse(String(init?.body)) as Sent | Sent[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one);
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const original = redis.pipeline.bind(redis);
async function recorded<T>(run: () => Promise<T>): Promise<{ result: T; commands: (string | number)[][] }> {
  const commands: (string | number)[][] = [];
  redis.pipeline = async (batch: (string | number)[][]) => {
    commands.push(...batch);
    return original(batch);
  };
  try {
    return { result: await run(), commands };
  } finally {
    redis.pipeline = original;
  }
}
/** A pass that handled the reminder reads its invitation (readInvite, one HGET); a run with nothing due reads only the line. */
const handled = (commands: (string | number)[][]) => commands.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:mv:"));
const GUARD_READS = (c: (string | number)[]) =>
  (c[0] === "HMGET" && (String(c[1]).startsWith("nl:erased:") || String(c[1]).startsWith("nl:store:leads:"))) || (c[0] === "EXISTS" && String(c[1]).startsWith("nl:recover:off:"));

async function setup(handle: string, owner: string, member: string, renews: number) {
  await claimHandle(owner, handle, "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setMailSettings(owner, { fromName: "Harbor Kitchen", address: POSTAL });
  await setStripeAccount(owner, `acct_${handle}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, period: paidPeriod() });
  const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  const store = (await storeForEmail(owner))!;
  const m = await startImport(store, owner, "members", { expected: 1, file: "patrons.csv", stopped: true });
  if (!m.ok) throw new Error(`members not started: ${m.reason}`);
  await addRows(store, m.job.id, [["2", member, "The Inner Circle", new Date(renews * 1000).toISOString().slice(0, 10), ""]]);
  await finishUpload(store, m.job.id);
  for (let i = 0; i < 10; i += 1) if ((await runImport(m.job.id, Date.now() + 30_000))?.state === "done") break;
  is(`control (${handle}): the member's first email went`, emails.filter((e) => [e.to].flat()[0] === member).length, 1);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();
  // The renewal date at noon UTC, so the date the row carries is the one the reminder is timed from.
  const noon = (s: number) => Math.floor(s / DAY) * DAY + 12 * HOUR;
  const renews = noon(Math.floor(Date.now() / 1000) + 20 * DAY);

  part("No postal address until the renewal date: few passes, each small, none reading the guards");
  const OWNER = "held-owner@example.com";
  const member = "fern@example.com";
  await setup("heldshop", OWNER, member, renews);
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "" });
  const before = emails.length;
  const passes: (string | number)[][][] = [];
  // Every hour from four days before the renewal date to a day after it, as the five-minute job would find it due.
  for (let at = renews - (REMIND_DAYS_BEFORE + 1) * DAY; at <= renews + DAY; at += HOUR) {
    const run = await recorded(() => sendMoveReminders(Date.now() + 30_000, at * 1000));
    if (handled(run.commands)) passes.push(run.commands);
  }
  is("nothing is sent without the postal address", emails.length - before, 0);
  is(`held at most MOVE_HELD_PASSES (${MOVE_HELD_PASSES}) times, not every hour`, passes.length >= 1 && passes.length <= MOVE_HELD_PASSES, true);
  is("each held pass within MOVE_HELD_PASS_COMMANDS", passes.map((p) => p.length <= MOVE_HELD_PASS_COMMANDS), passes.map(() => true));
  is("no held pass reads the deleted people, the list's rows or the stop mark", passes.map((p) => p.filter(GUARD_READS).length), passes.map(() => 0));
  is("MOVE_HELD_PASSES is the reminder's days before the renewal date", MOVE_HELD_PASSES, REMIND_DAYS_BEFORE);
  is(
    "the imports line prices every moved email with its held passes",
    MOVED_EMAIL_COMMANDS_PRICED,
    MOVED_EMAIL_EXTRA_COMMANDS + MOVE_HELD_PASSES * MOVE_HELD_PASS_COMMANDS,
  );
  const worst = passes.reduce((m, p) => Math.max(m, p.length), 0);
  is("what the passes cost is inside what is priced", MOVED_EMAIL_EXTRA_COMMANDS + passes.length * worst <= MOVED_EMAIL_COMMANDS_PRICED, true);

  part("The address saved again before the renewal date: the reminder still goes, once");
  const OWNER2 = "back-owner@example.com";
  const member2 = "reed@example.com";
  await setup("backshop", OWNER2, member2, renews);
  await setMailSettings(OWNER2, { fromName: "Harbor Kitchen", address: "" });
  const first = await recorded(() => sendMoveReminders(Date.now() + 30_000, (renews - REMIND_DAYS_BEFORE * DAY + 60) * 1000));
  is("control: the first due pass holds it", [handled(first.commands), first.result.sent], [true, 0]);
  await setMailSettings(OWNER2, { fromName: "Harbor Kitchen", address: POSTAL });
  let sent = 0;
  for (let at = renews - REMIND_DAYS_BEFORE * DAY + HOUR; at <= renews; at += HOUR) sent += (await sendMoveReminders(Date.now() + 30_000, at * 1000)).sent;
  is("sent once after the address is back", [sent, emails.filter((e) => [e.to].flat()[0] === member2).length], [1, 2]);
  done();
}

void main();
