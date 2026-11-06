/**
 * Reviewer proof for #2156: picture ownership may be authorized only by the
 * exact Redis acknowledgements the door requested.
 */
import { notePictureDoor, takePictureDoor } from "@/lib/picture-door";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const PATH = `images/${"a".repeat(24)}/${"b".repeat(32)}.jpg`;
const NOW = 1_800_000_000_000;

async function withReply<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (_commands: Command[]) => reply) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

async function take(reply: unknown): Promise<string[] | "unknown"> {
  try {
    return await withReply(reply, async () => [...(await takePictureDoor([PATH], NOW)).keys()]);
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  part("The upload door needs its whole write acknowledgement");
  is("a short write reply does not open the upload door", await withReply([0], () => notePictureDoor(PATH, NOW)), false);
  is("the canonical write reply opens it", await withReply([0, 1, 0, 1], () => notePictureDoor(PATH, NOW)), true);

  part("Taking a picture needs an exact removal acknowledgement");
  is("a numeric-looking removal string is unknown", await take([String(NOW), "1"]), "unknown");
  is("the canonical score and numeric removal acknowledge the picture", await take([String(NOW), 1]), [PATH]);
  done();
}

main().catch((error) => {
  redis.pipeline = real;
  console.error(error);
  process.exit(1);
});
