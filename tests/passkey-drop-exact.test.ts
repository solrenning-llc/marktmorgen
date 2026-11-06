/**
 * A passkey's pending removal read in an unknown shape (rule 24; the same
 * exactness listPasskeys already has, rule 30). Read as "no removal", the
 * session opened with a passkey that is set to be removed got a second step
 * (owner C3-88: whoever holds it may not be its owner), and a removal whose
 * days are over was never applied.
 * Synthetic only: the Redis stub; no WebAuthn ceremony.
 */
import { createHash } from "node:crypto";
import { openSession } from "@/lib/auth";
import { pendingRemoval } from "@/lib/passkeys";
import { hasSecondStep, liveSecondStep } from "@/lib/second-step-gate";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const ME = "drop-exact@example.com";
const listKey = `nl:pk:${sha(`nimbus-passkeys:${ME}`).slice(0, 40)}`;
const dropKey = `nl:pk:drop:${sha(`nimbus-passkey-drop:${ME}`).slice(0, 40)}`;
const DOOMED = "doomedPasskeyIdAAAA";
const OTHER = "otherPasskeyIdBBBBBB";
const passkey = (id: string) => ({ id, publicKey: "cHVibGljLWtleQ", counter: 0, transports: [], name: id, createdAt: "", lastUsedAt: "", synced: false });
const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];

async function outcome<T>(reply: unknown[], body: () => Promise<T>): Promise<T | "rejected"> {
  redis.pipeline = (async (c: Commands) => (c.length === 1 && c[0][0] === "GET" && c[0][1] === dropKey ? [...reply] : real(c))) as typeof redis.pipeline;
  try {
    return await body();
  } catch {
    return "rejected";
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  const later = Date.now() + 5 * 86_400_000;
  await real([
    ["SET", listKey, JSON.stringify([passkey(DOOMED), passkey(OTHER)])],
    ["SET", dropKey, JSON.stringify({ atOf: { [DOOMED]: later }, told: Date.now() })],
  ]);
  const session = await openSession(ME, "passkey", DOOMED);

  part("Controls: the removal is read");
  is("the passkey is waiting to be removed", (await pendingRemoval(ME))?.ids, [DOOMED]);
  is("its own session has no second step", await liveSecondStep(ME, session), null);

  for (const [label, reply] of [["no reply", []], ["undefined", [undefined]], ["a number", [3]], ["an object", [{}]], ["unreadable JSON", ["{"]], ["two replies", [null, null]]] as const) {
    part(`The pending removal answers ${label}`);
    is("never 'nothing waiting'", await outcome([...reply], () => pendingRemoval(ME)), "rejected");
    is("the doomed passkey's session never gets a second step", await outcome([...reply], () => liveSecondStep(ME, session)), "rejected");
    is("the account's second step is not answered on a guess", await outcome([...reply], () => hasSecondStep(ME)), "rejected");
  }

  part("Controls: none waiting");
  await real([["DEL", dropKey]]);
  is("no record: nothing waiting", await pendingRemoval(ME), null);
  is("and the session's passkey is its second step", await liveSecondStep(ME, session), "passkey");
  done();
}

void main();
