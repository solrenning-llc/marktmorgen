/**
 * Marktmorgen for Zapier (zapier/index.js): a message that reaches a Zap's
 * hook is passed on only when it carries the signature the store's webhooks
 * put on every message (lib/webhooks.ts, `signature`, `signatureFor`): the
 * header Marktmorgen-Signature, "t=<seconds>,v1=<hex>", the hex HMAC-SHA256
 * of "<seconds>.<raw body>" under the endpoint's secret, which the Zap kept
 * when it subscribed. Before this, the trigger passed on whatever body
 * arrived at its URL, signed or not, and of any age.
 *
 * Synthetic: a stand-in z and Zapier-shaped bundles (rawRequest with
 * Zapier's Http- headers, and the cleanedRequest Zapier also gives). The
 * signatures are made by the server's own functions. No route, no network.
 */
import { signature, signatureFor } from "@/lib/webhooks";
import { done, is, part } from "./check";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require("../zapier/index.js") as ZapierApp;

type Reply = { status: number; data: unknown; content?: string };
type Z = { request: (r: unknown) => Promise<Reply>; errors: { Error: typeof ZapierError; HaltedError: typeof HaltedError } };
type Run = (z: Z, b: Record<string, unknown>) => Promise<unknown>;
type ZapierApp = {
  afterResponse: ((r: Reply, z: Z) => Reply)[];
  triggers: Record<string, { operation: { perform: Run; performSubscribe: Run } }>;
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
/** Zapier's HaltedError: the run stops and shows as halted, and never turns the Zap off. */
class HaltedError extends Error {}

function fakeZ(reply: Reply = { status: 200, data: {} }): Z {
  const z: Z = { errors: { Error: ZapierError, HaltedError }, request: async () => app.afterResponse[0](reply, z) };
  return z;
}

/** What a call ended as: what it passed on, a halt, or the code of an error. */
async function outcome(call: () => Promise<unknown>): Promise<{ passed: unknown } | { halted: true } | { error: string }> {
  try {
    return { passed: await call() };
  } catch (error) {
    if (error instanceof HaltedError) return { halted: true };
    return { error: error instanceof ZapierError ? error.code : `not a Zapier error: ${String(error)}` };
  }
}

const SECRET = "whsec_" + "a".repeat(32);
const OTHER = "whsec_" + "b".repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const event = { id: "evt_0f1e2d3c4b5a69788796a5b4c3d2e1f0", type: "sale.completed", created: now(), store: { handle: "harbor" }, data: { amount_cents: 2900 } };
const body = JSON.stringify(event);

/** A delivery as Zapier hands it to perform: headers with its Http- prefix, the raw body, the parsed one. */
function delivery(headers: Record<string, string>, content = body, secret: unknown = SECRET) {
  const prefixed = Object.fromEntries(Object.entries(headers).map(([k, v]) => [`Http-${k}`, v]));
  let cleaned: unknown = {};
  try {
    cleaned = JSON.parse(content);
  } catch {
    cleaned = {};
  }
  return { subscribeData: { id: "we_0123456789abcdef", secret }, rawRequest: { method: "POST", headers: prefixed, content, querystring: "" }, cleanedRequest: cleaned };
}
const signed = (t = now(), secret = SECRET, content = body) => ({ "Marktmorgen-Signature": signature(secret, t, content), "Marktmorgen-Timestamp": String(t), "Marktmorgen-Event-Id": event.id });

const perform = (b: Record<string, unknown>) => outcome(() => app.triggers.sale_completed.operation.perform(fakeZ(), b));

async function main() {
  part("A message signed with the Zap's secret is passed on, as it was signed");
  is("a fresh, valid signature passes the event", await perform(delivery(signed())), { passed: [event] });
  const rolled = (stored: string) => {
    const t = now();
    const header = signatureFor({ secret: OTHER, previous: SECRET, previousUntil: Date.now() + 3_600_000 }, t, body);
    return delivery({ "Marktmorgen-Signature": header, "Marktmorgen-Timestamp": String(t) }, body, stored);
  };
  is("during a secret's roll, a Zap holding the old secret still passes (any v1 matches)", await perform(rolled(SECRET)), { passed: [event] });
  is("and one holding the new secret too", await perform(rolled(OTHER)), { passed: [event] });
  const lower = delivery({});
  lower.rawRequest.headers = { "marktmorgen-signature": signature(SECRET, now(), body) };
  is("a header in plain lower case is read too", await perform(lower), { passed: [event] });
  is("a message signed 4 minutes ago is still recent", await perform(delivery(signed(now() - 240))), { passed: [event] });

  part("A signed message of another event is not this trigger's (control)");
  const other = JSON.stringify({ ...event, type: "refund.issued" });
  is("another event, validly signed, passes nothing", await perform(delivery(signed(now(), SECRET, other), other)), { passed: [] });

  part("A bad signature is refused and never reaches the Zap");
  is("signed with another secret", await perform(delivery(signed(now(), OTHER))), { halted: true });
  const tampered = body.replace("2900", "1");
  is("a body changed after signing", await perform(delivery(signed(), tampered)), { halted: true });
  const sig = signature(SECRET, now(), body);
  is("a v1 cut short", await perform(delivery({ "Marktmorgen-Signature": sig.slice(0, -2) })), { halted: true });
  is("a v1 that is not hex", await perform(delivery({ "Marktmorgen-Signature": sig.replace(/v1=.{4}/, "v1=zzzz") })), { halted: true });
  const t = now();
  is("a time changed after signing", await perform(delivery({ "Marktmorgen-Signature": signature(SECRET, t, body).replace(`t=${t}`, `t=${t + 1}`) })), { halted: true });
  is("two times in one header", await perform(delivery({ "Marktmorgen-Signature": `t=${t},${signature(SECRET, t, body)}` })), { halted: true });

  part("A missing signature is refused");
  is("no signature header (the old trigger passed this on)", await perform(delivery({ "Marktmorgen-Timestamp": String(now()) })), { halted: true });
  is("a header with no v1", await perform(delivery({ "Marktmorgen-Signature": `t=${now()}` })), { halted: true });
  is("a header with no time", await perform(delivery({ "Marktmorgen-Signature": signature(SECRET, now(), body).replace(/^t=\d+,/, "") })), { halted: true });
  is("an empty header", await perform(delivery({ "Marktmorgen-Signature": "" })), { halted: true });
  const noRaw = delivery(signed());
  is("no raw request to check (only the parsed body)", await perform({ subscribeData: noRaw.subscribeData, cleanedRequest: noRaw.cleanedRequest }), { halted: true });
  is("no secret kept for the Zap", await perform(delivery(signed(), body, null)), { halted: true });
  is("an empty secret kept for the Zap", await perform(delivery({ "Marktmorgen-Signature": signature("", now(), body) }, body, "")), { halted: true });

  part("An old message is refused");
  is("signed an hour ago", await perform(delivery(signed(now() - 3600))), { halted: true });
  is("signed 6 minutes ago", await perform(delivery(signed(now() - 360))), { halted: true });
  is("signed an hour ahead", await perform(delivery(signed(now() + 3600))), { halted: true });

  part("A subscription is kept only with the secret it signs with");
  const subscribed = { id: "we_0123456789abcdef", where: "hooks.zapier.com", events: ["sale.completed"], added_at: "2026-11-06T00:00:00.000Z" };
  const subscribe = (data: unknown) => outcome(() => app.triggers.sale_completed.operation.performSubscribe(fakeZ({ status: 200, data: { data } }), { targetUrl: "https://hooks.zapier.com/x" }));
  is("an answer with no secret is not a subscription", await subscribe(subscribed), { error: "unconfirmed_response" });
  is("nor one with an empty secret", await subscribe({ ...subscribed, secret: "" }), { error: "unconfirmed_response" });
  is("one with its secret is kept whole (control)", await subscribe({ ...subscribed, secret: SECRET }), { passed: { ...subscribed, secret: SECRET } });

  done();
}

void main();
