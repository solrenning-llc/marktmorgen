/**
 * R19 MEDIUM 2 (Claude 6's access audit, 9 November 2026): the copy of a
 * person's data (619 [SZ3], lib/person-copy.ts) read their payment requests
 * from the store's list, only its newest N (the plan's kept figure, 20 once
 * the plan ended), and kept those addressed to them. A request is kept
 * KEEP_DAYS (400), so an older one of theirs was left out of their copy, and
 * the copy said nothing about it.
 *
 * Now the copy reads the person's own set (nl:payreq:p:<sid>:<person>), the
 * same index the erasure deletes by, whole: its size is read before anything
 * else, so a set past the most a store keeps is refused before a record is
 * read; then a page of members at a time, orphans (records gone) skipped
 * however many; any reply that does not read exactly fails the copy, never a
 * copy handed over with a part silently missing.
 */
import { personKey } from "@/lib/person-key";
import { KEEP_DAYS, MAX_PER_PERSON, type PaymentRequest } from "@/lib/payment-request-rules";
import { COPY_MEMBERS_MAX, COPY_PAGE_MEMBERS, COPY_PAGES_MAX, COPY_READ_COMMANDS_MAX, createRequest, forgetRequestsPerson, readRequest } from "@/lib/payment-request-store";
import { COPIERS } from "@/lib/person-copy";
import { erasureScope } from "@/lib/person-erasure";
import { NOT_A_COST } from "./plan-cost-registry";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const OWNER = "copy-whole-owner@example.com";
const TESS = "tess.copy@example.com";
const copier = COPIERS["lib/payment-request-store.ts"];

const hex = (n: number, salt: string) => (salt + n.toString(16)).padStart(32, "0").slice(-32);

/** One request as createRequest keeps it: its record, the store's list, the person's set. */
async function seed(sid: string, email: string, id: string, createdAt: number, state: PaymentRequest["state"] = "paid"): Promise<PaymentRequest> {
  const request: PaymentRequest = {
    id, sid, email, name: "Synthetic", lines: [{ text: "Synthetic work", quantity: 1, cents: 1_000 }], note: "", currency: "usd" as PaymentRequest["currency"],
    total: 1_000, createdAt, dueDate: "", expiresAt: createdAt + 30 * DAY, state, autoReminders: 0, sent: [createdAt], failed: "",
    session: "", sessionAt: 0, paidAt: state === "paid" ? createdAt + DAY : 0, amountPaid: state === "paid" ? 1_000 : 0, payment: "", refunded: 0, closedAt: 0,
  };
  await redis.pipeline([
    ["SET", `nl:payreq:r:${id}`, JSON.stringify(request), "EX", Math.ceil((createdAt + KEEP_DAYS * DAY - Date.now()) / 1000)],
    ["ZADD", `nl:payreq:s:${sid}`, String(createdAt), id],
    ["SADD", `nl:payreq:p:${sid}:${personKey(sid, email)}`, id],
  ]);
  return request;
}

