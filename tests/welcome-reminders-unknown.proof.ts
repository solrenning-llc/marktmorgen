/**
 * Proof only (rule 24 candidates in lib/welcome-offer-send.ts), outside the CI run:
 *   node tests/g-proof-run.mjs welcome-reminders-unknown.proof.ts
 *
 * Each case replaces ONE Redis reply (store.pipeline patched for that command only) and counts:
 * reminder emails posted to the provider, the store's email figure taken, the due entry left,
 * and what the personal-data deletion reports. Healthy replies are the controls. Synthetic only.
 * The `is` lines state what happens TODAY; a line marked DEFECT is the behavior under suspicion.
 */
import { createHash } from "node:crypto";
import { remindAt } from "@/lib/welcome-offer";
import { forgetWelcomePerson, scheduleReminder, sendWelcomeReminders, welcomesOffered } from "@/lib/welcome-offer-send";
import { readClaimFull, recordLead, requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_welcome_only_a_stand_in";

const sent: { to: string; key: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    const h = new Headers(init?.headers);
    sent.push({ to: [body.to].flat()[0], key: h.get("Idempotency-Key") ?? "", subject: body.subject, text: body.text });
    return json({ id: `email_${sent.length}` });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "owner@example.com";
const DUE = "nl:wo:due";
const real = redis.pipeline.bind(redis);
type Pipe = typeof redis.pipeline;
const reminders = () => sent.filter((m) => m.key.startsWith("nimbus-wo:")).length;
let ip = 0;
let freeId = "";

/** A new person who agreed and confirmed, with their one reminder set; the due list holds only theirs. */
async function prepare(email: string): Promise<{ member: string; now: number; statsId: string }> {
  await real([["DEL", DUE]]);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, freeId))!;
  const before = sent.length;
  const result = await requestCopy({ store, product, email, consent: true, ip: `10.1.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, origin: "https://marktmorgen.com" });
  if (result !== "sent") throw new Error(`not sent: ${result}`);
  const token = /token=([0-9a-f]{64})/.exec(JSON.stringify(sent.slice(before)))?.[1] ?? "";
  const claim = (await readClaimFull(token))!;
  await recordLead(store, claim, product.title);
  const asked = Math.floor(Date.parse(claim.at) / 1000);
  const fresh = (await storeForEmail(OWNER))!;
  if (!(await scheduleReminder(fresh, claim, token, asked + 3600))) throw new Error("reminder not set");
  const [members] = await real([["ZRANGEBYSCORE", DUE, "0", "+inf"]]);
  return { member: (members as string[])[0], now: remindAt(asked, 48) + 1, statsId: fresh.statsId! };
}

const inDue = async (member: string) => (await real([["ZSCORE", DUE, member]]))[0] !== null;

/** One run of the five-minute job with one reply replaced; counts what it did. */
async function run(now: number, patch?: Pipe) {
  const store = (await storeForEmail(OWNER))!;
  const usedBefore = await allowanceUsed(store, "email");
  const mailsBefore = reminders();
  if (patch) redis.pipeline = patch;
  let counts: { sent: number; dropped: number };
  try {
    counts = await sendWelcomeReminders(Date.now() + 20_000, now);
  } finally {
    redis.pipeline = real;
  }
  return { ...counts, mails: reminders() - mailsBefore, taken: (await allowanceUsed(store, "email")) - usedBefore };
}

const on = (name: string, reply: (commands: (string | number)[][]) => Promise<unknown[]>): Pipe =>
  (async (commands: (string | number)[][]) => (commands[0]?.[0] === name ? reply(commands) : real(commands))) as Pipe;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestWelcomeProof1", true);
  await setSubscription(OWNER, { customerId: "cus_WelcomeProof1", subscriptionId: "sub_WelcomeProof1", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  if (!free.ok || !paid.ok) throw new Error("no products");
  for (const p of [free, paid]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  await setWelcomeOffer(OWNER, { product: paid.product.id, percent: 25, hours: 48, coupon: "c_welcome25", remind: true, address: "1 Main St, Springfield, IL 62701" });
  freeId = free.product.id;
  let n = 0;
  const person = () => `p${++n}@example.com`;

  part("Control: healthy replies");
  {
    const p = await prepare(person());
    const r = await run(p.now);
    is("healthy: one reminder sent, one email taken, due entry gone", [r.sent, r.dropped, r.mails, r.taken, await inDue(p.member)], [1, 0, 1, 1, false]);
    const again = await run(p.now + 60);
    is("healthy: next tick sends nothing more", [again.sent, again.mails, again.taken], [0, 0, 0]);
  }

  part("A. ZRANGEBYSCORE reply unknown (the due list read)");
  for (const [label, bad] of [["missing []", []], ["null", [null]], ["undefined", [undefined]], ["wrong type: string", ["oops"]], ["wrong type: number", [1]], ["wrong type: object", [{}]]] as const) {
    const p = await prepare(person());
    const r = await run(p.now, on("ZRANGEBYSCORE", async () => bad as unknown as unknown[]));
    const left = await inDue(p.member);
    const next = await run(p.now + 300);
    console.log(`  [A ${label}] tick1=${JSON.stringify(r)} leftInDue=${left} tick2=${JSON.stringify(next)}`);
    is(`A ${label}: tick reads as "nothing due" (0 sent, 0 dropped, 0 mails), entry kept`, [r.sent, r.dropped, r.mails, left], [0, 0, 0, true]);
    is(`A ${label}: the next healthy tick sends it once (delayed, not lost)`, [next.sent, next.mails, next.taken], [1, 1, 1]);
  }
  {
    const p = await prepare(person());
    const r = await run(p.now, on("ZRANGEBYSCORE", async (c) => [...(await real(c)), ["extra"]]));
    is("A extra trailing reply: ignored, sent once", [r.sent, r.mails, r.taken], [1, 1, 1]);
    const p2 = await prepare(person());
    const r2 = await run(p2.now, on("ZRANGEBYSCORE", async (c) => [[...((await real(c))[0] as string[]), "[object Object]", "not-json"]]));
    is("A list with foreign members: they fail ZREM (0) and are skipped; the real one sent once", [r2.sent, r2.dropped, r2.mails], [1, 0, 1]);
  }

  part("B. ZREM reply unknown (the claim), the entry REALLY removed by Redis");
  for (const [label, bad] of [["missing []", []], ["null", [null]], ["undefined", [undefined]], ["wrong type: 'OK'", ["OK"]], ["wrong type: object", [{}]]] as const) {
    const p = await prepare(person());
    const r = await run(p.now, on("ZREM", async (c) => (await real(c), bad as unknown as unknown[])));
    const left = await inDue(p.member);
    const next = await run(p.now + 300);
    const later = await run(p.now + 3600);
    console.log(`  [B ${label}] tick1=${JSON.stringify(r)} leftInDue=${left} tick2=${JSON.stringify(next)} tick3=${JSON.stringify(later)}`);
    is(`B ${label}: DEFECT lost send — claimed, never sent, counted neither sent nor dropped`, [r.sent, r.dropped, r.mails, left, next.mails + later.mails], [0, 0, 0, false, 0]);
  }
  for (const [label, bad] of [["missing []", []], ["null", [null]]] as const) {
    const p = await prepare(person());
    const r = await run(p.now, on("ZREM", async () => bad as unknown as unknown[]));
    const next = await run(p.now + 300);
    is(`B ${label}, ZREM NOT executed: entry kept, next tick sends once (retry works)`, [r.mails, await inDue(p.member) || next.mails === 1, next.mails, next.taken], [0, true, 1, 1]);
  }
  {
    const p = await prepare(person());
    const r = await run(p.now, on("ZREM", async (c) => [...(await real(c)), 99]));
    is("B extra trailing reply: ignored, sent once", [r.sent, r.mails], [1, 1]);
  }

  part("C. Concurrent run: entry already claimed by run A, run B reads a stale list, ZREM really answers 0");
  for (const [label, shown] of [["healthy 0 (control)", 0], ["wrong type: true", true], ["wrong type: '1'", "1"], ["wrong type: [1]", [1]]] as const) {
    const p = await prepare(person());
    const a = await run(p.now);
    const stale = on("ZRANGEBYSCORE", async () => [[p.member]]);
    const patchB = (async (commands: (string | number)[][]) => {
      if (commands[0]?.[0] === "ZREM") {
        const [truth] = await real(commands);
        if (truth !== 0) throw new Error("expected the honest answer 0");
        return [shown];
      }
      return stale(commands);
    }) as Pipe;
    const b = await run(p.now + 1, patchB);
    const keys = sent.filter((m) => m.key.startsWith("nimbus-wo:")).slice(-(a.mails + b.mails)).map((m) => m.key);
    console.log(`  [C ${label}] runA=${JSON.stringify(a)} runB=${JSON.stringify(b)} keys=${JSON.stringify(keys)}`);
    is(`C ${label}: run A sends once`, [a.sent, a.mails, a.taken], [1, 1, 1]);
    if (shown === 0) is(`C ${label}: run B skips (0 mails, 0 taken)`, [b.sent, b.mails, b.taken], [0, 0, 0]);
    else {
      // Run B goes on to sendEmail for an entry it did not take. On the Resend path the transport's claim under the
      // same Idempotency-Key ("nimbus-wo:<statsId>:<hash>") answers accepted_receipt: no second POST, no second unit
      // of the store's email figure, but run B still counts it as sent.
      is(`C ${label}: run B attempts an already-claimed entry and reports sent:1 (over-count)`, b.sent, 1);
      is(`C ${label}: Resend path: no second POST, no second email unit (deduped by the idempotency claim)`, [b.mails, b.taken, keys.length], [0, 0, 1]);
    }
  }

  part("D. forgetWelcomePerson: DEL reply unknown (personal-data deletion)");
  // The two keys forgetWelcomePerson deletes, named as lib/welcome-offer-send.ts names them.
  let current = "";
  const h = (email: string) => createHash("sha256").update(`welcome:${email.toLowerCase()}`).digest("hex").slice(0, 32);
  const startKeys = async (statsId: string) => ((await real([["EXISTS", `nl:wo:start:${statsId}:${h(current)}`]]))[0] === 1 ? ["s"] : []);
  const remKeys = async (statsId: string) => ((await real([["EXISTS", `nl:wo:r:${statsId}:${h(current)}`]]))[0] === 1 ? ["r"] : []);
  {
    const email = person();
    current = email;
    const p = await prepare(email);
    const beforeKeys = (await startKeys(p.statsId)).length + (await remKeys(p.statsId)).length;
    is("D healthy, data present: reports 2, keys gone", [await forgetWelcomePerson(p.statsId, email), (await startKeys(p.statsId)).length + (await remKeys(p.statsId)).length - beforeKeys], [2, -2]);
    is("D healthy, nothing kept: reports 0 (confirmed absence)", await forgetWelcomePerson(p.statsId, email), 0);
    // Side observation (not a rule-24 case): the due entry, which holds the address and the claim token, is not among what it deletes.
    is("D side: after the healthy deletion the due entry with the address is still kept", [await inDue(p.member), p.member.includes(email)], [true, true]);
  }
  for (const [label, bad, exec] of [["missing [], not executed", [], false], ["null, not executed", [null], false], ["wrong type 'x', not executed", ["x"], false], ["missing [], executed", [], true], ["wrong type true, not executed", [true], false]] as const) {
    const email = person();
    current = email;
    const p = await prepare(email);
    const count = async () => (await startKeys(p.statsId)).length + (await remKeys(p.statsId)).length;
    const before = await count();
    redis.pipeline = on("DEL", async (c) => {
      if (exec) await real(c);
      return bad as unknown as unknown[];
    });
    let reported: unknown;
    let threw = false;
    try {
      reported = await forgetWelcomePerson(p.statsId, email);
    } catch {
      threw = true;
    } finally {
      redis.pipeline = real;
    }
    const removed = before - (await count());
    console.log(`  [D ${label}] reported=${String(reported)} threw=${threw} keysRemoved=${removed}`);
    if (!exec && label.startsWith("wrong type true")) is(`D ${label}: DEFECT reports 1 record deleted, nothing deleted, no failure`, [reported, threw, removed], [1, false, 0]);
    else if (!exec) is(`D ${label}: DEFECT reports 0 ("nothing kept"), no failure, both keys still there`, [reported, threw, removed], [0, false, 0]);
    else is(`D ${label}: reports 0 although 2 keys went (under-report, no data left)`, [reported, threw, removed], [0, false, 2]);
  }

  part("E. welcomesOffered: GET reply unknown (studio count)");
  {
    const store = (await storeForEmail(OWNER))!;
    const truth = await welcomesOffered(store);
    is("E healthy: the count of people offered", truth > 0, true);
    for (const [label, bad] of [["missing []", []], ["null", [null]], ["wrong type 'x'", ["x"]]] as const) {
      redis.pipeline = on("GET", async (c) => (String(c[0][1]).startsWith("nl:wo:n:") ? (bad as unknown as unknown[]) : real(c)));
      let shown: number;
      try {
        shown = await welcomesOffered(store);
      } finally {
        redis.pipeline = real;
      }
      is(`E ${label}: shows 0 instead of ${truth} (display only: "Offered so far: 0.")`, shown, 0);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
