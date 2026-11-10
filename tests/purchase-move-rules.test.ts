/**
 * 611 [WP10], unit 1: a buyer asks to move their purchases (from one store,
 * or from every store) to another email address. Pure rules, no Redis and no
 * email: the request only counts once BOTH addresses confirmed it, inside
 * the time allowed, once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMove,
  confirmMove,
  dailyMoves,
  MAX_MOVES_PER_ADDRESS_DAY,
  MOVE_CONFIRM_SECONDS,
  MOVE_EMAILS_PER_REQUEST,
  moveState,
  newMoveRequest,
  parseMoveRequest,
  readMoveAddresses,
  readMoveScope,
  type MoveRequest,
} from "@/lib/purchase-move-rules";

const SID = "0123456789abcdef0123456789abcdef";
const T0 = 1_800_000_000;

function fresh(): MoveRequest {
  const made = newMoveRequest({ from: "old@example.com", to: "new@example.com", scope: { kind: "store", sid: SID }, now: T0 });
  assert.ok(typeof made === "object");
  return made as MoveRequest;
}

test("both addresses are read the way sign-in reads them, and must differ", () => {
  assert.deepEqual(readMoveAddresses("  Old@Example.com ", "NEW@example.com"), { from: "old@example.com", to: "new@example.com" });
  assert.equal(readMoveAddresses("old@example.com", "OLD@EXAMPLE.COM "), "same");
  assert.equal(readMoveAddresses("old@example.com", "not an address"), "email");
  assert.equal(readMoveAddresses("", "new@example.com"), "email");
  assert.equal(readMoveAddresses(42, "new@example.com"), "email");
  assert.equal(readMoveAddresses("old@example.com", `${"a".repeat(250)}@example.com`), "email");
});

test("the scope is one store, by its id, or every store", () => {
  assert.deepEqual(readMoveScope("all"), { kind: "all" });
  assert.deepEqual(readMoveScope(SID), { kind: "store", sid: SID });
  for (const bad of ["", "ALL", "store", SID.toUpperCase(), `${SID}0`, null, undefined, 7]) {
    assert.equal(readMoveScope(bad), null, String(bad));
  }
});

test("a new request is waiting for both addresses", () => {
  const request = fresh();
  assert.deepEqual(request, {
    from: "old@example.com",
    to: "new@example.com",
    scope: { kind: "store", sid: SID },
    createdAt: T0,
    fromConfirmedAt: null,
    toConfirmedAt: null,
    appliedAt: null,
  });
  assert.equal(moveState(request, T0), "waiting-both");
  assert.equal(MOVE_EMAILS_PER_REQUEST, 2);
});

test("without both confirmations nothing moves", () => {
  const onlyOld = confirmMove(fresh(), "from", T0 + 60);
  assert.ok(typeof onlyOld === "object");
  assert.equal(moveState(onlyOld as MoveRequest, T0 + 60), "waiting-to");
  assert.equal(applyMove(onlyOld as MoveRequest, T0 + 61), "not-ready");

  const onlyNew = confirmMove(fresh(), "to", T0 + 60);
  assert.equal(moveState(onlyNew as MoveRequest, T0 + 60), "waiting-from");
  assert.equal(applyMove(onlyNew as MoveRequest, T0 + 61), "not-ready");
  assert.equal(applyMove(fresh(), T0 + 61), "not-ready");
});

test("after both, in either order, it moves once and never again", () => {
  for (const order of [["from", "to"], ["to", "from"]] as const) {
    const first = confirmMove(fresh(), order[0], T0 + 10) as MoveRequest;
    const both = confirmMove(first, order[1], T0 + 20) as MoveRequest;
    assert.equal(moveState(both, T0 + 20), "ready");
    const applied = applyMove(both, T0 + 30);
    assert.ok(typeof applied === "object");
    assert.equal((applied as MoveRequest).appliedAt, T0 + 30);
    assert.equal(moveState(applied as MoveRequest, T0 + 30), "done");
    assert.equal(applyMove(applied as MoveRequest, T0 + 31), "done");
    assert.equal(confirmMove(applied as MoveRequest, "from", T0 + 31), "done");
  }
});

test("confirming the same side twice changes nothing", () => {
  const once = confirmMove(fresh(), "from", T0 + 10) as MoveRequest;
  assert.equal(confirmMove(once, "from", T0 + 50), "already");
  assert.equal(once.fromConfirmedAt, T0 + 10);
});

test("a request not finished in time expires: no confirmation and no move after it", () => {
  assert.equal(MOVE_CONFIRM_SECONDS, 24 * 60 * 60);
  const end = T0 + MOVE_CONFIRM_SECONDS;
  const old = confirmMove(fresh(), "from", end - 1) as MoveRequest;
  assert.equal(moveState(old, end - 1), "waiting-to");
  assert.equal(confirmMove(old, "to", end), "expired");
  assert.equal(moveState(old, end), "expired");
  const both = confirmMove(old, "to", end - 1) as MoveRequest;
  assert.equal(applyMove(both, end - 1) === "expired", false);
  assert.equal(applyMove(both, end), "expired");
});

test("a clock that cannot be read, or that runs backwards, never confirms or moves", () => {
  assert.equal(confirmMove(fresh(), "from", Number.NaN), "unknown");
  assert.equal(confirmMove(fresh(), "from", T0 - 1), "unknown");
  const both = confirmMove(confirmMove(fresh(), "from", T0 + 1) as MoveRequest, "to", T0 + 2) as MoveRequest;
  assert.equal(applyMove(both, Number.NaN), "unknown");
  assert.equal(applyMove(both, T0 + 1), "unknown");
  assert.equal(moveState(both, Number.NaN), "unknown");
});

test("what comes back from storage is used only when every field reads exactly", () => {
  const both = confirmMove(confirmMove(fresh(), "from", T0 + 1) as MoveRequest, "to", T0 + 2) as MoveRequest;
  assert.deepEqual(parseMoveRequest(JSON.parse(JSON.stringify(both))), both);
  assert.deepEqual(parseMoveRequest({ ...both, scope: { kind: "all" } }), { ...both, scope: { kind: "all" } });
  const broken: unknown[] = [
    null,
    "x",
    { ...both, from: "nope" },
    { ...both, to: both.from },
    { ...both, scope: { kind: "store", sid: "x" } },
    { ...both, createdAt: "1" },
    { ...both, fromConfirmedAt: T0 - 5 },
    { ...both, toConfirmedAt: 1.5 },
    { ...both, appliedAt: T0 + 1 },
    { ...both, appliedAt: undefined },
  ];
  for (const raw of broken) assert.equal(parseMoveRequest(raw), null, JSON.stringify(raw));
});

test("each address asks at most a few times a day; a count that cannot be read refuses", () => {
  assert.equal(MAX_MOVES_PER_ADDRESS_DAY, 3);
  assert.equal(dailyMoves(0), "within");
  assert.equal(dailyMoves(MAX_MOVES_PER_ADDRESS_DAY - 1), "within");
  assert.equal(dailyMoves(MAX_MOVES_PER_ADDRESS_DAY), "over");
  for (const bad of [null, undefined, Number.NaN, -1, 1.5, "0"]) assert.equal(dailyMoves(bad), "unknown", String(bad));
});

test("a new request refuses what it cannot read", () => {
  assert.equal(newMoveRequest({ from: "old@example.com", to: "old@example.com", scope: { kind: "all" }, now: T0 }), "same");
  assert.equal(newMoveRequest({ from: "x", to: "new@example.com", scope: { kind: "all" }, now: T0 }), "email");
  assert.equal(newMoveRequest({ from: "old@example.com", to: "new@example.com", scope: { kind: "store", sid: "bad" }, now: T0 }), "scope");
  assert.equal(newMoveRequest({ from: "old@example.com", to: "new@example.com", scope: { kind: "all" }, now: Number.NaN }), "unknown");
});
