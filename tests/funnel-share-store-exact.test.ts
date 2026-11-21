/**
 * Share links read Redis only in its exact shape (CX-123 rules 24 and 30),
 * in lib/funnel-share-store.ts against the in-memory Redis:
 *
 *   - listShares: an EXISTS that is not exactly 0 or 1, or a list hash with a
 *     part that is not a string, throws before any HDEL, so a live link is
 *     never cleared from the sender's list (which revokes it) on a reply
 *     nobody could read; a confirmed 0 still clears the row;
 *   - openShare: only an exact 1 from HEXISTS opens a link;
 *   - revokeShare, createShare and countUse: a reply of another shape throws,
 *     never "not there", "full" or a count that fits.
 *
 * Synthetic data only; no provider is called.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { countUse, createShare, listShares, lookupKey, openShare, revokeShare } from "@/lib/funnel-share-store";

const SID = "a1b2c3d4e5f60718";
type Pipe = typeof redis.pipeline;
const real: Pipe = redis.pipeline.bind(redis);
let sent: string[] = [];

/** Answers `command` with `odd` (every one of them in that pipeline), the rest as Redis would; records every command sent. */
function answer(command: string, odd: unknown): void {
  (redis as unknown as { pipeline: Pipe }).pipeline = async (cmds) => {
    for (const c of cmds) sent.push(String(c[0]));
    if (cmds.some((c) => c[0] === command)) {
      const rest = await real(cmds);
      return cmds.map((c, i) => (c[0] === command ? odd : rest[i])) as never;
    }
    return real(cmds);
  };
}
function restore(): void {
  (redis as unknown as { pipeline: Pipe }).pipeline = real;
}
async function make(name = "Launch"): Promise<{ code: string; id: string; hash: string }> {
  const made = await createShare(SID, { name, funnelId: "f1", days: 7, from: "Exact Shop", bundle: { v: 1 } as never, outline: { steps: [] } as never, limit: 10 });
  if (!made.ok) throw new Error("setup: share not made");
  return { code: made.code, id: made.entry.id, hash: made.entry.hash };
}
async function threw(run: () => Promise<unknown>): Promise<string> {
  try {
    const out = await run();
    return `answered ${JSON.stringify(out)}`;
  } catch {
    return "threw";
  }
}
const listed = async () => (await listShares(SID)).length;
const opens = async (code: string) => (await openShare(code, "sum")) !== null;

