/**
 * Rule 24 (CX-123): lib/host-claims.ts reads every Redis reply in its exact shape.
 *
 * - confirmClaim (a paid team booking): an HSET, PTTL or PEXPIRE reply that is not exactly what was asked for
 *   throws, so lib/calls.ts logs the booking's hosts as not confirmed instead of taking a hold that will lapse
 *   (and let another store book the same host at the same hour) for a paid booking.
 * - claimHosts: only the script's exact {1, 0} takes the time; any other shape is a refusal ("invalid").
 * - readClaims: a list that is not exactly a list of strings throws, so no time is shown as free.
 * - releaseClaim: an HDEL reply that is not a count throws.
 * The healthy and confirmed-empty paths are unchanged.
 */
import { claimHosts, claimsKey, confirmClaim, newClaimId, readClaims, releaseClaim } from "@/lib/host-claims";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOST = "0123456789abcdef01234567";
const now = Date.UTC(2026, 10, 10, 12, 0, 0);
const start = now + 3 * 86_400_000;
const end = start + 3_600_000;
const host = { id: HOST, gapMs: 0, day: [start - 3_600_000, start + 8 * 3_600_000] as [number, number], cap: 10 };
const real = redis.pipeline.bind(redis);

type Replace = (commands: (string | number)[][], replies: unknown[]) => unknown;
/** Runs the real command, then hands its replies to `replace` for every pipeline whose first command is `verb`. */
function answer(verb: string, replace: Replace): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands[0]?.[0] === verb ? replace(commands, replies) : replies;
  }) as typeof redis.pipeline;
}
/** Answers `verb`'s pipelines with `shape` without running them. */
function instead(verb: string, shape: unknown): void {
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === verb ? shape : real(commands))) as typeof redis.pipeline;
}
async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  } finally {
    redis.pipeline = real;
  }
}
const storeB = (at: number) => claimHosts({ hosts: [host], start, end, claim: newClaimId(), until: 0, ref: "callsB:p9", now: at });

async function main(): Promise<void> {
  part("confirmClaim: an HSET reply not exactly a count throws");
  for (const shape of [[], [undefined, undefined], ["QUEUED", "QUEUED"], [null, 3_600_000], [-1, 3_600_000], [1, 3_600_000, 1]] as unknown[][]) {
    redis.clear();
    const claim = newClaimId();
    await claimHosts({ hosts: [host], start, end, claim, until: now + 40 * 60_000, ref: "callsA:p1", now });
    instead("HSET", shape);
    is(`HSET answered ${JSON.stringify(shape)}: confirmClaim throws`, await rejects(() => confirmClaim([HOST], claim, start, end, "callsA:p1")), true);
  }

  part("confirmClaim: a PTTL reply not exactly a whole number throws (the PEXPIRE is never skipped as NaN)");
  for (const pttl of [undefined, null, "QUEUED", "3600000", 1.5]) {
    redis.clear();
    const claim = newClaimId();
    answer("HSET", (_, replies) => [replies[0], pttl]);
    is(`PTTL answered ${JSON.stringify(pttl)}: confirmClaim throws`, await rejects(() => confirmClaim([HOST], claim, start, end, "callsA:p1")), true);
  }

  part("confirmClaim: a PEXPIRE reply not exactly a count throws");
  for (const shape of [[], [undefined], ["QUEUED"], [1, 1]] as unknown[][]) {
    redis.clear();
    const claim = newClaimId();
    instead("PEXPIRE", shape);
    is(`PEXPIRE answered ${JSON.stringify(shape)}: confirmClaim throws`, await rejects(() => confirmClaim([HOST], claim, start, end, "callsA:p1")), true);
  }

  part("control: confirmClaim on healthy replies keeps the host taken, with a lifetime");
  redis.clear();
  const paid = newClaimId();
  await claimHosts({ hosts: [host], start, end, claim: paid, until: now + 40 * 60_000, ref: "callsA:p1", now });
  await confirmClaim([HOST], paid, start, end, "callsA:p1");
  is("store B is refused after the hold's time", (await storeB(now + 41 * 60_000)).ok, false);
  is("the paid claim is kept with until 0", ((await readClaims([HOST], now + 41 * 60_000)).get(HOST) ?? []).map((c) => c.until).join(), "0");
  redis.clear();
  const fresh = newClaimId();
  await confirmClaim([HOST], fresh, start, end, "callsA:p1");
  const [ttl] = await real([["PTTL", claimsKey(HOST)]]);
  is("a list written anew by confirmClaim gets a lifetime", typeof ttl === "number" && ttl > 0, true);

  part("claimHosts: only the script's exact {1, 0} takes the time");
  for (const shape of [[1], ["1", "0"], [true, 0], [1, 0, 9], [1, "x"], [1.0000001, 0]] as unknown[]) {
    redis.clear();
    instead("EVAL", [shape]);
    const result = await claimHosts({ hosts: [host], start, end, claim: newClaimId(), until: 0, ref: "callsA:p1", now });
    redis.pipeline = real;
    is(`EVAL answered ${JSON.stringify(shape)}: refused as invalid`, JSON.stringify(result), JSON.stringify({ ok: false, reason: "invalid", host: 0 }));
  }
  part("control: claimHosts on the real script");
  redis.clear();
  is("a free host is taken", (await claimHosts({ hosts: [host], start, end, claim: newClaimId(), until: 0, ref: "callsA:p1", now })).ok, true);
  is("the same hour is refused as taken", JSON.stringify(await storeB(now)), JSON.stringify({ ok: false, reason: "taken", host: 0 }));
  redis.clear();
  is(
    "a full day is refused as cap",
    JSON.stringify(await claimHosts({ hosts: [{ ...host, cap: 0 }], start, end, claim: newClaimId(), until: 0, ref: "callsA:p1", now })),
    JSON.stringify({ ok: false, reason: "cap", host: 0 }),
  );

  part("readClaims: a reply not exactly a list of strings throws (no time is shown as free)");
  redis.clear();
  await claimHosts({ hosts: [host], start, end, claim: newClaimId(), until: 0, ref: "callsA:p1", now });
  for (const shape of [[], [null], ["x"], [{}], [[1, 2]], [["k"]], [[], []]] as unknown[][]) {
    instead("HGETALL", shape);
    is(`HGETALL answered ${JSON.stringify(shape)}: readClaims throws`, await rejects(() => readClaims([HOST], now)), true);
  }
  is("control: the booked claim is read", ((await readClaims([HOST], now)).get(HOST) ?? []).length, 1);
  redis.clear();
  is("control: a host with no list (confirmed empty) has no claims", JSON.stringify([...(await readClaims([HOST], now)).entries()]), JSON.stringify([[HOST, []]]));

  part("releaseClaim: an HDEL reply not exactly a count throws");
  for (const shape of [[], [null], ["QUEUED"], [1, 1]] as unknown[][]) {
    instead("HDEL", shape);
    is(`HDEL answered ${JSON.stringify(shape)}: releaseClaim throws`, await rejects(() => releaseClaim([HOST], newClaimId())), true);
  }
  part("control: releaseClaim on a healthy reply lets the time go");
  redis.clear();
  const held = newClaimId();
  await claimHosts({ hosts: [host], start, end, claim: held, until: now + 40 * 60_000, ref: "callsA:p1", now });
  await releaseClaim([HOST], held);
  is("store B takes the released hour", (await storeB(now)).ok, true);
  is("releasing a claim already gone resolves", await rejects(() => releaseClaim([HOST], newClaimId())), false);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
