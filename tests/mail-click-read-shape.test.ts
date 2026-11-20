/**
 * A condition on a sequence email may use whether each reader used a link in
 * the previous email.  Unknown Redis evidence must never become "did not
 * click": that would let an `unclicked` branch send an email on a guess.
 */
import { usedLinkIn } from "@/lib/mail-clicks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const emails = ["ada@example.com", "bea@example.com"];

async function readWith(answer: unknown[]): Promise<string[] | "unknown"> {
  redis.pipeline = async (commands: Command[]) =>
    commands.length > 0 && commands.every((command) => command[0] === "SISMEMBER")
      ? answer
      : real(commands);
  try {
    return [...(await usedLinkIn("list_test", "s-0123456789abcdef-fedcba9876543210", emails))].sort();
  } catch {
    return "unknown";
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();

  part("Only exact link-use evidence selects an email branch");
  is("canonical one and zero keep their positions", await readWith([1, 0]), ["ada@example.com"]);
  is("canonical zeros prove neither reader clicked", await readWith([0, 0]), []);
  is("a partial reply is unknown", await readWith([1]), "unknown");
  is("an extra reply is unknown", await readWith([1, 0, 1]), "unknown");
  is("a numeric-looking string is unknown", await readWith(["1", 0]), "unknown");
  is("null is unknown rather than zero", await readWith([1, null]), "unknown");
  is("another number is unknown rather than zero", await readWith([1, 2]), "unknown");

  done();
}

main().catch((error) => {
  redis.pipeline = real;
  console.error(error);
  process.exit(1);
});
