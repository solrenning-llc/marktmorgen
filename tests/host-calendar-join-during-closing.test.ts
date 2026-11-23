/**
 * #5010 row 105 (Codex L-20261119-0659, MEDIUM, erasure): a closing store's host who joins another live store while
 * the closing walk decides their own calendar keeps it. The walk asked whether the host serves another store
 * (servesAnother: their team index, each store's team and record, the stores they own) and deleted their calendar's
 * keys in a later, separate command, so a join that landed in between lost the host's private calendar settings on the
 * store they had just joined. Three places:
 *
 * 1. prepareStore put the calendar's keys in the closing store's own deletes (forgetLive), run much later than the read;
 * 2. decideCalendars (a host not known at the preparation, read again before the store is finished) sent a plain DEL;
 * 3. spendInvite (lib/team.ts) wrote the new member into the team before their team index, outside the team's lock, so
 *    a read between the two saw the team listing them and an index that did not: "no other store".
 *
 * Now every host is decided before the store is finished, by one Redis step that deletes the calendar only if what the
 * decision read has not changed since (the team index, each of its stores' teams and records, the first store and the
 * account's set and records), and spendInvite writes the index first, under the team's lock.
 *
 * Synthetic only: the in-memory Redis double and a stand-in for the email provider. Nothing real is sent.
 */
