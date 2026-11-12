/**
 * Marktmorgen for Zapier.
 *
 * A Zapier integration built only on Marktmorgen's public API
 * (https://marktmorgen.com/developers): a store's API key connects the
 * account; every trigger is an instant one, subscribed through
 * POST /api/v1/hooks and removed through DELETE /api/v1/hooks when the Zap is
 * turned off; the examples Zapier shows while a Zap is set up come from
 * GET /api/v1/events; the actions are the API's own writes. Nothing here
 * reads or sends anything the API does not already allow the same key.
 *
 * Deployed with the Zapier CLI from this folder (docs/zapier-app.md). It is
 * kept as one CommonJS file with no require, so the site's own checks read
 * and test it (tests/zapier-app.test.ts) without installing Zapier's packages.
 */

const API = "https://marktmorgen.com/api/v1";
/** Kept equal to zapier-platform-core in package.json (tests/zapier-app.test.ts). */
const PLATFORM_VERSION = "19.2.1";
const VERSION = "1.0.0";

const addKey = (request, z, bundle) => {
  const key = String((bundle.authData && bundle.authData.api_key) || "").trim();
  if (key) request.headers = Object.assign({}, request.headers, { Authorization: `Bearer ${key}` });
  request.headers = Object.assign({ Accept: "application/json" }, request.headers);
  return request;
};

/** The API answers every refusal with { error, message }: that message is what the creator reads. */
const explain = (response, z) => {
  if (response.status >= 400) {
    let body = response.data;
    if (!body || typeof body !== "object") {
      try {
        body = JSON.parse(response.content);
      } catch {
        body = {};
      }
    }
    const message = (body && body.message) || `Marktmorgen answered ${response.status}. Try again in a moment.`;
    throw new z.errors.Error(message, (body && body.error) || "api_error", response.status);
  }
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    unconfirmed(z);
  }
  return response;
};

/** An unknown write result must not be reported as success or retried here. */
const unconfirmed = (z) => {
  throw new z.errors.Error(
    "Marktmorgen could not confirm this operation. Check its status in your store before trying again.",
    "unconfirmed_response",
    502,
  );
};

/** Keep a write's answer whole, but require the fields that identify its effect; anything else is unconfirmed. */
const hookResult = (response, z, matches) => {
  const body = response.data;
  const data = body && typeof body === "object" && !Array.isArray(body) ? body.data : null;
  if (!data || typeof data !== "object" || Array.isArray(data) || !matches(data)) unconfirmed(z);
  return data;
};

const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;

/** A read whose answer is not the shape the API gives is unknown, never empty or nobody. */
const unknownRead = (z) => {
  throw new z.errors.Error("Marktmorgen's answer could not be read. Try again in a moment.", "unknown_response", 502);
};

/** The `data` of a read: a list of objects, or (`one`) one object that `matches`. */
const readResult = (response, z, { one = false, matches = () => true } = {}) => {
  const body = response.data;
  const data = plain(body) ? body.data : undefined;
  if (one ? !(plain(data) && matches(data)) : !(Array.isArray(data) && data.every(plain))) unknownRead(z);
  return data;
};

/**
 * How a message from the store's webhooks is known to be one (lib/webhooks.ts,
 * `signature`): its Marktmorgen-Signature header is "t=<seconds>,v1=<hex>",
 * the hex HMAC-SHA256 of "<seconds>.<raw body>" under the secret the Zap kept
 * when it subscribed, with a second v1 under the old secret for a day after
 * the creator makes a new one. A message is passed on only when one v1
 * matches and its time is within SIGNATURE_TOLERANCE_SECONDS of now, either
 * way. The server sets no number of its own (it signs at each try, a retry
 * included, and gives up on a try after 8 seconds); five minutes is the
 * window Stripe's scheme, which this one follows, checks.
 *
 * Repeats are not ignored here: Zapier runs this once per message with no
 * memory between runs, so knowing an event id was already passed on would
 * need storage this app does not have (docs/zapier-app.md).
 */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** A header from Zapier's rawRequest, whose names come as "Http-Name", in any case. */
const headerOf = (headers, name) => {
  if (!plain(headers)) return undefined;
  const wanted = [name, `http-${name}`];
  const key = Object.keys(headers).find((k) => wanted.includes(k.toLowerCase()));
  return key === undefined ? undefined : headers[key];
};

/** The time and every v1 of a signature header, or null when it is not that shape. */
const parseSignature = (header) => {
  if (typeof header !== "string") return null;
  let t = null;
  const v1 = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    const name = part.slice(0, at);
    const value = part.slice(at + 1);
    if (name === "t" && t === null && /^[0-9]{1,12}$/.test(value)) t = Number(value);
    else if (name === "v1" && /^[0-9a-f]{64}$/.test(value)) v1.push(value);
    else return null;
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
};

