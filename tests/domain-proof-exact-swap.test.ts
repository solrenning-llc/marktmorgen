/**
 * MÉDIO of Codex V's review at eeeada8077 on #4248: proveDomain read the compare-and-set swap's reply as
 * Number(won) === 1, so a reply in an unconfirmed but coercible shape ([true], ["1"], ["01"]) was certified as
 * "proved" while the key still held another store's claim. Only an exact 1 is a swap done, an exact 0 a race lost,
 * and anything else is settled by reading the key again exactly: "proved" only when it holds this store. Every swap
 * of proveDomain is read this way. Synthetic: resolveTxt and the swap's replies are stand-ins.
 */
import dns from "node:dns/promises";
import { domainKey, proofRecord } from "@/lib/domains";
import { proveDomain } from "@/lib/domain-proof";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const owner = { sid: "sexactowner00000000000000000000001", handle: "realowner", previousHandles: ["oldowner"] };
(dns as { resolveTxt: (host: string) => Promise<string[][]> }).resolveTxt = async (host: string) => [[proofRecord(owner, host.replace(/^_marktmorgen\./, "")).value]];

/** What the swap answers, and whether it really swapped first. */
let reply: unknown[] = [1];
let applies = true;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('if redis.call("GET", KEYS[1]) ~= ARGV[1]')) {
    const [, script, , key, expected, next] = commands[0].map(String);
    if (applies && redis.run(["GET", key]) === expected) redis.run(script.includes("KEEPTTL") ? ["SET", key, next, "KEEPTTL"] : ["SET", key, next]);
    return reply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

let n = 0;
const domain = () => `exact${(n += 1)}.creator4248.com`;
const held = (name: string) => redis.run(["GET", domainKey(name)]);

async function main(): Promise<void> {
  redis.clear();
  const shapes: [string, unknown[]][] = [["[true]", [true]], ['["1"]', ["1"]], ['["01"]', ["01"]], ["[]", []], ["[null]", [null]]];

  part("Taking another store's unproved claim: an unconfirmed reply never certifies a swap that did not happen");
  for (const [shape, value] of shapes) {
    const name = domain();
    redis.run(["SET", domainKey(name), "?squatter"]);
    reply = value;
    applies = false;
    is(`${shape}, not swapped: not proved, the claim kept`, [await proveDomain(owner, name).catch(() => "unknown"), held(name)], ["waiting", "?squatter"]);
  }
  part("An unconfirmed reply after a swap that did happen is settled by reading the key: proved");
  for (const [shape, value] of shapes) {
    const name = domain();
    redis.run(["SET", domainKey(name), "?squatter"]);
    reply = value;
    applies = true;
    is(`${shape}, swapped: proved, the key holds this store`, [await proveDomain(owner, name), held(name)], ["proved", "realowner"]);
  }
  part("The same for this store's own claim, and under an older address");
  for (const [shape, value] of shapes) {
    const own = domain();
    redis.run(["SET", domainKey(own), "?realowner"]);
    reply = value;
    applies = false;
    is(`own claim, ${shape}, not swapped: not proved`, [await proveDomain(owner, own).catch(() => "unknown"), held(own)], ["waiting", "?realowner"]);
    const old = domain();
    redis.run(["SET", domainKey(old), "oldowner"]);
    is(`older address, ${shape}, not moved: not proved`, [await proveDomain(owner, old).catch(() => "unknown"), held(old)], ["waiting", "oldowner"]);
  }
  part("Controls: an exact 1 swaps, an exact 0 is a race lost");
  applies = true;
  reply = [1];
  const ok = domain();
  redis.run(["SET", domainKey(ok), "?squatter"]);
  is("exact 1: proved", [await proveDomain(owner, ok), held(ok)], ["proved", "realowner"]);
  reply = [0];
  applies = false;
  const lost = domain();
  redis.run(["SET", domainKey(lost), "?squatter"]);
  is("exact 0: waiting, the claim kept", [await proveDomain(owner, lost), held(lost)], ["waiting", "?squatter"]);
  done();
}
void main();
