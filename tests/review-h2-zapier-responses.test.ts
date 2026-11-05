/** Independent whole-trigger controls; only a synthetic z.request is used. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Reply = { status: unknown; data: unknown };
type Request = { method: string; body: { url?: string; events?: string[]; id?: string } };
class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}
type Z = { errors: { Error: typeof ApiError }; request: (r: Request) => Promise<Reply> };
type Bundle = { targetUrl: string; subscribeData: { id: string } };
type Operation = {
  type?: string;
  sample?: { type: string };
  performSubscribe: (z: Z, b: Bundle) => Promise<unknown>;
  performUnsubscribe: (z: Z, b: Bundle) => Promise<unknown>;
};
type App = { afterResponse: ((r: Reply, z: Z) => Reply)[]; triggers: Record<string, { operation: Operation }> };
const box = { exports: {} };
runInNewContext(readFileSync("zapier/index.js", "utf8"), { module: box });
const app = box.exports as App;
const bundle = { targetUrl: "https://hooks.example.test/one?token=synthetic", subscribeData: { id: "we_0123456789abcdef" } };
let checks = 0;
let triggers = 0;
function check(value: unknown): void { assert.ok(value); checks++; }

async function invoke(op: Operation, remove: boolean, reply: Reply) {
  const requests: Request[] = [];
  const z: Z = {
    errors: { Error: ApiError },
    request: async r => {
      requests.push(r);
      return app.afterResponse.reduce((value, hook) => hook(value, z), reply);
    },
  };
  try {
    const value = await (remove ? op.performUnsubscribe(z, bundle) : op.performSubscribe(z, bundle));
    return { value, error: null, requests };
  } catch (error) {
    return { value: null, error, requests };
  }
}

async function main() {
  for (const { operation: op } of Object.values(app.triggers)) {
    if (op.type !== "hook") continue;
    triggers++;
    const event = op.sample?.type;
    check(typeof event === "string");
    const added = { id: bundle.subscribeData.id, events: [event], retained: { marker: "opaque" } };
    const good = await invoke(op, false, { status: 201, data: { data: added } });
    check(good.error === null && good.value === added);
    check(good.requests.length === 1 && good.requests[0].method === "POST");
    check(good.requests[0].body.url === bundle.targetUrl);
    check(JSON.stringify(good.requests[0].body.events) === JSON.stringify([event]));
    for (const status of [199, 300, 307, 399, "201", undefined, null, NaN]) {
      const result = await invoke(op, false, { status, data: { data: added } });
      check(result.error instanceof ApiError && result.error.code === "unconfirmed_response");
      check(result.requests.length === 1 && result.value === null);
    }
    for (const data of [null, [], {}, { data: [] }, { data: { ...added, events: [event, event] } }]) {
      const result = await invoke(op, false, { status: 200, data });
      check(result.error instanceof ApiError && result.requests.length === 1 && result.value === null);
    }
    const removed = { id: bundle.subscribeData.id, status: "removed", retained: "opaque" };
    const removal = await invoke(op, true, { status: 200, data: { data: removed } });
    check(removal.error === null && removal.value === removed);
    check(removal.requests.length === 1 && removal.requests[0].method === "DELETE");
    check(removal.requests[0].body.id === bundle.subscribeData.id);
    const wrong = await invoke(op, true, { status: 200, data: { data: { ...removed, id: "we_fedcba9876543210" } } });
    check(wrong.error instanceof ApiError && wrong.requests.length === 1 && wrong.value === null);
    const refusal = await invoke(op, false, { status: 403, data: { error: "forbidden", message: "Key cannot write." } });
    check(refusal.error instanceof ApiError && refusal.error.code === "forbidden" && refusal.error.message === "Key cannot write.");
  }
  check(triggers > 1);
  console.log(`${checks} independent checks passed across ${triggers} hook triggers`);
}
void main();
