/**
 * propose_product_description (631 [AA1] (c), #1856) takes what it reads and
 * writes from the store's API allowance before reading, as every other tool
 * past the door (lib/api-read-rules.ts): the product's listing, its current
 * description and the store's book of proposals, which it reads and writes
 * back whole.
 *
 *   - All but the book is taken first; the book is measured under its lock
 *     (an exact STRLEN, where no other change can make it grow), and the rest
 *     is taken before it is read: the call takes the door's one request and
 *     exactly apiReadUnits of its envelope at what the book weighed.
 *   - From an empty book to one of more than a megabyte, what it reads and
 *     what it writes back stay inside that envelope.
 *   - With too few requests left it is refused with the door's sentence:
 *     the book is not locked, read or written, and nothing is proposed; with
 *     enough for all but the book, it is refused once the book is weighed,
 *     nothing of it is read, and its lock is let go.
 *
 * Synthetic stores and keys only; no outside request.
 */
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { addProposal } from "@/lib/agent-book";
import { PRODUCT_DESCRIPTION } from "@/lib/agent-kinds";
import { type ReadWork, addWork, apiReadUnits, listingsWork, proposeWork } from "@/lib/api-read-rules";
import { listingsToRead } from "@/lib/catalog-read-count";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const RECORDS = ["nl:product:", "nl:agent:book:", "nl:catalog:"];
const isRecord = (c: Command) => {
  const key = c[0] === "EVAL" ? c[3] : c[1];
  return typeof key === "string" && RECORDS.some((prefix) => key.startsWith(prefix));
};

let reads: { command: Command; bytes: number; sent: number }[] = [];
// Set by a check: run just before the book's lock is taken, as another key's proposal finished in between.
let beforeLock: (() => Promise<void>) | null = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  if (beforeLock && batch.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:agent:book:lock:"))) {
    const run = beforeLock;
    beforeLock = null;
    await run();
  }
  const answers = await real(batch);
  batch.forEach((command, i) => {
    if (!isRecord(command)) return;
    const sent = command.slice(2).reduce<number>((n, part) => n + Buffer.byteLength(String(part), "utf8"), 0);
    reads.push({ command, bytes: Buffer.byteLength(JSON.stringify(answers[i] ?? null) ?? "", "utf8"), sent });
  });
  return answers;
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

const OWNER = "mcp-propose-cost@example.com";
let id = 0;
let key = "";
const store = async () => (await storeForEmail(OWNER))!;

