/**
 * Every per-connection limit counts an IPv6 client by its /64, not by the exact address it sent (#4628).
 *
 * lib/request-guard.ts keyed withinLimit and essentialLimitState on `who` as given, and the callers build it from
 * clientAddress, the exact x-forwarded-for. One IPv6 customer holds at least a /64, so every request of theirs could
 * come from a new address and find a new allowance: the checkout's, the free copy's, the hits', the API key's. The
 * key is now made from the connection of each part of `who` that is an IPv6 address, in one place, for every caller.
 * A /64, as visitorAddress in lib/traffic-rules.ts counts one: not a /48, which a mobile carrier shares among
 * thousands of subscribers, so one of them could use up a site-wide limit for all the others (Claude 7 on #4637).
 * An IPv4 address counts by itself. Every caller keeps the address in a "|" part of its own, and the affiliate
 * keys use the same grouping.
 *
 * Synthetic requests; MemoryRedis.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clientAddress, essentialLimitState, limitAddress, withinLimit } from "@/lib/request-guard";
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

  part("The same for an essential limit, within one /64");
  const states: string[] = [];
  for (let i = 0; i < 20; i += 1) states.push(await essentialLimitState("y", clientAddress(from(`2001:db8:5:7:${(i + 1).toString(16)}::1`)), 3, 60));
  is("three within, then exceeded", [states.slice(0, 3).every((s) => s === "within"), states.slice(3).every((s) => s === "exceeded")], [true, true]);

  part("Control: separate connections keep separate allowances");
  is("another /64 of the same /48 starts its own count (a carrier's other subscriber)", await withinLimit("x", `${clientAddress(from("2001:db8:0:2::7"))}|shop`, 5, 60), true);
  const neighbours: string[] = [];
  for (let i = 0; i < 20; i += 1) neighbours.push(await essentialLimitState("u", clientAddress(from(`2001:db8:5:${(i + 1).toString(16)}::1`)), 3, 60));
  is("twenty /64s of one /48 are twenty connections, never locked out together", neighbours.every((s) => s === "within"), true);
  is("the connection is the /64", [limitAddress("2001:DB8:0:1:abcd::7"), limitAddress("2001:db8::1"), limitAddress("198.51.100.4")], ["2001:db8:0:1::/64", "2001:db8:0:0::/64", "198.51.100.4"]);
  is("another /48 starts its own count", await withinLimit("x", `${clientAddress(from("2001:db8:9999:1::7"))}|shop`, 5, 60), true);
  is("the hex IPv4-mapped form is that IPv4 address, not a shared bucket", [limitAddress("::ffff:cb00:7109"), limitAddress("::ffff:c633:6404")], ["203.0.113.9", "198.51.100.4"]);
  is("brackets, a port and a zone are not part of the address", [limitAddress("[2001:db8:0:1::7]:443"), limitAddress("[2001:db8:0:1::8]"), limitAddress("2001:db8:0:1::9%eth0")], ["2001:db8:0:1::/64", "2001:db8:0:1::/64", "2001:db8:0:1::/64"]);
  const v4: boolean[] = [];
  for (let i = 0; i < 6; i += 1) v4.push(await withinLimit("z", `198.51.100.${i + 1}|shop`, 1, 60));
  is("each IPv4 address counts by itself", v4.every(Boolean), true);
  is("an IPv4 address written the new way is the same address", [await withinLimit("w", "203.0.113.9", 1, 60), await withinLimit("w", "::ffff:203.0.113.9", 1, 60)], [true, false]);
  is("a part that is not an address is kept as it is", [await withinLimit("v", "abc:def|shop", 1, 60), await withinLimit("v", "abc:dee|shop", 1, 60)], [true, true]);

  part("Every caller keeps the address in a part of its own");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
  // Joined to another part with ":", an IPv6 address is not read as one and counts exactly again (Claude 7 on #4637).
  // Two callers wait on their files' reservations (docs/reservations/codex.md, Codex N): changed once released.
  const waiting = new Set(["lib/store-join.ts", "lib/waitlist.ts"]);
  const limits = /\b(?:withinLimit|withinStore|withinEssentialLimit|essentialLimitState|essentialTakeBelow|withinServiceWhy|withinService)\(\s*"[^"]+",\s*`[^`]*:\$\{[^}]*\b(?:ip|address|clientAddress\([^)]*\))\}`/;
  const joined = [...files("lib"), ...files("app")].filter((f) => !waiting.has(f.replace(/\\/g, "/")) && limits.test(readFileSync(f, "utf8")));
  is("no limit joins an address to another part with \":\"", joined, []);
  const aff = readFileSync("lib/affiliates.ts", "utf8");
  is("the affiliate click and apply counters use the same grouping", [/clickIpKey = [^\n]*limitAddress\(ip\)/.test(aff), /applyIpKey = [^\n]*limitAddress\(ip\)/.test(aff)], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
