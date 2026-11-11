import assert from "node:assert/strict";
import test from "node:test";
import { certificateCount, certificatesOf } from "@/lib/certificate";
import { store as redis } from "./redis-stub";

const COURSE = "c".repeat(32);
const OTHER_COURSE = "d".repeat(32);
const CERTIFICATE = {
  id: "copyevidence0001",
  store: "copy-evidence-store",
  productId: "course-product",
  courseId: COURSE,
  name: "Sample Student",
  title: "Sample Course",
  creator: "Sample School",
  email: "student@example.test",
  issuedAt: 1_790_000_000,
  withdrawnAt: 0,
};
const RAW = JSON.stringify(CERTIFICATE);

async function copyWith(...replies: unknown[]): Promise<Awaited<ReturnType<typeof certificatesOf>>> {
  const original = redis.pipeline.bind(redis);
  let call = 0;
  redis.pipeline = (async () => replies[call++] as unknown[]) as typeof redis.pipeline;
  try {
    return await certificatesOf([COURSE], CERTIFICATE.email);
  } finally {
    redis.pipeline = original;
  }
}

async function countWith(reply: unknown): Promise<number> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async () => reply as unknown[]) as typeof redis.pipeline;
  try {
    return await certificateCount([COURSE, OTHER_COURSE]);
  } finally {
    redis.pipeline = original;
  }
}

async function unknown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.name : typeof error;
  }
}

test("certificate privacy copy requires the exact index-read envelope and slot types", async () => {
  redis.clear();
  assert.deepEqual(await copyWith([[CERTIFICATE.id], null, 0], [[RAW]]), [CERTIFICATE]);

  const sparse = new Array(3) as unknown[];
  sparse[0] = [];
  sparse[2] = 0;
  let getterReads = 0;
  const accessor = [[], null, 0] as unknown[];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return [];
    },
  });

  const bad: Array<[string, unknown]> = [
    ["missing envelope", []],
    ["short envelope", [[], null]],
    ["extra envelope", [[], null, 0, "extra"]],
    ["sparse envelope", sparse],
    ["non-list personal index", [null, null, 0]],
    ["non-string standing id", [[], 7, 0]],
    ["numeric-text count", [[], null, "0"]],
    ["negative count", [[], null, -1]],
    ["unsafe count", [[], null, Number.MAX_SAFE_INTEGER + 1]],
  ];
  for (const [name, reply] of bad) {
    assert.equal(await unknown(() => copyWith(reply)), "UnknownReply", name);
  }
  assert.equal(await unknown(() => copyWith(accessor)), "UnknownReply");
  assert.equal(getterReads, 0, "an accessor envelope is refused without executing it");
});

test("certificate privacy copy requires exact legacy-list and record-read evidence", async () => {
  redis.clear();
  assert.deepEqual(await copyWith([[], null, 1], [[CERTIFICATE.id]], [[RAW]]), [CERTIFICATE]);

  for (const reply of [[], [null], [{}], [[], "extra"]]) {
    assert.equal(
      await unknown(() => copyWith([[], null, 1], reply)),
      "UnknownReply",
      `legacy list ${JSON.stringify(reply)} is unknown`,
    );
  }

  const sparseRows = new Array(1) as unknown[];
  let rowGetterReads = 0;
  const accessorRows = new Array(1) as unknown[];
  Object.defineProperty(accessorRows, "0", {
    enumerable: true,
    configurable: true,
    get() {
      rowGetterReads += 1;
      return RAW;
    },
  });
  for (const [name, rows] of [
    ["missing outer reply", undefined],
    ["null nested list", null],
    ["short nested list", []],
    ["extra nested row", [RAW, RAW]],
    ["sparse nested list", sparseRows],
    ["accessor nested list", accessorRows],
  ] as const) {
    assert.equal(
      await unknown(() => copyWith([[CERTIFICATE.id], null, 0], rows === undefined ? [] : [rows])),
      "UnknownReply",
      `${name} is unknown`,
    );
  }
  assert.equal(rowGetterReads, 0, "a stored-record accessor is refused without executing it");
});

test("certificate erasure preflight count requires one exact numeric reply per course", async () => {
  redis.clear();
  assert.equal(await countWith([2, 700]), 502, "known counts preserve the existing per-course scan ceiling");

  const sparse = new Array(2) as unknown[];
  sparse[0] = 1;
  let getterReads = 0;
  const accessor = [1, 2] as unknown[];
  Object.defineProperty(accessor, "1", {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return 2;
    },
  });
  const bad: Array<[string, unknown]> = [
    ["missing envelope", []],
    ["short envelope", [1]],
    ["extra envelope", [1, 2, 3]],
    ["sparse envelope", sparse],
    ["undefined count", [1, undefined]],
    ["null count", [1, null]],
    ["numeric-text count", [1, "2"]],
    ["negative count", [1, -1]],
    ["fractional count", [1, 1.5]],
    ["infinite count", [1, Infinity]],
    ["unsafe count", [1, Number.MAX_SAFE_INTEGER + 1]],
  ];
  for (const [name, reply] of bad) {
    assert.equal(await unknown(() => countWith(reply)), "UnknownReply", name);
  }
  assert.equal(await unknown(() => countWith(accessor)), "UnknownReply");
  assert.equal(getterReads, 0, "a count accessor is refused without executing it");
});
