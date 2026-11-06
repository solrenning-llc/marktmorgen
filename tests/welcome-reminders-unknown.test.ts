/**
 * Rule 24 in lib/welcome-offer-send.ts: a Redis reply is read in its exact shape.
 *
 * Each case replaces ONE Redis reply (store.pipeline patched for that command only) and counts:
 * reminder emails posted to the provider, the store's email figure taken, the due entry left,
 * and what the personal-data deletion reports. Healthy replies are the controls. Synthetic only.
 *
 * What fails here: a reminder claimed off the due list in an unknown reply and never sent
 * (a lost send); a wrong-type "yes" from the claim counted as sent; a deletion answered in an
 * unknown shape reported as "nothing kept" or as deleted instead of failing, so the person's
 * erasure (lib/person-erasure.ts) says incomplete; the due list's unknown read not logged.
 * Made permanent from the proof tests/welcome-reminders-unknown.proof.ts (commit 11a63966).
 */
import { createHash } from "node:crypto";
import { remindAt } from "@/lib/welcome-offer";
import { forgetWelcomePerson, scheduleReminder, sendWelcomeReminders } from "@/lib/welcome-offer-send";
import { erasePerson } from "@/lib/person-erasure";
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
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    error(...args);
  };
  let counts: { sent: number; dropped: number; unknown?: number };
  try {
    counts = await sendWelcomeReminders(Date.now() + 20_000, now);
  } finally {
    redis.pipeline = real;
    console.error = error;
  }
  return {
    sent: counts.sent,
    dropped: counts.dropped,
    unknown: counts.unknown ?? 0,
    mails: reminders() - mailsBefore,
    taken: (await allowanceUsed(store, "email")) - usedBefore,
    logged: logged.some((line) => line.includes("unknown shape")),
  };
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
    is("healthy: one reminder sent, one email taken, due entry gone, nothing logged", [r.sent, r.dropped, r.unknown, r.mails, r.taken, await inDue(p.member), r.logged], [1, 0, 0, 1, 1, false, false]);
    const again = await run(p.now + 60);
    is("healthy: next tick sends nothing more", [again.sent, again.unknown, again.mails, again.taken], [0, 0, 0, 0]);
  }

  part("A. ZRANGEBYSCORE reply unknown (the due list read): delayed, never lost, and said in the log");
  for (const [label, bad] of [["missing []", []], ["null", [null]], ["undefined", [undefined]], ["wrong type: string", ["oops"]], ["wrong type: number", [1]], ["wrong type: object", [{}]]] as const) {
    const p = await prepare(person());
    const r = await run(p.now, on("ZRANGEBYSCORE", async () => bad as unknown as unknown[]));
    const left = await inDue(p.member);
    const next = await run(p.now + 300);
    is(`A ${label}: nothing tried this tick, entry kept, the unknown read logged`, [r.sent, r.dropped, r.unknown, r.mails, left, r.logged], [0, 0, 0, 0, true, true]);
    is(`A ${label}: the next healthy tick sends it once`, [next.sent, next.mails, next.taken], [1, 1, 1]);
  }
  {
    const p = await prepare(person());
    const r = await run(p.now, on("ZRANGEBYSCORE", async (c) => [...(await real(c)), ["extra"]]));
    is("A extra trailing reply: the list is still read, sent once", [r.sent, r.mails, r.taken], [1, 1, 1]);
    const p2 = await prepare(person());
    const r2 = await run(p2.now, on("ZRANGEBYSCORE", async (c) => [[...((await real(c))[0] as string[]), "[object Object]", "not-json"]]));
    is("A list with foreign members: they fail ZREM (0) and are skipped; the real one sent once", [r2.sent, r2.dropped, r2.unknown, r2.mails], [1, 0, 0, 1]);
  }

  part("B. ZREM reply unknown (the claim), the entry REALLY removed by Redis: sent anyway, counted unknown");
  for (const [label, bad] of [["missing []", []], ["null", [null]], ["undefined", [undefined]], ["wrong type: 'OK'", ["OK"]], ["wrong type: object", [{}]], ["extra trailing reply", null]] as const) {
    const p = await prepare(person());
    const r = await run(p.now, on("ZREM", async (c) => {
      const truth = await real(c);
      return bad === null ? [...truth, 99] : (bad as unknown as unknown[]);
    }));
    const left = await inDue(p.member);
    const next = await run(p.now + 300);
    const later = await run(p.now + 3600);
    is(`B ${label}: sent once now, counted unknown (not sent), one email taken, logged`, [r.sent, r.dropped, r.unknown, r.mails, r.taken, left, r.logged], [0, 0, 1, 1, 1, false, true]);
    is(`B ${label}: never again later`, [next.mails + later.mails, next.taken + later.taken], [0, 0]);
  }
  for (const [label, bad] of [["missing []", []], ["null", [null]], ["wrong type: 'OK'", ["OK"]]] as const) {
    const p = await prepare(person());
    const r = await run(p.now, on("ZREM", async () => bad as unknown as unknown[]));
    const left = await inDue(p.member);
    const next = await run(p.now + 300);
    is(`B ${label}, ZREM NOT executed: still queued, left for the next run (nothing sent now)`, [r.sent, r.unknown, r.mails, r.taken, left], [0, 0, 0, 0, true]);
    is(`B ${label}, ZREM NOT executed: the next tick sends once`, [next.sent, next.mails, next.taken], [1, 1, 1]);
  }
  for (const [label, zscore] of [["ZSCORE missing []", []], ["ZSCORE wrong type: object", [{}]], ["ZSCORE wrong type: number", [5]]] as const) {
    const p = await prepare(person());
    const patch = (async (commands: (string | number)[][]) => {
      if (commands[0]?.[0] === "ZREM") return (await real(commands), [null]);
      if (commands[0]?.[0] === "ZSCORE") return zscore as unknown as unknown[];
      return real(commands);
    }) as Pipe;
    const r = await run(p.now, patch);
    const next = await run(p.now + 300);
    is(`B ZREM unknown and ${label}: sent anyway under its idempotency key, counted unknown, never lost`, [r.sent, r.unknown, r.mails, r.taken, next.mails], [0, 1, 1, 1, 0]);
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
    is(`C ${label}: run A sends once`, [a.sent, a.mails, a.taken], [1, 1, 1]);
    if (shown === 0) is(`C ${label}: run B skips (0 mails, 0 taken)`, [b.sent, b.unknown, b.mails, b.taken], [0, 0, 0, 0]);
    else {
      // The wrong-type "yes" is not taken as this run's claim: the entry is gone, so it is tried under the same
      // Idempotency-Key ("nimbus-wo:<statsId>:<hash>"), counted unknown, never as a second "sent".
      is(`C ${label}: run B does not report it as sent; counted unknown`, [b.sent, b.unknown], [0, 1]);
      is(`C ${label}: no second POST, no second email unit (deduped by the idempotency claim)`, [b.mails, b.taken, keys.length], [0, 0, 1]);
    }
  }

  part("D. forgetWelcomePerson: DEL reply unknown (personal-data deletion) refuses, never reports a count");
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
  }
  const cases = [
    ["missing [], not executed", [], false],
    ["null, not executed", [null], false],
    ["undefined, not executed", [undefined], false],
    ["wrong type 'x', not executed", ["x"], false],
    ["wrong type '2', not executed", ["2"], false],
    ["wrong type true, not executed", [true], false],
    ["out of range 3, not executed", [3], false],
    ["negative -1, not executed", [-1], false],
    ["fraction 1.5, not executed", [1.5], false],
    ["extra trailing reply, executed", null, true],
    ["missing [], executed", [], true],
  ] as const;
  for (const [label, bad, exec] of cases) {
    const email = person();
    current = email;
    const p = await prepare(email);
    const count = async () => (await startKeys(p.statsId)).length + (await remKeys(p.statsId)).length;
    const before = await count();
    redis.pipeline = on("DEL", async (c) => {
      const truth = exec ? await real(c) : [];
      return bad === null ? [...truth, 0] : (bad as unknown as unknown[]);
    });
    let reported: unknown;
    let threw = "";
    try {
      reported = await forgetWelcomePerson(p.statsId, email);
    } catch (error) {
      threw = (error as Error).name;
    } finally {
      redis.pipeline = real;
    }
    const removed = before - (await count());
    is(`D ${label}: refuses with UnknownReplyError, no count reported`, [reported, threw, removed], [undefined, "UnknownReplyError", exec ? 2 : 0]);
  }

  part("D'. The person's erasure says the welcome module failed when its deletion is unknown");
  {
    const email = person();
    current = email;
    const p = await prepare(email);
    const store = (await storeForEmail(OWNER))!;
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands[0]?.[0] === "DEL" && String(commands[0][1]).startsWith("nl:wo:start:") ? [null] : real(commands)) as Pipe;
    let result: Awaited<ReturnType<typeof erasePerson>>;
    const error = console.error;
    console.error = () => undefined;
    try {
      result = await erasePerson(store, email, { kind: "person" });
    } finally {
      redis.pipeline = real;
      console.error = error;
    }
    const failed = !result.ok && result.reason === "incomplete" ? result.failed : [];
    is("erasure: incomplete, naming lib/welcome-offer-send.ts", [result.ok, !result.ok && result.reason, failed.includes("lib/welcome-offer-send.ts")], [false, "incomplete", true]);
    is("erasure: the welcome keys are still there to delete on the next run", (await startKeys(p.statsId)).length + (await remKeys(p.statsId)).length, 2);
    const again = await erasePerson(store, email, { kind: "person" });
    const welcomePart = again.ok ? again.parts.find((x) => x.module === "lib/welcome-offer-send.ts") : undefined;
    is("erasure run again with healthy replies: complete, the welcome module deletes its 2 keys", [again.ok, welcomePart?.records], [true, 2]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