import { BATCH_KEY, WALK_GAP_MS, WALK_KEY, eraseClosed, markDue } from "@/lib/closed-store-data";
import { hostCalendarKeys } from "@/lib/host-calendar";
import { hostId } from "@/lib/host-claims";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMember, putMember, readTeam, servingKeys, spendInvite } from "@/lib/team";
import { paidPeriod } from "./billing-period-fixture";
import { closeForErasure } from "./closed-for-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { SERVED_COMMANDS, SERVING_READ_COMMANDS, SERVING_RECHECK_COMMANDS } from "./plan-cost-registry";
import { MEMBER_STORES_READ, TEAM_JOIN, TEAM_JOIN_CALLS } from "@/lib/team";
import { createHash } from "node:crypto";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
// An exact literal already known to tests/resend-fixture-credentials.ts, so no shared list is edited (AC (d)).
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const host = new URL(String(input instanceof Request ? input.url : input)).hostname;
  if (host === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (host === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const tokenTo = (to: string) => /\/signin\/join\?token=([0-9a-f]{64})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";

type Command = (string | number)[];
const realPipeline = redis.pipeline.bind(redis);

/** The closing store's owner, a host whose own calendar is decided. */
const HOST = "host@calendarjoin.example";
/** The owner of a live store that invited the host. */
const LIVE = "live@calendarjoin.example";
const calendarOf = (email: string) => hostCalendarKeys(hostId(email));
const calendarKept = (email: string) => calendarOf(email).map((key) => redis.run(["EXISTS", key]));
const batchLeft = () => redis.run(["HLEN", BATCH_KEY]);
const walkTime = (at: number, k: number) => at + k * (WALK_GAP_MS + 60_000);
const walkAt = async (at: number) => (await eraseClosed(Date.now() + 60_000, async () => {}, at)).stores;

/** A batch that writes or deletes one of the host's calendar keys (a DEL, or a script naming one). */
const touchesCalendar = (commands: Command[]) => {
  const keys = new Set(calendarOf(HOST));
  return commands.some((command) => (command[0] === "DEL" || command[0] === "EVAL") && command.some((arg) => typeof arg === "string" && keys.has(arg)));
};

/** Runs `before` once, just ahead of the first batch `when` picks, then lets that batch through. */
function aheadOf(when: (commands: Command[]) => boolean, before: () => Promise<unknown>): void {
  redis.pipeline = (async (commands: Command[]) => {
    if (when(commands)) {
      redis.pipeline = realPipeline;
      await before();
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
}

/**
 * A fresh database: the live store, paid, that has invited the host (the token of its emailed link answered), and the
 * host's own store closed and in line for the walk, with the host's calendar written. The host serves no other store.
 */
async function setUp(): Promise<{ at: number; token: string; liveSid: string }> {
  redis.clear();
  redis.pipeline = realPipeline;
  mails.length = 0;
  redis.run(["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", 1, "finished", 1]);
  await claimHandle(LIVE, "calendarjoinlive", "Calendar Join Live", "");
  await ensureStatsId(LIVE);
  await ensureStoreId(LIVE);
  await ensureListId(LIVE);
  await setStripeAccount(LIVE, "acct_1CalendarJoinXX", true);
  await setSubscription(LIVE, { customerId: "cus_calendarjoin", subscriptionId: "sub_calendarjoin", active: true, tier: "creator", period: paidPeriod() });
  const live = (await storeForEmail(LIVE))!;
  const invited = await inviteMember(live, HOST, "editor", "https://marktmorgen.com");
  if (!invited.ok) throw new Error(`setup: the host was not invited (${JSON.stringify(invited)})`);
  const token = tokenTo(HOST);
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("setup: the invitation email carries no link");
  await claimHandle(HOST, "calendarjoinhost", "Calendar Join Host", "");
  await ensureStoreId(HOST);
  await closeForErasure(HOST);
  for (const key of calendarOf(HOST)) redis.run(["SET", key, "test"]);
  const at = Date.now();
  await markDue(HOST, at - 1000);
  return { at, token, liveSid: live.sid };
}

/** The host is on the live store's team now. */
async function joined(liveSid: string): Promise<boolean> {
  return (await readTeam(liveSid)).members.some((m) => m.email === HOST);
}

async function main(): Promise<void> {
  part("1. The host joins a live store while the walk prepares their closing store: their calendar is kept");
  {
    const { at, token, liveSid } = await setUp();
    aheadOf(touchesCalendar, async () => {
      const result = await spendInvite(token);
      if (!result.ok) throw new Error(`the host's join was refused (${JSON.stringify(result)})`);
    });
    await walkAt(walkTime(at, 0));
    redis.pipeline = realPipeline;
    is("the host joined the live store meanwhile", await joined(liveSid), true);
    for (let k = 1; k <= 3; k += 1) await walkAt(walkTime(at, k));
    is("the host serves the live store, so their own calendar is kept", calendarKept(HOST), [1, 1, 1, 1]);
    is("... and the closing store is out of the walk's batch once that is known", batchLeft(), 0);
  }

  part("2. A host not known at the preparation, decided again later, joins a live store as it is decided: kept");
  {
    const { at, token, liveSid } = await setUp();
    // The host's team index answers in a shape that is not a list for the whole first walk, so the preparation keeps
    // their calendar and leaves them to be decided again before the store is finished (decideCalendars).
    redis.pipeline = (async (commands: Command[]) => {
      const real = await realPipeline(commands);
      return real.map((reply: unknown, i: number) => (commands[i][0] === "SMEMBERS" && String(commands[i][1]).startsWith("nl:team:of:") ? "ERR synthetic transient" : reply));
    }) as typeof redis.pipeline;
    await walkAt(walkTime(at, 0));
    redis.pipeline = realPipeline;
    is("the first walk keeps the calendar while the host is not known", [calendarKept(HOST), batchLeft()], [[1, 1, 1, 1], 1]);
    aheadOf(touchesCalendar, async () => {
      const result = await spendInvite(token);
      if (!result.ok) throw new Error(`the host's join was refused (${JSON.stringify(result)})`);
    });
    await walkAt(walkTime(at, 1));
    redis.pipeline = realPipeline;
    is("the host joined the live store meanwhile", await joined(liveSid), true);
    for (let k = 2; k <= 4; k += 1) await walkAt(walkTime(at, k));
    is("the host serves the live store, so their own calendar is kept", calendarKept(HOST), [1, 1, 1, 1]);
    is("... and the closing store leaves the batch once that is known", batchLeft(), 0);
  }

  part("3. The walk reads the host right after the first of their join's writes lands: their calendar is kept");
  {
    const { at, token, liveSid } = await setUp();
    const teamKey = `nl:team:${liveSid}`;
    const indexKey = servingKeys(HOST).index;
    // Right after the join's first write of the host's index or of the team that lists them lands, the whole walk runs,
    // before the join's next command: what a walk reading the host at that moment decides. Two writes in either order
    // leave a moment with one and not the other (Claude 4's MEDIUM on #5280: the SADD first, then the walk read an index
    // naming the live store and a team not listing the host); one step leaves none.
    let armed = true;
    let walked = false;
    let saved = false;
    redis.pipeline = (async (commands: Command[]) => {
      if (armed && saved) {
        armed = false;
        redis.pipeline = realPipeline;
        for (let k = 0; k <= 3; k += 1) await walkAt(walkTime(at, k));
        walked = true;
      }
      const real = await realPipeline(commands);
      const writesJoin = (c: Command) =>
        (c[0] === "SET" && c[1] === teamKey && String(c[2]).includes(HOST)) ||
        (c[0] === "SADD" && c[1] === indexKey && c[2] === liveSid) ||
        (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:team-join:") && c.includes(teamKey) && c.includes(indexKey));
      if (commands.some(writesJoin)) saved = true;
      return real;
    }) as typeof redis.pipeline;
    const result = await spendInvite(token);
    redis.pipeline = realPipeline;
    if (!result.ok) throw new Error(`the host's join was refused (${JSON.stringify(result)})`);
    is("the walk ran right after the join's first write", walked, true);
    is("the host joined the live store", await joined(liveSid), true);
    is("the host serves the live store, so their own calendar is kept", calendarKept(HOST), [1, 1, 1, 1]);
  }

  part("Control: a host who serves no other store loses their calendar with their last store, as before");
  {
    const { at } = await setUp();
    for (let k = 0; k <= 3; k += 1) await walkAt(walkTime(at, k));
    is("the calendar goes and the store leaves the batch", [calendarKept(HOST), batchLeft()], [[0, 0, 0, 0], 0]);
  }

  part("Control: a teammate on another live store before the closing keeps their calendar, as before");
  {
    const { at, liveSid } = await setUp();
    const live = (await storeForEmail(LIVE))!;
    if (!(await putMember(live, HOST, "editor"))) throw new Error("setup: the host is not on the live store's team");
    for (let k = 0; k <= 3; k += 1) await walkAt(walkTime(at, k));
    is("the calendar stays and the store leaves the batch", [await joined(liveSid), calendarKept(HOST), batchLeft()], [true, [1, 1, 1, 1], 0]);
  }

  part("Cost (rule 964c): a join's one step is billed as its EVAL and the calls inside it");
  is("TEAM_JOIN makes exactly TEAM_JOIN_CALLS redis.call (its SADD and its SET)", (TEAM_JOIN.match(/redis\.call\(/g) ?? []).length, TEAM_JOIN_CALLS);

  part("Cost (rule 964c): one host's decision, at the most the registry prices it");
  {
    const { at } = await setUp();
    // The host's team index full to what is read (MEMBER_STORES_READ ids, each a store id with no team), so each of
    // them is read by what decides it, by servesAnother and again by the recheck.
    const index = `nl:team:of:${createHash("sha256").update(`nimbus-team-of:${HOST}`).digest("hex").slice(0, 40)}`;
    for (let i = 0; i < MEMBER_STORES_READ; i += 1) redis.run(["SADD", index, createHash("md5").update(`full-index-${i}`).digest("hex")]);
    let counting = false;
    let sent = 0;
    let inner = 0;
    let rechecks = 0;
    redis.pipeline = (async (commands: Command[]) => {
      // From what decides the host, read first (its first command is the index's SMEMBERS), to the recheck's answer.
      if (!counting && commands.some((c) => c[0] === "SMEMBERS" && c[1] === index)) counting = true;
      const before = redis.scriptCalls;
      const real = await realPipeline(commands);
      if (counting) {
        sent += commands.length;
        inner += redis.scriptCalls - before;
        if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:host-calendar-del-if-unchanged:"))) {
          rechecks += 1;
          counting = false;
        }
      }
      return real;
    }) as typeof redis.pipeline;
    for (let k = 0; k <= 3; k += 1) await walkAt(walkTime(at, k));
    redis.pipeline = realPipeline;
    const priced = SERVING_READ_COMMANDS + SERVED_COMMANDS + SERVING_RECHECK_COMMANDS;
    is("the host is decided once, with one recheck, and their calendar goes", [rechecks, calendarKept(HOST), batchLeft()], [1, [0, 0, 0, 0], 0]);
    is(`its commands, inner calls counted, are within what the registry prices for one host (${priced})`, [sent + inner <= priced, sent + inner > 2 * MEMBER_STORES_READ], [true, true]);
    console.log(`one host's decision with a full index: ${sent} sent and ${inner} inside the recheck, ${sent + inner} of ${priced} priced`);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
