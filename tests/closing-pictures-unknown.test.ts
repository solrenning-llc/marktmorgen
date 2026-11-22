/**
 * A community's picture count that does not read is unknown, never zero (#4260, Codex V; rule 24).
 *
 * lib/community-files.ts `picturesKept` is what the closing walk (lib/plan-closing.ts) adds to a store's measured
 * bytes. Before this fix it read `GET nl:cimg:n:<folder>` without checking the reply's shape, coerced it with
 * `Number`, and answered 0 for an odd reply and for a read that threw. A store whose count could not be read was
 * then measured as keeping fewer bytes than it does: an ended plan could be saved as fitting and left alone for
 * RECHECK_DAYS, and a closing store went on with a figure nobody had.
 *
 * Now only an exact nil is "no pictures" and only a string of digits is a count; every other reply, and a read that
 * throws, is an UnknownReplyError. The closing walk already keeps a store whose look throws in line as "held" and
 * looks at it again on its next run (closeEnded), so nothing is measured, saved or removed on a figure we do not have.
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), with chosen replies for the count's GET.
 */
import { createHash } from "node:crypto";
import { communityFolder } from "@/lib/community-image";
import { picturesKept, takePicturePlace } from "@/lib/community-files";
import { PICTURE_BYTES } from "@/lib/community-picture-rules";
import { type Hands, closeOne } from "@/lib/plan-closing";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
delete process.env.BLOB_READ_WRITE_TOKEN;
/** Stripe has no plan for anybody, and every email is taken (no real service is reached). */
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin === "https://api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response(JSON.stringify({ id: "email_0001", data: [{ id: "email_0001" }] }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
/** The reply the test gives in place of Redis for the count's GET, or a throw; null lets Redis answer. */
let countReply: (() => Promise<unknown[]>) | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (countReply && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:cimg:n:")) return countReply();
  return pipeline(commands);
}) as typeof redis.pipeline;

const ODD: [string, () => Promise<unknown[]>][] = [
  ["no reply at all", async () => []],
  ["two replies", async () => ["2", "2"]],
  ["undefined", async () => [undefined]],
  ["QUEUED", async () => ["QUEUED"]],
  ["a word", async () => ["many"]],
  ["a negative count", async () => ["-1"]],
  ["a fraction", async () => ["1.5"]],
  ["an empty string", async () => [""]],
  ["a number past the safe range", async () => ["99999999999999999999"]],
  ["a list", async () => [["2"]]],
  ["a read that threw (a timeout)", () => Promise.reject(new Error("the database did not answer in time"))],
];

/** "unknown" when the read rejects with UnknownReplyError or the Redis error itself, else the number answered. */
const kept = (folder: string) =>
  picturesKept(folder).then(
    (n) => n,
    (error: unknown) => (error instanceof UnknownReplyError || (error instanceof Error && /did not answer/.test(error.message)) ? "unknown" : `threw ${String(error)}`),
  );

async function reads(): Promise<void> {
  const folder = communityFolder("e".repeat(32));
  part("What the count reads as");
  is("no count at all (nil) is no pictures", await kept(folder), 0);
  await takePicturePlace(`community/${folder}/${"1".repeat(16)}.jpg`, 50);
  await takePicturePlace(`community/${folder}/${"2".repeat(16)}.jpg`, 50);
  is("a count of two is two", await kept(folder), 2);
  countReply = async () => ["0"];
  is("a count of zero is zero", await kept(folder), 0);

  part("Any other answer is unknown, never zero");
  for (const [label, reply] of ODD) {
    countReply = reply;
    is(`${label}: unknown`, await kept(folder), "unknown");
  }
  countReply = null;
  is("and once it reads again, the count is as it was", await kept(folder), 2);
}

async function closing(): Promise<void> {
  part("The closing walk on a count it cannot read");
  const email = "pia@example.com";
  await claimHandle(email, "pia", "Pia", "");
  // A paid plan first, as tests/plan-closing.test.ts makes one, so that its end is an ended plan.
  await setSubscription(email, { customerId: "cus_pia0001", subscriptionId: "sub_pia0001", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  const withCommunity = await setCommunity(email, true);
  const folder = communityFolder(withCommunity!.community!.id);
  for (const name of ["a1b2c3d4e5f6a7b8.jpg", "b1b2c3d4e5f6a7b8.jpg"]) await takePicturePlace(`community/${folder}/${name}`, 10);
  await setSubscription(email, { active: false });
  const endedAt = Date.parse((await storeForEmail(email))?.planEndedAt ?? "");
  const removed: string[] = [];
  const hands: Hands = {
    measure: async () => 0,
    pictures: async (id) => (await picturesKept(communityFolder(id))) * PICTURE_BYTES,
    list: async () => [],
    remove: async (paths) => {
      removed.push(...paths);
    },
  };
  countReply = async () => ["QUEUED"];
  const look = await closeOne(email, endedAt + 60_000, hands).then(
    (result) => `answered ${result.state}`,
    (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`),
  );
  countReply = null;
  is("a store whose picture count does not read is not measured: the look stops as unknown (closeEnded keeps it held)", look, "unknown");
  is("and nothing of it was removed", removed, []);
  // The key lib/plan-closing.ts keeps a store's closing state under (stateKey).
  const [state] = await pipeline([["GET", `nl:plan:closing:${createHash("sha256").update(email).digest("hex").slice(0, 40)}`]]);
  is("no closing state was saved for it on that figure", state, null);
}

async function main(): Promise<void> {
  await reads();
  await closing();
  done();
}

void main();
