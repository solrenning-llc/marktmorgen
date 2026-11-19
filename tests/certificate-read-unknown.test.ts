/**
 * A certificate's record read exactly (lib/certificate.ts readCertificate;
 * CX-123 rule 24). GET answers the record (a text) or a confirmed none (nil);
 * any other reply leaves it unknown. It used to read as "no certificate", so:
 *   - the public page that proves a certificate (app/[handle]/certificate/[id])
 *     told whoever checked it that it was not found;
 *   - the studio's "Withdraw" answered "unknown" (404) for a certificate that
 *     stands, and left it standing while saying it did not exist.
 * Now the read throws UnknownReply: nothing says found or not found on a guess.
 * A stored record that is itself malformed stays "no certificate", as before
 * (tests/certificate-record-evidence.test.ts).
 */
import { UnknownReply } from "@/lib/redis-exact";
import { certKey, readCertificate, withdrawCertificate } from "@/lib/certificate";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const id = "readunknown00001";
const courseId = "d".repeat(32);
const record = { id, store: "read-store", courseId, productId: "course1", name: "Sample Student", title: "Sample Course", creator: "Sample School", email: "student@example.com", issuedAt: 1_790_000_000, withdrawnAt: 0 };

const original = redis.pipeline.bind(redis);
/** Every GET of the certificate's record answers `reply`; everything else as Redis does. */
function getAnswers(reply: unknown): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === certKey(id)) return reply;
    return original(commands);
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = original;
};
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await run());
  } catch (error) {
    return error instanceof UnknownReply ? "unknown" : `threw ${String(error)}`;
  }
}

async function main() {
  redis.clear();
  await redis.pipeline([["SET", certKey(id), JSON.stringify(record)]]);
  part("A reply that is not the record or nil is unknown");
  for (const [label, reply] of [["a missing envelope", []], ["a number", [7]], ["a list", [["x"]]], ["an object", [{ id }]], ["two replies", [JSON.stringify(record), null]]] as [string, unknown][]) {
    getAnswers(reply);
    is(`the page's read: ${label} is unknown, never "not found"`, await outcome(() => readCertificate(id)), "unknown");
    is(`the studio's withdrawal: ${label} is unknown, never "no such certificate"`, await outcome(() => withdrawCertificate(courseId, id)), "unknown");
    restore();
  }
  is("nothing was withdrawn on an unknown read", (await readCertificate(id))?.withdrawnAt, 0);
  part("Controls");
  is("the record reads as it is", (await readCertificate(id))?.name, "Sample Student");
  getAnswers([null]);
  is("a confirmed none (nil) is no certificate", await outcome(() => readCertificate(id)), "null");
  restore();
  is("the withdrawal of a standing certificate is done", await withdrawCertificate(courseId, id), true);
  is("and it reads withdrawn", ((await readCertificate(id))?.withdrawnAt ?? 0) > 0, true);
  done();
}
void main();