const hmacHex = async (secret, payload) => {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return null;
  const encode = (value) => new TextEncoder().encode(value);
  const key = await subtle.importKey("raw", encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await subtle.sign("HMAC", key, encode(payload)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Equal hex of equal length, compared in time that does not depend on where they differ. */
const sameHex = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Halts the run before the Zap: shown in its history, and never counted toward turning it off. */
const notPassedOn = (z, why) => {
  const Halted = z.errors.HaltedError || z.errors.Error;
  throw new Halted(`This message was not passed on: ${why}`, "unsigned_event", 401);
};

/** The message, parsed from the very bytes that were signed, once its signature and time check out. */
const verifiedMessage = async (z, bundle) => {
  const secret = bundle.subscribeData && bundle.subscribeData.secret;
  const raw = bundle.rawRequest;
  if (!text(secret)) notPassedOn(z, "this Zap has no signing secret. Turn it off and on again.");
  if (!plain(raw) || typeof raw.content !== "string") notPassedOn(z, "its body could not be read to check its signature.");
  const signed = parseSignature(headerOf(raw.headers, "marktmorgen-signature"));
  if (!signed) notPassedOn(z, "it has no Marktmorgen signature.");
  if (Math.abs(Math.floor(Date.now() / 1000) - signed.t) > SIGNATURE_TOLERANCE_SECONDS) notPassedOn(z, "it was not signed within the last 5 minutes.");
  const expected = await hmacHex(secret, `${signed.t}.${raw.content}`);
  if (!expected) notPassedOn(z, "its signature could not be checked here.");
  let matched = false;
  for (const candidate of signed.v1) matched = sameHex(candidate, expected) || matched;
  if (!matched) notPassedOn(z, "its signature does not match this Zap's secret.");
  try {
    return JSON.parse(raw.content);
  } catch {
    return notPassedOn(z, "its signed body is not JSON.");
  }
};

/** What each action's answer must be, exactly as lib/api-write.ts gives it. */
const SUBSCRIBER = (data) => text(data.email) && (data.status === "added" || data.status === "already");
const LABELS = (data) => text(data.email) && Array.isArray(data.labels) && data.labels.every((label) => typeof label === "string");
const ACCESS = (data) => text(data.email) && text(data.product) && (data.status === "given" || data.status === "already") && typeof data.emailed === "boolean";

const authentication = {
  type: "custom",
  fields: [
    {
      key: "api_key",
      label: "API key",
      required: true,
      type: "password",
      helpText:
        "In your Marktmorgen studio, open **Integrations → API keys** and make a key for Zapier. Choose **Can also write** if your Zaps add people to your list, give products or start on a sale, refund or booking; a key that reads only works for nothing here but the connection check.",
    },
  ],
  test: async (z) => {
    const response = await z.request({ url: `${API}/store` });
    return readResult(response, z, { one: true, matches: (data) => text(data.handle) });
  },
  connectionLabel: "{{name}} (@{{handle}})",
};

const store = {
  handle: "harbor",
  name: "Harbor Kitchen",
  url: "https://marktmorgen.com/@harbor",
};

const buyer = { email: "ada@example.com", name: "Ada Lovelace" };
const product = { id: "p_8f2c1a", title: "The Weeknight Cookbook" };

/** One event the store's webhooks can send, and what its message looks like. */
const EVENTS = [
  {
    key: "sale_completed",
    event: "sale.completed",
    noun: "Sale",
    label: "New Sale",
    description: "Triggers when a checkout on your store is paid, or a one-click extra after it.",
    data: {
      checkout_session: "cs_live_a1b2c3",
      kind: "one_time",
      product,
      option: null,
      bundle_items: null,
      order_bump: null,
      order_bumps: [],
      amount_cents: 2900,
      discount_cents: 0,
      currency: "usd",
      buyer,
      paid_at: "2026-10-19T14:05:00.000Z",
      source: { utm_source: "instagram", utm_medium: "bio", utm_campaign: null, utm_content: null, site: null },
    },
  },
  {
    key: "refund_issued",
    event: "refund.issued",
    noun: "Refund",
    label: "New Refund",
    description: "Triggers when a refund is made on your Stripe account for a sale of your store.",
    data: {
      charge: "ch_a1b2c3",
      payment_intent: "pi_a1b2c3",
      product,
      amount_refunded_cents: 2900,
      total_refunded_cents: 2900,
      amount_cents: 2900,
      fully_refunded: true,
      currency: "usd",
      buyer,
      refunded_at: "2026-10-20T09:30:00.000Z",
    },
  },
  {
    key: "lead_captured",
    event: "lead.captured",
    noun: "Lead",
    label: "New Lead",
    description: "Triggers when someone confirms their email address for one of your free products.",
    data: { email: "ada@example.com", agreed_to_emails: true, product, requested_at: 1792440000000 },
  },
  {
    key: "list_joined",
    event: "list.joined",
    noun: "Subscriber",
    label: "New Subscriber",
    description: "Triggers when someone confirms their address to join your email list.",
    data: { email: "ada@example.com", allowed_link_tracking: false, form: null, site: null, requested_at: 1792440000000 },
  },
  {
    key: "membership_started",
    event: "membership.started",
    noun: "Membership",
    label: "New Membership",
    description: "Triggers when someone buys one of your memberships.",
    data: {
      subscription: "sub_a1b2c3",
      checkout_session: "cs_live_a1b2c3",
      product: { id: "p_3d9e7b", title: "The Supper Club" },
      amount_cents: 900,
      currency: "usd",
      trial_days: 0,
      payments: null,
      buyer,
    },
  },
  {
    key: "membership_canceled",
    event: "membership.canceled",
    noun: "Membership",
    label: "Membership Canceled",
    description: "Triggers when a membership is set to end, or ends.",
    data: {
      subscription: "sub_a1b2c3",
      product: { id: "p_3d9e7b", title: "The Supper Club" },
      status: "ending",
      ends_at: "2026-11-19T14:05:00.000Z",
      reason: "cancellation_requested",
      buyer: { email: "ada@example.com", customer: "cus_a1b2c3" },
    },
  },
  {
    key: "call_booked",
    event: "call.booked",
    noun: "Booking",
    label: "New Booking",
    description: "Triggers when a call, a group call or a seat in a live session is booked and paid.",
    data: {
      checkout_session: "cs_live_a1b2c3",
      product: { id: "p_5a6b7c", title: "Menu Review Call" },
      start: "2026-10-24T15:00:00.000Z",
      end: "2026-10-24T15:30:00.000Z",
      kind: "call",
      buyer: { email: "ada@example.com", name: "Ada Lovelace", timezone: "America/New_York" },
      answers: [{ question: "What would you like to cover?", answer: "My first menu." }],
    },
  },
  {
    key: "call_moved",
    event: "call.moved",
    noun: "Booking",
    label: "Booking Moved",
    description: "Triggers when a buyer moves their booking to another time.",
    data: {
      checkout_session: "cs_live_a1b2c3",
      product: { id: "p_5a6b7c", title: "Menu Review Call" },
      from: { start: "2026-10-24T15:00:00.000Z", end: "2026-10-24T15:30:00.000Z" },
      to: { start: "2026-10-25T16:00:00.000Z", end: "2026-10-25T16:30:00.000Z" },
      moves: 1,
      buyer: { email: "ada@example.com", timezone: "America/New_York" },
    },
  },
];

/** A message as the store's webhook sends it. */
const message = (spec) => ({ id: "evt_0f1e2d3c4b5a69788796a5b4c3d2e1f0", type: spec.event, created: 1792440300, store, data: spec.data });

const hookTrigger = (spec) => ({
  key: spec.key,
  noun: spec.noun,
  display: { label: spec.label, description: spec.description },
  operation: {
    type: "hook",
    performSubscribe: async (z, bundle) => {
      const response = await z.request({ url: `${API}/hooks`, method: "POST", body: { url: bundle.targetUrl, events: [spec.event] } });
      return hookResult(response, z, (data) =>
        typeof data.id === "string" && /^we_[0-9a-f]{16}$/.test(data.id) &&
        Array.isArray(data.events) && data.events.length === 1 && data.events[0] === spec.event &&
        // Kept as subscribeData: every message is checked against it.
        text(data.secret),
      );
    },
    performUnsubscribe: async (z, bundle) => {
      const id = bundle.subscribeData && bundle.subscribeData.id;
      const response = await z.request({ url: `${API}/hooks`, method: "DELETE", body: { id } });
      return hookResult(response, z, (data) => typeof id === "string" && /^we_[0-9a-f]{16}$/.test(id) && data.id === id && data.status === "removed");
    },
    perform: async (z, bundle) => {
      const body = await verifiedMessage(z, bundle);
      return plain(body) && body.type === spec.event ? [body] : [];
    },
    performList: async (z) => {
      const response = await z.request({ url: `${API}/events`, params: { type: spec.event, limit: 3 } });
      return readResult(response, z);
    },
    sample: message(spec),
  },
});

const triggers = EVENTS.map(hookTrigger);

/** The store's products, for the product field of "Give Product Access" (hidden from the trigger list). */
const productList = {
  key: "product_list",
  noun: "Product",
  display: { label: "List Products", description: "Lists your store's products.", hidden: true },
  operation: {
    canPaginate: true,
    perform: async (z, bundle) => {
      // The API pages products 200 at a time, its cursor the count already read.
      const cursor = bundle.meta && bundle.meta.page ? String(bundle.meta.page * 200) : undefined;
      const response = await z.request({ url: `${API}/products`, params: cursor ? { cursor } : {} });
      return readResult(response, z);
    },
    sample: { id: "p_8f2c1a", title: "The Weeknight Cookbook", price: 2900, currency: "usd", kind: "one_time", interval: null, hidden: false, url: "https://marktmorgen.com/@harbor/p_8f2c1a" },
  },
};
triggers.push(productList);

const addSubscriber = {
  key: "add_subscriber",
  noun: "Subscriber",
  display: {
    label: "Add Subscriber to List",
    description: "Adds someone who agreed to hear from you to your store's email list, with optional labels.",
  },
  operation: {
    inputFields: [
      { key: "email", label: "Email", required: true, type: "string" },
      { key: "name", label: "Name", required: false, type: "string" },
      { key: "tags", label: "Labels", required: false, type: "string", list: true, helpText: "Labels to put on them, such as webinar or vip." },
      {
        key: "agreed",
        label: "They Agreed to Hear From You",
        required: true,
        type: "boolean",
        helpText:
          "Choose **True** only when this person agreed to receive your emails, for example by checking a box on your form. Marktmorgen refuses anyone without it, and never adds back someone who unsubscribed.",
      },
    ],
    perform: async (z, bundle) => {
      const tags = Array.isArray(bundle.inputData.tags) ? bundle.inputData.tags : bundle.inputData.tags ? [bundle.inputData.tags] : [];
      const response = await z.request({
        url: `${API}/leads`,
        method: "POST",
        body: { email: bundle.inputData.email, name: bundle.inputData.name || "", tags, agreed: bundle.inputData.agreed === true || bundle.inputData.agreed === "true" },
      });
      return hookResult(response, z, SUBSCRIBER);
    },
    sample: { email: "ada@example.com", status: "added" },
  },
};

const changeLabels = {
  key: "change_labels",
  noun: "Labels",
  display: { label: "Add or Remove Labels", description: "Adds labels to, or takes them off, someone already on your list." },
  operation: {
    inputFields: [
      { key: "email", label: "Email", required: true, type: "string" },
      { key: "add", label: "Labels to Add", required: false, type: "string", list: true },
      { key: "remove", label: "Labels to Remove", required: false, type: "string", list: true },
    ],
    perform: async (z, bundle) => {
      const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
      const response = await z.request({
        url: `${API}/leads/labels`,
        method: "POST",
        body: { email: bundle.inputData.email, add: list(bundle.inputData.add), remove: list(bundle.inputData.remove) },
      });
      return hookResult(response, z, LABELS);
    },
    sample: { email: "ada@example.com", labels: ["vip"] },
  },
};

const giveAccess = {
  key: "give_access",
  noun: "Access",
  display: {
    label: "Give Product Access",
    description: "Gives one of your products to an email address without a payment, as importing past buyers does.",
  },
  operation: {
    inputFields: [
      { key: "email", label: "Email", required: true, type: "string" },
      { key: "product", label: "Product", required: true, dynamic: "product_list.id.title" },
      { key: "notify", label: "Email Them a Link", required: false, type: "boolean", default: "false" },
    ],
    perform: async (z, bundle) => {
      const response = await z.request({
        url: `${API}/access`,
        method: "POST",
        body: { email: bundle.inputData.email, product: bundle.inputData.product, notify: bundle.inputData.notify === true || bundle.inputData.notify === "true" },
      });
      return hookResult(response, z, ACCESS);
    },
    sample: { email: "ada@example.com", product: "p_8f2c1a", status: "given", emailed: false },
  },
};

const byKey = (list) => Object.fromEntries(list.map((item) => [item.key, item]));

module.exports = {
  version: VERSION,
  platformVersion: PLATFORM_VERSION,
  authentication,
  beforeRequest: [addKey],
  afterResponse: [explain],
  triggers: byKey(triggers),
  searches: {},
  creates: byKey([addSubscriber, changeLabels, giveAccess]),
  resources: {},
  // For the site's own checks: which events the triggers stand for.
  EVENTS: EVENTS.map((e) => ({ key: e.key, event: e.event })),
};
