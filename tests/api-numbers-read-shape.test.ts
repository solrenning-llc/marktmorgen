import assert from "node:assert/strict";
import { test } from "node:test";
import { apiNumbers, keptNumbersCopy, openKeptNumbers } from "@/lib/api-numbers";
import { emptyCatalog } from "@/lib/catalog";
import { studioStats, type Stats, type StatsData } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const shop = {
  sid: "api-numbers-read-shape",
  statsId: "n".repeat(32),
  handle: "api-numbers-read-shape",
  name: "Numbers read shape",
  currency: "usd",
  catalog: emptyCatalog("c".repeat(32)),
  links: [],
} as unknown as Store;

const coldRefusal = new Response("cold read reached", { status: 429 });

const emptyWindow = {
  visitors: 0,
  views: 0,
  checkouts: 0,
  sources: [],
  mediums: [],
  campaigns: [],
  checkoutsByProduct: {},
  viewsByProduct: {},
  linkClicks: {},
  countries: [],
  devices: [],
  checkoutsBySource: [],
  freeBySource: [],
  reach: {},
  heard: {},
  searchMisses: [],
};

const validStats = (): StatsData =>
  studioStats(
    shop,
    {
      days: [],
      windows: { d7: emptyWindow, d30: emptyWindow, d90: emptyWindow },
      previous: {
        d7: { visitors: 0, views: 0, checkouts: 0 },
        d30: { visitors: 0, views: 0, checkouts: 0 },
        d90: { visitors: 0, views: 0, checkouts: 0 },
      },
      life: null,
    } as Stats,
    null,
    "none",
    [],
  );

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

test("a kept copy whose paid content changed without its identity header is unknown", () => {
  const now = Date.now();
  const data = validStats();
  const raw = keptNumbersCopy(shop, "plain", data, now);
  assert.ok(raw);
  assert.deepEqual(openKeptNumbers(shop, "plain", raw, now)?.data, JSON.parse(JSON.stringify(data)));

  const end = raw.indexOf("\n");
  const changed = JSON.parse(raw.slice(end + 1)) as { totals: { d7: { cents: unknown } } };
  changed.totals.d7.cents = "unreadable";
  const altered = raw.slice(0, end + 1) + JSON.stringify(changed);

  assert.equal(openKeptNumbers(shop, "plain", altered, now), null);
});

for (const [name, cents] of [
  ["text", "unreadable"],
  ["null", null],
  ["fraction", 0.5],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
] as const) {
  test(`a coherently digested kept copy with ${name} cents is unknown`, () => {
    const now = Date.now();
    const data = validStats();
    (data.totals.d7 as { cents: unknown }).cents = cents;
    const raw = keptNumbersCopy(shop, "plain", data, now);
    assert.ok(raw, "the malformed producer output has its own matching digest");
    assert.equal(openKeptNumbers(shop, "plain", raw, now), null);
  });
}
