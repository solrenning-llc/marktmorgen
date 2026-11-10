import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  LEVER_TOGGLE_SPECS,
  UNDO_SECONDS,
  type LeverFacts,
  type LeverSpec,
  leverToggle,
  leverToggleFor,
  toggleOutcome,
} from "@/lib/sales-lever-toggle-rules";
import { salesLeverSettings, type LeverKey } from "@/lib/sales-levers";
import { ROLE_PERMISSIONS, can, type Role } from "@/lib/team-roles";
import { claimHandle, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const KEYS: LeverKey[] = ["bump", "upsell", "downsell", "bundle", "recovery", "next"];
const ROLES: Role[] = ["owner", "admin", "editor", "support"];
const ADDRESS = "100 Synthetic Way, Testville, CA 90000";
const facts = (over: Partial<LeverFacts> = {}, store: Record<string, unknown> = {}): LeverFacts => ({
  role: "owner",
  addOn: true,
  ...over,
  store: over.store === null ? null : {
    name: "Synthetic levers",
    stripeAccountId: "acct_synthetic0001",
    recovery: { enabled: false, address: ADDRESS, asks: true },
    nextOffer: { on: false, email: false },
    ...store,
  },
});

test("each of the six cards has one rule, opening the same settings path the card already links to", async () => {
  redis.clear();
  await claimHandle("toggle@example.test", "togglefixture", "Synthetic levers", "");
  const store = (await storeForEmail("toggle@example.test"))!;
  const paths = new Map(salesLeverSettings(store).map((lever) => [lever.key, lever.path]));
  assert.deepEqual(Object.keys(LEVER_TOGGLE_SPECS).sort(), [...KEYS].sort());
  for (const key of KEYS) assert.equal(LEVER_TOGGLE_SPECS[key].path, paths.get(key), key);
});

test("only the two levers with an existing on/off setting can be switched, through that setting's own route and permission", () => {
  assert.deepEqual(KEYS.filter((key) => LEVER_TOGGLE_SPECS[key].setting !== null), ["recovery", "next"]);
  const recovery = readFileSync("app/api/store/recovery/route.ts", "utf8");
  const assistant = readFileSync("app/api/store/assistant-settings/route.ts", "utf8");
  assert.deepEqual(LEVER_TOGGLE_SPECS.recovery.setting, { route: "/api/store/recovery" });
  assert.equal(LEVER_TOGGLE_SPECS.recovery.permission, "settings");
  assert.match(recovery, /guardStoreWrite\(request, "settings"\)/);
  assert.deepEqual(LEVER_TOGGLE_SPECS.next.setting, { route: "/api/store/assistant-settings" });
  assert.equal(LEVER_TOGGLE_SPECS.next.permission, "page");
  assert.match(assistant, /guardStoreWrite\(request, "page"/);
  for (const key of ["bump", "upsell", "downsell", "bundle"] as const) {
    const control = leverToggle(key, facts());
    assert.equal(control.kind, "settings", key);
    assert.equal(LEVER_TOGGLE_SPECS[key].permission, "products");
    if (control.kind === "settings") assert.match(control.reason, /price/i, key);
  }
});

test("a lever that spends money, changes a price, a limit or a commission, or needs the owner is never switched here", () => {
  const base: LeverSpec = { ...LEVER_TOGGLE_SPECS.recovery };
  const ads: LeverSpec = { ...base, key: "ads", title: "Ads", spend: "new-spend" };
  for (const spec of [ads, { ...base, changesTerms: true }, { ...base, needsOwner: true }]) {
    const control = leverToggleFor(spec, facts());
    assert.equal(control.kind, "settings");
    if (control.kind === "settings") {
      assert.ok(control.reason.length > 20);
      assert.equal(control.path, spec.path);
    }
  }
  assert.equal(LEVER_TOGGLE_SPECS.recovery.spend, "plan-capped");
  assert.equal(LEVER_TOGGLE_SPECS.next.spend, "plan-capped");
  for (const key of KEYS) assert.notEqual(LEVER_TOGGLE_SPECS[key].spend, "new-spend", key);
});

test("an unknown current state is shown as unknown and offers no switch", () => {
  for (const key of ["recovery", "next"] as const) {
    const unread = leverToggle(key, facts({ store: null }));
    assert.equal(unread.kind, "unknown", key);
  }
  for (const bad of [undefined, null, "on", { enabled: "true", address: ADDRESS }, { enabled: true, address: 7 }]) {
    assert.equal(leverToggle("recovery", facts({}, { recovery: bad })).kind, "unknown", JSON.stringify(bad));
  }
  for (const bad of [undefined, null, { on: 1, email: false }, { on: true }]) {
    assert.equal(leverToggle("next", facts({}, { nextOffer: bad })).kind, "unknown", JSON.stringify(bad));
  }
  // Whether the add-on is active cannot be read: switching on is not offered blindly.
  assert.equal(leverToggle("next", facts({ addOn: "unknown" })).kind, "unknown");
  // Switching off never depends on the add-on.
  const off = leverToggle("next", facts({ addOn: "unknown" }, { nextOffer: { on: true, email: true } }));
  assert.equal(off.kind, "toggle");
  if (off.kind === "toggle") assert.equal(off.to, false);
});

test("who may switch matches the role table and each setting's own permission; others get no button", () => {
  for (const key of ["recovery", "next"] as const) {
    for (const role of ROLES) {
      const control = leverToggle(key, facts({ role }));
      const may = can(role, LEVER_TOGGLE_SPECS[key].permission);
      assert.equal(control.kind === "toggle", may, `${key} ${role}`);
      if (!may) assert.equal(control.kind, "hidden", `${key} ${role}`);
    }
  }
  assert.ok(!ROLE_PERMISSIONS.support.has("settings") && !ROLE_PERMISSIONS.editor.has("settings"));
  assert.equal(leverToggle("recovery", facts({ role: "editor" })).kind, "hidden");
  assert.equal(leverToggle("next", facts({ role: "editor" })).kind, "toggle");
  assert.equal(leverToggle("next", facts({ role: "support" })).kind, "hidden");
});

test("checkout recovery: the request keeps the saved address both ways, and is not offered on without an address or Stripe", () => {
  const on = leverToggle("recovery", facts());
  assert.equal(on.kind, "toggle");
  if (on.kind !== "toggle") return;
  assert.equal(on.on, false);
  assert.equal(on.to, true);
  assert.equal(on.route, "/api/store/recovery");
  assert.deepEqual(on.body, { enabled: true, address: ADDRESS, expect: { enabled: false, address: ADDRESS } });
  assert.deepEqual(on.undoBody, { enabled: false, address: ADDRESS, expect: { enabled: true, address: ADDRESS } });
  assert.match(on.buyerSees, /reminder/i);
  assert.match(on.before, /consent|ask/i);
  const off = leverToggle("recovery", facts({}, { recovery: { enabled: true, address: ADDRESS, asks: true } }));
  assert.equal(off.kind, "toggle");
  if (off.kind === "toggle") {
    assert.deepEqual(off.body, { enabled: false, address: ADDRESS, expect: { enabled: true, address: ADDRESS } });
    assert.deepEqual(off.undoBody, { enabled: true, address: ADDRESS, expect: { enabled: false, address: ADDRESS } });
  }
  const noAddress = leverToggle("recovery", facts({}, { recovery: { enabled: false, address: "", asks: true } }));
  assert.equal(noAddress.kind, "settings");
  if (noAddress.kind === "settings") assert.match(noAddress.reason, /postal address/i);
  const tooLong = leverToggle("recovery", facts({}, { recovery: { enabled: false, address: "x".repeat(201), asks: true } }));
  assert.equal(tooLong.kind, "settings");
  const noStripe = leverToggle("recovery", facts({}, { stripeAccountId: null }));
  assert.equal(noStripe.kind, "settings");
  if (noStripe.kind === "settings") assert.match(noStripe.reason, /Stripe/);
});

test("next offer: switched on only while the add-on is active, keeping the email line choice for Undo", () => {
  const on = leverToggle("next", facts());
  assert.equal(on.kind, "toggle");
  if (on.kind === "toggle") {
    assert.equal(on.route, "/api/store/assistant-settings");
    assert.deepEqual(on.body, { next: { on: true, email: false }, expect: { on: false, email: false } });
    assert.deepEqual(on.undoBody, { next: { on: false, email: false }, expect: { on: true, email: false } });
    assert.match(on.buyerSees, /More from Synthetic levers/);
    assert.match(on.buyerSees, /AI suggestion/);
  }
  const inactive = leverToggle("next", facts({ addOn: false }));
  assert.equal(inactive.kind, "settings");
  if (inactive.kind === "settings") assert.match(inactive.reason, /add-on/);
  const off = leverToggle("next", facts({ addOn: false }, { nextOffer: { on: true, email: true } }));
  assert.equal(off.kind, "toggle");
  if (off.kind === "toggle") {
    assert.deepEqual(off.body, { next: { on: false, email: false }, expect: { on: true, email: true } });
    assert.deepEqual(off.undoBody, { next: { on: true, email: true }, expect: { on: false, email: false } });
    assert.match(off.before, /not see|do not see|doesn't show|not shown/i);
  }
});

test("the outcome is saved only on the route's exact confirmation of the asked state; anything else is never success", () => {
  const on = leverToggle("recovery", facts());
  const next = leverToggle("next", facts());
  assert.ok(on.kind === "toggle" && next.kind === "toggle");
  if (on.kind !== "toggle" || next.kind !== "toggle") return;
  const saved = toggleOutcome(on, { ok: true, recovery: { enabled: true, address: ADDRESS, asks: true } });
  assert.equal(saved.state, "saved");
  if (saved.state === "saved") {
    assert.match(saved.text, /on/i);
    assert.deepEqual(saved.undoBody, on.undoBody);
    assert.equal(saved.undoSeconds, UNDO_SECONDS);
  }
  assert.equal(toggleOutcome(next, { ok: true, next: { on: true, email: false } }).state, "saved");
  // A reply that does not show the asked state, or is malformed, is unknown: reload, never "saved".
  for (const reply of [null, undefined, "ok", { ok: "true" }, { ok: true }, { ok: true, recovery: { enabled: false } }, { ok: true, recovery: { enabled: "true" } }]) {
    const outcome = toggleOutcome(on, reply);
    assert.equal(outcome.state, "unknown", JSON.stringify(reply));
    assert.match(outcome.text, /reload/i);
  }
  // A refusal says nothing was changed, with the route's reason.
  for (const [error, pattern] of [
    ["address", /postal address/i],
    ["stripe", /Stripe/],
    ["role", /role/i],
    ["unavailable", /not available|could not/i],
    ["studio_used", /limit|allowance/i],
  ] as const) {
    const outcome = toggleOutcome(on, { ok: false, error });
    assert.equal(outcome.state, "refused", error);
    assert.match(outcome.text, /Nothing was changed/);
    assert.match(outcome.text, pattern, error);
  }
  assert.equal(toggleOutcome(on, { ok: false, error: "something_new" }).state, "refused");
});

test("undo lasts a few seconds and every sentence is plain US English without sales pressure", () => {
  assert.ok(Number.isInteger(UNDO_SECONDS) && UNDO_SECONDS >= 5 && UNDO_SECONDS <= 30);
  const texts: string[] = [];
  for (const key of KEYS) {
    for (const store of [{}, { recovery: { enabled: true, address: ADDRESS, asks: true }, nextOffer: { on: true, email: true } }]) {
      const control = leverToggle(key, facts({}, store));
      if (control.kind === "toggle") texts.push(control.label, control.before, control.buyerSees);
      if (control.kind === "settings" || control.kind === "unknown") texts.push(control.reason);
    }
  }
  assert.ok(texts.length >= 10);
  for (const text of texts) {
    assert.doesNotMatch(text, /guarantee|boost|skyrocket|increase your sales|colour|favour|!/i, text);
    assert.ok(text.trim() === text && text.length > 0, text);
  }
});

test("the rules are browser-safe: no server import", () => {
  const source = readFileSync("lib/sales-lever-toggle-rules.ts", "utf8");
  const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*from\s+"([^"]+)"/gm)];
  for (const [line, typeOnly, from] of imports) {
    if (typeOnly) continue;
    assert.ok(["@/lib/team-roles", "@/lib/recovery-setting-rules", "@/lib/buyer-words/next-offer"].includes(from), line);
  }
});
