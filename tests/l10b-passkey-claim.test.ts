/**
 * CX-123 rule 24, lot L10b: a new passkey (lib/passkeys.ts addPasskey) claims its credential for the account with a SET
 * NX of the account's address, so one credential never logs in to two accounts. A reply to it in any shape but "OK" or
 * nil is read back: the key holding this address, for a credential this account does not have yet, is ours; another
 * address is "taken"; nothing readable adds nothing and throws UnknownReplyError (the route answers a server error, to
 * try again), letting go of a claim this run may have written, so the next try adds it. Synthetic passkeys only
 * (tests/passkey-world.ts).
 */
import { createHash } from "node:crypto";
import { UnknownReplyError } from "@/lib/redis-reply";
import { addPasskey, listPasskeys, registrationOptions } from "@/lib/passkeys";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makePasskey } from "./passkey-world";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx } from "./l10b-replies";

process.env.RESEND_API_KEY = "re_test_l10b_passkeys_only_a_stand_in";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }))) as typeof fetch;

const CRED = "nl:pk:cred:";
const credKey = (id: string) => `${CRED}${createHash("sha256").update(`nimbus-passkey-id:${id}`).digest("hex").slice(0, 40)}`;
let n = 0;

async function add(email: string, id: string): Promise<string> {
  const session = `l10b-session-${(n += 1)}`;
  const options = await registrationOptions(email, session);
  try {
    const result = await addPasskey(email, session, makePasskey(email, id).register(options.challenge) as never, "Phone");
    return result.ok ? "added" : result.reason;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}
const ids = async (email: string) => (await listPasskeys(email)).map((p) => p.id);
const credId = (id: string) => Buffer.from(id).toString("base64url");

async function main(): Promise<void> {
  redis.clear();

  part("The plain case: added, and the same credential is refused for another account");
  is("added to the first account, refused for the second", [await add("one@example.com", "cred-plain"), await add("two@example.com", "cred-plain")], ["added", "taken"]);

  part("A credential claimed by another account is never taken for ours");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const id = `cred-other-${shape.replace(/\W/g, "")}`;
    redis.run(["SET", credKey(credId(id)), "other@example.com"]);
    answer(setNx(CRED), reply);
    const got = await add("mine@example.com", id);
    is(`the claim answered with ${shape} while another account holds it: taken, not added, theirs untouched`, [got, (await ids("mine@example.com")).includes(credId(id)), redis.run(["GET", credKey(credId(id))])], ["taken", false, "other@example.com"]);
  }

  part("The claim written and its answer lost: this address read back, added once");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const id = `cred-landed-${shape.replace(/\W/g, "")}`;
    answer(setNx(CRED), reply);
    is(`answered with ${shape}, the write landed: added`, [await add("landed@example.com", id), (await ids("landed@example.com")).filter((p) => p === credId(id)).length], ["added", 1]);
  }

  part("Nothing readable: not added, said as unknown, and a claim this run may have written let go");
  for (const [shape, reply] of [...UNREADABLE, ["the write failing too", THROWS] as const]) {
    clearAnswers();
    const id = `cred-unknown-${shape.replace(/\W/g, "")}`;
    answer(setNx(CRED), shape === "the write failing too" ? THROWS : () => ["QUEUED"]);
    answer(getOf(CRED), reply);
    const got = await add("unknown@example.com", id);
    is(`the claim unknown and its read-back ${shape}: unknown, not added, no claim left behind`, [got, (await ids("unknown@example.com")).includes(credId(id)), redis.run(["EXISTS", credKey(credId(id))])], ["unknown", false, 0]);
    clearAnswers();
    is(`and the next try adds it (${shape})`, await add("unknown@example.com", id), "added");
  }
  clearAnswers();
  done();
}

void main();
