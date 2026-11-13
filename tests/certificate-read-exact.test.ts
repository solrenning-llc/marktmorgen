/**
 * A certificate's record is read exactly (CX-123 rule 24): `readCertificate`
 * reads a nil as no certificate, but a pipeline answering no reply, more than
 * one, or a reply that is not a string throws UnknownReply. Before this, such a
 * reply read as "not found": the public page told whoever checks a real
 * certificate that it does not exist, and withdrawing it answered 404
 * "unknown" to the creator.
 *
 * Against the Redis stand-in only; nothing real is reached.
 */
import { readCertificate, withdrawCertificate } from "@/lib/certificate";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);

const ID = "abcdefghjkmnpqrs";
const KEY = `nl:cert:${ID}`;

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return value === null ? "none" : typeof value === "boolean" ? String(value) : "read";
  } catch (error) {
    return error instanceof Error && error.name === "UnknownReply" ? "threw" : `other: ${String(error)}`;
  }
}

/** The certificate's GET answers with `replies` (the whole pipeline's answer) for one run. */
async function withGet(replies: unknown, run: () => Promise<unknown>): Promise<string> {
  redis.pipeline = async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === KEY) return replies as unknown[];
    return realPipeline(commands);
  };
  try {
    return await outcome(run);
  } finally {
    redis.pipeline = realPipeline;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const record = { id: ID, store: "s:1", productId: "p1", courseId: "c1", name: "Ana Lima", title: "Course", creator: "Shop", email: "ana@example.com", issuedAt: 1_800_000_000, withdrawnAt: 0 };

  part("Control: the key's own key, a nil and a stored record");
  is("the record lives under the key this test answers for", (await realPipeline([["SET", KEY, JSON.stringify(record)], ["GET", KEY]]))[1], JSON.stringify(record));
  is("a stored record reads", await outcome(() => readCertificate(ID)), "read");
  is("a confirmed nil is no certificate", await withGet([null], () => readCertificate(ID)), "none");

  part("Rule 24: a reply that is not exactly one string or nil is unknown, never not found");
  is("no reply", await withGet([], () => readCertificate(ID)), "threw");
  is("two replies", await withGet([null, null], () => readCertificate(ID)), "threw");
  is("a number", await withGet([5], () => readCertificate(ID)), "threw");
  is("an object", await withGet([record], () => readCertificate(ID)), "threw");
  is("not a list", await withGet("garbled", () => readCertificate(ID)), "threw");

  part("Withdrawing over an unknown read is unknown, never \"no such certificate\"");
  is("withdraw over a number", await withGet([5], () => withdrawCertificate("c1", ID)), "threw");
  is("withdraw over a nil is no certificate", await withGet([null], () => withdrawCertificate("c1", ID)), "false");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
