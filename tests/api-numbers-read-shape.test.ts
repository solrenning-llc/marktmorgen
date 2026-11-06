import assert from "node:assert/strict";
import { test } from "node:test";
import { apiNumbers } from "@/lib/api-numbers";
import { emptyCatalog } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const shop = {
  sid: "api-numbers-read-shape",
  statsId: "n".repeat(32),
  handle: "api-numbers-read-shape",
  name: "Numbers read shape",
  currency: "usd",
  catalog: emptyCatalog("c".repeat(32)),
} as unknown as Store;

const coldRefusal = new Response("cold read reached", { status: 429 });

for (const [name, reply] of [
  ["missing result", []],
  ["extra result", [0, 0]],
  ["boolean result", [false]],
  ["text result", ["0"]],
  ["negative result", [-1]],
  ["fractional result", [0.5]],
] as const) {
  test(`an unknown kept-numbers STRLEN reply (${name}) is unavailable before a cold paid read`, async () => {
    redis.clear();
    const pipeline = redis.pipeline.bind(redis);
    let charges = 0;
    let holds = 0;
    redis.pipeline = async commands => {
      if (commands.length === 1 && commands[0]?.[0] === "STRLEN") return [...reply] as unknown[];
      return pipeline(commands);
    };

    try {
      const result = await apiNumbers(
        shop,
        "plain",
        async () => {
          charges += 1;
          return coldRefusal;
        },
        async () => {
          holds += 1;
          return async () => null;
        },
      );
      assert.equal(result, null);
      assert.equal(charges, 0, "an unknown size must not become an absent cache followed by a cold paid read");
      assert.equal(holds, 0, "an unknown size cannot set a cache-read ceiling");
    } finally {
      redis.pipeline = pipeline;
    }
  });
}

for (const [name, reply] of [
  ["missing result", []],
  ["extra result", ["kept", "extra"]],
  ["boolean result", [false]],
  ["numeric result", [1]],
] as const) {
  test(`an unknown kept-numbers GET reply (${name}) is unavailable after settling only the attempted cache read`, async () => {
    redis.clear();
    const pipeline = redis.pipeline.bind(redis);
    let charges = 0;
    let holds = 0;
    let settlements = 0;
    redis.pipeline = async commands => {
      if (commands.length === 1 && commands[0]?.[0] === "STRLEN") return [1];
      if (commands.length === 1 && commands[0]?.[0] === "GET") return [...reply] as unknown[];
      return pipeline(commands);
    };

    try {
      const result = await apiNumbers(
        shop,
        "plain",
        async () => {
          charges += 1;
          return coldRefusal;
        },
        async () => {
          holds += 1;
          return async () => {
            settlements += 1;
            return null;
          };
        },
      );
      assert.equal(result, null);
      assert.equal(charges, 0, "an unknown cache read must not be treated as a known miss followed by a cold paid read");
      assert.equal(holds, 1);
      assert.equal(settlements, 1, "the attempted cache read is still settled before refusing");
    } finally {
      redis.pipeline = pipeline;
    }
  });
}

test("a confirmed absent kept copy still permits the separately counted cold read", async () => {
  redis.clear();
  const pipeline = redis.pipeline.bind(redis);
  let charges = 0;
  let holds = 0;
  redis.pipeline = async commands => {
    if (commands.length === 1 && commands[0]?.[0] === "STRLEN") return [0];
    return pipeline(commands);
  };

  try {
    const result = await apiNumbers(
      shop,
      "plain",
      async () => {
        charges += 1;
        return coldRefusal;
      },
      async () => {
        holds += 1;
        return async () => null;
      },
    );
    assert.equal(result, coldRefusal);
    assert.equal(charges, 1);
    assert.equal(holds, 0);
  } finally {
    redis.pipeline = pipeline;
  }
});

test("a copy removed between its exact size and GET still permits the separately counted cold read", async () => {
  redis.clear();
  const pipeline = redis.pipeline.bind(redis);
  let charges = 0;
  let settlements = 0;
  redis.pipeline = async commands => {
    if (commands.length === 1 && commands[0]?.[0] === "STRLEN") return [1];
    if (commands.length === 1 && commands[0]?.[0] === "GET") return [null];
    return pipeline(commands);
  };

  try {
    const result = await apiNumbers(
      shop,
      "plain",
      async () => {
        charges += 1;
        return coldRefusal;
      },
      async () => async () => {
        settlements += 1;
        return null;
      },
    );
    assert.equal(result, coldRefusal);
    assert.equal(charges, 1);
    assert.equal(settlements, 1);
  } finally {
    redis.pipeline = pipeline;
  }
});
