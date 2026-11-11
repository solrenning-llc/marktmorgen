/**
 * 752 [CD3], unit 2: the switch on the "Grow your sales" card itself, for the
 * two levers that have an on/off setting (checkout recovery, next offer).
 *
 * Driven through the real settings routes (app/api/store/recovery,
 * app/api/store/assistant-settings) with a real session on a synthetic store
 * in the Redis stub; no email is sent and no provider is called (the
 * recovery route is refused before Stripe when no sender is set up, which is
 * the test environment).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, setNextOffer, setRecovery, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import {
  SWITCH_START,
  type LeverRoute,
  type LeverSwitch,
  leverToggle,
  pressLever,
  switchBack,
} from "@/lib/sales-lever-toggle-rules";
import { SalesLevers, addOnFact } from "@/components/sales-levers";
import type { Role } from "@/lib/team-roles";
import { POST as recoveryRoute } from "@/app/api/store/recovery/route";
import { POST as assistantRoute } from "@/app/api/store/assistant-settings/route";
import { store as redis } from "./redis-stub";

const OWNER = "switch.maker@example.test";
const ADDRESS = "100 Synthetic Way, Testville, CA 90000";
const ORIGIN = "https://marktmorgen.com";

async function world(): Promise<{ session: string; read: () => Promise<Store> }> {
  redis.clear();
  delete process.env.RESEND_API_KEY;
  await claimHandle(OWNER, "switchfixture", "Synthetic switch shop", "");
  const linked = await setStripeAccount(OWNER, "acct_1Synthetic00001");
  assert.ok(linked.ok);
  const session = await openSession(OWNER);
  return { session, read: async () => (await storeForEmail(OWNER))! };
}

/** What the card's fetch does, against the real route handlers. */
function poster(session: string, sent: { route: string; body: unknown }[] = []) {
  const routes: Record<LeverRoute, (request: NextRequest) => Promise<Response>> = {
    "/api/store/recovery": recoveryRoute,
    "/api/store/assistant-settings": assistantRoute,
  };
  return async (route: LeverRoute, body: Record<string, unknown>): Promise<unknown> => {
    sent.push({ route, body });
    const response = await routes[route](
      new NextRequest(`${ORIGIN}${route}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }),
    );
    return response.json();
  };
}

const toggle = (store: Store, key: "recovery" | "next", addOn: boolean | "unknown" = true, role: Role = "owner"): LeverSwitch => {
  const control = leverToggle(key, { store, role, addOn });
  assert.equal(control.kind, "toggle", key);
  return control as LeverSwitch;
};

test("the switch back is the exact reverse, and its reverse is the switch again", () => {
  const store = {
    name: "Synthetic",
    stripeAccountId: "acct_1Synthetic00001",
    recovery: { enabled: true, address: ADDRESS, asks: true },
    nextOffer: { on: true, email: true },
  } as unknown as Store;
  for (const key of ["recovery", "next"] as const) {
    for (const addOn of [true, false, "unknown"] as const) {
      const control = toggle(store, key, addOn);
      const back = switchBack(control);
      assert.equal(back.on, control.to);
      assert.equal(back.to, control.on);
      assert.deepEqual(back.body, control.undoBody);
      assert.deepEqual(back.undoBody, control.body);
      assert.notEqual(back.before, control.before, `${key} ${addOn}`);
      assert.match(back.label, control.on ? /^Turn on/ : /^Turn off/);
      assert.deepEqual(switchBack(back), control);
    }
  }
});

test("next offer: switched on and off from the card through the real route, and Undo puts back the exact earlier setting", async () => {
  const { session, read } = await world();
  // Earlier choice: on, with its line in the confirmation email.
  assert.ok(await setNextOffer(OWNER, { on: true, email: true }));
  const sent: { route: string; body: unknown }[] = [];
  const post = poster(session, sent);
  const control = toggle(await read(), "next", false);

  const off = await pressLever(control, SWITCH_START, "switch", post);
  assert.equal(off.outcome?.state, "saved");
  assert.equal(off.flipped, true);
  assert.equal(off.undo, true);
  assert.match(off.outcome!.text, /Next offer is off/);
  assert.deepEqual((await read()).nextOffer, { on: false, email: false });

  const undone = await pressLever(control, off, "undo", post);
  assert.equal(undone.outcome?.state, "saved");
  assert.equal(undone.flipped, false);
  assert.equal(undone.undo, false);
  assert.deepEqual((await read()).nextOffer, { on: true, email: true });
  assert.deepEqual(sent.map((one) => one.route), ["/api/store/assistant-settings", "/api/store/assistant-settings"]);

  // Undo is offered once: pressing it again sends nothing.
  const again = await pressLever(control, undone, "undo", post);
  assert.deepEqual(again, undone);
  assert.equal(sent.length, 2);

  // The switch itself still works both ways.
  const off2 = await pressLever(control, undone, "switch", post);
  assert.equal(off2.flipped, true);
  const on2 = await pressLever(control, off2, "switch", post);
  assert.equal(on2.flipped, false);
  assert.deepEqual((await read()).nextOffer, { on: true, email: true });
});

test("checkout recovery: off keeps the saved address; a refused switch says nothing was changed and keeps the state", async () => {
  const { session, read } = await world();
  const saved = await setRecovery(OWNER, { enabled: true, address: ADDRESS, asks: true });
  assert.ok(saved.ok);
  const post = poster(session);
  const control = toggle(await read(), "recovery");

  const off = await pressLever(control, SWITCH_START, "switch", post);
  assert.equal(off.outcome?.state, "saved");
  assert.equal((await read()).recovery.enabled, false);
  assert.equal((await read()).recovery.address, ADDRESS);

  // Back on needs email sending set up: the route refuses before any provider is asked.
  const refused = await pressLever(control, off, "undo", post);
  assert.equal(refused.outcome?.state, "refused");
  assert.match(refused.outcome!.text, /^Nothing was changed\./);
  assert.match(refused.outcome!.text, /not available/);
  assert.equal(refused.flipped, true);
  assert.equal(refused.undo, true);
  assert.equal((await read()).recovery.enabled, false);
});

test("an unconfirmed reply leaves the state unknown, and nothing more is sent until the page is reloaded", async () => {
  const { read } = await world();
  const control = toggle(await read(), "next");
  const sent: unknown[] = [];
  for (const reply of [{ ok: true }, { ok: true, next: { on: "yes" } }, "<html>", null]) {
    const view = await pressLever(control, SWITCH_START, "switch", async (_route, body) => {
      sent.push(body);
      return reply;
    });
    assert.equal(view.flipped, "unknown", JSON.stringify(reply));
    assert.equal(view.undo, false);
    assert.equal(view.outcome?.state, "unknown");
    assert.match(view.outcome!.text, /Reload/);
    const after = await pressLever(control, view, "switch", async () => {
      throw new Error("must not be sent");
    });
    assert.deepEqual(after, view);
  }
  const thrown = await pressLever(control, SWITCH_START, "switch", async () => {
    throw new Error("network");
  });
  assert.equal(thrown.flipped, "unknown");
  assert.equal(sent.length, 4);
});

test("a write applied whose reply was lost is unknown, never 'Nothing was changed', and nothing more is sent until a reload", async () => {
  const { session, read } = await world();
  assert.ok(await setNextOffer(OWNER, { on: true, email: true }));
  const control = toggle(await read(), "next", true);
  const sent: { route: string; body: unknown }[] = [];
  const route = poster(session, sent);
  // What the route really answers: the fenced write of the store record runs, then its acknowledgment is lost once.
  const original = redis.pipeline;
  let lost = 0;
  const replies: unknown[] = [];
  redis.pipeline = async (commands) => {
    const result = await original.call(redis, commands);
    if (!lost && commands.some((command) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:fenced-set:v1\n"))) {
      lost += 1;
      throw new Error("synthetic: the reply to an applied write was lost");
    }
    return result;
  };
  let view;
  try {
    view = await pressLever(control, SWITCH_START, "switch", async (path, body) => {
      const reply = await route(path, body);
      replies.push(reply);
      return reply;
    });
  } finally {
    redis.pipeline = original;
  }
  assert.equal(lost, 1);
  assert.deepEqual(replies, [{ ok: false, error: "server_error" }]);
  // The write did happen.
  assert.deepEqual((await read()).nextOffer, { on: false, email: false });
  assert.equal(view.outcome?.state, "unknown");
  assert.doesNotMatch(view.outcome!.text, /Nothing was changed/);
  assert.match(view.outcome!.text, /Reload/);
  assert.equal(view.flipped, "unknown");
  assert.equal(view.undo, false);
  // No further press is sent from that state.
  for (const how of ["switch", "undo"] as const) assert.deepEqual(await pressLever(control, view, how, route), view);
  assert.equal(sent.length, 1);
});

test("only a refusal the route gives before any write says nothing was changed; a server error or an unknown code is unknown", async () => {
  const { read } = await world();
  const control = toggle(await read(), "next");
  for (const error of ["server_error", "something_new", "", 42]) {
    const view = await pressLever(control, SWITCH_START, "switch", async () => ({ ok: false, error }));
    assert.equal(view.outcome?.state, "unknown", String(error));
    assert.doesNotMatch(view.outcome!.text, /Nothing was changed/);
    assert.equal(view.flipped, "unknown");
  }
  for (const error of ["address", "address_long", "stripe", "role", "forbidden", "signed_out", "unavailable", "studio_used", "locked", "two_step_required", "store_gone", "none", "invalid"]) {
    const view = await pressLever(control, SWITCH_START, "switch", async () => ({ ok: false, error }));
    assert.equal(view.outcome?.state, "refused", error);
    assert.match(view.outcome!.text, /^Nothing was changed\./);
    assert.equal(view.flipped, false);
  }
});

test("addOnFact: active only inside a paid month; a snapshot that ran out is unknown, never active", () => {
  const now = 1_800_000_000;
  const plan = (over: Record<string, unknown>) => ({ subscriptionId: "sub_1", active: true, period: { start: now - 86_400, end: now + 86_400, renews: true }, cancelsAtEnd: false, disputedAt: "", ...over });
  assert.equal(addOnFact(null, now), false);
  assert.equal(addOnFact(plan({}) as never, now), true);
  assert.equal(addOnFact(plan({ period: { start: now - 90 * 86_400, end: now - 60 * 86_400, renews: true } }) as never, now), "unknown");
  assert.equal(addOnFact(plan({ period: null }) as never, now), "unknown");
  assert.equal(addOnFact(plan({ active: false }) as never, now), false);
  assert.equal(addOnFact(plan({ disputedAt: "2026-10-01" }) as never, now), false);
});

const render = (store: Store, role: Role, addOn: boolean | "unknown") =>
  renderToStaticMarkup(createElement(SalesLevers, { store, reading: null, canConfigure: true, role, addOn }));

test("the cards show a switch only where the rules allow one, named by the lever, with its state and what it does", async () => {
  const { read } = await world();
  await setRecovery(OWNER, { enabled: false, address: ADDRESS, asks: true });
  const store = await read();

  const owner = render(store, "owner", true);
  assert.equal(owner.match(/role="switch"/g)?.length, 2);
  assert.equal(owner.match(/aria-checked="false"/g)?.length, 2);
  for (const title of ["Checkout recovery", "Next offer"]) assert.match(owner, new RegExp(`<button[^>]*role="switch"[^>]*>(?:(?!</button>).)*${title}`));
  // Each switch is described by what pressing it does and what buyers see.
  for (const [, ids] of owner.matchAll(/role="switch"[^>]*aria-describedby="([^"]+)"/g)) {
    // Compared as literal text: an id is never turned into a pattern, so no character in it can widen the match.
    for (const id of ids.split(" ")) assert.ok(owner.includes(`id="${id}"`), `no element has id="${id}"`);
  }
  assert.match(owner, /What buyers see/);
  // The footer no longer says this screen changes no settings.
  assert.doesNotMatch(owner, /This review changes no settings/);
  assert.match(owner, /saves the same setting as its settings page/);

  // An editor cannot change the reminder setting: no switch there; the next offer is the page's.
  assert.equal(render(store, "editor", true).match(/role="switch"/g)?.length, 1);
  assert.equal(render(store, "support", true).match(/role="switch"/g), null);

  // Without the add-on, the next offer is not switched on here, and the card says why.
  const inactive = render(store, "owner", false);
  assert.equal(inactive.match(/role="switch"/g)?.length, 1);
  assert.match(inactive, /Store assistant add-on/);
  const unknown = render(store, "owner", "unknown");
  assert.match(unknown, /could not be read just now/);

  // Without a postal address, the reminder is not switched on here, and the card says why.
  await setRecovery(OWNER, { enabled: false, address: "", asks: true });
  const bare = render(await read(), "owner", true);
  assert.equal(bare.match(/role="switch"/g)?.length, 1);
  assert.match(bare, /postal address/);
  // The other four cards are unchanged: no switch, the settings link as before.
  assert.equal(bare.match(/<li /g)?.length, 6);
  assert.match(bare, /Review order bump settings/);
});

test("the switch follows the switch pattern without a time limit, motion or color alone", () => {
  const source = readFileSync("components/sales-lever-switch.tsx", "utf8");
  assert.match(source, /^"use client";/);
  assert.match(source, /role="switch"/);
  assert.match(source, /aria-checked=\{/);
  assert.match(source, /aria-describedby=\{/);
  assert.match(source, /role="status"/);
  assert.match(source, /min-h-11/);
  // Undo stays until the next press: no timer takes it away (WCAG 2.2.3).
  assert.doesNotMatch(source, /setTimeout|setInterval/);
  // No animation (WCAG 2.3.3), and the state is said in words, not only by color or position (1.4.1).
  assert.doesNotMatch(source, /transition|animate-/);
  assert.match(source, /"On" : "Off"|\? "On" : "Off"/);
  // A press while a request is out does nothing; the control keeps focus (aria-disabled, not disabled).
  assert.match(source, /aria-disabled=\{/);
  assert.doesNotMatch(source, /\sdisabled=\{/);
});