async function call(args: Record<string, unknown>) {
  reads = [];
  const response = await mcp(new Request("https://marktmorgen.com/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "propose_product_description", arguments: args } }),
  }));
  const body = (await response.json()) as { result?: { content: { text: string }[]; isError: boolean }; error?: { code: number; message: string } };
  const text = body.result?.content[0].text ?? "";
  return { body, text, sent: Buffer.byteLength(text, "utf8") };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "mcp-propose-cost", "Propose Cost", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ProposeCost001", subscriptionId: "sub_ProposeCost001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const made = await makeKey((await store()).sid, "Drafter", Date.now(), false, "draft");
  if (!made.ok) throw new Error("no synthetic key");
  key = made.key;
  const product = await addProduct(OWNER, "Guide", "A guide.", "29", null);
  if (!product.ok) throw new Error("no product");
  const p = product.product.id;
  const statsId = (await store()).statsId!;
  const bookKey = `nl:agent:book:${statsId}`;
  const held = async () => Number((await real([["STRLEN", bookKey]]))[0]);
  const envelope = async (): Promise<ReadWork> => {
    const s = await store();
    return addWork(listingsWork(3 * listingsToRead(s, [p])), proposeWork(await held(), PRODUCT_DESCRIPTION.maxBytes));
  };
  let n = 0;
  const words = (length: number) => `Plain words for the guide, version ${++n}. ` + "€".repeat(Math.max(0, length - 40));

  part("Measured first, then each call takes the door's request and exactly its envelope");
  for (const label of ["an empty book", "a book with one proposal"]) {
    const before = await allowanceUsed(await store(), "api");
    const units = apiReadUnits(await envelope());
    const answered = await call({ product: p, description: words(400) });
    const after = await allowanceUsed(await store(), "api");
    is(`${label}: proposed, and took 1 + ${units}`, [answered.body.result?.isError ?? null, after - before], [false, 1 + units]);
  }

  part("A book that grew before the lock was taken is paid at what it holds under the lock");
  {
    // Another key's proposals land between the count and the lock: what is read must still be what was paid for.
    const grown = await store();
    let underLock = 0;
    beforeLock = async () => {
      // The other key's own reads are its own, not this call's.
      const ours = reads.slice();
      for (let i = 0; i < 40; i += 1) {
        await addProposal({ ...grown, statsId }, PRODUCT_DESCRIPTION, { target: `other${i}`, before: words(4_900), after: words(4_900), asked: { by: "mcp", who: "key_y" } });
      }
      underLock = await held();
      reads = ours;
    };
    const before = await allowanceUsed(await store(), "api");
    const answered = await call({ product: p, description: words(1_000) });
    const after = await allowanceUsed(await store(), "api");
    const work = addWork(listingsWork(3 * listingsToRead(await store(), [p])), proposeWork(underLock, PRODUCT_DESCRIPTION.maxBytes));
    const read = reads.reduce((total, r) => total + r.bytes, 0);
    is(`grown under the lock to ${underLock} bytes: proposed, ${read} bytes read within ${work.bytes}, and took 1 + ${apiReadUnits(work)}`, [answered.body.result?.isError ?? null, read <= work.bytes, after - before], [false, true, 1 + apiReadUnits(work)]);
  }

  part("From an empty book to more than a megabyte, what is read and written stays inside the envelope");
  // Other products' proposals waiting, each near its kind's ceiling, so the book passes a megabyte.
  const s = await store();
  for (let i = 40; i < 46; i += 1) {
    await addProposal({ ...s, statsId }, PRODUCT_DESCRIPTION, { target: `other${i}`, before: words(4_900), after: words(4_900), asked: { by: "mcp", who: "key_x" } });
  }
  is("the book is past a megabyte", (await held()) > 1_000_000, true);
  for (const label of ["a book past a megabyte"]) {
    const work = await envelope();
    const answered = await call({ product: p, description: words(4_900) });
    const read = reads.reduce((total, r) => total + r.bytes, 0);
    const sent = reads.reduce((total, r) => total + r.sent, 0) + answered.sent;
    is(`${label}: ${reads.length} record commands, ${read} bytes read and ${sent} written or sent, within ${work.commands}, ${work.bytes} and ${work.sent}`, [answered.body.result?.isError ?? null, reads.length <= work.commands, read <= work.bytes, sent <= work.sent], [false, true, true, true]);
    is(`${label}: it takes more than the door's one request`, apiReadUnits(work) > 1, true);
  }

  part("Enough for all but the book: refused once the book is weighed, nothing of it read, its lock let go");
  {
    const now = await store();
    const first = apiReadUnits(addWork(listingsWork(3 * listingsToRead(now, [p])), proposeWork(0, PRODUCT_DESCRIPTION.maxBytes)));
    const left = allowanceFor(now, "api") - (await allowanceUsed(now, "api"));
    // The door's one and the part before the book are left; the book, past a megabyte, is not covered.
    if (left > 1 + first) await takeAllowance(now, "api", left - 1 - first);
    const bookBefore = (await real([["GET", bookKey]]))[0];
    const answered = await call({ product: p, description: words(300) });
    const bookReads = reads.filter((r) => String(r.command[0]) === "GET" && String(r.command[1]) === bookKey);
    const lockLeft = (await real([["EXISTS", `nl:agent:book:lock:${statsId}`]]))[0];
    is("refused with the door's sentence, which says the requests it already took stay counted", [answered.body.error?.code ?? null, /requests/i.test(answered.body.error?.message ?? ""), /stay counted/i.test(answered.body.error?.message ?? "")], [-32001, true, true]);
    is("the book was weighed but not read, holds the same, and its lock is let go", [bookReads.length, (await real([["GET", bookKey]]))[0] === bookBefore, Number(lockLeft)], [0, true, 0]);
  }

  part("With too few requests left, refused with the door's sentence, and the book is not touched");
  const now = await store();
  const left = allowanceFor(now, "api") - (await allowanceUsed(now, "api"));
  if (left > 1) await takeAllowance(now, "api", left - 1);
  const bookBefore = (await real([["GET", bookKey]]))[0];
  const answered = await call({ product: p, description: words(300) });
  const touched = reads.filter((r) => String(r.command[0]) !== "STRLEN" && (String(r.command[1]).startsWith("nl:agent:book:") || String(r.command[3] ?? "").startsWith("nl:agent:book:")));
  is("refused with the door's sentence", [answered.body.error?.code ?? null, /requests/i.test(answered.body.error?.message ?? "")], [-32001, true]);
  is("the book is neither locked, read nor written, and holds the same", [touched.length, (await real([["GET", bookKey]]))[0] === bookBefore], [0, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
