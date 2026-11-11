/**
 * CX-123 rule 24, lot L10b: a custom domain is claimed for a store (lib/domain-proof.ts proveDomain) with a SET NX of
 * "?<handle>" before its TXT record is looked for. A reply to it in any shape but "OK" or nil is read back: the key
 * holding this store's claim is ours; another store's claim is "taken"; nothing readable is "waiting", and the DNS is
 * not asked this time (the creator's next check asks again). The DNS is played by a stand-in for resolveTxt.
 */
import dns from "node:dns/promises";
import { proofRecord } from "@/lib/domains";
import { proveDomain } from "@/lib/domain-proof";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx } from "./l10b-replies";

const store = { sid: "l10bdomainstore00000000000000001", handle: "lmine", previousHandles: [] as string[] };
let asked = 0;
(dns as { resolveTxt: (host: string) => Promise<string[][]> }).resolveTxt = async (host: string) => {
  asked += 1;
  const name = host.replace(/^_marktmorgen\./, "");
  return [[proofRecord(store, name).value]];
};

/** The stand-in runs no Lua: lib/domain-proof.ts's swap (set only while the key holds the value expected), played here. */
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('if redis.call("GET", KEYS[1]) ~= ARGV[1]')) {
    const [, script, , key, expected, next] = commands[0].map(String);
    if (redis.run(["GET", key]) !== expected) return [0];
    redis.run(script.includes("KEEPTTL") ? ["SET", key, next, "KEEPTTL"] : ["SET", key, next]);
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const KEY = "nl:domain:";
let n = 0;
const domain = () => `shop${(n += 1)}.l10b.invalid`;

async function main(): Promise<void> {
  redis.clear();

  part("The plain case: claimed, its record found, proved");
  const plain = domain();
  asked = 0;
  is("proved, the DNS asked once", [await proveDomain(store, plain), asked, redis.run(["GET", `${KEY}${plain}`])], ["proved", 1, "lmine"]);

  part("Claimed a moment ago by another store: taken, the DNS not asked");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const name = domain();
    asked = 0;
    answer(setNx(`${KEY}${name}`), reply, { before: () => void redis.run(["SET", `${KEY}${name}`, "?another", "EX", 600]) });
    is(`the claim answered with ${shape} while another store holds it: taken`, [await proveDomain(store, name), asked, redis.run(["GET", `${KEY}${name}`])], ["taken", 0, "?another"]);
  }

  part("The claim written and its answer lost: this store's claim read back, proved");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const name = domain();
    answer(setNx(`${KEY}${name}`), reply);
    is(`answered with ${shape}, the write landed: proved`, [await proveDomain(store, name), redis.run(["GET", `${KEY}${name}`])], ["proved", "lmine"]);
  }

  part("Nothing readable: waiting, the DNS not asked, nothing proved");
  for (const [shape, reply] of [...UNREADABLE, ["the write failing too", THROWS] as const]) {
    clearAnswers();
    const name = domain();
    asked = 0;
    answer(setNx(`${KEY}${name}`), shape === "the write failing too" ? THROWS : () => ["QUEUED"], { run: false });
    answer(getOf(`${KEY}${name}`), reply);
    const got = await proveDomain(store, name).catch(() => "threw");
    is(`the claim unknown and its read-back ${shape}: waiting, the DNS not asked`, [got, asked], ["waiting", 0]);
  }
  clearAnswers();
  done();
}

void main();
