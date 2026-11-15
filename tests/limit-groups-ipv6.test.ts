/**
 * Every per-connection limit counts an IPv6 client by its /48, not by the exact address it sent (#4628).
 *
 * lib/request-guard.ts keyed withinLimit and essentialLimitState on `who` as given, and the callers build it from
 * clientAddress, the exact x-forwarded-for. One IPv6 customer holds at least a /64, so every request of theirs could
 * come from a new address and find a new allowance: the checkout's, the free copy's, the hits', the API key's. The
 * key is now made from the share address of each part of `who` that is an IPv6 address (a /48, as shareAddress in
 * lib/traffic-rules.ts counts a connection), in one place, for every caller. An IPv4 address counts by itself.
 *
 * Synthetic requests; MemoryRedis.
 */
import { clientAddress, essentialLimitState, withinLimit } from "@/lib/request-guard";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const from = (ip: string) => ({ headers: new Headers({ "x-forwarded-for": ip }) });

async function main(): Promise<void> {
  redis.clear();

  part("1,000 requests from 1,000 addresses of one /64");
  let let_through = 0;
  for (let i = 0; i < 1_000; i += 1) {
    if (await withinLimit("x", `${clientAddress(from(`2001:db8:0:1:${(i + 1).toString(16)}::7`))}|shop`, 5, 60)) let_through += 1;
  }
  is("five are let through, as for one address", let_through, 5);

  part("The same for an essential limit, and across a /48");
  const states: string[] = [];
  for (let i = 0; i < 20; i += 1) states.push(await essentialLimitState("y", clientAddress(from(`2001:db8:5:${(i + 1).toString(16)}::1`)), 3, 60));
  is("three within, then exceeded", [states.slice(0, 3).every((s) => s === "within"), states.slice(3).every((s) => s === "exceeded")], [true, true]);

  part("Control: separate connections keep separate allowances");
  is("another /48 starts its own count", await withinLimit("x", `${clientAddress(from("2001:db8:9999:1::7"))}|shop`, 5, 60), true);
  const v4: boolean[] = [];
  for (let i = 0; i < 6; i += 1) v4.push(await withinLimit("z", `198.51.100.${i + 1}|shop`, 1, 60));
  is("each IPv4 address counts by itself", v4.every(Boolean), true);
  is("an IPv4 address written the new way is the same address", [await withinLimit("w", "203.0.113.9", 1, 60), await withinLimit("w", "::ffff:203.0.113.9", 1, 60)], [true, false]);
  is("a part that is not an address is kept as it is", [await withinLimit("v", "abc:def|shop", 1, 60), await withinLimit("v", "abc:dee|shop", 1, 60)], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
