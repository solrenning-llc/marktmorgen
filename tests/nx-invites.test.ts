/**
 * Creators inviting creators: the code a store's link is made with, and the inviter a new store is written down
 * under, are SET NX claims read exactly (CX-123 rule 24). "OK", or our own value read back, is ours; nil or another
 * value is somebody else's; anything else is unknown, and nothing is linked or listed on it. Synthetic data only.
 */
import { claimHandle } from "@/lib/store";
import { ALL_KEY, byKey, invitedBy, inviteCode, inviterFor, listKey, recordInvite as recordInviteAt } from "@/lib/creator-invites";
import { LEGACY_INVITE_RECORDING_UNTIL } from "@/lib/creator-invite-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);
/** Each SET NX on a key `match` picks: `before` runs first (another writer), then it is sent and answered by `answer`. */
function claimAnswers(match: (key: string) => boolean, answer: (wrote: boolean) => unknown[] | Error, opts: { before?: (key: string) => Promise<void>; read?: () => unknown[] } = {}) {
  redis.pipeline = async (commands: Command[]) => {
    const [first] = commands;
    if (commands.length === 1 && first[0] === "SET" && match(String(first[1])) && first.includes("NX")) {
      await opts.before?.(String(first[1]));
      const wrote = (await original(commands))[0] === "OK";
      const reply = answer(wrote);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (opts.read && commands.length === 1 && first[0] === "GET" && match(String(first[1]))) return opts.read();
    return original(commands);
  };
}
const restore = () => { redis.pipeline = original; };
/**
 * One moment inside the legacy recording window for every invite these checks write down. recordInvite read the real
 * clock, and from LEGACY_INVITE_RECORDING_UNTIL (16 December 2026 UTC) on it answers "paused" before any claim is
 * made, so every check below failed on any run from that day; nothing here compares the recorded time with the clock.
 */
const OPEN = LEGACY_INVITE_RECORDING_UNTIL - 86_400_000;
const recordInvite = (store: Parameters<typeof recordInviteAt>[0], code: string, now = OPEN) => recordInviteAt(store, code, now);
const malformed = [["undefined", [undefined]], ["no reply", []], ["text", ["QUEUED"]], ["a number", [1]]] as const;

async function main(): Promise<void> {
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };

  part("a store's invite code");
  for (const [label, reply] of malformed) {
    redis.clear();
    const ana = await made("ana@example.com", "ana");
    const other = await made("other@example.com", "other");
    // The code drawn is already another store's (the other writer got there first), and the answer says nothing.
    claimAnswers((key) => key.startsWith("nl:ref:code:"), () => [...reply], { before: async (key) => { await original([["SET", key, other.sid]]); } });
    let code: string | null = "threw";
    try { code = await inviteCode(ana.sid); } catch { /* checked below */ }
    restore();
    const owner = code && code !== "threw" ? (await inviterFor(code))?.sid ?? null : null;
    is(`${label} on a code another store holds: ana's link never leads to the other store`, owner === other.sid, false);
  }
  {
    redis.clear();
    const ana = await made("ana@example.com", "ana");
    claimAnswers((key) => key.startsWith("nl:ref:code:"), () => new Error("synthetic lost reply"));
    let code: string | null = "threw";
    try { code = await inviteCode(ana.sid); } catch { /* checked below */ }
    restore();
    is("a code written whose reply was lost: read back as ana's, her link is made", [code !== "threw" && code !== null, code && code !== "threw" ? (await inviterFor(code))?.sid : null], [true, ana.sid]);
  }
  {
    redis.clear();
    const ana = await made("ana@example.com", "ana");
    const code = await inviteCode(ana.sid);
    is("healthy: a code, leading to ana, the same one asked again", [(await inviterFor(code!))?.sid, await inviteCode(ana.sid)], [ana.sid, code]);
  }

  part("who invited a new store");
  for (const [label, reply] of malformed) {
    redis.clear();
    const ana = await made("ana@example.com", "ana");
    const bea = await made("bea@example.com", "bea");
    const cal = await made("cal@example.com", "cal");
    const anaCode = (await inviteCode(ana.sid))!;
    const beaCode = (await inviteCode(bea.sid))!;
    is("ana's invite is the first, written down", await recordInvite(cal, anaCode), "recorded");
    claimAnswers((key) => key === byKey(cal.sid), () => [...reply]);
    let second: unknown = "threw";
    try { second = await recordInvite(cal, beaCode); } catch { /* checked below */ }
    restore();
    const listed = (await original([["ZSCORE", listKey(bea.sid), cal.sid]]))[0];
    is(`${label} on a store already invited by ana: never written down under bea`, [second === "recorded", listed], [false, null]);
  }
  {
    redis.clear();
    const ana = await made("ana@example.com", "ana");
    const cal = await made("cal@example.com", "cal");
    const anaCode = (await inviteCode(ana.sid))!;
    claimAnswers((key) => key === byKey(cal.sid), () => new Error("synthetic lost reply"));
    let first: unknown = "threw";
    try { first = await recordInvite(cal, anaCode); } catch { /* checked below */ }
    restore();
    const listed = (await original([["ZSCORE", listKey(ana.sid), cal.sid], ["ZSCORE", ALL_KEY, cal.sid]]));
    is("an invite written whose reply was lost: read back as this one, listed under ana", [first, listed.every((x) => x !== null)], ["recorded", true]);
  }
  {
    redis.clear();
    const ana = await made("ana@example.com", "ana");
    const cal = await made("cal@example.com", "cal");
    const anaCode = (await inviteCode(ana.sid))!;
    claimAnswers((key) => key === byKey(cal.sid), () => [undefined], { read: () => [undefined] });
    let first: unknown = "threw";
    try { first = await recordInvite(cal, anaCode); } catch { /* checked below */ }
    restore();
    const listed = (await original([["ZSCORE", listKey(ana.sid), cal.sid]]))[0];
    is("answered and read back in no known shape: not said recorded, not listed", [first === "recorded", listed], [false, null]);
    // Its record names ana, so the daily settlement walk must still find it (C5-2956): it credits only from that
    // record. Ana's own list is left alone, since nothing confirmed that this record is hers.
    const all = (await original([["ZSCORE", ALL_KEY, cal.sid]]))[0];
    is("and the record written stays on the settlement walk, under its own inviter", [first, (await invitedBy(cal.sid))?.r === ana.sid, all !== null], ["threw", true, true]);
    is("a later try answers already", await recordInvite(cal, anaCode), "already");
  }
  {
    // The same two unknown answers, when the SET was never applied: no record is made up, nobody's list gains it.
    redis.clear();
    const ana = await made("ana@example.com", "ana");
    const cal = await made("cal@example.com", "cal");
    const anaCode = (await inviteCode(ana.sid))!;
    redis.pipeline = async (commands: Command[]) => {
      const [c] = commands;
      if (commands.length === 1 && (c[0] === "SET" || c[0] === "GET") && c[1] === byKey(cal.sid)) return [undefined];
      return original(commands);
    };
    let first: unknown = "threw";
    try { first = await recordInvite(cal, anaCode); } catch { /* checked below */ }
    restore();
    const [mine] = await original([["ZSCORE", listKey(ana.sid), cal.sid]]);
    is("not applied, answered and read back in no known shape: no record, not on ana's list", [first, await invitedBy(cal.sid), mine], ["threw", null, null]);
    is("and a later try records it", await recordInvite(cal, anaCode), "recorded");
  }
  {
    // Bea invited cal first; ana's try is answered in no known shape: bea's record and lists stay, ana gains nothing.
    redis.clear();
    const ana = await made("ana@example.com", "ana");
    const bea = await made("bea@example.com", "bea");
    const cal = await made("cal@example.com", "cal");
    const anaCode = (await inviteCode(ana.sid))!;
    const beaCode = (await inviteCode(bea.sid))!;
    await recordInvite(cal, beaCode);
    const [allBefore] = await original([["ZSCORE", ALL_KEY, cal.sid]]);
    // Ana's try a second later, so a score written over bea's would show.
    claimAnswers((key) => key === byKey(cal.sid), () => [undefined], { read: () => [undefined] });
    let first: unknown = "threw";
    try { first = await recordInvite(cal, anaCode, OPEN + 1_000); } catch { /* checked below */ }
    restore();
    const [mine, theirs, all] = await original([["ZSCORE", listKey(ana.sid), cal.sid], ["ZSCORE", listKey(bea.sid), cal.sid], ["ZSCORE", ALL_KEY, cal.sid]]);
    is("and its place on the settlement walk keeps bea's time", all, allBefore);
    is("held by bea, unknown for ana: bea's record and lists kept, ana's list never gains it", [first, (await invitedBy(cal.sid))?.r === bea.sid, mine, theirs !== null, all !== null], ["threw", true, null, true, true]);
  }
  {
    redis.clear();
    const ana = await made("ana@example.com", "ana");
    const bea = await made("bea@example.com", "bea");
    const cal = await made("cal@example.com", "cal");
    const anaCode = (await inviteCode(ana.sid))!;
    const beaCode = (await inviteCode(bea.sid))!;
    is("healthy: the first invite is recorded, a second is already", [await recordInvite(cal, anaCode), await recordInvite(cal, beaCode)], ["recorded", "already"]);
  }
  done();
}
void main();
