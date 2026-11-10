/**
 * 604 [WP3] unit 3: the public "Apply first" form route and the studio's
 * decisions, run through the real routes, the real store, the real public and
 * studio counts, over the Redis stand-in (tests/apply-first-redis.ts runs the
 * application scripts). Synthetic only: example.invalid addresses, no email,
 * no checkout, no provider, no network.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST as apply } from "@/app/api/store/apply/route";
import { POST as decide } from "@/app/api/store/applications/route";
import { ApplyFirstStudio } from "@/components/apply-first-studio";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { productSegment } from "@/lib/product-slug";
import { applyTokenDigest } from "@/lib/apply-first-rules";
import {
  APPLY_CONSENT_TEXT, APPLY_CONSENT_VERSION, APPLY_DECIDE_STUDIO_UNITS, APPLY_SUBMIT_REQUEST_UNITS, listApplications,
} from "@/lib/apply-first-store";
import { DECIDE_WORDS } from "@/lib/apply-first-words";
import { COMMAND, DB_BYTE, UNIT_COST, request as costOf } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { paidPeriod } from "./billing-period-fixture";
import { commandsRun, memory, redis } from "./apply-first-redis";

const OWNER = "owner@example.invalid";
const SITE = "https://marktmorgen.com";
let store: Store;
let product = { id: "", segment: "" };
let other = "";
let cookie = "";

async function setUp() {
  memory.clear();
  redis.sent = [];
  redis.fault = null;
  await claimHandle(OWNER, "applyshop", "Apply Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestApply00001", true);
  await setSubscription(OWNER, { customerId: "cus_apply", subscriptionId: "sub_apply", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Group Coaching", "", "900");
  assert.ok(made.ok);
  const plain = await addProduct(OWNER, "Plain Guide", "", "19");
  assert.ok(plain.ok);
  store = (await storeForEmail(OWNER))!;
  product = { id: made.product.id, segment: productSegment(made.product) };
  other = plain.product.id;
  // The mode, as the studio's product setting (a later unit) will write it.
  redis.run(["SADD", `nl:apply:on:${store.sid}`, product.id]);
  cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  redis.sent = [];
}

function form(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const body = new URLSearchParams({ handle: "applyshop", product: product.id, email: "ann@example.invalid", consent: "yes", version: APPLY_CONSENT_VERSION, ...fields });
  return new NextRequest(`${SITE}/api/store/apply`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "marktmorgen.com", origin: SITE, ...headers },
    body: body.toString(),
  });
}
const where = (response: Response) => response.headers.get("location") ?? "";
const statusOf = (response: Response) => new URL(where(response)).searchParams.get("apply");
const touched = (prefix: string) => redis.sent.some((c) => c.slice(1).some((part) => String(part).startsWith(prefix)));

async function studio(body: Record<string, unknown>, headers: Record<string, string> = { cookie }) {
  const response = await decide(new NextRequest(`${SITE}/api/store/applications`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "marktmorgen.com", origin: SITE, ...headers },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; message?: string; application?: { id: string; state: string; expiresAt: number } } };
}

beforeEach(setUp);

test("an application is kept from the plain form, with the sentence agreed to, and the page told only a word", async () => {
  const response = await apply(form({ email: "Ann@Example.invalid " }));
  assert.equal(response.status, 303);
  assert.equal(where(response), `${SITE}/@applyshop/p/${product.segment}?apply=sent#apply`);
  assert.equal(where(response).toLowerCase().includes("ann@"), false, "nothing typed goes in the address");
  const listed = await listApplications(store);
  assert.deepEqual(listed?.map((a) => [a.email, a.offer, a.state, a.consent.text, a.consent.version]), [["ann@example.invalid", product.id, "submitted", APPLY_CONSENT_TEXT, APPLY_CONSENT_VERSION]]);
  // No email is sent and no checkout opened: nothing is written outside the store's applications, its counts and its traffic.
  assert.equal(touched("nl:mail:"), false);
});

test("another site is refused before anything is read", async () => {
  for (const headers of [{ origin: "https://evil.example" }, { origin: "", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    redis.sent = [];
    const response = await apply(form({}, headers));
    assert.equal(response.status, 403);
    assert.deepEqual(redis.sent, [], "not one command");
  }
});

test("the store's public requests are taken before the product, its mode or any application is read, and a store out of them keeps nothing", async () => {
  await apply(form({}));
  const first = (test: (c: (string | number)[]) => boolean) => redis.sent.findIndex(test);
  const traffic = first((c) => String(c[1]).startsWith("nl:traffic:r:") || c.slice(1).some((p) => String(p).startsWith("nl:traffic:r:")));
  const mode = first((c) => c[0] === "SISMEMBER");
  const kept = first((c) => String(c[0]) === "EVAL" && c.slice(1).some((p) => String(p).startsWith("nl:apply:r:")));
  assert.ok(traffic >= 0 && traffic < mode && mode < kept, `${traffic} < ${mode} < ${kept}`);
  // The window's count does not answer: nothing about the application is read or kept.
  memory.clear();
  await setUp();
  redis.fault = (command) => (command.slice(1).some((p) => String(p).startsWith("nl:traffic:r:")) ? "unknown" : undefined);
  const refused = await apply(form({ email: "bob@example.invalid" }));
  assert.equal(where(refused), `${SITE}/@applyshop`);
  assert.equal(touched("nl:apply:"), false);
  redis.fault = null;
  assert.deepEqual(await listApplications(store), []);
});

test("without the box, with an old version, for a product that does not ask, or past a cap, nothing is kept", async () => {
  const cases: [Record<string, string>, string][] = [
    [{ consent: "" }, "consent"],
    [{ version: "apply-first-0" }, "consent"],
    [{ email: "not an address" }, "email"],
    [{ product: other }, "closed"],
  ];
  for (const [fields, status] of cases) {
    const response = await apply(form(fields));
    assert.equal(statusOf(response), status, JSON.stringify(fields));
  }
  assert.deepEqual(await listApplications(store), []);
  // A hidden field only a program fills: told it worked, nothing kept.
  assert.equal(statusOf(await apply(form({ website: "https://spam.example" }))), "sent");
  assert.deepEqual(await listApplications(store), []);
  // One connection, ten tries an hour, each counted before the mode or the box is read.
  memory.clear();
  await setUp();
  for (let i = 0; i < 10; i++) assert.equal(statusOf(await apply(form({ email: `p${i}@example.invalid` }))), "sent");
  assert.equal(statusOf(await apply(form({ email: "p10@example.invalid" }))), "limited");
  // Unknown is never "closed" or "sent": a mode read in another shape is an error.
  memory.clear();
  await setUp();
  redis.fault = (command) => (command[0] === "SISMEMBER" ? "1" : undefined);
  assert.equal(statusOf(await apply(form({}))), "error");
  redis.fault = null;
  assert.deepEqual(await listApplications(store), []);
  // A product that is not the store's goes back to the store's page.
  assert.equal(where(await apply(form({ product: "nope" }))), `${SITE}/@applyshop`);
});

test("the studio approves and declines, says a change or an unknown as such, and never sends the link's token to the page", async () => {
  await apply(form({}));
  await apply(form({ email: "bob@example.invalid" }));
  const [ann, bob] = (await listApplications(store))!;
  // Signed out, or from another site: refused before anything is decided.
  assert.equal((await studio({ action: "approve", id: ann.id, days: 7 }, {})).status, 401);
  assert.equal((await studio({ action: "approve", id: ann.id, days: 7 }, { cookie, origin: "https://evil.example" })).status, 403);
  for (const days of [0, 31, 1.5, "7"]) {
    const refused = await studio({ action: "approve", id: ann.id, days });
    assert.deepEqual([refused.status, refused.body.error, refused.body.message], [400, "days", DECIDE_WORDS.days], String(days));
  }
  const approved = await studio({ action: "approve", id: ann.id, days: 7 });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.application?.state, "approved");
  assert.equal(JSON.stringify(approved.body).includes("token"), false, "the token is not sent to the page");
  const raw = JSON.parse(String(redis.run(["GET", `nl:apply:r:${store.sid}:${ann.id}`])));
  assert.match(JSON.parse(raw.app).tokenDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(JSON.parse(raw.app).tokenDigest, applyTokenDigest(""));
  assert.deepEqual([(await studio({ action: "approve", id: ann.id, days: 7 })).body.error], ["still_open"]);
  // Changed while deciding: nothing saved, and said so.
  redis.fault = (command) => {
    if (String(command[0]) === "EVAL" && command.slice(1).some((p) => String(p) === `nl:apply:r:${store.sid}:${bob.id}`)) {
      redis.fault = null;
      redis.run(["SET", `nl:apply:r:${store.sid}:${bob.id}`, "written by another press", "EX", 600]);
    }
    return undefined;
  };
  const changed = await studio({ action: "decline", id: bob.id });
  assert.deepEqual([changed.status, changed.body.error, changed.body.message], [409, "changed", DECIDE_WORDS.changed]);
  assert.equal(redis.run(["GET", `nl:apply:r:${store.sid}:${bob.id}`]), "written by another press");
  // A record not written here makes the whole list unknown, never a shorter one.
  assert.equal(await listApplications(store), null);
  redis.run(["DEL", `nl:apply:r:${store.sid}:${bob.id}`]);
  // Whether it was saved is not known: said as unknown, never as done.
  await apply(form({ email: "cy@example.invalid" }));
  const cy = (await listApplications(store))!.find((a) => a.email === "cy@example.invalid")!;
  redis.fault = (command) => (String(command[0]) === "EVAL" && command.slice(1).some((p) => String(p) === `nl:apply:r:${store.sid}:${cy.id}`) ? "1" : undefined);
  const unknown = await studio({ action: "decline", id: cy.id });
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.message], [503, "unknown", DECIDE_WORDS.unknown]);
  redis.fault = null;
  // Declined is final; a gone id is gone.
  assert.equal((await studio({ action: "decline", id: ann.id })).status, 200);
  assert.deepEqual([(await studio({ action: "approve", id: ann.id, days: 3 })).body.error], ["final"]);
  assert.deepEqual([(await studio({ action: "decline", id: "f".repeat(32) })).status], [404]);
  assert.deepEqual([(await studio({ action: "sell", id: ann.id })).status], [400]);
});

test("each door's commands stay inside the requests it takes before it reads", async () => {
  redis.sent = [];
  await apply(form({}));
  const submit = commandsRun(redis.sent);
  // One later page for the request itself, and what the application adds on top, inside the units it takes.
  const priced = APPLY_SUBMIT_REQUEST_UNITS * laterPageCost();
  const needed = laterPageCost() + submit * COMMAND + 3 * 3_072 * DB_BYTE;
  assert.ok(priced >= needed, `submit: ${submit} commands, $${needed.toFixed(7)} > $${priced.toFixed(7)}`);
  console.log(`# an application: ${submit} commands, $${needed.toFixed(7)} at most, inside ${APPLY_SUBMIT_REQUEST_UNITS} public requests at $${priced.toFixed(7)}`);
  const id = (await listApplications(store))![0].id;
  redis.sent = [];
  await studio({ action: "approve", id, days: 7 });
  const decided = commandsRun(redis.sent);
  // The door's studio request and the decision's own, against one request running every command the route sent.
  assert.ok((1 + APPLY_DECIDE_STUDIO_UNITS) * UNIT_COST.studio >= costOf("studio", decided, 50_000), `decide: ${decided} commands`);
  console.log(`# a decision: ${decided} commands, $${costOf("studio", decided, 50_000).toFixed(7)} at most, inside ${1 + APPLY_DECIDE_STUDIO_UNITS} studio requests at $${((1 + APPLY_DECIDE_STUDIO_UNITS) * UNIT_COST.studio).toFixed(7)}`);
});

test("the studio page shows each answer beside its application, with no buttons for a role that may not decide", () => {
  const rows = [
    { id: "a".repeat(32), email: "ann@example.invalid", product: "Group Coaching", state: "submitted" as const, at: Date.UTC(2026, 10, 10), expiresAt: 0 },
    { id: "b".repeat(32), email: "bob@example.invalid", product: "Group Coaching", state: "declined" as const, at: Date.UTC(2026, 10, 9), expiresAt: 0 },
  ];
  const html = renderToStaticMarkup(createElement(ApplyFirstStudio, { rows, now: Date.UTC(2026, 10, 11), canDecide: true }));
  assert.match(html, /aria-label="Approve ann@example.invalid"/);
  assert.match(html, /aria-label="Decline ann@example.invalid"/);
  assert.equal((html.match(/aria-label="Approve /g) ?? []).length, 1, "a declined application has no buttons");
  assert.match(html, /<label[^>]*for="apply-days-a{32}"/);
  assert.match(html, /Nov 10, 2026/);
  assert.equal((html.match(/role="status"/g) ?? []).length, 2, "a status region beside each application");
  const reader = renderToStaticMarkup(createElement(ApplyFirstStudio, { rows, now: Date.UTC(2026, 10, 11), canDecide: false }));
  assert.equal(/<button/.test(reader), false);
  assert.match(renderToStaticMarkup(createElement(ApplyFirstStudio, { rows: [], now: 0, canDecide: true })), /No applications yet\./);
  // The page: an unreadable list is said as not verified, never as empty; reading needs "orders", deciding "send".
  const page = readFileSync("app/studio/applications/page.tsx", "utf8");
  assert.ok(page.includes("This does not mean there are none."));
  assert.ok(page.includes('"orders");') && page.includes('can(view.role, "send")'));
  assert.ok(readFileSync("app/api/store/applications/route.ts", "utf8").includes('guardStoreWrite(request, "send", 1_000)'));
});
