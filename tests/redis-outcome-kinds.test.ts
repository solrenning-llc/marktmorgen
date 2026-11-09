// What a failed Redis call says about whether it was applied (rule 24): redisOutcomeOf tells
// "not-sent" (nothing reached Redis), "refused" (Redis answered every command, and a command it
// refused changed nothing) and "maybe-applied" (anything else: a timeout or a connection lost after
// the request went out, an answer cut short, an HTTP error, a script that raised). The errors
// themselves are exactly as before: same class, message and cause, so no caller changes.
// Synthetic only: fetch is replaced, or points at a loopback port nothing listens on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { redisOutcomeOf, redisPipeline, redisPipelineBase64 } from "../lib/redis";
import { withCutoff } from "../lib/fetch-timeout";

type Fetch = typeof globalThis.fetch;
const nativeFetch = globalThis.fetch;
const NAMES = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"] as const;

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  assert.fail("the call was expected to throw");
}

async function withRedis<T>(fetchImpl: Fetch | null, body: (calls: { count: number }) => Promise<T>, url = "https://redis.example.test"): Promise<T> {
  const prior = NAMES.map((name) => process.env[name]);
  for (const name of NAMES) delete process.env[name];
  process.env.UPSTASH_REDIS_REST_URL = url;
  process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic-token";
  const calls = { count: 0 };
  if (fetchImpl) {
    globalThis.fetch = ((input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
      calls.count += 1;
      return fetchImpl(input, init);
    }) as Fetch;
  }
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = nativeFetch;
    NAMES.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
}

const json = (value: unknown, status = 200): Fetch => async () => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("a command Redis refused is 'refused', with each command's own answer, and the error is the one it always was", async () => {
  await withRedis(json([{ result: "kept" }, { error: "WRONGTYPE Operation against a key holding the wrong kind of value" }, { result: 1 }]), async () => {
    const error = await caught(() => redisPipeline([["GET", "a"], ["SET", "b", "1"], ["DEL", "c"]]));
    assert.ok(error instanceof Error);
    assert.equal((error as Error).constructor, Error, "still a plain Error");
    assert.equal((error as Error).message, "Redis error: WRONGTYPE Operation against a key holding the wrong kind of value");
    const outcome = redisOutcomeOf(error);
    assert.equal(outcome.kind, "refused");
    assert.ok(outcome.kind === "refused");
    assert.deepEqual(outcome.answers, [
      { applied: true, result: "kept" },
      { applied: false, error: "WRONGTYPE Operation against a key holding the wrong kind of value" },
      { applied: true, result: 1 },
    ]);
    assert.ok(Object.isFrozen(outcome) && Object.isFrozen(outcome.answers) && outcome.answers.every(Object.isFrozen), "nobody can rewrite what Redis said");
  });
});

test("the base64 pipeline tells a refusal the same way, with its answers as they came", async () => {
  await withRedis(json([{ result: "T0s=" }, { error: "ERR syntax error" }]), async () => {
    const error = await caught(() => redisPipelineBase64([["GET", "a"], ["SET", "b"]]));
    assert.equal((error as Error).message, "Redis error: ERR syntax error");
    assert.deepEqual(redisOutcomeOf(error), { kind: "refused", answers: [{ applied: true, result: "T0s=" }, { applied: false, error: "ERR syntax error" }] });
  });
});

test("a script that raised may have written before it did: 'maybe-applied', never 'refused'", async () => {
  for (const name of ["EVAL", "evalsha", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO", "EXEC"]) {
    await withRedis(json([{ error: "ERR user_script:1: Script attempted to access nonexistent global variable" }]), async () => {
      const error = await caught(() => redisPipeline([[name, "return 1", 0]]));
      assert.equal(redisOutcomeOf(error).kind, "maybe-applied", name);
    });
  }
});

test("an answer that is not one plain entry per command is not a refusal: 'maybe-applied'", async () => {
  const shapes: unknown[] = [
    [{ error: "ERR x" }], // one answer for two commands
    [{ error: "ERR x" }, { result: 1 }, { result: 2 }],
    [{ error: "ERR x" }, { result: 1, error: "ERR y" }],
    [{ error: "ERR x" }, {}],
    [{ error: "ERR x" }, null],
    [{ error: 7 }, { result: 1 }],
  ];
  for (const shape of shapes) {
    await withRedis(json(shape), async () => {
      const error = await caught(() => redisPipeline([["SET", "a", "1"], ["SET", "b", "1"]]));
      assert.equal(redisOutcomeOf(error).kind, "maybe-applied", JSON.stringify(shape));
    });
  }
});

test("an HTTP error status is 'maybe-applied' (Upstash's meaning of each status is not read here), message unchanged", async () => {
  for (const status of [400, 401, 429, 500, 502, 504]) {
    await withRedis(json({ error: "x" }, status), async () => {
      const error = await caught(() => redisPipeline([["SET", "a", "1"]]));
      assert.equal((error as Error).message, `Redis request failed with status ${status}`);
      assert.equal(redisOutcomeOf(error).kind, "maybe-applied", String(status));
      const base64 = await caught(() => redisPipelineBase64([["SET", "a", "1"]]));
      assert.equal(redisOutcomeOf(base64).kind, "maybe-applied", String(status));
    });
  }
});

test("an answer cut short after the request went out is 'maybe-applied'", async () => {
  const cut: Fetch = async () => new Response('[{"result":"OK"', { status: 200 });
  await withRedis(cut, async () => {
    const error = await caught(() => redisPipeline([["SET", "a", "1"]]));
    assert.ok(error instanceof SyntaxError, "the same JSON error as before");
    assert.equal(redisOutcomeOf(error).kind, "maybe-applied");
  });
});

test("a timeout after the request was handed to fetch is 'maybe-applied', and still the TypeError callers know", async () => {
  const hang: Fetch = (_input, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  await withRedis(hang, async (calls) => {
    const error = await caught(() => withCutoff(Date.now() + 200, () => redisPipeline([["SET", "a", "1"]])));
    assert.equal(calls.count, 1, "the request was handed over");
    assert.ok(error instanceof TypeError);
    assert.equal((error as TypeError).message, "fetch failed");
    assert.equal(redisOutcomeOf(error).kind, "maybe-applied");
  });
});

test("a connection lost after sending (reset, socket closed) is 'maybe-applied'", async () => {
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "ETIMEDOUT", undefined]) {
    const lost: Fetch = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("lost"), code ? { code } : {}) });
    };
    await withRedis(lost, async () => {
      const error = await caught(() => redisPipeline([["SET", "a", "1"]]));
      assert.equal((error as Error).message, "fetch failed");
      assert.equal(redisOutcomeOf(error).kind, "maybe-applied", String(code));
    });
  }
});

