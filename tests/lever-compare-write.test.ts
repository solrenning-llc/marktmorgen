/**
 * 752 [CD3], unit 3: the two settings routes the "Grow your sales" switch
 * uses compare what is saved with what the page read, inside the store's
 * write lock, and refuse with "changed" (nothing written) when another tab,
 * another person or the settings form changed it since. The card and both
 * settings forms say so and ask for a reload.
 *
 * Real route handlers, a real session, a synthetic store in the Redis stub;
 * no email is sent and no provider is called.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, setNextOffer, setRecovery, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { type LeverRoute, type LeverSwitch, SWITCH_START, leverToggle, pressLever, toggleOutcome } from "@/lib/sales-lever-toggle-rules";
import { POST as recoveryRoute } from "@/app/api/store/recovery/route";
import { POST as assistantRoute } from "@/app/api/store/assistant-settings/route";
import { store as redis } from "./redis-stub";

const OWNER = "compare.maker@example.test";
const A = "100 Synthetic Way, Testville, CA 90000";
const C = "200 Other Road, Testville, CA 90001";
const ORIGIN = "https://marktmorgen.com";
const ROUTES: Record<LeverRoute, (request: NextRequest) => Promise<Response>> = {
  "/api/store/recovery": recoveryRoute,
  "/api/store/assistant-settings": assistantRoute,
};

async function world() {
  redis.clear();
  delete process.env.RESEND_API_KEY;
  await claimHandle(OWNER, "comparefixture", "Synthetic compare shop", "");
  assert.ok((await setStripeAccount(OWNER, "acct_1Synthetic00002")).ok);
  const session = await openSession(OWNER);
  const send = async (route: LeverRoute, body: unknown) => {
    const response = await ROUTES[route](
      new NextRequest(`${ORIGIN}${route}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { send, read: async () => (await storeForEmail(OWNER))! };
}

const toggle = (store: Store, key: "recovery" | "next"): LeverSwitch => {
  const control = leverToggle(key, { store, role: "owner", addOn: true });
  assert.equal(control.kind, "toggle");
  return control as LeverSwitch;
};

test("recovery route: saves only when the saved setting is still the one the page read", async () => {
  const { send, read } = await world();
  assert.ok((await setRecovery(OWNER, { enabled: true, address: A, asks: true })).ok);
  const before = JSON.stringify((await read()).recovery);

  // The page read it off: it was turned on since. Nothing is written.
  const stale = await send("/api/store/recovery", { enabled: false, address: A, expect: { enabled: false, address: A } });
  assert.deepEqual([stale.status, stale.body], [409, { ok: false, error: "changed" }]);
  assert.equal(JSON.stringify((await read()).recovery), before);

  // The page read another address: it was changed since. Nothing is written.
  const moved = await send("/api/store/recovery", { enabled: false, address: C, expect: { enabled: true, address: C } });
  assert.deepEqual([moved.status, moved.body.error], [409, "changed"]);
  assert.equal(JSON.stringify((await read()).recovery), before);

  // An expectation that is not a setting is not a request.
  for (const expect of ["on", null, [], { enabled: "true", address: A }, { enabled: true }, { enabled: true, address: 7 }]) {
    const bad = await send("/api/store/recovery", { enabled: false, address: A, expect });
    assert.deepEqual([bad.status, bad.body.error], [400, "invalid"], JSON.stringify(expect));
  }
  assert.equal(JSON.stringify((await read()).recovery), before);

  // The page read what is saved: switched off, address kept.
  const fresh = await send("/api/store/recovery", { enabled: false, address: A, expect: { enabled: true, address: A } });
  assert.equal(fresh.status, 200);
  assert.equal((await read()).recovery.enabled, false);
  assert.equal((await read()).recovery.address, A);
});

test("assistant route: the next offer saves only when it is still the one the page read; its other settings are untouched", async () => {
  const { send, read } = await world();
  assert.ok(await setNextOffer(OWNER, { on: true, email: true }));
  const stale = await send("/api/store/assistant-settings", { next: { on: false, email: false }, expect: { on: false, email: false } });
  assert.deepEqual([stale.status, stale.body], [409, { ok: false, error: "changed" }]);
  const emailMoved = await send("/api/store/assistant-settings", { next: { on: false, email: false }, expect: { on: true, email: false } });
  assert.equal(emailMoved.body.error, "changed");
  assert.deepEqual((await read()).nextOffer, { on: true, email: true });
  for (const expect of ["on", null, { on: "true", email: false }, { on: true }]) {
    const bad = await send("/api/store/assistant-settings", { next: { on: false, email: false }, expect });
    assert.deepEqual([bad.status, bad.body.error], [400, "invalid"], JSON.stringify(expect));
  }
  assert.deepEqual((await read()).nextOffer, { on: true, email: true });
  const fresh = await send("/api/store/assistant-settings", { next: { on: false, email: false }, expect: { on: true, email: true } });
  assert.deepEqual(fresh.body, { ok: true, next: { on: false, email: false } });
  // The chat's own switch is not the next offer's: no expectation is asked of it.
  const chat = await send("/api/store/assistant-settings", { on: false, notes: "" });
  assert.equal(chat.body.ok, true);
});

test("the comparison is made with the store's write lock held, and a record that cannot be read there is never written", async () => {
  const source = readFileSync("lib/store.ts", "utf8");
  for (const name of ["setRecovery", "setNextOffer"]) {
    const start = source.indexOf(`export async function ${name}(`);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    assert.match(body, /patchStore\(email, \(store\) => \{[\s\S]*expect[\s\S]*return null;/, name);
  }
  await world();
  assert.ok((await setRecovery(OWNER, { enabled: true, address: A, asks: true })).ok);
  assert.deepEqual(await setRecovery(OWNER, { enabled: false, address: A, asks: true }, { enabled: false, address: A }), { ok: false, reason: "changed" });
  assert.equal(await setNextOffer(OWNER, { on: true, email: false }, { on: true, email: false }), "changed");
  // A record that cannot be read inside the lock: refused, and left as it was.
  const key = `nl:store:owner:${createHash("sha256").update(`nimbus-store:${OWNER}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", key, "{not a store"]]);
  assert.deepEqual(await setRecovery(OWNER, { enabled: false, address: A, asks: true }, { enabled: true, address: A }), { ok: false, reason: "none" });
  assert.equal(await setNextOffer(OWNER, { on: false, email: false }, { on: false, email: false }), null);
  assert.deepEqual(await redis.pipeline([["GET", key]]), ["{not a store"]);
});

test("another tab's change is never lost to the card's switch, and the card asks for a reload", async () => {
  const { send, read } = await world();
  assert.ok((await setRecovery(OWNER, { enabled: true, address: A, asks: true })).ok);
  assert.ok(await setNextOffer(OWNER, { on: false, email: false }));
  // This tab drew its cards.
  const page = await read();
  const recovery = toggle(page, "recovery");
  const next = toggle(page, "next");
  // Another tab: a new address (saved as its route saves it once its checks pass: no email sender is set up here); the next offer on with its email line.
  assert.ok((await setRecovery(OWNER, { enabled: true, address: C, asks: true }, { enabled: true, address: A })).ok);
  assert.equal((await send("/api/store/assistant-settings", { next: { on: true, email: true }, expect: { on: false, email: false } })).status, 200);

  const post = async (route: LeverRoute, body: Record<string, unknown>) => (await send(route, body)).body;
  for (const control of [recovery, next]) {
    const view = await pressLever(control, SWITCH_START, "switch", post);
    assert.equal(view.outcome?.state, "refused", control.key);
    assert.match(view.outcome!.text, /^Nothing was changed\. It was changed in another tab or by someone else/);
    assert.match(view.outcome!.text, /Reload/);
    assert.equal(view.flipped, "unknown", control.key);
    assert.equal(view.undo, false);
  }
  const now = await read();
  assert.deepEqual([now.recovery.enabled, now.recovery.address], [true, C]);
  assert.deepEqual(now.nextOffer, { on: true, email: true });
});

test("the card's switch and its Undo carry the state they expect", () => {
  const store = { name: "S", stripeAccountId: "acct_1Synthetic00002", recovery: { enabled: true, address: A, asks: true }, nextOffer: { on: true, email: true } } as unknown as Store;
  const recovery = toggle(store, "recovery");
  assert.deepEqual(recovery.body, { enabled: false, address: A, expect: { enabled: true, address: A } });
  assert.deepEqual(recovery.undoBody, { enabled: true, address: A, expect: { enabled: false, address: A } });
  const next = toggle(store, "next");
  assert.deepEqual(next.body, { next: { on: false, email: false }, expect: { on: true, email: true } });
  assert.deepEqual(next.undoBody, { next: { on: true, email: true }, expect: { on: false, email: false } });
  const off = toggle({ ...store, nextOffer: { on: false, email: false } } as Store, "next");
  assert.deepEqual(off.body, { next: { on: true, email: false }, expect: { on: false, email: false } });
  assert.deepEqual(off.undoBody, { next: { on: false, email: false }, expect: { on: true, email: false } });
  const changed = toggleOutcome(recovery, { ok: false, error: "changed" });
  assert.equal(changed.state, "refused");
  if (changed.state === "refused") assert.equal(changed.changed, true);
});

test("both settings forms send what they read, and say a change made elsewhere as such", () => {
  const recovery = readFileSync("components/recovery-editor.tsx", "utf8");
  assert.match(recovery, /JSON\.stringify\(\{ enabled, address, expect: \{ enabled: recovery\.enabled, address: recovery\.address \} \}\)/);
  assert.match(recovery, /changed: "[^"]*changed in another tab or by someone else[^"]*Reload[^"]*"/);
  const assistant = readFileSync("components/store-assistant-editor.tsx", "utf8");
  assert.match(assistant, /next: \{ on: nextOn, email: nextOn && nextEmail \}, expect: \{ on: next\.on, email: next\.email \}/);
  assert.match(assistant, /changed in another tab or by someone else/);
});
