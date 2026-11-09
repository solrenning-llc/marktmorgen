/**
 * The ceiling on store addresses that lead nowhere must never take a real store off the air (coordinator's review of
 * claude5/unknown-store-ceiling, 9 November 2026). Whether an address has a store is decided by the small index read
 * storeForHandle already makes (nl:store:handle:<handle>), never by the company's ceiling: past the day's ceiling, or
 * with a count that cannot be read, a real store this server has not seen still opens, and a made-up address costs
 * only that small read, never the store's record. The lookup is counted before the read, in the same round trip.
 */
import { createHash } from "node:crypto";
import { claimHandle, storeForHandle, storeForVisitor } from "@/lib/store";
import { STORE_MISSES_PER_DAY, UNSEEN_STORE_LOOKUPS_PER_MINUTE, forgetStoreLookups } from "@/lib/store-lookup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const isCount = (c: Command) => /^(INCR|INCRBY|HINCRBY)$/.test(String(c[0])) && String(c[1]).startsWith("nl:store-lookup:");

/** Runs `run` with every count of the lookup answered `answer`, the rest as Redis answers it; returns what was sent. */
async function counted(answer: unknown, run: () => Promise<unknown>): Promise<Command[][]> {
  const original = redis.pipeline.bind(redis);
  const sent: Command[][] = [];
  redis.pipeline = async (cmds) => {
    sent.push(cmds);
    const out = await original(cmds);
    return answer === undefined ? out : out.map((value, i) => (isCount(cmds[i]!) ? answer : value));
  };
  try { await run(); } finally { redis.pipeline = original; }
  return sent;
}

const recordKey = (email: string) =>
  `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;

/** Commands `run` sends to the database. */
async function commandsOf(run: () => Promise<unknown>): Promise<number> {
  const original = redis.pipeline.bind(redis);
  let n = 0;
  redis.pipeline = async (cmds) => { n += cmds.length; return original(cmds); };
  try { await run(); } finally { redis.pipeline = original; }
  return n;
}

/**
 * Pre-review of 9 November 2026 (NÃO PRONTO): the pace counted every unseen address, real stores included, and the
 * memory of a miss outlived a claim. A real store is never paced, never remembered as missing and never costs more
 * than storeForHandle's own reads.
 */
async function realStores(): Promise<void> {
  const T = Date.UTC(2026, 10, 20, 12);
  part("Real stores browsed from one connection past the pace (a shared NAT, an IPv6 /48, a crawler) all open");
  forgetStoreLookups();
  for (let i = 0; i <= UNSEEN_STORE_LOOKUPS_PER_MINUTE; i++) await claimHandle(`real${i}@example.com`, `realshop${i}`, `Shop ${i}`, "");
  let dark = 0;
  for (let i = 0; i <= UNSEEN_STORE_LOOKUPS_PER_MINUTE; i++) if (!(await storeForVisitor(`realshop${i}`, { now: T, address: "100.64.0.1" }))) dark += 1;
  is("every real store opens for that connection", dark, 0);

  part("Made-up addresses from a connection never take a neighbour's real store off the air");
  forgetStoreLookups();
  for (let i = 0; i < UNSEEN_STORE_LOOKUPS_PER_MINUTE * 2; i++) await storeForVisitor(`madeup${i}x`, { now: T, address: "100.64.0.2" });
  is("the neighbour's real store opens", (await storeForVisitor("realshop0", { now: T + 1, address: "100.64.0.2" }))?.handle, "realshop0");

  part("A burst for one real store on a cold server, from one connection, all opens");
  forgetStoreLookups();
  const burst = await Promise.all(Array.from({ length: UNSEEN_STORE_LOOKUPS_PER_MINUTE + 5 }, () => storeForVisitor("realshop3", { now: T, address: "100.64.0.3" })));
  is("every concurrent request opens", burst.filter((s) => !s).length, 0);

  part("A free address asked about, then claimed: the new store opens at once");
  forgetStoreLookups();
  is("(setup) the free address leads nowhere", await storeForVisitor("brandnew", { now: T, address: "198.51.100.7" }), null);
  await claimHandle("brandnew@example.com", "brandnew", "Brand New", "");
  is("the visitor's lookup finds it right after the claim", (await storeForVisitor("brandnew", { now: T + 5_000, address: "198.51.100.7" }))?.handle, "brandnew");

  part("A record read empty once (the claim writes the index before the record) does not darken the store");
  forgetStoreLookups();
  await claimHandle("racer@example.com", "racer", "Racer", "");
  const key = recordKey("racer@example.com");
  const [raw] = await redis.pipeline([["GET", key]]);
  is("(setup) the record key is the one storeForHandle reads", typeof raw, "string");
  await redis.pipeline([["DEL", key]]);
  is("(setup) mid-claim, nothing to show", await storeForVisitor("racer", { now: T, address: "198.51.100.8" }), null);
  await redis.pipeline([["SET", key, raw as string]]);
  is("a moment later the store opens", (await storeForVisitor("racer", { now: T + 1_000, address: "198.51.100.9" }))?.handle, "racer");

  part("A real store's first lookup on a server costs what storeForHandle costs");
  forgetStoreLookups();
  const cold = await commandsOf(() => storeForVisitor("realshop1", { now: T, address: "203.0.113.1" }));
  const warm = await commandsOf(() => storeForVisitor("realshop1", { now: T + 1, address: "203.0.113.1" }));
  const before = await commandsOf(() => storeForHandle("realshop1"));
  console.log(`  cold ${cold}, warm ${warm}, storeForHandle ${before}`);
  is("cold and warm alike, no more than storeForHandle", [cold <= before, warm <= before], [true, true]);
}

async function main(): Promise<void> {
  redis.clear();
  for (const handle of ["realopen", "realopen2", "realopen3"]) await claimHandle(`${handle}@example.com`, handle, handle, "");

  part("Past the company's day, a real store this server has not seen still opens");
  forgetStoreLookups();
  await counted(STORE_MISSES_PER_DAY + 5, () => storeForVisitor("madeupone"));
  is("a real store opens past the ceiling", (await storeForVisitor("realopen"))?.handle, "realopen");
  const past = await counted(STORE_MISSES_PER_DAY + 6, () => storeForVisitor("madeuptwo"));
  const pastCommands = past.flat();
  is("a made-up address past it costs at most the small index read", pastCommands.filter((c) => !isCount(c)).length <= 1, true);
  is("and never the store's record", pastCommands.some((c) => String(c[1]).startsWith("nl:store:owner:")), false);

  part("A count that cannot be read never hides a real store");
  forgetStoreLookups();
  await counted("garbled", () => storeForVisitor("madeupthree"));
  is("a real store opens after an unreadable count", (await storeForVisitor("realopen2"))?.handle, "realopen2");

  part("The lookup is counted before the read, in the same round trip");
  forgetStoreLookups();
  const sent = await counted(undefined, () => storeForVisitor("madeupfour"));
  const read = sent.findIndex((cmds) => cmds.some((c) => c[0] === "GET" && c[1] === "nl:store:handle:madeupfour"));
  const count = sent.findIndex((cmds) => cmds.some(isCount));
  is("the count and the index read go together", [count, read], [0, 0]);
  is("a real store found this way is the store", (await storeForVisitor("realopen3"))?.handle, "realopen3");
  await realStores();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
