/**
 * #4797 (rule 24, exact reads): forgetRecoveryPerson (lib/checkout-recovery.ts)
 * sends one DEL with one key per product. Its count confirms the step only as a
 * whole number from 0 up to the number of keys sent; a larger count does not
 * match the command that ran, so it throws UnknownReplyError and the erasure
 * stays incomplete and repeatable, never "done".
 *
 * Synthetic data, in-memory Redis; nothing leaves this machine.
 */
import { forgetRecoveryPerson } from "@/lib/checkout-recovery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const STATS = "s".repeat(32);
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

/** Runs the step with the DEL's reply forged; returns its count, or the error's name. */
async function forget(products: string[], reply: unknown): Promise<string> {
  redis.clear();
  let sent = 0;
  redis.pipeline = (async (commands: Command[]) => {
    const answers = await original(commands);
    if (commands.length === 1 && commands[0][0] === "DEL") {
      sent = commands[0].length - 1;
      return [reply];
    }
    return answers;
  }) as typeof redis.pipeline;
  try {
    const count = await forgetRecoveryPerson(STATS, products, "gone@example.test");
    return `${count} of ${sent}`;
  } catch (error) {
    return error instanceof Error ? error.name : "rejected";
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("A DEL of one key: 0 or 1 confirms, anything above is unknown");
  is("control: 0 is accepted", await forget(["prod1"], 0), "0 of 1");
  is("control: 1 is accepted", await forget(["prod1"], 1), "1 of 1");
  is("2 for one key throws UnknownReplyError", await forget(["prod1"], 2), "UnknownReplyError");

  part("A DEL of two keys: 0 to 2 confirms, 3 is unknown");
  is("control: 2 of two keys is accepted", await forget(["prod1", "prod2"], 2), "2 of 2");
  is("3 for two keys throws UnknownReplyError", await forget(["prod1", "prod2"], 3), "UnknownReplyError");
  is("a huge count throws UnknownReplyError", await forget(["prod1", "prod2"], Number.MAX_SAFE_INTEGER), "UnknownReplyError");

  part("A product named twice: DEL removes at most one per distinct key (review of the same family, as lib/discord-access.ts)");
  is("control: 1 for the same key sent twice is accepted", await forget(["prod1", "prod1"], 1), "1 of 2");
  is("2 for one distinct key sent twice throws UnknownReplyError", await forget(["prod1", "prod1"], 2), "UnknownReplyError");

  part("Other shapes stay unknown");
  is("a negative count", await forget(["prod1"], -1), "UnknownReplyError");
  is("a fraction", await forget(["prod1"], 0.5), "UnknownReplyError");
  is("text", await forget(["prod1"], "1"), "UnknownReplyError");
  is("a missing reply", await forget(["prod1"], undefined), "UnknownReplyError");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
