/**
 * Idempotency-Key, unit 3: deleting a person from a store deletes at once every API answer kept about their address
 * (lib/api-idempotency.ts, forgetIdempotentPerson, through lib/person-erasure.ts). Synthetic stores only. Each part
 * fails on the wrong behavior it names: an answer about the deleted person left until it expires, another person's
 * answer deleted, another store's answer deleted, an unknown read taken as "nothing kept", and an answer kept where
 * an erasure could not find it.
 */
import { createHash } from "node:crypto";
import { IDEMPOTENCY_COMMANDS, IDEMPOTENCY_SECONDS, PERSON_INDEX_LINE_BYTES } from "@/lib/api-idempotency-rules";
import { dataBytes } from "@/lib/store-data-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { POST as postLead } from "@/app/api/v1/leads/route";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { erasePerson, erasureScope, erasureSize } from "@/lib/person-erasure";
import { ERASE_BATCH, forgetIdempotentPerson, idempotentLines } from "@/lib/api-idempotency";
import { erasureWork } from "@/lib/erasure-rules";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url}` } }), { status: 404 });
}) as typeof fetch;

const call = async (handler: (r: Request) => Promise<Response>, key: string, body: unknown, idem: string) => {
  const response = await handler(new Request("https://marktmorgen.com/api/v1/x", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idem }, body: JSON.stringify(body) }));
  return { status: response.status, replayed: response.headers.get("Idempotent-Replayed") };
};
const record = (sid: string, key: string) => `nl:api:idem:${sid}:${createHash("sha256").update(key).digest("hex")}`;
const has = (key: string) => redis.keys().includes(key);

async function shop(owner: string, handle: string) {
  await claimHandle(owner, handle, "Synthetic Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, period: paidPeriod() });
  const guide = await addProduct(owner, "The Guide", "", "12", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(owner, guide.product.id, "https://example.test/guide");
  const store = (await storeForEmail(owner))!;
  const writer = await makeKey(store.sid!, "Zapier", Date.now(), true);
  if (!writer.ok) throw new Error("no key");
  return { owner, sid: store.sid!, key: writer.key, product: guide.product.id };
}

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_api_write_only_a_stand_in";
  redis.clear();
  const a = await shop("erase-owner-a@example.test", "eraseshopa");
  const b = await shop("erase-owner-b@example.test", "eraseshopb");
  const ADA = "ada-erase@example.test";
  const BO = "bo-erase@example.test";

  part("Keyed answers about two people, in two stores");
  is("all taken", [
    (await call(postAccess, a.key, { email: ADA, product: a.product }, "a-ada-access")).status,
    (await call(postLead, a.key, { email: "Ada-Erase@Example.test", agreed: true }, "a-ada-lead")).status,
    (await call(postAccess, a.key, { email: BO, product: a.product }, "a-bo-access")).status,
    (await call(postAccess, b.key, { email: ADA, product: b.product }, "b-ada-access")).status,
  ], [200, 200, 200, 200]);
  const kept = [record(a.sid, "a-ada-access"), record(a.sid, "a-ada-lead"), record(a.sid, "a-bo-access"), record(b.sid, "b-ada-access")];
  is("four answers kept", kept.map(has), [true, true, true, true]);
  // The person's index is named by the store in clear and the address only as a hash: no store value goes into a
  // fast hash (CodeQL js/insufficient-password-hash on #3542), and the address is never in the name.
  const index = (sid: string, email: string) => `nl:api:idem:p:${sid}:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
  // Codex X5 on #3542 @1c5fa00 (MÉDIO): the index outlives the erasure by a day with its mark, so a name made by a
  // plain SHA-256 of the address lets anyone holding a list of addresses confirm, offline, who was in this store.
  is("no index is named by the plain SHA-256 of her address: it could be confirmed offline from a list", has(index(a.sid, ADA)), false);
  is("her answers are still indexed (an index in store A names its store, one per address)", redis.keys().filter((k) => k.startsWith(`nl:api:idem:p:${a.sid}:`)).length, 2);
  is("no index name says an address", redis.keys().filter((k) => k.startsWith("nl:api:idem:p:") && /@/.test(k)), []);

  part("One keyed write about a person stays inside the cost ceiling's commands");
  // Every database command a keyed write sends on its own keys (the record and the person's index) is counted against
  // IDEMPOTENCY_COMMANDS, the figure idempotencyWorstMicroUsd prices (rule MR: the ceiling is a true upper bound).
  const sent: string[] = [];
  const pipeline = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof pipeline }).pipeline = async (commands: (string | number)[][]) => {
    for (const c of commands) if (String(c[1] ?? "").startsWith("nl:api:idem:")) sent.push(String(c[0]));
    return pipeline(commands);
  };
  try {
    is("taken", (await call(postAccess, a.key, { email: "dee-erase@example.test", product: a.product }, "a-dee-access")).status, 200);
  } finally {
    (redis as unknown as { pipeline: typeof pipeline }).pipeline = pipeline;
  }
  is("its commands on the record and the index fit the ceiling", [sent.length <= IDEMPOTENCY_COMMANDS, sent], [true, sent]);

  part("Deleting the person from store A deletes their answers there at once, and nothing else");
  const storeA = (await storeForEmail(a.owner))!;
  const erased = await erasePerson(storeA, ADA, { kind: "person" });
  is("the erasure finished", erased.ok, true);
  is("Ada's two answers in store A are gone, an address written in other case included", [has(kept[0]), has(kept[1])], [false, false]);
  is("Bo's answer in store A stays", has(kept[2]), true);
  is("Ada's answer in store B stays: another store's", has(kept[3]), true);
  is("pressed again, nothing more is found", await forgetIdempotentPerson(a.sid, ADA), 0);
  is("a repeat of Ada's request now runs again, never replays her old answer", (await call(postAccess, a.key, { email: ADA, product: a.product }, "a-ada-access")).replayed, null);

  part("An unknown read is never 'nothing kept'");
  const real = redis.pipeline.bind(redis);
  const shapes: unknown[] = [[1, 1, { weird: true }], [1, 1, ["ok", 7]], null, [], [1, 0, []], ["OK", 1, []]];
  const thrown: boolean[] = [];
  for (const reply of shapes) {
    // The erasure's one read of the index: its mark, the expiry and the lines, answered here in another shape.
    (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => (commands.some((c) => c[0] === "ZRANGEBYSCORE") ? (reply as unknown[]) : real(commands));
    thrown.push(await forgetIdempotentPerson(a.sid, BO).then(() => false, () => true));
  }
  (redis as unknown as { pipeline: typeof real }).pipeline = real;
  is("each reply of another shape throws, so the erasure is pressed again rather than said done", thrown, [true, true, true, true, true, true]);
  is("and Bo's answer was not touched by any of them", has(kept[2]), true);

  part("An answer is kept only where an erasure can find it");
  const original = redis.pipeline.bind(redis);
  // The person's index cannot be written: the answer must not be kept (the claim stays, a repeat is told 409).
  (redis as unknown as { pipeline: typeof original }).pipeline = async (commands) => commands.some((c) => c[0] === "ZADD" && String(c[1]).startsWith("nl:api:idem:p:")) ? [null, null, null, null] : original(commands);
  const noIndex = await call(postAccess, a.key, { email: "cy-erase@example.test", product: a.product }, "a-cy-access");
  (redis as unknown as { pipeline: typeof original }).pipeline = original;
  const again = await call(postAccess, a.key, { email: "cy-erase@example.test", product: a.product }, "a-cy-access");
  is("the write ran once; its answer was not kept, and the repeat is told 409, not run again", [noIndex.status, again.status, again.replayed], [200, 409, null]);

  part("A write the erasure ran beside keeps no answer about the person");
  // Reviews on #3542 @13c5f213 (Claude 1, Claude 3 cloud J, LOW): a keyed write that passed the grant's check before the
  // person was deleted, and lists and keeps its answer while the erasure runs or after it ended, must not leave an
  // answer naming them for 24 hours where no erasure finds it.
  type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;
  const plain = redis.pipeline.bind(redis) as Pipe;
  const setPipe = (fn: Pipe) => { (redis as unknown as { pipeline: Pipe }).pipeline = fn; };
  const onIndex = (commands: (string | number)[][], names: string[]) => commands.some((c) => String(c[1] ?? "").startsWith("nl:api:idem:p:") && names.includes(String(c[0])));
  const isRead = (commands: (string | number)[][]) => onIndex(commands, ["SMEMBERS", "ZRANGEBYSCORE", "ZRANGE"]);
  const isListing = (commands: (string | number)[][]) => !isRead(commands) && onIndex(commands, ["SADD", "ZADD"]);
  const keptAbout = async (sid: string, email: string) => {
    const names = redis.keys().filter((k) => k.startsWith(`nl:api:idem:${sid}:`));
    const out: string[] = [];
    for (const name of names) {
      const [raw] = (await plain([["GET", name]])) as unknown[];
      try {
        const r = JSON.parse(String(raw)) as { state?: string; body?: string };
        if (r.state === "done" && String(r.body).includes(email)) out.push(name);
      } catch { /* not a record */ }
    }
    return out;
  };
  const storeNow = async () => (await storeForEmail(a.owner))!;
  for (const when of ["while the erasure reads the index", "after the erasure ended"] as const) {
    const who = when === "after the erasure ended" ? "gus-erase@example.test" : "fay-erase@example.test";
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let atGate!: () => void;
    const reached = new Promise<void>((resolve) => { atGate = resolve; });
    let write: Promise<{ status: number }> | null = null;
    let held = false;
    setPipe(async (commands) => {
      if (!held && isListing(commands)) { held = true; atGate(); await gate; return plain(commands); }
      if (when === "while the erasure reads the index" && isRead(commands)) {
        const reply = await plain(commands);
        open();
        await write;
        return reply;
      }
      return plain(commands);
    });
    write = call(postAccess, a.key, { email: who, product: a.product }, `a-race-${who}`);
    await reached;
    const erased = await erasePerson(await storeNow(), who, { kind: "person" });
    if (when === "after the erasure ended") open();
    await write;
    setPipe(plain);
    is(`${when}: the erasure finished`, erased.ok, true);
    is(`${when}: no answer naming the person is kept`, await keptAbout(a.sid, who), []);
  }

  part("The person's index lists only answers still kept");
  // Claude 3 cloud J's LOW on #3542: each keep set the index's expiry again, and answers past their 24 hours stayed
  // listed, so a busy address's index grew past the cap and the erasure threw until it lapsed.
  const pk = (sid: string, email: string) => `nl:api:idem:p:${sid}:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
  const listed = async (name: string) => {
    try {
      const [members] = (await plain([["ZRANGEBYSCORE", name, "-inf", "+inf"]])) as unknown[];
      return Array.isArray(members) ? members : "unreadable";
    } catch { return "unreadable"; }
  };
  const EVE = "eve-erase@example.test";
  is("a first answer about Eve", (await call(postAccess, a.key, { email: EVE, product: a.product }, "a-eve-1")).status, 200);
  advance(IDEMPOTENCY_SECONDS * 1_000 + 120_000);
  const later = redis.now();
  const realNow = Date.now;
  Date.now = () => later;
  try {
    is("a second one, a day and two minutes later", (await call(postLead, a.key, { email: EVE, agreed: true }, "a-eve-2")).status, 200);
  } finally {
    Date.now = realNow;
  }
  is("only the answer still kept is listed", await listed(pk(a.sid, EVE)), [createHash("sha256").update("a-eve-2").digest("hex")]);

  part("What the index costs and what deleting it costs are counted");
  // Claude 3 cloud F's LOW: the index's bytes must cover a new index for every keyed write (its name, its line, its
  // score), as dataBytes counts what is kept. And the erasure's work on it is counted before it runs (rule MR).
  const longestIndex = `nl:api:idem:p:${"0".repeat(32)}:${"0".repeat(64)}`;
  is("one keyed write's index line, a new index each time, fits the figure priced", PERSON_INDEX_LINE_BYTES >= dataBytes([longestIndex, "0".repeat(64), String(9_999_999_999_999)], 2), true);
  const HAL = "hal-erase@example.test";
  for (const k of ["a-hal-1", "a-hal-2", "a-hal-3"]) await call(postAccess, a.key, { email: HAL, product: a.product }, k);
  const scope = await erasureScope(await storeNow(), HAL);
  const size = scope ? await erasureSize(scope) : null;
  is("the erasure's size counts Hal's kept answers", (size as Record<string, unknown> | null)?.apiAnswers, 3);
  {
    // A person with more answers than one batch: what the erasure sends on them is no more than its size counts.
    const IVY = "ivy-erase@example.test";
    const n = ERASE_BATCH + 7;
    const until = Date.now() + IDEMPOTENCY_SECONDS * 1_000;
    const hashes = Array.from({ length: n }, (_, i) => createHash("sha256").update(`ivy-${i}`).digest("hex"));
    await plain(hashes.flatMap((h) => [["ZADD", pk(a.sid, IVY), until, h], ["SET", `nl:api:idem:${a.sid}:${h}`, JSON.stringify({ state: "done", fp: "0".repeat(64), at: Date.now(), status: 200, body: `{"data":{"email":"${IVY}"}}` }), "EX", 3600]]));
    const lines = await idempotentLines(a.sid, IVY);
    const counted = { apiAnswers: lines, apiAnswerBatches: Math.ceil(lines / ERASE_BATCH) };
    const work = { commands: 0, bytes: 0 };
    setPipe(async (commands) => {
      const reply = await plain(commands);
      work.commands += commands.length;
      work.bytes += JSON.stringify(commands).length + JSON.stringify(reply).length;
      return reply;
    });
    const gone = await forgetIdempotentPerson(a.sid, IVY);
    setPipe(plain);
    const priced = erasureWork(counted);
    const fixed = erasureWork({});
    is("every one of them is deleted", [lines, gone, (await keptAbout(a.sid, IVY)).length], [n, n, 0]);
    // The mark, the expiry and the read are 3 of the 4 fixed commands (the count is the fourth), under 1,000 bytes.
    is("its commands and bytes fit what is counted for them", [work.commands <= priced.commands - fixed.commands + 3, work.bytes <= priced.bytes - fixed.bytes + 1_000], [true, true]);
  }

  done();
}

void main();
