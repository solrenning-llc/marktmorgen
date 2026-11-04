/**
 * Run by scripts/move-repair.mjs against the real Redis (lib/redis.ts): shows
 * a broken move of an address, tries the automatic repair, and, only with the
 * address typed again after --clear=, clears the record without repairing.
 *
 *   node scripts/move-repair.mjs someone@example.com
 *   node scripts/move-repair.mjs someone@example.com --repair
 *   node scripts/move-repair.mjs someone@example.com --clear=someone@example.com
 */
import { clearBrokenMoveByHand, describeMove, repairMove } from "@/lib/move-repair";

async function main(): Promise<void> {
  const [address, ...flags] = process.argv.slice(2);
  if (!address) {
    console.error("Usage: node scripts/move-repair.mjs <address> [--repair | --clear=<the same address>]");
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(await describeMove(address), null, 2));
  if (flags.includes("--repair")) {
    console.log((await repairMove(address)) ? "Repaired: the ways in are with the store, and the record is gone." : "Not repaired: look at the state above.");
  }
  const clear = flags.find((flag) => flag.startsWith("--clear="));
  if (clear) {
    console.log((await clearBrokenMoveByHand(address, clear.slice("--clear=".length))) ? "Cleared, and both addresses logged out." : "Not cleared: type the same address after --clear=.");
  }
}

void main();
