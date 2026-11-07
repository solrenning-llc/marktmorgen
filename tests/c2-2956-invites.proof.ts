/** C5's stranded-invite boundary, independently replayed; no real provider or payment. */
import assert from "node:assert/strict";
import { claimHandle } from "@/lib/store";
import { ALL_KEY, byKey, invitedBy, inviteCode, listKey, recordInvite } from "@/lib/creator-invites";
import { store as redis } from "@/tests/redis-stub";

type Batch = (string | number)[][];
const NOW = Date.UTC(2026, 10, 6, 12);
const cases = ["healthy", "applied-lost-recovered", "applied-double-unknown", "not-applied-double-unknown", "taken-by-another"] as const;

export async function auditInvites() {
  const original = redis.pipeline.bind(redis);
  const priorFetch = globalThis.fetch;
  const observations: Record<string, unknown>[] = [];
  const failures: { name: string; actual: unknown; expected: unknown }[] = [];
  let checks = 0, totalCommands = 0, currentCommands = 0, forbiddenFetches = 0;
  let scenario = "setup";
  const check = (name: string, actual: unknown, expected: unknown) => {
    checks++;
    try { assert.deepEqual(actual, expected); }
    catch { failures.push({ name: `${scenario}: ${name}`, actual, expected }); }
  };
  const admitted = (batch: Batch) => {
    assert.ok(currentCommands + batch.length <= 2000 && totalCommands + batch.length <= 16000, "command ceilings before dispatch, including setup/inspection");
    currentCommands += batch.length; totalCommands += batch.length;
  };
  const dispatch = (batch: Batch) => { admitted(batch); return original(batch); };
  const make = async (email: string, handle: string) => {
    const made = await claimHandle(email, handle, handle, "");
    assert.ok(made.ok, "real creator fixture must exist before interpreting the probe");
    return made.store;
  };
  globalThis.fetch = (async () => { forbiddenFetches++; throw Error("C2 invites probe: no external operation admitted"); }) as typeof fetch;
  try {
    assert.ok(cases.length <= 8);
    for (const item of cases) {
      scenario = item; currentCommands = 0;
      redis.clear(); redis.pipeline = dispatch;
      const inviter = await make("reviewinviter@example.com", "reviewinviter");
      const other = await make("reviewother@example.com", "reviewother");
      const guest = await make("reviewguest@example.com", "reviewguest");
      const code = await inviteCode(inviter.sid), otherCode = await inviteCode(other.sid);
      assert.ok(code && otherCode);
      if (item === "taken-by-another") assert.equal(await recordInvite(guest, otherCode, NOW), "recorded");
      const target = byKey(guest.sid);
      let targetSets = 0, targetReads = 0;
      redis.pipeline = async batch => {
        const command = batch[0];
        if (batch.length === 1 && command[0] === "SET" && command[1] === target && command.includes("NX")) {
          targetSets++;
          if (item === "not-applied-double-unknown") { admitted(batch); return [undefined]; }
          const result = await dispatch(batch);
          if (item === "applied-lost-recovered") throw Error("synthetic ACK lost after SET");
          if (item === "applied-double-unknown") return [undefined];
          return result;
        }
        if (batch.length === 1 && command[0] === "GET" && command[1] === target) {
          targetReads++;
          const result = await dispatch(batch);
          if (item === "applied-double-unknown" || item === "not-applied-double-unknown") return [undefined];
          return result;
        }
        return dispatch(batch);
      };
      let outcome: unknown = "threw";
      try { outcome = await recordInvite(guest, code, NOW); } catch { /* asserted as an outcome below */ }
      redis.pipeline = dispatch;
      const by = await invitedBy(guest.sid);
      const [all, mine, theirs] = await dispatch([["ZSCORE", ALL_KEY, guest.sid], ["ZSCORE", listKey(inviter.sid), guest.sid], ["ZSCORE", listKey(other.sid), guest.sid]]);
      if (item === "applied-double-unknown") {
        // Credit Claude5/6697816780: this is the SAME stranded-index finding, not a new attribution.
        check("unknown is not reported recorded", outcome, "threw");
        check("real applied inviter row remains", by?.r, inviter.sid);
        check("healthy retry recognizes an existing inviter", await recordInvite(guest, code, NOW), "already");
        check("recorded invite remains discoverable by the settlement walk", all !== null, true);
        check("recorded invite remains discoverable in its inviter's list", mine !== null, true);
      } else if (item === "not-applied-double-unknown") {
        check("unknown non-application is not reported recorded", outcome, "threw");
        check("no synthetic row invented", by, null);
        check("no indexes invented", [all, mine, theirs], [null, null, null]);
        check("healthy retry can record the genuinely absent row", await recordInvite(guest, code, NOW), "recorded");
      } else if (item === "taken-by-another") {
        check("first inviter is retained", by?.r, other.sid);
        check("second inviter is refused", outcome, "already");
        check("second inviter gains no list entry", mine, null);
        check("true inviter and global walk remain indexed", [theirs !== null, all !== null], [true, true]);
        check("exact taken does not add a read-back", targetReads, 0);
      } else {
        check("confirmed claim records the invite", outcome, "recorded");
        check("real stored inviter matches", by?.r, inviter.sid);
        check("both real indexes exist", [all !== null, mine !== null], [true, true]);
        check("other inviter receives nothing", theirs, null);
        check("read-back is bounded to ambiguous SET", targetReads, item === "applied-lost-recovered" ? 1 : 0);
      }
      observations.push({ scenario, outcome, stored: by !== null, globalIndexed: all !== null, inviterIndexed: mine !== null, targetSets, targetReads, commands: currentCommands });
    }
    assert.equal(forbiddenFetches, 0);
    return { checks, failures, observations, totalCommands, forbiddenFetches, bounds: { scenarios: cases.length, perScenario: 2000, total: 16000 } };
  } finally { redis.pipeline = original; globalThis.fetch = priorFetch; }
}
