/**
 * The sibling of tests/flow-page-units.test.ts on the studio's buyer page (regra 30, 7 November 2026).
 *
 * A buyer's page in the studio (app/studio/people/page.tsx, lib/buyer-profile.ts) shows which of the store's sequences
 * the person was started on. To know it, buyerProfile read the store's whole list of workflows (the worst list the
 * code allows is about 7.9 MB) every time a page was opened, inside the page's own studio requests, without measuring
 * it first; and a list that could not be read, or a start that could not be checked, was shown as "started on none".
 *
 * Held here:
 *   1. the list is measured before it is read, and what reading it comes to past the page's own studio requests is
 *      taken first, through the same meter as the email page and the studio's actions (lib/flows.ts, FlowMeter); only
 *      the names of the sequences the person is on are sent on, so nothing more is counted for sending;
 *   2. without those studio requests, the list is not read: the sequences are shown as not loaded, with why, in
 *      words, and the rest of the page (the list's record, the notes) is still there;
 *   3. a list or a start that cannot be read is "not loaded", never "none";
 *   4. a small list costs nothing beyond the page's own studio requests;
 *   5. the copy of a person's data (lib/person-copy.ts) is their right: nothing is charged there.
 *
 * Measured with the in-memory Redis on the real code. Synthetic stores and people only.
 */
