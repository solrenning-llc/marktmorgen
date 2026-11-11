/**
 * What a move of the sign-in address costs the company, priced, and where that cost is funded (#2271: Codex G's
 * MEDIUM 6789950680, after Codex G2's 6648143960). The monthly room (tests/move-month-room.test.ts) bounds how many
 * moves the company pays for; this holds what each one costs and what the month's moves cost in dollars.
 *
 * 1. The registry prices a tap (tests/plan-cost-registry.ts MOVE_TAP_COST) from the repository's own rates: every
 *    database command, every byte both ways, the call, and its CPU and memory for the whole time it can take, lock
 *    waits included; and the month (MOVES_MONTH_COST) as MOVES_PER_MONTH taps plus the records a move leaves.
 *    MOVES_PER_MONTH is no longer only a sentence in NOT_A_COST.
 * 2. The figures are the real route's, counted here with every command the stand-in Redis runs, the scripts' own
 *    commands inside each EVAL included, for an account at every bound the code keeps: five stores at the largest
 *    record, nine earlier handles, ten passkeys at the largest body the passkey route reads, two-step login and a
 *    recovery address, a hundred browsers. Each lock the tap takes is priced at every try its wait allows, with the
 *    tries counted from lib/redis-lock.ts takeLock itself, under a stand-in clock.
 * 3. A broken move's record (lib/auth.ts markBrokenMove) is priced at its largest; a store holds at most one broken
 *    move: another move of either address waits until it is repaired and writes no record of its own.
 * 4. What the code does not bound is named (MOVE_COST_UNKNOWNS), never priced at zero, and the move is a line of the
 *    LLC fixed costs ("account-moves", lib/llc-fixed-costs.ts; FX275: 100% Marktmorgen) whose reviewed ceiling stays
 *    unknown while any of it is open: the company total, and with it the minimum base, stays unknown, never zero.
 *    The owner approved US$17 a month for the bounded part (11/11/2026 11:32 Fortaleza, accountMoves.boundedPartApproval):
 *    the priced month, rounded up to the cent, must stay within it, so a dearer month fails here.
 *
 * Synthetic only: a stand-in Redis and a stand-in clock; the move link is written as sendMoveLink writes it, and no
 * email is sent.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { MAX_EMAIL_LENGTH, MOVES_PER_MONTH, markBrokenMove, openSession } from "@/lib/auth";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { MAX_STORES_PER_ACCOUNT, MAX_STORE_BYTES, claimHandle, createStore, ensureStatsId, ensureStoreId, renameHandle, storeForEmail } from "@/lib/store";
import { MAX_ADDRESSES } from "@/lib/store-field-rules";
import { MAX_PASSKEYS } from "@/lib/passkeys";
import { keepRecoveryAddress } from "@/lib/recovery-address";
import { finishSetup, startSetup } from "@/lib/two-step";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { takeLock } from "@/lib/redis-lock";
import * as fixed from "@/lib/llc-fixed-costs";
import { UPSTASH_MICRO_USD_PER_GB_MONTH, UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION, VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR } from "@/lib/spend-cost-table";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (new URL(url).hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (new URL(url).hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Command = (string | number)[];
type LockBound = { takes: number; waitMs: number; source: { file: string; text: string } };
const r = registry as unknown as Record<string, unknown>;
const num = (name: string): number => (typeof r[name] === "number" && Number.isFinite(r[name]) ? (r[name] as number) : NaN);
const fn = (name: string): ((...args: number[]) => number) | null => (typeof r[name] === "function" ? (r[name] as (...args: number[]) => number) : null);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// Every command the stand-in runs, those inside an EVAL included (its scripts are modelled step for step through
// run), and every pipeline with its bytes both ways as the REST API carries them (JSON).
const realRun = redis.run.bind(redis);
const realPipeline = redis.pipeline.bind(redis);
const seen = { commands: 0, pipelines: 0, bytes: 0, locks: new Map<string, number>() };
const reset = () => {
  seen.commands = 0;
  seen.pipelines = 0;
  seen.bytes = 0;
  seen.locks.clear();
};
(redis as unknown as { run: (command: Command) => unknown }).run = (command: Command) => {
  seen.commands += 1;
  return realRun(command);
};
redis.pipeline = async (commands: Command[]) => {
  seen.pipelines += 1;
  for (const command of commands) {
    const key = String(command[1] ?? "");
    if (String(command[0]).toUpperCase() === "SET" && command.map(String).includes("NX") && /:lock[:]?/.test(key)) {
      const prefix = /^(.*?:lock:)/.exec(key)?.[1] ?? key;
      seen.locks.set(prefix, (seen.locks.get(prefix) ?? 0) + 1);
    }
  }
  const replies = await realPipeline(commands);
  seen.bytes += Buffer.byteLength(JSON.stringify(commands)) + Buffer.byteLength(JSON.stringify(replies));
  return replies;
};

const ORIGIN = "https://marktmorgen.com";
const form = (fields: Record<string, string>) =>
  new NextRequest(`${ORIGIN}/api/auth/move`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
const where = (location: string) => location.replace(/^.*[?&](status|address)=/, "");

/** One tap of a fresh move link, as the person would, counted from the tap alone. */
async function tap(from: string, to: string): Promise<string> {
  const session = await openSession(from);
  const token = randomBytes(32).toString("hex");
  const key = `nl:auth:move:${sha(`nimbus-auth-move:${token}`).slice(0, 40)}`;
  await realPipeline([["SET", key, JSON.stringify({ from, to, session }), "EX", 900]]);
  reset();
  return where((await moveRoute(form({ token }))).headers.get("location") ?? "");
}

