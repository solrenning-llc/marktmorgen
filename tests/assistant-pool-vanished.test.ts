/**
 * The Store assistant's month (lib/store-assistant.ts, ASSISTANT_POOL) is never opened twice: a pool that was opened
 * and is then gone before its month ends (a key lost, evicted or deleted) is not known, so nothing more is reserved
 * from it, rather than a whole fresh pool spent on top of the one already used. Synthetic data only.
 */
import { pool } from "@/lib/store-assistant";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "s".repeat(24);
const WINDOW = "2026-11-01";
const KEY = `nl:assist:pool:${STATS}:${WINDOW}`;

async function main(): Promise<void> {
  part("A month's pool gone before its month ends refuses, never a fresh pool");
  redis.clear();
  is("the month opens and is spent to its cap", [await pool("reserve", STATS, WINDOW, 1_000, 1_000), await pool("settle", STATS, WINDOW, 1_000, 1_000), await pool("reserve", STATS, WINDOW, 1, 1_000)], [1, 1, 0]);
  redis.run(["DEL", KEY]);
  is("the pool is lost: nothing more is reserved for the month", await pool("reserve", STATS, WINDOW, 1_000, 1_000), -1);
  is("and nothing is written in its place", redis.run(["EXISTS", KEY]), 0);

  part("A month never opened opens once");
  redis.clear();
  is("opened", await pool("reserve", STATS, WINDOW, 10, 1_000), 1);
  is("settled", await pool("settle", STATS, WINDOW, 10, 4), 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
