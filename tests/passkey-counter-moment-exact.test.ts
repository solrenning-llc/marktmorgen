/**
 * Issue #4287, items 2 and 3 (Codex G, hidden #4160 and #4183; rule 24, defense in depth).
 *
 * Item 2: a passkey's signature counter (lib/passkeys.ts listPasskeys) in a shape this code never writes (text, a
 * negative number, a fraction) was read as 0, or as written, and went to WebAuthn's verification as the counter that
 * guards against a cloned authenticator. Now the list reads only when every counter is a whole number from 0 up;
 * otherwise it is unknown (UnknownReplyError), as a list in any other shape already is.
 *
 * Item 3: a removal record's moments (readDrop: each passkey's `atOf`, `told`, `telling.since`) took any finite
 * number, -1 and 1.5 included, though writeDrop only writes whole milliseconds from 0 up. Now any other moment is
 * unknown too.
 *
 * Synthetic records only; no network.
 */
import { createHash } from "node:crypto";
import { listPasskeys, pendingNow } from "@/lib/passkeys";
import { UnknownReplyError } from "@/lib/redis-reply";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const listKey = (email: string) => `nl:pk:${sha(`nimbus-passkeys:${email}`).slice(0, 40)}`;
const dropKey = (email: string) => `nl:pk:drop:${sha(`nimbus-passkey-drop:${email}`).slice(0, 40)}`;

async function outcome<T>(work: () => Promise<T>): Promise<T | string> {
  try {
    return await work();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : String(error);
  }
}

let n = 0;
async function withCounter(counter: unknown): Promise<unknown> {
  const email = `counter-${++n}@example.com`;
  const key = makePasskey(email, `key-${n}`);
  await key.keep();
  const [raw] = (await redis.pipeline([["GET", listKey(email)]])) as [string];
  const list = JSON.parse(raw) as Record<string, unknown>[];
  list[0]!.counter = counter;
  await redis.pipeline([["SET", listKey(email), JSON.stringify(list)]]);
  return outcome(async () => (await listPasskeys(email)).map((p) => p.counter));
}

async function withMoment(field: "atOf" | "told" | "since", moment: unknown): Promise<unknown> {
  const email = `moment-${++n}@example.com`;
  const id = `lost-${n}`;
  await makePasskey(email, id).keep();
  const at = Date.now() + 3_600_000;
  const record: Record<string, unknown> = { atOf: { [id]: field === "atOf" ? moment : at } };
  if (field === "told") record.told = moment;
  if (field === "since") record.telling = { token: "a".repeat(32), since: moment };
  await redis.pipeline([["SET", dropKey(email), JSON.stringify(record)]]);
  return outcome(async () => ((await pendingNow(email)) ? "read" : "none"));
}

async function main(): Promise<void> {
  redis.clear();

  part("Item 2: controls, a counter as this code writes it");
  is("0", await withCounter(0), [0]);
  is("a later count", await withCounter(7), [7]);

  part("Item 2: a counter in another shape is unknown");
  for (const [label, counter] of [["text", "5"], ["negative", -1], ["a fraction", 1.5], ["missing", undefined], ["past the safe range", 2 ** 60]] as const) {
    is(`${label}: unknown`, await withCounter(counter), "unknown");
  }

  part("Item 3: controls, moments as writeDrop writes them");
  is("a removal's moment", await withMoment("atOf", Date.now() + 3_600_000), "read");
  is("when the owner was told", await withMoment("told", Date.now() - 1000), "read");
  is("when the telling began", await withMoment("since", Date.now() - 1000), "read");

  part("Item 3: a moment in another shape is unknown");
  for (const field of ["atOf", "told", "since"] as const) {
    for (const [label, moment] of [["negative", -1], ["a fraction", 1.5], ["past the safe range", 2 ** 60]] as const) {
      is(`${field} ${label}: unknown`, await withMoment(field, moment), "unknown");
    }
  }

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
