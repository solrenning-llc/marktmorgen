/**
 * Claude 5's review proof for #2676 (head 834878cb): MEMORY_FORGET_COMMANDS
 * is said to be forgetMemory's worst. The worst try of review-2556-delta3 has
 * no notes and no lock held, so it never reaches it; this counts forgetMemory
 * itself at its worst: the lock held by another change for the whole wait
 * (every SET NX refused, then taken over), the record removed (room given
 * back) and the release script failing (GET and DEL instead). Synthetic only.
 */
import { MEMORY_FORGET_COMMANDS, forgetMemory, keepNote } from "@/lib/assistant-memory-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  part("forgetMemory at its worst stays within MEMORY_FORGET_COMMANDS");
  const STATS = "st_c5_amem";
  const room = { sid: "c".repeat(32), statsId: STATS, subscriptionActive: true, subscriptionId: "sub_x", trialEnds: 0, planEndedAt: "" };
  const kept = await keepNote(STATS, { kind: "instruction", text: "Keep each answer short." }, room as never);
  is("a note is kept first", "ok" in kept && kept.ok, true);
  await real([["SET", `nl:amem:lock:${STATS}`, "someone-else", "EX", 60]]);
  let counted = 0;
  let sets = 0;
  redis.pipeline = async (commands: Command[]) => {
    counted += commands.length;
    for (const c of commands) if (c[0] === "SET" && c[3] === "NX") sets += 1;
    const c = commands[0];
    if (commands.length === 1 && c[0] === "EVAL" && !String(c[1]).includes("amem-forget") && !String(c[1]).includes("store-data")) throw new Error("NOSCRIPT simulated");
    return real(commands);
  };
  await forgetMemory(STATS, room as never);
  redis.pipeline = real;
  is("the note is gone", redis.run(["GET", `nl:amem:${STATS}`]), null);
  console.log(`  (counted ${counted} commands, ${sets} SET NX tries; MEMORY_FORGET_COMMANDS = ${MEMORY_FORGET_COMMANDS})`);
  is("commands within MEMORY_FORGET_COMMANDS", counted <= MEMORY_FORGET_COMMANDS ? "within" : `${counted} > ${MEMORY_FORGET_COMMANDS}`, "within");
  done();
}

void main();
