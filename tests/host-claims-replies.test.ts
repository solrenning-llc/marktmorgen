/**
 * Rule 24 (CX-123): lib/host-claims.ts reads every Redis reply in its exact shape.
 *
 * - confirmClaim (a paid team booking): an HSET, PTTL or PEXPIRE reply that is not exactly what was asked for is
 *   read back exactly (HGET, PTTL) and, when the write did not land, sent once more, the same write, and read back
 *   again; only what is still not confirmed throws, so lib/calls.ts logs it. A paid booking's claim is never left
 *   a hold that lapses (and lets another store book the same host at the same hour) on a lost reply alone.
 * - claimHosts: only the script's exact {1, 0} takes the time; any other shape is a refusal ("invalid").
 * - readClaims: a list that is not exactly a list of strings throws, so no time is shown as free.
 * - releaseClaim: an HDEL reply that is not a count throws.
 * The healthy and confirmed-empty paths are unchanged.
 */
import { claimHosts, claimsKey, confirmClaim, newClaimId, readClaims, releaseClaim } from "@/lib/host-claims";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOST = "0123456789abcdef01234567";
const HOST2 = "fedcba9876543210fedcba98";
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
type Plan = (commands: (string | number)[][], run: () => Promise<unknown[]>, sent: Record<string, number>) => Promise<unknown>;
/** Hands every pipeline to `plan` (which may run it for real), and lists each command's verb as it was sent. */
function scripted(plan: Plan): string[] {
  const verbs: string[] = [];
  const counts: Record<string, number> = {};
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) verbs.push(String(c[0]));
    const first = String(commands[0]?.[0]);
    counts[first] = (counts[first] ?? 0) + 1;
    return plan(commands, () => real(commands), counts);
  }) as typeof redis.pipeline;
  return verbs;
}
/** Runs `run` with console.error captured, then puts the real pipeline back. */
async function logged(run: () => Promise<unknown>): Promise<{ threw: boolean; error: unknown; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await run();
    return { threw: false, error: null, lines };
  } catch (error) {
    return { threw: true, error, lines };
  } finally {
    console.error = original;
    redis.pipeline = real;
  }
}
const storeB = (at: number) => claimHosts({ hosts: [host], start, end, claim: newClaimId(), until: 0, ref: "callsB:p9", now: at });
const storeB2 = (at: number) => claimHosts({ hosts: [{ ...host, id: HOST2 }], start, end, claim: newClaimId(), until: 0, ref: "callsB:p9", now: at });

