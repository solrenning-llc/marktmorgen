/**
 * Codex L-20261121-0237 (HIGH): connecting an email platform, or saving its settings, waits on the provider, then
 * writes the store's sealed key under nl:esync:cfg:<statsId> with a plain SET. If the store's erasure began, or ended,
 * while the provider answered, that SET put the sealed key back, with no expiry and outside any live store, after the
 * closing walk had deleted it. The key is written only while the store is live, in one fenced step, and the creator is
 * told nothing was saved. Synthetic store, transport and key only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { connect, saveSettings } from "@/lib/email-sync";
import { ERASING_KEY, claimHandle, ensureStatsId, erasingField, storeForEmail, storeRef } from "@/lib/store";
import { answerWith } from "./email-sync-config-erasure-world";
import { store as redis } from "./redis-stub";

const OWNER = "config-erasure@example.test";
const KEY = "synthetic-platform-target-key";
const ACCOUNT = JSON.stringify({ account: { id: 1 } });
const FORMS = JSON.stringify({ forms: [{ id: "chosen", name: "Synthetic form" }], pagination: { has_previous_page: false, has_next_page: false } });
/** Two forms, so a connect picks none and a save that picks one reads the list from the provider again. */
const TWO_FORMS = JSON.stringify({ forms: [{ id: "chosen", name: "Synthetic form" }, { id: "other", name: "Other form" }], pagination: { has_previous_page: false, has_next_page: false } });

async function liveStore() {
  redis.clear();
  await claimHandle(OWNER, "configerasure", "Synthetic config erasure", "");
  await ensureStatsId(OWNER);
  return (await storeForEmail(OWNER))!;
}

/** What the store's erasure leaves when it began: its erasing mark, and its email-platform settings deleted. */
async function eraseBegins(store: Awaited<ReturnType<typeof liveStore>>) {
  redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]);
  redis.run(["DEL", `nl:esync:cfg:${store.statsId}`]);
}

for (const [name, at] of [["the key check (ping)", 0], ["the list read", 1]] as const) {
  test(`the store's erasure during ${name} of a connect leaves no sealed key`, async () => {
    const store = await liveStore();
    answerWith([ACCOUNT, FORMS], at, () => eraseBegins(store));
    const result = await connect(store, "kit", KEY);
    assert.equal(result.ok, false, "the creator is not told it was saved");
    assert.equal(redis.run(["GET", `nl:esync:cfg:${store.statsId}`]), null, "no sealed key is written back");
  });
}

test("the store's erasure during a settings save's list read leaves no sealed key", async () => {
  const store = await liveStore();
  answerWith([ACCOUNT, TWO_FORMS]);
  assert.equal((await connect(store, "kit", KEY)).ok, true, "(connected while live, no form picked yet)");
  const connected = (await storeForEmail(OWNER))!;
  answerWith([TWO_FORMS], 0, () => eraseBegins(connected));
  const saved = await saveSettings(connected, { target: "chosen", free: true, buyers: "all", products: [], tags: {} } as never);
  assert.equal(saved.ok, false, "the creator is not told it was saved");
  assert.equal(redis.run(["GET", `nl:esync:cfg:${connected.statsId}`]), null, "no sealed key is written back");
});

test("a live store connects and keeps its sealed key (control)", async () => {
  const store = await liveStore();
  answerWith([ACCOUNT, FORMS]);
  const result = await connect(store, "kit", KEY);
  assert.equal(result.ok, true);
  const kept = redis.run(["GET", `nl:esync:cfg:${store.statsId}`]);
  assert.equal(typeof kept, "string", "the sealed key is kept");
  assert.equal(redis.run(["TTL", `nl:esync:cfg:${store.statsId}`]), -1, "with no expiry, as before");
});

test("a store whose id key now points to another store (its account moved) gets no sealed key", async () => {
  const store = await liveStore();
  answerWith([ACCOUNT, FORMS], 1, async () => {
    redis.run(["SET", `nl:store:id:${store.sid}`, "someone-else@example.test"]);
    redis.run(["DEL", `nl:esync:cfg:${store.statsId}`]);
  });
  const result = await connect(store, "kit", KEY);
  assert.equal(result.ok, false);
  assert.equal(redis.run(["GET", `nl:esync:cfg:${store.statsId}`]), null);
});

