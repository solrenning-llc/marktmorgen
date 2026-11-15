/**
 * Marktmorgen for Zapier (zapier/index.js) and the two API routes it rests on
 * (app/api/v1/hooks, app/api/v1/events), run as Zapier would run them, against
 * the real routes and an in-memory store. What is checked:
 *
 *   - a Zap subscribes with a key that may write, and only with one; every
 *     endpoint added this way is told to the creator, and turning the Zap off
 *     removes it;
 *   - the five endpoints a store may have count those added by Zapier too;
 *   - the examples Zapier shows are only messages the store's webhooks already
 *     sent, of the one event asked for;
 *   - each trigger stands for one of the events the webhooks send, every
 *     event the webhooks send has its trigger, each example has exactly the
 *     fields that event's webhook sends, and each action calls the API's own
 *     write, with the agreement the list requires;
 *   - the app names the platform version its package installs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { MAX_ENDPOINTS, WEBHOOK_EVENTS, emitEvent, webhooksView } from "@/lib/webhooks";
import { DELETE as deleteHook, POST as postHook } from "@/app/api/v1/hooks/route";
import { GET as getEvents } from "@/app/api/v1/events/route";
import { GET as getStore } from "@/app/api/v1/store/route";
import { POST as postLeads } from "@/app/api/v1/leads/route";
import { POST as postLabels } from "@/app/api/v1/leads/labels/route";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { GET as getProducts } from "@/app/api/v1/products/route";
import { POST as postCodes } from "@/app/api/v1/codes/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require("../zapier/index.js") as ZapierApp;

type Bundle = {
  authData: { api_key: string };
  inputData: Record<string, unknown>;
  targetUrl?: string;
  subscribeData?: { id?: string };
  cleanedRequest?: unknown;
  meta?: { page?: number };
};
type Op = {
  type?: string;
  perform: (z: Z, b: Bundle) => Promise<unknown>;
  performSubscribe?: (z: Z, b: Bundle) => Promise<{ id: string }>;
  performUnsubscribe?: (z: Z, b: Bundle) => Promise<unknown>;
  sample: Record<string, unknown>;
};
type ZapierApp = {
  version: string;
  platformVersion: string;
  authentication: { test: (z: Z) => Promise<Record<string, unknown>> };
  beforeRequest: ((r: Req, z: Z, b: Bundle) => Req)[];
  afterResponse: ((r: Res, z: Z) => Res)[];
  triggers: Record<string, { display: { hidden?: boolean }; operation: Op }>;
  creates: Record<string, { operation: Op & { inputFields: { key: string; required?: boolean }[] } }>;
  EVENTS: { key: string; event: string }[];
};
type Req = { url: string; method?: string; body?: unknown; params?: Record<string, string | number>; headers?: Record<string, string> };
type Res = { status: number; data: { data?: unknown }; content: string };
type Z = { request: (r: Req) => Promise<Res>; errors: { Error: typeof ZapierError } };

class ZapierError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** A Zapier z: runs a request through the app's beforeRequest and afterResponse, against the real routes. */
function makeZ(key: string): Z {
  const routes: { test: RegExp; handler: (request: Request) => Promise<Response> }[] = [
    { test: /\/api\/v1\/store$/, handler: getStore },
    { test: /\/api\/v1\/hooks$/, handler: hooksRouter },
    { test: /\/api\/v1\/events/, handler: getEvents },
    { test: /\/api\/v1\/leads\/labels$/, handler: postLabels },
    { test: /\/api\/v1\/leads$/, handler: postLeads },
    { test: /\/api\/v1\/access$/, handler: postAccess },
    { test: /\/api\/v1\/products/, handler: getProducts },
    { test: /\/api\/v1\/codes$/, handler: postCodes },
  ];
  async function hooksRouter(request: Request): Promise<Response> {
    return request.method === "DELETE" ? deleteHook(request) : postHook(request);
  }
  const z: Z = {
    errors: { Error: ZapierError },
    request: async (raw: Req) => {
      let req: Req = { headers: {}, method: "GET", ...raw };
      for (const hook of app.beforeRequest) req = hook(req, z, { authData: { api_key: key }, inputData: {} });
      const url = new URL(req.url);
      for (const [name, value] of Object.entries(req.params ?? {})) url.searchParams.set(name, String(value));
      const route = routes.find((r) => r.test.test(url.pathname));
      if (!route) throw new Error(`no route for ${url.pathname}`);
      const init: RequestInit = { method: req.method, headers: req.headers as Record<string, string> };
      if (req.body !== undefined) {
        init.body = JSON.stringify(req.body);
        init.headers = { ...(req.headers as Record<string, string>), "Content-Type": "application/json" };
      }
      const response = await route.handler(new Request(url.toString(), init));
      const content = await response.text();
      let data: { data?: unknown } = {};
      try {
        data = JSON.parse(content);
      } catch {
        data = {};
      }
      let res: Res = { status: response.status, data, content };
      for (const hook of app.afterResponse) res = hook(res, z);
      return res;
    },
  };
  return z;
}

