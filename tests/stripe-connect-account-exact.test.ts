// CX-123 rule 24, at readAccount (lib/stripe-connect.ts): Stripe's answer about a
// connected account is read in its exact shape. A 200 without
// configuration.merchant (the include ignored, a change of shape in API v2, a
// body that is not JSON) was read as "card payments off", and the studio routes
// app/api/stripe/check and app/api/stripe/return wrote that down with
// setStripeAccount: a selling store's checkout closed and the creator read
// "stripe=pending" while nothing was known. A 200 without `requirements` was read
// as "nothing outstanding", so the checkup said all was fine and never warned of
// a documents deadline that had passed. Now any other shape throws: the routes
// answer "stripe=error" and write nothing, the checkup says "not-checked".
// Synthetic store, synthetic session, Stripe mocked; MemoryRedis (tests/redis-stub.ts).
import { NextRequest } from "next/server";
import { GET as returnGET } from "@/app/api/stripe/return/route";
import { POST as checkPOST } from "@/app/api/stripe/check/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { within } from "@/lib/checkup";
import { stripeCheck } from "@/lib/checkup-rules";
import { type AccountState, readAccount } from "@/lib/stripe-connect";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_connect_account_exact_only";
const ACCOUNT = "acct_1ExactShape";

/** The body Stripe answers with, as raw text so a body that is not JSON can be sent too. */
let body = "";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || !url.pathname.startsWith(`/v2/core/accounts/${ACCOUNT}`)) {
    throw new Error(`Unexpected synthetic provider request: ${url}`);
  }
  stripeCalls++;
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const card = (status: unknown) => ({ merchant: { capabilities: { card_payments: { status } } } });
const shaped = (status: unknown, requirements: unknown) => JSON.stringify({ id: ACCOUNT, configuration: card(status), requirements });

/** Shapes that say nothing certain: each must throw, never read as "off" or "nothing due". */
const UNKNOWN: ReadonlyArray<readonly [string, string]> = [
  ["no configuration (the include ignored)", JSON.stringify({ id: ACCOUNT, requirements: { summary: {} } })],
  ["configuration not an object", JSON.stringify({ id: ACCOUNT, configuration: "merchant", requirements: { summary: {} } })],
  ["no merchant", JSON.stringify({ id: ACCOUNT, configuration: {}, requirements: { summary: {} } })],
  ["merchant null", JSON.stringify({ id: ACCOUNT, configuration: { merchant: null }, requirements: { summary: {} } })],
  ["no capabilities", JSON.stringify({ id: ACCOUNT, configuration: { merchant: {} }, requirements: { summary: {} } })],
  ["no card_payments", JSON.stringify({ id: ACCOUNT, configuration: { merchant: { capabilities: {} } }, requirements: { summary: {} } })],
  ["card_payments an array", JSON.stringify({ id: ACCOUNT, configuration: { merchant: { capabilities: { card_payments: ["active"] } } }, requirements: { summary: {} } })],
  ["status missing", JSON.stringify({ id: ACCOUNT, configuration: { merchant: { capabilities: { card_payments: {} } } }, requirements: { summary: {} } })],
  ["status a number", shaped(1, { summary: {} })],
  ["status empty", shaped("", { summary: {} })],
  ["status null", shaped(null, { summary: {} })],
  ["no requirements, card payments active", JSON.stringify({ id: ACCOUNT, configuration: card("active") })],
  ["requirements a string", shaped("active", "none")],
  ["requirements an array", shaped("active", [])],
  ["requirements without summary", shaped("active", {})],
  ["summary a string", shaped("active", { summary: "ok" })],
  ["summary an array", shaped("active", { summary: [] })],
  ["minimum_deadline a string", shaped("active", { summary: { minimum_deadline: "past_due" } })],
  ["minimum_deadline an array", shaped("active", { summary: { minimum_deadline: [] } })],
  ["minimum_deadline without status", shaped("active", { summary: { minimum_deadline: {} } })],
  ["minimum_deadline status a number", shaped("active", { summary: { minimum_deadline: { status: 3 } } })],
  // Codex Z on #3311 (review 5820295862): a status that is not one Stripe documents is not known either.
  // "inactive" is a v1 Capability status, not one of the v2 card_payments statuses (stripe-node v22.6.0, API
  // 2026-08-26.dahlia: active | pending | restricted | unsupported), so it is unknown here (Codex U on #3311).
  ["card status 'inactive' (v1, not a v2 status)", shaped("inactive", { summary: {} })],
  ["card status a single space", shaped(" ", { summary: {} })],
  ["card status a value Stripe does not document", shaped("future_unknown", { summary: {} })],
  ["card status in other letter case", shaped("Active", { summary: {} })],
  ["deadline status a value Stripe does not document", shaped("active", { summary: { minimum_deadline: { status: "someday_due" } } })],
  ["deadline status empty", shaped("active", { summary: { minimum_deadline: { status: "" } } })],
  ["only an id", JSON.stringify({ id: ACCOUNT })],
  ["empty object", "{}"],
  ["JSON null", "null"],
  ["JSON array", "[]"],
  ["JSON number", "7"],
  ["not JSON", "<html>maintenance</html>"],
];

