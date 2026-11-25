/**
 * #4624 (residual): the job that settles offers after paying that the buyer's browser did not settle
 * (lib/upsell.ts settlePendingOffers) takes the 50 oldest waiting offers a run. A member whose look threw (its store
 * read failed, Stripe failed) kept its old score, so 50 of them held the front and every healthy offer behind them
 * waited their whole watch: the buyer's confirmation email and the affiliate credit came late. A thrown look now moves
 * the member behind, on the same schedule as an offer still pending (WATCH_AFTER_MS), so the next run reaches the
 * others. The no-store and no-Stripe cases already did so (d283d36307). A throw comes from the record read, the store
 * read or a write; settleOne answers every Stripe failure itself. Since Claude 5 ichw's reviews of #5482: the time
 * an offer began is noted beside the list (nl:upsell:at:<checkout>, written by watchPending), or, for an entry listed
 * before that, its score is noted once, so a look whose record does not read follows the offer's own schedule: a
 * passing failure is looked at again minutes later, never a day, and an offer whose record never reads, or stops
 * reading after a rewrite, is let go when its watch is over, inside OFFER_WATCH_LOOKS_MOST; a member another path took
 * off is never put back; a look whose own reschedule threw sends no second one; and the list's members keep the format
 * older code reads ("<store>|<checkout>|<slot>"), so rolling a deploy back leaves nothing it looks at every run.
 * Synthetic data only; nothing is charged.
 */
import { settlePendingOffers } from "@/lib/upsell";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { OFFER_WATCH_LOOKS_MOST } from "./plan-cost-registry";
import { done, is, part } from "./check";

