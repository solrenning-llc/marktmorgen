/**
 * Board #5285, row #2612 (a Codex PR whose review findings stayed open when it merged; released by Claude 3, taken by
 * Claude 5 Jt9). Codex X5's LOWs (with Claude 1's LEVEs) still on main:
 *
 *   - takeSnsReceipt compared the pending value's time with Math.abs, so a run whose clock is more than the 35-second
 *     lease ahead of ours was taken as past its lease and taken over while it could still be acting on the notice.
 *   - docs/ses-delivery-events.md said the calculator charges "all eleven" commands on every retry, where the line
 *     right before it counts eighteen (MAIL_CALLBACK_COMMANDS_PER_ATTEMPT).
 *
 * Synthetic SNS keys; the in-memory Redis of tests/ses-dedup-ack-world.ts.
 */
import { readFileSync } from "node:fs";
import { SNS_RECEIPT_LEASE_MS, SNS_RECEIPT_SECONDS, takeSnsReceipt } from "@/lib/sns-receipt";
import { reset, world } from "./ses-dedup-ack-world";
import { done, is, part } from "./check";

const KEY = "nl:sns:seen:synthetic-sns-lease-2612";
const NOW = Date.UTC(2026, 10, 23, 15, 0, 0);
const pendingAt = (ms: number) => `${ms}.000000001`;
const held = () => world.redis.run(["GET", KEY]);

async function main(): Promise<void> {
  part("Another run's pending value whose time is ahead of our clock is busy, never taken over");
  for (const [label, ahead] of [["5 s ahead", 5_000], ["40 s ahead (past the lease)", SNS_RECEIPT_LEASE_MS + 5_000], ["an hour ahead", 3_600_000]] as const) {
    reset();
    const other = pendingAt(NOW + ahead);
    world.redis.run(["SET", KEY, other, "EX", SNS_RECEIPT_SECONDS]);
    is(`${label}: busy`, (await takeSnsReceipt(KEY, NOW)).state, "busy");
    is(`${label}: the other run's value stays`, held(), other);
  }

  part("Control: a pending value past its lease is still taken over");
  reset();
  world.redis.run(["SET", KEY, pendingAt(NOW - SNS_RECEIPT_LEASE_MS - 1_000), "EX", SNS_RECEIPT_SECONDS]);
  is("a value 36 s old is taken over", (await takeSnsReceipt(KEY, NOW)).state, "ours");
  reset();
  world.redis.run(["SET", KEY, pendingAt(NOW - 1_000), "EX", SNS_RECEIPT_SECONDS]);
  is("a value 1 s old is busy", (await takeSnsReceipt(KEY, NOW)).state, "busy");

  part("A time further ahead than the key can live is no live run's, and is taken over");
  reset();
  world.redis.run(["SET", KEY, pendingAt(NOW + SNS_RECEIPT_SECONDS * 1000 + 60_000), "EX", SNS_RECEIPT_SECONDS]);
  is("a value more than a day ahead is taken over, so a damaged time never holds the notice for its whole life", (await takeSnsReceipt(KEY, NOW)).state, "ours");

  part("The delivery-events note counts the commands the line before it counts");
  const doc = readFileSync("docs/ses-delivery-events.md", "utf8");
  is("no 'all eleven on every retry'", doc.includes("charges all eleven on every retry"), false);
  is("'all eighteen on every retry'", doc.includes("charges all eighteen on every retry"), true);

  done();
}

void main();