const emails: { to: string | string[]; subject: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as { to: string | string[]; subject: string });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url}` } }), { status: 404 });
}) as typeof fetch;

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

/** The top-level fields of the object a source file passes to emitEvent for one event, sorted. */
function sentFields(source: string, event: string): string[] {
  const at = source.indexOf(`emitEvent(store, "${event}",`);
  if (at < 0) throw new Error(`no emitEvent for ${event}`);
  // The object follows the seed, which may be a template with its own "${...}": it is the first ", {" after the call.
  const open = source.indexOf(", {", at) + 2;
  if (open < 2) throw new Error(`no object for ${event}`);
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") depth -= 1;
    if (depth === 0) break;
  }
  // Top level only: a key is read up to its ":" (or its "," when written short, as `email,`), and its value is skipped to the next ",".
  const keys: string[] = [];
  depth = 0;
  let token = "";
  let inValue = false;
  for (const ch of source.slice(open + 1, end) + ",") {
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    if (depth !== 0) continue;
    if (ch === ",") {
      if (!inValue && /^[a-z_]+$/.test(token.trim())) keys.push(token.trim());
      token = "";
      inValue = false;
    } else if (ch === ":" && !inValue) {
      keys.push(token.trim());
      inValue = true;
    } else if (!inValue) token += ch;
  }
  return [...new Set(keys)].sort();
}

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_zapier_app_only_a_stand_in";
  redis.clear();
  const OWNER = "chef@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Z0000001", subscriptionId: "sub_Z0000001", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "The Weeknight Cookbook", "", "29", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/cookbook");
  const store = (await storeForEmail(OWNER))!;
  const reader = await makeKey(store.sid!, "Reader");
  const writer = await makeKey(store.sid!, "Zapier", Date.now(), true);
  if (!reader.ok || !writer.ok) throw new Error("no key");

  const bundle = (over: Partial<Bundle> = {}): Bundle => ({ authData: { api_key: writer.key }, inputData: {}, ...over });
  const sale = app.triggers.sale_completed.operation;

  part("The connection is a store, by a key");
  const tested = await app.authentication.test(makeZ(writer.key));
  is("the key names its store", [tested.handle, tested.name], ["harbor", "Harbor Kitchen"]);

  part("A Zap subscribes, and only a key that writes may");
  const readerFailed = await sale
    .performSubscribe!(makeZ(reader.key), bundle({ authData: { api_key: reader.key }, targetUrl: "https://hooks.zapier.com/1" }))
    .then(() => "", (error: ZapierError) => error.code);
  is("a key made to read cannot subscribe a Zap", readerFailed, "read_only");
  const subscribed = await sale.performSubscribe!(makeZ(writer.key), bundle({ targetUrl: "https://hooks.zapier.com/hooks/catch/1/abc" }));
  await new Promise<void>(resolve => setImmediate(resolve));
  is("the endpoint is added, with an id", /^we_[0-9a-f]{16}$/.test(subscribed.id), true);
  is("the creator is told, as for one added in the studio", emails.some((e) => /webhook was added/i.test(e.subject)), true);

  part("The five-endpoint ceiling counts a Zap's too");
  const extra = [];
  for (let i = 0; i < MAX_ENDPOINTS; i += 1) {
    extra.push(
      await app.triggers.refund_issued.operation
        .performSubscribe!(makeZ(writer.key), bundle({ targetUrl: `https://hooks.zapier.com/hooks/catch/1/n${i}` }))
        .then(() => "ok", (error: ZapierError) => error.code),
    );
  }
  is("the sixth endpoint is refused as full", extra[extra.length - 1], "full");

  part("The examples are only messages already sent");
  await emitEvent(store, "sale.completed", "cs_live_example", {
    checkout_session: "cs_live_example",
    product: { id: guide.product.id, title: "The Weeknight Cookbook" },
    amount_cents: 2900,
    currency: "usd",
    buyer: { email: "ada@example.com", name: "Ada" },
  });
  const examples = (await (sale as unknown as { performList: (z: Z, b: Bundle) => Promise<Record<string, unknown>[]> }).performList(makeZ(writer.key), bundle())) as { type: string; data: { checkout_session: string } }[];
  is("one sale example, as its webhook was sent", [examples.length, examples[0]?.type, examples[0]?.data.checkout_session], [1, "sale.completed", "cs_live_example"]);
  const none = await getEvents(new Request(`https://marktmorgen.com/api/v1/events?type=sale.completed`, { headers: { Authorization: `Bearer ${writer.key}` } }));
  is("an unknown event type is refused, not guessed", (await getEvents(new Request(`https://marktmorgen.com/api/v1/events?type=not.an.event`, { headers: { Authorization: `Bearer ${writer.key}` } }))).status, 400);
  is("a known one is read", none.status, 200);

  part("Turning the Zap off removes its endpoint");
  await sale.performUnsubscribe!(makeZ(writer.key), bundle({ subscribeData: { id: subscribed.id } }));
  await new Promise<void>(resolve => setImmediate(resolve));
  is("the creator is told it was removed", emails.some((e) => /webhook.*removed/i.test(e.subject)), true);
  const gone = await deleteHook(new Request("https://marktmorgen.com/api/v1/hooks", { method: "DELETE", headers: { Authorization: `Bearer ${writer.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: subscribed.id }) }));
  is("removing the same endpoint again says it is not there", gone.status, 404);

  part("Every trigger is an event the webhooks send; every action is an API write");
  const triggerEvents = app.EVENTS.map((e) => e.event);
  is("each hook trigger stands for a webhook event", triggerEvents.every((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e)), true);
  is("every event the webhooks send has its trigger, once", [...triggerEvents].sort(), [...WEBHOOK_EVENTS].sort());
  is("each event's trigger is the one named for it", app.EVENTS.every((e) => app.triggers[e.key]?.operation.type === "hook" && e.key === e.event.replace(".", "_")), true);

  part("Each example says what its webhook really sends, field by field");
  for (const [event, file] of [["membership.changed", "lib/webhooks.ts"], ["dispute.opened", "lib/webhooks.ts"], ["sequence.step", "lib/flows.ts"]] as const) {
    const spec = app.EVENTS.find((e) => e.event === event);
    const sample = spec ? (app.triggers[spec.key].operation.sample as { type?: string; data?: Record<string, unknown> }) : null;
    is(`${event}: the example is that event's message`, sample?.type, event);
    is(`${event}: its fields are the ones ${file} sends`, Object.keys(sample?.data ?? {}).sort(), sentFields(read(file), event));
  }
  const disputeSample = app.triggers.dispute_opened.operation.sample as { data: Record<string, unknown> };
  is("a dispute's example names no buyer, as a dispute's webhook names none", "buyer" in disputeSample.data || /@/.test(JSON.stringify(disputeSample.data)), false);

  part("The triggers added for the other events subscribe to their own event and show only what was sent");
  for (const [key, event, seed, data] of [
    ["membership_changed", "membership.changed", "sub_Z1:1", { subscription: "sub_Z1", product: { id: guide.product.id, title: "The Weeknight Cookbook" }, option: null, from: null, to: null, changed_at: "2026-10-21T10:00:00.000Z" }],
    ["dispute_opened", "dispute.opened", "dp_Z1", { dispute: "dp_Z1", charge: "ch_Z1", amount_cents: 2900, currency: "usd", reason: "fraudulent", status: "needs_response" }],
    ["sequence_step", "sequence.step", "f1:s1:ada@example.com", { sequence: { id: "f1", name: "Welcome" }, step: 1, email: "ada@example.com" }],
  ] as const) {
    const op = app.triggers[key].operation as Op & { performList: (z: Z, b: Bundle) => Promise<{ type: string }[]> };
    const zap = await op.performSubscribe!(makeZ(writer.key), bundle({ targetUrl: `https://hooks.zapier.com/hooks/catch/1/${key}` }));
    is(`${event}: the Zap's endpoint hears that event and nothing else`, (await webhooksView(store)).endpoints.find((e) => e.id === zap.id)?.events, [event]);
    is(`${event}: no example before one was sent, never a made-up one`, (await op.performList(makeZ(writer.key), bundle())).length, 0);
    await emitEvent(store, event, seed, data);
    const shown = await op.performList(makeZ(writer.key), bundle());
    is(`${event}: the example is the message sent`, [shown.length, shown[0]?.type], [1, event]);
    await op.performUnsubscribe!(makeZ(writer.key), bundle({ subscribeData: { id: zap.id } }));
    is(`${event}: turning the Zap off removes its endpoint`, (await webhooksView(store)).endpoints.some((e) => e.id === zap.id), false);
  }
  is("the product list is hidden from the trigger menu", app.triggers.product_list.display.hidden, true);
  is("adding a subscriber requires the agreement the list requires", app.creates.add_subscriber.operation.inputFields.some((f) => f.key === "agreed" && f.required === true), true);
  is("the four actions are the API's writes", Object.keys(app.creates).sort(), ["add_subscriber", "change_labels", "create_discount_code", "give_access"]);

  part("A discount code is made only where the studio would make one, through the real route");
  const codeRefused = await app.creates.create_discount_code.operation
    .perform(makeZ(writer.key), bundle({ inputData: { code: "SPRING20", percent: "20" } }))
    .then(() => "", (error: ZapierError) => error.code);
  is("a store not taking payments is refused with the API's own reason, no code made", codeRefused, "not_selling");
  const codeReader = await app.creates.create_discount_code.operation
    .perform(makeZ(reader.key), bundle({ authData: { api_key: reader.key }, inputData: { code: "SPRING20", percent: "20" } }))
    .then(() => "", (error: ZapierError) => error.code);
  is("a key made to read cannot make a code", codeReader, "read_only");

  part("The action adds to the list only with agreement, through the real route");
  const addSub = app.creates.add_subscriber.operation;
  const refused = await addSub.perform(makeZ(writer.key), bundle({ inputData: { email: "bea@example.com", agreed: false } })).then(() => "", (error: ZapierError) => error.code);
  is("without agreement, refused", refused, "consent");
  const addedOk = (await addSub.perform(makeZ(writer.key), bundle({ inputData: { email: "Bea@Example.com", name: "Bea", tags: "vip", agreed: true } }))) as { email: string; status: string };
  is("with agreement, added by the address as kept", [addedOk.email, addedOk.status], ["bea@example.com", "added"]);

  part("The app names the platform version it installs");
  const pkg = JSON.parse(read("zapier/package.json")) as { dependencies: Record<string, string> };
  is("index.js and package.json agree on the platform version", app.platformVersion, pkg.dependencies["zapier-platform-core"]);

  part("A funded store cannot create new webhook obligations without its cohort");
  await setSubscription(OWNER, { customerId: "cus_Z0000001", subscriptionId: "sub_Z0000001", active: true, period: { ...store.period!, funded: true } });
  const fundedStore = (await storeForEmail(OWNER))!;
  const endpointsBefore = (await webhooksView(fundedStore)).endpoints;
  is("the rejection is not the five-endpoint ceiling", endpointsBefore.length < MAX_ENDPOINTS, true);
  const noticesBefore = emails.length;
  const unavailable = await postHook(new Request("https://marktmorgen.com/api/v1/hooks", {
    method: "POST", headers: { Authorization: `Bearer ${writer.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://hooks.zapier.com/hooks/catch/funded/new", events: ["sale.completed"] }),
  }));
  is("the actual API reports temporary financial unavailability", [unavailable.status, (await unavailable.json()).error], [503, "unavailable"]);
  is("the refusal leaves all endpoints and creator notices unchanged", [(await webhooksView(fundedStore)).endpoints, emails.length], [endpointsBefore, noticesBefore]);
  const retained = endpointsBefore[0];
  if (!retained) throw new Error("missing retained endpoint");
  const removed = await deleteHook(new Request("https://marktmorgen.com/api/v1/hooks", {
    method: "DELETE", headers: { Authorization: `Bearer ${writer.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: retained.id }),
  }));
  is("the actual authenticated DELETE remains available without new cohort approval", removed.status, 200);
  is("only that retained endpoint is removed", (await webhooksView(fundedStore)).endpoints.map(e => e.id), endpointsBefore.filter(e => e.id !== retained.id).map(e => e.id));

  done();
}

void main();
