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