import { readFileSync } from "node:fs";
import * as profileModule from "@/lib/buyer-profile";
import { saveFlow } from "@/lib/flows";
import { readFlowListStrict } from "@/lib/flow-list";
import { personOf } from "@/lib/flow-runs";
import { MAX_FLOWS, MAX_STEPS } from "@/lib/flow-limits";
import { leadsKey } from "@/lib/contacts";
import { countUnits } from "@/lib/person-agenda-read";
import { allowanceUsed, forceAllowance } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { PAGE_INCLUDED_BYTES } from "@/lib/sent-bytes";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Store } from "@/lib/store";
import { ORIGIN_PER_BYTE, UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "peopleunits@example.com";
const BUYER = "buyer.on.two.sequences@example.com";
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

type Charge = (units: number) => Promise<{ ok: true } | { ok: false; message: string }>;
type Profile = Awaited<ReturnType<typeof profileModule.buyerProfile>> & { sequences: string[] | null; sequencesNotLoaded?: string };
// The page's call, with the studio requests the sequences take (the third argument is what this test holds).
const open = (store: Store, email: string, charge: Charge) =>
  (profileModule.buyerProfile as unknown as (s: Store, e: string, c: Charge) => Promise<Profile>)(store, email, charge);

async function setUp() {
  redis.clear();
  await claimHandle(OWNER, "peopleunits", "People Units Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPeople0001", true);
  await setSubscription(OWNER, { customerId: "cus_People0001", subscriptionId: "sub_People0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "People Units Kitchen", address: "1 Main St, Portland, OR 97201" });
}

// Stripe is not what this test reads: the store's account is left out of the profile's store, so no payment is asked.
const current = async (): Promise<Store> => ({ ...(await storeForEmail(OWNER))!, stripeAccountId: null }) as Store;

const steps = (count: number, chars: number, v: number) =>
  Array.from({ length: count }, (_, i) => ({ delayHours: i * 24, subject: `Step ${i} v${v}`, body: `${"x".repeat(chars - 8)} v${v}`.slice(0, chars) }));

/** `count` workflows, the worst the code allows when `chars` is the largest step; returns their ids. */
async function seedFlows(count: number, stepCount: number, chars: number): Promise<string[]> {
  for (let n = 0; n < count; n += 1) {
    const made = await saveFlow(await current(), { name: `Sequence ${n}`, trigger: "joined", steps: steps(stepCount, chars, n) });
    if (!made.ok) throw new Error(`flow ${n}: ${made.reason}`);
  }
  return (await readFlowListStrict((await current()).listId as string)).map((f) => f.id);
}

async function seedPerson(store: Store, flowIds: string[]) {
  await redis.pipeline([
    ["HSET", leadsKey(store.listId as string), BUYER, JSON.stringify({ agreed: true, agreedAt: "2026-09-01T10:00:00.000Z", firstAt: "2026-09-01T10:00:00.000Z", lastAt: "2026-09-11T10:00:00.000Z", titles: [], ids: [], source: "buyer", unsub: false, unsubAt: "", t: "", name: "", tags: ["vip"], importedAt: "" })],
    ...flowIds.map((id) => ["SET", `nl:mail:enr:${id}:${personOf(BUYER)}`, "1"]),
  ]);
}

type Tally = { commands: number; dbBytes: number; flowsRead: number };

/** Runs `work` with every command and byte of the store's workflows and of the starts counted. */
async function tallied<T>(listId: string, work: () => Promise<T>, fail?: (command: string, key: string) => boolean): Promise<{ result: T | "threw"; tally: Tally }> {
  const flowsKey = `nl:mail:flows:${listId}`;
  const base = redis.pipeline.bind(redis);
  const tally: Tally = { commands: 0, dbBytes: 0, flowsRead: 0 };
  redis.pipeline = async (batch) => {
    if (fail && batch.some((c) => fail(String(c[0]), String(c[1])))) throw new Error("the database did not answer");
    const ours = batch.some((c) => c[1] === flowsKey || String(c[1]).startsWith("nl:mail:enr:"));
    const reply = await base(batch);
    if (ours) {
      tally.commands += batch.length;
      tally.dbBytes += utf8(JSON.stringify(batch)) + utf8(JSON.stringify(reply));
      for (const c of batch) if (c[0] === "GET" && c[1] === flowsKey) tally.flowsRead += 1;
    }
    return reply;
  };
  try {
    return { result: await work(), tally };
  } catch {
    return { result: "threw", tally };
  } finally {
    redis.pipeline = base;
  }
}

async function main(): Promise<void> {
  const page = readFileSync("app/studio/people/page.tsx", "utf8");
  const lib = readFileSync("lib/buyer-profile.ts", "utf8");

  // ---------------------------------------------------------------- part 1
  part("1. The buyer page reads the workflows through the meter, never whole and unpaid");
  is("the profile no longer reads the whole list unmetered", /readFlows\(store\.listId\)/.test(lib), false);
  is("it reads it through the workflows' meter, sending nothing of it back but names", /new FlowMeter\(/.test(lib) && /\.list\(store\.listId, false\)/.test(lib), true);
  is("the page pays for it from the store's studio requests", /buyerProfile\(store, email, /.test(page) && /countUnits\(store, units\)/.test(page), true);

  await setUp();
  const chars = Math.floor((400_000 - 4_000) / MAX_STEPS) - 100;
  const ids = await seedFlows(MAX_FLOWS, MAX_STEPS, chars);
  const store = await current();
  const listId = store.listId as string;
  await seedPerson(store, [ids[3], ids[11]]);
  const usedBefore = await allowanceUsed(store, "studio");
  const worst = await tallied(listId, () => open(store, BUYER, (u) => countUnits(store, u)));
  const units = (await allowanceUsed(await current(), "studio")) - usedBefore;
  const shown = worst.result !== "threw" ? worst.result.sequences : worst.result;
  is("the sequences they are on, by name", shown, ["Sequence 3", "Sequence 11"]);
  const sentBytes = utf8(JSON.stringify(shown ?? []));
  console.log("C5_PEOPLE_FLOWS worst", JSON.stringify({ ...worst.tally, sentBytes, units }));
  is(`past the ${PAGE_INCLUDED_BYTES} bytes one studio request moves, more than one is taken`, worst.tally.dbBytes > PAGE_INCLUDED_BYTES ? units >= 1 : true, true);
  is("the studio requests taken pay for what it moved at the registry's prices", units * UNIT_COST.studio >= request("studio", worst.tally.commands, worst.tally.dbBytes) + sentBytes * ORIGIN_PER_BYTE, true);
  is("read once", worst.tally.flowsRead, 1);

  // ---------------------------------------------------------------- part 2
  // Regra 23 (changed after the RED commit): "?? \"threw\"" also turned the expected null into "threw"; read as
  // "a result, or threw" instead, here and in part 3. The expected values are unchanged.
  part("2. Without the studio requests the list needs: not read, said in words, the rest of the page still there");
  const used = await allowanceUsed(store, "studio");
  await forceAllowance(store, "studio", STORE_ALLOWANCES.pro.studio - used - 1);
  const refused = await tallied(listId, () => open(store, BUYER, (u) => countUnits(store, u)));
  const r = refused.result !== "threw" ? refused.result : null;
  is("the list was not read", refused.tally.flowsRead, 0);
  is("the sequences are not loaded, not 'none'", r ? r.sequences : "threw", null);
  is("and why, in words", (r?.sequencesNotLoaded ?? "").length > 20, true);
  is("the list's record is still on the page", [r?.contact?.agreed, r?.contact?.tags], [true, ["vip"]]);
  is("the page says it in words", /sequencesNotLoaded/.test(page) && /sequences === null/.test(page), true);

  // ---------------------------------------------------------------- part 3
  part("3. A list or a start that cannot be read is 'not loaded', never 'none'");
  await setUp();
  const one = await seedFlows(2, 2, 200);
  const sStore = await current();
  await seedPerson(sStore, [one[0]]);
  const down = await tallied(sStore.listId as string, () => open(sStore, BUYER, (u) => countUnits(sStore, u)), (c, key) => c === "GET" && key.startsWith("nl:mail:flows:"));
  const d = down.result !== "threw" ? down.result : null;
  is("the list did not come back: not loaded", [d ? d.sequences : "threw", (d?.sequencesNotLoaded ?? "").length > 20], [null, true]);
  is("the rest is still there", d?.contact?.agreed, true);
  const noStart = await tallied(sStore.listId as string, () => open(sStore, BUYER, (u) => countUnits(sStore, u)), (c) => c === "EXISTS");
  const n = noStart.result !== "threw" ? noStart.result : null;
  is("the starts did not come back: not loaded", [n ? n.sequences : "threw", (n?.sequencesNotLoaded ?? "").length > 20], [null, true]);
  const strlen = await tallied(sStore.listId as string, () => open(sStore, BUYER, async () => ({ ok: true })), (c) => c === "STRLEN");
  const s = strlen.result !== "threw" ? strlen.result : null;
  is("its size did not come back: not loaded, nothing read", [s ? s.sequences : "threw", strlen.tally.flowsRead], [null, 0]);

  // ---------------------------------------------------------------- part 4
  part("4. A small list costs nothing beyond the page's own studio requests");
  const before = await allowanceUsed(sStore, "studio");
  const small = await open(sStore, BUYER, (u) => countUnits(sStore, u));
  is("the sequence they are on", [small.sequences, small.sequencesNotLoaded], [["Sequence 0"], ""]);
  is("no studio request more", (await allowanceUsed(await current(), "studio")) - before, 0);
  const noList = await open({ ...sStore, listId: null } as Store, BUYER, async () => ({ ok: false, message: "never asked" }));
  is("a store with no list: none, read from nowhere", [noList.sequences, noList.sequencesNotLoaded], [[], ""]);

  // ---------------------------------------------------------------- part 5
  part("5. The copy of a person's data is their right: nothing charged there");
  const copy = readFileSync("lib/person-copy.ts", "utf8");
  is("lib/person-copy.ts takes no studio request", /countUnits|FlowMeter|countStudio/.test(copy), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