async function main() {
  part("Controls: a live link is listed and opens; a confirmed-gone snapshot is cleared");
  redis.clear();
  const live = await make();
  is("a live link is listed", await listed(), 1);
  is("and its code opens", await opens(live.code), true);
  await redis.pipeline([["DEL", lookupKey(live.hash)]]);
  is("EXISTS confirmed 0: the row is cleared", await listed(), 0);
  is("and the code no longer opens", await opens(live.code), false);
  redis.clear();
  const old = await make();
  is("a link past its end is cleared from the list", (await listShares(SID, Math.floor(Date.now() / 1000) + 8 * 86_400)).length, 0);
  is("and does not open", await opens(old.code), false);
  redis.clear();
  is("no links at all: an empty list, no error", await listed(), 0);

  part("listShares: EXISTS in another shape throws before any HDEL, and the link keeps working");
  for (const odd of [null, "1", "0", "yes", true, false, [1], { value: 1 }, 2, -1, 1.5]) {
    redis.clear();
    const share = await make();
    sent = [];
    answer("EXISTS", odd);
    const got = await threw(() => listShares(SID));
    restore();
    is(`EXISTS ${JSON.stringify(odd)}: listShares refuses`, got, "threw");
    is(`EXISTS ${JSON.stringify(odd)}: no HDEL sent`, sent.includes("HDEL"), false);
    is(`EXISTS ${JSON.stringify(odd)}: still listed, the code still opens`, [await listed(), await opens(share.code)], [1, true]);
  }

  part("listShares: a list hash with a part that is not a string throws before any HDEL");
  for (const shape of ["object value", "number field", "odd length"] as const) {
    redis.clear();
    const share = await make();
    sent = [];
    (redis as unknown as { pipeline: Pipe }).pipeline = async (cmds) => {
      for (const c of cmds) sent.push(String(c[0]));
      const rest = await real(cmds);
      if (cmds[0][0] !== "HGETALL") return rest;
      const flat = rest[0] as string[];
      const odd = shape === "object value" ? [flat[0], { json: flat[1] }] : shape === "number field" ? [123, flat[1]] : [flat[0]];
      return [odd] as never;
    };
    const got = await threw(() => listShares(SID));
    restore();
    is(`${shape}: listShares refuses`, got, "threw");
    is(`${shape}: no HDEL sent`, sent.includes("HDEL"), false);
    is(`${shape}: still listed, the code still opens`, [await listed(), await opens(share.code)], [1, true]);
  }

  part("openShare: only an exact 1 from HEXISTS opens a link");
  redis.clear();
  const half = await make();
  // A revoke that stopped halfway: the list line is gone, the snapshot is not.
  await redis.pipeline([["HDEL", `nl:fshares:${SID}`, half.id]]);
  is("control: HEXISTS 0, the half-revoked link does not open", await opens(half.code), false);
  for (const odd of ["1", true, [1], 1.0000001, { 1: 1 }]) {
    answer("HEXISTS", odd);
    const got = await threw(() => openShare(half.code, "sum"));
    restore();
    is(`HEXISTS ${JSON.stringify(odd)}: the half-revoked link does not open`, got === "threw" || got === "answered null", true);
  }

  part("revokeShare: a reply in another shape throws, never \"not there\" or a wrong yes");
  redis.clear();
  const kept = await make();
  is("control: an id not on the list is not there", await revokeShare(SID, "000000000000"), false);
  for (const odd of [5, ["x"], { v: 1 }, true]) {
    answer("HGET", odd);
    const got = await threw(() => revokeShare(SID, kept.id));
    restore();
    is(`HGET ${JSON.stringify(odd)}: refuses instead of "not there"`, got, "threw");
  }
  is("the link was left as it was", [await listed(), await opens(kept.code)], [1, true]);
  for (const odd of [null, "1", true, [1]]) {
    redis.clear();
    const gone = await make();
    answer("HDEL", odd);
    const got = await threw(() => revokeShare(SID, gone.id));
    restore();
    is(`HDEL ${JSON.stringify(odd)}: refuses instead of a wrong answer`, got, "threw");
    is(`HDEL ${JSON.stringify(odd)}: the link is revoked all the same`, await opens(gone.code), false);
  }
  redis.clear();
  const ok = await make();
  is("control: a healthy revoke says yes", await revokeShare(SID, ok.id), true);
  is("and the link stops working", [await listed(), await opens(ok.code)], [0, false]);

  part("createShare: a reply in another shape throws, never \"full\" or made");
  for (const odd of [null, "1", "0", true, false, [1], 1.5]) {
    redis.clear();
    answer("EVAL", odd);
    const got = await threw(() => createShare(SID, { name: "Odd", funnelId: "f1", days: 7, from: "Exact Shop", bundle: { v: 1 } as never, outline: { steps: [] } as never, limit: 10 }));
    restore();
    is(`EVAL ${JSON.stringify(odd)}: refuses`, got, "threw");
  }
  redis.clear();
  await make();
  const full = await createShare(SID, { name: "Two", funnelId: "f1", days: 7, from: "Exact Shop", bundle: { v: 1 } as never, outline: { steps: [] } as never, limit: 1 });
  is("control: at the limit, a confirmed 0 says full", full.ok ? "made" : full.error, "full");

  part("countUse: a count in another shape throws, never a count that fits");
  for (const odd of [true, "1", [1], 1.5, null, { n: 1 }]) {
    redis.clear();
    answer("INCR", odd);
    const got = await threw(() => countUse("nl:fuse:test:exact", 5, 60));
    restore();
    is(`INCR ${JSON.stringify(odd)}: refuses`, got, "threw");
  }
  redis.clear();
  is("control: the first use fits", await countUse("nl:fuse:test:exact", 1, 60), true);
  is("control: the second does not", await countUse("nl:fuse:test:exact", 1, 60), false);

  done();
}

main();
