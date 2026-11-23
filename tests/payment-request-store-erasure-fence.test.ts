/**
 * A payment request is never written for a store whose erasure began (row 93 of #5010; Codex
 * T-20261119-1230-defeito-payment-request-store-erasure-fence). The SAVE script of lib/payment-request-store.ts checked
 * only the request's lock token and its record: a creation held up between its counts and its write, while the store's
 * erasure removed the store's id key and marked its reference as erasing, still wrote the buyer's email, name, amount
 * and note and answered ok. A stale copy of the store did the same with no race at all, and so did a change to a
 * request already kept. Now the same script checks the store's id key and its erasing mark before any write.
 *
 * Its cost, measured on the real route's work (rule 964c): what the studio's POST does once it takes a request (the
 * request kept and its email sent; with plans not on sale the route answers 409 before either) and one change. The
 * fence's own calls, the SAVEs a unit takes and the fence's bytes are held at what line payment-request-erasure-fence
 * (tests/plan-cost-registry.ts) prices; the whole request's work against ORDER_COMPUTE is row 141 of #5010.
 * Synthetic only: the Redis stand-in and a fetch stub; no real email or payment.
 */
import { sendRequestEmail } from "@/lib/payment-requests";
import { readDraft } from "@/lib/payment-request-rules";
import { cancelRequest, createRequest, readRequest } from "@/lib/payment-request-store";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { COMMAND, DB_BYTE, ORDER_COMPUTE } from "./plan-cost-registry";
import * as payreqStore from "@/lib/payment-request-store";

process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_payreq_fence" }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

type Command = (string | number)[];
type Pipeline = (commands: Command[]) => Promise<unknown[]>;
const realPipeline: Pipeline = redis.pipeline.bind(redis);
const setPipeline = (next: Pipeline) => {
  (redis as unknown as { pipeline: Pipeline }).pipeline = next;
};

const OWNER = "payreq-erasure-fence@example.com";
const CLIENT = "client-fence@example.com";
const LINE = { text: "Coaching, November (4 sessions)", quantity: 1, amount: "480" };
const SAVE_HEAD = "-- marktmorgen:payreq-save:v1";
/** What line payment-request-erasure-fence prices a SAVE's fence at; read without a static import, so the RED runs on main's libs. */
const PAYREQ_FENCE_COMMANDS = (payreqStore as Record<string, unknown>).PAYREQ_FENCE_COMMANDS as number | undefined;

