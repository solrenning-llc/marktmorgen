/**
 * What a contact's checked write costs in database commands, at its worst, held (review of #3448 by Claude 3,
 * MEDIUM 2, rules 26 and 27). Upstash bills a script as one command plus every redis.call it runs
 * (lib/capped-count.ts), so a script counts as 1 + what is inside it, not as 1. Before this, the worst case of
 * upsertContact was written down as 21 commands with the script counted once, and unsubscribe, tokensFor and
 * takeBackClicks gained commands that no line named.
 *
 * The figures come from lib/contacts.ts (CONTACT_WRITE_CALLS, CONTACT_COMMANDS_MOST); this holds that they are the
 * script's own calls, that one round of each path really stays inside them, and that they are named where the
 * paths are paid for (tests/plan-cost-registry.ts). The room's own charge scripts (lib/store-data.ts) are priced
 * by the data room's line and are left out of every count here.
 */
import { readFileSync } from "node:fs";
import { CONTACT_COMMANDS_MOST, CONTACT_WRITE_CALLS, CONTACT_WRITE_IF, leadsKey, noteProduct, takeBackClicks, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { COMMAND, ORDER_COMPUTE } from "./plan-cost-registry";
import { COMMANDS } from "./traffic-cost";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);

/** Commands as Upstash bills them for one trip: each command 1, a script 1 plus the calls it makes inside. */
function billed(commands: Commands, scriptCalls: number): number {
  let total = 0;
  for (const c of commands) {
    const head = String(c[1] ?? "");
    if (c[0] !== "EVAL") total += 1;
    else if (head.startsWith("-- marktmorgen:store-data:")) continue;
    else if (head.startsWith("-- marktmorgen:contact-write-if:v1")) total += 1 + scriptCalls;
    else if (head.startsWith("-- marktmorgen:contact-cas-hset:v1")) total += 1 + 2 * ((c.length - 4) / 3);
    else total += 1000; // a script this test does not know is not free
  }
  return total;
}

/** `scriptCalls`: what CONTACT_WRITE_IF runs for the path measured (an unsubscribe: the row, the row written, the left count). */
async function measure(run: () => Promise<unknown>, scriptCalls = CONTACT_WRITE_CALLS): Promise<number> {
  let sum = 0;
  redis.pipeline = async (commands: Commands) => {
    sum += billed(commands, scriptCalls);
    return real(commands);
  };
  try {
    await run();
  } finally {
    redis.pipeline = real;
  }
  return sum;
}