/** Every store record of an account made `size` bytes long, through a field the record keeps as it is. */
function pad(email: string, size: number): number {
  const data = (redis as unknown as { data: Map<string, unknown> }).data;
  let padded = 0;
  for (const [key, value] of data) {
    if (typeof value !== "string" || !value.startsWith("{") || !value.includes(`"email":"${email}"`) || !value.includes('"handle"')) continue;
    const record = JSON.parse(value) as Record<string, unknown>;
    record.bio = "";
    const room = size - Buffer.byteLength(JSON.stringify(record));
    record.bio = "x".repeat(Math.max(0, room));
    data.set(key, JSON.stringify(record));
    padded += 1;
  }
  return padded;
}

/** An account at every bound the code keeps (see the header), its address `from`. */
async function fullAccount(from: string, tag: string): Promise<void> {
  await claimHandle(from, `${tag}-0`, "Full", "");
  await ensureStatsId(from);
  await ensureStoreId(from);
  for (let i = 1; i < MAX_STORES_PER_ACCOUNT; i += 1) {
    const made = await createStore(from, `${tag}-${i}`, "Full", "");
    if (!made.ok) throw new Error(`extra store ${i}: ${JSON.stringify(made)}`);
  }
  for (let i = 0; i < MAX_ADDRESSES - 1; i += 1) {
    const renamed = await renameHandle(from, `${tag}-r${i}`);
    if (!renamed.ok) throw new Error(`rename ${i}: ${JSON.stringify(renamed)}`);
  }
  // Ten passkeys, each as long as the largest body the passkey route reads (app/api/auth/passkey, MAX_BODY_BYTES).
  const passkeys = Array.from({ length: MAX_PASSKEYS }, (_, i) => ({
    id: `${tag}-key-${i}`.padEnd(64, "k"),
    publicKey: "p".repeat(PASSKEY_BODY_BYTES),
    counter: 0,
    transports: ["internal"],
    name: "N".repeat(60),
    createdAt: new Date(0).toISOString(),
    lastUsedAt: new Date(0).toISOString(),
    synced: true,
  }));
  await realPipeline([
    ["SET", `nl:pk:${sha(`nimbus-passkeys:${from}`).slice(0, 40)}`, JSON.stringify(passkeys)],
    ...passkeys.map((p) => ["SET", `nl:pk:cred:${sha(`nimbus-passkey-id:${p.id}`).slice(0, 40)}`, from]),
    ["SADD", `nl:auth:devices:${sha(`nimbus-auth-devices:${from}`).slice(0, 40)}`, ...Array.from({ length: 100 }, (_, i) => sha(`device-${tag}-${i}`).slice(0, 40))],
  ]);
  const backup = `${tag}.backup@example.com`;
  const session = sha(`session-${tag}`);
  const started = await startSetup(from, session, backup);
  if (typeof started === "string") throw new Error(`two-step: ${started}`);
  const code = /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === backup)?.text ?? "")?.[1] ?? "";
  const finished = await finishSetup(from, session, codeAt(base32Decode(started.secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS)), code);
  if (typeof finished === "string") throw new Error(`two-step finish: ${finished}`);
  await keepRecoveryAddress(from, backup);
}
/** app/api/auth/passkey/route.ts MAX_BODY_BYTES: no passkey it adds is longer. */
const PASSKEY_BODY_BYTES = 16_000;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("1. the registry prices a tap and the month in dollars, from the repository's own rates");
  const COMMAND = UPSTASH_MICRO_USD_PER_MILLION_COMMANDS / 1e12;
  const DB_BYTE = UPSTASH_MICRO_USD_PER_GB_TRANSFER / 1e15;
  const DB_BYTE_MONTH = UPSTASH_MICRO_USD_PER_GB_MONTH / 1e15;
  const CALL = VERCEL_CALL_MICRO_USD_PER_MILLION / 1e12;
  const CPU_SECOND = VERCEL_CPU_MICRO_USD_PER_HOUR / 1e6 / 3600;
  const MEMORY_SECOND = (VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR / 1e6) * VERCEL_FUNCTION_GB / 3600;
  const commands = num("MOVE_TAP_COMMANDS_MOST");
  const bytes = num("MOVE_TAP_BYTES_MOST");
  const seconds = num("MOVE_TAP_SECONDS_MOST");
  const tapCost = num("MOVE_TAP_COST");
  is("a tap's commands, bytes and seconds are figures", [commands, bytes, seconds].every((n) => Number.isFinite(n) && n > 0), true);
  // CPU the whole time it may take, as the backup's route is priced (lib/backup-cost.ts): never a guess of less.
  const byHand = CALL + seconds * (CPU_SECOND + MEMORY_SECOND) + commands * COMMAND + bytes * DB_BYTE;
  is("a tap is priced from the rates: call, CPU and memory for its seconds, commands, bytes", Math.abs(tapCost - byHand) < 1e-12, true);
  const recordBytes = num("MOVE_BROKEN_RECORD_BYTES");
  const roomBytes = num("MOVE_ROOM_KEY_BYTES");
  const kept = 2 * MOVES_PER_MONTH * recordBytes * DB_BYTE_MONTH + 2 * (MOVES_PER_MONTH + 2) * roomBytes * DB_BYTE_MONTH;
  is("the month's records are priced: two broken-move records a move, the counts kept into the next month", Math.abs(num("MOVES_MONTH_KEPT") - kept) < 1e-12, true);
  is("the month: MOVES_PER_MONTH taps and what they keep", Math.abs(num("MOVES_MONTH_COST") - (MOVES_PER_MONTH * tapCost + kept)) < 1e-9, true);
  is("the month is a positive dollar figure, never zero", num("MOVES_MONTH_COST") > 0, true);
  is("MOVES_PER_MONTH's line names its priced month", String(registry.NOT_A_COST.MOVES_PER_MONTH ?? "").includes("MOVES_MONTH_COST"), true);

  part("2. the real route's tap at every bound the code keeps, every command counted, scripts' own included");
  const tries = fn("lockTriesMost");
  is("the tries a lock's wait allows are a figure of the registry", typeof tries, "function");
  // takeLock against a lock somebody else holds, under a stand-in clock: every try it makes in its whole wait.
  const clock = { now: Date.now(), sleep: setTimeout };
  const realNow = Date.now;
  for (const waitMs of [4_000, 8_000]) {
    await realPipeline([["SET", "nl:test:lock:held", "theirs", "EX", 60]]);
    let made = 0;
    const counting = redis.pipeline;
    redis.pipeline = async (batch: Command[]) => {
      made += batch.filter((c) => c[1] === "nl:test:lock:held").length;
      return realPipeline(batch);
    };
    const realRandom = Math.random;
    Math.random = () => 0;
    Date.now = () => clock.now;
    (globalThis as { setTimeout: unknown }).setTimeout = (resolve: () => void, ms: number) => {
      clock.now += ms;
      return clock.sleep(resolve, 0);
    };
    try {
      await takeLock("nl:test:lock:held", 5, waitMs).catch(() => null);
    } finally {
      redis.pipeline = counting;
      Date.now = realNow;
      Math.random = realRandom;
      (globalThis as { setTimeout: unknown }).setTimeout = clock.sleep;
    }
    // No random part to a wait (Math.random 0): the most tries the wait allows, exactly.
    is(`a lock waited ${waitMs} ms is tried exactly lockTriesMost(${waitMs}) times at the most`, tries ? made === tries(waitMs) : false, true);
  }

  const FROM = "full-from@example.com";
  const TO = "full-to@example.com";
  await fullAccount(FROM, "move-cost-full");
  is("(five stores, each at the largest record)", pad(FROM, MAX_STORE_BYTES), MAX_STORES_PER_ACCOUNT);
  const primary = await storeForEmail(FROM);
  is("(the primary store reads, with its nine earlier handles)", primary?.previousHandles.length, MAX_ADDRESSES - 1);
  is("the full account moves", await tap(FROM, TO), "moved");
  const fullTap = { ...seen, locks: new Map(seen.locks) };
  is(`its commands, the scripts' own included (${fullTap.commands}), are within MOVE_TAP_COMMANDS_UNCONTENDED`, fullTap.commands <= num("MOVE_TAP_COMMANDS_UNCONTENDED"), true);
  is(`its pipelines (${fullTap.pipelines}) are within MOVE_TAP_PIPELINES`, fullTap.pipelines <= num("MOVE_TAP_PIPELINES"), true);
  // Each byte of a record may be escaped once on the wire (a quote or a backslash in its text: two bytes), so the
  // bytes measured with plain text count twice in the bound.
  is(`its bytes both ways (${fullTap.bytes}) are within MOVE_TAP_BYTES_UNCONTENDED`, fullTap.bytes <= num("MOVE_TAP_BYTES_UNCONTENDED"), true);
  const tryBytes = Object.values((r.MOVE_TAP_LOCKS ?? {}) as Record<string, LockBound>).reduce((sum, lock) => sum + lock.takes * ((tries?.(lock.waitMs) ?? Infinity) - 1) * num("LOCK_TRY_BYTES"), 0);
  is("the most bytes: twice the measured tap and every try of every lock, for a record escaped on the wire", Number.isFinite(tryBytes) && bytes === 2 * (num("MOVE_TAP_BYTES_UNCONTENDED") + tryBytes), true);
  const locks = (r.MOVE_TAP_LOCKS ?? {}) as Record<string, LockBound>;
  const unknownLocks = [...fullTap.locks.keys()].filter((prefix) => !locks[prefix]);
  is("every lock the tap takes is priced", unknownLocks, []);
  is("no lock is taken more often than priced", [...fullTap.locks].filter(([prefix, n]) => n > (locks[prefix]?.takes ?? 0)), []);
  is("each lock's wait is the one its code waits", Object.keys(locks).length > 0 && Object.values(locks).every((lock) => readFileSync(lock.source.file, "utf8").includes(lock.source.text)), true);
  is("the passkey route's body ceiling is the one used here", readFileSync("app/api/auth/passkey/route.ts", "utf8").includes(`const MAX_BODY_BYTES = 16_000;`), true);
  const contended = Object.values(locks).reduce((sum, lock) => sum + lock.takes * ((tries?.(lock.waitMs) ?? Infinity) - 1), 0);
  is("the most commands: the measured tap and every try of every lock", Number.isFinite(contended) && commands === num("MOVE_TAP_COMMANDS_UNCONTENDED") + contended, true);
  const waits = Object.values(locks).reduce((sum, lock) => sum + lock.takes * (lock.waitMs / 1000 + ((tries?.(lock.waitMs) ?? Infinity) - 1) * num("ROUND_TRIP_SECONDS")), 0);
  is("the most seconds: every trip to the database one after another, and every lock's whole wait", Math.abs(seconds - (num("MOVE_TAP_PIPELINES") * num("ROUND_TRIP_SECONDS") + waits)) < 1e-9, true);

  part("3. a broken move's record, at its largest, and at most one a store");
  const long = (tag: string) => `${tag}${"a".repeat(MAX_EMAIL_LENGTH - tag.length - "@example.com".length)}@example.com`;
  const [A, B] = [long("a"), long("b")];
  await markBrokenMove(A, B);
  const record = await realPipeline([["GET", `nl:auth:move-broken:${sha(`nimbus-auth-move-broken:${A}`).slice(0, 40)}`]]);
  const noted = JSON.stringify({ ...JSON.parse(String(record[0])), copy: "f".repeat(64) });
  is("the record, noted with its copy, key and value, is within MOVE_BROKEN_RECORD_BYTES", Buffer.byteLength(noted) + 61 <= recordBytes, true);
  const C = "broken-c@example.com";
  const D = "broken-d@example.com";
  const E = "broken-e@example.com";
  await claimHandle(C, "move-cost-broken", "Broken", "");
  await markBrokenMove(C, D);
  const brokenKeys = () => [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((key) => key.startsWith("nl:auth:move-broken:")).length;
  const before = brokenKeys();
  // The repair cannot settle it (the store is at C and the way in nowhere to move) only when it is still running:
  // a move's own mark is there, so the next move of C waits and writes nothing.
  await realPipeline([["SET", `nl:auth:moving:${sha(`nimbus-auth-moving:${C}`).slice(0, 40)}`, "another", "EX", 300]]);
  is("another move of an address with a broken move waits", await tap(C, E), "move-error");
  is("and leaves no record of its own", brokenKeys(), before);

  part("4. what the code does not bound is named, and the move is a line of the LLC fixed costs");
  const unknowns = Array.isArray(r.MOVE_COST_UNKNOWNS) ? (r.MOVE_COST_UNKNOWNS as string[]) : [];
  for (const open of ["sessions", "memberships", "phone", "broken", "undo", "repair", "ask"]) {
    is(`an open item names ${open}`, unknowns.some((line) => line.toLowerCase().includes(open)), true);
  }
  const ids = fixed.LLC_FIXED_COST_IDS as readonly string[];
  is("the move is one of the LLC's fixed costs (FX275: 100% Marktmorgen)", ids.includes("account-moves"), true);
  type Approval = { monthlyUsdCents?: unknown; covers?: string; excludes?: string; approvedBy?: string; decided?: string; decision?: string };
  const observation = (fixed.FIXED_COST_SOURCE_OBSERVATIONS as Record<string, { model?: string; approvedCeiling?: boolean; boundedPartApproval?: Approval }>).accountMoves;
  is("its observation names the priced month and the whole line is not an approved ceiling", [observation?.model?.includes("MOVES_MONTH_COST"), observation?.approvedCeiling], [true, false]);
  // The owner's decision (11/11/2026 11:32 Fortaleza, "Aprovar US$ 17/mês"): US$17 a month for the bounded part only.
  const approval = observation?.boundedPartApproval;
  is("the owner's approval is US$17 a month, dated, for MOVES_MONTH_COST only and not MOVE_COST_UNKNOWNS",
    [approval?.monthlyUsdCents, approval?.approvedBy, approval?.decided, approval?.decision, approval?.covers?.endsWith(" MOVES_MONTH_COST"), approval?.excludes?.endsWith(" MOVE_COST_UNKNOWNS")],
    [1700, "owner", "2026-11-11T11:32:00-03:00", "Aprovar US$ 17/mês", true, true]);
  const approvedCents = typeof approval?.monthlyUsdCents === "number" && Number.isSafeInteger(approval.monthlyUsdCents) ? approval.monthlyUsdCents : -1;
  is("the priced worst month, rounded up to the cent, stays within the owner's approved ceiling", Math.ceil(num("MOVES_MONTH_COST") * 100) <= approvedCents, true);
  is("unknowns are still open, so the approval does not complete the line", unknowns.length > 0, true);
  const line = fixed.CURRENT_LLC_FIXED_COST_CEILINGS.find((one) => one.id === ("account-moves" as never));
  is("its reviewed ceiling stays unknown while anything is open", [Boolean(line), line?.fullMonthlyUsdCents, line?.fullAnnualUsdCents], [true, null, null]);
  is("so the company's fixed total stays unknown, never zero", fixed.allocateEntireLlcFixedCosts(fixed.CURRENT_LLC_FIXED_COST_CEILINGS), null);
  done();
}

void main();
