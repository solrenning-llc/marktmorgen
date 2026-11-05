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

async function main(): Promise<void> {
  part("Only an own inert pipeline slot proves a picture place");
  is("a plain own integer remains accepted", await opens([1]), true);

  const inherited = Array(1) as unknown[];
  const inheritedPrototype = Object.create(Array.prototype) as Record<string, unknown>;
  inheritedPrototype[0] = 1;
  Object.setPrototypeOf(inherited, inheritedPrototype);
  is("an inherited slot cannot open the door", await opens(inherited), false);

  let getterReads = 0;
  const accessor = Array(1) as unknown[];
  Object.defineProperty(accessor, "0", {
    get() {
      getterReads += 1;
      return 1;
    },
    enumerable: true,
  });
  is("an accessor slot cannot open the door", await opens(accessor), false);
  is("validation does not execute the accessor", getterReads, 0);

  done();
}

void main();