test("a fenced write whose answer does not read is never said to be saved", async () => {
  type Batch = (string | number)[][];
  for (const reply of ["1", "OK", 2, 0.5, null]) {
    const store = await liveStore();
    const plain = redis.pipeline;
    redis.pipeline = (async (batch: Batch) => {
      if (batch.length === 1 && batch[0]?.[0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:store-cache-persistent-live:v1")) return [reply];
      return plain(batch);
    }) as typeof redis.pipeline;
    try {
      answerWith([ACCOUNT, FORMS]);
      const result = await connect(store, "kit", KEY);
      assert.equal(result.ok, false, `answer ${JSON.stringify(reply)} is not a save`);
    } finally {
      redis.pipeline = plain;
    }
  }
});

test("a connect and a settings save stay inside a call out's priced commands, the fence's included", async () => {
  // Each command sent, and the fence's inner calls (HGET, GET and SET) on top. The lock scripts' inner calls are not
  // counted here; the route test below counts every inner call against the units the route takes.
  const { PERSISTENT_FENCE_EXTRA_COMMANDS } = await import("@/lib/store-live-cache");
  type Batch = (string | number)[][];
  let billed = 0;
  const plain = redis.pipeline;
  redis.pipeline = (async (batch: Batch) => {
    for (const command of batch) billed += command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:store-cache-persistent-live:v1") ? 1 + PERSISTENT_FENCE_EXTRA_COMMANDS : 1;
    return plain(batch);
  }) as typeof redis.pipeline;
  try {
    const store = await liveStore();
    billed = 0;
    answerWith([ACCOUNT, TWO_FORMS]);
    assert.equal((await connect(store, "kit", KEY)).ok, true);
    // UNIT_COST.integration in tests/plan-cost-registry.ts: 10 commands of work plus the fence's extra.
    assert.ok(billed <= 10 + PERSISTENT_FENCE_EXTRA_COMMANDS, `a connect bills ${billed}`);
    const connected = (await storeForEmail(OWNER))!;
    billed = 0;
    answerWith([TWO_FORMS]);
    assert.equal((await saveSettings(connected, { target: "chosen", free: true, buyers: "all", products: [], tags: {} } as never)).ok, true);
    assert.ok(billed <= 10 + PERSISTENT_FENCE_EXTRA_COMMANDS, `a settings save bills ${billed}`);
  } finally {
    redis.pipeline = plain;
  }
});

test("a fenced answer that does not read never leaves the store's reference on settings that were not kept", async () => {
  // Claude 1 E's LEVE on #5185: the reference is changed before the key; when the key's answer does not read, it is read
  // back, and the reference follows what is kept.
  type Batch = (string | number)[][];
  const store = await liveStore();
  answerWith([ACCOUNT, TWO_FORMS]);
  assert.equal((await connect(store, "kit", KEY)).ok, true, "(connected, no form picked, so no reference)");
  const before = (await storeForEmail(OWNER))!.emailSync ?? null;
  const connected = (await storeForEmail(OWNER))!;
  const plain = redis.pipeline;
  redis.pipeline = (async (batch: Batch) => {
    if (batch.length === 1 && batch[0]?.[0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:store-cache-persistent-live:v1")) return ["?"];
    return plain(batch);
  }) as typeof redis.pipeline;
  try {
    answerWith([TWO_FORMS]);
    const saved = await saveSettings(connected, { target: "chosen", free: true, buyers: "all", products: [], tags: {} } as never);
    assert.equal(saved.ok, false, "not said to be saved");
  } finally {
    redis.pipeline = plain;
  }
  assert.deepEqual((await storeForEmail(OWNER))!.emailSync ?? null, before, "the reference follows the settings that are kept");
});

test("the whole email-platform route, at its worst, stays inside the studio and integration units it takes", async () => {
  // Claude 1 coord's rule (mail 964c) and Claude 1 E (0260) on #5185: the route, not only connect and saveSettings. A
  // request here takes one studio unit (guardStoreWrite) and one integration unit (withinServiceWhy), so it is paid by
  // both. Counted as Upstash bills: every command the store runs, a script's inner calls included.
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/store/email-sync/route");
  const { openSession, SESSION_COOKIE } = await import("@/lib/auth");
  const { setSubscription } = await import("@/lib/store");
  const { paidPeriod } = await import("./billing-period-fixture");
  const { afterTasks } = await import("./next-server-after-world");
  const { allowanceUsed } = await import("@/lib/store-allowance");
  const { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS, UNIT_COST, request } = await import("./plan-cost-registry");
  const { PERSISTENT_FENCE_EXTRA_COMMANDS } = await import("@/lib/store-live-cache");
  // The commands UNIT_COST prices in its studio and integration units, tied to it so they cannot drift apart.
  const studio = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
  const integration = 10 + TAKE_COMMANDS + PERSISTENT_FENCE_EXTRA_COMMANDS;
  assert.equal(request("studio", studio, 50_000), UNIT_COST.studio);
  assert.equal(request("wait", integration, 21_024), UNIT_COST.integration);
  await liveStore();
  await setSubscription(OWNER, { customerId: "cus_ConfigErasure01", subscriptionId: "sub_ConfigErasure01", active: true, tier: "creator", cycle: "month", period: paidPeriod() } as never);
  const token = await openSession(OWNER);
  const post = (body: object) => POST(new NextRequest("https://local.example/api/store/email-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://local.example", Host: "local.example", Cookie: `${SESSION_COOKIE}=${token}` },
    body: JSON.stringify(body),
  }));
  let billed = 0;
  let unreadable = false;
  const plainRun = redis.run.bind(redis);
  const plainPipeline = redis.pipeline;
  (redis as { run: typeof plainRun }).run = (command) => { billed += 1; return plainRun(command); };
  redis.pipeline = (async (batch: (string | number)[][]) => {
    // The worst save: the fenced answer does not read, so the key is read back and the reference put back (#5185).
    if (unreadable && batch.length === 1 && batch[0]?.[0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:store-cache-persistent-live:v1")) {
      billed += 1 + PERSISTENT_FENCE_EXTRA_COMMANDS;
      return ["?"];
    }
    return plainPipeline(batch);
  }) as typeof redis.pipeline;
  try {
    for (const [name, body, replies, status] of [
      ["a connect", { action: "connect", provider: "kit", key: KEY }, [ACCOUNT, TWO_FORMS], 200],
      ["a settings save", { action: "save", target: "chosen", free: true, buyers: "all", products: [], tags: {} }, [TWO_FORMS], 200],
      ["a save whose fenced answer does not read", { action: "save", target: "other", free: true, buyers: "all", products: [], tags: {} }, [TWO_FORMS], 400],
    ] as const) {
      unreadable = status === 400;
      afterTasks.length = 0;
      // Claude 1 coord's rule (e931): the two units count only when both are taken before the provider is called, so
      // they are read at the platform's first request (not billed here).
      const units = async () => { const store = (await storeForEmail(OWNER))!; return [await allowanceUsed(store, "studio"), await allowanceUsed(store, "integration")]; };
      const before = await units();
      let atCall: number[] = [];
      answerWith([...replies], 0, async () => { const held = billed; atCall = await units(); billed = held; });
      billed = 0;
      assert.equal((await post(body)).status, status, name);
      assert.deepEqual(atCall, [before[0] + 1, before[1] + 1], `${name} took one studio and one integration unit before the platform was called`);
      // The creator's notice after a new connection is an inbox message, priced by UNIT_COST.inbox, not here.
      assert.ok(billed <= studio + integration, `${name} bills ${billed}, over the ${studio + integration} of its two units`);
    }
  } finally {
    (redis as { run: typeof plainRun }).run = plainRun;
    redis.pipeline = plainPipeline;
  }
});