async function freshStore(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "payreqerasurefence", "Fence Coaching", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1PayReqFenceXx", true);
  await setSubscription(OWNER, { customerId: "cus_payreqfence", subscriptionId: "sub_payreqfence", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

const draftOf = (now: number) => {
  const read = readDraft({ email: CLIENT, name: "Dana", lines: [LINE], note: "Thank you.", dueDate: "", autoReminders: 2, consent: true }, "usd", now);
  if (!read.ok) throw new Error("synthetic draft refused");
  return read.draft;
};

/** The keys that hold a request's record, and a person's set of requests. */
const recordKeys = (): string[] => [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((key) => key.startsWith("nl:payreq:r:"));
const personKeys = (): string[] => [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((key) => key.startsWith("nl:payreq:p:"));

/** The store's erasure, as lib/store.ts begins it: the erasing mark set and the store's id key removed. */
async function beginErasure(store: Store): Promise<void> {
  await realPipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())], ["DEL", storeIdCommand(store.sid!)[1]]]);
}

async function main(): Promise<void> {
  console.error = () => {};

  part("A live store still makes and changes its requests");
  {
    const store = await freshStore();
    const made = await createRequest(store, draftOf(Date.now()));
    is("the request is made", made.ok, true);
    is("its record is kept", recordKeys().length, 1);
    if (made.ok) {
      const canceled = await cancelRequest(store, made.request.id);
      is("and it can be withdrawn", typeof canceled === "object" && canceled !== null && canceled.state, "canceled");
    }
  }

  part("A creation held up while the store's erasure began writes nothing");
  {
    const store = await freshStore();
    let began = false;
    setPipeline(async (commands) => {
      if (!began && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith(SAVE_HEAD))) {
        began = true;
        await beginErasure(store);
      }
      return realPipeline(commands);
    });
    const made = await createRequest(store, draftOf(Date.now()));
    setPipeline(realPipeline);
    is("the erasure began just before the record's write", began, true);
    is("the creation is refused", made.ok, false);
    is("no record with the buyer's email, name, amount or note is written", recordKeys(), []);
    is("and the person's set holds no request", personKeys().every((key) => ((redis.run(["SMEMBERS", key]) as unknown[]) ?? []).length === 0), true);
  }

  part("A stale copy of a store whose id is gone makes no request");
  {
    const store = await freshStore();
    await realPipeline([["DEL", storeIdCommand(store.sid!)[1]]]);
    const made = await createRequest(store, draftOf(Date.now()));
    is("the creation is refused", made.ok, false);
    is("no record is written", recordKeys(), []);
  }

  part("A copy of the store from before its owner moved writes nothing (Claude 6 i51q on #5248)");
  {
    const store = await freshStore();
    // moveAccount repoints the id key to the new ref; an erasure begun after the move marks the new ref's field. The
    // id key still exists, so only its ref says that this copy is no longer the store's own.
    const newRef = "moved-owner@example.com";
    await realPipeline([["SET", storeIdCommand(store.sid!)[1], newRef], ["HSET", ERASING_KEY, await erasingField(newRef), String(Date.now())]]);
    const made = await createRequest(store, draftOf(Date.now()));
    is("the creation from the copy before the move is refused", made.ok, false);
    is("no record is written for the store being erased", recordKeys(), []);
  }

  part("A change to a request kept before the erasure began writes nothing back");
  {
    const store = await freshStore();
    const made = await createRequest(store, draftOf(Date.now()));
    if (!made.ok) throw new Error("no request");
    const before = await readRequest(made.request.id);
    await realPipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
    const canceled = await cancelRequest(store, made.request.id);
    is("the withdrawal answers that the request is gone", canceled, null);
    is("the record is as it was, not written back as withdrawn", (await readRequest(made.request.id))?.state, before?.state);
  }

  part("Its cost on the real route's work: the fence stays inside what line payment-request-erasure-fence prices");
  {
    const store = await freshStore();
    const seen: Command[] = [];
    let bytes = 0;
    const before = redis.scriptCalls;
    setPipeline(async (commands) => {
      seen.push(...commands);
      const replies = await realPipeline(commands);
      bytes += JSON.stringify(commands).length + JSON.stringify(replies).length;
      return replies;
    });
    let id = "";
    try {
      // The route's own work once it takes a request (app/api/store/payment-requests/route.ts, action "create"): the
      // request kept, then its email. With plans not on sale the route answers 409 before either, which costs less.
      const made = await createRequest(store, draftOf(Date.now()));
      is("the request is made", made.ok, true);
      if (made.ok) {
        id = made.request.id;
        await sendRequestEmail(store, made.request);
      }
    } finally {
      setPipeline(realPipeline);
    }
    const counted = (commands: Command[], calls: number) =>
      commands.length + calls + commands.filter((c) => c[0] === "EVAL").reduce((sum, c) => sum + (String(c[1]).match(/redis\.p?call\(/g) ?? []).length, 0);
    const making = counted(seen, Math.max(redis.scriptCalls - before, 0));
    const makingBytes = bytes;

    // One change at its worst: the withdrawal reads the record again under its lock and writes it through SAVE.
    const change: Command[] = [];
    let changeBytes = 0;
    const beforeChange = redis.scriptCalls;
    setPipeline(async (commands) => {
      change.push(...commands);
      const replies = await realPipeline(commands);
      changeBytes += JSON.stringify(commands).length + JSON.stringify(replies).length;
      return replies;
    });
    try {
      const canceled = await cancelRequest(store, id);
      is("a change is written through the fenced SAVE", typeof canceled === "object" && canceled !== null && canceled.state, "canceled");
    } finally {
      setPipeline(realPipeline);
    }
    is("the change's SAVE checks the store's id key and its erasing mark", change.some((c) => c[0] === "EVAL" && String(c[1]).startsWith(SAVE_HEAD) && c[2] === 6), true);
    const oneChange = counted(change, Math.max(redis.scriptCalls - beforeChange, 0));
    // What line payment-request-erasure-fence prices (tests/plan-cost-registry.ts, paymentRequestFenceCost): the fence's
    // own calls in each SAVE, at most two SAVEs for a studio unit that makes and emails a request and one for a change,
    // each with 512 wire bytes. The whole request's work against ORDER_COMPUTE is row 141 of #5010 (coordinator acd6).
    const saves = (commands: Command[]) => commands.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith(SAVE_HEAD));
    const fenceLine = String(saves(seen)[0]?.[1] ?? "").split("\n").find((line) => line.includes("KEYS[5]")) ?? "";
    is("each SAVE runs exactly PAYREQ_FENCE_COMMANDS fence calls", (fenceLine.match(/redis\.call\(/g) ?? []).length, PAYREQ_FENCE_COMMANDS);
    is("a request made and emailed takes at most the two SAVEs priced for its studio unit", saves(seen).length <= 2 && saves(seen).length >= 1, true);
    is("a change takes the one SAVE priced for its unit", saves(change).length, 1);
    const fenceBytes = (c: Command) => JSON.stringify([c[7], c[8], c[c.length - 1]]).length;
    is("the fence's keys and field fit the 512 wire bytes priced a SAVE", [...saves(seen), ...saves(change)].every((c) => fenceBytes(c) <= 512), true);
    console.log("PAYMENT_REQUEST_ROUTE", JSON.stringify({ making, makingBytes, oneChange, changeBytes, savesMaking: saves(seen).length, orderCompute: ORDER_COMPUTE, note: "row 141 measures the whole request against ORDER_COMPUTE" }));
    void COMMAND;
    void DB_BYTE;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
