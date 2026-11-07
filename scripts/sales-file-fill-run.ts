/**
 * Run by scripts/sales-file-fill.mjs against the real Redis (lib/redis.ts):
 * walks every store a SCAN page at a time (lib/sales-file-fill.ts) and fills
 * the sales file's short copies that are missing, or only counts them.
 *
 *   node scripts/sales-file-fill.mjs                          only counts, changes nothing
 *   node scripts/sales-file-fill.mjs --write --yes-production  writes what is missing
 *   node scripts/sales-file-fill.mjs --max-steps=50            stops after 50 pages of stores
 *
 * It prints the Redis host it is pointed at, what it found, and a cost line:
 * the commands and bytes it moved at Upstash's paid rates. Nothing is written
 * without --write --yes-production. The sales file's honest price may drop only
 * after a counting run that read every store says nothing is left
 * (nothingLeft): no sale and no product without its copy, nothing unreadable.
 */
import { addFill, emptyFill, fillSalesFileStep, nothingLeft, spendOf } from "@/lib/sales-file-fill";

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const host = (() => {
    try {
      return new URL(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "").host || "(none set)";
    } catch {
      return "(not a URL)";
    }
  })();
  console.log(`Redis: ${host}`);
  const write = flags.includes("--write");
  if (write && !flags.includes("--yes-production")) {
    console.error(`This writes to the data at ${host}. Run it again with --write --yes-production to go on.`);
    process.exitCode = 3;
    return;
  }
  const maxFlag = flags.find((flag) => flag.startsWith("--max-steps="));
  const maxSteps = maxFlag ? Number(maxFlag.slice("--max-steps=".length)) : 100_000;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    console.error("--max-steps= takes a whole number from 1 up.");
    process.exitCode = 2;
    return;
  }
  let total = emptyFill();
  let cursor = "0";
  let steps = 0;
  do {
    total = addFill(total, await fillSalesFileStep(cursor, write));
    cursor = total.next;
    steps += 1;
  } while (cursor !== "0" && steps < maxSteps);
  console.log(JSON.stringify({ ...total, steps, wrote: write }, null, 2));
  console.log(`Cost: ${total.commands} commands and ${total.bytes} bytes, about US$${spendOf(total).toFixed(6)} at Upstash's paid rates.`);
  if (cursor !== "0") console.log(`Stopped after ${steps} pages; run it again to go on (it starts over, and what is filled stays filled).`);
  else if (nothingLeft(total) && !write) console.log("Every store read: no sale and no product without its copy, nothing unreadable.");
  else console.log(write ? "Run it again without --write to count what is left." : "Copies are missing or unreadable: the sales file still reads those whole.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