/** Confirmed shapes, read as before. */
const HEALTHY: ReadonlyArray<readonly [string, string, AccountState]> = [
  ["active, eventually due", shaped("active", { summary: { minimum_deadline: { status: "eventually_due" } } }), { chargesEnabled: true, cardPayments: "active", detailsSubmitted: true }],
  ["active, currently due", shaped("active", { summary: { minimum_deadline: { status: "currently_due" } } }), { chargesEnabled: true, cardPayments: "active", detailsSubmitted: true }],
  ["active, past due", shaped("active", { summary: { minimum_deadline: { status: "past_due" } } }), { chargesEnabled: true, cardPayments: "active", detailsSubmitted: false }],
  ["restricted, past due", shaped("restricted", { summary: { minimum_deadline: { status: "past_due" } } }), { chargesEnabled: false, cardPayments: "restricted", detailsSubmitted: false }],
  ["pending, nothing due (empty summary)", shaped("pending", { summary: {} }), { chargesEnabled: false, cardPayments: "pending", detailsSubmitted: true }],
  ["active, minimum_deadline null (nothing due)", shaped("active", { summary: { minimum_deadline: null } }), { chargesEnabled: true, cardPayments: "active", detailsSubmitted: true }],
  ["active, summary null (confirmed none)", shaped("active", { summary: null }), { chargesEnabled: true, cardPayments: "active", detailsSubmitted: true }],
  ["active, requirements null (confirmed none)", shaped("active", null), { chargesEnabled: true, cardPayments: "active", detailsSubmitted: true }],
  ["unsupported, nothing due", shaped("unsupported", { summary: {} }), { chargesEnabled: false, cardPayments: "unsupported", detailsSubmitted: true }],
];

async function read(): Promise<string> {
  try {
    return JSON.stringify(await readAccount(ACCOUNT));
  } catch {
    return "threw";
  }
}

async function main() {
  part("readAccount: every unknown shape throws");
  for (const [label, reply] of UNKNOWN) {
    body = reply;
    is(`${label}: throws`, await read(), "threw");
  }

  part("readAccount: confirmed shapes read as before");
  for (const [label, reply, want] of HEALTHY) {
    body = reply;
    is(`${label}: read`, await read(), JSON.stringify(want));
  }

  part("checkup: an unknown shape is said as not checked, never as fine");
  for (const [label, reply] of [UNKNOWN[0], UNKNOWN[11]] as const) {
    body = reply;
    const account = await within(() => readAccount(ACCOUNT), null, 2_000);
    is(`${label}: payments line`, stripeCheck(true, account).state, "not-checked");
  }
  body = shaped("active", { summary: { minimum_deadline: { status: "past_due" } } });
  is("control, past due: warned", stripeCheck(true, await within(() => readAccount(ACCOUNT), null, 2_000)).state === "ok", false);
  body = shaped("active", { summary: {} });
  is("control, nothing due: ok", stripeCheck(true, await within(() => readAccount(ACCOUNT), null, 2_000)).state, "ok");

  const email = "connect-exact@example.com";
  is("synthetic store", (await claimHandle(email, "connectexact", "A store", "")).ok, true);
  const session = await openSession(email);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const routes = [
    ["return", () => returnGET(new NextRequest("https://marktmorgen.com/api/stripe/return", { headers: { cookie } }))],
    ["check", () => checkPOST(new NextRequest("https://marktmorgen.com/api/stripe/check", { method: "POST", headers: { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" } }))],
  ] as const;
  const said = (response: Response) => new URL(response.headers.get("location") ?? "", "https://marktmorgen.com").searchParams.get("stripe");

  for (const [name, call] of routes) {
    part(`${name}: an unknown shape writes nothing and says the check failed`);
    for (const [label, reply] of [UNKNOWN[0], UNKNOWN[2], UNKNOWN[11], UNKNOWN[26]] as const) {
      is("seeded selling", (await setStripeAccount(email, ACCOUNT, true)).ok, true);
      body = reply;
      stripeCalls = 0;
      const response = await call();
      is(`${name} ${label}: told the check failed`, said(response), "error");
      is(`${name} ${label}: the selling record is unchanged`, (await storeForEmail(email))?.stripeChargesEnabled, true);
      is(`${name} ${label}: Stripe asked once`, stripeCalls, 1);
    }

    part(`${name}: confirmed shapes are written and said as before`);
    for (const [status, charges, word] of [["active", true, "ready"], ["pending", false, "pending"]] as const) {
      is("seeded", (await setStripeAccount(email, ACCOUNT, !charges)).ok, true);
      body = shaped(status, { summary: {} });
      const response = await call();
      is(`${name} ${status}: said`, said(response), word);
      is(`${name} ${status}: written`, (await storeForEmail(email))?.stripeChargesEnabled, charges);
    }
  }
  done();
}

void main();
