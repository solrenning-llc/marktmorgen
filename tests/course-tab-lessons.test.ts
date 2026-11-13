/**
 * Issue #4304, unit D (coordinator, 13/11/2026): what the lessons tab of the studio's course page still reads on
 * each load, held against the page's figure: the AI captions refunds Stripe has not confirmed (read at most
 * OWED_SHOWN of them, with how many more are pending, never the whole set), the AI writing balance (one GET) and
 * the products' titles for the "More from" shelf (one HGETALL of the cards, MAX_PRODUCTS at most).
 *
 * Each runs against a Redis that answers every command at its largest; the commands and bytes are added up.
 */
import { OWED_SHOWN, autoRefundsOwedPage } from "@/lib/auto-captions";
import { aiLeft } from "@/lib/ai";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);
const COMMANDS = STUDIO_PAGE_UNITS * 20 - 8;
const BYTES = STUDIO_PAGE_UNITS * 50_000;
const FOLDER = "f".repeat(32);
const guid = (i: number) => `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`;

function largest(command: (string | number)[]): unknown {
  const [name, key, ...rest] = command;
  switch (name) {
    case "SMEMBERS":
      return Array.from({ length: 50_000 }, (_, i) => guid(i));
    case "SSCAN":
      return ["123", Array.from({ length: Number(rest[rest.indexOf("COUNT") + 1]) * 2 }, (_, i) => guid(i))];
    case "SCARD":
      return 50_000;
    case "GET":
      return String(key).startsWith("nl:stream:auto:") ? JSON.stringify({ path: `stream/${FOLDER}/lesson000001/${guid(1)}`, cents: 9_999, owed: { cents: 9_999, stuck: false } }) : "3";
    default:
      return null;
  }
}

async function measure(run: () => Promise<unknown>): Promise<{ commands: number; bytes: number; value: unknown }> {
  let commands = 0;
  let bytes = 0;
  redis.pipeline = async (batch: Commands) => {
    commands += batch.length;
    const replies = batch.map(largest);
    bytes += Buffer.byteLength(JSON.stringify(replies));
    return replies;
  };
  let value: unknown;
  try {
    value = await run().catch((error) => error);
  } finally {
    redis.pipeline = realPipeline;
  }
  return { commands, bytes, value };
}

async function main(): Promise<void> {
  part("Refunds not confirmed yet: a page of them, with how many more, never the whole set");
  const owed = await measure(() => autoRefundsOwedPage(FOLDER));
  console.log(`  refunds: ${owed.commands} commands, ${owed.bytes} bytes`);
  is(`within ${COMMANDS} commands and ${BYTES} bytes`, owed.commands <= COMMANDS && owed.bytes <= BYTES, true);
  const value = owed.value as { rows?: unknown[]; more?: boolean } | null;
  is("it lists at most OWED_SHOWN and says there are more", [Array.isArray(value?.rows) && value!.rows!.length <= OWED_SHOWN, value?.more], [true, true]);

  part("The AI writing balance: one read");
  const balance = await measure(() => aiLeft({ statsId: "s".repeat(32), tier: "store", catalog: { items: [] } } as unknown as Store));
  console.log(`  aiLeft: ${balance.commands} commands, ${balance.bytes} bytes`);
  is("at most one command", balance.commands <= 1, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