test("a connection that was never made (DNS, refused, connect timeout) is 'not-sent'", async () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]) {
    const never: Fetch = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("no connection"), { code }) });
    };
    await withRedis(never, async () => {
      const error = await caught(() => redisPipeline([["SET", "a", "1"]]));
      assert.ok(error instanceof TypeError);
      assert.equal(redisOutcomeOf(error).kind, "not-sent", code);
    });
  }
  // A code read through a getter is not trusted (nothing of the cause is run): 'maybe-applied'.
  const getter: Fetch = async () => {
    const cause = new Error("no connection");
    Object.defineProperty(cause, "code", { get: () => "ECONNREFUSED" });
    throw new TypeError("fetch failed", { cause });
  };
  await withRedis(getter, async () => {
    assert.equal(redisOutcomeOf(await caught(() => redisPipeline([["SET", "a", "1"]]))).kind, "maybe-applied");
  });
  // An error of another kind carrying the same code is not fetch's: 'maybe-applied'.
  const other: Fetch = async () => {
    throw Object.assign(new Error("no connection"), { code: "ECONNREFUSED" });
  };
  await withRedis(other, async () => {
    assert.equal(redisOutcomeOf(await caught(() => redisPipeline([["SET", "a", "1"]]))).kind, "maybe-applied");
  });
});

test("the real fetch to a loopback port nothing listens on is 'not-sent'", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await withRedis(null, async () => {
    const error = await caught(() => redisPipeline([["SET", "a", "1"]]));
    assert.ok(error instanceof TypeError);
    assert.equal((error as TypeError).message, "fetch failed");
    assert.equal(redisOutcomeOf(error).kind, "not-sent");
  }, `http://127.0.0.1:${address.port}`);
});

test("no time left to ask, or no Redis configured, is 'not-sent' and nothing is fetched", async () => {
  await withRedis(json([{ result: "OK" }]), async (calls) => {
    const late = await caught(() => withCutoff(Date.now() + 10, () => redisPipeline([["SET", "a", "1"]])));
    assert.ok(late instanceof TypeError);
    assert.equal(redisOutcomeOf(late).kind, "not-sent");
    const lateBase64 = await caught(() => withCutoff(Date.now() + 10, () => redisPipelineBase64([["SET", "a", "1"]])));
    assert.equal(redisOutcomeOf(lateBase64).kind, "not-sent");
    assert.equal(calls.count, 0);
  });
  await withRedis(json([{ result: "OK" }]), async (calls) => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const error = await caught(() => redisPipeline([["SET", "a", "1"]]));
    assert.equal((error as Error).message, "Redis is not configured");
    assert.equal(redisOutcomeOf(error).kind, "not-sent");
    assert.equal(redisOutcomeOf(await caught(() => redisPipelineBase64([["SET", "a", "1"]]))).kind, "not-sent");
    assert.equal(calls.count, 0);
  });
});

test("an error that did not come out of these calls, or any other value, is 'maybe-applied'", () => {
  for (const value of [new Error("Redis error: ERR x"), new TypeError("fetch failed"), "x", null, undefined, 3, {}]) {
    assert.equal(redisOutcomeOf(value).kind, "maybe-applied");
  }
});

test("a call that answers is unchanged", async () => {
  await withRedis(json([{ result: "OK" }, { result: null }]), async () => {
    assert.deepEqual(await redisPipeline([["SET", "a", "1"], ["GET", "b"]]), ["OK", null]);
  });
});
