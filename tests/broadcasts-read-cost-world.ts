/**
 * A synthetic store with sent emails at their longest, and a watch on every
 * database call, for the readers of a store's one-off emails that pay before
 * they read (tests/broadcasts-read-cost-*.test.ts; regra 30, siblings of the
 * reading #3034 fixed on the page "Change where a link goes").
 *
 * What one studio request pays for in the database is what
 * tests/plan-cost-registry.ts prices it at (UNIT_COST.studio): twenty
 * commands and fifty kilobytes. A command is counted as Upstash bills it:
 * each one in a batch, and each call a script makes inside it
 * (BROADCAST_HEADS: one GET a key). A byte is counted both ways, as sent:
 * the batch and its replies as JSON.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { MAX_MAIL_BODY } from "@/lib/mail";
import { countStudio } from "@/lib/studio-route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

export const UNIT_COMMANDS = 20;
export const UNIT_BYTES = 50_000;

export type Command = (string | number)[];
export type Event = { kind: "pay"; units: number } | { kind: "db"; commands: number; bytes: number; reads: string[]; sizes: number };

export const wire = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
export const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");
export const emailKey = (id: string) => `nl:mail:bc:${id}`;
const RECORD = /^nl:mail:bc:[0-9a-f]{24}$/;
const HEADS = "-- marktmorgen:broadcast-heads:v";
export const pipeline = redis.pipeline.bind(redis);

const LINK = '<p><a href="https://youtube.com/watch?v=1">Watch</a></p>';
/** The longest body there is: every character escaped as stored (six bytes) and once more as it crosses. */
export const LONGEST = LINK + "\u0001".repeat(MAX_MAIL_BODY - LINK.length);
export const SMALL = LINK;

/** A paying store with a list. */
export async function makeStore(owner: string, handle: string): Promise<Store> {
  const made = await claimHandle(owner, handle, "Read Cost", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Read Cost", address: "1 Main St, Portland, OR 97201" });
  return (await storeForEmail(owner))!;
}

/** A sent email's record as createBroadcast writes it (lib/broadcasts.ts). */
export function record(store: Store, id: string, body: string, extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    id, listId: store.listId, handle: store.handle, subject: `Subject ${id.slice(-2)}`, body, productId: null, notProductId: null, who: "all", narrow: null,
    status: "sent", createdAt: now - 3_600, sendAt: now - 3_600, finishedAt: now - 3_000, total: 100, sent: 100, note: "", failures: 0, listed: true, tagged: true, test: null, links: true,
    ...extra,
  });
}

export const idsFor = (n: number, prefix = "ab") => Array.from({ length: n }, (_, i) => `${prefix.repeat(11)}${String(i).padStart(2, "0")}`);

/** Writes the store's emails, newest first as listed, each with the body given. */
export async function writeEmails(store: Store, ids: string[], bodyOf: (i: number) => string, extra: (i: number) => Record<string, unknown> = () => ({})): Promise<void> {
  const listKey = `nl:mail:bcs:${store.listId}`;
  await pipeline([["DEL", listKey]]);
  for (const [i, id] of ids.entries()) await pipeline([["SET", emailKey(id), record(store, id, bodyOf(i), extra(i))]]);
  if (ids.length) await pipeline([["RPUSH", listKey, ...ids]]);
}

/** Commands as billed: each in the batch, and each key a heads script reads inside it. */
function billed(batch: Command[]): number {
  return batch.reduce((n, c) => n + 1 + (c[0] === "EVAL" && String(c[1]).startsWith(HEADS) ? Number(c[2]) : 0), 0);
}

/** Record bodies read by a batch: a GET or GETRANGE of a record, or a heads script answering records (not only sizes). */
function readsOf(batch: Command[]): string[] {
  const out: string[] = [];
  for (const c of batch) {
    if ((c[0] === "GET" || c[0] === "GETRANGE") && RECORD.test(String(c[1]))) out.push(String(c[1]));
    if (c[0] === "EVAL" && String(c[1]).startsWith(HEADS)) {
      const keys = Number(c[2]);
      if (c[3 + keys] !== "size") out.push(...c.slice(3, 3 + keys).map(String));
    }
  }
  return out;
}

