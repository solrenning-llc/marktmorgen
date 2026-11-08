/**
 * A person's erasure and a signature already in progress (Codex M on #3151;
 * lib/agreement-store.ts, forgetAgreementsPerson and signAgreement).
 *
 * signAgreement holds the agreement's lock, reads the record and the version,
 * then writes the record back with the signature. The erasure used to delete
 * the record and the person's set without that lock: a signature that had
 * already read the record wrote it back after the erasure said it was done,
 * with the person's name, address and signature, and the person's set was gone,
 * so a retry answered 0 and could never find it.
 *
 * Now the erasure takes each agreement's lock before deleting it. It waits for
 * a signature in progress to finish and then deletes what it wrote; if the lock
 * stays taken, it throws (the erasure is not finished, the set is kept, and a
 * retry finds everything). Whatever the interleaving: an erasure that says it is
 * done leaves nothing behind, and a retry after the signature leaves nothing.
 *
 * Synthetic only: the Redis stand-in, a fetch stub, and the real signing and
 * erasing paths, with the erasure run while the signer waits on its version read.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/agreement-rules";
import { agreementKeys, createAgreement, forgetAgreementsPerson, readAgreement, signAgreement } from "@/lib/agreement-store";
import { ERASERS, erasureScope } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
const original = redis.pipeline.bind(redis);
const PERSON = "person@example.com";

async function world(): Promise<{ store: Store; id: string; sha: string }> {
  redis.clear();
  const owner = "owner@example.com";
  await claimHandle(owner, "agreesign", "Synthetic store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1AgrSignxxxxx", true);
  await setSubscription(owner, { customerId: "cus_agreesign", subscriptionId: "sub_agreesign", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const draft = readDraft({ kind: "agreement", email: PERSON, name: "Synthetic Person", title: "Synthetic agreement", body: "Synthetic text.", lines: [], consent: true }, "usd");
  if (!("draft" in draft)) throw Error("invalid fixture draft");
  const made = await createAgreement(store, draft.draft);
  if (!made.ok) throw Error(made.message);
  return { store, id: made.agreement.id, sha: made.version.sha256 };
}

async function second(store: Store): Promise<{ id: string; sha: string }> {
  const draft = readDraft({ kind: "agreement", email: PERSON, name: "Synthetic Person", title: "Second agreement", body: "More synthetic text.", lines: [], consent: true }, "usd");
  if (!("draft" in draft)) throw Error("invalid fixture draft");
  const made = await createAgreement(store, draft.draft);
  if (!made.ok) throw Error(made.message);
  return { id: made.agreement.id, sha: made.version.sha256 };
}

const input = (sha: string) => ({ n: 1, sha256: sha, name: "Synthetic Person", email: PERSON, consent: true, ip: "unknown" });
const left = (id: string) => agreementKeys(id).filter((k) => redis.keys().includes(k));

async function main(): Promise<void> {
  part("control: an erasure that finished before the signature");
  {
    const w = await world();
    is("the erasure answers one agreement", await forgetAgreementsPerson(w.store.sid!, PERSON), 1);
    is("signing afterward is refused", (await signAgreement(w.store, w.id, input(w.sha), "Synthetic Person")).ok, false);
    is("no record or version remains", left(w.id), []);
  }

  part("the erasure runs while a signature waits on its version read");
  {
    const w = await world();
    const scope = (await erasureScope(w.store, PERSON))!;
    const eraser = ERASERS.find((e) => e.module === "lib/agreement-store.ts")!;
    let armed = true;
    let erased: unknown = "not run";
    redis.pipeline = (async (commands: Parameters<typeof original>[0]) => {
      const reply = await original(commands);
      if (armed && commands.some((c) => c[0] === "GET" && c[1] === `nl:agree:v:${w.id}:1`)) {
        armed = false;
        erased = await eraser.run(scope, [], new Set()).then(
          (n) => n,
          (error: unknown) => `threw ${(error as Error)?.name}`,
        );
      }
      return reply;
    }) as typeof redis.pipeline;
    await signAgreement(w.store, w.id, input(w.sha), "Synthetic Person");
    redis.pipeline = original;
    is("the real signing path reached its version read and ran the real eraser", armed, false);
    // Either the erasure waited for the signature and then deleted, or it could not take the lock and said so.
    const finished = typeof erased === "number";
    is("an erasure that said it is done leaves no record (name, address, signature)", finished ? await readAgreement(w.id) : null, null);
    is("an erasure that said it is done leaves no version text", finished ? left(w.id) : [], []);
    is("an erasure that could not finish says so, never a count", finished || /^threw /.test(String(erased)), true);
    const retry = await forgetAgreementsPerson(w.store.sid!, PERSON);
    is("a retry after the signature leaves no record", await readAgreement(w.id), null);
    is("a retry after the signature leaves no version text", left(w.id), []);
    is("a retry answers what it deleted (0 only when the first pass already deleted it)", retry, finished ? 0 : 1);
  }
  part("the signature's lock ran out while it waited; the erasure then ran (Codex M on #3151)");
  {
    const w = await world();
    const scope = (await erasureScope(w.store, PERSON))!;
    const eraser = ERASERS.find((e) => e.module === "lib/agreement-store.ts")!;
    let armed = true;
    let erased: unknown = "not run";
    redis.pipeline = (async (commands: Parameters<typeof original>[0]) => {
      const reply = await original(commands);
      if (armed && commands.some((c) => c[0] === "GET" && c[1] === `nl:agree:v:${w.id}:1`)) {
        armed = false;
        redis.advance(11_000); // past the signature's ten-second lock: a request paused longer than its lock
        erased = await eraser.run(scope, [], new Set()).then(
          (n) => n,
          (error: unknown) => `threw ${(error as Error)?.name}`,
        );
      }
      return reply;
    }) as typeof redis.pipeline;
    const signed = await signAgreement(w.store, w.id, input(w.sha), "Synthetic Person");
    redis.pipeline = original;
    is("the real signing path reached its version read and ran the real eraser", armed, false);
    is("the erasure took the free lock and deleted the agreement", erased, 1);
    is("the stale signature, its lock gone, writes nothing and is not said as signed", signed.ok, false);
    is("no record comes back (name, address, signature)", await readAgreement(w.id), null);
    is("no record or version key comes back", left(w.id), []);
    is("a retry finds nothing left, and nothing is stored", [await forgetAgreementsPerson(w.store.sid!, PERSON), left(w.id)], [0, []]);
  }
  for (const [label, pauseAt] of [
    ["before it takes the next agreement's lock", "next lock"],
    ["between taking an agreement's lock and deleting it", "own delete"],
  ] as const) {
    part(`the erasure's own lock runs out ${label}; a new signature takes it (Codex M on #3151)`);
    const w = await world();
    const b = await second(w.store);
    const [first, next] = [w.id, b.id].sort();
    const sha = first === w.id ? w.sha : b.sha;
    let armed = true;
    let release: () => void = () => {};
    const erasureDone = new Promise<void>((resolve) => (release = resolve));
    let signing: Promise<{ ok: boolean }> | null = null;
    redis.pipeline = (async (commands: Parameters<typeof original>[0]) => {
      const c = commands[0];
      const hit =
        pauseAt === "next lock"
          ? c?.[0] === "SET" && c[1] === `nl:agree:lock:${next}` && c.includes("NX")
          : (c?.[0] === "EVAL" && commands.some((x) => x.includes(`nl:agree:r:${first}`))) || (c?.[0] === "DEL" && c.includes(`nl:agree:r:${first}`));
      if (armed && hit) {
        armed = false;
        redis.advance(11_000); // the erasure paused past its own ten-second lock
        signing = signAgreement(w.store, first, input(sha), "Synthetic Person");
        await new Promise((r) => setTimeout(r, 50)); // the new signer takes the free lock and reads
      }
      if (!armed && signing && commands.some((x) => x[0] === "GET" && x[1] === `nl:agree:v:${first}:1`)) {
        const reply = await original(commands);
        await erasureDone; // the signer's version read answers only once the erasure has finished
        return reply;
      }
      return original(commands);
    }) as typeof redis.pipeline;
    const erased = await forgetAgreementsPerson(w.store.sid!, PERSON).then(
      (n) => n,
      (error: unknown) => `threw ${(error as Error)?.name}`,
    );
    release();
    const signed = signing ? await signing : { ok: false };
    redis.pipeline = original;
    is("the pause was reached", armed, false);
    const finished = typeof erased === "number";
    is("an erasure that said it is done leaves no record of either agreement", finished ? [await readAgreement(first), await readAgreement(next)] : [null, null], [null, null]);
    is("an erasure that could not finish says so, never a count", finished || /^threw /.test(String(erased)), true);
    void signed;
    await forgetAgreementsPerson(w.store.sid!, PERSON);
    is("a retry after the signature leaves nothing of either", [left(first), left(next)], [[], []]);
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
