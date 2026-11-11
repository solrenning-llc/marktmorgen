/**
 * Counters and counts read only in their exact shape (audit SG2, batch L4,
 * CX-123 rule 24).
 *
 * Each of these read a Redis reply with Number(), which turns null, a short
 * reply or a negative into a number that lets something through:
 *
 *   - inviteMember (lib/team.ts) read the day's INCR of team invitations as
 *     "under the limit" when it was null, missing, negative or text, and
 *     emailed the invitation. An unknown count is now "limited".
 *   - alertCreator and sendTest (lib/phone-alerts.ts) read the hour's quiet
 *     count and the minute's test count the same way, and sent a push. An
 *     unknown count now sends nothing; so does a "seen" mark (SET NX) that
 *     answered neither OK nor null.
 *   - buyerLedger and ledgerReadingUnits (lib/segments.ts) read a STRLEN or
 *     HLEN of null as an empty copy, counted as 0 units. An unknown size is
 *     now LedgerNotCounted, and nothing is read.
 *   - forgetDiscordPerson (lib/discord-access.ts) counted an unknown DEL as
 *     0 records removed in the erasure report. It now throws, so the report
 *     says the Discord part could not finish (lib/person-erasure.ts).
 *
 * The exact replies keep working as before.
 */
import { createECDH, randomBytes } from "node:crypto";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { inviteMember } from "@/lib/team";
import { addDevice, alertCreator, sendTest, setPhoneHooksForTests } from "@/lib/phone-alerts";
import { LedgerNotCounted, buyerLedger, ledgerReadingUnits } from "@/lib/segments";
import { forgetDiscordPerson } from "@/lib/discord-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

