/**
 * Sweep A5 proof (CX-123 rule 24), synthetic only. lib/passkeys.ts readDrop, lines 403-424:
 *   const [raw] = await redisPipeline([["GET", dropKey(email)]]);
 *   const value = typeof raw === "string" ? JSON.parse(raw) : null;  if (!value) return null;
 * A GET of the removal record answered in an unknown shape reads as "no removal was asked". signInWith (lines
 * 766-811) applies due removals with removeDue (line 608: `if (!record) return null`) and reads `doomed` from the same
 * record, so a passkey the owner set to be removed, whose wait has run out, still logs in, as a passkey not set to
 * go (doomed: false). The sign-in route (app/api/auth/passkey/signin/route.ts:84-89) then lets that login call off a
 * pending two-step reset and close what the recovery address opened. listPasskeys right beside it is already exact
 * (repliesFor, lot L10b); readDrop is its unfixed sibling (rule 30), also behind pendingRemoval, pendingNow and
 * unlessSetToGo.
 */
import { createHash } from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { listPasskeys, signInOptions, signInWith } from "@/lib/passkeys";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => { throw new Error("no network in this proof"); }) as typeof fetch;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const dropKey = (email: string) => `nl:pk:drop:${sha(`nimbus-passkey-drop:${email}`).slice(0, 40)}`;
const original = redis.pipeline.bind(redis);

async function login(key: ReturnType<typeof makePasskey>) {
  const { options, nonce } = await signInOptions();
  return signInWith(nonce, key.answer(options.challenge) as AuthenticationResponseJSON);
}
async function setUp(email: string) {
  const lost = makePasskey(email, `lost-${email}`);
  const kept = makePasskey(email, `kept-${email}`);
  await lost.keep();
  await kept.keep();
  // The owner set the lost phone's passkey to be removed; its wait ran out an hour ago.
  await redis.pipeline([["SET", dropKey(email), JSON.stringify({ atOf: { [`lost-${email}`]: Date.now() - 3_600_000 }, told: Date.now() - 8 * 86_400_000 })]]);
  return lost;
}

async function main() {
  redis.clear();
  part("Healthy control: a passkey whose removal is due cannot log in, and is removed");
  const a = await setUp("owner-a@example.com");
  is("refused", await login(a), null);
  is("removed from the account", (await listPasskeys("owner-a@example.com")).map((p) => p.id), ["kept-owner-a@example.com"]);

  part("DEFECT: the same due removal, the GET of the removal record answered in an unknown shape");
  for (const [label, reply] of [["a number", 1], ["an object", { atOf: {} }], ["no reply", undefined]] as const) {
    const email = `owner-${label.replace(/\s/g, "")}@example.com`;
    const lost = await setUp(email);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === dropKey(email)) return reply === undefined ? [] : [reply];
      return original(commands);
    }) as typeof redis.pipeline;
    const signed = await login(lost);
    redis.pipeline = original;
    is(`DEFECT (${label}): the passkey set to go logs in, as one not set to go`, [signed?.email, signed?.doomed], [email, false]);
    is(`DEFECT (${label}): and stays on the account`, (await listPasskeys(email)).some((p) => p.id === `lost-${email}`), true);
  }
  done();
}
main();