const ids = (list: unknown[]) => (list as PaymentRequest[]).map((r) => r.id).sort();
const threw = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "returned";
  } catch {
    return "threw";
  }
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "copywhole", "Copy whole", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_copywhole01", true);
  const paid = await setSubscription(OWNER, { customerId: "cus_copywhole", subscriptionId: "sub_copywhole", active: true, tier: "creator", period: paidPeriod() });
  if (!paid?.subscriptionActive) throw new Error("synthetic paid plan not accepted");
  let store = (await storeForEmail(OWNER))!;
  const sid = store.sid;
  const now = Date.now();

  part("An older request of theirs is in their copy, however many newer the store keeps");
  // Tess's request, made the real way, 300 days ago (kept 400).
  const made = await createRequest(store, { email: TESS, name: "Tess", lines: [{ text: "Coaching, January", quantity: 1, cents: 48_000 }], note: "", dueDate: "", autoReminders: 0, total: 48_000 }, now - 300 * DAY);
  if (!made.ok) throw new Error(`Tess's request was not kept: ${made.message}`);
  // 200 newer ones to other people: the creator plan keeps 200 (REQUEST_LIMITS.creator.kept).
  for (let i = 0; i < 200; i += 1) await seed(sid, `other${i}@example.com`, hex(i, "b"), now - 200 * DAY + i * 3_600_000);
  let scope = (await erasureScope(store, TESS))!;
  is("paid plan: the copy has Tess's request past the newest 200", ids(await copier(scope)), [made.request.id]);

  // The plan ends: the store's list read stops at its newest 20.
  await setSubscription(OWNER, { active: false });
  store = (await storeForEmail(OWNER))!;
  scope = (await erasureScope(store, TESS))!;
  is("ended plan: the copy still has Tess's request", ids(await copier(scope)), [made.request.id]);

  part("Every one of theirs, at the most a person can have, and nobody else's");
  const mine = [made.request.id];
  for (let i = 1; i < MAX_PER_PERSON; i += 1) mine.push((await seed(sid, TESS, hex(i, "c"), now - (300 - i * 10) * DAY)).id);
  const all = (await copier(scope)) as PaymentRequest[];
  is("all of Tess's 24, whatever their age", ids(all), [...mine].sort());
  is("each one is addressed to her", all.every((r) => r.email === TESS), true);
  is("newest first", all.map((r) => r.createdAt), [...all.map((r) => r.createdAt)].sort((a, b) => b - a));

  part("A request whose record ran out is not in it, and is no failure");
  await redis.pipeline([["DEL", `nl:payreq:r:${mine[5]}`]]);
  is("the gone one is left out, the rest are there", ids(await copier(scope)), mine.filter((_, i) => i !== 5).sort());

  part("What cannot be read whole fails the copy, visibly");
  const set = `nl:payreq:p:${sid}:${personKey(sid, TESS)}`;
  const original = redis.pipeline.bind(redis);
  const sent: (string | number)[][] = [];
  const under = async (answer: (command: (string | number)[]) => unknown, run: () => Promise<unknown>) => {
    sent.length = 0;
    redis.pipeline = async (commands) => {
      sent.push(...commands);
      if (commands.length === 1) {
        const own = answer(commands[0]);
        if (own !== undefined) return own as unknown[];
      }
      return original(commands);
    };
    try {
      return await threw(run);
    } finally {
      redis.pipeline = original;
    }
  };
  const onSet = (verb: string, reply: unknown) => (c: (string | number)[]) => (c[0] === verb && c[1] === set ? reply : undefined);
  for (const [what, reply] of [["no reply", []], ["null", [null]], ["a string", ["3"]], ["below zero", [-1]], ["a fraction", [1.5]]] as const) {
    is(`the set's size read as ${what}: the copy fails`, await under(onSet("SCARD", reply), () => copier(scope)), "threw");
  }
  // Changed assertions (rule 23, review of the whole copy, 9 November 2026): the ceiling was MAX_PER_PERSON x 2 (48),
  // which orphan members (records gone, still in the set) could pass and lock the copy for good
  // (tests/payment-request-copy-orphans.test.ts); it is now COPY_MEMBERS_MAX, the most a store keeps on any plan, and
  // the members are read in SSCAN pages, so "not one member" is no SSCAN and no MGET.
  is("a set past the most a store keeps: the copy fails", await under(onSet("SCARD", [COPY_MEMBERS_MAX + 1]), () => copier(scope)), "threw");
  is("and not one member or record was read for it (its cost is bounded before reading)", sent.some((c) => c[0] === "SSCAN" || c[0] === "SMEMBERS" || c[0] === "MGET"), false);
  // Changed assertions (rule 23, same review): the members come in SSCAN pages ([cursor, members]), not one SMEMBERS
  // list, so each odd shape is now one of a page; a member given twice is no longer a failure (SSCAN may give one
  // twice), it is read once (below).
  for (const [what, reply] of [
    ["no reply", []],
    ["null", [null]],
    ["a page that is not a cursor and its members", [[mine[0], mine[1]]]],
    ["a cursor that is not digits", [["x", [mine[0]]]]],
    ["a member that is not an id", [["0", [mine[0], "not-an-id"]]]],
    ["a member that is not a string", [["0", [mine[0], 7]]]],
    ["more members than a store keeps", [["0", Array.from({ length: COPY_MEMBERS_MAX + 1 }, (_, i) => hex(i, "d"))]]],
  ] as const) {
    is(`its members read as ${what}: the copy fails`, await under(onSet("SSCAN", reply), () => copier(scope)), "threw");
  }
  is("a walk not at its end after COPY_PAGES_MAX pages: the copy fails", await under(onSet("SSCAN", [["7", []]]), () => copier(scope)), "threw");
  is("and it read no more than COPY_PAGES_MAX pages", sent.filter((c) => c[0] === "SSCAN").length, COPY_PAGES_MAX);
  is("a member a page gives twice is read once", await under(onSet("SSCAN", [["0", [mine[0], mine[0]]]]), async () => {
    const twice = (await copier(scope)) as PaymentRequest[];
    if (ids(twice).join() !== mine[0]) throw new Error(`read as ${ids(twice).join()}`);
  }), "returned");
  const onRecords = (reply: (keys: (string | number)[]) => unknown) => (c: (string | number)[]) => (c[0] === "MGET" && String(c[1]).startsWith("nl:payreq:r:") ? reply(c.slice(1)) : undefined);
  const record = (await readRequest(mine[0]))!;
  for (const [what, reply] of [
    ["no reply", () => []],
    ["one record short", (keys: unknown[]) => [Array(keys.length - 1).fill(null)]],
    ["a record that does not parse", (keys: unknown[]) => [Array(keys.length).fill("{not json")]],
    ["a record of another store", (keys: unknown[]) => [keys.map((k) => JSON.stringify({ ...record, id: String(k).slice(12), sid: "another-store" }))]],
    ["a record under another id", (keys: unknown[]) => [keys.map(() => JSON.stringify(record))]],
    ["a record to another person", (keys: unknown[]) => [keys.map((k) => JSON.stringify({ ...record, id: String(k).slice(12), email: "olly@example.com" }))]],
  ] as const) {
    is(`its records read as ${what}: the copy fails`, await under(onRecords(reply), () => copier(scope)), "threw");
  }

  part("A page at a time, as Redis pages a set: every live one, orphans skipped, the cost bounded");
  // 2,000 orphan members (records gone) beside her 23 live requests; SSCAN answered a page of COUNT at a time from a
  // cursor, as Redis does for a set this size (the stub answers it whole).
  const orphans = Array.from({ length: 2_000 }, (_, i) => hex(i, "a0"));
  await redis.pipeline([["SADD", set, ...orphans]]);
  const commandsSent: (string | number)[][] = [];
  redis.pipeline = async (commands) => {
    commandsSent.push(...commands);
    const [c] = commands;
    if (commands.length === 1 && c[0] === "SSCAN" && c[1] === set) {
      const [members] = (await original([["SMEMBERS", set]])) as string[][];
      const sorted = [...members].sort();
      const from = Number(c[2]);
      const count = Number(c[4]);
      const next = from + count >= sorted.length ? "0" : String(from + count);
      return [[next, sorted.slice(from, from + count)]];
    }
    return original(commands);
  };
  let paged: PaymentRequest[] = [];
  try {
    paged = (await copier(scope)) as PaymentRequest[];
  } finally {
    redis.pipeline = original;
  }
  is("every live one of hers, past 2,000 orphans", ids(paged), mine.filter((_, i) => i !== 5).sort());
  is("pages of COPY_PAGE_MEMBERS asked for", commandsSent.filter((c) => c[0] === "SSCAN").every((c) => c[4] === COPY_PAGE_MEMBERS), true);
  is("no MGET reads more than COPY_PAGE_MEMBERS records", commandsSent.filter((c) => c[0] === "MGET").every((c) => c.length - 1 <= COPY_PAGE_MEMBERS), true);
  is("the commands sent stay within COPY_READ_COMMANDS_MAX", commandsSent.length <= COPY_READ_COMMANDS_MAX, true);
  is("and only reads: nothing was written or taken off", commandsSent.every((c) => ["SCARD", "SSCAN", "MGET"].includes(String(c[0]))), true);
  is("the orphans are still members (the copy writes nothing)", (await redis.pipeline([["SCARD", set]]))[0], mine.length + orphans.length);
  await redis.pipeline([["SREM", set, ...orphans]]);
  is("the copy's worst read, in commands", COPY_READ_COMMANDS_MAX, 315);
  is("its cost is in the registry, said to be uncharged while copyPerson has no caller", /no caller/.test(NOT_A_COST.COPY_READ_COMMANDS_MAX ?? "") && /never zero/.test(NOT_A_COST.COPY_READ_COMMANDS_MAX ?? ""), true);

  part("The erasure deletes by the same set: the old one goes, nobody else's");
  await forgetRequestsPerson(sid, TESS);
  is("none of Tess's records is left", (await Promise.all(mine.map((id) => readRequest(id)))).every((r) => r === null), true);
  is("the others' are all there", (await Promise.all(Array.from({ length: 200 }, (_, i) => readRequest(hex(i, "b"))))).every((r) => r !== null), true);
  is("and her copy is empty", await copier(scope), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