/** Every email handed to the stand-in Resend. */
const mails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const host = new URL(url).hostname;
  if (host === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    mails.push(Array.isArray(body.to) ? String(body.to[0]) : String(body.to ?? ""));
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (host === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** Every push the code tried: the push service's name is looked up, recorded here and refused, so nothing leaves. */
const pushes: string[] = [];
setPhoneHooksForTests({
  resolve: async (host: string) => {
    pushes.push(host);
    throw new Error("a stand-in that answers nothing");
  },
} as never);

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

/** "rejected: <name>" when the promise rejects, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

/** The pipeline that counts a limit: [SET key 0 EX n NX, INCR key] on a key starting with `prefix`. */
const counter = (prefix: string) => (commands: (string | number)[][]) =>
  commands.length === 2 && commands[1]?.[0] === "INCR" && String(commands[1]?.[1]).startsWith(prefix);
const only = (name: string, prefix: string) => (commands: (string | number)[][]) =>
  commands.length === 1 && commands[0]?.[0] === name && String(commands[0]?.[1]).startsWith(prefix);

/** Replies a limit's [SET NX, INCR] must never be read from. */
const BAD_COUNTERS: [string, unknown][] = [
  ["a count that is null", ["OK", null]],
  ["a count written as text", ["OK", "1"]],
  ["a fractional count", ["OK", 0.5]],
  ["a negative count", ["OK", -1]],
  ["a count that is an object", ["OK", { result: 1 }]],
  ["a count that is true", ["OK", true]],
  ["a reply missing the count", ["OK"]],
  ["a third, unasked-for reply", ["OK", 1, 1]],
  ["a reply that is not a list", { result: 1 }],
  ["a Redis that cannot be asked", "throw"],
];

/** Replies a one-command count (STRLEN, HLEN, DEL) must never be read from. */
const BAD_COUNTS: [string, unknown][] = [
  ["a count that is null", [null]],
  ["a count written as text", ["5"]],
  ["a fractional count", [0.5]],
  ["a negative count", [-1]],
  ["a count that is an object", [{ result: 1 }]],
  ["a count that is true", [true]],
  ["an empty reply", []],
  ["a second, unasked-for reply", [1, 1]],
  ["a reply that is not a list", { result: 1 }],
  ["a Redis that cannot be asked", "throw"],
];

async function shop(email: string, handle: string): Promise<Store> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await ensureListId(email);
  await setSubscription(email, { customerId: `cus_${handle.replace(/-/g, "")}`, subscriptionId: `sub_${handle.replace(/-/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(email))!;
}

function subscription(n: number) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/sg2-l4-${n}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

async function main(): Promise<void> {
  redis.clear();

  part("inviteMember: an invitation is emailed only on a whole count under the day's limit");
  {
    const owner = "sg2-l4-team@example.com";
    const store = await shop(owner, "sg2-l4-team");
    let n = 0;
    for (const [label, reply] of BAD_COUNTERS) {
      n += 1;
      rule = { when: counter("nl:rl:team-invite:"), reply };
      const before = mails.length;
      const got = await outcome(() => inviteMember(store, `helper${n}@sg2-l4.example`, "editor", "https://marktmorgen.com"));
      is(`inviteMember, ${label}: refused, never sent`, [typeof got === "string" ? "rejected" : got.ok ? "sent" : got.reason, mails.length - before], [reply === "throw" ? "rejected" : "limited", 0]);
    }
    rule = { when: counter("nl:rl:team-invite:"), reply: ["OK", 21] };
    is("inviteMember: one past the day's limit is limited, as before", await outcome(() => inviteMember(store, "past@sg2-l4.example", "editor", "https://marktmorgen.com")), { ok: false, reason: "limited" });
    rule = { when: counter("nl:rl:team-invite:"), reply: ["OK", 20] };
    const last = await inviteMember(store, "last@sg2-l4.example", "editor", "https://marktmorgen.com");
    is("inviteMember: the day's last one (20) is sent", [last.ok, mails.at(-1)], [true, "last@sg2-l4.example"]);
    rule = null;
    const real = await inviteMember(store, "real@sg2-l4.example", "editor", "https://marktmorgen.com");
    is("inviteMember: the real counter still sends", [real.ok, mails.at(-1)], [true, "real@sg2-l4.example"]);
  }

  part("phone sendTest: a test push is sent only on a whole count under the minute's limit");
  const owner = "sg2-l4-phone@example.com";
  const phoneStore = await shop(owner, "sg2-l4-phone");
  const added = await addDevice(phoneStore, owner, "owner", subscription(1), ["report"], "Test", Date.now() - 1000);
  if (!added.ok) throw new Error(`the synthetic device was not added: ${added.reason}`);
  for (const [label, reply] of BAD_COUNTERS) {
    rule = { when: counter("nl:rl:phone:test:"), reply };
    const before = pushes.length;
    const got = await outcome(() => sendTest(phoneStore, owner, "owner", added.id));
    is(`phone sendTest, ${label}: refused, nothing pushed`, [typeof got === "string" ? "rejected" : got.ok ? "sent" : got.reason, pushes.length - before], [reply === "throw" ? "rejected" : "limited", 0]);
  }
  rule = { when: counter("nl:rl:phone:test:"), reply: ["OK", 7] };
  is("phone sendTest: one past the minute's limit is limited, as before", await outcome(() => sendTest(phoneStore, owner, "owner", added.id)), { ok: false, reason: "limited" });
  rule = { when: counter("nl:rl:phone:test:"), reply: ["OK", 6] };
  {
    const before = pushes.length;
    const got = await sendTest(phoneStore, owner, "owner", added.id);
    is("phone sendTest: the minute's last one (6) is tried", [got.ok, pushes.length - before], [true, 1]);
  }
  rule = null;
  {
    const before = pushes.length;
    const got = await sendTest(phoneStore, owner, "owner", added.id);
    is("phone sendTest: the real counter still tries it", [got.ok, pushes.length - before], [true, 1]);
  }

  part("phone alertCreator: a quiet event is pushed only on a whole count under the hour's limit");
  const alert = { title: "A report", body: "Someone reported a comment.", url: "/studio" };
  let seed = 0;
  for (const [label, reply] of BAD_COUNTERS) {
    rule = { when: counter("nl:rl:phone:quiet:"), reply };
    const before = pushes.length;
    seed += 1;
    const got = await outcome(() => alertCreator(phoneStore, "report", alert, { seed: `quiet-${seed}` }));
    is(`alertCreator, ${label}: nothing pushed`, [got === "rejected: Error" ? "rejected" : got, pushes.length - before], [reply === "throw" ? "rejected" : 0, 0]);
  }
  for (const [label, reply] of [["an unknown answer", ["1"]], ["an empty reply", []], ["a list of two", ["OK", "OK"]], ["a Redis that cannot be asked", "throw"]] as [string, unknown][]) {
    rule = { when: only("SET", "nl:phone:seen:"), reply };
    const before = pushes.length;
    seed += 1;
    const got = await outcome(() => alertCreator(phoneStore, "report", alert, { seed: `seen-${seed}` }));
    is(`alertCreator, the "seen" mark answered ${label}: nothing pushed`, [got === "rejected: Error" ? "rejected" : got, pushes.length - before], [reply === "throw" ? "rejected" : 0, 0]);
  }
  rule = { when: only("SET", "nl:phone:seen:"), reply: [null] };
  is("alertCreator: an event already seen (null) is not pushed again, as before", await alertCreator(phoneStore, "report", alert, { seed: "seen-again" }), 0);
  rule = { when: counter("nl:rl:phone:quiet:"), reply: ["OK", 21] };
  {
    const before = pushes.length;
    is("alertCreator: one past the hour's limit is not pushed, as before", [await alertCreator(phoneStore, "report", alert, { seed: "past" }), pushes.length - before], [0, 0]);
  }
  rule = { when: counter("nl:rl:phone:quiet:"), reply: ["OK", 20] };
  {
    const before = pushes.length;
    is("alertCreator: the hour's last one (20) is pushed", [await alertCreator(phoneStore, "report", alert, { seed: "last" }), pushes.length - before], [1, 1]);
  }
  rule = null;
  {
    const before = pushes.length;
    is("alertCreator: the real counter still pushes", [await alertCreator(phoneStore, "report", alert, { seed: "real" }), pushes.length - before], [1, 1]);
  }

  part("buyerLedger: the buyers' copy is read and counted only on a whole size");
  const ledgerOwner = "sg2-l4-ledger@example.com";
  const ledgerStore: Store = { ...(await shop(ledgerOwner, "sg2-l4-ledger")), pastBuyers: true } as Store;
  const counted: number[] = [];
  const count = async (units: number) => {
    counted.push(units);
    return true;
  };
  for (const [label, reply] of BAD_COUNTS) {
    rule = { when: only("STRLEN", "nl:"), reply };
    is(`buyerLedger, the copy's size is ${label}: not counted, nothing read`, await outcome(() => buyerLedger(ledgerStore, count)), reply === "throw" ? "rejected: Error" : "rejected: LedgerNotCounted");
  }
  for (const [label, reply] of BAD_COUNTS) {
    rule = { when: only("HLEN", "nl:"), reply };
    is(`buyerLedger, the imported buyers' count is ${label}: not counted, nothing read`, await outcome(() => buyerLedger(ledgerStore, count)), reply === "throw" ? "rejected: Error" : "rejected: LedgerNotCounted");
  }
  rule = { when: only("STRLEN", "nl:"), reply: [0] };
  is("buyerLedger: no copy kept (0) is read from the sales, as before", (await outcome(() => buyerLedger(ledgerStore, count))) instanceof Object, true);
  rule = null;
  is("buyerLedger: the real reading still answers", (await outcome(() => buyerLedger(ledgerStore, count))) instanceof Object, true);
  is("LedgerNotCounted is the error the callers already handle", new LedgerNotCounted().name, "LedgerNotCounted");

  part("ledgerReadingUnits: what a reading costs is measured only on whole sizes");
  const pair = (commands: (string | number)[][]) => commands.length === 2 && commands[0]?.[0] === "STRLEN" && commands[1]?.[0] === "HLEN";
  for (const [label, reply] of [
    ["a size that is null", [null, 0]],
    ["a size written as text", ["5", 0]],
    ["a count written as text", [0, "5"]],
    ["a fractional size", [0.5, 0]],
    ["a negative count", [0, -1]],
    ["a size that is true", [true, 0]],
    ["a reply missing the count", [0]],
    ["a third, unasked-for reply", [0, 0, 0]],
  ] as [string, unknown][]) {
    rule = { when: pair, reply };
    is(`ledgerReadingUnits, ${label}: not counted`, await outcome(() => ledgerReadingUnits(ledgerStore)), "rejected: LedgerNotCounted");
  }
  rule = { when: pair, reply: [0, 0] };
  is("ledgerReadingUnits: nothing kept still measures", typeof (await outcome(() => ledgerReadingUnits(ledgerStore))), "number");

  part("forgetDiscordPerson: the records removed are counted only on a whole DEL count");
  const discordStore = await shop("sg2-l4-discord@example.com", "sg2-l4-discord");
  for (const [label, reply] of BAD_COUNTS) {
    rule = { when: only("DEL", "nl:"), reply };
    is(`forgetDiscordPerson, ${label}: said as unknown, never as 0 removed`, await outcome(() => forgetDiscordPerson(discordStore, "buyer@sg2-l4.example", ["p_one", "p_two"])), reply === "throw" ? "rejected: Error" : "rejected: UnknownReplyError");
  }
  rule = { when: only("DEL", "nl:"), reply: [2] };
  is("forgetDiscordPerson: two removed are counted as two", await forgetDiscordPerson(discordStore, "buyer@sg2-l4.example", ["p_one", "p_two"]), { records: 2, rolesLeft: false });
  rule = { when: only("DEL", "nl:"), reply: [0] };
  is("forgetDiscordPerson: none there is counted as none", await forgetDiscordPerson(discordStore, "buyer@sg2-l4.example", ["p_one", "p_two"]), { records: 0, rolesLeft: false });
  rule = null;
  is("forgetDiscordPerson: the real DEL still counts", await forgetDiscordPerson(discordStore, "buyer@sg2-l4.example", ["p_one"]), { records: 0, rolesLeft: false });
  is("UnknownReplyError is the shape error the erasure runner reports as not finished", new UnknownReplyError("x").name, "UnknownReplyError");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
