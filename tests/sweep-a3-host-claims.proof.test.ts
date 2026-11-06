/**
 * Sweep A3 proof (CX-123 rule 24), synthetic only: the in-memory Redis double. lib/host-claims.ts:
 *
 * 1. readClaims, line 128: its own comment says "A list that cannot be read throws, and the caller offers none of
 *    that host's times" (and lib/team-booking.ts teamContext says the same), but an HGETALL reply that is not a list
 *    is read as "no claims": the host's taken times are offered as free on another store's booking page. The
 *    booking itself is still refused by the atomic claim script (CLAIM_HOST_TIMES), so the buyer meets a time that
 *    cannot be booked.
 * 2. confirmClaim, lines 179-182: the PTTL read with `Number(ttls[...]) < keep`; an unknown answer is NaN, never
 *    "short", so no PEXPIRE is sent. When the hold had run out (the key gone), the HSET makes the host's list again
 *    with no expiry at all (PTTL -1): a list of a person's bookings kept with no end.
 */
import { claimHosts, claimsKey, confirmClaim, hostId, newClaimId, readClaims } from "@/lib/host-claims";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  const host = hostId("host@example.com");
  const now = Date.now();
  const start = now + 86_400_000;
  const claim = newClaimId();
  const taken = await claimHosts({ hosts: [{ id: host, gapMs: 0, day: [start - 3_600_000, start + 3_600_000], cap: 5 }], start, end: start + 3_600_000, claim, until: 0, ref: "calls:product", now });
  if (!taken.ok) throw new Error("no claim");

  part("1. readClaims: healthy control");
  is("the host's booked time is read", (await readClaims([host], now)).get(host)?.map((c) => c.claim), [claim]);

  part("1. DEFECT: the HGETALL answers in an unknown shape");
  redis.pipeline = (async (commands: Command[]) => (commands.every((c) => c[0] === "HGETALL") ? [{ unexpected: true }] : real(commands))) as typeof redis.pipeline;
  let read: unknown;
  try {
    read = (await readClaims([host], now)).get(host);
  } catch (error) {
    read = (error as Error).message;
  }
  redis.pipeline = real;
  is("DEFECT: no throw, the host reads as having no claims (all times free)", read, []);

  part("2. confirmClaim: healthy control (the hold ran out: the list is made again)");
  const other = hostId("other@example.com");
  const paid = newClaimId();
  await confirmClaim([other], paid, start, start + 3_600_000, "calls:product");
  const ttl = Number((await real([["PTTL", claimsKey(other)]]))[0]);
  is("given an expiry of at least the booking's end plus two days", ttl > 86_400_000, true);

  part("2. DEFECT: the PTTL answers in an unknown shape");
  const third = hostId("third@example.com");
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    return commands.some((c) => c[0] === "PTTL") ? replies.map((r, i) => (commands[i][0] === "PTTL" ? "?" : r)) : replies;
  }) as typeof redis.pipeline;
  await confirmClaim([third], newClaimId(), start, start + 3_600_000, "calls:product");
  redis.pipeline = real;
  is("DEFECT: no PEXPIRE: the host's list is kept with no expiry (-1)", (await real([["PTTL", claimsKey(third)]]))[0], -1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
