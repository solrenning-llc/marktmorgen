/**
 * #4790 (rule 24, exact reads): the erasure steps that forget a person's
 * checkout reminder marks (forgetRecoveryPerson, lib/checkout-recovery.ts) and
 * come-back offer marks (forgetWinbackPerson, lib/winback-send.ts) each send one
 * DEL of N keys. Its count confirms the step only as a whole number from 0 to N;
 * anything else, a count above N included, throws UnknownReplyError so the
 * erasure stays incomplete and repeatable, never "done".
 *
 * Synthetic data, in-memory Redis; nothing leaves this machine.
 */
import { forgetRecoveryPerson } from "@/lib/checkout-recovery";
import { forgetWinbackPerson } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Step = (statsId: string, productIds: string[], email: string) => Promise<number>;
const STATS = "s".repeat(32);
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

/** Runs one step with its DEL's reply forged; returns its count of the keys sent, or the error's name. */
async function forget(step: Step, products: string[], reply: unknown): Promise<string> {
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
    const count = await step(STATS, products, "buyer@example.test");
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

  for (const [name, step] of [["come-back marks", forgetWinbackPerson], ["reminder marks", forgetRecoveryPerson]] as [string, Step][]) {
    part(`${name}: a DEL of N keys confirms 0 to N, nothing else`);
    is("control: 0 of one key", await forget(step, ["prod1"], 0), "0 of 1");
    is("control: 1 of one key", await forget(step, ["prod1"], 1), "1 of 1");
    is("control: 2 of two keys", await forget(step, ["prod1", "prod2"], 2), "2 of 2");
    is("2 for one key throws UnknownReplyError", await forget(step, ["prod1"], 2), "UnknownReplyError");
    is("3 for two keys throws UnknownReplyError", await forget(step, ["prod1", "prod2"], 3), "UnknownReplyError");
    is("a huge count throws UnknownReplyError", await forget(step, ["prod1"], Number.MAX_SAFE_INTEGER), "UnknownReplyError");
    is("a negative count throws UnknownReplyError", await forget(step, ["prod1"], -1), "UnknownReplyError");
    is("a fraction throws UnknownReplyError", await forget(step, ["prod1", "prod2"], 1.5), "UnknownReplyError");
    is("text throws UnknownReplyError", await forget(step, ["prod1"], "1"), "UnknownReplyError");
    is("a missing reply throws UnknownReplyError", await forget(step, ["prod1"], undefined), "UnknownReplyError");
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
