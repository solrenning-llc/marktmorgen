/**
 * Run by scripts/move-repair.mjs against the real Redis (lib/redis.ts): shows
 * a broken move of an address, tries the automatic repair, and, only with the
 * address typed again after --clear=, clears the record without repairing.
 *
 *   node scripts/move-repair.mjs someone@example.com
 *   node scripts/move-repair.mjs someone@example.com --repair --yes-production
 *   node scripts/move-repair.mjs someone@example.com --clear=someone@example.com --yes-production
 *
 * It prints the Redis host it is pointed at, and changes nothing without
 * --yes-production. --clear is refused while the state is split.
 */
import { clearBrokenMoveByHand, describeMove, repairMove } from "@/lib/move-repair";

async function main(): Promise<void> {
  const [address, ...flags] = process.argv.slice(2);
  if (!address) {
    console.error("Usage: node scripts/move-repair.mjs <address> [--repair | --clear=<the same address>] [--yes-production]");
    process.exitCode = 2;
    return;
  }
  const host = (() => {
    try {
      return new URL(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "").host || "(none set)";
    } catch {
      return "(not a URL)";
    }
  })();
  console.log(`Redis: ${host}`);
  console.log(JSON.stringify(await describeMove(address), null, 2));
  const changes = flags.includes("--repair") || flags.some((flag) => flag.startsWith("--clear="));
  if (changes && !flags.includes("--yes-production")) {
    console.error(`This changes the data at ${host}. Run it again with --yes-production to go on.`);
    process.exitCode = 3;
    return;
  }
  if (flags.includes("--repair")) {
    console.log((await repairMove(address)) ? "Repaired: the ways in are with the store, and the record is gone." : "Not repaired: look at the state above.");
  }
  const clear = flags.find((flag) => flag.startsWith("--clear="));
  if (clear) {
    const answer = await clearBrokenMoveByHand(address, clear.slice("--clear=".length));
    console.log(
      answer === "cleared"
        ? "Cleared, and both addresses logged out."
        : answer === "split"
          ? "Not cleared: the store is on one address and its passkeys or app on the other. Clearing would let the emailed link in with no second step; repair it, or move the ways in by hand first."
          : answer === "running"
            ? "Not cleared: a move of one of these addresses is running now. Wait for it to end."
            : answer === "confirm"
            ? "Not cleared: type the same address after --clear=."
            : answer === "sessions"
            ? "Not cleared: logging out one of the addresses could not be confirmed. Nothing was cleared; run it again."
            : "Nothing to clear: this address has no broken move.",
    );
  }
}

void main();
