/**
 * Rule 24 for Marktmorgen for Zapier (zapier/index.js): a 2xx answer whose
 * body is not the exact shape the API gives is never reported to Zapier as a
 * done action or a read result. Before this, the three actions returned
 * `response.data.data` whatever it was, so `{}` or `{ data: { status: "?" } }`
 * showed "Give Product Access" as done with nothing confirming it, while the
 * hook subscription already refused the same answer.
 *
 * Synthetic: a stand-in z answers every request with a canned reply, passed
 * through the app's own afterResponse. No route, no network. The real routes
 * are run by tests/zapier-app.test.ts.
 */
import { done, is, part } from "./check";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require("../zapier/index.js") as ZapierApp;

type Reply = { status: number; data: unknown; content?: string };
type Z = { request: (r: unknown) => Promise<Reply>; errors: { Error: typeof ZapierError } };
type Run = (z: Z, b: Record<string, unknown>) => Promise<unknown>;
type ZapierApp = {
  authentication: { test: (z: Z) => Promise<unknown> };
  afterResponse: ((r: Reply, z: Z) => Reply)[];
  triggers: Record<string, { operation: { perform: Run; performList?: Run } }>;
  creates: Record<string, { operation: { perform: Run } }>;
};

class ZapierError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fakeZ(reply: Reply): Z {
  const z: Z = { errors: { Error: ZapierError }, request: async () => app.afterResponse[0](reply, z) };
  return z;
}

/** What a call ended as: its result, or the code of the error it threw. */
async function outcome(call: () => Promise<unknown>): Promise<{ ok: unknown } | { error: string }> {
  try {
    return { ok: await call() };
  } catch (error) {
    return { error: error instanceof ZapierError ? error.code : `not a Zapier error: ${String(error)}` };
  }
}

const bundle = { authData: { api_key: "nl_live_" + "0".repeat(40) }, inputData: { email: "ada@example.com", product: "abc123", agreed: true, notify: true, add: "vip" }, meta: { page: 0 } };
const ok = (data: unknown): Reply => ({ status: 200, data: { data } });

/** Answers that are 2xx but are not what the API gives. */
const MALFORMED: [string, Reply][] = [
  ["an empty object", { status: 200, data: {} }],
  ["a list", { status: 200, data: [] }],
  ["no body", { status: 200, data: undefined }],
  ["data null", ok(null)],
  ["data a list", ok([])],
];

const WRITES: { key: string; healthy: Record<string, unknown>[]; near: [string, Record<string, unknown>][] }[] = [
  {
    key: "add_subscriber",
    healthy: [{ email: "ada@example.com", status: "added" }, { email: "ada@example.com", status: "already" }],
    near: [
      ["an unknown status", { email: "ada@example.com", status: "queued_unknown" }],
      ["no email", { status: "added" }],
      ["an email that is not text", { email: 1, status: "added" }],
    ],
  },
  {
    key: "change_labels",
    healthy: [{ email: "ada@example.com", labels: ["vip"] }, { email: "ada@example.com", labels: [] }],
    near: [
      ["no labels", { email: "ada@example.com" }],
      ["labels not a list", { email: "ada@example.com", labels: "vip" }],
      ["a label that is not text", { email: "ada@example.com", labels: [1] }],
      ["no email", { labels: ["vip"] }],
    ],
  },
  {
    key: "give_access",
    healthy: [
      { email: "ada@example.com", product: "abc123", status: "given", emailed: true },
      { email: "ada@example.com", product: "abc123", status: "already", emailed: false },
    ],
    near: [
      ["an unknown status", { email: "ada@example.com", product: "abc123", status: "queued_unknown", emailed: false }],
      ["no emailed", { email: "ada@example.com", product: "abc123", status: "given" }],
      ["emailed not a boolean", { email: "ada@example.com", product: "abc123", status: "given", emailed: "true" }],
      ["no product", { email: "ada@example.com", status: "given", emailed: false }],
      ["no email", { product: "abc123", status: "given", emailed: false }],
    ],
  },
];

async function main(): Promise<void> {
  for (const { key, healthy, near } of WRITES) {
    const perform = app.creates[key].operation.perform;
    part(`${key}: a 2xx answer that is not the API's own shape is unconfirmed, never done`);
    for (const [name, reply] of MALFORMED) {
      is(`${name}: unconfirmed`, await outcome(() => perform(fakeZ(reply), bundle)), { error: "unconfirmed_response" });
    }
    for (const [name, data] of near) {
      is(`${name}: unconfirmed`, await outcome(() => perform(fakeZ(ok(data)), bundle)), { error: "unconfirmed_response" });
    }
    part(`${key}: controls`);
    for (const data of healthy) {
      is(`the API's own answer is returned whole: ${JSON.stringify(data)}`, await outcome(() => perform(fakeZ(ok(data)), bundle)), { ok: data });
    }
    is("a refusal is still the API's own message", await outcome(() => perform(fakeZ({ status: 403, data: { error: "read_only_key", message: "This key may only read." } }), bundle)), { error: "read_only_key" });
  }

  part("reads: an answer that is not a list or the store is unknown, never empty or nobody");
  const reads: [string, Run, unknown[]][] = [
    ["connection check", (z) => app.authentication.test(z), [{ handle: "harbor", name: "Harbor Kitchen", currency: "usd" }]],
    ["examples of a trigger", (z, b) => app.triggers.sale_completed.operation.performList!(z, b), [[], [{ id: "evt_1", type: "sale.completed" }]]],
    ["products for the product field", (z, b) => app.triggers.product_list.operation.perform(z, b), [[], [{ id: "abc123", title: "Book" }]]],
  ];
  for (const [name, read, healthy] of reads) {
    for (const [what, reply] of [
      ["an empty object", { status: 200, data: {} }],
      ["no body", { status: 200, data: undefined }],
      ["data null", ok(null)],
      ["data a number", ok(3)],
      ...(name === "connection check" ? ([["data a list", ok([])], ["a store with no handle", ok({ name: "Harbor Kitchen" })]] as [string, Reply][]) : ([["data an object", ok({})], ["a row that is not an object", ok([1])]] as [string, Reply][])),
    ] as [string, Reply][]) {
      is(`${name}, ${what}: unknown`, await outcome(() => read(fakeZ(reply), bundle)), { error: "unknown_response" });
    }
    for (const data of healthy) {
      is(`${name}, control ${JSON.stringify(data)}: returned`, await outcome(() => read(fakeZ(ok(data)), bundle)), { ok: data });
    }
  }
  done();
}

void main();
