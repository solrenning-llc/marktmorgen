import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { done, is, part } from "./check";

type Reply = { status: unknown; data: unknown; content?: string };
type Req = { method?: string; body?: unknown };
class ZapierError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
type Z = { errors: { Error: typeof ZapierError }; request: (request: Req) => Promise<Reply> };
type Bundle = { targetUrl: string; subscribeData: { id: string } };
type App = {
  afterResponse: ((reply: Reply, z: Z) => Reply)[];
  triggers: Record<string, { operation: {
    performSubscribe: (z: Z, b: Bundle) => Promise<unknown>;
    performUnsubscribe: (z: Z, b: Bundle) => Promise<unknown>;
  } }>;
};
const moduleBox = { exports: {} };
runInNewContext(readFileSync("zapier/index.js", "utf8"), { module: moduleBox });
const app = moduleBox.exports as App;
const id = "we_0123456789abcdef";
const bundle = { targetUrl: "https://hooks.example.test/zap", subscribeData: { id } };
const op = app.triggers.sale_completed.operation;

async function call(kind: "subscribe" | "unsubscribe", reply: Reply, input = bundle) {
  const requests: Req[] = [];
  const z: Z = {
    errors: { Error: ZapierError },
    request: async request => {
      requests.push(request);
      return app.afterResponse.reduce((r, hook) => hook(r, z), reply);
    },
  };
  try {
    const value = await (kind === "subscribe" ? op.performSubscribe(z, input) : op.performUnsubscribe(z, input));
    return { accepted: true, value, code: null, calls: requests.length, method: requests[0]?.method };
  } catch (error) {
    return { accepted: false, value: null, code: error instanceof ZapierError ? error.code : "unexpected", calls: requests.length, method: requests[0]?.method };
  }
}

async function main() {
  const subscribed = { id, events: ["sale.completed"], where: "hooks.example.test", secret: "synthetic-secret", added_at: "2026-11-05T00:00:00.000Z" };
  part("HTTP must confirm success before a Zap operation can succeed");
  for (const status of [0, 199, 301, 302, 307, 399, undefined, "200", NaN]) {
    const r = await call("subscribe", { status, data: { data: subscribed } });
    is(`HTTP ${String(status)} is not confirmation`, [r.accepted, r.calls, r.method], [false, 1, "POST"]);
  }
  const denied = await call("subscribe", { status: 403, data: { error: "forbidden", message: "This key cannot write." } });
  is("existing API refusal remains visible", [denied.accepted, denied.code, denied.calls], [false, "forbidden", 1]);

  part("A subscription needs its endpoint id and the requested event");
  for (const data of [null, {}, { data: null }, { data: [] }, { data: {} }, { data: { ...subscribed, id: "wrong" } }, { data: { ...subscribed, events: [] } }, { data: { ...subscribed, events: ["refund.issued"] } }, { data: { ...subscribed, events: ["sale.completed", "refund.issued"] } }]) {
    const r = await call("subscribe", { status: 200, data });
    is(`incomplete subscription ${JSON.stringify(data)} is not accepted or retried`, [r.accepted, r.code, r.calls], [false, "unconfirmed_response", 1]);
  }
  const good = await call("subscribe", { status: 200, data: { data: subscribed } });
  is("confirmed subscription is returned intact", [good.accepted, good.value, good.calls], [true, subscribed, 1]);

  part("Removal must confirm the same endpoint, without another request");
  for (const data of [{}, { data: {} }, { data: { id } }, { data: { id, status: "added" } }, { data: { id: "we_fedcba9876543210", status: "removed" } }]) {
    const r = await call("unsubscribe", { status: 200, data });
    is(`unconfirmed removal ${JSON.stringify(data)} is refused`, [r.accepted, r.code, r.calls, r.method], [false, "unconfirmed_response", 1, "DELETE"]);
  }
  const removed = { id, status: "removed" };
  const goodRemoval = await call("unsubscribe", { status: 200, data: { data: removed } });
  is("confirmed matching removal is returned intact", [goodRemoval.accepted, goodRemoval.value, goodRemoval.calls], [true, removed, 1]);
  for (const badId of ["", "wrong", "we_0123456789ABCDEF"]) {
    const r = await call("unsubscribe", { status: 200, data: { data: { id: badId, status: "removed" } } }, { ...bundle, subscribeData: { id: badId } });
    is(`a matching but invalid endpoint ${JSON.stringify(badId)} is not confirmation`, [r.accepted, r.calls], [false, 1]);
  }
  done();
}
void main();
