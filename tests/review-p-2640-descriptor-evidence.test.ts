import { takePicturePlace } from "@/lib/community-files";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const PATH = `community/${"a".repeat(24)}/picture.webp`;
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

async function opens(reply: unknown): Promise<boolean> {
  redis.pipeline = (async () => reply) as typeof redis.pipeline;
  try {
    return await takePicturePlace(PATH, 3);
  } finally {
    redis.pipeline = original;
  }
}

function accessor(reads: { count: number }): unknown[] {
  const reply = Array(1) as unknown[];
  Object.defineProperty(reply, "0", {
    get() {
      reads.count += 1;
      return 1;
    },
    enumerable: true,
  });
  return reply;
}

async function main(): Promise<void> {
  part("Only an own descriptor value can confirm a picture place");
  is("plain own data remains accepted", await opens([1]), true);

  const ordinaryReads = { count: 0 };
  is("an ordinary accessor remains refused", await opens(accessor(ordinaryReads)), false);
  is("the ordinary accessor is not executed", ordinaryReads.count, 0);

  const inherited = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  const pollutedReads = { count: 0 };
  const pollutedReply = accessor(pollutedReads);
  try {
    Object.defineProperty(Object.prototype, "value", { configurable: true, value: 1 });
    is("an inherited descriptor value cannot confirm the count", await opens(pollutedReply), false);
    is("the polluted accessor is not executed", pollutedReads.count, 0);
  } finally {
    if (inherited) Object.defineProperty(Object.prototype, "value", inherited);
    else delete (Object.prototype as { value?: unknown }).value;
  }

  done();
}

void main();