const PENDING = "nl:upsell:pending";
/** The offer's member, exactly as listed, and its score; null when it is not listed. */
const listedAs = (member: string): { member: string; score: number } | null => {
  const score = redis.run(["ZSCORE", PENDING, member]);
  return score === null || score === undefined ? null : { member, score: Number(score) };
};
/** The time noted beside the list for an offer (lib/upsell.ts atKey); null when none. */
const notedAt = (session: string): number | null => {
  const value = redis.run(["GET", `nl:upsell:at:${session}`]);
  return value === null || value === undefined ? null : Number(value);
};
/** Every member of the list keeps the three fields older code reads: "<store>|<checkout>|<slot>". */
const oldFormat = () => (redis.run(["ZRANGE", PENDING, 0, -1]) as string[]).every((m) => m.split("|").length === 3);
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
console.error = () => {};

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  const broken = Array.from({ length: 50 }, (_, i) => `cs_test_brokenoffer${String(i).padStart(3, "0")}`);
  for (const [i, session] of broken.entries()) {
    redis.run(["SET", `nl:upsell:${session}`, JSON.stringify({ state: "pending", product: "p1", pi: `pi_broken${i}`, at: now - 10 * 60_000 })]);
    redis.run(["ZADD", PENDING, i, `broken|${session}|`]);
  }
  const healthy = "healthy|cs_test_healthyoffer001|";
  redis.run(["ZADD", PENDING, now - 5 * 60_000, healthy]);
  const front = () => (redis.run(["ZRANGEBYSCORE", PENDING, 0, Date.now() - 60_000, "LIMIT", 0, 50]) as string[]);

  part("Control: before the run, the 50 offers whose look throws hold the job's front");
  is("the healthy offer is the 51st", front().includes(healthy), false);

  part("A look that throws moves its offer behind, so the next run reaches the others");
  const storeFor = async (handle: string): Promise<Store | null> => {
    if (handle === "broken") throw new Error("synthetic store read failure");
    return null;
  };
  const run = await settlePendingOffers(storeFor, Date.now() + 10_000);
  is("the run looked at the 50 at the front", run.checked, 50);
  is("none of them was dropped: each is still waiting", broken.every((s) => listedAs(`broken|${s}|`) !== null), true);
  is("each is now due later than now, at its schedule's next look (eleven minutes after it began)", broken.every((s) => listedAs(`broken|${s}|`)?.score === now - 10 * 60_000 + 11 * 60_000 && (listedAs(`broken|${s}|`)?.score ?? 0) > Date.now()), true);
  is("each keeps the member older code reads", oldFormat(), true);
  is("so the healthy offer is at the front of the next run", front()[0], healthy);

  part("An offer whose look throws past its whole watch is let go, as the other branches do");
  redis.clear();
  const old = "cs_test_oldbrokenoffer01";
  redis.run(["SET", `nl:upsell:${old}`, JSON.stringify({ state: "pending", product: "p1", pi: "pi_old", at: now - 8 * 86_400_000 })]);
  redis.run(["ZADD", PENDING, 1, `broken|${old}|`]);
  await settlePendingOffers(storeFor, Date.now() + 10_000);
  is("past the watch for a payment still clearing (seven days), it leaves the list", listedAs(`broken|${old}|`), null);

  // Claude 5 iYwjc's LEVE on #5482: an offer whose record never reads was looked at hourly until the record lapsed
  // (RECORD_SECONDS, 8 days), up to ~192 looks against the OFFER_WATCH_LOOKS_MOST the orders line prices.
  part("An offer whose record never reads is looked at on its own schedule, inside the priced looks, then let go");
  redis.clear();
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const garbled = "cs_test_garbledoffer001";
    redis.run(["SET", `nl:upsell:${garbled}`, "{not json"]);
    // Listed as watchPending lists an offer: its score is the time it began.
    redis.run(["ZADD", PENDING, realNow(), `broken|${garbled}|`]);
    let looks = 0;
    const counted = async (handle: string): Promise<Store | null> => storeFor(handle);
    const reads = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "GET" && c[1] === `nl:upsell:${garbled}`)) looks += 1;
      return reads(commands);
    }) as typeof redis.pipeline;
    // Every five minutes for the record's eight days, as the job runs.
    for (let t = 0; t <= 8 * 86_400_000; t += 5 * 60_000) {
      shift = t;
      await settlePendingOffers(counted, Date.now() + 10_000);
    }
    redis.pipeline = reads;
    is(`looked at ${looks} times in eight days, inside the priced ${OFFER_WATCH_LOOKS_MOST}`, looks <= OFFER_WATCH_LOOKS_MOST, true);
    is("and let go once its watch is over, as a readable offer is", listedAs(`broken|${garbled}|`), null);
  } finally {
    Date.now = realNow;
  }

  // Claude 5 ichw's MEDIUM on #5482: one passing failure of the record read never puts a paid offer's settling a day off.
  part("One passing failure of the record read: the offer is looked at again minutes later, never a day");
  redis.clear();
  {
    const passing = "cs_test_passingfailure01";
    const began = Date.now() - 2 * 60_000;
    redis.run(["SET", `nl:upsell:${passing}`, JSON.stringify({ state: "pending", product: "p1", pi: "pi_passing", at: began })]);
    redis.run(["ZADD", PENDING, began, `quiet|${passing}|`]);
    const reads = redis.pipeline.bind(redis);
    let failedOnce = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!failedOnce && commands.some((c) => c[0] === "GET" && c[1] === `nl:upsell:${passing}`)) {
        failedOnce = true;
        throw new Error("synthetic passing timeout");
      }
      return reads(commands);
    }) as typeof redis.pipeline;
    await settlePendingOffers(async () => null, Date.now() + 10_000);
    redis.pipeline = reads;
    const after = listedAs(`quiet|${passing}|`);
    is("the read failed once, and the offer is still listed, its time noted from its score", [failedOnce, after?.member, notedAt(passing)], [true, `quiet|${passing}|`, began]);
    is("its next look is its schedule's next, eleven minutes after it began, never a day", after?.score, began + 11 * 60_000);
    is("and it keeps the member older code reads", oldFormat(), true);
  }

  // Claude 5 ichw's LEVE 2 on #5482: a record read on early looks, then rewritten (its expiry renewed) and unreadable,
  // is looked at on the offer's first time, never past its watch. Listed as watchPending lists it (its time noted), and,
  // for an entry listed before the time was noted (none today: PLANS_ON_SALE is false, so no offer is taken), from the
  // score noted at its first unreadable look: later than its start, so at most twice the priced looks, once.
  for (const listedBy of ["watchPending", "older code"] as const) {
    part(`A record that reads, is rewritten, then stops reading (listed by ${listedBy}): looked at inside its looks, then let go`);
    redis.clear();
    const shiftNow = Date.now;
    let shift = 0;
    Date.now = () => shiftNow() + shift;
    try {
      const mixed = "cs_test_mixedoffer00001";
      const began = shiftNow();
      redis.run(["SET", `nl:upsell:${mixed}`, JSON.stringify({ state: "pending", product: "p1", pi: "pi_mixed", at: began }), "EX", 8 * 86_400]);
      redis.run(["ZADD", PENDING, began, `quiet|${mixed}|`]);
      if (listedBy === "watchPending") redis.run(["SET", `nl:upsell:at:${mixed}`, began, "NX", "EX", 8 * 86_400]);
      let looks = 0;
      const reads = redis.pipeline.bind(redis);
      redis.pipeline = (async (commands: (string | number)[][]) => {
        if (commands.some((c) => c[0] === "GET" && c[1] === `nl:upsell:${mixed}`)) looks += 1;
        return reads(commands);
      }) as typeof redis.pipeline;
      for (let t = 0; t <= 14 * 86_400_000; t += 5 * 60_000) {
        shift = t;
        // On its first day, after its early looks, the record is rewritten with a fresh eight days and stops reading.
        if (t === 86_400_000 + 5 * 60_000) redis.run(["SET", `nl:upsell:${mixed}`, "{rewritten, unreadable", "EX", 8 * 86_400]);
        await settlePendingOffers(async () => null, Date.now() + 10_000);
      }
      redis.pipeline = reads;
      const most = listedBy === "watchPending" ? OFFER_WATCH_LOOKS_MOST : 2 * OFFER_WATCH_LOOKS_MOST;
      is(`looked at ${looks} times in fourteen days, inside ${most}`, looks <= most, true);
      is("and let go when its watch is over", listedAs(`quiet|${mixed}|`), null);
    } finally {
      Date.now = shiftNow;
    }
  }

  // Claude 5 ichw's LEVE 3 on #5482: a member the thanks page took off during a look is never put back by the job.
  part("A member another path takes off during a look is never put back");
  redis.clear();
  {
    const settled = "cs_test_settledmeanwhile1";
    const began = Date.now() - 10 * 60_000;
    redis.run(["SET", `nl:upsell:${settled}`, JSON.stringify({ state: "pending", product: "p1", pi: "pi_settled", at: began })]);
    redis.run(["ZADD", PENDING, began, `broken|${settled}|`]);
    const throwsAfterUnlisting = async (): Promise<Store | null> => {
      // As the thanks page settles it: unwatchPending takes the member off, then this look throws.
      redis.run(["ZREM", PENDING, `broken|${settled}|`]);
      throw new Error("synthetic store read failure");
    };
    await settlePendingOffers(throwsAfterUnlisting, Date.now() + 10_000);
    is("the offer is not listed again", listedAs(`broken|${settled}|`), null);
  }

  // Claude 5 ichw's MÉDIO 1 on #5482 @a9eb1c0d34: a reschedule whose reply was lost was sent again by the catch, a look
  // billed 11 commands against the 9 priced. A look whose own write threw now sends no second one.
  part("A look whose reschedule's reply was lost sends no second write");
  redis.clear();
  {
    const lost = "cs_test_lostreschedule01";
    const began = Date.now() - 10 * 60_000;
    redis.run(["SET", `nl:upsell:${lost}`, JSON.stringify({ state: "pending", product: "p1", pi: "pi_lost", at: began })]);
    redis.run(["ZADD", PENDING, began, `quiet|${lost}|`]);
    const writes = redis.pipeline.bind(redis);
    let moves = 0;
    let billed = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      for (const c of commands) billed += String(c[0]).toUpperCase() === "EVAL" ? 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length : 1;
      const answer = await writes(commands);
      if (commands.some((c) => c[0] === "ZADD" && c[1] === PENDING)) {
        moves += 1;
        // Made by Redis, its reply lost on the way back.
        throw new Error("synthetic lost reply");
      }
      return answer;
    }) as typeof redis.pipeline;
    await settlePendingOffers(async () => null, Date.now() + 10_000);
    redis.pipeline = writes;
    is("one move sent, never a second from the catch", moves, 1);
    is("the move was made: the offer is at its next look", listedAs(`quiet|${lost}|`)?.score, began + 11 * 60_000);
    is(`the look bills ${billed} commands, inside OFFER_WATCH_LOOK_COMMANDS_MOST`, billed <= 9, true);
  }

  // Claude 5 id8Ws on #5482: a write that fails never takes a still-pending offer off the job's list.
  part("A reschedule that is refused leaves the offer listed and pending, looked at again by the next run");
  redis.clear();
  {
    const kept = "cs_test_keptonfailure001";
    const began = Date.now() - 10 * 60_000;
    redis.run(["SET", `nl:upsell:${kept}`, JSON.stringify({ state: "pending", product: "p1", pi: "pi_kept", at: began })]);
    redis.run(["ZADD", PENDING, began, `quiet|${kept}|`]);
    const writes = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      // The move is refused, as Redis can refuse a write (a timeout before it ran, a refused write).
      if (commands.some((c) => c[0] === "ZADD" && c[1] === PENDING)) throw new Error("synthetic refused write");
      return writes(commands);
    }) as typeof redis.pipeline;
    await settlePendingOffers(async () => null, Date.now() + 10_000);
    redis.pipeline = writes;
    is("the offer is still on the job's list, still pending", [listedAs(`quiet|${kept}|`)?.score, JSON.parse(String(redis.run(["GET", `nl:upsell:${kept}`]))).state], [began, "pending"]);
  }

  // Claude 5 ichw's MÉDIO 2 on #5482 @a9eb1c0d34: an entry carrying its time ("|at:<ms>") was rescheduled by older code
  // as a new plain member while the timed one stayed due, looked at on every run (566 looks in 3 days). The list now
  // keeps the older format through every path, the offer's time beside it.
  part("Every path keeps the member older code reads, so a rolled-back deploy looks at nothing every run");
  redis.clear();
  {
    const shiftNow = Date.now;
    let shift = 0;
    Date.now = () => shiftNow() + shift;
    try {
      const began = shiftNow();
      const sessions = ["cs_test_formatplain00001", "cs_test_formatgarbled001", "cs_test_formatbroken0001"];
      redis.run(["SET", `nl:upsell:${sessions[0]}`, JSON.stringify({ state: "pending", product: "p1", pi: "pi_f0", at: began })]);
      redis.run(["SET", `nl:upsell:${sessions[1]}`, "{not json"]);
      redis.run(["SET", `nl:upsell:${sessions[2]}`, JSON.stringify({ state: "pending", product: "p1", pi: "pi_f2", at: began })]);
      redis.run(["ZADD", PENDING, began, `quiet|${sessions[0]}|`]);
      redis.run(["ZADD", PENDING, began, `quiet|${sessions[1]}|`]);
      redis.run(["ZADD", PENDING, began, `broken|${sessions[2]}|`]);
      let always = true;
      for (let t = 0; t <= 3 * 86_400_000; t += 5 * 60_000) {
        shift = t;
        await settlePendingOffers(async (handle) => storeFor(handle), Date.now() + 10_000);
        always &&= oldFormat();
      }
      is("after three days of runs every member still has three fields", always, true);
    } finally {
      Date.now = shiftNow;
    }
  }

  // Claude 5 iao9Ep's NIT on #5482: the thanks page takes off the offer's one entry.
  part("An offer settled by the thanks page leaves the list at once, or at its next look if it was already read");
  redis.clear();
  {
    const paid = "cs_test_paidonthanks0001";
    const began = Date.now() - 10 * 60_000;
    redis.run(["SET", `nl:upsell:${paid}`, JSON.stringify({ state: "paid", product: "p1", pi: "pi_paid", at: began })]);
    redis.run(["ZADD", PENDING, began, `quiet|${paid}|`]);
    await settlePendingOffers(async () => null, Date.now() + 10_000);
    is("a paid offer's entry leaves the list", listedAs(`quiet|${paid}|`), null);
  }

  // Claude 5 ichw's LEVE 4 on #5482: a record that has expired is let go at its next look.
  part("A record that has expired is let go at its next look");
  redis.clear();
  {
    const gone = "cs_test_expiredrecord001";
    redis.run(["ZADD", PENDING, Date.now() - 10 * 60_000, `quiet|${gone}|`]);
    await settlePendingOffers(async () => null, Date.now() + 10_000);
    is("no record: the offer leaves the list", listedAs(`quiet|${gone}|`), null);
  }

  done();
}

void main();
