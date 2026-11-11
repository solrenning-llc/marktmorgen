import { takePicturePlace } from "@/lib/community-files";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const PATH = `community/${"a".repeat(24)}/picture.webp`;
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

async function take(replies: unknown[][], limit = 3): Promise<{ opened: boolean; commands: (string | number)[][] }> {
  const commands: (string | number)[][] = [];
  redis.pipeline = (async (batch) => {
    commands.push(...batch);
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected picture count command");
    return reply;
  }) as typeof redis.pipeline;
  try {
    return { opened: await takePicturePlace(PATH, limit), commands };
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Only an exact increment reply opens the upload door");
  is("a confirmed first place opens", await take([[1]]), {
    opened: true,
    commands: [["INCR", `nl:cimg:n:${"a".repeat(24)}`]],
  });
  is("a confirmed last place opens", (await take([[3]])).opened, true);
  for (const [name, reply] of [
    ["missing", []],
    ["extra", [1, 0]],
    ["null", [null]],
    ["boolean", [false]],
    ["Redis text instead of integer", ["1"]],
    ["zero", [0]],
    ["negative", [-1]],
    ["fractional", [1.5]],
    ["unsafe", [Number.MAX_SAFE_INTEGER + 1]],
  ] as const) {
    const result = await take([reply as unknown as unknown[], [0]]);
    is(`${name} increment evidence keeps the door closed`, result.opened, false);
    is(`${name} increment evidence is not compensated without a confirmed count`, result.commands.length, 1);
  }

  const inherited = Array(1) as unknown[];
  const inheritedPrototype = Object.create(Array.prototype) as Record<string, unknown>;
  inheritedPrototype[0] = 1;
  Object.setPrototypeOf(inherited, inheritedPrototype);
  is("an inherited slot cannot open the door", (await take([inherited])).opened, false);

  let getterReads = 0;
  const accessor = Array(1) as unknown[];
  Object.defineProperty(accessor, "0", {
    get() {
      getterReads += 1;
      return 1;
    },
    enumerable: true,
  });
  is("an accessor slot cannot open the door", (await take([accessor])).opened, false);
  is("validation does not execute the accessor", getterReads, 0);

  const inheritedDescriptorValue = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  const pollutedAccessor = Array(1) as unknown[];
  Object.defineProperty(pollutedAccessor, "0", {
    get() {
      getterReads += 1;
      return 1;
    },
    enumerable: true,
  });
  try {
    Object.defineProperty(Object.prototype, "value", { configurable: true, value: 1 });
    is("an inherited descriptor value cannot open the door", (await take([pollutedAccessor])).opened, false);
    is("validation still does not execute the polluted accessor", getterReads, 0);
  } finally {
    if (inheritedDescriptorValue) Object.defineProperty(Object.prototype, "value", inheritedDescriptorValue);
    else delete (Object.prototype as { value?: unknown }).value;
  }

  let proxyPayloadReads = 0;
  const proxy = new Proxy([1], {
    get(target, property, receiver) {
      // Promise resolution probes `then` before the async caller receives the reply.
      if (property !== "then") proxyPayloadReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  is("a proxy reply cannot open the door", (await take([proxy])).opened, false);
  is("validation does not read proxy payload fields", proxyPayloadReads, 0);

  const decorated = [1] as unknown[] & { extra?: number };
  decorated.extra = 0;
  is("a decorated reply cannot open the door", (await take([decorated])).opened, false);

  part("Only a confirmed count past the limit is compensated");
  is("the first confirmed place past the limit is returned", await take([[4], [3]]), {
    opened: false,
    commands: [
      ["INCR", `nl:cimg:n:${"a".repeat(24)}`],
      ["DECR", `nl:cimg:n:${"a".repeat(24)}`],
    ],
  });

  done();
}

void main();