async function main() {
  redis.clear();

  part("the script's calls");
  {
    const written = (CONTACT_WRITE_IF.match(/redis\.call\(/g) ?? []).length;
    // The counts line holds INCR and DECR as alternatives, of which one runs.
    is("CONTACT_WRITE_CALLS is the most redis.call a run of CONTACT_WRITE_IF makes (the INCR/DECR pair counted once)", CONTACT_WRITE_CALLS, written - 1);
    is("and it is the eight it was reviewed at: two reads, the row, the lifted mark, both counts, the stores joined (2)", CONTACT_WRITE_CALLS, 8);
  }

  part("the worst case of each path, scripts counted by what they run");
  {
    const t = CONTACT_COMMANDS_MOST;
    is("a sign-up's round: its 3 reads, the mark's time, the script and its calls", t.upsertRound, 3 + 1 + 1 + CONTACT_WRITE_CALLS);
    is("a sign-up at the most: 3 rounds lost, and the 2 reads that read an unknown answer back", t.upsert, t.tries * t.upsertRound + 2);
    is("an unsubscribe round: the link, the row, the script and its 3 calls (row, row written, left)", t.unsubscribeRound, 1 + 1 + 1 + 3);
    is("an unsubscribe at the most", t.unsubscribe, t.tries * t.unsubscribeRound);
    is("a purchase noted: the row, the checked write (1 + 2) and, once, its read back", [t.noteProductRound, t.noteProduct], [4, t.tries * 4 + 1]);
    is("taking back the permission: the row, the checked write (1 + 2) and, once, its read back", [t.takeBackRound, t.takeBack], [4, t.tries * 4 + 1]);
    is("links for n addresses: per round both reads, a record and a checked write (1 + 2) and a taken-back record each", [t.tokens(1), t.tokens(10)], [t.tries * (2 + 1 + 3 + 1), t.tries * (2 + 10 * (1 + 3 + 1))]);
    is("an order's sign-up is inside the order's own compute", t.upsert * COMMAND <= ORDER_COMPUTE, true);
  }

  part("one round of each really stays inside its figure");
  {
    const list = "cost_list", email = "cost@example.com";
    const sid = "0123456789abcdef0123456789abcdef";
    const first = await measure(() => upsertContact(list, email, { agreed: true, explicit: true, source: "free", sid }, ROOM));
    is("a new sign-up, no race", first <= CONTACT_COMMANDS_MOST.upsertRound, true);
    is("and it stays inside a later page's commands, as a public request's work does", first + 2 <= COMMANDS.laterPage + COMMANDS.laterCount, true);
    const again = await measure(() => upsertContact(list, email, { agreed: true, explicit: true, source: "free", sid, productId: "p1", title: "T" }, ROOM));
    is("a sign-up over an existing row, no race", again <= CONTACT_COMMANDS_MOST.upsertRound, true);
    const note = await measure(() => noteProduct(list, email, "p2", "Two", { sid: "", statsId: "", handle: "" }));
    is("a purchase noted", note <= CONTACT_COMMANDS_MOST.noteProductRound, true);
    const token = (await tokensFor(list, [email], "h")).get(email) ?? "";
    is("control: the link exists", token.length > 0, true);
    const second = await measure(() => tokensFor(list, [email, "other@example.com"], "h"));
    is("links already made: both reads", second <= 2, true);
    await upsertContact(list, "fresh@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
    const made = await measure(() => tokensFor(list, ["fresh@example.com"], "h"));
    is("a link made", made <= CONTACT_COMMANDS_MOST.tokens(1) / CONTACT_COMMANDS_MOST.tries, true);
    await upsertContact(list, "clicks@example.com", { agreed: true, explicit: true, source: "free", clicks: true }, ROOM);
    const back = await measure(() => takeBackClicks(list, "clicks@example.com"));
    is("taking back the permission", back <= CONTACT_COMMANDS_MOST.takeBackRound, true);
    const left = await measure(() => unsubscribe(token), 3);
    is("an unsubscribe", left <= CONTACT_COMMANDS_MOST.unsubscribeRound, true);
    is("control: the row was written", String(redis.run(["HGET", leadsKey(list), email])).includes('"unsub":true'), true);
  }

  // Codex Z on #3448 (6751568157, MEDIUM): only a healthy round was held against the public request that pays for a
  // sign-up; a sign-up whose row another writer changed between the read and the write went round again, up to
  // CONTACT_WRITE_TRIES times, past what that request pays for (19 commands measured against 18).
  part("a contested sign-up from a public request stays inside what the request pays for");
  {
    const list = "contested_list", email = "contested@example.com";
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    let losses = 2;
    let sum = 0;
    redis.pipeline = async (commands: Commands) => {
      // Another writer changes the row just before each of the first two checked writes: theirs is not counted here.
      if (losses > 0 && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:contact-write-if:v1"))) {
        losses -= 1;
        const [row] = await real([["HGET", leadsKey(list), email]]);
        await real([["HSET", leadsKey(list), email, String(row).replace(/"lastAt":"[^"]*"/, `"lastAt":"2026-01-0${losses + 1}T00:00:00.000Z"`)]]);
      }
      sum += billed(commands, CONTACT_WRITE_CALLS);
      return real(commands);
    };
    let outcome = "written";
    try {
      await upsertContact(list, email, { agreed: true, explicit: true, source: "free", productId: "p9", title: "Nine" }, ROOM);
    } catch {
      outcome = "refused";
    } finally {
      redis.pipeline = real;
    }
    is(`a contested sign-up's commands stay inside a later page's (${sum} against ${COMMANDS.laterPage + COMMANDS.laterCount})`, sum <= COMMANDS.laterPage + COMMANDS.laterCount, true);
    is("and the figure for it says so", CONTACT_COMMANDS_MOST.upsertPublic <= COMMANDS.laterPage + COMMANDS.laterCount, true);
    is("it is refused, for the visitor to try again, never written over what changed", outcome, "refused");
  }

  part("named where the paths are paid for");
  {
    const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
    for (const name of ["CONTACT_COMMANDS_MOST", "CONTACT_WRITE_CALLS"]) is(`tests/plan-cost-registry.ts names ${name}`, registry.includes(name), true);
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
