/**
 * What get_emails (lib/mcp-tools.ts, emailsTool; the MCP server and the API)
 * reads of the store's one-off emails, measured on the real database calls
 * (regra 30, the fourth sibling of #3034): it measured the records as stored
 * (broadcastSizes), set that aside in API requests, then read them again
 * with listBroadcasts, whose own LRANGE and GETs have no bound: an email
 * listed or grown between the measure and the read was read unpaid, the
 * bytes were priced as stored rather than as they cross (each byte escaped
 * once more at the most), and every body was read although none is told
 * back. Held here, with synthetic stores only:
 *
 *   1. What the reading really did (every command as billed, every byte both
 *      ways as JSON, every trip to the database, what is told back) comes to
 *      no more API requests than were taken for it.
 *   2. Only the emails measured are read, each no further than paid: one
 *      listed after the measure is not read (it is told on the next call);
 *      one grown since is read once more, paid first.
 *   3. No body crosses.
 */
import { emailsTool } from "@/lib/mcp-tools";
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { apiReadUnits } from "@/lib/api-read-rules";
import { allowanceUsed } from "@/lib/store-allowance";
import type { Store } from "@/lib/store";
import { LONGEST, emailKey, idsFor, makeStore, pipeline, record, redis, wire, writeEmails, type Command } from "./broadcasts-read-cost-world";
import { done, is, part } from "./check";

const OWNER = "mcpemailsread@example.com";
const HEADS = "-- marktmorgen:broadcast-heads:v";
const RECORD = /^nl:mail:bc:[0-9a-f]{24}$/;

type Batch = { batch: Command[]; replies: unknown };
type Told = { emails?: { subject: string; sent: number }[] };

/** Commands as Upstash bills them: each in the batch, and each key a heads script reads inside it. */
const billed = (batch: Command[]) => batch.reduce((n, c) => n + 1 + (c[0] === "EVAL" && String(c[1]).startsWith(HEADS) ? Number(c[2]) : 0), 0);
/** The records whose bytes a batch reads: a GET or GETRANGE of one, or a heads script answering them. */
const recordsRead = (batch: Command[]) => batch.flatMap((c) => {
  if ((c[0] === "GET" || c[0] === "GETRANGE") && RECORD.test(String(c[1]))) return [String(c[1])];
  if (c[0] === "EVAL" && String(c[1]).startsWith(HEADS)) {
    const keys = Number(c[2]);
    return c[3 + keys] === "size" ? [] : c.slice(3, 3 + keys).map(String);
  }
  return [];
});
/** A batch that takes or gives back the store's requests: priced by apiReadUnits itself (withTaking). */
const taking = (batch: Command[]) => batch.some((c) => c.some((v) => String(v).includes("nl:allow:")));

async function run(store: Store, then: ((batch: Command[]) => Promise<void>) | null) {
  const log: Batch[] = [];
  const before = await allowanceUsed(store, "api");
  redis.pipeline = (async (batch: Command[]) => {
    const replies = await pipeline(batch);
    log.push({ batch, replies });
    if (then) await then(batch);
    return replies;
  }) as typeof redis.pipeline;
  let told: unknown;
  try {
    told = await emailsTool(store, { charge: (more, taken) => takeMoreApi(store, more, taken), hold: (most) => holdMoreApi(store, most) });
  } catch {
    told = "threw";
  } finally {
    redis.pipeline = pipeline as typeof redis.pipeline;
  }
  const took = (await allowanceUsed(store, "api")) - before;
  const work = log.filter((b) => !taking(b.batch));
  const did = {
    commands: work.reduce((n, b) => n + billed(b.batch), 0),
    bytes: work.reduce((n, b) => n + wire(b.batch) + wire(b.replies), 0),
    sent: told instanceof Response || told === "threw" ? 0 : wire(told),
    stripePages: 0,
    roundTrips: work.length,
  };
  return { told: told as Told | Response | "threw", took, did, units: apiReadUnits(did), read: log.flatMap((b) => recordsRead(b.batch)) };
}

async function main(): Promise<void> {
  redis.clear();
  const store = await makeStore(OWNER, "mcpemailsread");
  const measuring = (batch: Command[]) => batch.length > 1 && batch.every((c) => c[0] === "STRLEN" && RECORD.test(String(c[1]))) || (batch[0]?.[0] === "EVAL" && String(batch[0][1]).startsWith(HEADS) && batch[0][3 + Number(batch[0][2])] === "size");

  part("1. Twenty-nine emails at their longest, and one more listed between the measure and the read");
  {
    const ids = idsFor(29, "a1");
    await writeEmails(store, ids, () => LONGEST);
    const late = "f".repeat(24);
    let added = false;
    const r = await run(store, async (batch) => {
      if (added || !measuring(batch)) return;
      added = true;
      await pipeline([["SET", emailKey(late), record(store, late, LONGEST)], ["LPUSH", `nl:mail:bcs:${store.listId}`, late]]);
    });
    is("told", r.told !== "threw" && !(r.told instanceof Response) && Array.isArray(r.told.emails), true);
    is("the late one was listed after the measure", added, true);
    is(`what the reading did comes to no more API requests than were taken (${JSON.stringify({ took: r.took, units: r.units, bytes: r.did.bytes, commands: r.did.commands })})`, r.units <= r.took, true);
    is("the email listed after the measure is not read", r.read.includes(emailKey(late)), false);
    is("each measured email is read once", r.read.length, ids.length);
    is(`no body crosses (${r.did.bytes} bytes)`, r.did.bytes < 100_000, true);
    const next = await run(store, null);
    is("the late one is told on the next call", next.told !== "threw" && !(next.told instanceof Response) ? next.told.emails?.length : next.told, 30);
  }

  part("2. An email grown between the measure and the read is read once more, paid first");
  {
    const ids = idsFor(5, "b2");
    await writeEmails(store, ids, () => LONGEST);
    let grown = false;
    const r = await run(store, async (batch) => {
      if (grown || !measuring(batch)) return;
      grown = true;
      await pipeline([["SET", emailKey(ids[0]), record(store, ids[0], LONGEST, { note: "n".repeat(300), total: 123_456, sent: 123_456 })]]);
    });
    is("told as it is now", r.told !== "threw" && !(r.told instanceof Response) ? r.told.emails?.[0].sent : r.told, 123_456);
    is(`inside what was taken (${JSON.stringify({ took: r.took, units: r.units })})`, r.units <= r.took, true);

    // Exactly what the first read sets aside left, then grown: the read again is refused, in words, and not made.
    await writeEmails(store, ids, () => LONGEST);
    const plain = await run(store, null);
    const api = redis.keys().filter((k) => k.startsWith("nl:allow:api:"));
    is("the store's API count is where it is counted", api.length, 1);
    await pipeline([["SET", api[0], String(2_000 - plain.took)]]);
    let again = false;
    const refused = await run(store, async (batch) => {
      if (again || !measuring(batch)) return;
      again = true;
      await pipeline([["SET", emailKey(ids[0]), record(store, ids[0], LONGEST, { note: "n".repeat(300) })]]);
    });
    is("refused with its own words", refused.told instanceof Response ? [refused.told.status, /API requests/.test(await refused.told.text())] : refused.told, [429, true]);
    is("the grown one read once, as far as it was paid", refused.read.filter((k) => k === emailKey(ids[0])).length, 1);
    await pipeline([["SET", api[0], "0"]]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