async function main(): Promise<void> {
  part("confirmClaim: an HSET never answered as asked, on the write and on its one retry, throws");
  for (const shape of [[], [undefined, undefined], ["QUEUED", "QUEUED"], [null, 3_600_000], [-1, 3_600_000], [1, 3_600_000, 1]] as unknown[][]) {
    redis.clear();
    const claim = newClaimId();
    await claimHosts({ hosts: [host], start, end, claim, until: now + 40 * 60_000, ref: "callsA:p1", now });
    instead("HSET", shape);
    is(`HSET answered ${JSON.stringify(shape)}: confirmClaim throws`, await rejects(() => confirmClaim([HOST], claim, start, end, "callsA:p1")), true);
  }

  part("(a) the HSET's reply is lost but the write landed: read back, confirmed, no second write");
  {
    redis.clear();
    const claim = newClaimId();
    await claimHosts({ hosts: [host], start, end, claim, until: now + 40 * 60_000, ref: "callsA:p1", now });
    const sent = scripted(async (commands, run, n) => (commands[0]?.[0] === "HSET" && n.HSET === 1 ? (await run(), []) : run()));
    const logs = await logged(() => confirmClaim([HOST], claim, start, end, "callsA:p1"));
    is("confirmClaim resolves", logs.threw, false);
    is("the HSET is sent once", sent.filter((v) => v === "HSET").length, 1);
    is("the field is read back with HGET", sent.includes("HGET"), true);
    is("the unknown reply is logged", logs.lines.some((l) => l.includes("host claim")), true);
    is("store B is refused after the hold's time", (await storeB(now + 41 * 60_000)).ok, false);
  }

  part("(b) the first HSET did not land: written once more, read back, confirmed");
  for (const before of ["hold", "absent"] as const) {
    redis.clear();
    const claim = newClaimId();
    if (before === "hold") await claimHosts({ hosts: [host], start, end, claim, until: now + 40 * 60_000, ref: "callsA:p1", now });
    const sent = scripted(async (commands, run, n) => (commands[0]?.[0] === "HSET" && n.HSET === 1 ? [] : run()));
    const logs = await logged(() => confirmClaim([HOST], claim, start, end, "callsA:p1"));
    is(`${before}: confirmClaim resolves`, logs.threw, false);
    is(`${before}: the same HSET is sent twice, never a third time`, sent.filter((v) => v === "HSET").length, 2);
    is(`${before}: the paid claim is kept with until 0`, ((await readClaims([HOST], now + 41 * 60_000)).get(HOST) ?? []).filter((c) => c.claim === claim).map((c) => c.until).join(), "0");
    is(`${before}: store B is refused after the hold's time`, (await storeB(now + 41 * 60_000)).ok, false);
    const [ttl] = await real([["PTTL", claimsKey(HOST)]]);
    is(`${before}: the list has a lifetime`, typeof ttl === "number" && ttl > 0, true);
  }

  part("(c) the HSET and its retry both fail: confirmClaim throws, and it is logged");
  {
    redis.clear();
    const claim = newClaimId();
    await claimHosts({ hosts: [host], start, end, claim, until: now + 40 * 60_000, ref: "callsA:p1", now });
    const sent = scripted(async (commands, run) => (commands[0]?.[0] === "HSET" ? [] : run()));
    const logs = await logged(() => confirmClaim([HOST], claim, start, end, "callsA:p1"));
    is("confirmClaim throws UnknownReplyError", logs.error instanceof UnknownReplyError, true);
    is("the HSET is sent twice, never a third time", sent.filter((v) => v === "HSET").length, 2);
    is("the unknown reply is logged", logs.lines.some((l) => l.includes("host claim")), true);
  }

  part("confirmClaim: a PTTL reply lost once is read again exactly; never answered as asked, it throws");
  for (const pttl of [undefined, null, "QUEUED", "3600000", 1.5]) {
    redis.clear();
    const claim = newClaimId();
    answer("HSET", (_, replies) => [replies[0], pttl]);
    is(`PTTL answered ${JSON.stringify(pttl)} once: confirmClaim resolves`, await rejects(() => confirmClaim([HOST], claim, start, end, "callsA:p1")), false);
    const [ttl] = await real([["PTTL", claimsKey(HOST)]]);
    is(`PTTL answered ${JSON.stringify(pttl)} once: the list has a lifetime`, typeof ttl === "number" && ttl > 0, true);
    redis.clear();
    scripted(async (commands, run) => {
      const replies = await run();
      if (commands[0]?.[0] === "HSET" && commands.length === 2) return [replies[0], pttl];
      return commands[0]?.[0] === "PTTL" ? commands.map(() => pttl) : replies;
    });
    is(`PTTL answered ${JSON.stringify(pttl)} on every read: confirmClaim throws`, await rejects(() => confirmClaim([HOST], newClaimId(), start, end, "callsA:p1")), true);
  }

  part("confirmClaim: a PEXPIRE reply lost but landed is read back with PTTL; never landed, it throws");
  for (const shape of [[], [undefined], ["QUEUED"], [1, 1]] as unknown[][]) {
    redis.clear();
    answer("PEXPIRE", () => shape);
    is(`PEXPIRE answered ${JSON.stringify(shape)} but landed: confirmClaim resolves`, await rejects(() => confirmClaim([HOST], newClaimId(), start, end, "callsA:p1")), false);
    redis.clear();
    instead("PEXPIRE", shape);
    is(`PEXPIRE answered ${JSON.stringify(shape)} and never ran: confirmClaim throws`, await rejects(() => confirmClaim([HOST], newClaimId(), start, end, "callsA:p1")), true);
  }

  part("(d) a group booking: the 1st host's write and its retry fail; the 2nd host is still confirmed, then the call throws");
  {
    redis.clear();
    const claim = newClaimId();
    const both = [host, { ...host, id: HOST2 }];
    await claimHosts({ hosts: both, start, end, claim, until: now + 40 * 60_000, ref: "callsA:p1", now });
    // The first pipeline (both hosts) is lost and does not land; every HSET for host 1 alone fails too.
    const sent = scripted(async (commands, run) =>
      commands[0]?.[0] === "HSET" && (commands.length > 1 || commands[0][1] === claimsKey(HOST)) ? [] : run(),
    );
    const logs = await logged(() => confirmClaim([HOST, HOST2], claim, start, end, "callsA:p1"));
    is("confirmClaim throws UnknownReplyError", logs.error instanceof UnknownReplyError, true);
    is("the 2nd host's write is retried once", sent.filter((v) => v === "HSET").length, 4);
    is("the 2nd host's paid claim is kept with until 0", ((await readClaims([HOST2], now + 41 * 60_000)).get(HOST2) ?? []).filter((c) => c.claim === claim).map((c) => c.until).join(), "0");
    is("store B is refused on the 2nd host after the hold's time", (await storeB2(now + 41 * 60_000)).ok, false);
    const [ttl] = await real([["PTTL", claimsKey(HOST2)]]);
    is("the 2nd host's list has a lifetime", typeof ttl === "number" && ttl > 0, true);
    is("the 1st host is still a hold, not taken for paid", ((await readClaims([HOST], now)).get(HOST) ?? []).filter((c) => c.claim === claim).map((c) => c.until).join(), String(now + 40 * 60_000));

    // The caller's retry, on healthy replies: idempotent for the host already confirmed, and it confirms the rest.
    const again = scripted(async (_, run) => run());
    const retry = await logged(() => confirmClaim([HOST, HOST2], claim, start, end, "callsA:p1"));
    is("retry: confirmClaim resolves", retry.threw, false);
    is("retry: one write per host, no read-back", `${again.filter((v) => v === "HSET").length}/${again.includes("HGET")}`, "2/false");
    const after = await readClaims([HOST, HOST2], now + 41 * 60_000);
    is("retry: both hosts' paid claims kept with until 0, once each", [HOST, HOST2].map((id) => (after.get(id) ?? []).filter((c) => c.claim === claim).map((c) => c.until).join()).join(";"), "0;0");
    is("retry: store B is refused on the 1st host after the hold's time", (await storeB(now + 41 * 60_000)).ok, false);
  }

  part("(e) a group booking: the 1st host's PEXPIRE and its retry fail; the 2nd host still gets its lifetime, then the call throws");
  {
    redis.clear();
    scripted(async (commands, run) =>
      commands[0]?.[0] === "PEXPIRE" && (commands.length > 1 || commands[0][1] === claimsKey(HOST)) ? [] : run(),
    );
    const logs = await logged(() => confirmClaim([HOST, HOST2], newClaimId(), start, end, "callsA:p1"));
    is("confirmClaim throws UnknownReplyError", logs.error instanceof UnknownReplyError, true);
    const [ttl] = await real([["PTTL", claimsKey(HOST2)]]);
    is("the 2nd host's list has a lifetime", typeof ttl === "number" && ttl > 0, true);
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