/** Records whose size without the body a batch asks (a heads script in "size" mode): work that must be paid before it is sent too (Codex P 5811379332, Codex J 5811457165 on #3034). */
export function sizesOf(batch: Command[]): number {
  return batch.reduce((n, c) => n + (c[0] === "EVAL" && String(c[1]).startsWith(HEADS) && c[3 + Number(c[2])] === "size" ? Number(c[2]) : 0), 0);
}

/** The studio requests a reader takes, from the store's own count (lib/studio-route.ts, countStudio). */
export const payFrom = (store: Store) => async (units: number) => {
  const counted = await countStudio(store, null, units);
  return counted.ok ? ({ ok: true } as const) : ({ ok: false, message: counted.message } as const);
};

export type Sum = { ok: boolean; paid: number; commands: number; bytes: number; own: { commands: number; bytes: number }; readBefore: boolean; sizedBefore: boolean; read: number; sized: number };

/**
 * What a run read before its first take (`own`, inside its caller's own
 * studio requests), whether a record was read or measured before it, and whether every
 * command and byte after it is inside what was taken when it was sent.
 */
export function covered(log: Event[]): Sum {
  const firstPay = log.findIndex((e) => e.kind === "pay");
  const cut = firstPay < 0 ? log.length : firstPay;
  const before = log.slice(0, cut).filter((e): e is Extract<Event, { kind: "db" }> => e.kind === "db");
  const own = { commands: before.reduce((n, e) => n + e.commands, 0), bytes: before.reduce((n, e) => n + e.bytes, 0) };
  let paid = 0;
  let commands = 0;
  let bytes = 0;
  let ok = true;
  for (const event of log.slice(cut)) {
    if (event.kind === "pay") {
      paid += event.units;
      continue;
    }
    commands += event.commands;
    bytes += event.bytes;
    if (commands > paid * UNIT_COMMANDS || bytes > paid * UNIT_BYTES) ok = false;
  }
  const read = log.reduce((n, e) => n + (e.kind === "db" ? e.reads.length : 0), 0);
  const sized = log.reduce((n, e) => n + (e.kind === "db" ? e.sizes : 0), 0);
  return { ok, paid, commands, bytes, own, readBefore: before.some((e) => e.reads.length > 0), sizedBefore: before.some((e) => e.sizes > 0), read, sized };
}

/** Runs `what` with every database call watched; `then` runs after a batch (to change a record between two calls). */
export async function watched<T>(what: () => Promise<T>, then: ((batch: Command[]) => Promise<void>) | null = null): Promise<{ result: T | "threw"; sum: Sum; log: Event[] }> {
  const log: Event[] = [];
  redis.pipeline = (async (batch: Command[]) => {
    const studio = batch.find((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:allow:studio:"));
    // A take is credited when it is sent: its own commands are in what it takes.
    if (studio) log.push({ kind: "pay", units: Number(studio[2]) });
    const replies = await pipeline(batch);
    log.push({ kind: "db", commands: billed(batch), bytes: wire(batch) + wire(replies), reads: readsOf(batch), sizes: sizesOf(batch) });
    if (then) await then(batch);
    return replies;
  }) as typeof redis.pipeline;
  let result: T | "threw";
  try {
    result = await what();
  } catch {
    result = "threw";
  } finally {
    redis.pipeline = pipeline as typeof redis.pipeline;
  }
  return { result, sum: covered(log), log };
}

/** Sets the store's studio requests used this month (its one count), to leave `left` of `of`. */
export async function leaveStudio(left: number, of: number): Promise<void> {
  const allowance = redis.keys().filter((k) => k.startsWith("nl:allow:studio:"));
  if (allowance.length !== 1) throw new Error(`studio count not found (${allowance.length})`);
  await pipeline([["SET", allowance[0], String(of - left)]]);
}

export { redis };
